
"""ml-container-creator hey — Advisory agent powered by Strands.

Entry point for the interactive REPL that connects to MCP servers
and provides ML infrastructure guidance via Claude on Bedrock.

Usage:
    python3 src/agent/agent.py --project-dir <path> [--offline|-o]
    python3 src/agent/agent.py --project-dir <path> --goal 'build and deploy' [--auto] [--dry-run]
"""

from __future__ import annotations

import collections
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONUNBUFFERED", "1")

from strands import Agent, tool
from strands.tools.mcp import MCPClient
from strands.models.anthropic import AnthropicModel
from mcp.client.stdio import StdioServerParameters, stdio_client

from config_loader import load_agent_config
from context import ProjectContext
from execution_config import load_execution_config
from health_check import EnvironmentHealthCheck, print_health_report
from tools.execute_script import create_execute_script_tool, get_execution_log
from goal_planner import GoalPlanner, GoalPlanningError
from chain_runner import ChainRunner
from dry_run_reporter import DryRunReporter


# ─── Constants ────────────────────────────────────────────────────────────────

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent
_MCP_CONFIG_PATH = _PACKAGE_ROOT / "config" / "mcp.json"
_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "system.md"
_CAPABILITY_MATRIX_PATH = Path(__file__).resolve().parent / "data" / "capability-matrix.json"


# ─── read_docs tool ──────────────────────────────────────────────────────────


def _create_read_docs_tool():
    """Create a read_docs tool that reads bundled documentation markdown files.

    The tool resolves docs from the installed package root, allowing the agent
    to ground answers in the actual published documentation.

    Returns:
        A Strands @tool-decorated function.
    """
    docs_dir = _PACKAGE_ROOT / "docs"

    @tool
    def read_docs(page: str = "", query: str = "") -> str:
        """Read documentation pages bundled with ml-container-creator.

        Use this to look up official documentation when answering user questions
        about workflows, configuration, troubleshooting, or features. The docs
        are the same as https://awslabs.github.io/ml-container-creator/.

        Args:
            page: Documentation page name (e.g., "fine-tuning", "benchmarking",
                  "custom-training", "getting-started"). Omit .md extension.
                  If empty, returns the list of available pages.
            query: Optional search term. If provided with a page, returns only
                   sections containing this term (case-insensitive).

        Returns:
            The markdown content of the page, a filtered subset, or a listing.
        """
        if not docs_dir.exists():
            return "Error: docs/ directory not found in package. Was it included in files[]?"

        # List mode: return available pages
        if not page:
            pages = sorted(p.stem for p in docs_dir.rglob("*.md"))
            return "Available documentation pages:\n" + "\n".join(f"  - {p}" for p in pages)

        # Resolve the page (support both "fine-tuning" and "fine-tuning.md")
        page_name = page if page.endswith(".md") else f"{page}.md"
        # Search recursively (docs may have subdirs like dev/)
        matches = list(docs_dir.rglob(page_name))
        if not matches:
            # Try fuzzy: find pages containing the query term
            all_pages = sorted(p.stem for p in docs_dir.rglob("*.md"))
            suggestions = [p for p in all_pages if page.lower().replace("-", "") in p.lower().replace("-", "")]
            if suggestions:
                return f"Page '{page}' not found. Did you mean: {', '.join(suggestions)}?"
            return f"Page '{page}' not found. Use read_docs() with no args to list available pages."

        content = matches[0].read_text(encoding="utf-8")

        # Filter by query if provided
        if query:
            sections = content.split("\n## ")
            matched = [s for s in sections if query.lower() in s.lower()]
            if matched:
                return "\n## ".join(matched)
            return f"No sections in '{page}' match '{query}'. Returning full page.\n\n{content}"

        return content

    return read_docs


# ─── write_file tool ──────────────────────────────────────────────────────────


