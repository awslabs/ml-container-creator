"""Integration test: --dry-run must not invoke AWS APIs (CP-4).

Validates:
- CP-4: do/deploy --dry-run MUST produce identical config output as a real
  deploy, but MUST NOT invoke any AWS API or modify any remote state.
- FR-3.6: do/deploy --dry-run MUST show the fully resolved configuration and
  the target-specific command that would be executed, without actually deploying.

Strategy:
- A mock `aws` CLI bash script is placed first in PATH. It logs every
  invocation (with all arguments) to a file, then exits with an error.
- do/deploy --dry-run is run with fully populated config (status vars pre-set
  to prevent backfill attempts).
- The mock aws log file is checked: it MUST remain empty (no invocations).
- The stdout output is validated for resolved config and command display.

Key deployment script flow:
1. _backfill_status_var: only calls AWS if status var is empty. We pre-set
   status vars in config to prevent this.
2. Switch-or-deploy: only fires with --target flag + non-empty status var.
   We omit --target so the script reads DEPLOYMENT_TARGET from config directly.
3. Dry-run output: reached when FLAG_DRY_RUN=1 and DEPLOYMENT_TARGET is set.
"""
import json
import os
import stat
import subprocess
import tempfile

import pytest

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DO = os.path.join(REPO_ROOT, "templates", "do")
DEPLOY_SCRIPT = os.path.join(TEMPLATES_DO, "deploy")
LIB_PYTHON = os.path.join(TEMPLATES_DO, "lib", "python")
VENV_PYTHON = os.path.join(REPO_ROOT, ".venv", "bin", "python3")
PYTHON = VENV_PYTHON if os.path.isfile(VENV_PYTHON) else "python3"

