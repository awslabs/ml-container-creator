"""Test that v1.4 projects deploy without interactive prompts (FR-9.1).

Validates:
- Projects with populated DEPLOYMENT_TARGET and all required schema vars
  skip the interactive deploy helper entirely.
- The dispatch conditional (`if [ -z "${DEPLOYMENT_TARGET:-}" ] || [ "$_NEEDS_HELPER" -eq 1 ]`)
  evaluates to FALSE when config is complete, meaning no helper is invoked.
- v1.4-style config with all required vars for a target results in direct dispatch.
"""
import os
import subprocess
import tempfile


# Minimal bash script that replicates the dispatch logic from do/deploy.
# Instead of actually invoking the Python helper or deploy.d scripts,
# it records whether the helper WOULD have been invoked and whether
# dispatch WOULD have proceeded.
_DISPATCH_LOGIC = """\
#!/bin/bash
set -e

SCRIPT_DIR="{tmpdir}"
source "${{SCRIPT_DIR}}/config"

# Parse flags (mirrors do/deploy)
FLAG_TARGET=""
_NEEDS_HELPER=0

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            shift; FLAG_TARGET="$1"; shift ;;
        *) shift ;;
    esac
done

# Apply --target flag if provided
if [ -n "$FLAG_TARGET" ]; then
    DEPLOYMENT_TARGET="$FLAG_TARGET"
fi

# Switch-or-deploy logic (simplified: no status vars present = new deploy)
if [ -n "$FLAG_TARGET" ]; then
    case "$FLAG_TARGET" in
        managed-inference) _STATUS_VAR="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        hyperpod-eks)      _STATUS_VAR="DEPLOYMENT_TARGET_HP_STATUS" ;;
        async-inference)   _STATUS_VAR="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform)   _STATUS_VAR="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        *)                 _STATUS_VAR="" ;;
    esac

    if [ -n "$_STATUS_VAR" ] && [ -n "${{!_STATUS_VAR:-}}" ]; then
        echo "SWITCH_ONLY=true"
        exit 0
    fi
    _NEEDS_HELPER=1
fi

# The critical backward-compat conditional
_HELPER_INVOKED=0
if [ -z "${{DEPLOYMENT_TARGET:-}}" ] || [ "$_NEEDS_HELPER" -eq 1 ]; then
    _HELPER_INVOKED=1
fi

echo "HELPER_INVOKED=$_HELPER_INVOKED"
echo "DEPLOYMENT_TARGET=$DEPLOYMENT_TARGET"
"""


