"""Integration tests for MCP mock workflow ($MCP_MOCK_RESPONSES).

Demonstrates the full end-to-end mock workflow for all three MCP tools
(instance-sizer/recommend, endpoint-picker/list, cluster-picker/list)
used by the prompt engine.

Validates: Requirements FR-2.4, FR-10.1, FR-10.2, FR-10.4, NFR-3.2
"""
from __future__ import annotations

import json

import pytest

from deploy_prompts import (
    _MCP_FALLBACK_WARNING,
    get_clusters,
    get_endpoints,
    get_instance_recommendation,
)
from mcp_client import (
    MCPClient,
    call_tool,
    discover_mcp,
    mcp_list_clusters,
    mcp_list_endpoints,
    mcp_recommend_instance,
)


# ---------------------------------------------------------------------------
# Full mock response data (reusable across tests)
# ---------------------------------------------------------------------------

FULL_MOCK_RESPONSES = {
    "instance-sizer/recommend": {
        "instance_type": "ml.g5.xlarge",
        "gpu_count": 1,
        "instances": [
            {"instance_type": "ml.g5.xlarge", "gpu_count": 1},
            {"instance_type": "ml.g5.2xlarge", "gpu_count": 1},
            {"instance_type": "ml.g6.xlarge", "gpu_count": 1},
        ],
    },
    "endpoint-picker/list": {
        "endpoints": [
            {"name": "prod-bert-ep", "status": "InService"},
            {"name": "staging-llama-ep", "status": "InService"},
            {"name": "dev-ep-creating", "status": "Creating"},
        ],
    },
    "cluster-picker/list": {
        "clusters": [
            {"name": "prod-cluster", "gpu_capacity": 32, "queues": ["default", "priority"]},
            {"name": "dev-cluster", "gpu_capacity": 8, "queues": ["default"]},
        ],
    },
}


# ---------------------------------------------------------------------------
# Integration: Full mock workflow via conftest fixture
# ---------------------------------------------------------------------------


class TestMCPMockIntegrationFixture:
    """End-to-end integration test using the mcp_mock_responses conftest fixture.

    Validates: Requirements NFR-3.2
    """

    def test_fixture_sets_up_mock_client(self, mcp_mock_responses) -> None:
        """The fixture correctly configures discover_mcp() to return a mock client."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        client = discover_mcp()
        assert client is not None
        assert client.is_mock is True
        assert client.transport == "mock"

    def test_all_three_tools_via_fixture(self, mcp_mock_responses) -> None:
        """All three MCP tools return expected mock data via the fixture."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        client = discover_mcp()
        assert client is not None

        # instance-sizer/recommend
        rec = mcp_recommend_instance(client, "meta-llama/Llama-2-7b-hf", "float16")
        assert rec is not None
        assert rec["instance_type"] == "ml.g5.xlarge"
        assert rec["gpu_count"] == 1
        assert len(rec["instances"]) == 3

        # endpoint-picker/list
        endpoints = mcp_list_endpoints(client, "us-east-1")
        assert endpoints == ["prod-bert-ep", "staging-llama-ep"]

        # cluster-picker/list
        clusters = mcp_list_clusters(client, "us-east-1")
        assert len(clusters) == 2
        assert clusters[0]["name"] == "prod-cluster"
        assert clusters[0]["gpu_capacity"] == 32
        assert clusters[0]["queues"] == ["default", "priority"]
        assert clusters[1]["name"] == "dev-cluster"

    def test_fixture_isolates_between_tests(self, mcp_mock_responses) -> None:
        """Each test gets a fresh mock — previous test's data doesn't leak."""
        # Set up with different data than FULL_MOCK_RESPONSES
        custom_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.p4d.24xlarge",
                "gpu_count": 8,
            }
        }
        mcp_mock_responses(custom_responses)

        client = discover_mcp()
        assert client is not None

        rec = mcp_recommend_instance(client, "large-model/70b", "float16")
        assert rec is not None
        assert rec["instance_type"] == "ml.p4d.24xlarge"
        assert rec["gpu_count"] == 8

        # endpoint-picker not registered in this test
        endpoints = mcp_list_endpoints(client, "us-east-1")
        assert endpoints == []


# ---------------------------------------------------------------------------
# Integration: High-level prompt engine functions with mock
# ---------------------------------------------------------------------------


class TestPromptEngineMCPIntegration:
    """Integration test for deploy_prompts high-level functions with $MCP_MOCK_RESPONSES.

    Verifies that get_instance_recommendation(), get_endpoints(), and
    get_clusters() correctly route through the mock transport when
    $MCP_MOCK_RESPONSES is set.

    Validates: Requirements FR-2.4, FR-10.1, FR-10.2, NFR-3.2
    """

    def test_get_instance_recommendation_uses_mock(
        self, mcp_mock_responses, capsys
    ) -> None:
        """get_instance_recommendation uses MCP mock and skips heuristic."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        result = get_instance_recommendation("meta-llama/Llama-2-7b-hf", "float16")

        assert result == "ml.g5.xlarge"
        # No fallback warning should appear
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_get_endpoints_uses_mock(self, mcp_mock_responses, capsys) -> None:
        """get_endpoints uses MCP mock and returns InService endpoints."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        result = get_endpoints("us-east-1")

        # Only InService endpoints are returned
        assert result == ["prod-bert-ep", "staging-llama-ep"]
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_get_clusters_uses_mock(self, mcp_mock_responses, capsys) -> None:
        """get_clusters uses MCP mock and returns cluster data."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        result = get_clusters("us-east-1")

        assert len(result) == 2
        assert result[0]["name"] == "prod-cluster"
        assert result[0]["gpu_capacity"] == 32
        assert result[0]["queues"] == ["default", "priority"]
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_all_three_functions_in_single_flow(
        self, mcp_mock_responses, capsys
    ) -> None:
        """Simulate a full deploy flow calling all three MCP functions."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        # Step 1: Get instance recommendation
        instance_type = get_instance_recommendation("bert-base-uncased", "float16")
        assert instance_type == "ml.g5.xlarge"

        # Step 2: Get endpoints (for "attach to existing" flow)
        endpoints = get_endpoints("us-east-1")
        assert len(endpoints) == 2
        assert "prod-bert-ep" in endpoints

        # Step 3: Get clusters (for HyperPod flow)
        clusters = get_clusters("us-east-1")
        assert len(clusters) == 2
        assert clusters[0]["name"] == "prod-cluster"

        # No warnings throughout the entire flow
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err


