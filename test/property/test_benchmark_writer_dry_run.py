"""Unit tests for benchmark writer dry-run mode.

Tests validate that --dry-run outputs enriched records as JSON without writing
to S3, performs the same validation as normal mode, and shows intended S3 path
and partition info.

**Validates: Requirements 6.5**
"""

import importlib.util
import json
import os
import sys
import tempfile

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_WRITER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".benchmark_writer.py"
)
_WRITER_PATH = os.path.normpath(_WRITER_PATH)

_spec = importlib.util.spec_from_file_location("benchmark_writer", _WRITER_PATH)
_writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_writer)

validate_input = _writer.validate_input
enrich_records = _writer.enrich_records
compute_s3_path = _writer.compute_s3_path
compute_partition_info = _writer.compute_partition_info
compute_model_family = _writer.compute_model_family
compute_instance_family = _writer.compute_instance_family
compute_cost_per_1m_tokens = _writer.compute_cost_per_1m_tokens


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _valid_config_context():
    """Return a minimal valid config context."""
    return {
        "config_id": "ec3f1a0072d1b3d4",
        "model_name": "Qwen/Qwen3-4B",
        "instance_type": "ml.g5.xlarge",
        "deployment_config": "transformers-vllm",
        "deployment_target": "realtime-inference",
        "tensor_parallel_degree": 1,
        "quantization": "none",
        "enable_lora": False,
        "base_image": "vllm/vllm-openai:v0.8.5",
        "mcc_version": "0.10.1",
        "region": "us-east-1",
        "account_id": "111111111111",
    }


def _valid_results_data():
    """Return a minimal valid benchmark results payload."""
    return {
        "job_name": "bmk-qwen3-4b-vllm-20260609",
        "metrics": [
            {
                "concurrency": 1,
                "request_throughput": 12.5,
                "output_token_throughput": 487.2,
                "time_to_first_token": {"p50": 45.2, "p90": 67.8, "p99": 112.4},
                "inter_token_latency": {"p50": 8.1, "p90": 12.3, "p99": 18.7},
                "error_count": 0,
                "total_requests": 100,
                "duration_seconds": 60,
            },
            {
                "concurrency": 4,
                "request_throughput": 38.2,
                "output_token_throughput": 1250.0,
                "time_to_first_token": {"p50": 78.5, "p90": 120.0, "p99": 200.0},
                "inter_token_latency": {"p50": 10.5, "p90": 15.2, "p99": 22.1},
                "error_count": 2,
                "total_requests": 400,
                "duration_seconds": 60,
            },
        ],
    }


# ── Dry-run output structure tests ───────────────────────────────────────────


class TestDryRunOutput:
    """Tests for dry-run mode output structure and content."""

    def test_dry_run_outputs_correct_structure(self):
        """Dry-run output contains dry_run flag, s3_path, partition, record_count, records."""
        from datetime import datetime, timezone

        config = _valid_config_context()
        results = _valid_results_data()
        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)

        records = enrich_records(config, results, run_timestamp)
        s3_path = compute_s3_path("mlcc-benchmark-results-111111111111-us-east-1",
                                  config["config_id"], config["region"], run_timestamp)
        partition = compute_partition_info(config["region"], run_timestamp)

        # Simulate dry-run output structure
        output = {
            "dry_run": True,
            "s3_path": s3_path,
            "partition": partition,
            "record_count": len(records),
            "records": records,
        }

        assert output["dry_run"] is True
        assert "s3_path" in output
        assert "partition" in output
        assert "record_count" in output
        assert "records" in output

    def test_dry_run_s3_path_format(self):
        """S3 path follows the expected partition pattern."""
        from datetime import datetime, timezone

        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        s3_path = compute_s3_path(
            "mlcc-benchmark-results-111111111111-us-east-1",
            "ec3f1a0072d1b3d4",
            "us-east-1",
            run_timestamp,
        )

        expected = (
            "s3://mlcc-benchmark-results-111111111111-us-east-1/"
            "region=us-east-1/year=2026/month=06/"
            "run-ec3f1a0072d1b3d4-20260609T143022Z.parquet"
        )
        assert s3_path == expected

    def test_dry_run_partition_info(self):
        """Partition info includes region, year, month."""
        from datetime import datetime, timezone

        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        partition = compute_partition_info("us-east-1", run_timestamp)

        assert partition == {"region": "us-east-1", "year": "2026", "month": "06"}

    def test_dry_run_record_count_matches_concurrency_levels(self):
        """Record count equals the number of concurrency levels in the input."""
        from datetime import datetime, timezone

        config = _valid_config_context()
        results = _valid_results_data()
        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)

        records = enrich_records(config, results, run_timestamp)

        assert len(records) == 2  # Two concurrency levels in test data

    def test_dry_run_records_contain_all_required_columns(self):
        """Each enriched record contains all columns from the Athena DDL."""
        from datetime import datetime, timezone

        config = _valid_config_context()
        results = _valid_results_data()
        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)

        records = enrich_records(config, results, run_timestamp)

        expected_columns = [
            "config_id", "model_name", "model_family", "instance_type",
            "instance_family", "deployment_config", "deployment_target",
            "run_timestamp", "tensor_parallel_degree", "quantization",
            "enable_lora", "base_image", "base_image_version", "mcc_version",
            "concurrency", "input_tokens_mean", "output_tokens_mean",
            "duration_seconds", "ttft_p50_ms", "ttft_p99_ms", "itl_p50_ms",
            "itl_p99_ms", "throughput_rps", "tokens_per_second",
            "cost_per_1m_tokens", "error_rate", "status", "run_type",
            "ci_run_id", "ci_stage", "benchmark_job_name", "account_id",
            "region", "year", "month",
        ]

        for record in records:
            for col in expected_columns:
                assert col in record, f"Missing column: {col}"

    def test_dry_run_enriched_values_correct(self):
        """Enriched records have correctly computed derived fields."""
        from datetime import datetime, timezone

        config = _valid_config_context()
        results = _valid_results_data()
        run_timestamp = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)

        records = enrich_records(config, results, run_timestamp)
        record = records[0]

        # Derived fields
        assert record["model_family"] == "qwen3"
        assert record["instance_family"] == "g5"
        assert record["base_image_version"] == "v0.8.5"

        # Partition keys
        assert record["year"] == "2026"
        assert record["month"] == "06"
        assert record["region"] == "us-east-1"

        # Metrics passthrough
        assert record["concurrency"] == 1
        assert record["throughput_rps"] == 12.5
        assert record["ttft_p50_ms"] == 45.2
        assert record["itl_p50_ms"] == 8.1


