# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Integration test: agent MCP server interaction.

Validates that:
1. agent-knowledge MCP server starts and responds via stdio transport
2. instance-sizer MCP server starts and responds via stdio transport
3. Python → Node.js stdio transport works end-to-end
4. Responses are parseable JSON with expected fields

Requires: strands-agents[tools] installed (provides MCPClient).
Skip gracefully when not available.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Skip entire module if strands-agents is not installed
pytest.importorskip("strands", reason="strands-agents not installed")

from strands.tools.mcp import MCPClient

# Project root resolved from this file's location
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture
def agent_knowledge_client():
    """Start the agent-knowledge MCP server as an MCPClient."""
    server_path = str(PROJECT_ROOT / "servers" / "agent-knowledge" / "index.js")
    client = MCPClient(
        command="node",
        args=[server_path],
    )
    client.start()
    yield client
    client.stop()


@pytest.fixture
def instance_sizer_client():
    """Start the instance-sizer MCP server as an MCPClient."""
    server_path = str(PROJECT_ROOT / "servers" / "instance-sizer" / "index.js")
    client = MCPClient(
        command="node",
        args=[server_path],
    )
    client.start()
    yield client
    client.stop()


class TestAgentKnowledgeIntegration:
    """Integration tests for the agent-knowledge MCP server via MCPClient."""

    def test_server_starts_and_lists_tools(self, agent_knowledge_client):
        """Server starts successfully and exposes query_knowledge tool."""
        tools = agent_knowledge_client.list_tools()
        tool_names = [t.name for t in tools]
        assert "query_knowledge" in tool_names

    def test_query_script_reference(self, agent_knowledge_client):
        """query_knowledge with topic=script_reference returns valid JSON array."""
        tools = agent_knowledge_client.list_tools()
        query_tool = next(t for t in tools if t.name == "query_knowledge")

        result = query_tool.invoke(topic="script_reference")

        # Result should be parseable as a list
        assert result is not None
        # MCPClient returns the tool result; parse the text content
        content = result.get("content", [])
        assert len(content) > 0
        text = content[0].get("text", "")
        data = json.loads(text)
        assert isinstance(data, list)
        assert len(data) > 0
        # First entry should have expected fields
        assert "name" in data[0]
        assert "purpose" in data[0]

    def test_query_troubleshooting(self, agent_knowledge_client):
        """query_knowledge with topic=troubleshooting returns valid JSON."""
        tools = agent_knowledge_client.list_tools()
        query_tool = next(t for t in tools if t.name == "query_knowledge")

        result = query_tool.invoke(topic="troubleshooting")

        content = result.get("content", [])
        assert len(content) > 0
        text = content[0].get("text", "")
        data = json.loads(text)
        assert isinstance(data, list)


class TestInstanceSizerIntegration:
    """Integration tests for the instance-sizer MCP server via MCPClient."""

    def test_server_starts_and_lists_tools(self, instance_sizer_client):
        """Server starts successfully and exposes get_instance_recommendation tool."""
        tools = instance_sizer_client.list_tools()
        tool_names = [t.name for t in tools]
        assert "get_instance_recommendation" in tool_names

    def test_get_instance_recommendation(self, instance_sizer_client):
        """get_instance_recommendation returns valid response for known model."""
        tools = instance_sizer_client.list_tools()
        rec_tool = next(t for t in tools if t.name == "get_instance_recommendation")

        result = rec_tool.invoke(modelName="meta-llama/Llama-3.1-8B-Instruct")

        assert result is not None
        content = result.get("content", [])
        assert len(content) > 0
        text = content[0].get("text", "")
        data = json.loads(text)

        # Verify expected response structure
        assert "values" in data
        assert "choices" in data
        assert "metadata" in data
        assert data["values"]["instanceType"].startswith("ml.")
        assert data["metadata"]["source"] == "catalog"


class TestCrossServerCompatibility:
    """Test that both servers can coexist and communicate correctly."""

    def test_both_servers_run_simultaneously(
        self, agent_knowledge_client, instance_sizer_client
    ):
        """Both servers can run and respond without interfering."""
        # Query agent-knowledge
        ak_tools = agent_knowledge_client.list_tools()
        ak_tool = next(t for t in ak_tools if t.name == "query_knowledge")
        ak_result = ak_tool.invoke(topic="capability_matrix")

        # Query instance-sizer
        is_tools = instance_sizer_client.list_tools()
        is_tool = next(t for t in is_tools if t.name == "get_instance_recommendation")
        is_result = is_tool.invoke(modelName="meta-llama/Llama-3.1-8B-Instruct")

        # Both should return valid content
        ak_content = ak_result.get("content", [])
        is_content = is_result.get("content", [])
        assert len(ak_content) > 0
        assert len(is_content) > 0

        # Both should be parseable JSON
        ak_data = json.loads(ak_content[0].get("text", ""))
        is_data = json.loads(is_content[0].get("text", ""))
        assert ak_data is not None
        assert "values" in is_data
