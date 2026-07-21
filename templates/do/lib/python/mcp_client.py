from __future__ import annotations
"""MCP client for deploy-time tool calls.

Handles MCP server discovery and JSON-RPC communication over stdio transport.
Used by the prompt engine to call MCP tools (instance-sizer, endpoint-picker,
cluster-picker) at deploy time for real-time recommendations.

Discovery order:
    1. $MCP_SOCKET — stdio transport (set by Kiro IDE)
    2. ~/.kiro/settings/mcp.json — spawn server as subprocess
    3. Neither available → return None (caller uses built-in heuristic)

All MCP calls enforce a 10-second timeout (FR-10.4). On timeout or error,
callers fall back to manual input or the built-in heuristic.

Test support:
    $MCP_MOCK_RESPONSES — JSON object mapping "server/method" tool names to
    mock response objects. When set, no real MCP server is contacted and
    discover_mcp() returns an MCPClient(transport="mock") immediately (NFR-3.2).

    Expected JSON format:
        {
          "instance-sizer/recommend": {
            "instance_type": "ml.g5.xlarge",
            "gpu_count": 1,
            "instances": [...]
          },
          "endpoint-picker/list": {
            "endpoints": [{"name": "ep-1", "status": "InService"}]
          },
          "cluster-picker/list": {
            "clusters": [{"name": "cluster-1", "gpu_capacity": 8, "queues": ["default"]}]
          }
        }

    Usage in tests:
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_data))
        client = discover_mcp()          # returns MCPClient(transport="mock")
        call_tool(client, "instance-sizer/recommend", {...})  # returns mock

    Or use the ``mcp_mock_responses`` pytest fixture from conftest.py for a
    cleaner API (sets and cleans up the env var automatically).

Callers: deploy_prompts.py, .deploy_helper.py
"""

import json
import logging
import os
import subprocess
import sys
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MCP_CALL_TIMEOUT: int = 10  # seconds per MCP call (FR-10.4)
MCP_SOCKET_ENV: str = "MCP_SOCKET"
MCP_MOCK_ENV: str = "MCP_MOCK_RESPONSES"
MCP_CONFIG_PATH: str = os.path.expanduser("~/.kiro/settings/mcp.json")

# JSON-RPC protocol constants
JSONRPC_VERSION: str = "2.0"


# ---------------------------------------------------------------------------
# MCP Client class
# ---------------------------------------------------------------------------


class MCPClient:
    """Lightweight MCP client using JSON-RPC over stdio transport.

    Attributes:
        transport: Transport type - "socket", "subprocess", or "mock".
        socket_path: Path to MCP socket (when transport is "socket").
        server_config: Server config from mcp.json (when transport is "subprocess").
        _mock_responses: Mock response mapping (when transport is "mock").
    """

    def __init__(
        self,
        transport: str,
        socket_path: str | None = None,
        server_config: dict[str, Any] | None = None,
        mock_responses: dict[str, Any] | None = None,
    ) -> None:
        self.transport = transport
        self.socket_path = socket_path
        self.server_config = server_config
        self._mock_responses = mock_responses or {}

    @property
    def is_mock(self) -> bool:
        """True if this client uses mock responses (testing mode)."""
        return self.transport == "mock"

    @property
    def is_available(self) -> bool:
        """True if this client can make MCP calls."""
        return True

    def __repr__(self) -> str:
        return f"MCPClient(transport={self.transport!r})"


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def discover_mcp() -> MCPClient | None:
    """Discover and return an MCP client, or None if MCP is unavailable.

    Discovery order:
        1. $MCP_MOCK_RESPONSES — return a mock client (for testing, NFR-3.2)
        2. $MCP_SOCKET — use the socket transport (Kiro IDE sets this)
        3. ~/.kiro/settings/mcp.json — spawn MCP server as subprocess
        4. None — MCP unavailable, caller should use built-in heuristic

    Returns:
        MCPClient instance if MCP is available, None otherwise.
    """
    # 1. Check for mock responses (testing mode)
    mock_raw = os.environ.get(MCP_MOCK_ENV)
    if mock_raw:
        try:
            mock_responses = json.loads(mock_raw)
            logger.debug("MCP: using mock responses from $%s", MCP_MOCK_ENV)
            return MCPClient(transport="mock", mock_responses=mock_responses)
        except json.JSONDecodeError:
            logger.warning("MCP: invalid JSON in $%s, ignoring", MCP_MOCK_ENV)

    # 2. Check $MCP_SOCKET
    socket_path = os.environ.get(MCP_SOCKET_ENV)
    if socket_path:
        if os.path.exists(socket_path):
            logger.debug("MCP: using socket transport at %s", socket_path)
            return MCPClient(transport="socket", socket_path=socket_path)
        else:
            logger.warning(
                "MCP: $%s set to %s but path does not exist",
                MCP_SOCKET_ENV,
                socket_path,
            )

    # 3. Check ~/.kiro/settings/mcp.json
    config = _load_mcp_config()
    if config:
        logger.debug("MCP: using subprocess transport from %s", MCP_CONFIG_PATH)
        return MCPClient(transport="subprocess", server_config=config)

    # 4. MCP unavailable
    logger.info("MCP: no server available — falling back to built-in heuristics")
    return None