# Mock MCP responses (required for helper invocations)
MOCK_MCP_RESPONSES = {
    "instance-sizer/recommend": {
        "instance_type": "ml.g6.xlarge",
        "gpu_count": 1,
        "instances": [
            {"type": "ml.g6.xlarge", "vram_gb": 24},
        ],
    },
    "endpoint-picker/list": {
        "endpoints": [],
    },
    "cluster-picker/list": {
        "clusters": [
            {"name": "hp-cluster-1", "gpu_capacity": 8, "queues": ["default"]},
        ],
    },
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_aws_env(tmp_path):
    """Create a mock aws CLI and a temporary environment for dry-run tests.

    Sets up:
    - A mock `aws` script that logs all calls to a file and exits 1
    - An environment with the mock aws first in PATH

    Returns a dict with:
    - env: environment dict for subprocess
    - aws_log: path to the aws invocation log file
    - mock_bin_dir: directory with mock aws
    """
    # Create mock aws CLI
    mock_bin_dir = str(tmp_path / "mock_bin")
    os.makedirs(mock_bin_dir)

    aws_log = str(tmp_path / "aws_calls.log")
    mock_aws = os.path.join(mock_bin_dir, "aws")

    with open(mock_aws, "w") as f:
        f.write(f"""#!/bin/bash
# Mock aws CLI that records all invocations
echo "CALLED: aws $@" >> "{aws_log}"
exit 1
""")
    os.chmod(mock_aws, stat.S_IRWXU)

    # Create empty log file
    with open(aws_log, "w") as f:
        pass

    # Build environment with mock aws first in PATH
    env = os.environ.copy()
    env["PATH"] = mock_bin_dir + ":" + env.get("PATH", "")
    env["MCP_MOCK_RESPONSES"] = json.dumps(MOCK_MCP_RESPONSES)
    env["PYTHONPATH"] = LIB_PYTHON
    # Prevent any real AWS credential lookups
    env["AWS_ACCESS_KEY_ID"] = "FAKE_ACCESS_KEY"
    env["AWS_SECRET_ACCESS_KEY"] = "FAKE_SECRET_KEY"
    env["AWS_DEFAULT_REGION"] = "us-east-1"

    return {
        "env": env,
        "aws_log": aws_log,
        "mock_bin_dir": mock_bin_dir,
    }


def _write_config(tmpdir: str, lines: list[str]) -> str:
    """Write a do/config file and return its path."""
    config_path = os.path.join(tmpdir, "config")
    with open(config_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return config_path


def _setup_do_dir(config_dir: str) -> str:
    """Create a do/ directory structure that mirrors the real template layout.

    Returns the path to the do/ directory.
    """
    do_dir = os.path.join(config_dir, "do")
    os.makedirs(do_dir, exist_ok=True)

    # Symlink the deploy script
    deploy_link = os.path.join(do_dir, "deploy")
    if not os.path.exists(deploy_link):
        os.symlink(DEPLOY_SCRIPT, deploy_link)

    # Symlink deploy.d directory
    deploy_d_link = os.path.join(do_dir, "deploy.d")
    if not os.path.exists(deploy_d_link):
        os.symlink(os.path.join(TEMPLATES_DO, "deploy.d"), deploy_d_link)

    # Symlink lib directory (for python libs)
    lib_link = os.path.join(do_dir, "lib")
    if not os.path.exists(lib_link):
        os.symlink(os.path.join(TEMPLATES_DO, "lib"), lib_link)

    # Symlink the deploy helper
    helper_link = os.path.join(do_dir, ".deploy_helper.py")
    if not os.path.exists(helper_link):
        os.symlink(os.path.join(TEMPLATES_DO, ".deploy_helper.py"), helper_link)

    return do_dir


def _run_dry_run(
    config_dir: str,
    flags: list[str],
    env: dict,
    timeout: float = 30.0,
) -> subprocess.CompletedProcess:
    """Run do/deploy --dry-run via the bash script with provided flags.

    Creates a minimal project directory with do/ structure containing
    symlinks to the real template files. The config file is written into
    the do/ directory (where deploy sources it from SCRIPT_DIR/config).

    Args:
        config_dir: Directory containing a 'config' file.
        flags: Additional CLI flags for do/deploy.
        env: Environment dict (should include mock aws in PATH).
        timeout: Subprocess timeout.

    Returns:
        CompletedProcess with captured stdout/stderr.
    """
    do_dir = _setup_do_dir(config_dir)

    # Copy config into the do/ directory (deploy sources from SCRIPT_DIR/config)
    src_config = os.path.join(config_dir, "config")
    dst_config = os.path.join(do_dir, "config")
    with open(src_config) as f:
        content = f.read()
    with open(dst_config, "w") as f:
        f.write(content)

    cmd = ["bash", os.path.join(do_dir, "deploy"), "--dry-run"] + flags

    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
        cwd=config_dir,
    )


def _get_aws_calls(aws_log: str) -> list[str]:
    """Read and return all lines from the aws invocation log."""
    with open(aws_log) as f:
        return [line.strip() for line in f.readlines() if line.strip()]


# ---------------------------------------------------------------------------
# Tests: CP-4 — dry-run produces config output without AWS calls
# ---------------------------------------------------------------------------


class TestDryRunCP4:
    """Integration tests validating CP-4: --dry-run MUST NOT invoke any AWS API.

    Each test uses a fully-populated config WITH status vars pre-set.
    This ensures:
    1. _backfill_status_var is a no-op (status var already exists)
    2. No --target flag → switch-or-deploy logic does not fire
    3. DEPLOYMENT_TARGET is non-empty → skips helper invocation
    4. --dry-run flag is respected → shows config and exits
    """

    def test_managed_inference_dry_run_no_aws_calls(self, mock_aws_env, tmp_path):
        """managed-inference: --dry-run shows config but makes zero AWS calls."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export ENDPOINT_NAME="test-ep"',
            'export ENDPOINT_STRATEGY="new"',
            'export IC_GPU_COUNT="1"',
            'export INSTANCE_TYPES="ml.g6.xlarge"',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
            # Pre-set status var to prevent backfill calling AWS
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"

        # CP-4: No AWS calls made
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], (
            f"--dry-run MUST NOT invoke AWS CLI, but got: {aws_calls}"
        )

        # FR-3.6: Output contains resolved config
        assert "DEPLOYMENT_TARGET=managed-inference" in result.stdout
        assert "INSTANCE_TYPE=ml.g6.xlarge" in result.stdout
        assert "ENDPOINT_NAME=test-ep" in result.stdout

        # FR-3.6: Output shows command that would execute
        assert "deploy.d/managed-inference" in result.stdout
        assert "Would execute" in result.stdout

    def test_async_inference_dry_run_no_aws_calls(self, mock_aws_env, tmp_path):
        """async-inference: --dry-run shows config but makes zero AWS calls."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="async-inference"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export ASYNC_S3_OUTPUT_PATH="s3://bucket/async-output/"',
            'export ASYNC_SNS_TOPIC="arn:aws:sns:us-east-1:123:topic"',
            'export ASYNC_MAX_CONCURRENT="3"',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
            # Pre-set status var to prevent backfill calling AWS
            'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"

        # CP-4: No AWS calls made
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], (
            f"--dry-run MUST NOT invoke AWS CLI, but got: {aws_calls}"
        )

        # FR-3.6: Output contains resolved config
        assert "DEPLOYMENT_TARGET=async-inference" in result.stdout
        assert "INSTANCE_TYPE=ml.g6.xlarge" in result.stdout
        assert "ASYNC_S3_OUTPUT_PATH=s3://bucket/async-output/" in result.stdout

        # FR-3.6: Output shows command that would execute
        assert "deploy.d/async-inference" in result.stdout

    def test_batch_transform_dry_run_no_aws_calls(self, mock_aws_env, tmp_path):
        """batch-transform: --dry-run shows config but makes zero AWS calls."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="batch-transform"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export BATCH_INPUT_PATH="s3://data/input/dataset.jsonl"',
            'export BATCH_OUTPUT_PATH="s3://data/output/results/"',
            'export BATCH_SPLIT_TYPE="Line"',
            'export BATCH_STRATEGY="MultiRecord"',
            'export BATCH_MAX_CONCURRENT="5"',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
            # Pre-set status var to prevent backfill calling AWS
            'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"

        # CP-4: No AWS calls made
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], (
            f"--dry-run MUST NOT invoke AWS CLI, but got: {aws_calls}"
        )

        # FR-3.6: Output contains resolved config
        assert "DEPLOYMENT_TARGET=batch-transform" in result.stdout
        assert "BATCH_INPUT_PATH=s3://data/input/dataset.jsonl" in result.stdout
        assert "BATCH_OUTPUT_PATH=s3://data/output/results/" in result.stdout
        assert "BATCH_SPLIT_TYPE=Line" in result.stdout
        assert "BATCH_STRATEGY=MultiRecord" in result.stdout

        # FR-3.6: Output shows command that would execute
        assert "deploy.d/batch-transform" in result.stdout

    def test_hyperpod_eks_dry_run_no_aws_calls(self, mock_aws_env, tmp_path):
        """hyperpod-eks: --dry-run shows config but makes zero AWS calls."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="hyperpod-eks"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export HP_CLUSTER_NAME="hp-cluster-1"',
            'export HP_GPU_COUNT="4"',
            'export HP_NAMESPACE="default"',
            'export HP_REPLICAS="2"',
            'export HP_QUEUE="gpu-queue"',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
            # Pre-set status var to prevent backfill calling AWS
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"

        # CP-4: No AWS calls made
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], (
            f"--dry-run MUST NOT invoke AWS CLI, but got: {aws_calls}"
        )

        # FR-3.6: Output contains resolved config
        assert "DEPLOYMENT_TARGET=hyperpod-eks" in result.stdout
        assert "HP_CLUSTER_NAME=hp-cluster-1" in result.stdout
        assert "HP_GPU_COUNT=4" in result.stdout
        assert "HP_NAMESPACE=default" in result.stdout
        assert "HP_REPLICAS=2" in result.stdout

        # FR-3.6: Output shows command that would execute
        assert "deploy.d/hyperpod-eks" in result.stdout

    def test_dry_run_shows_no_changes_message(self, mock_aws_env, tmp_path):
        """--dry-run output ends with a 'no changes made' confirmation."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export ENDPOINT_NAME="test-ep"',
            'export ENDPOINT_STRATEGY="new"',
            'export IC_GPU_COUNT="1"',
            'export INSTANCE_TYPES="ml.g6.xlarge"',
            'export MODEL_NAME="test-model"',
            'export PROJECT_NAME="test-project"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}"
        # The script outputs "No changes made (dry run)" at the end
        assert "No changes made" in result.stdout or "dry run" in result.stdout.lower()

    def test_dry_run_does_not_modify_config(self, mock_aws_env, tmp_path):
        """--dry-run MUST NOT modify the do/config file (no state change)."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        config_lines = [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export ENDPOINT_NAME="test-ep"',
            'export ENDPOINT_STRATEGY="new"',
            'export IC_GPU_COUNT="1"',
            'export INSTANCE_TYPES="ml.g6.xlarge"',
            'export MODEL_NAME="test-model"',
            'export PROJECT_NAME="test-project"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        ]
        _write_config(config_dir, config_lines)
        original_content = "\n".join(config_lines) + "\n"

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}"

        # The config in do/ dir (where deploy sources from) must be unchanged
        do_config = os.path.join(config_dir, "do", "config")
        with open(do_config) as f:
            after_content = f.read()

        assert after_content == original_content, (
            "Config was modified during --dry-run! "
            f"Original:\n{original_content}\nAfter:\n{after_content}"
        )

    def test_dry_run_with_helper_flags_no_aws(self, mock_aws_env, tmp_path):
        """--dry-run with flags through helper resolves config without AWS calls.

        When DEPLOYMENT_TARGET is empty and --target + all flags are passed,
        the helper is invoked to resolve config. Dry-run still must not
        call AWS — only the deploy.d scripts call AWS.
        """
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET=""',
            'export INSTANCE_TYPE=""',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
        ])

        result = _run_dry_run(
            config_dir,
            [
                "--target", "batch-transform",
                "--instance-type", "ml.g5.2xlarge",
                "--batch-input-path", "s3://input-bucket/data.jsonl",
                "--batch-output-path", "s3://output-bucket/results/",
                "--batch-split-type", "RecordIO",
                "--batch-strategy", "SingleRecord",
                "--batch-max-concurrent", "10",
            ],
            mock_aws_env["env"],
        )

        assert result.returncode == 0, f"stderr: {result.stderr}\nstdout: {result.stdout}"

        # Verify all flag values appear in resolved config
        assert "DEPLOYMENT_TARGET=batch-transform" in result.stdout
        assert "INSTANCE_TYPE=ml.g5.2xlarge" in result.stdout
        assert "BATCH_INPUT_PATH=s3://input-bucket/data.jsonl" in result.stdout
        assert "BATCH_OUTPUT_PATH=s3://output-bucket/results/" in result.stdout
        assert "BATCH_SPLIT_TYPE=RecordIO" in result.stdout
        assert "BATCH_STRATEGY=SingleRecord" in result.stdout
        assert "BATCH_MAX_CONCURRENT=10" in result.stdout

        # CP-4: Still no AWS calls (helper uses MCP mock, deploy.d not invoked)
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], f"AWS called during --dry-run: {aws_calls}"

    def test_dry_run_output_structure(self, mock_aws_env, tmp_path):
        """--dry-run output has the expected structure: header, config, command."""
        config_dir = str(tmp_path / "project")
        os.makedirs(config_dir, exist_ok=True)
        _write_config(config_dir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export INSTANCE_TYPE="ml.g6.xlarge"',
            'export ENDPOINT_NAME="prod-ep"',
            'export ENDPOINT_STRATEGY="existing"',
            'export IC_GPU_COUNT="2"',
            'export INSTANCE_TYPES="ml.g6.xlarge,ml.g6e.xlarge"',
            'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
            'export PROJECT_NAME="test-project"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        ])

        result = _run_dry_run(config_dir, [], mock_aws_env["env"])

        assert result.returncode == 0, f"stderr: {result.stderr}"
        output = result.stdout

        # Verify structural elements
        assert "Dry Run" in output
        assert "Target: managed-inference" in output
        assert "Resolved configuration:" in output
        assert "Would execute:" in output
        assert "deploy.d/managed-inference" in output

    def test_dry_run_all_four_targets_no_aws(self, mock_aws_env, tmp_path):
        """All four deployment targets produce dry-run output with zero AWS calls.

        Runs all targets sequentially with the same mock aws, verifying the
        log stays empty across all invocations.
        """
        targets_config = {
            "managed-inference": [
                'export DEPLOYMENT_TARGET="managed-inference"',
                'export INSTANCE_TYPE="ml.g6.xlarge"',
                'export ENDPOINT_NAME="ep-1"',
                'export ENDPOINT_STRATEGY="new"',
                'export IC_GPU_COUNT="1"',
                'export INSTANCE_TYPES="ml.g6.xlarge"',
                'export MODEL_NAME="test-model"',
                'export PROJECT_NAME="test-project"',
                'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            ],
            "async-inference": [
                'export DEPLOYMENT_TARGET="async-inference"',
                'export INSTANCE_TYPE="ml.g6.xlarge"',
                'export ASYNC_S3_OUTPUT_PATH="s3://bucket/out/"',
                'export ASYNC_SNS_TOPIC=""',
                'export ASYNC_MAX_CONCURRENT="1"',
                'export MODEL_NAME="test-model"',
                'export PROJECT_NAME="test-project"',
                'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"',
            ],
            "batch-transform": [
                'export DEPLOYMENT_TARGET="batch-transform"',
                'export INSTANCE_TYPE="ml.g6.xlarge"',
                'export BATCH_INPUT_PATH="s3://in/data.jsonl"',
                'export BATCH_OUTPUT_PATH="s3://out/results/"',
                'export BATCH_SPLIT_TYPE="Line"',
                'export BATCH_STRATEGY="MultiRecord"',
                'export BATCH_MAX_CONCURRENT="1"',
                'export MODEL_NAME="test-model"',
                'export PROJECT_NAME="test-project"',
                'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"',
            ],
            "hyperpod-eks": [
                'export DEPLOYMENT_TARGET="hyperpod-eks"',
                'export INSTANCE_TYPE="ml.g6.xlarge"',
                'export HP_CLUSTER_NAME="cluster-1"',
                'export HP_GPU_COUNT="1"',
                'export HP_NAMESPACE="default"',
                'export HP_REPLICAS="1"',
                'export HP_QUEUE="default"',
                'export MODEL_NAME="test-model"',
                'export PROJECT_NAME="test-project"',
                'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
            ],
        }

        for target, config_lines in targets_config.items():
            config_dir = str(tmp_path / f"project-{target}")
            os.makedirs(config_dir, exist_ok=True)
            _write_config(config_dir, config_lines)

            result = _run_dry_run(config_dir, [], mock_aws_env["env"])

            assert result.returncode == 0, (
                f"Target {target} dry-run failed: stderr={result.stderr}"
            )
            assert f"Target: {target}" in result.stdout, (
                f"Target {target} not shown in dry-run output"
            )
            assert f"deploy.d/{target}" in result.stdout, (
                f"Deploy script path not shown for {target}"
            )

        # Final check: NO aws calls across all 4 targets
        aws_calls = _get_aws_calls(mock_aws_env["aws_log"])
        assert aws_calls == [], (
            f"AWS was called during dry-run of one or more targets: {aws_calls}"
        )