def _create_write_file_tool(project_dir: Path):
    """Create a write_file tool scoped to the given project directory.

    The tool validates that the target path does not escape the project root,
    preventing path traversal attacks.

    Args:
        project_dir: Resolved absolute path to the project root.

    Returns:
        A Strands @tool-decorated function.
    """

    @tool
    def write_file(file_path: str, content: str) -> str:
        """Write content to a file within the project directory.

        Use this to save action plans, TODO lists, or recommendation summaries.
        The file path must be relative to the project root. Parent directories
        are created automatically.

        Args:
            file_path: Relative path within the project (e.g., "TODO.md", "docs/plan.md").
            content: Text content to write to the file.

        Returns:
            Confirmation message with the absolute path written.
        """
        # Resolve the target path and validate it stays within project_dir
        target = (project_dir / file_path).resolve()
        try:
            target.relative_to(project_dir)
        except ValueError:
            return f"Error: path '{file_path}' escapes the project directory. Refusing to write."

        # Create parent directories if needed
        target.parent.mkdir(parents=True, exist_ok=True)

        # Write the file
        target.write_text(content, encoding="utf-8")
        return f"Written to {target}"

    return write_file


# ─── MCP Server Management ───────────────────────────────────────────────────


def _load_mcp_config() -> dict[str, Any]:
    """Load and parse config/mcp.json from the package root.

    Returns:
        Dict of server configurations from mcpServers key.

    Raises:
        SystemExit: If the config file is missing or unparseable.
    """
    if not _MCP_CONFIG_PATH.is_file():
        print(f"\033[31mError:\033[0m config/mcp.json not found at {_MCP_CONFIG_PATH}")
        sys.exit(1)

    try:
        data = json.loads(_MCP_CONFIG_PATH.read_text(encoding="utf-8"))
        return data.get("mcpServers", {})
    except (json.JSONDecodeError, OSError) as e:
        print(f"\033[31mError:\033[0m Cannot parse config/mcp.json: {e}")
        sys.exit(1)


def _start_mcp_servers(
    server_names: frozenset[str],
    timeout: int = 30,
) -> list[MCPClient]:
    """Start the subset of MCP servers needed by the advisory agent.

    Reads config/mcp.json, filters to the agent's required servers,
    resolves paths relative to the package root, and starts each via stdio.

    Args:
        server_names: Set of MCP server names to connect to.
        timeout: Seconds to wait for each MCP server to start (reserved for future use).

    Returns:
        List of connected MCPClient instances.
    """
    all_servers = _load_mcp_config()
    clients: list[MCPClient] = []

    for name, config in all_servers.items():
        if name not in server_names:
            continue

        command = config.get("command", "node")
        args = config.get("args", [])

        # Resolve relative server paths against package root
        resolved_args = []
        for arg in args:
            arg_path = _PACKAGE_ROOT / arg
            if arg_path.is_file():
                resolved_args.append(str(arg_path))
            else:
                resolved_args.append(arg)

        try:
            server_params = StdioServerParameters(command=command, args=resolved_args)
            client = MCPClient(lambda sp=server_params: stdio_client(sp))
            clients.append(client)
        except Exception as e:
            print(f"  \033[33m⚠\033[0m Could not start MCP server '{name}': {e}")

    # Also start the agent-knowledge server explicitly if not in mcp.json
    # (it's at servers/agent-knowledge/index.js)
    if "agent-knowledge" in server_names and "agent-knowledge" not in all_servers:
        knowledge_path = _PACKAGE_ROOT / "servers" / "agent-knowledge" / "index.js"
        if knowledge_path.is_file():
            try:
                server_params = StdioServerParameters(command="node", args=[str(knowledge_path)])
                client = MCPClient(lambda sp=server_params: stdio_client(sp))
                clients.append(client)
            except Exception as e:
                print(f"  \033[33m⚠\033[0m Could not start agent-knowledge server: {e}")

    return clients


def _stop_mcp_servers(clients: list[MCPClient]) -> None:
    """Gracefully stop all MCP clients.

    Args:
        clients: List of MCPClient instances to shut down.
    """
    for client in clients:
        try:
            client.stop(None, None, None)
        except Exception:
            pass  # Best effort cleanup


# ─── System Prompt Construction ───────────────────────────────────────────────