def _run_dispatch_test(config_content: str, extra_args: list[str] | None = None) -> dict[str, str]:
    """Run the dispatch logic script and return parsed output vars."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        with open(config_path, "w") as f:
            f.write(config_content)

        script = _DISPATCH_LOGIC.format(tmpdir=tmpdir)
        cmd = ["bash", "-c", script]
        if extra_args:
            cmd.extend(["--"] + extra_args)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        # Parse KEY=VALUE lines from output
        output = {}
        for line in result.stdout.strip().split("\n"):
            if "=" in line:
                key, value = line.split("=", 1)
                output[key] = value
        return output


class TestV14ManagedInferenceNoPrompts:
    """v1.4 projects with managed-inference config deploy without prompts."""

    def test_complete_managed_inference_config_skips_helper(self):
        """Config with DEPLOYMENT_TARGET + all required vars → no helper invoked."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-ep"\n'
        )
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "0", (
            "Helper should NOT be invoked when DEPLOYMENT_TARGET is set "
            "and no --target flag is used"
        )
        assert output["DEPLOYMENT_TARGET"] == "managed-inference"

    def test_managed_inference_with_optional_vars_skips_helper(self):
        """Config with required + optional vars still skips helper."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-ep"\n'
            'export ENDPOINT_STRATEGY="new"\n'
            'export IC_GPU_COUNT="1"\n'
        )
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "0"


class TestV14HyperpodNoPrompts:
    """v1.4 projects with hyperpod-eks config deploy without prompts."""

    def test_complete_hyperpod_config_skips_helper(self):
        """HyperPod config with all required vars → no helper invoked."""
        config = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="my-cluster"\n'
            'export HP_GPU_COUNT="4"\n'
            'export HP_NAMESPACE="default"\n'
            'export HP_REPLICAS="1"\n'
        )
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "0"
        assert output["DEPLOYMENT_TARGET"] == "hyperpod-eks"


class TestV14AsyncInferenceNoPrompts:
    """v1.4 projects with async-inference config deploy without prompts."""

    def test_complete_async_config_skips_helper(self):
        """Async config with all required vars → no helper invoked."""
        config = (
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async-output/"\n'
        )
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "0"
        assert output["DEPLOYMENT_TARGET"] == "async-inference"


class TestV14BatchTransformNoPrompts:
    """v1.4 projects with batch-transform config deploy without prompts."""

    def test_complete_batch_config_skips_helper(self):
        """Batch config with all required vars → no helper invoked."""
        config = (
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
            'export BATCH_INPUT_PATH="s3://data/input/"\n'
            'export BATCH_OUTPUT_PATH="s3://data/output/"\n'
        )
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "0"
        assert output["DEPLOYMENT_TARGET"] == "batch-transform"


class TestEmptyConfigTriggersHelper:
    """Configs with empty DEPLOYMENT_TARGET DO invoke the helper (contrast)."""

    def test_empty_deployment_target_invokes_helper(self):
        """Empty DEPLOYMENT_TARGET → helper IS invoked (new project)."""
        config = 'export DEPLOYMENT_TARGET=""\n'
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "1"

    def test_missing_deployment_target_invokes_helper(self):
        """No DEPLOYMENT_TARGET line at all → helper IS invoked."""
        config = '# empty config\n'
        output = _run_dispatch_test(config)
        assert output["HELPER_INVOKED"] == "1"


class TestTargetFlagOverride:
    """When --target is provided to an existing v1.4 project, helper is needed."""

    def test_target_flag_forces_helper_for_new_target(self):
        """--target flag with no existing status → needs helper (new deployment)."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-ep"\n'
        )
        output = _run_dispatch_test(config, extra_args=["--target", "hyperpod-eks"])
        # --target to a new (not-yet-deployed) target requires the helper
        assert output["HELPER_INVOKED"] == "1"

    def test_target_flag_switches_when_status_exists(self):
        """--target flag with existing status var → switch only (no helper)."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-ep"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
        )
        output = _run_dispatch_test(config, extra_args=["--target", "hyperpod-eks"])
        # Status var exists → fast-switch, no helper needed
        assert output.get("SWITCH_ONLY") == "true"


# ---------------------------------------------------------------------------
# Status-var back-fill tests (FR-9.1, Task 13.2)
# ---------------------------------------------------------------------------

# Bash script that exercises the _backfill_status_var function in isolation.
# It sources a config, defines _update_config (writes to a side-file so we can
# inspect what was written), then runs the back-fill function.
_BACKFILL_LOGIC = """\
#!/bin/bash
set -e

SCRIPT_DIR="{tmpdir}"
source "${{SCRIPT_DIR}}/config"

# _update_config mock: writes the call to a sidecar file for inspection
_update_config() {{
    echo "$1=$2" >> "${{SCRIPT_DIR}}/written_vars"
}}

# Mock aws CLI: a script that returns a canned endpoint status
export PATH="{tmpdir}/bin:$PATH"

