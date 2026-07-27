"""Unit tests for per-target status variable independence (CP-8).

Validates: Requirements FR-4.1, FR-4.2, CP-8

CP-8: Multi-target status vars MUST be independent. Deploying to target A
MUST NOT modify the status var of target B. Only the active DEPLOYMENT_TARGET
pointer and the deployed target's own status var are written.
"""
from __future__ import annotations

import os
import re
import tempfile

import pytest

from deploy_schema import STATUS_VARS


# ---------------------------------------------------------------------------
# Helper: Python re-implementation of _update_config from do/deploy
# ---------------------------------------------------------------------------

def update_config(config_path: str, key: str, value: str) -> None:
    """Replicate the bash _update_config function behavior.

    If the key exists as `export KEY=...`, replace the line in-place.
    Otherwise append `export KEY="value"` to the end.
    """
    with open(config_path, "r") as f:
        lines = f.readlines()

    pattern = re.compile(rf'^export {re.escape(key)}=')
    replaced = False
    new_lines = []
    for line in lines:
        if pattern.match(line):
            new_lines.append(f'export {key}="{value}"\n')
            replaced = True
        else:
            new_lines.append(line)

    if not replaced:
        new_lines.append(f'export {key}="{value}"\n')

    with open(config_path, "w") as f:
        f.writelines(new_lines)


def read_config_var(config_path: str, key: str) -> str:
    """Read a single var value from config, returns empty string if not found."""
    pattern = re.compile(rf'^export {re.escape(key)}="?(.*?)"?\s*$')
    with open(config_path, "r") as f:
        for line in f:
            m = pattern.match(line)
            if m:
                return m.group(1)
    return ""


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

INITIAL_CONFIG = """\
#!/bin/bash
export DEPLOYMENT_TARGET="realtime-inference"
export DEPLOYMENT_TARGET_SMAI_STATUS="InService"
export DEPLOYMENT_TARGET_HP_STATUS="Running"
export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"
export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"
export INSTANCE_TYPE="ml.g5.xlarge"
"""


@pytest.fixture
def config_file(tmp_path):
    """Create a temporary config file with all 4 status vars populated."""
    config_path = tmp_path / "config"
    config_path.write_text(INITIAL_CONFIG)
    return str(config_path)


# ---------------------------------------------------------------------------
# CP-8 Tests: Status var independence
# ---------------------------------------------------------------------------


class TestStatusVarIndependence:
    """Verify that writing one target's status does NOT modify other targets."""

    @pytest.mark.parametrize(
        "target,new_status",
        [
            ("realtime-inference", "Failed"),
            ("hyperpod-eks", "Failed"),
            ("async-inference", "Failed"),
            ("batch-transform", "InProgress"),
        ],
    )
    def test_writing_one_status_preserves_others(
        self, config_file: str, target: str, new_status: str
    ) -> None:
        """CP-8: Deploying to target A MUST NOT modify the status var of target B.

        Validates: Requirements CP-8
        """
        # Record initial values of all OTHER targets
        other_targets = {t: v for t, v in STATUS_VARS.items() if t != target}
        initial_others = {
            var_name: read_config_var(config_file, var_name)
            for var_name in other_targets.values()
        }

        # Simulate a deploy to `target` that writes status
        status_var = STATUS_VARS[target]
        update_config(config_file, status_var, new_status)

        # Verify the target's own status was updated
        assert read_config_var(config_file, status_var) == new_status

        # Verify all other targets remain unchanged
        for other_target, other_var in other_targets.items():
            actual = read_config_var(config_file, other_var)
            expected = initial_others[other_var]
            assert actual == expected, (
                f"Writing {target} status modified {other_target}'s var "
                f"({other_var}): expected '{expected}', got '{actual}'"
            )

    def test_deployment_target_update_preserves_all_status_vars(
        self, config_file: str
    ) -> None:
        """Switching DEPLOYMENT_TARGET must not modify any status var.

        Validates: Requirements CP-8, FR-4.5
        """
        # Record all status vars
        initial_status = {
            var: read_config_var(config_file, var)
            for var in STATUS_VARS.values()
        }

        # Switch active target
        update_config(config_file, "DEPLOYMENT_TARGET", "hyperpod-eks")

        # Verify DEPLOYMENT_TARGET was updated
        assert read_config_var(config_file, "DEPLOYMENT_TARGET") == "hyperpod-eks"

        # Verify all status vars are unchanged
        for var_name, expected_val in initial_status.items():
            actual = read_config_var(config_file, var_name)
            assert actual == expected_val, (
                f"Switching DEPLOYMENT_TARGET modified {var_name}: "
                f"expected '{expected_val}', got '{actual}'"
            )

    def test_sequential_deploys_to_different_targets(
        self, config_file: str
    ) -> None:
        """Multiple sequential deploys only update the respective target's var.

        Validates: Requirements CP-8, FR-4.1
        """
        # Deploy to realtime-inference (overwrite existing)
        update_config(config_file, "DEPLOYMENT_TARGET", "realtime-inference")
        update_config(config_file, "DEPLOYMENT_TARGET_SMAI_STATUS", "Creating")

        # Deploy to hyperpod-eks
        update_config(config_file, "DEPLOYMENT_TARGET", "hyperpod-eks")
        update_config(config_file, "DEPLOYMENT_TARGET_HP_STATUS", "Creating")

        # Verify realtime-inference status was not touched by the HP deploy
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_SMAI_STATUS") == "Creating"

        # Now HP succeeds
        update_config(config_file, "DEPLOYMENT_TARGET_HP_STATUS", "Running")

        # SMAI still shows Creating (untouched)
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_SMAI_STATUS") == "Creating"
        # Async and Batch untouched from initial
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_ASYNC_STATUS") == "InService"
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_failed_deploy_only_marks_own_status(self, config_file: str) -> None:
        """A failed deploy writes Failed only to its own status var.

        Validates: Requirements CP-8
        """
        # Simulate async-inference failure
        update_config(config_file, "DEPLOYMENT_TARGET_ASYNC_STATUS", "Failed")

        # All other status vars remain unchanged
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_SMAI_STATUS") == "InService"
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_HP_STATUS") == "Running"
        assert read_config_var(config_file, "DEPLOYMENT_TARGET_BATCH_STATUS") == "Completed"

    def test_status_vars_map_covers_all_targets(self) -> None:
        """STATUS_VARS defines a unique variable for each target.

        Validates: Requirements FR-4.2
        """
        expected_targets = {
            "realtime-inference",
            "hyperpod-eks",
            "async-inference",
            "batch-transform",
        }
        assert set(STATUS_VARS.keys()) == expected_targets

        # All var names must be unique
        var_names = list(STATUS_VARS.values())
        assert len(var_names) == len(set(var_names)), "Status var names must be unique"
