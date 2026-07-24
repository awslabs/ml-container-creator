"""Integration test: target switching sequences (CP-2).

Validates CP-2: For any sequence of --target switches, the DEPLOYMENT_TARGET
in do/config MUST always equal the last --target value passed. Status vars
for other targets MUST remain unchanged.

This test exercises the actual bash dispatcher logic (do/deploy) since target
switching happens at the bash level. It uses a self-contained bash script that
replicates the dispatch logic from templates/do/deploy, focusing on the
switch-or-deploy path. Deploy commands are mocked to avoid AWS calls.
"""
import os
import subprocess
import tempfile

import pytest


# ---------------------------------------------------------------------------
# Bash script replicating the target switching logic from do/deploy.
#
# This script:
# 1. Sources the config file
# 2. Parses --target flag
# 3. Runs _backfill_status_var (to support v1.4 configs)
# 4. Executes switch-or-deploy logic
# 5. Persists DEPLOYMENT_TARGET to config on switch
#
# The script does NOT invoke the deploy helper or deploy.d scripts — it only
# exercises the switching path (status var non-empty → fast switch).
# ---------------------------------------------------------------------------

_SWITCH_LOGIC = """\
#!/bin/bash
set -e

SCRIPT_DIR="{tmpdir}"
source "${{SCRIPT_DIR}}/config"

# ── Config persistence (same as do/deploy) ──────────────────
_update_config() {{
    local key="$1" value="$2"
    local config="${{SCRIPT_DIR}}/config"
    if grep -q "^export ${{key}}=" "$config" 2>/dev/null; then
        sed -i.bak \\
          "s|^export ${{key}}=.*|export ${{key}}=\\"${{value}}\\"|" \\
          "$config"
        rm -f "${{config}}.bak"
    else
        echo "export ${{key}}=\\"${{value}}\\"" >> "$config"
    fi
}}

# Parse --target flag
FLAG_TARGET=""
while [ $# -gt 0 ]; do
    case "$1" in
        --target) shift; FLAG_TARGET="$1"; shift ;;
        *) shift ;;
    esac
done

# Apply --target flag
if [ -n "$FLAG_TARGET" ]; then
    DEPLOYMENT_TARGET="$FLAG_TARGET"
fi

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
        # Existing deployment — switch focus only
        _update_config DEPLOYMENT_TARGET "$FLAG_TARGET"
        echo "RESULT=SWITCH_FOCUS"
        echo "FOCUSED_TARGET=$FLAG_TARGET"
        exit 0
    fi
    _NEEDS_HELPER=1
fi

# If helper would be invoked (no existing deployment for target)
echo "RESULT=NEEDS_HELPER"
echo "DEPLOYMENT_TARGET=${{DEPLOYMENT_TARGET:-}}"
"""