# ── _backfill_status_var (copied from templates/do/deploy) ───
_backfill_status_var() {{
    local target="${{DEPLOYMENT_TARGET:-}}"
    [ -z "$target" ] && return 0

    local status_var=""
    case "$target" in
        managed-inference) status_var="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        hyperpod-eks)      status_var="DEPLOYMENT_TARGET_HP_STATUS" ;;
        async-inference)   status_var="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform)   status_var="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        *) return 0 ;;
    esac

    # Only back-fill if status var is empty (not yet migrated)
    [ -n "${{!status_var:-}}" ] && return 0

    # Try to detect status from live API
    local live_status=""
    case "$target" in
        managed-inference|async-inference)
            local ep_name="${{ENDPOINT_NAME:-}}"
            if [ -n "$ep_name" ]; then
                live_status=$(aws sagemaker describe-endpoint \\
                    --endpoint-name "$ep_name" \\
                    --region "${{AWS_REGION:-us-east-1}}" \\
                    --query 'EndpointStatus' \\
                    --output text 2>/dev/null) || live_status=""
            fi
            ;;
        hyperpod-eks)
            if [ -n "${{HP_CLUSTER_NAME:-}}" ] && [ -n "${{INSTANCE_TYPE:-}}" ]; then
                live_status="Running"
            fi
            ;;
        batch-transform)
            if [ -n "${{BATCH_INPUT_PATH:-}}" ] && [ -n "${{BATCH_OUTPUT_PATH:-}}" ]; then
                live_status="Completed"
            fi
            ;;
    esac

    # Write back-fill if we got a status
    if [ -n "$live_status" ]; then
        _update_config "$status_var" "$live_status"
        export "$status_var=$live_status"
    fi
}}

_backfill_status_var

# Report resulting status var values for test verification
echo "DEPLOYMENT_TARGET_SMAI_STATUS=${{DEPLOYMENT_TARGET_SMAI_STATUS:-}}"
echo "DEPLOYMENT_TARGET_HP_STATUS=${{DEPLOYMENT_TARGET_HP_STATUS:-}}"
echo "DEPLOYMENT_TARGET_ASYNC_STATUS=${{DEPLOYMENT_TARGET_ASYNC_STATUS:-}}"
echo "DEPLOYMENT_TARGET_BATCH_STATUS=${{DEPLOYMENT_TARGET_BATCH_STATUS:-}}"
"""


def _run_backfill_test(
    config_content: str,
    mock_aws_output: str = "",
) -> tuple[dict[str, str], list[str]]:
    """Run the back-fill logic and return (env_vars, written_config_lines).

    Args:
        config_content: Shell config to source (export KEY="value" lines).
        mock_aws_output: Text that the mocked `aws` command should output.

    Returns:
        Tuple of (output_vars dict, list of lines written via _update_config).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        # Write config
        config_path = os.path.join(tmpdir, "config")
        with open(config_path, "w") as f:
            f.write(config_content)

        # Create mock aws CLI
        bin_dir = os.path.join(tmpdir, "bin")
        os.makedirs(bin_dir)
        aws_mock_path = os.path.join(bin_dir, "aws")
        with open(aws_mock_path, "w") as f:
            f.write(f"#!/bin/bash\necho '{mock_aws_output}'\n")
        os.chmod(aws_mock_path, 0o755)

        # Prepare written_vars sidecar
        written_path = os.path.join(tmpdir, "written_vars")
        open(written_path, "w").close()

        script = _BACKFILL_LOGIC.format(tmpdir=tmpdir)
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Backfill script failed: {result.stderr}"

        # Parse output vars
        output_vars: dict[str, str] = {}
        for line in result.stdout.strip().split("\n"):
            if "=" in line:
                key, value = line.split("=", 1)
                output_vars[key] = value

        # Read what was written to config
        with open(written_path) as f:
            written_lines = [l.strip() for l in f.readlines() if l.strip()]

        return output_vars, written_lines


class TestBackfillManagedInference:
    """Back-fill status var for managed-inference from live endpoint API."""

    def test_backfill_queries_aws_and_writes_status(self):
        """v1.4 config with endpoint but no status → calls aws, writes status."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
        )
        output_vars, written = _run_backfill_test(
            config, mock_aws_output="InService"
        )
        assert output_vars["DEPLOYMENT_TARGET_SMAI_STATUS"] == "InService"
        assert "DEPLOYMENT_TARGET_SMAI_STATUS=InService" in written

    def test_backfill_skipped_when_status_already_set(self):
        """If status var is already populated, back-fill is skipped."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )
        output_vars, written = _run_backfill_test(
            config, mock_aws_output="InService"
        )
        # Should not re-write — already has a value
        assert written == []

    def test_backfill_no_endpoint_name_does_nothing(self):
        """If ENDPOINT_NAME is empty, no aws call is made, no back-fill."""
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME=""\n'
        )
        output_vars, written = _run_backfill_test(config)
        assert output_vars["DEPLOYMENT_TARGET_SMAI_STATUS"] == ""
        assert written == []


