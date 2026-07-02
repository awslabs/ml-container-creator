"""Unit tests for src/agent/health_check.py."""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.agent.health_check import (
    EnvironmentHealthCheck,
    HealthItem,
    print_health_report,
)


class TestHealthItem:
    """Tests for the HealthItem dataclass."""

    def test_pass_icon(self):
        item = HealthItem("pass", "Test", "ok")
        assert "✓" in item.icon

    def test_warn_icon(self):
        item = HealthItem("warn", "Test", "warning")
        assert "⚠" in item.icon

    def test_fail_icon(self):
        item = HealthItem("fail", "Test", "error")
        assert "✗" in item.icon

    def test_str_contains_label_and_message(self):
        item = HealthItem("pass", "Python version", "3.12 (>= 3.10)")
        output = str(item)
        assert "Python version" in output
        assert "3.12 (>= 3.10)" in output


class TestCheckPythonVersion:
    """Tests for _check_python_version."""

    def test_current_python_passes(self):
        """The test runner itself is Python >= 3.10."""
        hc = EnvironmentHealthCheck()
        result = hc._check_python_version()
        assert result.status == "pass"
        assert ">= 3.10" in result.message

    @patch.object(sys, "version_info", (3, 9, 0, "final", 0))
    def test_python_39_fails(self):
        hc = EnvironmentHealthCheck()
        result = hc._check_python_version()
        assert result.status == "fail"
        assert "3.9" in result.message


class TestCheckNodeVersion:
    """Tests for _check_node_version."""

    @patch("subprocess.run")
    def test_node_24_passes(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="v24.1.0\n")
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "pass"
        assert "v24.1.0" in result.message

    @patch("subprocess.run")
    def test_node_22_fails(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="v22.12.0\n")
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "fail"
        assert "v22.12.0" in result.message

    @patch("subprocess.run", side_effect=FileNotFoundError)
    def test_node_not_found(self, mock_run):
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "fail"
        assert "not found" in result.message

    @patch("subprocess.run")
    def test_node_bad_exit_code(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        hc = EnvironmentHealthCheck()
        result = hc._check_node_version()
        assert result.status == "fail"


class TestCheckPipPackages:
    """Tests for _check_pip_packages."""

    @patch("importlib.metadata.version")
    def test_all_packages_present(self, mock_version):
        mock_version.side_effect = lambda pkg: {
            "sagemaker": "2.200.0",
            "boto3": "1.35.0",
            "huggingface_hub": "0.25.0",
        }[pkg]
        hc = EnvironmentHealthCheck()
        result = hc._check_pip_packages()
        assert result.status == "pass"
        assert "sagemaker" in result.message

    @patch("importlib.metadata.version")
    def test_one_package_missing(self, mock_version):
        import importlib.metadata

        def side_effect(pkg):
            if pkg == "huggingface_hub":
                raise importlib.metadata.PackageNotFoundError(pkg)
            return "1.0.0"

        mock_version.side_effect = side_effect
        hc = EnvironmentHealthCheck()
        result = hc._check_pip_packages()
        assert result.status == "warn"
        assert "huggingface_hub" in result.message

    @patch("importlib.metadata.version")
    def test_all_packages_missing(self, mock_version):
        import importlib.metadata

        mock_version.side_effect = importlib.metadata.PackageNotFoundError("x")
        hc = EnvironmentHealthCheck()
        result = hc._check_pip_packages()
        assert result.status == "fail"


class TestCheckBootstrapProfile:
    """Tests for _check_bootstrap_profile."""

    def test_config_not_found(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "src.agent.health_check._BOOTSTRAP_CONFIG_PATH",
            tmp_path / "nonexistent" / "config.json",
        )
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "fail"
        assert "not found" in result.message

    def test_valid_config(self, tmp_path, monkeypatch):
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps(
                {
                    "activeProfile": "default",
                    "profiles": {
                        "default": {
                            "accountId": "123456789012",
                            "roleArn": "arn:aws:iam::123456789012:role/test",
                        }
                    },
                }
            )
        )
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "pass"
        assert "123456789012" in result.message

    def test_missing_active_profile(self, tmp_path, monkeypatch):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"profiles": {}}))
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "warn"
        assert "activeProfile" in result.message

    def test_profile_missing_fields(self, tmp_path, monkeypatch):
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps(
                {
                    "activeProfile": "default",
                    "profiles": {"default": {"accountId": "123"}},
                }
            )
        )
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_bootstrap_profile()
        assert result.status == "warn"
        assert "roleArn" in result.message


