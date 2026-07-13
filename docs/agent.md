# Agent (`hey`)

The `ml-container-creator hey` command starts a conversational AI agent that helps you understand your project configuration, troubleshoot deployment issues, plan workflows, get optimization recommendations, and **execute `do/` scripts** with explicit user confirmation. It's powered by Amazon Bedrock (Claude Sonnet) and can operate as both an advisor and an autonomous executor — planning and running `do/` script chains via `--goal` mode.

## Prerequisites

- **Python 3.10+** with agent dependencies installed:
  ```bash
  pip install -r src/agent/requirements-agent.txt
  ```
- **AWS credentials** configured with Bedrock access (the agent calls `ConverseStream`)
- **Bootstrap profile** set up via `ml-container-creator bootstrap`

!!! tip
    Run `ml-container-creator hey --offline` to verify your environment without incurring any Bedrock costs.

## Quick Start

```bash
# Inside a project directory — project-aware conversation
cd my-vllm-project/
ml-container-creator hey

# Outside a project directory — getting-started guidance
cd ~/
ml-container-creator hey

# Static health check only (no Bedrock, no cost)
ml-container-creator hey --offline

# Plan and execute toward a goal
ml-container-creator hey --goal "build and push my container"

# Fully autonomous goal execution
ml-container-creator hey --goal "validate my configuration" --auto

# Preview the plan without executing anything
ml-container-creator hey --goal "stage and deploy Qwen3-4B" --dry-run
```

## Modes

### Project Mode (inside a project directory)

When `do/config` exists in the current directory, the agent enters **project mode**:

- Loads your full project context: `do/config`, `do/ic/*.conf`, `do/training/config.yaml`, Dockerfile, adapters, and bootstrap profile
- Runs an environment health check at startup (prerequisites, AWS credentials, MCP server availability)
- Answers questions specific to your configuration
- Makes recommendations referencing your exact file paths and variable names

### Getting-Started Mode (outside a project directory)

When no `do/config` is found, the agent enters **getting-started mode**:

- Checks if you've bootstrapped (`~/.ml-container-creator/config.json`)
- Validates prerequisites (Node.js, Python, AWS credentials, pip packages)
- Walks you through first-time setup and project creation
- Explains what the tool does and how the lifecycle works

## Goal Mode

Goal mode turns `hey` into an autonomous executor. Provide a natural-language objective and the agent plans, resolves unknowns, and chains `do/` scripts to completion.

### Quick start

```bash
# Preview the plan without running anything
python3 src/agent/agent.py --goal "build and push my container" --dry-run

# Run the plan with per-step confirmation on costly steps
python3 src/agent/agent.py --goal "build and push my container"

# Fully autonomous — auto-answers unknowns, runs read-only steps without prompting
python3 src/agent/agent.py --goal "validate my configuration" --auto
```

### How it works

1. **GoalPlanner** converts the objective into an ordered list of `do/` script steps. Each step is stamped with a confirmation class: `auto` (read-only, runs without prompting) or `confirm` (costly or mutating, always pauses for `y/N`).

2. **QuestionResolver** fills in any unknowns from project context (`do/config`, IC confs), the capability matrix, and instance-sizer defaults. Under `--auto`, unknowns that can be resolved from context are filled silently. Infrastructure identifiers (endpoint names, ARNs, bucket names) are never invented — if they're missing from context, the agent asks once.

3. **ChainRunner** walks the plan step by step. On step failure: stop, diagnose, prompt **[R]etry / [S]kip / [A]bort**.

### Confirmation policy

Scripts are classified as `auto` or `confirm` in `config/agent.json` and project-local `.mlcc/agent-config.json`:

| Class | Default scripts |
|-------|----------------|
| `auto` | `do/test`, `do/status`, `do/logs`, `do/validate`, `do/export`, `do/ci` |
| `confirm` | `do/stage`, `do/build`, `do/push`, `do/submit`, `do/deploy`, `do/tune`, `do/train`, `do/adapter`, `do/clean`, `do/register`, `do/optimize`, `do/benchmark` |

Override in your project:
```json
// .mlcc/agent-config.json
{
  "confirmation": {
    "mode": "all"
  }
}
```
`mode: "all"` — always confirm (safe default for unfamiliar projects). `mode: "none"` — never confirm (CI/scripted use).

### --dry-run as a test harness