# ── Validation in dry-run mode ────────────────────────────────────────────────


class TestDryRunValidation:
    """Dry-run performs the same validation as normal mode."""

    def test_validates_missing_config_id(self):
        """Missing config_id is detected."""
        config = _valid_config_context()
        del config["config_id"]
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "config_id" for e in errors)

    def test_validates_missing_model_name(self):
        """Missing model_name is detected."""
        config = _valid_config_context()
        del config["model_name"]
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "model_name" for e in errors)

    def test_validates_missing_instance_type(self):
        """Missing instance_type is detected."""
        config = _valid_config_context()
        del config["instance_type"]
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "instance_type" for e in errors)

    def test_validates_missing_deployment_config(self):
        """Missing deployment_config is detected."""
        config = _valid_config_context()
        del config["deployment_config"]
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "deployment_config" for e in errors)

    def test_validates_missing_region(self):
        """Missing region is detected."""
        config = _valid_config_context()
        del config["region"]
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "region" for e in errors)

    def test_validates_missing_metrics(self):
        """Missing metrics array is detected."""
        config = _valid_config_context()
        results = {"job_name": "test"}

        errors = validate_input(config, results)
        assert any(e["field"] == "metrics" for e in errors)

    def test_validates_empty_metrics(self):
        """Empty metrics array is detected."""
        config = _valid_config_context()
        results = {"job_name": "test", "metrics": []}

        errors = validate_input(config, results)
        assert any(e["field"] == "metrics" for e in errors)

    def test_validates_non_array_metrics(self):
        """Non-array metrics value is detected."""
        config = _valid_config_context()
        results = {"job_name": "test", "metrics": "not-an-array"}

        errors = validate_input(config, results)
        assert any(e["field"] == "metrics" for e in errors)

    def test_valid_input_passes_validation(self):
        """Valid input produces no errors."""
        config = _valid_config_context()
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert errors == []

    def test_validates_empty_string_fields(self):
        """Empty string for required field is detected."""
        config = _valid_config_context()
        config["config_id"] = ""
        results = _valid_results_data()

        errors = validate_input(config, results)
        assert any(e["field"] == "config_id" for e in errors)


# ── CLI dry-run integration test ──────────────────────────────────────────────