class TestBackfillHyperpodEks:
    """Back-fill status var for hyperpod-eks from local config presence."""

    def test_backfill_sets_running_when_cluster_config_present(self):
        """v1.4 HyperPod config with cluster + instance → back-fills Running."""
        config = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="my-cluster"\n'
        )
        output_vars, written = _run_backfill_test(config)
        assert output_vars["DEPLOYMENT_TARGET_HP_STATUS"] == "Running"
        assert "DEPLOYMENT_TARGET_HP_STATUS=Running" in written

    def test_backfill_skipped_when_no_cluster_name(self):
        """Without HP_CLUSTER_NAME, back-fill does nothing."""
        config = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
        )
        output_vars, written = _run_backfill_test(config)
        assert output_vars["DEPLOYMENT_TARGET_HP_STATUS"] == ""
        assert written == []


class TestBackfillAsyncInference:
    """Back-fill status var for async-inference from live endpoint API."""

    def test_backfill_queries_aws_for_async_endpoint(self):
        """Async config with ENDPOINT_NAME → queries aws describe-endpoint."""
        config = (
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-async-ep"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://bucket/out/"\n'
        )
        output_vars, written = _run_backfill_test(
            config, mock_aws_output="InService"
        )
        assert output_vars["DEPLOYMENT_TARGET_ASYNC_STATUS"] == "InService"
        assert "DEPLOYMENT_TARGET_ASYNC_STATUS=InService" in written


class TestBackfillBatchTransform:
    """Back-fill status var for batch-transform from config presence."""

    def test_backfill_sets_completed_when_batch_config_present(self):
        """Batch config with input + output paths → back-fills Completed."""
        config = (
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
            'export BATCH_INPUT_PATH="s3://data/input/"\n'
            'export BATCH_OUTPUT_PATH="s3://data/output/"\n'
        )
        output_vars, written = _run_backfill_test(config)
        assert output_vars["DEPLOYMENT_TARGET_BATCH_STATUS"] == "Completed"
        assert "DEPLOYMENT_TARGET_BATCH_STATUS=Completed" in written

    def test_backfill_skipped_when_no_batch_paths(self):
        """Without batch paths, back-fill does nothing."""
        config = (
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
        )
        output_vars, written = _run_backfill_test(config)
        assert output_vars["DEPLOYMENT_TARGET_BATCH_STATUS"] == ""
        assert written == []


class TestBackfillEmptyTarget:
    """Back-fill does nothing when DEPLOYMENT_TARGET is empty."""

    def test_empty_target_no_backfill(self):
        """No DEPLOYMENT_TARGET → back-fill exits immediately."""
        config = 'export DEPLOYMENT_TARGET=""\n'
        output_vars, written = _run_backfill_test(config)
        assert written == []

    def test_unknown_target_no_backfill(self):
        """Unknown target value → back-fill exits without error."""
        config = 'export DEPLOYMENT_TARGET="unknown-thing"\n'
        output_vars, written = _run_backfill_test(config)
        assert written == []


# ---------------------------------------------------------------------------
# --target flag v1.4 backward compatibility tests (FR-9.2, Task 13.4)
# ---------------------------------------------------------------------------