def _load_mcp_config() -> dict[str, Any] | None:
    """Load MCP server configuration.

    Search order:
        1. $MCP_CONFIG — explicit path override
        2. config/mcp.json — workspace-level (relative to project root)
        3. .kiro/settings/mcp.json — workspace-level (Kiro convention)
        4. ~/.kiro/settings/mcp.json — user-level

    Returns:
        Parsed mcpServers config dict if found and valid, None otherwise.
    """
    candidates = []

    # Explicit override
    explicit = os.environ.get("MCP_CONFIG")
    if explicit:
        candidates.append(explicit)

    # Workspace-level: walk up from this file to find project root
    # (templates/do/lib/python/mcp_client.py → 4 levels up = project root)
    this_dir = os.path.dirname(os.path.abspath(__file__))
    # Walk up looking for config/mcp.json or .kiro/settings/mcp.json
    search_dir = this_dir
    for _ in range(6):
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent
        candidates.append(os.path.join(search_dir, "config", "mcp.json"))
        candidates.append(
            os.path.join(search_dir, ".kiro", "settings", "mcp.json")
        )

    # User-level fallback
    candidates.append(MCP_CONFIG_PATH)

    for config_path in candidates:
        if not os.path.isfile(config_path):
            continue

        try:
            with open(config_path) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("MCP: failed to read %s: %s", config_path, e)
            continue

        servers = data.get("mcpServers")
        if not isinstance(servers, dict) or not servers:
            continue

        logger.debug("MCP: loaded config from %s", config_path)
        return data

    return None


# ---------------------------------------------------------------------------
# Tool calling
# ---------------------------------------------------------------------------