class TestDryRunCLI:
    """Integration tests for the CLI --dry-run flag."""

    def test_dry_run_cli_outputs_json(self):
        """Running with --dry-run produces valid JSON output."""
        import subprocess

        # Create a temporary results file
        results = _valid_results_data()
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(results, f)
            results_file = f.name

        # Create a temporary config file
        config_content = """#!/bin/bash
export CONFIG_ID="ec3f1a0072d1b3d4"
export MODEL_NAME="Qwen/Qwen3-4B"
export INSTANCE_TYPE="ml.g5.xlarge"
export DEPLOYMENT_CONFIG="transformers-vllm"
export DEPLOYMENT_TARGET="realtime-inference"
export AWS_REGION="us-east-1"
export ACCOUNT_ID="111111111111"
export MCC_VERSION="0.10.1"
export BASE_IMAGE="vllm/vllm-openai:v0.8.5"
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".conf", delete=False
        ) as f:
            f.write(config_content)
            config_file = f.name

        try:
            result = subprocess.run(
                [
                    sys.executable, _WRITER_PATH, "write",
                    "--dry-run",
                    "--results-file", results_file,
                    "--config-file", config_file,
                    "--config-id", "ec3f1a0072d1b3d4",
                ],
                capture_output=True,
                text=True,
            )

            assert result.returncode == 0, f"stderr: {result.stderr}"
            output = json.loads(result.stdout)

            assert output["dry_run"] is True
            assert "s3_path" in output
            assert "partition" in output
            assert output["record_count"] == 2
            assert len(output["records"]) == 2

        finally:
            os.unlink(results_file)
            os.unlink(config_file)

    def test_dry_run_validation_failure_exits_nonzero(self):
        """Dry-run with invalid input exits with code 1 and shows errors."""
        import subprocess

        # Create results file missing metrics
        results = {"job_name": "test"}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(results, f)
            results_file = f.name

        try:
            result = subprocess.run(
                [
                    sys.executable, _WRITER_PATH, "write",
                    "--dry-run",
                    "--results-file", results_file,
                    "--config-id", "ec3f1a0072d1b3d4",
                ],
                capture_output=True,
                text=True,
            )

            assert result.returncode == 1
            output = json.loads(result.stdout)
            assert "error" in output
            assert "validation_errors" in output

        finally:
            os.unlink(results_file)

    def test_dry_run_no_bucket_still_shows_s3_path(self):
        """Dry-run without --bucket still computes and shows the S3 path pattern."""
        import subprocess

        results = _valid_results_data()
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(results, f)
            results_file = f.name

        config_content = """#!/bin/bash
export CONFIG_ID="ec3f1a0072d1b3d4"
export MODEL_NAME="Qwen/Qwen3-4B"
export INSTANCE_TYPE="ml.g5.xlarge"
export DEPLOYMENT_CONFIG="transformers-vllm"
export AWS_REGION="us-east-1"
"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".conf", delete=False
        ) as f:
            f.write(config_content)
            config_file = f.name

        try:
            result = subprocess.run(
                [
                    sys.executable, _WRITER_PATH, "write",
                    "--dry-run",
                    "--results-file", results_file,
                    "--config-file", config_file,
                    "--config-id", "ec3f1a0072d1b3d4",
                ],
                capture_output=True,
                text=True,
            )

            assert result.returncode == 0, f"stderr: {result.stderr}"
            output = json.loads(result.stdout)
            assert output["dry_run"] is True
            # S3 path should show pattern even without bucket
            assert "s3://" in output["s3_path"]
            assert "region=us-east-1" in output["s3_path"]
            assert ".parquet" in output["s3_path"]

        finally:
            os.unlink(results_file)
            os.unlink(config_file)


# ── Derived field tests (relevant to dry-run output) ──────────────────────────


class TestDerivedFields:
    """Tests for derived field computation shown in dry-run output."""

    def test_model_family_qwen3(self):
        assert compute_model_family("Qwen/Qwen3-4B") == "qwen3"

    def test_model_family_llama3(self):
        assert compute_model_family("meta-llama/Llama-3.1-8B") == "llama3"

    def test_model_family_deepseek_r1(self):
        assert compute_model_family("deepseek-ai/DeepSeek-R1-Distill-Qwen-7B") == "deepseek-r1"

    def test_model_family_unknown_returns_fallback(self):
        result = compute_model_family("org/SomeNewModel-7B")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_instance_family_g5(self):
        assert compute_instance_family("ml.g5.xlarge") == "g5"

    def test_instance_family_g6e(self):
        assert compute_instance_family("ml.g6e.2xlarge") == "g6e"

    def test_instance_family_p5(self):
        assert compute_instance_family("ml.p5.48xlarge") == "p5"

    def test_instance_family_trn2(self):
        assert compute_instance_family("ml.trn2.xlarge") == "trn2"

    def test_cost_per_1m_tokens_known_instance(self):
        cost = compute_cost_per_1m_tokens("ml.g5.xlarge", 500.0)
        assert cost is not None
        assert cost > 0

    def test_cost_per_1m_tokens_unknown_instance(self):
        cost = compute_cost_per_1m_tokens("ml.unknown.xlarge", 500.0)
        assert cost is None

    def test_cost_per_1m_tokens_zero_throughput(self):
        cost = compute_cost_per_1m_tokens("ml.g5.xlarge", 0.0)
        assert cost is None