def _build_system_prompt(context: dict[str, Any]) -> str:
    """Build the system prompt by loading the template and injecting context.

    Substitutes placeholders:
      - {project_context_json} — serialized project context
      - {capability_matrix_json} — capability matrix data
      - {user_context_md} — user-provided context markdown (or empty)

    Args:
        context: Project context dict from ProjectContext.load().

    Returns:
        Fully rendered system prompt string.
    """
    # Load the prompt template
    if _SYSTEM_PROMPT_PATH.is_file():
        template = _SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    else:
        template = "You are the ml-container-creator advisor.\n\n{project_context_json}"

    # Load capability matrix
    capability_matrix = "{}"
    if _CAPABILITY_MATRIX_PATH.is_file():
        try:
            capability_matrix = _CAPABILITY_MATRIX_PATH.read_text(encoding="utf-8")
        except OSError:
            pass

    # Serialize project context (exclude internal fields)
    context_json = json.dumps(context, indent=2, default=str)

    # Extract user context
    user_context = context.get("user_context") or "No user-provided context file found."

    # Perform substitutions
    prompt = template.replace("{project_context_json}", context_json)
    prompt = prompt.replace("{capability_matrix_json}", capability_matrix)
    prompt = prompt.replace("{user_context_md}", user_context)

    # Inject session execution history (NFR-7, AC-3.3)
    exec_log = get_execution_log()
    if exec_log:
        history_lines = []
        for entry in exec_log:
            flags_str = " ".join(entry.get("flags", []))
            cmd = f"./{entry['script']}" + (f" {flags_str}" if flags_str else "")
            history_lines.append(
                f"- `{cmd}` → {entry['status']} (exit {entry.get('exit_code', '?')}) at {entry['timestamp']}"
            )
        execution_history = "\n".join(history_lines)
    else:
        execution_history = "No scripts executed yet this session."
    prompt = prompt.replace("{execution_history_md}", execution_history)

    return prompt


# ─── Cost Tracking ────────────────────────────────────────────────────────────


class CostTracker:
    """Simple token cost tracker for the session.

    Tracks approximate input/output tokens and computes
    estimated cost based on Claude Sonnet pricing.
    """

    def __init__(self, input_cost_per_1k: float = 0.003, output_cost_per_1k: float = 0.015) -> None:
        self._input_cost_per_1k = input_cost_per_1k
        self._output_cost_per_1k = output_cost_per_1k
        self.input_tokens: int = 0
        self.output_tokens: int = 0
        self.turns: int = 0

    def record_turn(self, input_tokens: int = 0, output_tokens: int = 0) -> None:
        """Record token usage from a single turn.

        Args:
            input_tokens: Number of input tokens consumed.
            output_tokens: Number of output tokens generated.
        """
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.turns += 1

    @property
    def estimated_cost(self) -> float:
        """Estimated USD cost for the session."""
        input_cost = (self.input_tokens / 1000) * self._input_cost_per_1k
        output_cost = (self.output_tokens / 1000) * self._output_cost_per_1k
        return input_cost + output_cost

    def print_summary(self) -> None:
        """Print a formatted cost summary to stdout."""
        if self.turns == 0:
            return

        print("\n\033[1mSession Summary\033[0m")
        print("─" * 40)
        print(f"  Turns: {self.turns}")
        print(f"  Input tokens:  ~{self.input_tokens:,}")
        print(f"  Output tokens: ~{self.output_tokens:,}")
        print(f"  Estimated cost: ~${self.estimated_cost:.4f}")
        print()


# ─── CLI Argument Parsing ─────────────────────────────────────────────────────

ParsedArgs = collections.namedtuple('ParsedArgs', ['project_dir', 'offline', 'goal', 'auto_mode', 'dry_run'])


def _parse_args() -> ParsedArgs:
    """Parse command-line arguments.

    Returns:
        ParsedArgs namedtuple with project_dir, offline, goal, auto_mode, dry_run.
    """
    args = sys.argv[1:]
    project_dir = os.getcwd()
    offline = False
    goal = None
    auto_mode = False
    dry_run = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--project-dir" and i + 1 < len(args):
            project_dir = args[i + 1]
            i += 2
        elif arg in ("--offline", "-o"):
            offline = True
            i += 1
        elif arg == "--goal" and i + 1 < len(args):
            goal = args[i + 1]
            i += 2
        elif arg == "--auto":
            auto_mode = True
            i += 1
        elif arg == "--dry-run":
            dry_run = True
            i += 1
        else:
            i += 1

    return ParsedArgs(
        project_dir=project_dir,
        offline=offline,
        goal=goal,
        auto_mode=auto_mode,
        dry_run=dry_run,
    )