class TestCheckAwsCredentials:
    """Tests for _check_aws_credentials."""

    @patch("boto3.client")
    def test_valid_credentials(self, mock_client):
        mock_sts = MagicMock()
        mock_sts.get_caller_identity.return_value = {
            "Account": "123456789012",
            "Arn": "arn:aws:iam::123456789012:user/testuser",
        }
        mock_client.return_value = mock_sts
        hc = EnvironmentHealthCheck()
        result = hc._check_aws_credentials()
        assert result.status == "pass"
        assert "123456789012" in result.message
        assert "testuser" in result.message

    @patch("boto3.client")
    def test_no_credentials(self, mock_client):
        from botocore.exceptions import NoCredentialsError

        mock_sts = MagicMock()
        mock_sts.get_caller_identity.side_effect = NoCredentialsError()
        mock_client.return_value = mock_sts
        hc = EnvironmentHealthCheck()
        result = hc._check_aws_credentials()
        assert result.status == "fail"
        assert "No credentials" in result.message

    @patch("boto3.client")
    def test_client_error(self, mock_client):
        from botocore.exceptions import ClientError

        mock_sts = MagicMock()
        mock_sts.get_caller_identity.side_effect = ClientError(
            {"Error": {"Code": "ExpiredToken", "Message": "Token expired"}},
            "GetCallerIdentity",
        )
        mock_client.return_value = mock_sts
        hc = EnvironmentHealthCheck()
        result = hc._check_aws_credentials()
        assert result.status == "fail"
        assert "ExpiredToken" in result.message


class TestCheckMcpServers:
    """Tests for _check_mcp_servers."""

    def test_mcp_json_found(self):
        """The real project has config/mcp.json with servers defined."""
        hc = EnvironmentHealthCheck()
        result = hc._check_mcp_servers()
        # This uses the actual project's config/mcp.json
        assert result.status == "pass"
        assert "servers configured" in result.message

    def test_mcp_json_missing(self, tmp_path, monkeypatch):
        """When config/mcp.json doesn't exist at the resolved path."""
        # Point __file__ to a fake location so path resolution finds nothing
        fake_agent_dir = tmp_path / "src" / "agent"
        fake_agent_dir.mkdir(parents=True)
        fake_file = fake_agent_dir / "health_check.py"
        fake_file.write_text("")

        import src.agent.health_check as hc_module

        monkeypatch.setattr(hc_module, "__file__", str(fake_file))
        hc = EnvironmentHealthCheck()
        result = hc._check_mcp_servers()
        assert result.status == "fail"
        assert "not found" in result.message

    def test_mcp_json_no_servers(self, tmp_path, monkeypatch):
        """When config/mcp.json exists but has no servers."""
        fake_agent_dir = tmp_path / "src" / "agent"
        fake_agent_dir.mkdir(parents=True)
        fake_file = fake_agent_dir / "health_check.py"
        fake_file.write_text("")
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "mcp.json").write_text(json.dumps({"mcpServers": {}}))

        import src.agent.health_check as hc_module

        monkeypatch.setattr(hc_module, "__file__", str(fake_file))
        hc = EnvironmentHealthCheck()
        result = hc._check_mcp_servers()
        assert result.status == "warn"
        assert "no servers" in result.message


class TestCheckSecretsConfigured:
    """Tests for _check_secrets_configured."""

    def test_no_hf_model_id_in_config(self, tmp_path):
        """When project doesn't reference HF models, secrets not required."""
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export DEPLOYMENT_TARGET=sagemaker\n")
        hc = EnvironmentHealthCheck()
        result = hc._check_secrets_configured(str(tmp_path))
        assert result.status == "pass"
        assert "not required" in result.message

    def test_hf_token_env_set(self, tmp_path, monkeypatch):
        """When HF_TOKEN is in environment."""
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export HF_MODEL_ID=meta-llama/Llama-3-8B\n")
        monkeypatch.setenv("HF_TOKEN", "hf_test_token")
        hc = EnvironmentHealthCheck()
        result = hc._check_secrets_configured(str(tmp_path))
        assert result.status == "pass"
        assert "HF_TOKEN is set" in result.message

    def test_secrets_file_exists(self, tmp_path, monkeypatch):
        """When do/secrets.conf exists."""
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export HF_MODEL_ID=meta-llama/Llama-3-8B\n")
        (do_dir / "secrets.conf").write_text("HF_TOKEN=hf_xxx\n")
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
        hc = EnvironmentHealthCheck()
        result = hc._check_secrets_configured(str(tmp_path))
        assert result.status == "pass"
        assert "secrets.conf" in result.message

    def test_missing_secrets(self, tmp_path, monkeypatch):
        """When HF model is used but no token is configured."""
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export HF_MODEL_ID=meta-llama/Llama-3-8B\n")
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
        hc = EnvironmentHealthCheck()
        result = hc._check_secrets_configured(str(tmp_path))
        assert result.status == "warn"
        assert "gated models" in result.message