# ---------------------------------------------------------------------------
# Integration: Mock with partial responses
# ---------------------------------------------------------------------------


class TestPartialMockResponses:
    """Test behavior when only some tools are mocked (partial coverage).

    Validates: Requirements FR-10.4, NFR-3.2
    """

    def test_unmocked_tool_falls_back_gracefully(
        self, mcp_mock_responses, monkeypatch, capsys
    ) -> None:
        """Tools without mock entries trigger fallback (return None/empty)."""
        # Only mock the instance-sizer — endpoints and clusters not registered
        mcp_mock_responses({
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
                "gpu_count": 1,
            }
        })

        # Instance recommendation works (mocked)
        result = get_instance_recommendation("test-model/7b", "float16")
        assert result == "ml.g5.xlarge"

        # Endpoints: mock client exists but tool not registered → empty + warning
        endpoints = get_endpoints("us-east-1")
        assert endpoints == []
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_mock_with_empty_responses_triggers_fallback(
        self, mcp_mock_responses, monkeypatch, capsys
    ) -> None:
        """Empty mock responses dict means all tools fall back."""
        mcp_mock_responses({})
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g6e.xlarge",
        )

        result = get_instance_recommendation("test-model", "float16")
        assert result == "ml.g6e.xlarge"
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err


# ---------------------------------------------------------------------------
# Integration: Mock reusability across multiple discover_mcp() calls
# ---------------------------------------------------------------------------


class TestMockReusability:
    """Verify mock is reusable across multiple discover_mcp() invocations.

    Each high-level function (get_instance_recommendation, get_endpoints,
    get_clusters) calls discover_mcp() independently. The mock env var
    must work consistently across all calls within a single test.

    Validates: Requirements NFR-3.2
    """

    def test_multiple_discover_calls_all_return_mock(
        self, mcp_mock_responses
    ) -> None:
        """Multiple discover_mcp() calls within one test all return mock clients."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        client1 = discover_mcp()
        client2 = discover_mcp()
        client3 = discover_mcp()

        assert client1 is not None and client1.is_mock
        assert client2 is not None and client2.is_mock
        assert client3 is not None and client3.is_mock

        # All clients can serve different tools
        assert call_tool(client1, "instance-sizer/recommend") is not None
        assert call_tool(client2, "endpoint-picker/list") is not None
        assert call_tool(client3, "cluster-picker/list") is not None

    def test_mock_data_consistent_across_clients(
        self, mcp_mock_responses
    ) -> None:
        """All clients created from the same env var return identical data."""
        mcp_mock_responses(FULL_MOCK_RESPONSES)

        # Create two clients and verify they return the same data
        client_a = discover_mcp()
        client_b = discover_mcp()
        assert client_a is not None
        assert client_b is not None

        rec_a = mcp_recommend_instance(client_a, "model/7b", "float16")
        rec_b = mcp_recommend_instance(client_b, "model/7b", "float16")
        assert rec_a == rec_b

        ep_a = mcp_list_endpoints(client_a, "us-east-1")
        ep_b = mcp_list_endpoints(client_b, "us-east-1")
        assert ep_a == ep_b


# ---------------------------------------------------------------------------
# Integration: Direct monkeypatch usage (without fixture)
# ---------------------------------------------------------------------------


class TestMCPMockWithoutFixture:
    """Demonstrate the $MCP_MOCK_RESPONSES pattern using monkeypatch directly.

    This shows how tests in other files can use $MCP_MOCK_RESPONSES without
    depending on the conftest fixture (for test files that don't import it).

    Validates: Requirements NFR-3.2
    """

    def test_direct_monkeypatch_usage(self, monkeypatch, capsys) -> None:
        """$MCP_MOCK_RESPONSES works with plain monkeypatch.setenv()."""
        mock_data = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g6.2xlarge",
                "gpu_count": 1,
            },
            "endpoint-picker/list": {
                "endpoints": [{"name": "my-ep", "status": "InService"}],
            },
            "cluster-picker/list": {
                "clusters": [{"name": "my-cluster", "gpu_capacity": 16, "queues": ["train"]}],
            },
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_data))
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        # All three functions work correctly
        assert get_instance_recommendation("model", "float16") == "ml.g6.2xlarge"
        assert get_endpoints("us-west-2") == ["my-ep"]
        clusters = get_clusters("us-west-2")
        assert len(clusters) == 1
        assert clusters[0]["name"] == "my-cluster"

        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err
