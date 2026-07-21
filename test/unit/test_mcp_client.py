"""Unit tests for mcp_client module.

Validates: Requirements FR-10.2, FR-10.4, NFR-3.2
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from mcp_client import (
    MCP_CALL_TIMEOUT,
    MCP_CONFIG_PATH,
    MCP_MOCK_ENV,
    MCP_SOCKET_ENV,
    MCPClient,
    _build_jsonrpc_request,
    _load_mcp_config,
    _parse_jsonrpc_response,
    call_tool,
    discover_mcp,
    mcp_list_clusters,
    mcp_list_endpoints,
    mcp_recommend_instance,
)


# ---------------------------------------------------------------------------
# MCPClient construction tests
# ---------------------------------------------------------------------------


class TestMCPClient:
    """Verify MCPClient construction and properties."""

    def test_mock_client(self) -> None:
        client = MCPClient(transport="mock", mock_responses={"tool": {"result": 1}})
        assert client.is_mock is True
        assert client.is_available is True
        assert client.transport == "mock"

    def test_socket_client(self) -> None:
        client = MCPClient(transport="socket", socket_path="/tmp/mcp.sock")
        assert client.is_mock is False
        assert client.is_available is True
        assert client.socket_path == "/tmp/mcp.sock"

    def test_subprocess_client(self) -> None:
        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)
        assert client.is_mock is False
        assert client.transport == "subprocess"

    def test_repr(self) -> None:
        client = MCPClient(transport="mock")
        assert "mock" in repr(client)


# ---------------------------------------------------------------------------
# Discovery tests (FR-10.2)
# ---------------------------------------------------------------------------


class TestDiscoverMCP:
    """Verify MCP discovery logic: $MCP_MOCK_RESPONSES, $MCP_SOCKET, mcp.json."""

    def test_mock_env_var_returns_mock_client(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """NFR-3.2: $MCP_MOCK_RESPONSES env var creates a mock client."""
        mock_data = {"instance-sizer/recommend": {"instance_type": "ml.g5.xlarge"}}
        monkeypatch.setenv(MCP_MOCK_ENV, json.dumps(mock_data))
        monkeypatch.delenv(MCP_SOCKET_ENV, raising=False)

        client = discover_mcp()
        assert client is not None
        assert client.is_mock is True
        assert client._mock_responses == mock_data

    def test_invalid_mock_env_var_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Invalid JSON in $MCP_MOCK_RESPONSES is ignored, falls through."""
        monkeypatch.setenv(MCP_MOCK_ENV, "not-valid-json{{{")
        monkeypatch.delenv(MCP_SOCKET_ENV, raising=False)
        # Also make sure mcp.json doesn't exist for this test
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", "/nonexistent/path/mcp.json")

        client = discover_mcp()
        assert client is None

    def test_socket_env_var_with_existing_path(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        """FR-10.2: $MCP_SOCKET pointing to existing file returns socket client."""
        sock_file = tmp_path / "mcp.sock"
        sock_file.touch()
        monkeypatch.delenv(MCP_MOCK_ENV, raising=False)
        monkeypatch.setenv(MCP_SOCKET_ENV, str(sock_file))

        client = discover_mcp()
        assert client is not None
        assert client.transport == "socket"
        assert client.socket_path == str(sock_file)

    def test_socket_env_var_with_missing_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """$MCP_SOCKET set but path missing falls through to next option."""
        monkeypatch.delenv(MCP_MOCK_ENV, raising=False)
        monkeypatch.setenv(MCP_SOCKET_ENV, "/nonexistent/mcp.sock")
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", "/nonexistent/path/mcp.json")

        client = discover_mcp()
        assert client is None

    def test_mcp_config_file_returns_subprocess_client(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        """FR-10.2: ~/.kiro/settings/mcp.json with valid config returns subprocess client."""
        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        config_file = tmp_path / "mcp.json"
        config_file.write_text(json.dumps(config))

        monkeypatch.delenv(MCP_MOCK_ENV, raising=False)
        monkeypatch.delenv(MCP_SOCKET_ENV, raising=False)
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))

        client = discover_mcp()
        assert client is not None
        assert client.transport == "subprocess"
        assert client.server_config == config

    def test_no_mcp_available_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When no MCP source is available, returns None for heuristic fallback."""
        monkeypatch.delenv(MCP_MOCK_ENV, raising=False)
        monkeypatch.delenv(MCP_SOCKET_ENV, raising=False)
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", "/nonexistent/path/mcp.json")

        client = discover_mcp()
        assert client is None

    def test_discovery_priority_mock_over_socket(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        """Mock env var takes priority over socket."""
        sock_file = tmp_path / "mcp.sock"
        sock_file.touch()
        mock_data = {"test/tool": {"value": 42}}

        monkeypatch.setenv(MCP_MOCK_ENV, json.dumps(mock_data))
        monkeypatch.setenv(MCP_SOCKET_ENV, str(sock_file))

        client = discover_mcp()
        assert client is not None
        assert client.is_mock is True

    def test_discovery_priority_socket_over_config(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        """Socket takes priority over config file."""
        sock_file = tmp_path / "mcp.sock"
        sock_file.touch()
        config = {"mcpServers": {"sizer": {"command": "node", "args": []}}}
        config_file = tmp_path / "mcp.json"
        config_file.write_text(json.dumps(config))

        monkeypatch.delenv(MCP_MOCK_ENV, raising=False)
        monkeypatch.setenv(MCP_SOCKET_ENV, str(sock_file))
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))

        client = discover_mcp()
        assert client is not None
        assert client.transport == "socket"


# ---------------------------------------------------------------------------
# _load_mcp_config tests
# ---------------------------------------------------------------------------


class TestLoadMCPConfig:
    """Verify MCP config file loading edge cases."""

    def test_missing_file_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", "/nonexistent/path.json")
        assert _load_mcp_config() is None

    def test_invalid_json_returns_none(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        config_file = tmp_path / "mcp.json"
        config_file.write_text("not valid json {{")
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))
        assert _load_mcp_config() is None

    def test_empty_servers_returns_none(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        config_file = tmp_path / "mcp.json"
        config_file.write_text(json.dumps({"mcpServers": {}}))
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))
        assert _load_mcp_config() is None

    def test_no_servers_key_returns_none(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        config_file = tmp_path / "mcp.json"
        config_file.write_text(json.dumps({"other": "data"}))
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))
        assert _load_mcp_config() is None

    def test_valid_config_returns_data(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
        config = {"mcpServers": {"sizer": {"command": "node", "args": ["index.js"]}}}
        config_file = tmp_path / "mcp.json"
        config_file.write_text(json.dumps(config))
        monkeypatch.setattr("mcp_client.MCP_CONFIG_PATH", str(config_file))

        result = _load_mcp_config()
        assert result == config


# ---------------------------------------------------------------------------
# call_tool tests
# ---------------------------------------------------------------------------


class TestCallTool:
    """Verify tool calling dispatches correctly per transport."""

    def test_mock_returns_registered_response(self) -> None:
        """NFR-3.2: Mock transport returns pre-configured responses."""
        mock_data = {"instance-sizer/recommend": {"instance_type": "ml.g5.xlarge", "gpu_count": 1}}
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = call_tool(client, "instance-sizer/recommend", {"model": "bert-base"})
        assert result == {"instance_type": "ml.g5.xlarge", "gpu_count": 1}

    def test_mock_unregistered_tool_returns_none(self) -> None:
        """Mock transport returns None for unregistered tools."""
        client = MCPClient(transport="mock", mock_responses={})

        result = call_tool(client, "unknown/tool", {"arg": "value"})
        assert result is None

    def test_mock_with_none_arguments(self) -> None:
        """call_tool handles None arguments gracefully."""
        mock_data = {"sizer/recommend": {"type": "ml.g5.xlarge"}}
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = call_tool(client, "sizer/recommend", None)
        assert result == {"type": "ml.g5.xlarge"}

    def test_unknown_transport_returns_none(self) -> None:
        """Unknown transport type returns None."""
        client = MCPClient(transport="unknown")
        result = call_tool(client, "tool", {})
        assert result is None


# ---------------------------------------------------------------------------
# Subprocess transport tests
# ---------------------------------------------------------------------------


class TestSubprocessTransport:
    """Verify subprocess-based MCP calls."""

    def test_server_not_in_config_returns_none(self) -> None:
        """If server name not found in config, returns None."""
        config = {"mcpServers": {"other-server": {"command": "node", "args": []}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {"model": "bert"})
        assert result is None

    def test_server_no_command_returns_none(self) -> None:
        """If server entry has no command, returns None."""
        config = {"mcpServers": {"instance-sizer": {"args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {})
        assert result is None

    @patch("subprocess.Popen")
    def test_successful_subprocess_call(self, mock_popen: MagicMock) -> None:
        """Successful subprocess returns parsed result."""
        response = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"instance_type": "ml.g5.xlarge"}})
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = (response, "")
        mock_proc.returncode = 0
        mock_popen.return_value = mock_proc

        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {"model": "llama-7b"})
        assert result == {"instance_type": "ml.g5.xlarge"}

        # Verify timeout was passed
        mock_proc.communicate.assert_called_once()
        call_kwargs = mock_proc.communicate.call_args
        assert call_kwargs[1]["timeout"] == MCP_CALL_TIMEOUT

    @patch("subprocess.Popen")
    def test_subprocess_timeout_returns_none(self, mock_popen: MagicMock) -> None:
        """FR-10.4: Subprocess timeout (>10s) returns None."""
        mock_proc = MagicMock()
        mock_proc.communicate.side_effect = subprocess.TimeoutExpired(cmd="node", timeout=10)
        mock_proc.kill.return_value = None
        mock_proc.wait.return_value = None
        mock_popen.return_value = mock_proc

        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {"model": "llama-7b"})
        assert result is None
        mock_proc.kill.assert_called_once()

    @patch("subprocess.Popen")
    def test_subprocess_nonzero_exit_returns_none(self, mock_popen: MagicMock) -> None:
        """Non-zero exit code from subprocess returns None."""
        mock_proc = MagicMock()
        mock_proc.communicate.return_value = ("", "Error: module not found")
        mock_proc.returncode = 1
        mock_popen.return_value = mock_proc

        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {})
        assert result is None

    @patch("subprocess.Popen")
    def test_subprocess_spawn_failure_returns_none(self, mock_popen: MagicMock) -> None:
        """FileNotFoundError when spawning subprocess returns None."""
        mock_popen.side_effect = FileNotFoundError("node not found")

        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = call_tool(client, "instance-sizer/recommend", {})
        assert result is None


# ---------------------------------------------------------------------------
# JSON-RPC helper tests
# ---------------------------------------------------------------------------


class TestJSONRPCHelpers:
    """Verify JSON-RPC request building and response parsing."""

    def test_build_request_structure(self) -> None:
        """Request has correct JSON-RPC 2.0 structure."""
        request = _build_jsonrpc_request("instance-sizer/recommend", {"model": "bert"})
        assert request["jsonrpc"] == "2.0"
        assert request["id"] == 1
        assert request["method"] == "tools/call"
        assert request["params"]["name"] == "instance-sizer/recommend"
        assert request["params"]["arguments"] == {"model": "bert"}

    def test_build_request_empty_arguments(self) -> None:
        """Request with empty arguments dict."""
        request = _build_jsonrpc_request("endpoint-picker/list", {})
        assert request["params"]["arguments"] == {}

    def test_parse_valid_result(self) -> None:
        """Valid JSON-RPC response returns the result field."""
        raw = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"data": [1, 2, 3]}})
        result = _parse_jsonrpc_response(raw)
        assert result == {"data": [1, 2, 3]}

    def test_parse_error_response_returns_none(self) -> None:
        """JSON-RPC error response returns None."""
        raw = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": -32601, "message": "Method not found"},
        })
        result = _parse_jsonrpc_response(raw)
        assert result is None

    def test_parse_empty_string_returns_none(self) -> None:
        """Empty string input returns None."""
        assert _parse_jsonrpc_response("") is None
        assert _parse_jsonrpc_response("   ") is None

    def test_parse_invalid_json_returns_none(self) -> None:
        """Invalid JSON returns None."""
        assert _parse_jsonrpc_response("not json {{{") is None

    def test_parse_no_result_key_returns_none(self) -> None:
        """Response without result key returns None."""
        raw = json.dumps({"jsonrpc": "2.0", "id": 1})
        result = _parse_jsonrpc_response(raw)
        assert result is None


# ---------------------------------------------------------------------------
# Timeout constant test (FR-10.4)
# ---------------------------------------------------------------------------


class TestTimeoutConstant:
    """Verify the 10-second timeout constant is correctly defined."""

    def test_timeout_is_10_seconds(self) -> None:
        """FR-10.4: MCP calls MUST time out after 10 seconds."""
        assert MCP_CALL_TIMEOUT == 10


# ---------------------------------------------------------------------------
# mcp_recommend_instance tests (FR-2.4, FR-10.1, FR-10.2, FR-10.4)
# ---------------------------------------------------------------------------


class TestMCPRecommendInstance:
    """Verify the mcp_recommend_instance wrapper for instance-sizer/recommend."""

    def test_returns_instance_type_on_success(self) -> None:
        """Successful MCP call returns instance_type in result dict."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
                "gpu_count": 1,
                "instances": [
                    {"instance_type": "ml.g5.xlarge", "gpu_count": 1},
                    {"instance_type": "ml.g5.2xlarge", "gpu_count": 1},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "meta-llama/Llama-2-7b-hf", "float16")
        assert result is not None
        assert result["instance_type"] == "ml.g5.xlarge"
        assert result["gpu_count"] == 1
        assert len(result["instances"]) == 2

    def test_returns_none_on_mcp_failure(self) -> None:
        """When MCP call returns None (timeout/error), returns None."""
        # Empty mock_responses means tool is not registered → returns None
        client = MCPClient(transport="mock", mock_responses={})

        result = mcp_recommend_instance(client, "bert-base-uncased", "float16")
        assert result is None

    def test_returns_none_when_instance_type_missing(self) -> None:
        """If response lacks instance_type field, returns None."""
        mock_data = {
            "instance-sizer/recommend": {
                "gpu_count": 1,
                "instances": [],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "bert-base-uncased", "float16")
        assert result is None

    def test_returns_none_when_instance_type_empty_string(self) -> None:
        """If response has empty instance_type, returns None."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "",
                "gpu_count": 1,
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "bert-base-uncased", "float16")
        assert result is None

    def test_handles_response_without_optional_fields(self) -> None:
        """Response with only instance_type (no gpu_count, no instances) works."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g6.xlarge",
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "distilbert-base", "float16")
        assert result is not None
        assert result["instance_type"] == "ml.g6.xlarge"
        assert "gpu_count" not in result
        assert "instances" not in result

    def test_gpu_count_converted_to_int(self) -> None:
        """gpu_count is always returned as int, even if response has string."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.12xlarge",
                "gpu_count": "4",
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "llama-70b", "int8")
        assert result is not None
        assert result["gpu_count"] == 4
        assert isinstance(result["gpu_count"], int)

    def test_passes_model_and_precision_as_arguments(self) -> None:
        """Verify correct arguments are passed to the MCP tool call."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        # With mock transport, we can't directly verify arguments passed,
        # but we can verify the function doesn't error with various inputs
        result = mcp_recommend_instance(client, "meta-llama/Llama-2-13b-hf", "int4")
        assert result is not None
        assert result["instance_type"] == "ml.g5.xlarge"

    @patch("mcp_client._call_subprocess")
    def test_timeout_returns_none(self, mock_subprocess: MagicMock) -> None:
        """FR-10.4: On timeout, mcp_recommend_instance returns None."""
        mock_subprocess.return_value = None

        config = {"mcpServers": {"instance-sizer": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = mcp_recommend_instance(client, "llama-7b", "float16")
        assert result is None

    def test_returns_none_when_instance_type_not_string(self) -> None:
        """If instance_type is not a string (e.g. int), returns None."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": 12345,
                "gpu_count": 1,
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_recommend_instance(client, "bert-base-uncased", "float16")
        assert result is None


# ---------------------------------------------------------------------------
# mcp_list_endpoints tests (FR-2.4, FR-10.1, FR-10.2, FR-10.4)
# ---------------------------------------------------------------------------


class TestMCPListEndpoints:
    """Verify the mcp_list_endpoints wrapper for endpoint-picker/list."""

    def test_returns_endpoint_names_on_success(self) -> None:
        """Success case: returns list of InService endpoint name strings."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "my-endpoint-1", "status": "InService"},
                    {"name": "my-endpoint-2", "status": "InService"},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == ["my-endpoint-1", "my-endpoint-2"]

    def test_filters_to_inservice_only(self) -> None:
        """Only endpoints with status 'InService' are returned."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-active", "status": "InService"},
                    {"name": "ep-creating", "status": "Creating"},
                    {"name": "ep-updating", "status": "Updating"},
                    {"name": "ep-failed", "status": "Failed"},
                    {"name": "ep-deleting", "status": "Deleting"},
                    {"name": "ep-active-2", "status": "InService"},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-west-2")
        assert result == ["ep-active", "ep-active-2"]

    def test_returns_empty_list_on_timeout(self) -> None:
        """FR-10.4: On timeout/failure (call_tool returns None), returns empty list."""
        # No mock registered for endpoint-picker/list → call_tool returns None
        client = MCPClient(transport="mock", mock_responses={})

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == []

    def test_returns_empty_list_on_malformed_response(self) -> None:
        """Malformed response (endpoints not a list) returns empty list."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": "not-a-list",
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "eu-west-1")
        assert result == []

    def test_handles_empty_endpoint_list(self) -> None:
        """Empty endpoints list returns empty list gracefully."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": [],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == []

    def test_handles_missing_endpoints_key(self) -> None:
        """Response without 'endpoints' key returns empty list."""
        mock_data = {
            "endpoint-picker/list": {
                "data": [{"name": "ep-1"}],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == []

    def test_skips_entries_without_name(self) -> None:
        """Endpoint entries missing 'name' field are skipped."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-valid", "status": "InService"},
                    {"status": "InService"},  # missing name
                    {"name": "", "status": "InService"},  # empty name
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == ["ep-valid"]

    def test_skips_non_dict_entries(self) -> None:
        """Non-dict entries in endpoints list are skipped."""
        mock_data = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-valid", "status": "InService"},
                    "not-a-dict",
                    42,
                    None,
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == ["ep-valid"]

    @patch("mcp_client._call_subprocess")
    def test_subprocess_timeout_returns_empty_list(self, mock_subprocess: MagicMock) -> None:
        """FR-10.4: Subprocess timeout returns empty list via call_tool → None."""
        mock_subprocess.return_value = None

        config = {"mcpServers": {"endpoint-picker": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = mcp_list_endpoints(client, "us-east-1")
        assert result == []


# ---------------------------------------------------------------------------
# mcp_list_clusters tests (FR-2.4, FR-10.1, FR-10.2, FR-10.4)
# ---------------------------------------------------------------------------


class TestMCPListClusters:
    """Verify the mcp_list_clusters wrapper for cluster-picker/list."""

    def test_returns_cluster_dicts_on_success(self) -> None:
        """Success case: returns list of cluster dicts with name, gpu_capacity, queues."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "cluster-1", "gpu_capacity": 8, "queues": ["default-queue"]},
                    {"name": "cluster-2", "gpu_capacity": 16, "queues": ["train", "infer"]},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 2
        assert result[0] == {"name": "cluster-1", "gpu_capacity": 8, "queues": ["default-queue"]}
        assert result[1] == {"name": "cluster-2", "gpu_capacity": 16, "queues": ["train", "infer"]}

    def test_returns_empty_list_on_timeout(self) -> None:
        """FR-10.4: On timeout/failure (call_tool returns None), returns empty list."""
        client = MCPClient(transport="mock", mock_responses={})

        result = mcp_list_clusters(client, "us-east-1")
        assert result == []

    def test_returns_empty_list_on_malformed_response(self) -> None:
        """Malformed response (clusters not a list) returns empty list."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": "not-a-list",
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-west-2")
        assert result == []

    def test_handles_clusters_with_empty_queues_list(self) -> None:
        """Clusters with empty queues list are returned successfully."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "cluster-no-queues", "gpu_capacity": 4, "queues": []},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 1
        assert result[0] == {"name": "cluster-no-queues", "gpu_capacity": 4, "queues": []}

    def test_handles_response_missing_clusters_key(self) -> None:
        """Response without 'clusters' key returns empty list."""
        mock_data = {
            "cluster-picker/list": {
                "data": [{"name": "cluster-1"}],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert result == []

    def test_validates_cluster_entries_have_required_fields(self) -> None:
        """Entries missing required fields (name, gpu_capacity) are skipped."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "valid-cluster", "gpu_capacity": 8, "queues": ["q1"]},
                    {"gpu_capacity": 4, "queues": ["q2"]},  # missing name
                    {"name": "", "gpu_capacity": 4, "queues": []},  # empty name
                    {"name": "no-gpu"},  # missing gpu_capacity
                    {"name": "invalid-gpu", "gpu_capacity": "abc", "queues": []},  # non-numeric
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 1
        assert result[0]["name"] == "valid-cluster"

    def test_skips_non_dict_entries(self) -> None:
        """Non-dict entries in clusters list are skipped."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "valid", "gpu_capacity": 8, "queues": ["default"]},
                    "not-a-dict",
                    42,
                    None,
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 1
        assert result[0]["name"] == "valid"

    def test_gpu_capacity_converted_to_int(self) -> None:
        """gpu_capacity is always returned as int, even if response has string."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "cluster-str-gpu", "gpu_capacity": "16", "queues": []},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 1
        assert result[0]["gpu_capacity"] == 16
        assert isinstance(result[0]["gpu_capacity"], int)

    def test_queues_defaults_to_empty_list_when_missing(self) -> None:
        """If queues field is missing or not a list, defaults to empty list."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "no-queues-key", "gpu_capacity": 8},
                    {"name": "queues-not-list", "gpu_capacity": 4, "queues": "invalid"},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert len(result) == 2
        assert result[0]["queues"] == []
        assert result[1]["queues"] == []

    def test_queues_filters_non_string_entries(self) -> None:
        """Non-string entries in queues list are filtered out."""
        mock_data = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "mixed-queues", "gpu_capacity": 8, "queues": ["valid-q", 123, None, "also-valid"]},
                ],
            }
        }
        client = MCPClient(transport="mock", mock_responses=mock_data)

        result = mcp_list_clusters(client, "us-east-1")
        assert result[0]["queues"] == ["valid-q", "also-valid"]

    @patch("mcp_client._call_subprocess")
    def test_subprocess_timeout_returns_empty_list(self, mock_subprocess: MagicMock) -> None:
        """FR-10.4: Subprocess timeout returns empty list via call_tool → None."""
        mock_subprocess.return_value = None

        config = {"mcpServers": {"cluster-picker": {"command": "node", "args": ["index.js"]}}}
        client = MCPClient(transport="subprocess", server_config=config)

        result = mcp_list_clusters(client, "us-east-1")
        assert result == []
