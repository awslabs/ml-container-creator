"""Unit tests for benchmark writer input validation.

Tests validate that the validation logic in templates/do/.benchmark_writer.py
correctly rejects invalid input with structured errors and accepts valid input.

Validates: Requirements 6.4
"""

import importlib.util
import json
import os
import sys

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_WRITER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".benchmark_writer.py"
)
_WRITER_PATH = os.path.normpath(_WRITER_PATH)

_spec = importlib.util.spec_from_file_location("benchmark_writer", _WRITER_PATH)
_benchmark_writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_benchmark_writer)

validate_benchmark_input = _benchmark_writer.validate_benchmark_input
emit_validation_error = _benchmark_writer.emit_validation_error


# ── Valid input fixture ───────────────────────────────────────────────────────

def _valid_input():
    """Return a minimal valid benchmark input."""
    return {
        "config_id": "ec3f1a0072d1b3d4",
        "model_name": "Qwen/Qwen3-4B",
        "instance_type": "ml.g5.xlarge",
        "deployment_config": "transformers-vllm",
        "region": "us-east-1",
        "metrics": [
            {"concurrency": 1, "request_throughput": 12.5},
            {"concurrency": 4, "request_throughput": 38.2},
        ],
    }


# ── Tests: valid input ────────────────────────────────────────────────────────

class TestValidInput:
    """Verify that valid inputs pass validation with no errors."""

    def test_minimal_valid_input_passes(self):
        data = _valid_input()
        errors = validate_benchmark_input(data)
        assert errors == []

    def test_single_metric_entry_passes(self):
        data = _valid_input()
        data["metrics"] = [{"concurrency": 1}]
        errors = validate_benchmark_input(data)
        assert errors == []

    def test_extra_fields_are_ignored(self):
        data = _valid_input()
        data["extra_field"] = "should be fine"
        data["metrics"][0]["extra"] = 999
        errors = validate_benchmark_input(data)
        assert errors == []


# ── Tests: missing fields ─────────────────────────────────────────────────────

