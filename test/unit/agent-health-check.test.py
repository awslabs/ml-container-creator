# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Minimal unit tests for src/agent/health_check.py — edge cases.

Complements the existing test/unit/test_health_check.py (32 tests).
Focus on edge cases: timeout handling, malformed config, and report printing.
"""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.agent.health_check import EnvironmentHealthCheck, HealthItem


class TestNodeVersionEdgeCases:
    """Edge cases for _check_node_version not in the existing suite."""

    @patch("subprocess.run")
    def test_node_timeout(self, mock_run):
        """Subprocess timeout returns 'warn' rather than crashing."""
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="node", timeout=10)
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "warn"
        assert "timed out" in result.message

    @patch("subprocess.run")
    def test_node_unparseable_version(self, mock_run):
        """Unparseable version string returns 'warn'."""
        mock_run.return_value = MagicMock(returncode=0, stdout="not-a-version\n")
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "warn"
        assert "Could not parse" in result.message


class TestBootstrapProfileEdgeCases:
    """Edge cases for _check_bootstrap_profile."""

    def test_malformed_json(self, tmp_path, monkeypatch):
        """Malformed JSON in config file returns 'fail'."""
        config_file = tmp_path / "config.json"
        config_file.write_text("{not valid json")
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "fail"
        assert "Cannot parse" in result.message

    def test_profile_name_not_in_profiles(self, tmp_path, monkeypatch):
        """activeProfile references a non-existent profile name."""
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps(
                {
                    "activeProfile": "nonexistent",
                    "profiles": {"default": {"accountId": "123", "roleArn": "arn"}},
                }
            )
        )
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "warn"
        assert "nonexistent" in result.message


class TestAwsCredentialsEdgeCases:
    """Edge cases for _check_aws_credentials."""

    @patch("boto3.client")
    def test_network_unreachable(self, mock_client):
        """Network errors (e.g. EndpointConnectionError) return 'warn'."""
        from botocore.exceptions import EndpointConnectionError

        mock_sts = MagicMock()
        mock_sts.get_caller_identity.side_effect = EndpointConnectionError(endpoint_url="https://sts.us-east-1.amazonaws.com")
        mock_client.return_value = mock_sts
        hc = EnvironmentHealthCheck()
        result = hc._check_aws_credentials()
        assert result.status == "warn"
        assert "Could not verify" in result.message


class TestHealthItemDataclass:
    """Additional HealthItem behavior."""

    def test_unknown_status_icon(self):
        """Unknown status returns '?' icon."""
        item = HealthItem("unknown", "Test", "msg")
        assert item.icon == "?"