# ─── REPL ─────────────────────────────────────────────────────────────────────


def _run_repl(
    agent: Agent,
    context: dict[str, Any],
    project_dir: str,
    cost: CostTracker,
    exit_commands: frozenset[str],
    reload_commands: frozenset[str],
) -> None:
    """Run the interactive REPL loop with streaming output.

    Supports:
      - Configurable exit commands to quit
      - Configurable reload commands to refresh project context
      - Ctrl+C / EOF for graceful exit
      - Streaming responses

    Args:
        agent: Configured Strands Agent instance.
        context: Current project context dict.
        project_dir: Path to the project directory.
        cost: CostTracker instance for session metrics.
        exit_commands: Set of commands that exit the REPL.
        reload_commands: Set of commands that reload project context.
    """
    print("\n\033[1mReady.\033[0m Type your question, or 'exit' to quit.\n")

    while True:
        try:
            user_input = input("\033[36myou:\033[0m ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            break

        if not user_input:
            continue

        # Handle exit commands
        if user_input.lower() in exit_commands:
            break

        # Handle reload
        if user_input.lower() in reload_commands:
            print("  Reloading project context...")
            try:
                new_context = ProjectContext(project_dir).load()
                new_prompt = _build_system_prompt(new_context)
                agent.system_prompt = new_prompt
                context.update(new_context)
                print("  \033[32m✓\033[0m Context reloaded.\n")
            except Exception as e:
                print(f"  \033[31m✗\033[0m Reload failed: {e}\n")
            continue

        # Send to agent with streaming
        try:
            print("\033[90magent:\033[0m ", end="", flush=True)
            response = agent(user_input)

            # Track tokens from response metrics if available
            if hasattr(response, "metrics") and response.metrics and hasattr(response.metrics, "accumulated_usage"):
                metrics = response.metrics
                usage = metrics.accumulated_usage or {}
                input_t = usage.get("inputTokens", 0) or 0
                output_t = usage.get("outputTokens", 0) or 0
                cost.record_turn(input_tokens=input_t, output_tokens=output_t)
            else:
                # Fallback: approximate from word count
                cost.record_turn(
                    input_tokens=len(user_input.split()) * 2,
                    output_tokens=len(str(response).split()) * 2,
                )

            print("\n")
        except KeyboardInterrupt:
            print("\n  (interrupted)\n")
            continue
        except Exception as e:
            print(f"\n  \033[31mError:\033[0m {e}\n")
            continue


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    """Entry point for the advisory agent.

    Parses arguments, runs health checks, connects MCP servers,
    creates the Strands agent, and starts the interactive REPL
    or goal-mode execution.
    """
    args = _parse_args()
    project_path = Path(args.project_dir).resolve()

    # Load external configuration
    config = load_agent_config()

    # Derive frozensets from config for fast membership testing
    agent_mcp_servers = frozenset(config.mcp_servers)
    exit_commands = frozenset(config.exit_commands)
    reload_commands = frozenset(config.reload_commands)

    # Detect whether we're in a project directory
    in_project = (project_path / "do" / "config").is_file()

    # Load project context
    if in_project:
        ctx = ProjectContext(str(project_path))
        context = ctx.load()
        project_name = context.get("project_name") or project_path.name
        engine = context.get("engine") or "unknown"
        target = context.get("deployment_target") or "unknown"
        model = context.get("model") or "not set"
        instance = context.get("instance_type") or "not set"
        print(f"\n\033[1m📁 Project:\033[0m {project_name} ({engine}, {target})")
        print(f"   Model: {model} on {instance}")
    else:
        context = {"mode": "getting-started"}
        print("\n\033[1m👋 Welcome to ml-container-creator!\033[0m")
        print("   No do/config found — running in getting-started mode.")

    # Always run health check
    print()
    health_check = EnvironmentHealthCheck()
    items = health_check.run(str(project_path) if in_project else None)
    print_health_report(items)

    # Offline mode: print summary and exit
    if args.offline:
        print("📄 \033[1mOffline mode\033[0m — no Bedrock calls, no MCP servers.")
        print("   Run without --offline for interactive conversation.")
        return

    # Initialize MCP clients and agent
    mcp_clients: list[MCPClient] = []
    cost = CostTracker(
        input_cost_per_1k=config.input_cost_per_1k,
        output_cost_per_1k=config.output_cost_per_1k,
    )

    # Register signal handler for graceful shutdown
    def _signal_handler(signum: int, frame: Any) -> None:
        """Handle SIGINT for graceful cleanup."""
        print("\n\nShutting down...")
        _stop_mcp_servers(mcp_clients)
        cost.print_summary()
        sys.exit(0)

    signal.signal(signal.SIGINT, _signal_handler)

    try:
        # Connect to MCP servers
        print("Connecting to MCP servers...")
        mcp_clients = _start_mcp_servers(
            server_names=agent_mcp_servers,
            timeout=config.mcp_server_timeout,
        )

        if mcp_clients:
            print(f"  \033[32m✓\033[0m {len(mcp_clients)} MCP servers configured.")
        else:
            print("  \033[33m⚠\033[0m No MCP servers configured. Tool calls will be unavailable.")

        # Build tools list from MCP clients + write_file + execute_script
        tools: list[Any] = list(mcp_clients)  # MCPClient instances are passed directly as tools
        tools.append(_create_write_file_tool(project_path))
        tools.append(_create_read_docs_tool())

        # Load execution config and register execute_script tool
        exec_config = load_execution_config(project_path)
        execute_script_tool = create_execute_script_tool(project_path, exec_config)
        tools.append(execute_script_tool)

        # Build system prompt
        system_prompt = _build_system_prompt(context)

        # Create the Strands agent
        if config.provider == "claude-direct":
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                print("\n\033[31mError:\033[0m provider=claude-direct requires ANTHROPIC_API_KEY env var.")
                print("  Set: export ANTHROPIC_API_KEY=sk-ant-...")
                sys.exit(1)
            model = AnthropicModel(
                model_id=config.model_id,
                max_tokens=4096,
                client_args={"api_key": api_key},
            )
            print(f"  \033[34mℹ\033[0m Using Anthropic direct API (model: {config.model_id})")
        else:
            model = config.model_id  # Strands resolves Bedrock internally from a string

        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            tools=tools,
        )

        print(f"  \033[32m✓\033[0m Agent ready (model: {config.model_id})")

    except Exception as e:
        error_msg = str(e)
        _stop_mcp_servers(mcp_clients)

        # Check for Bedrock connection failures
        if "bedrock" in error_msg.lower() or "credential" in error_msg.lower():
            print(f"\n\033[31mError:\033[0m Could not connect to Bedrock: {error_msg}")
            print("\n  Suggestions:")
            print("  • Check AWS credentials (aws sts get-caller-identity)")
            print("  • Verify Bedrock model access in your AWS account")
            print("  • Run with --offline for static reference mode")
            print("  • Use Claude direct API: set MCC_PROVIDER=claude-direct and ANTHROPIC_API_KEY=<key>")
        else:
            print(f"\n\033[31mError:\033[0m Failed to initialize agent: {error_msg}")
            print("  Try running with --offline for static reference mode.")

        sys.exit(1)

    # ─── Goal Mode ────────────────────────────────────────────────────────────
    if args.goal:
        try:
            planner = GoalPlanner(agent, exec_config.permitted_scripts, exec_config)
            plan = planner.plan(args.goal, context)

            if args.dry_run:
                reporter = DryRunReporter(project_path)
                reporter.report(plan, [])
                _stop_mcp_servers(mcp_clients)
                return

            runner = ChainRunner(execute_script_tool, exec_config, project_path, dry_run=False)
            result = runner.run(plan)

            # Print final goal summary
            if result.steps_failed == 0:
                print(f'\033[32m🚀 Goal completed: "{args.goal}"\033[0m')
            else:
                print(f'\033[33m⚠️  Goal partially completed: "{args.goal}"\033[0m')

        except GoalPlanningError as e:
            print(f'\n{e}', file=sys.stderr)
            sys.exit(1)
        finally:
            _stop_mcp_servers(mcp_clients)
            cost.print_summary()
        return

    # ─── Interactive REPL (default) ───────────────────────────────────────────
    try:
        _run_repl(agent, context, str(project_path), cost, exit_commands, reload_commands)
    finally:
        # Cleanup
        _stop_mcp_servers(mcp_clients)
        cost.print_summary()


if __name__ == "__main__":
    main()