class TestMissingFields:
    """Verify that missing required fields produce structured errors."""

    def test_missing_config_id(self):
        data = _valid_input()
        del data["config_id"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "config_id"
        assert "missing" in errors[0]["reason"]

    def test_missing_model_name(self):
        data = _valid_input()
        del data["model_name"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "model_name"
        assert "missing" in errors[0]["reason"]

    def test_missing_instance_type(self):
        data = _valid_input()
        del data["instance_type"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "instance_type"
        assert "missing" in errors[0]["reason"]

    def test_missing_deployment_config(self):
        data = _valid_input()
        del data["deployment_config"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "deployment_config"
        assert "missing" in errors[0]["reason"]

    def test_missing_region(self):
        data = _valid_input()
        del data["region"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "region"
        assert "missing" in errors[0]["reason"]

    def test_missing_metrics(self):
        data = _valid_input()
        del data["metrics"]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics"
        assert "missing" in errors[0]["reason"]

    def test_all_fields_missing(self):
        errors = validate_benchmark_input({})
        assert len(errors) == 6
        fields = [e["field"] for e in errors]
        assert "config_id" in fields
        assert "model_name" in fields
        assert "instance_type" in fields
        assert "deployment_config" in fields
        assert "region" in fields
        assert "metrics" in fields


# ── Tests: invalid field values ───────────────────────────────────────────────

class TestInvalidFieldValues:
    """Verify that invalid field values produce structured errors."""

    def test_empty_config_id(self):
        data = _valid_input()
        data["config_id"] = ""
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "config_id"
        assert "non-empty" in errors[0]["reason"]

    def test_whitespace_config_id(self):
        data = _valid_input()
        data["config_id"] = "   "
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "config_id"

    def test_non_string_config_id(self):
        data = _valid_input()
        data["config_id"] = 12345
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "config_id"

    def test_instance_type_not_matching_ml_pattern(self):
        data = _valid_input()
        data["instance_type"] = "g5.xlarge"
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "instance_type"
        assert "ml.*" in errors[0]["reason"]

    def test_instance_type_empty(self):
        data = _valid_input()
        data["instance_type"] = ""
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "instance_type"

    def test_metrics_empty_array(self):
        data = _valid_input()
        data["metrics"] = []
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics"
        assert "non-empty" in errors[0]["reason"]

    def test_metrics_not_array(self):
        data = _valid_input()
        data["metrics"] = "not an array"
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics"
        assert "non-empty array" in errors[0]["reason"]

    def test_metrics_entry_missing_concurrency(self):
        data = _valid_input()
        data["metrics"] = [{"request_throughput": 12.5}]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics[0].concurrency"
        assert "missing" in errors[0]["reason"]

    def test_metrics_entry_concurrency_not_int(self):
        data = _valid_input()
        data["metrics"] = [{"concurrency": "four"}]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics[0].concurrency"
        assert "integer" in errors[0]["reason"]

    def test_metrics_entry_concurrency_float(self):
        data = _valid_input()
        data["metrics"] = [{"concurrency": 4.5}]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert errors[0]["field"] == "metrics[0].concurrency"
        assert "integer" in errors[0]["reason"]

    def test_metrics_entry_not_object(self):
        data = _valid_input()
        data["metrics"] = [42]
        errors = validate_benchmark_input(data)
        assert len(errors) == 1
        assert "object" in errors[0]["reason"]

    def test_multiple_invalid_metrics_entries(self):
        data = _valid_input()
        data["metrics"] = [
            {"concurrency": 1},
            {"request_throughput": 5.0},  # missing concurrency
            {"concurrency": "bad"},       # non-int concurrency
        ]
        errors = validate_benchmark_input(data)
        assert len(errors) == 2
        fields = [e["field"] for e in errors]
        assert "metrics[1].concurrency" in fields
        assert "metrics[2].concurrency" in fields


# ── Tests: non-dict input ─────────────────────────────────────────────────────

class TestNonDictInput:
    """Verify graceful handling of non-dict input."""

    def test_none_input(self):
        errors = validate_benchmark_input(None)
        assert len(errors) == 1
        assert errors[0]["field"] == "_root"

    def test_list_input(self):
        errors = validate_benchmark_input([1, 2, 3])
        assert len(errors) == 1
        assert errors[0]["field"] == "_root"

    def test_string_input(self):
        errors = validate_benchmark_input("not a dict")
        assert len(errors) == 1
        assert errors[0]["field"] == "_root"


# ── Tests: structured error output ───────────────────────────────────────────

class TestStructuredErrorOutput:
    """Verify that emit_validation_error produces correct JSON and exits."""

    def test_emit_produces_json_and_exits(self, capsys):
        errors = [
            {"field": "config_id", "reason": "missing required field"},
            {"field": "metrics", "reason": "must be a non-empty array"},
        ]
        with pytest.raises(SystemExit) as exc_info:
            emit_validation_error(errors)

        assert exc_info.value.code == 1

        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert output["error"] is True
        assert len(output["validation_errors"]) == 2
        assert output["validation_errors"][0]["field"] == "config_id"
        assert output["validation_errors"][1]["field"] == "metrics"


# ── Tests: no crash guarantee ─────────────────────────────────────────────────

class TestNoCrash:
    """Verify that validation never crashes — always returns structured errors."""

    def test_null_fields_dont_crash(self):
        data = {
            "config_id": None,
            "model_name": None,
            "instance_type": None,
            "deployment_config": None,
            "region": None,
            "metrics": None,
        }
        errors = validate_benchmark_input(data)
        # Should produce errors for each field, not crash
        assert len(errors) >= 6

    def test_wrong_types_dont_crash(self):
        data = {
            "config_id": 123,
            "model_name": [],
            "instance_type": {},
            "deployment_config": True,
            "region": 0,
            "metrics": "string",
        }
        errors = validate_benchmark_input(data)
        assert len(errors) >= 5  # At least one error per invalid field