def call_tool(
    client: MCPClient,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Call an MCP tool and return the result.

    Dispatches to the appropriate transport (mock, socket, subprocess).
    Enforces a 10-second timeout on all calls (FR-10.4).

    Args:
        client: MCPClient instance from discover_mcp().
        tool_name: MCP tool name (e.g. "instance-sizer/recommend").
        arguments: Tool arguments dict, or None for no arguments.

    Returns:
        Tool result dict on success, None on timeout or error.
        Callers should fall back to built-in heuristic when None is returned.
    """
    if arguments is None:
        arguments = {}

    if client.is_mock:
        return _call_mock(client, tool_name, arguments)

    if client.transport == "socket":
        return _call_socket(client, tool_name, arguments)

    if client.transport == "subprocess":
        return _call_subprocess(client, tool_name, arguments)

    logger.error("MCP: unknown transport %r", client.transport)
    return None


def _call_mock(
    client: MCPClient,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any] | None:
    """Handle mock transport — return pre-configured response.

    Mock responses are keyed by tool_name. If no mock is registered for the
    requested tool, returns None (simulating MCP unavailability).
    """
    response = client._mock_responses.get(tool_name)
    if response is None:
        logger.debug("MCP mock: no response registered for %r", tool_name)
        return None
    return response


def _call_socket(
    client: MCPClient,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any] | None:
    """Call MCP tool via Unix domain socket (stdio transport).

    Uses socat or direct socket communication to send a JSON-RPC request
    to the MCP socket and read the response.
    """
    request = _build_jsonrpc_request(tool_name, arguments)

    try:
        import socket as socket_mod

        sock = socket_mod.socket(socket_mod.AF_UNIX, socket_mod.SOCK_STREAM)
        sock.settimeout(MCP_CALL_TIMEOUT)
        sock.connect(client.socket_path)

        # Send request
        payload = json.dumps(request) + "\n"
        sock.sendall(payload.encode("utf-8"))

        # Read response
        response_data = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response_data += chunk
            # Check if we have a complete JSON object
            try:
                json.loads(response_data.decode("utf-8"))
                break
            except json.JSONDecodeError:
                continue

        sock.close()
        return _parse_jsonrpc_response(response_data.decode("utf-8"))

    except (OSError, TimeoutError) as e:
        logger.warning("MCP socket call timed out or failed for %r: %s", tool_name, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("MCP socket call error for %r: %s", tool_name, e)
        return None


def _call_subprocess(
    client: MCPClient,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any] | None:
    """Call MCP tool by spawning the server as a subprocess.

    Resolves the server from the tool_name prefix (e.g. "instance-sizer"
    from "instance-sizer/recommend") and spawns it using the command from
    mcp.json config.
    """
    # Parse server name from tool_name (format: "server-name/tool-method")
    server_name = tool_name.split("/")[0] if "/" in tool_name else tool_name

    servers = client.server_config.get("mcpServers", {})
    server_def = servers.get(server_name)

    if not server_def:
        logger.warning("MCP: server %r not found in config", server_name)
        return None

    command = server_def.get("command")
    args = server_def.get("args", [])

    if not command:
        logger.warning("MCP: server %r has no command", server_name)
        return None

    request = _build_jsonrpc_request(tool_name, arguments)

    try:
        proc = subprocess.Popen(
            [command] + args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        payload = json.dumps(request) + "\n"
        stdout, stderr = proc.communicate(input=payload, timeout=MCP_CALL_TIMEOUT)

        if proc.returncode != 0:
            logger.warning(
                "MCP subprocess %r exited with code %d: %s",
                server_name,
                proc.returncode,
                stderr.strip(),
            )
            return None

        return _parse_jsonrpc_response(stdout)

    except subprocess.TimeoutExpired:
        logger.warning("MCP subprocess call timed out for %r (>%ds)", tool_name, MCP_CALL_TIMEOUT)
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:  # noqa: BLE001
            pass
        return None
    except (OSError, FileNotFoundError) as e:
        logger.warning("MCP subprocess spawn failed for %r: %s", server_name, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("MCP subprocess call error for %r: %s", tool_name, e)
        return None


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------


def _build_jsonrpc_request(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 request for an MCP tools/call.

    Args:
        tool_name: Full tool name (e.g. "instance-sizer/recommend").
        arguments: Tool arguments.

    Returns:
        JSON-RPC request dict ready for serialization.
    """
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }


# ---------------------------------------------------------------------------
# High-level MCP tool wrappers
# ---------------------------------------------------------------------------


def mcp_list_endpoints(
    client: MCPClient,
    region: str,
) -> list[str]:
    """Call MCP endpoint-picker/list and return InService endpoint names.

    Wraps the low-level call_tool() to list available SageMaker endpoints
    in the given region. Filters results to only InService endpoints.

    Used by managed-inference "Attach to existing" flow (FR-5.3) to list
    available endpoints for the user to pick from.

    Args:
        client: MCPClient instance from discover_mcp().
        region: AWS region string (e.g. "us-east-1").

    Returns:
        List of endpoint name strings (InService only), or empty list
        on failure/timeout. Callers fall back to manual input when empty.
    """
    result = call_tool(client, "endpoint-picker/list", {"region": region})

    if result is None:
        return []

    # Validate response structure: {"endpoints": [...]}
    endpoints = result.get("endpoints")
    if not isinstance(endpoints, list):
        logger.warning(
            "MCP endpoint-picker/list returned invalid response: endpoints is not a list"
        )
        return []

    # Filter to InService endpoints and extract names
    names: list[str] = []
    for ep in endpoints:
        if not isinstance(ep, dict):
            continue
        if ep.get("status") == "InService":
            name = ep.get("name")
            if isinstance(name, str) and name:
                names.append(name)

    return names