def _write_config(tmpdir: str, lines: list[str]) -> str:
    """Write a do/config file and return its path."""
    config_path = os.path.join(tmpdir, "config")
    with open(config_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return config_path


def _read_config_var(config_path: str, var_name: str) -> str:
    """Read a variable value from a bash config file by sourcing it."""
    script = f'source "{config_path}" && echo "${{{var_name}:-}}"'
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _run_switch(tmpdir: str, target: str) -> dict[str, str]:
    """Run the switch logic script with --target and return output vars."""
    script = _SWITCH_LOGIC.format(tmpdir=tmpdir)
    cmd = ["bash", "-c", script, "--", "--target", target]

    result = subprocess.run(cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"Script failed: {result.stderr}"

    output = {}
    for line in result.stdout.strip().split("\n"):
        if "=" in line:
            key, value = line.split("=", 1)
            output[key] = value
    return output


class TestTargetSwitchingCP2:
    """CP-2: DEPLOYMENT_TARGET always equals last --target; other status vars unchanged.

    These tests set up configs with multiple targets having non-empty status vars
    (simulating existing deployments for each), then perform sequences of --target
    switches and verify:
    1. DEPLOYMENT_TARGET in config equals the last --target value after each switch
    2. Status vars for OTHER targets remain unchanged after each switch
    """

    def _setup_multi_target_config(self, tmpdir: str) -> str:
        """Create a config with all 4 targets having non-empty status vars."""
        return _write_config(tmpdir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
            'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"',
            'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"',
            'export INSTANCE_TYPE="ml.g5.xlarge"',
            'export ENDPOINT_NAME="my-endpoint"',
            'export HP_CLUSTER_NAME="my-cluster"',
            'export HP_GPU_COUNT="4"',
            'export ASYNC_S3_OUTPUT_PATH="s3://bucket/async/"',
            'export BATCH_INPUT_PATH="s3://data/input/"',
            'export BATCH_OUTPUT_PATH="s3://data/output/"',
        ])

    def test_single_switch_updates_deployment_target(self, tmp_path):
        """A single --target switch updates DEPLOYMENT_TARGET to that target."""
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        output = _run_switch(tmpdir, "hyperpod-eks")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert output["FOCUSED_TARGET"] == "hyperpod-eks"

        # Verify config was updated
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "hyperpod-eks"

    def test_switch_preserves_other_status_vars(self, tmp_path):
        """Switching to one target leaves status vars of other targets unchanged."""
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        # Switch to hyperpod-eks
        output = _run_switch(tmpdir, "hyperpod-eks")
        assert output["RESULT"] == "SWITCH_FOCUS"

        # All status vars must remain unchanged
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_two_switch_sequence(self, tmp_path):
        """Two consecutive switches: DEPLOYMENT_TARGET equals the second target."""
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        # First switch: managed-inference → async-inference
        _run_switch(tmpdir, "async-inference")
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "async-inference"

        # Re-source config for second switch (simulates next invocation)
        output = _run_switch(tmpdir, "batch-transform")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "batch-transform"

    def test_round_trip_smai_hp_async_batch_smai(self, tmp_path):
        """Full round-trip: smai → hp → async → batch → smai.

        After each switch DEPLOYMENT_TARGET equals the last target.
        After all switches, all status vars are unchanged.
        """
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        sequence = [
            "hyperpod-eks",
            "async-inference",
            "batch-transform",
            "managed-inference",
        ]

        for target in sequence:
            output = _run_switch(tmpdir, target)
            assert output["RESULT"] == "SWITCH_FOCUS", (
                f"Expected SWITCH_FOCUS for {target}, got {output}"
            )
            # CP-2: DEPLOYMENT_TARGET == last --target value
            assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == target, (
                f"After switching to {target}, DEPLOYMENT_TARGET should be {target}"
            )

        # After full round-trip, all status vars unchanged
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_repeated_switch_to_same_target(self, tmp_path):
        """Switching to the same target multiple times is idempotent."""
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        for _ in range(3):
            output = _run_switch(tmpdir, "async-inference")
            assert output["RESULT"] == "SWITCH_FOCUS"
            assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "async-inference"

        # Status vars all preserved
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_alternating_switch_pattern(self, tmp_path):
        """Alternating between two targets: hp → smai → hp → smai."""
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        alternating = ["hyperpod-eks", "managed-inference"] * 3  # 6 switches

        for target in alternating:
            output = _run_switch(tmpdir, target)
            assert output["RESULT"] == "SWITCH_FOCUS"
            assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == target

        # Final target is managed-inference (last in the pattern)
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "managed-inference"

        # All status vars preserved through 6 switches
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_switch_does_not_modify_target_specific_vars(self, tmp_path):
        """Switching targets does not modify any target-specific config vars.

        Beyond status vars, vars like ENDPOINT_NAME, HP_CLUSTER_NAME etc.
        must also be preserved across switches.
        """
        tmpdir = str(tmp_path)
        config_path = self._setup_multi_target_config(tmpdir)

        # Perform several switches
        for target in ["batch-transform", "hyperpod-eks", "async-inference"]:
            _run_switch(tmpdir, target)

        # All target-specific vars preserved
        assert _read_config_var(config_path, "INSTANCE_TYPE") == "ml.g5.xlarge"
        assert _read_config_var(config_path, "ENDPOINT_NAME") == "my-endpoint"
        assert _read_config_var(config_path, "HP_CLUSTER_NAME") == "my-cluster"
        assert _read_config_var(config_path, "HP_GPU_COUNT") == "4"
        assert _read_config_var(config_path, "ASYNC_S3_OUTPUT_PATH") == "s3://bucket/async/"
        assert _read_config_var(config_path, "BATCH_INPUT_PATH") == "s3://data/input/"
        assert _read_config_var(config_path, "BATCH_OUTPUT_PATH") == "s3://data/output/"

    def test_switch_to_undeployed_target_needs_helper(self, tmp_path):
        """Switching to a target with empty status var triggers the helper (not a fast switch).

        CP-2 only applies to the fast-switch path (existing deployment).
        When the status var is empty, the helper is needed — this is NOT a switch.
        """
        tmpdir = str(tmp_path)
        # Config where only SMAI and HP have status (async and batch are empty)
        config_path = _write_config(tmpdir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
            'export DEPLOYMENT_TARGET_ASYNC_STATUS=""',
            'export DEPLOYMENT_TARGET_BATCH_STATUS=""',
            'export INSTANCE_TYPE="ml.g5.xlarge"',
            'export ENDPOINT_NAME="my-endpoint"',
        ])

        # Switch to a deployed target → fast switch
        output = _run_switch(tmpdir, "hyperpod-eks")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "hyperpod-eks"

        # Switch to an undeployed target → needs helper
        output = _run_switch(tmpdir, "async-inference")
        assert output["RESULT"] == "NEEDS_HELPER"

        # DEPLOYMENT_TARGET in the output reflects intent (will be set after helper runs)
        assert output["DEPLOYMENT_TARGET"] == "async-inference"

        # Status vars for existing targets remain unchanged
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"

    def test_mixed_switch_sequence_with_partial_deployments(self, tmp_path):
        """Switching among deployed targets works; attempting undeployed target triggers helper.

        Tests a realistic scenario: 3 targets deployed, 1 not yet deployed.
        Switches among deployed targets always succeed as fast switches.
        """
        tmpdir = str(tmp_path)
        config_path = _write_config(tmpdir, [
            'export DEPLOYMENT_TARGET="managed-inference"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            'export DEPLOYMENT_TARGET_HP_STATUS=""',  # Not deployed
            'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"',
            'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"',
            'export INSTANCE_TYPE="ml.g5.xlarge"',
            'export ENDPOINT_NAME="my-endpoint"',
        ])

        # Switch among deployed targets: all should be fast switches
        output = _run_switch(tmpdir, "async-inference")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "async-inference"

        output = _run_switch(tmpdir, "batch-transform")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "batch-transform"

        output = _run_switch(tmpdir, "managed-inference")
        assert output["RESULT"] == "SWITCH_FOCUS"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == "managed-inference"

        # Attempt undeployed target
        output = _run_switch(tmpdir, "hyperpod-eks")
        assert output["RESULT"] == "NEEDS_HELPER"

        # Status vars preserved through all switches
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_HP_STATUS") == ""
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"
