"""Property-based test: status vars independent (CP-8).

**Validates: Requirements CP-8**

Multi-target status vars MUST be independent. Deploying to target A MUST NOT
modify the status var of target B. Only the active DEPLOYMENT_TARGET pointer
and the deployed target's own status var are written.

Uses hypothesis to generate random initial config states and deployment
sequences, verifying independence holds across all combinations.
"""
import os
import re
import subprocess
import sys

import pytest
from hypothesis import given, settings, HealthCheck, assume
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

from deploy_schema import STATUS_VARS  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_TARGETS = list(STATUS_VARS.keys())

# Valid status values per target (from design.md)
TARGET_VALID_STATUSES: dict[str, list[str]] = {
    "managed-inference": ["InService", "Creating", "Failed", ""],
    "hyperpod-eks": ["Running", "Creating", "Failed", ""],
    "async-inference": ["InService", "Creating", "Failed", ""],
    "batch-transform": ["Completed", "InProgress", "Failed", ""],
}

# ---------------------------------------------------------------------------
# Bash script that replicates _update_config from do/deploy.
#
# This is the actual persistence logic used in production. We test at the
# bash level to ensure the sed-based replacement logic maintains independence.
# ---------------------------------------------------------------------------

_UPDATE_CONFIG_SCRIPT = """\
#!/bin/bash
set -e

SCRIPT_DIR="{tmpdir}"

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

# Apply updates: KEY=VALUE pairs passed as arguments
while [ $# -gt 0 ]; do
    _update_config "$1" "$2"
    shift 2
done
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_config(tmpdir: str, status_values: dict[str, str]) -> str:
    """Write a do/config file with the given status var values."""
    config_path = os.path.join(tmpdir, "config")
    lines = ['#!/bin/bash']
    lines.append('export DEPLOYMENT_TARGET="managed-inference"')
    for target, var_name in STATUS_VARS.items():
        value = status_values.get(target, "")
        lines.append(f'export {var_name}="{value}"')
    # Add some non-status vars to ensure they're also preserved
    lines.append('export INSTANCE_TYPE="ml.g5.xlarge"')
    lines.append('export ENDPOINT_NAME="my-ep"')
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


def _deploy_to_target(tmpdir: str, target: str, new_status: str) -> None:
    """Simulate a deploy operation: update DEPLOYMENT_TARGET and the target's status var.

    This replicates what do/deploy does after a successful deployment:
    1. Set DEPLOYMENT_TARGET to the target
    2. Set the target's status var to the new status
    """
    script = _UPDATE_CONFIG_SCRIPT.format(tmpdir=tmpdir)
    status_var = STATUS_VARS[target]
    cmd = [
        "bash", "-c", script, "--",
        "DEPLOYMENT_TARGET", target,
        status_var, new_status,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"Deploy script failed: {result.stderr}"


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------


@st.composite
def st_initial_config(draw):
    """Generate random initial status values for all 4 targets."""
    config = {}
    for target in ALL_TARGETS:
        config[target] = draw(st.sampled_from(TARGET_VALID_STATUSES[target]))
    return config


@st.composite
def st_deploy_operation(draw):
    """Generate a single deploy operation: target + new status (non-empty)."""
    target = draw(st.sampled_from(ALL_TARGETS))
    # Deploy writes a non-empty status (Creating, InService, Running, etc.)
    # Filter out empty string since a deploy always writes a definitive status
    valid_statuses = [s for s in TARGET_VALID_STATUSES[target] if s != ""]
    new_status = draw(st.sampled_from(valid_statuses))
    return (target, new_status)


@st.composite
def st_deploy_sequence(draw):
    """Generate a sequence of 2-6 deploy operations to random targets."""
    length = draw(st.integers(min_value=2, max_value=6))
    ops = []
    for _ in range(length):
        target = draw(st.sampled_from(ALL_TARGETS))
        valid_statuses = [s for s in TARGET_VALID_STATUSES[target] if s != ""]
        new_status = draw(st.sampled_from(valid_statuses))
        ops.append((target, new_status))
    return ops


# ---------------------------------------------------------------------------
# Property-based tests
# ---------------------------------------------------------------------------


class TestStatusVarsIndependentCP8:
    """Property: deploying to target A MUST NOT modify target B's status var.

    **Validates: Requirements CP-8**
    """

    @given(
        initial_config=st_initial_config(),
        deploy_op=st_deploy_operation(),
    )
    @settings(
        max_examples=50,
        deadline=10000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_single_deploy_preserves_other_status_vars(
        self, initial_config, deploy_op, tmp_path_factory
    ):
        """Deploying to one target leaves all other targets' status vars unchanged.

        For any initial configuration of status vars and any single deploy operation,
        only the deployed target's status var and DEPLOYMENT_TARGET are modified.
        All other status vars must remain exactly as they were before.
        """
        tmpdir = str(tmp_path_factory.mktemp("cp8_single"))
        config_path = _write_config(tmpdir, initial_config)

        target, new_status = deploy_op
        other_targets = [t for t in ALL_TARGETS if t != target]

        # Record initial values of OTHER targets' status vars
        initial_others = {}
        for other in other_targets:
            var = STATUS_VARS[other]
            initial_others[var] = _read_config_var(config_path, var)

        # Perform deploy
        _deploy_to_target(tmpdir, target, new_status)

        # Verify the deployed target's status was written correctly
        assert _read_config_var(config_path, STATUS_VARS[target]) == new_status

        # Verify DEPLOYMENT_TARGET was updated
        assert _read_config_var(config_path, "DEPLOYMENT_TARGET") == target

        # CP-8: All other targets' status vars MUST be unchanged
        for other in other_targets:
            var = STATUS_VARS[other]
            actual = _read_config_var(config_path, var)
            expected = initial_others[var]
            assert actual == expected, (
                f"Deploying to {target} modified {other}'s status var "
                f"({var}): expected '{expected}', got '{actual}'"
            )

    @given(
        initial_config=st_initial_config(),
        deploy_sequence=st_deploy_sequence(),
    )
    @settings(
        max_examples=30,
        deadline=30000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_deploy_sequence_maintains_independence(
        self, initial_config, deploy_sequence, tmp_path_factory
    ):
        """Random sequences of deploys to different targets maintain independence.

        After a sequence of deploys, each target's status var reflects ONLY the
        last deploy to that specific target (or the initial value if never deployed).
        """
        tmpdir = str(tmp_path_factory.mktemp("cp8_seq"))
        config_path = _write_config(tmpdir, initial_config)

        # Track expected final state: start with initial, update as we go
        expected_status: dict[str, str] = {}
        for target in ALL_TARGETS:
            expected_status[target] = initial_config[target]

        # Execute deploy sequence
        for target, new_status in deploy_sequence:
            _deploy_to_target(tmpdir, target, new_status)
            expected_status[target] = new_status

        # Verify each target's status var equals ONLY its own last deploy value
        for target in ALL_TARGETS:
            var = STATUS_VARS[target]
            actual = _read_config_var(config_path, var)
            expected = expected_status[target]
            assert actual == expected, (
                f"After deploy sequence, {target}'s status var ({var}) "
                f"is '{actual}' but expected '{expected}'. "
                f"Sequence was: {deploy_sequence}"
            )

    @given(
        initial_config=st_initial_config(),
        target=st.sampled_from(ALL_TARGETS),
        status_progression=st.lists(
            st.sampled_from(["Creating", "InService", "Failed", "Running", "Completed", "InProgress"]),
            min_size=2,
            max_size=5,
        ),
    )
    @settings(
        max_examples=30,
        deadline=20000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_repeated_deploys_same_target_only_affects_own_var(
        self, initial_config, target, status_progression, tmp_path_factory
    ):
        """Deploying to the same target multiple times with different statuses
        (Creating -> InService -> Failed) only affects that target's var.

        Other targets must remain at their initial values throughout.
        """
        tmpdir = str(tmp_path_factory.mktemp("cp8_repeat"))
        config_path = _write_config(tmpdir, initial_config)

        other_targets = [t for t in ALL_TARGETS if t != target]

        # Record initial others
        initial_others = {}
        for other in other_targets:
            var = STATUS_VARS[other]
            initial_others[var] = _read_config_var(config_path, var)

        # Deploy multiple times to the same target with different statuses
        for status in status_progression:
            _deploy_to_target(tmpdir, target, status)

        # The target's status var should reflect the LAST status in progression
        final_status = status_progression[-1]
        assert _read_config_var(config_path, STATUS_VARS[target]) == final_status

        # All other targets MUST be unchanged from their initial values
        for other in other_targets:
            var = STATUS_VARS[other]
            actual = _read_config_var(config_path, var)
            expected = initial_others[var]
            assert actual == expected, (
                f"Repeated deploys to {target} modified {other}'s var "
                f"({var}): expected '{expected}', got '{actual}'. "
                f"Progression was: {status_progression}"
            )

    @given(
        initial_config=st_initial_config(),
    )
    @settings(
        max_examples=20,
        deadline=20000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_deploy_to_all_four_targets_each_only_writes_own(
        self, initial_config, tmp_path_factory
    ):
        """Mixed deployment across all 4 targets: each deploy only writes its own var.

        Deploy to all 4 targets in random order and verify final state is
        exactly: each target has the status from its own deploy, not from any other.
        """
        tmpdir = str(tmp_path_factory.mktemp("cp8_all4"))
        config_path = _write_config(tmpdir, initial_config)

        # Deploy to every target with a known status (not from initial)
        deploy_statuses = {
            "managed-inference": "Creating",
            "hyperpod-eks": "Creating",
            "async-inference": "Creating",
            "batch-transform": "InProgress",
        }

        for target, status in deploy_statuses.items():
            _deploy_to_target(tmpdir, target, status)

        # After deploying to all 4, each target should have exactly its deployed status
        for target, expected_status in deploy_statuses.items():
            var = STATUS_VARS[target]
            actual = _read_config_var(config_path, var)
            assert actual == expected_status, (
                f"After deploying to all 4 targets, {target}'s var ({var}) "
                f"is '{actual}' but expected '{expected_status}'"
            )