# This script replicates the full deploy dispatch logic including:
# 1. Source config
# 2. Parse --target flag
# 3. Apply --target to DEPLOYMENT_TARGET
# 4. Run _backfill_status_var (populate status from live API / config presence)
# 5. Switch-or-deploy logic (fast switch if status var set, else helper)
#
# This tests the end-to-end interaction between back-fill and --target.
_TARGET_V14_LOGIC = """\
#!/bin/bash
set -e

SCRIPT_DIR="{tmpdir}"
source "${{SCRIPT_DIR}}/config"

# _update_config mock: writes the call to a sidecar file for inspection
_update_config() {{
    echo "$1=$2" >> "${{SCRIPT_DIR}}/written_vars"
    # Also apply to live config so subsequent reads see it
    export "$1=$2"
}}

# Mock aws CLI
export PATH="{tmpdir}/bin:$PATH"

# Parse flags
FLAG_TARGET=""
while [ $# -gt 0 ]; do
    case "$1" in
        --target) shift; FLAG_TARGET="$1"; shift ;;
        *) shift ;;
    esac
done

# Apply --target flag if provided
if [ -n "$FLAG_TARGET" ]; then
    DEPLOYMENT_TARGET="$FLAG_TARGET"
fi

# ── _backfill_status_var (from templates/do/deploy) ───
_backfill_status_var() {{
    local target="${{DEPLOYMENT_TARGET:-}}"
    [ -z "$target" ] && return 0

    local status_var=""
    case "$target" in
        managed-inference) status_var="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        hyperpod-eks)      status_var="DEPLOYMENT_TARGET_HP_STATUS" ;;
        async-inference)   status_var="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform)   status_var="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        *) return 0 ;;
    esac

    # Only back-fill if status var is empty (not yet migrated)
    [ -n "${{!status_var:-}}" ] && return 0

    # Try to detect status from live API
    local live_status=""
    case "$target" in
        managed-inference|async-inference)
            local ep_name="${{ENDPOINT_NAME:-}}"
            if [ -n "$ep_name" ]; then
                live_status=$(aws sagemaker describe-endpoint \\
                    --endpoint-name "$ep_name" \\
                    --region "${{AWS_REGION:-us-east-1}}" \\
                    --query 'EndpointStatus' \\
                    --output text 2>/dev/null) || live_status=""
            fi
            ;;
        hyperpod-eks)
            if [ -n "${{HP_CLUSTER_NAME:-}}" ] && [ -n "${{INSTANCE_TYPE:-}}" ]; then
                live_status="Running"
            fi
            ;;
        batch-transform)
            if [ -n "${{BATCH_INPUT_PATH:-}}" ] && [ -n "${{BATCH_OUTPUT_PATH:-}}" ]; then
                live_status="Completed"
            fi
            ;;
    esac

    # Write back-fill if we got a status
    if [ -n "$live_status" ]; then
        _update_config "$status_var" "$live_status"
        export "$status_var=$live_status"
    fi
}}

_backfill_status_var

# ── Switch-or-deploy logic (FR-4.4) ──────────────────────────
_NEEDS_HELPER=0
if [ -n "$FLAG_TARGET" ]; then
    case "$FLAG_TARGET" in
        managed-inference) _STATUS_VAR="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        hyperpod-eks)      _STATUS_VAR="DEPLOYMENT_TARGET_HP_STATUS" ;;
        async-inference)   _STATUS_VAR="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform)   _STATUS_VAR="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        *)                 _STATUS_VAR="" ;;
    esac

    if [ -n "$_STATUS_VAR" ] && [ -n "${{!_STATUS_VAR:-}}" ]; then
        # Existing deployment — switch focus only (FR-4.4, FR-4.5)
        _update_config DEPLOYMENT_TARGET "$FLAG_TARGET"
        echo "RESULT=SWITCH_FOCUS"
        echo "FOCUSED_TARGET=$FLAG_TARGET"
        exit 0
    fi
    _NEEDS_HELPER=1
fi

# If DEPLOYMENT_TARGET is still empty or _NEEDS_HELPER is set
_HELPER_INVOKED=0
if [ -z "${{DEPLOYMENT_TARGET:-}}" ] || [ "$_NEEDS_HELPER" -eq 1 ]; then
    _HELPER_INVOKED=1
fi

echo "RESULT=DISPATCH"
echo "HELPER_INVOKED=$_HELPER_INVOKED"
echo "DEPLOYMENT_TARGET=${{DEPLOYMENT_TARGET:-}}"
"""