`--dry-run` runs the full planner and resolver but substitutes a `DryRunReporter` for the executor. Zero `do/` scripts run, zero AWS calls. A deterministic `plan.json` is written to the project directory.

```bash
# Reproducible: same inputs → same plan.json
python3 src/agent/agent.py --goal "stage and deploy Qwen3-4B" --dry-run
cat plan.json | jq '.steps[].script'
```

Useful for golden-file tests: assert on the plan structure without spending on actual jobs.

## What It Can Help With

- **Instance selection**: "What instance should I use for Llama-3.1-8B with LoRA?" → queries instance catalog, calculates VRAM, recommends with math
- **Config explanation**: "What does IC_ENV_VLLM_MAX_MODEL_LEN do?" → explains the variable, shows your current value, recommends what it should be
- **Troubleshooting**: "I'm getting OOM on deploy" → identifies pattern (CUDA graph overhead, LoRA pre-allocation), suggests specific fix
- **Workflow planning**: "Plan a deployment workflow for my model" → generates step-by-step plan, offers to save as `TODO.md`
- **Feature status**: "Is SGLang LoRA supported?" → queries capability matrix, gives honest "no" with alternatives
- **Project summary**: "What's my current config?" → reads and summarizes your entire project state
- **Optimization**: "How can I improve throughput?" → recommends FP8 quantization, batch settings, context length tuning

!!! note
    The agent calls MCP servers (instance-sizer, model-picker, base-image-picker, etc.) to get factual data before answering. It does not guess instance specs or model parameters.

## Flags

| Flag | Description |
|------|-------------|
| `--offline` / `-o` | Print environment health check and project summary, then exit. No Bedrock calls, no cost. |
| `--project-dir <dir>` | Override project directory (default: current working directory). |
| `--goal '<objective>'` | Plan a sequence of `do/` steps to achieve a natural-language objective. Produces an ordered plan; pairs with `--auto` for autonomous execution. |
| `--auto` | Self-answer clarifying questions from project context and instance-sizer defaults, then chain-execute the plan. Pauses only at `confirm`-class scripts (costly or mutating). |
| `--dry-run` | Run the planner and resolver, write `plan.json`, but execute zero `do/` scripts. Deterministic output for CI/testing. |

## Commands During Conversation

| Command | Effect |
|---------|--------|
| `reload` | Re-read project files (use after editing config mid-session) |
| `exit` / `quit` / `bye` / `q` | End session gracefully (prints cost summary) |
| Ctrl+C | Interrupt current response or end session |

## Customizing Agent Knowledge

Create a `.mlcc-agent-context.md` file in your project root to inject team-specific knowledge:

```markdown
<!-- .mlcc-agent-context.md -->
# Team Conventions

- We always use FP8 quantization for cost optimization
- Our max_model_len policy is 4096 (higher requires VP approval)
- Preferred instance family: g5 (approved in our AWS account)
- Adapters are named: tuned-<technique>-<dataset>-<date>
- All deployments go through the staging endpoint first
```

The agent reads this file at startup and incorporates it into all recommendations. Use it for:

- Naming conventions and deployment patterns
- Instance/region preferences and constraints
- Known issues specific to your environment
- Cost policies and approval requirements

## Cost

Each session uses Amazon Bedrock Claude Sonnet. Token usage and estimated cost are displayed when you exit:

```
Session Summary
────────────────────────────────────────
  Turns: 8
  Input tokens:  ~12,400
  Output tokens: ~3,200
  Estimated cost: ~$0.0852
```

A typical 10-turn session costs **~$0.05–$0.10**. Use `--offline` for zero-cost quick reference.

!!! warning
    Cost tracking is approximate. Actual billing comes from your AWS account's Bedrock usage metrics.

## Limitations

- **Executes `do/` scripts listed in `permitted_scripts`** (see `config/agent.json`). Scripts not in the permitted list are refused. To add a script, edit `.mlcc/agent-config.json` in your project.
- **Session state is not persisted** — each `hey` invocation starts fresh. Use `TODO.md` output to capture plans.
- **Knowledge is version-bound** — the agent knows about features in the installed version. Custom forks or unreleased changes aren't reflected unless you add them via `.mlcc-agent-context.md`.
- **Requires internet** — Bedrock access needed for interactive mode. Use `--offline` for air-gapped environments.