def mcp_recommend_instance(
    client: MCPClient,
    model_name: str,
    precision: str,
) -> dict[str, Any] | None:
    """Call MCP instance-sizer/recommend and return the recommendation.

    Wraps the low-level call_tool() to provide a typed interface for
    instance sizing recommendations. On success returns a dict with at
    least ``instance_type`` (str) and optionally ``gpu_count`` (int) and
    ``instances`` (list of alternatives).

    Args:
        client: MCPClient instance from discover_mcp().
        model_name: Model identifier (e.g. "meta-llama/Llama-2-7b-hf").
        precision: Data type string (e.g. "float16", "int8").

    Returns:
        Dict with ``instance_type``, and optionally ``gpu_count`` and
        ``instances``, or None on failure/timeout. Callers should fall
        back to the built-in heuristic when None is returned.
    """
    result = call_tool(
        client,
        "instance-sizer/recommend",
        {"model": model_name, "precision": precision},
    )

    if result is None:
        return None

    # Validate that the response contains at minimum instance_type
    instance_type = result.get("instance_type")
    if not instance_type or not isinstance(instance_type, str):
        logger.warning(
            "MCP instance-sizer/recommend returned invalid response: missing instance_type"
        )
        return None

    recommendation: dict[str, Any] = {"instance_type": instance_type}

    # Extract optional fields
    gpu_count = result.get("gpu_count")
    if gpu_count is not None:
        recommendation["gpu_count"] = int(gpu_count)

    instances = result.get("instances")
    if isinstance(instances, list):
        recommendation["instances"] = instances

    return recommendation


def mcp_list_clusters(
    client: MCPClient,
    region: str,
) -> list[dict[str, Any]]:
    """Call MCP cluster-picker/list and return clusters with GPU capacity.

    Wraps the low-level call_tool() to list available HyperPod EKS clusters
    in the given region, including their GPU capacity and Kueue queue info.

    Used by HyperPod EKS flow (FR-6.1, FR-6.4) to show available clusters
    and Kueue queues for the user to select.

    Args:
        client: MCPClient instance from discover_mcp().
        region: AWS region string (e.g. "us-east-1").

    Returns:
        List of cluster dicts (each with name, gpu_capacity, queues),
        or empty list on failure/timeout. Callers fall back to manual
        input when empty.
    """
    result = call_tool(client, "cluster-picker/list", {"region": region})

    if result is None:
        return []

    # Validate response structure: {"clusters": [...]}
    clusters = result.get("clusters")
    if not isinstance(clusters, list):
        logger.warning(
            "MCP cluster-picker/list returned invalid response: clusters is not a list"
        )
        return []

    # Validate and extract cluster entries
    validated: list[dict[str, Any]] = []
    for entry in clusters:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        gpu_capacity = entry.get("gpu_capacity")
        queues = entry.get("queues")

        # Required fields: name (str), gpu_capacity (int-like)
        if not isinstance(name, str) or not name:
            continue
        if gpu_capacity is None:
            continue
        try:
            gpu_capacity_int = int(gpu_capacity)
        except (TypeError, ValueError):
            continue

        # queues should be a list of strings; default to empty list
        if not isinstance(queues, list):
            queues = []
        queues = [q for q in queues if isinstance(q, str)]

        validated.append({
            "name": name,
            "gpu_capacity": gpu_capacity_int,
            "queues": queues,
        })

    return validated


def _parse_jsonrpc_response(raw: str) -> dict[str, Any] | None:
    """Parse a JSON-RPC 2.0 response and extract the result.

    Args:
        raw: Raw JSON string from the MCP server response.

    Returns:
        The result dict from the response, or None if parsing fails
        or the response contains an error.
    """
    if not raw or not raw.strip():
        return None

    try:
        response = json.loads(raw.strip())
    except json.JSONDecodeError:
        logger.warning("MCP: failed to parse JSON-RPC response")
        return None

    # Check for JSON-RPC error
    if "error" in response:
        error = response["error"]
        logger.warning(
            "MCP: JSON-RPC error %s: %s",
            error.get("code", "unknown"),
            error.get("message", "unknown error"),
        )
        return None

    return response.get("result")