def _run_target_v14_test(
    config_content: str,
    extra_args: list[str] | None = None,
    mock_aws_output: str = "",
) -> tuple[dict[str, str], list[str]]:
    """Run the full backfill + switch-or-deploy logic and return results.

    Args:
        config_content: Shell config to source (export KEY="value" lines).
        extra_args: CLI arguments (e.g., ["--target", "managed-inference"]).
        mock_aws_output: Text that the mocked `aws` command should output.

    Returns:
        Tuple of (output_vars dict, list of lines written via _update_config).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        # Write config
        config_path = os.path.join(tmpdir, "config")
        with open(config_path, "w") as f:
            f.write(config_content)

        # Create mock aws CLI
        bin_dir = os.path.join(tmpdir, "bin")
        os.makedirs(bin_dir)
        aws_mock_path = os.path.join(bin_dir, "aws")
        with open(aws_mock_path, "w") as f:
            f.write(f"#!/bin/bash\necho '{mock_aws_output}'\n")
        os.chmod(aws_mock_path, 0o755)

        # Prepare written_vars sidecar
        written_path = os.path.join(tmpdir, "written_vars")
        open(written_path, "w").close()

        script = _TARGET_V14_LOGIC.format(tmpdir=tmpdir)
        cmd = ["bash", "-c", script]
        if extra_args:
            cmd.extend(["--"] + extra_args)

        result = subprocess.run(cmd, capture_output=True, text=True)
        assert result.returncode == 0, f"Script failed: {result.stderr}"

        # Parse KEY=VALUE lines from output
        output_vars: dict[str, str] = {}
        for line in result.stdout.strip().split("\n"):
            if "=" in line:
                key, value = line.split("=", 1)
                output_vars[key] = value

        # Read what was written to config
        with open(written_path) as f:
            written_lines = [l.strip() for l in f.readlines() if l.strip()]

        return output_vars, written_lines


class TestTargetFlagV14Behavior:
    """Verify --target matches v1.4 behavior (FR-9.2, Task 13.4).

    v1.4 behavior: --target <mode> sets DEPLOYMENT_TARGET and dispatches
    directly without prompts when config is already populated.

    With the new code, back-fill runs first (populating the status var from
    live API / config presence), then switch-or-deploy logic decides:
    - Non-empty status var → fast focus switch (no helper, no re-prompts)
    - Empty status var → helper invoked (new deployment needed)
    """

    def test_target_managed_inference_with_backfilled_status_fast_switch(self):
        """--target managed-inference on v1.4 config with back-filled status → fast switch.

        The back-fill detects InService from mock aws, populates SMAI_STATUS,
        then the switch logic sees the status and does a fast focus switch.
        This matches v1.4 behavior (no re-prompting).
        """
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "managed-inference"],
            mock_aws_output="InService",
        )
        # Back-fill should have run and populated the status var,
        # then switch-or-deploy should see it and do a focus switch
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "managed-inference"
        # Back-fill wrote the status var, then switch wrote DEPLOYMENT_TARGET
        assert "DEPLOYMENT_TARGET_SMAI_STATUS=InService" in written
        assert "DEPLOYMENT_TARGET=managed-inference" in written

    def test_target_managed_inference_backfill_succeeds_same_behavior(self):
        """--target managed-inference on v1.4 config where back-fill succeeds → same behavior.

        Even with different endpoint status (Creating), the back-fill should still
        populate the status var and cause a fast switch.
        """
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.2xlarge"\n'
            'export ENDPOINT_NAME="production-ep"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "managed-inference"],
            mock_aws_output="Creating",
        )
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "managed-inference"
        assert "DEPLOYMENT_TARGET_SMAI_STATUS=Creating" in written

    def test_target_same_active_target_fast_switch(self):
        """--target to the SAME target that's already active → still fast switch.

        When the status var is already populated (post-migration), --target
        to the current target just confirms focus without re-prompting.
        """
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "managed-inference"],
            mock_aws_output="InService",
        )
        # Status var is already set → back-fill is skipped, switch logic fires
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "managed-inference"
        # Back-fill should NOT have re-written the status var (already populated)
        backfill_writes = [l for l in written if l.startswith("DEPLOYMENT_TARGET_SMAI_STATUS=")]
        assert backfill_writes == [], "Back-fill should skip when status already set"

    def test_target_different_target_no_status_invokes_helper(self):
        """--target to a DIFFERENT target that doesn't exist yet → helper invoked.

        When switching to a target with no deployment (empty status var AND
        back-fill can't populate it), the helper is correctly invoked to
        gather deployment parameters.
        """
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "hyperpod-eks"],
            # No HP_CLUSTER_NAME or INSTANCE_TYPE for HP → back-fill can't populate
        )
        # Back-fill for hyperpod-eks requires HP_CLUSTER_NAME + INSTANCE_TYPE
        # INSTANCE_TYPE is set but HP_CLUSTER_NAME is not → no back-fill
        # Switch logic sees empty HP_STATUS → helper needed for new deployment
        assert output_vars["RESULT"] == "DISPATCH"
        assert output_vars["HELPER_INVOKED"] == "1"
        assert output_vars["DEPLOYMENT_TARGET"] == "hyperpod-eks"

    def test_target_hyperpod_with_backfill_fast_switch(self):
        """--target hyperpod-eks on v1.4 config with cluster info → fast switch.

        When HP_CLUSTER_NAME and INSTANCE_TYPE are set, back-fill populates
        HP_STATUS=Running, then switch logic does fast focus switch.
        """
        config = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="prod-cluster"\n'
            'export HP_NAMESPACE="default"\n'
            'export HP_REPLICAS="1"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "hyperpod-eks"],
        )
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "hyperpod-eks"
        assert "DEPLOYMENT_TARGET_HP_STATUS=Running" in written

    def test_target_batch_transform_with_backfill_fast_switch(self):
        """--target batch-transform on v1.4 config with batch paths → fast switch.

        When BATCH_INPUT_PATH and BATCH_OUTPUT_PATH are set, back-fill populates
        BATCH_STATUS=Completed, then switch logic does fast focus switch.
        """
        config = (
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
            'export BATCH_INPUT_PATH="s3://data/input/"\n'
            'export BATCH_OUTPUT_PATH="s3://data/output/"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "batch-transform"],
        )
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "batch-transform"
        assert "DEPLOYMENT_TARGET_BATCH_STATUS=Completed" in written

    def test_target_async_with_backfill_fast_switch(self):
        """--target async-inference on v1.4 config with endpoint → fast switch.

        When ENDPOINT_NAME is set and aws returns InService, back-fill populates
        ASYNC_STATUS, then switch logic does fast focus switch.
        """
        config = (
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-async-ep"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://bucket/async-out/"\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "async-inference"],
            mock_aws_output="InService",
        )
        assert output_vars["RESULT"] == "SWITCH_FOCUS"
        assert output_vars["FOCUSED_TARGET"] == "async-inference"
        assert "DEPLOYMENT_TARGET_ASYNC_STATUS=InService" in written

    def test_target_managed_inference_no_endpoint_name_invokes_helper(self):
        """--target managed-inference but no ENDPOINT_NAME → back-fill fails, helper invoked.

        If the v1.4 config is incomplete (ENDPOINT_NAME empty), back-fill cannot
        determine status, so the helper is invoked (correct: needs user input).
        """
        config = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME=""\n'
        )
        output_vars, written = _run_target_v14_test(
            config,
            extra_args=["--target", "managed-inference"],
        )
        # No endpoint name → aws not called → no back-fill → helper needed
        assert output_vars["RESULT"] == "DISPATCH"
        assert output_vars["HELPER_INVOKED"] == "1"