class TestCheckLocalOverrides:
    """Tests for _check_local_overrides."""

    def test_no_mlcc_directory(self, tmp_path):
        """When .mlcc/ doesn't exist, report no overrides."""
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert result.label == "Local overrides"
        assert "No local overrides" in result.message

    def test_empty_mlcc_directory(self, tmp_path):
        """When .mlcc/ exists but has no recognized files."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert "No local overrides" in result.message

    def test_model_picker_overrides(self, tmp_path):
        """When .mlcc/model-picker.json has entries."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "model-picker.json").write_text(
            json.dumps({"models": [{"name": "custom/test-model"}, {"name": "custom/other"}]})
        )
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert "2 entries" in result.message
        assert "model-picker: 2" in result.message

    def test_multiple_override_files(self, tmp_path):
        """When multiple override files are present."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "model-picker.json").write_text(
            json.dumps({"models": [{"name": "custom/m1"}, {"name": "custom/m2"}]})
        )
        (mlcc_dir / "capabilities.json").write_text(
            json.dumps({"capabilities": {"cap1": {"status": "green"}}})
        )
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert "3 entries" in result.message
        assert "model-picker: 2" in result.message
        assert "capabilities: 1" in result.message

    def test_malformed_json_skipped(self, tmp_path):
        """When an override file has invalid JSON, it's skipped gracefully."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "model-picker.json").write_text("not valid json {{{")
        (mlcc_dir / "capabilities.json").write_text(
            json.dumps({"capabilities": {"cap1": {"status": "green"}}})
        )
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert "1 entries" in result.message
        assert "capabilities: 1" in result.message

    def test_capabilities_object_format(self, tmp_path):
        """Capabilities uses object format (count keys, not array length)."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "capabilities.json").write_text(
            json.dumps(
                {
                    "capabilities": {
                        "cap1": {"status": "green"},
                        "cap2": {"status": "yellow"},
                        "cap3": {"status": "red"},
                    }
                }
            )
        )
        hc = EnvironmentHealthCheck()
        result = hc._check_local_overrides(str(tmp_path))
        assert result.status == "pass"
        assert "3 entries" in result.message
        assert "capabilities: 3" in result.message


class TestCheckBenchmarkInfra:
    """Tests for _check_benchmark_infra."""

    def test_both_present(self, tmp_path, monkeypatch):
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps(
                {
                    "activeProfile": "default",
                    "profiles": {
                        "default": {
                            "accountId": "123",
                            "roleArn": "arn:aws:iam::123:role/x",
                            "ciBenchmarkResultsBucket": "mlcc-benchmark-123-us-east-1",
                            "ciGlueDatabase": "mlcc_benchmarks",
                        }
                    },
                }
            )
        )
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_benchmark_infra()
        assert result.status == "pass"
        assert "mlcc-benchmark" in result.message

    def test_missing_bucket(self, tmp_path, monkeypatch):
        config_file = tmp_path / "config.json"
        config_file.write_text(
            json.dumps(
                {
                    "activeProfile": "default",
                    "profiles": {
                        "default": {
                            "accountId": "123",
                            "ciGlueDatabase": "mlcc_benchmarks",
                        }
                    },
                }
            )
        )
        monkeypatch.setattr("src.agent.health_check._BOOTSTRAP_CONFIG_PATH", config_file)
        hc = EnvironmentHealthCheck()
        result = hc._check_benchmark_infra()
        assert result.status == "warn"
        assert "ciBenchmarkResultsBucket" in result.message


class TestRunIntegration:
    """Tests for the full run() method."""

    def test_run_without_project_dir(self):
        """Run returns items for all environment checks."""
        hc = EnvironmentHealthCheck()
        items = hc.run()
        # Should have 6 checks (no project-level checks)
        assert len(items) == 6
        # All items should be HealthItem instances
        assert all(isinstance(i, HealthItem) for i in items)
        # All statuses should be valid
        assert all(i.status in ("pass", "warn", "fail") for i in items)

    def test_run_with_project_dir(self, tmp_path):
        """Run returns additional project-level checks."""
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export DEPLOYMENT_TARGET=sagemaker\n")
        hc = EnvironmentHealthCheck()
        items = hc.run(project_dir=str(tmp_path))
        # Should have 9 checks (6 env + 3 project: secrets, local overrides, benchmark)
        assert len(items) == 9


class TestPrintHealthReport:
    """Tests for print_health_report."""

    def test_prints_without_error(self, capsys):
        items = [
            HealthItem("pass", "Test 1", "ok"),
            HealthItem("warn", "Test 2", "warning"),
            HealthItem("fail", "Test 3", "error"),
        ]
        print_health_report(items)
        captured = capsys.readouterr()
        assert "Environment Health Check" in captured.out
        assert "Test 1" in captured.out
        assert "1 passed" in captured.out
        assert "1 warnings" in captured.out
        assert "1 failed" in captured.out
