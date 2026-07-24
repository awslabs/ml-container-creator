"""Performance test: target switch completes under 1 second (CP-5).

Validates CP-5: For any target with a non-empty status var,
do/deploy --target <that-target> MUST complete in under 1 second
(switch only — no API calls, no prompts).

This test exercises the same bash switch logic as test_target_switching_cp2.py,
but focuses on timing rather than correctness.
"""
import os
import subprocess
import tempfile
import time

import pytest


# ---------------------------------------------------------------------------
# Bash script replicating the target switching logic from do/deploy.
# Same as in test_target_switching_cp2.py — the switch-or-deploy fast path.
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
        echo "Focused on $FLAG_TARGET"
        exit 0
    fi
    _NEEDS_HELPER=1
fi

echo "RESULT=NEEDS_HELPER"
"""

# All 4 targets used for switching tests
_ALL_TARGETS = [
    "managed-inference",
    "hyperpod-eks",
    "async-inference",
    "batch-transform",
]

# Performance threshold in seconds (CP-5 requirement)
_MAX_SWITCH_SECONDS = 1.0


def _write_config(tmpdir: str, lines: list[str]) -> str:
    """Write a do/config file and return its path."""
    config_path = os.path.join(tmpdir, "config")
    with open(config_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return config_path


def _run_switch_timed(tmpdir: str, target: str) -> tuple[float, str]:
    """Run the switch logic script and return (elapsed_seconds, stdout)."""
    script = _SWITCH_LOGIC.format(tmpdir=tmpdir)
    cmd = ["bash", "-c", script, "--", "--target", target]

    start = time.perf_counter()
    result = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.perf_counter() - start

    assert result.returncode == 0, f"Script failed: {result.stderr}"
    return elapsed, result.stdout.strip()


def _setup_full_config(tmpdir: str) -> str:
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


def _setup_large_config(tmpdir: str, extra_vars: int = 100) -> str:
    """Create a large config with many vars to stress config read/write."""
    lines = [
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
    ]
    # Add many extra vars to simulate a large config file
    for i in range(extra_vars):
        lines.append(f'export EXTRA_VAR_{i}="value_{i}_padding_data_to_increase_size"')
    return _write_config(tmpdir, lines)


class TestPerfSwitchCP5:
    """CP-5: Target switch completes in under 1 second.

    Validates that the fast-switch path (target has non-empty status var)
    is a simple config update + print, with no API calls or prompts.
    """

    @pytest.mark.parametrize("target", _ALL_TARGETS)
    def test_switch_each_target_under_1_second(self, tmp_path, target):
        """Each of the 4 targets switches in under 1 second."""
        tmpdir = str(tmp_path)
        _setup_full_config(tmpdir)

        elapsed, stdout = _run_switch_timed(tmpdir, target)

        assert f"Focused on {target}" in stdout
        assert elapsed < _MAX_SWITCH_SECONDS, (
            f"Switch to {target} took {elapsed:.3f}s, exceeds {_MAX_SWITCH_SECONDS}s limit"
        )

    def test_cold_start_switch_under_1_second(self, tmp_path):
        """First-ever switch (cold) completes in under 1 second."""
        tmpdir = str(tmp_path)
        _setup_full_config(tmpdir)

        # Cold: first invocation, no prior bash caching
        elapsed, stdout = _run_switch_timed(tmpdir, "hyperpod-eks")

        assert "Focused on hyperpod-eks" in stdout
        assert elapsed < _MAX_SWITCH_SECONDS, (
            f"Cold switch took {elapsed:.3f}s, exceeds {_MAX_SWITCH_SECONDS}s limit"
        )

    def test_warm_repeated_switch_under_1_second(self, tmp_path):
        """Repeated (warm) switches each complete in under 1 second."""
        tmpdir = str(tmp_path)
        _setup_full_config(tmpdir)

        # Warm up with one switch
        _run_switch_timed(tmpdir, "managed-inference")

        # Now time 3 consecutive warm switches
        for target in ["hyperpod-eks", "async-inference", "batch-transform"]:
            elapsed, stdout = _run_switch_timed(tmpdir, target)
            assert f"Focused on {target}" in stdout
            assert elapsed < _MAX_SWITCH_SECONDS, (
                f"Warm switch to {target} took {elapsed:.3f}s, exceeds limit"
            )

    def test_rapid_consecutive_switches_each_under_1_second(self, tmp_path):
        """10 rapid consecutive switches, each individually under 1 second."""
        tmpdir = str(tmp_path)
        _setup_full_config(tmpdir)

        # Cycle through targets 10 times
        targets_cycle = (_ALL_TARGETS * 3)[:10]  # 10 switches

        for i, target in enumerate(targets_cycle):
            elapsed, stdout = _run_switch_timed(tmpdir, target)
            assert f"Focused on {target}" in stdout
            assert elapsed < _MAX_SWITCH_SECONDS, (
                f"Switch #{i+1} to {target} took {elapsed:.3f}s, exceeds limit"
            )

    def test_large_config_switch_under_1_second(self, tmp_path):
        """Switch stays under 1 second even with a large config (100+ vars)."""
        tmpdir = str(tmp_path)
        _setup_large_config(tmpdir, extra_vars=100)

        for target in _ALL_TARGETS:
            elapsed, stdout = _run_switch_timed(tmpdir, target)
            assert f"Focused on {target}" in stdout
            assert elapsed < _MAX_SWITCH_SECONDS, (
                f"Large-config switch to {target} took {elapsed:.3f}s, exceeds limit"
            )

    def test_very_large_config_switch_under_1_second(self, tmp_path):
        """Switch stays under 1 second with a very large config (500 vars)."""
        tmpdir = str(tmp_path)
        _setup_large_config(tmpdir, extra_vars=500)

        elapsed, stdout = _run_switch_timed(tmpdir, "hyperpod-eks")
        assert "Focused on hyperpod-eks" in stdout
        assert elapsed < _MAX_SWITCH_SECONDS, (
            f"Very-large-config switch took {elapsed:.3f}s, exceeds limit"
        )
