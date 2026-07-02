"""Environment health check for ml-container-creator.

Runs at startup to verify the tool is installed correctly and the
environment meets prerequisites. No LLM needed — pure code checks.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class HealthItem:
    """Single health check result."""

    status: str  # "pass", "warn", "fail"
    label: str
    message: str

    @property
    def icon(self) -> str:
        """Colored status indicator for terminal output."""
        icons = {"pass": "\033[32m✓\033[0m", "warn": "\033[33m⚠\033[0m", "fail": "\033[31m✗\033[0m"}
        return icons.get(self.status, "?")

    def __str__(self) -> str:
        return f"  {self.icon} {self.label}: {self.message}"


# Path to the bootstrap profile config
_BOOTSTRAP_CONFIG_PATH = Path.home() / ".ml-container-creator" / "config.json"

# Required pip packages for core functionality
_REQUIRED_PACKAGES = ["sagemaker", "boto3", "huggingface_hub"]

# Minimum versions
_MIN_PYTHON = (3, 10)
_MIN_NODE = 24


class EnvironmentHealthCheck:
    """Check environment prerequisites at startup.

    No LLM needed. Verifies that ml-container-creator is installed
    correctly and the environment is properly configured.
    """

    def run(self, project_dir: str | None = None) -> list[HealthItem]:
        """Run all health checks.

        Args:
            project_dir: Path to a project directory (contains do/config).
                         If None, only environment-level checks run.

        Returns:
            List of HealthItem results, one per check.
        """
        items: list[HealthItem] = []
        items.append(self._check_python_version())
        items.append(self._check_node_version())
        items.append(self._check_pip_packages())
        items.append(self._check_bootstrap_profile())
        items.append(self._check_aws_credentials())
        items.append(self._check_mcp_servers())
        if project_dir:
            items.append(self._check_secrets_configured(project_dir))
            items.append(self._check_benchmark_infra())
        return items

    def _check_python_version(self) -> HealthItem:
        """Check sys.version_info >= (3, 10)."""
        current = sys.version_info[:2]
        version_str = f"{current[0]}.{current[1]}"
        if current >= _MIN_PYTHON:
            return HealthItem("pass", "Python version", f"{version_str} (>= 3.10)")
        return HealthItem(
            "fail",
            "Python version",
            f"{version_str} — requires >= 3.10",
        )

    def _check_node_version(self) -> HealthItem:
        """Check node --version >= 24 via subprocess."""
        try:
            result = subprocess.run(
                ["node", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return HealthItem("fail", "Node.js version", "node command failed")

            # Parse version string like "v24.1.0" or "v22.12.0"
            version_output = result.stdout.strip()
            match = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version_output)
            if not match:
                return HealthItem("warn", "Node.js version", f"Could not parse: {version_output}")

            major = int(match.group(1))
            if major >= _MIN_NODE:
                return HealthItem("pass", "Node.js version", f"{version_output} (>= 24)")
            return HealthItem(
                "fail",
                "Node.js version",
                f"{version_output} — requires >= 24",
            )
        except FileNotFoundError:
            return HealthItem("fail", "Node.js version", "node not found in PATH")
        except subprocess.TimeoutExpired:
            return HealthItem("warn", "Node.js version", "node --version timed out")

    def _check_pip_packages(self) -> HealthItem:
        """Check sagemaker, boto3, huggingface_hub are installed."""
        missing: list[str] = []
        installed: list[str] = []

        for pkg in _REQUIRED_PACKAGES:
            try:
                version = importlib.metadata.version(pkg)
                installed.append(f"{pkg}=={version}")
            except importlib.metadata.PackageNotFoundError:
                missing.append(pkg)

        if not missing:
            return HealthItem("pass", "Pip packages", ", ".join(installed))
        if len(missing) == len(_REQUIRED_PACKAGES):
            return HealthItem("fail", "Pip packages", f"Missing: {', '.join(missing)}")
        return HealthItem(
            "warn",
            "Pip packages",
            f"Missing: {', '.join(missing)} (have: {', '.join(installed)})",
        )

    def _check_bootstrap_profile(self) -> HealthItem:
        """Check ~/.ml-container-creator/config.json exists and has a valid active profile."""
        if not _BOOTSTRAP_CONFIG_PATH.exists():
            return HealthItem(
                "fail",
                "Bootstrap profile",
                f"{_BOOTSTRAP_CONFIG_PATH} not found — run 'ml-container-creator bootstrap'",
            )

        try:
            config = json.loads(_BOOTSTRAP_CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError) as e:
            return HealthItem("fail", "Bootstrap profile", f"Cannot parse config: {e}")

        active_profile_name = config.get("activeProfile")
        if not active_profile_name:
            return HealthItem("warn", "Bootstrap profile", "No activeProfile set")

        profiles = config.get("profiles", {})
        profile = profiles.get(active_profile_name)
        if not profile:
            return HealthItem(
                "warn",
                "Bootstrap profile",
                f"activeProfile '{active_profile_name}' not found in profiles",
            )

        # Check required fields
        missing_fields: list[str] = []
        if not profile.get("accountId"):
            missing_fields.append("accountId")
        if not profile.get("roleArn"):
            missing_fields.append("roleArn")

        if missing_fields:
            return HealthItem(
                "warn",
                "Bootstrap profile",
                f"Profile '{active_profile_name}' missing: {', '.join(missing_fields)}",
            )

        return HealthItem(
            "pass",
            "Bootstrap profile",
            f"Active: {active_profile_name} (account: {profile['accountId']})",
        )

    def _check_aws_credentials(self) -> HealthItem:
        """Check AWS credentials via STS get_caller_identity with short timeout."""
        try:
            import boto3
            from botocore.config import Config
            from botocore.exceptions import ClientError, NoCredentialsError

            sts = boto3.client("sts", config=Config(connect_timeout=5, read_timeout=5))
            identity = sts.get_caller_identity()
            account = identity.get("Account", "unknown")
            arn = identity.get("Arn", "")
            # Show a short version of the ARN (last segment)
            short_arn = arn.split("/")[-1] if "/" in arn else arn
            return HealthItem("pass", "AWS credentials", f"Account {account} ({short_arn})")
        except NoCredentialsError:
            return HealthItem(
                "fail",
                "AWS credentials",
                "No credentials found — configure AWS_PROFILE or environment variables",
            )
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            return HealthItem("fail", "AWS credentials", f"STS call failed: {error_code}")
        except Exception as e:
            # Catch EndpointConnectionError and other network issues
            error_name = type(e).__name__
            return HealthItem("warn", "AWS credentials", f"Could not verify: {error_name}")

    def _check_mcp_servers(self) -> HealthItem:
        """Verify config/mcp.json exists in the installed package."""
        # Find the package root by looking relative to this file
        # src/agent/health_check.py -> project root is ../../..
        package_root = Path(__file__).resolve().parent.parent.parent
        mcp_config_path = package_root / "config" / "mcp.json"

        if not mcp_config_path.exists():
            return HealthItem(
                "fail",
                "MCP servers",
                f"config/mcp.json not found at {mcp_config_path}",
            )

        try:
            mcp_config = json.loads(mcp_config_path.read_text())
            servers = mcp_config.get("mcpServers", {})
            count = len(servers)
            if count == 0:
                return HealthItem("warn", "MCP servers", "config/mcp.json has no servers defined")
            return HealthItem("pass", "MCP servers", f"{count} servers configured")
        except (json.JSONDecodeError, OSError) as e:
            return HealthItem("fail", "MCP servers", f"Cannot parse mcp.json: {e}")

    def _check_secrets_configured(self, project_dir: str) -> HealthItem:
        """Check if HF_TOKEN or secrets file is present (if project uses gated models).

        Only relevant when inside a project directory.
        """
        project_path = Path(project_dir)

        # Check if this project likely needs HF_TOKEN (gated model references)
        do_config_path = project_path / "do" / "config"
        needs_hf_token = False
        if do_config_path.exists():
            try:
                content = do_config_path.read_text()
                # Heuristic: if HF_MODEL_ID is set, user likely needs HF access
                if "HF_MODEL_ID" in content:
                    needs_hf_token = True
            except OSError:
                pass

        if not needs_hf_token:
            return HealthItem("pass", "Secrets", "No gated model detected — HF_TOKEN not required")

        # Check HF_TOKEN env var
        if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
            return HealthItem("pass", "Secrets", "HF_TOKEN is set")

        # Check for secrets file in project
        secrets_file = project_path / "do" / "secrets.conf"
        if secrets_file.exists():
            return HealthItem("pass", "Secrets", "do/secrets.conf found")

        return HealthItem(
            "warn",
            "Secrets",
            "HF_TOKEN not set and no do/secrets.conf — may fail for gated models",
        )

    def _check_benchmark_infra(self) -> HealthItem:
        """Check if benchmark S3 bucket and Glue database are in bootstrap profile."""
        if not _BOOTSTRAP_CONFIG_PATH.exists():
            return HealthItem("warn", "Benchmark infra", "No bootstrap profile to check")

        try:
            config = json.loads(_BOOTSTRAP_CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return HealthItem("warn", "Benchmark infra", "Cannot read bootstrap profile")

        active_profile_name = config.get("activeProfile")
        if not active_profile_name:
            return HealthItem("warn", "Benchmark infra", "No active profile set")

        profiles = config.get("profiles", {})
        profile = profiles.get(active_profile_name, {})

        has_bucket = bool(profile.get("ciBenchmarkResultsBucket"))
        has_glue = bool(profile.get("ciGlueDatabase"))

        if has_bucket and has_glue:
            return HealthItem(
                "pass",
                "Benchmark infra",
                f"S3: {profile['ciBenchmarkResultsBucket']}, Glue: {profile['ciGlueDatabase']}",
            )
        missing = []
        if not has_bucket:
            missing.append("ciBenchmarkResultsBucket")
        if not has_glue:
            missing.append("ciGlueDatabase")
        return HealthItem(
            "warn",
            "Benchmark infra",
            f"Missing in profile: {', '.join(missing)} — benchmarks won't persist results",
        )


def print_health_report(items: list[HealthItem]) -> None:
    """Print a formatted health report to stdout.

    Args:
        items: List of HealthItem results from EnvironmentHealthCheck.run().
    """
    print("\n\033[1mEnvironment Health Check\033[0m")
    print("─" * 40)
    for item in items:
        print(str(item))

    # Summary line
    fails = sum(1 for i in items if i.status == "fail")
    warns = sum(1 for i in items if i.status == "warn")
    passes = sum(1 for i in items if i.status == "pass")

    print("─" * 40)
    parts = []
    if passes:
        parts.append(f"\033[32m{passes} passed\033[0m")
    if warns:
        parts.append(f"\033[33m{warns} warnings\033[0m")
    if fails:
        parts.append(f"\033[31m{fails} failed\033[0m")
    print(f"  {', '.join(parts)}")
    print()
