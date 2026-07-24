"""Unit tests for deploy_schema module.

Validates: Requirements FR-4.6, CP-1
"""
from __future__ import annotations

import pytest

from deploy_schema import SCHEMAS, STATUS_VARS, validate_config


# ---------------------------------------------------------------------------
# Schema structure tests
# ---------------------------------------------------------------------------

EXPECTED_TARGETS = ["managed-inference", "hyperpod-eks", "async-inference", "batch-transform"]


class TestSchemaStructure:
    """Verify SCHEMAS and STATUS_VARS cover all 4 deployment targets."""

    @pytest.mark.parametrize("target", EXPECTED_TARGETS)
    def test_target_defined_in_schemas(self, target: str) -> None:
        assert target in SCHEMAS

    @pytest.mark.parametrize("target", EXPECTED_TARGETS)
    def test_target_has_status_var(self, target: str) -> None:
        assert target in STATUS_VARS
        assert STATUS_VARS[target]  # non-empty string

    @pytest.mark.parametrize("target", EXPECTED_TARGETS)
    def test_schema_has_required_list(self, target: str) -> None:
        assert "required" in SCHEMAS[target]
        assert isinstance(SCHEMAS[target]["required"], list)
        assert len(SCHEMAS[target]["required"]) > 0

    @pytest.mark.parametrize("target", EXPECTED_TARGETS)
    def test_schema_has_optional_dict(self, target: str) -> None:
        assert "optional" in SCHEMAS[target]
        assert isinstance(SCHEMAS[target]["optional"], dict)


# ---------------------------------------------------------------------------
# validate_config tests
# ---------------------------------------------------------------------------

class TestValidateConfig:
    """Verify validate_config correctly identifies missing required vars."""

    def test_all_required_present_returns_empty(self) -> None:
        """When all required vars are non-empty, validation passes."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge", "ENDPOINT_NAME": "my-endpoint"}
        result = validate_config("managed-inference", config)
        assert result == []

    def test_missing_var_returned(self) -> None:
        """Missing vars appear in the returned list."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge"}
        result = validate_config("managed-inference", config)
        assert "ENDPOINT_NAME" in result

    def test_empty_var_treated_as_missing(self) -> None:
        """Empty string values count as missing."""
        config = {"INSTANCE_TYPE": "", "ENDPOINT_NAME": "my-endpoint"}
        result = validate_config("managed-inference", config)
        assert "INSTANCE_TYPE" in result

    def test_all_missing_returns_full_list(self) -> None:
        """When no required vars are provided, all are reported missing."""
        result = validate_config("batch-transform", {})
        expected = ["INSTANCE_TYPE", "BATCH_INPUT_PATH", "BATCH_OUTPUT_PATH"]
        assert sorted(result) == sorted(expected)

    def test_unknown_target_raises_value_error(self) -> None:
        """Unknown target names raise ValueError."""
        with pytest.raises(ValueError, match="Unknown deployment target"):
            validate_config("nonexistent-target", {})

    def test_optional_vars_not_in_missing(self) -> None:
        """Optional vars with defaults are never reported as missing."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge", "ENDPOINT_NAME": "ep"}
        result = validate_config("managed-inference", config)
        # Optional vars like ENDPOINT_STRATEGY should not appear
        assert "ENDPOINT_STRATEGY" not in result
        assert "IC_GPU_COUNT" not in result

    @pytest.mark.parametrize("target", EXPECTED_TARGETS)
    def test_cp1_all_required_filled_passes(self, target: str) -> None:
        """CP-1: If all required vars are non-empty, validation passes.

        Validates: Requirements CP-1
        """
        # Build a config where every required var has a non-empty value
        config = {var: "test-value" for var in SCHEMAS[target]["required"]}
        result = validate_config(target, config)
        assert result == [], f"Expected no missing vars for {target}, got: {result}"

    def test_hyperpod_required_vars(self) -> None:
        """Verify hyperpod-eks specific required vars."""
        config = {"INSTANCE_TYPE": "ml.p4d.24xlarge", "HP_CLUSTER_NAME": "my-cluster"}
        result = validate_config("hyperpod-eks", config)
        assert result == []

    def test_async_inference_missing_output_path(self) -> None:
        """async-inference requires ASYNC_S3_OUTPUT_PATH."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge"}
        result = validate_config("async-inference", config)
        assert "ASYNC_S3_OUTPUT_PATH" in result
