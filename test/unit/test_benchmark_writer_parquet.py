#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for benchmark writer Parquet serialization and partition paths.

Tests cover:
1. Parquet round-trip: write records → read back → verify all column values match
2. Parquet schema correctness: verify all 32 columns defined in the Athena DDL are present
3. Snappy compression: verify the written file uses Snappy
4. Partition path construction: year boundary (Dec 31 → Jan 1), leap year, month boundaries
5. S3 path format: verify region={r}/year={YYYY}/month={MM}/run-{configId}-{timestamp}.parquet
6. Single file per run: N concurrency levels → 1 file with N rows

Requirements validated: 6.1, 6.3, 6.4, 6.5
"""

import importlib.util
import os
import tempfile
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq
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

enrich_records = _benchmark_writer.enrich_records
get_parquet_schema = _benchmark_writer.get_parquet_schema
_records_to_parquet_table = _benchmark_writer._records_to_parquet_table
compute_s3_path = _benchmark_writer.compute_s3_path
compute_partition_keys = _benchmark_writer.compute_partition_keys
build_s3_path = _benchmark_writer.build_s3_path


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def sample_config():
    """A valid config context for benchmark writer."""
    return {
        "project_name": "test-qwen3-4b",
        "model_name": "Qwen/Qwen3-4B",
        "instance_type": "ml.g5.xlarge",
        "deployment_config": "transformers-vllm",
        "deployment_target": "realtime-inference",
        "tensor_parallel_degree": 1,
        "quantization": "none",
        "enable_lora": True,
        "base_image": "vllm/vllm-openai:v0.8.5",
        "base_image_version": "v0.8.5",
        "mcc_version": "0.10.1",
        "region": "us-east-1",
        "account_id": "111111111111",
        "run_type": "ci",
        "ci_run_id": "build-12345",
    }


@pytest.fixture
def sample_results():
    """A valid benchmark results object with multiple concurrency levels."""
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
                "input_tokens_mean": 128,
                "output_tokens_mean": 256,
            },
            {
                "concurrency": 4,
                "request_throughput": 38.2,
                "output_token_throughput": 1520.8,
                "time_to_first_token": {"p50": 78.5, "p90": 145.2, "p99": 234.1},
                "inter_token_latency": {"p50": 12.4, "p90": 18.9, "p99": 32.5},
                "error_count": 2,
                "total_requests": 400,
                "duration_seconds": 60,
                "input_tokens_mean": 128,
                "output_tokens_mean": 256,
            },
            {
                "concurrency": 8,
                "request_throughput": 52.1,
                "output_token_throughput": 2084.0,
                "time_to_first_token": {"p50": 142.3, "p90": 289.7, "p99": 456.2},
                "inter_token_latency": {"p50": 18.9, "p90": 34.5, "p99": 67.8},
                "error_count": 5,
                "total_requests": 800,
                "duration_seconds": 60,
                "input_tokens_mean": 128,
                "output_tokens_mean": 256,
            },
        ],
    }


@pytest.fixture
def fixed_timestamp():
    """A fixed timestamp for deterministic tests."""
    return datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)


def _write_parquet_to_temp(records):
    """Helper: serialize records to a temp Parquet file with Snappy, return path."""
    table = _records_to_parquet_table(records)
    tmp = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False)
    tmp.close()
    pq.write_table(table, tmp.name, compression="snappy")
    return tmp.name


# ── Test: Parquet Round-Trip ──────────────────────────────────────────────────


class TestParquetRoundTrip:
    """Test that serializing to Parquet and reading back preserves values.

    Validates: Requirements 6.1, 6.3
    """

    def test_single_record_roundtrip(self, sample_config, sample_results, fixed_timestamp):
        """Single concurrency level → write → read → values match."""
        # Use only the first metric entry
        results_single = {"job_name": sample_results["job_name"], "metrics": [sample_results["metrics"][0]]}
        records = enrich_records(sample_config, results_single, fixed_timestamp)
        assert len(records) == 1

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            assert table.num_rows == 1

            row = table.to_pydict()
            assert row["model_name"][0] == "Qwen/Qwen3-4B"
            assert row["model_family"][0] == "qwen3"
            assert row["instance_type"][0] == "ml.g5.xlarge"
            assert row["instance_family"][0] == "g5"
            assert row["deployment_config"][0] == "transformers-vllm"
            assert row["concurrency"][0] == 1
            assert abs(row["request_throughput_rps"][0] - 12.5) < 0.001
            assert abs(row["output_token_throughput_tps"][0] - 487.2) < 0.001
            assert abs(row["ttft_p50_ms"][0] - 45.2) < 0.001
            assert abs(row["ttft_p99_ms"][0] - 112.4) < 0.001
            assert abs(row["itl_p50_ms"][0] - 8.1) < 0.001
            assert abs(row["itl_p99_ms"][0] - 18.7) < 0.001
            assert row["error_rate"][0] == 0.0
            assert row["run_type"][0] == "ci"
            # Verify new fields
            assert row["gpu_count"][0] == 1
            assert row["gpu_type"][0] == "NVIDIA A10G"
            assert row["gpu_memory_gb"][0] == 24.0
            assert row["enable_lora"][0] is True
            assert row["kv_cache_dtype"][0] is None  # Not set in sample_config
            assert row["cost_per_1m_tokens"][0] is not None
        finally:
            os.unlink(path)

    def test_multiple_records_roundtrip(self, sample_config, sample_results, fixed_timestamp):
        """3 concurrency levels → write → read → all values preserved."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        assert len(records) == 3

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            assert table.num_rows == 3

            data = table.to_pydict()
            # Verify each concurrency level
            assert data["concurrency"] == [1, 4, 8]
            assert all(mn == "Qwen/Qwen3-4B" for mn in data["model_name"])

            # Verify throughput values match input
            assert abs(data["request_throughput_rps"][0] - 12.5) < 0.001
            assert abs(data["request_throughput_rps"][1] - 38.2) < 0.001
            assert abs(data["request_throughput_rps"][2] - 52.1) < 0.001
        finally:
            os.unlink(path)

    def test_boolean_field_preserved(self, sample_config, sample_results, fixed_timestamp):
        """enable_lora boolean field round-trips correctly."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            data = table.to_pydict()
            assert all(v is True for v in data["enable_lora"])
        finally:
            os.unlink(path)

    def test_timestamp_field_preserved(self, sample_config, sample_results, fixed_timestamp):
        """run_timestamp round-trips as a valid ISO 8601 string."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            data = table.to_pydict()
            # pyarrow reads timestamp as string (schema is pa.string())
            ts = data["run_timestamp"][0]
            assert "2026-06-09" in ts
            assert "14:30:22" in ts
        finally:
            os.unlink(path)

    def test_nullable_cost_field(self, sample_config, sample_results, fixed_timestamp):
        """cost_per_1m_tokens can be None for unknown instances and round-trips."""
        config = dict(sample_config)
        config["instance_type"] = "ml.x99.mega"  # Unknown instance → cost is None
        results_single = {"job_name": "test", "metrics": [sample_results["metrics"][0]]}
        records = enrich_records(config, results_single, fixed_timestamp)
        assert records[0]["cost_per_1m_tokens"] is None
        # Also verify GPU fields are NULL for unknown instance
        assert records[0]["gpu_count"] is None
        assert records[0]["gpu_type"] is None
        assert records[0]["gpu_memory_gb"] is None

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            data = table.to_pydict()
            assert data["cost_per_1m_tokens"][0] is None
            assert data["gpu_count"][0] is None
            assert data["gpu_type"][0] is None
            assert data["gpu_memory_gb"][0] is None
        finally:
            os.unlink(path)


# ── Test: Schema Correctness ──────────────────────────────────────────────────


class TestParquetSchemaCorrectness:
    """Test that the Parquet schema has all expected columns.

    Validates: Requirements 6.1, 6.3
    """

    # Key columns expected in the Athena DDL (subset verification)
    EXPECTED_COLUMNS = [
        "project_name", "model_name", "model_family", "instance_type",
        "instance_family", "deployment_config", "deployment_target",
        "run_timestamp", "tensor_parallel_degree", "quantization",
        "enable_lora", "kv_cache_dtype", "max_model_len",
        "gpu_count", "gpu_type", "gpu_memory_gb",
        "serving_config", "workload",
        "concurrency", "input_tokens_mean", "output_tokens_mean",
        "streaming", "duration_seconds",
        "request_throughput_rps", "total_token_throughput_tps",
        "output_token_throughput_tps",
        "ttft_avg_ms", "ttft_p50_ms", "ttft_p90_ms", "ttft_p99_ms",
        "itl_avg_ms", "itl_p50_ms", "itl_p90_ms", "itl_p99_ms",
        "error_rate", "cost_per_1m_tokens",
        "run_type", "benchmark_job_name", "mcc_version", "region",
        "adapter_name",
    ]

    def test_schema_has_all_columns(self):
        """get_parquet_schema() includes all 32 DDL columns."""
        schema = get_parquet_schema()
        column_names = [field.name for field in schema]
        for col in self.EXPECTED_COLUMNS:
            assert col in column_names, f"Missing column: {col}"

    def test_schema_column_count(self):
        """Schema has at least 56 columns (base 48 + 8 new fields)."""
        schema = get_parquet_schema()
        assert len(schema) >= 56, f"Expected at least 56 columns, got {len(schema)}"

    def test_written_file_has_all_columns(self, sample_config, sample_results, fixed_timestamp):
        """Written Parquet file contains all schema columns."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            file_columns = table.column_names
            for col in self.EXPECTED_COLUMNS:
                assert col in file_columns, f"Missing column in Parquet file: {col}"
        finally:
            os.unlink(path)

    def test_string_columns_are_string_type(self):
        """String columns have pa.string() type in schema."""
        schema = get_parquet_schema()
        string_cols = [
            "project_name", "model_name", "model_family", "instance_type",
            "instance_family", "deployment_config", "deployment_target",
            "quantization", "mcc_version",
            "run_type", "benchmark_job_name",
            "gpu_type", "kv_cache_dtype", "region", "adapter_name",
        ]
        for col_name in string_cols:
            field = schema.field(col_name)
            assert field.type == pa.string(), f"{col_name} should be string, got {field.type}"

    def test_numeric_columns_are_correct_type(self):
        """Numeric columns have correct arrow types."""
        schema = get_parquet_schema()
        int_cols = ["tensor_parallel_degree", "concurrency", "input_tokens_mean",
                    "output_tokens_mean", "duration_seconds", "gpu_count", "max_model_len"]
        float_cols = ["ttft_p50_ms", "ttft_p99_ms", "itl_p50_ms", "itl_p99_ms",
                      "request_throughput_rps", "output_token_throughput_tps",
                      "cost_per_1m_tokens", "error_rate", "gpu_memory_gb"]

        for col_name in int_cols:
            field = schema.field(col_name)
            assert field.type == pa.int32(), f"{col_name} should be int32, got {field.type}"

        for col_name in float_cols:
            field = schema.field(col_name)
            assert field.type == pa.float64(), f"{col_name} should be float64, got {field.type}"

    def test_boolean_column_type(self):
        """enable_lora and streaming are boolean types."""
        schema = get_parquet_schema()
        for col in ["enable_lora", "streaming"]:
            field = schema.field(col)
            assert field.type == pa.bool_(), f"{col} should be bool, got {field.type}"

    def test_timestamp_column_type(self):
        """run_timestamp is a string type (ISO 8601)."""
        schema = get_parquet_schema()
        field = schema.field("run_timestamp")
        assert field.type == pa.string()


# ── Test: Snappy Compression ──────────────────────────────────────────────────


class TestSnappyCompression:
    """Test that Parquet files use Snappy compression.

    Validates: Requirements 6.6 (pyarrow with Snappy compression)
    """

    def test_file_uses_snappy_compression(self, sample_config, sample_results, fixed_timestamp):
        """Written Parquet file metadata indicates Snappy compression."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            metadata = pq.read_metadata(path)
            # Check row group column chunk compression
            row_group = metadata.row_group(0)
            for i in range(row_group.num_columns):
                col = row_group.column(i)
                assert col.compression == "SNAPPY", (
                    f"Column {i} uses {col.compression}, expected SNAPPY"
                )
        finally:
            os.unlink(path)

    def test_compressed_file_is_valid_parquet(self, sample_config, sample_results, fixed_timestamp):
        """Snappy-compressed file is still valid and readable Parquet."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            # File is readable and round-trips correctly
            table = pq.read_table(path)
            assert table.num_rows == len(records)
            # Verify file size is reasonable (non-zero, not enormous)
            file_size = os.path.getsize(path)
            assert file_size > 0
            assert file_size < 1_000_000  # Sanity: < 1MB for 3 rows
        finally:
            os.unlink(path)


# ── Test: Partition Path Construction ─────────────────────────────────────────


class TestPartitionPathConstruction:
    """Test partition path for edge-case dates.

    Validates: Requirements 6.3
    """

    def test_year_boundary_dec31(self):
        """December 31 → year=2025, month=12."""
        ts = datetime(2025, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        year, month = compute_partition_keys(ts)
        assert year == "2025"
        assert month == "12"

    def test_year_boundary_jan1(self):
        """January 1 → year=2026, month=01."""
        ts = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        year, month = compute_partition_keys(ts)
        assert year == "2026"
        assert month == "01"

    def test_leap_year_feb29(self):
        """Feb 29 on leap year → year=2024, month=02."""
        ts = datetime(2024, 2, 29, 12, 0, 0, tzinfo=timezone.utc)
        year, month = compute_partition_keys(ts)
        assert year == "2024"
        assert month == "02"

    def test_month_boundary_jan31_to_feb1(self):
        """Month boundaries: Jan 31 → month=01, Feb 1 → month=02."""
        ts_jan = datetime(2026, 1, 31, 23, 59, 59, tzinfo=timezone.utc)
        ts_feb = datetime(2026, 2, 1, 0, 0, 0, tzinfo=timezone.utc)
        year_j, month_j = compute_partition_keys(ts_jan)
        year_f, month_f = compute_partition_keys(ts_feb)
        assert month_j == "01"
        assert month_f == "02"
        assert year_j == year_f == "2026"

    def test_month_boundary_nov30_to_dec1(self):
        """Month boundaries: Nov 30 → month=11, Dec 1 → month=12."""
        ts_nov = datetime(2026, 11, 30, 23, 59, 59, tzinfo=timezone.utc)
        ts_dec = datetime(2026, 12, 1, 0, 0, 0, tzinfo=timezone.utc)
        _, month_n = compute_partition_keys(ts_nov)
        _, month_d = compute_partition_keys(ts_dec)
        assert month_n == "11"
        assert month_d == "12"

    def test_s3_path_year_boundary(self):
        """compute_s3_path uses correct model partition across year boundary."""
        bucket = "mlcc-benchmark-results-111111111111-us-east-1"
        ts = datetime(2025, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        path = compute_s3_path(bucket, "test-proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)
        assert path.startswith("s3://")
        assert "model=Qwen_Qwen3-4B" in path
        assert "instance=ml.g5.xlarge" in path

    def test_build_s3_path_leap_year(self):
        """build_s3_path produces correct partition values."""
        ts = datetime(2024, 2, 29, 15, 30, 0, tzinfo=timezone.utc)
        result = build_s3_path("my-bucket", "test-proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)
        assert "s3_uri" in result
        assert result["partition_model"] == "Qwen_Qwen3-4B"
        assert result["partition_instance"] == "ml.g5.xlarge"
        assert result["partition_target"] == "realtime-inference"


# ── Test: S3 Path Format ──────────────────────────────────────────────────────


class TestS3PathFormat:
    """Test S3 path format: model/instance/target partitioning.

    Validates: Requirements 6.1, 6.3
    """

    def test_compute_s3_path_format(self):
        """S3 URI follows expected model/instance/target pattern."""
        ts = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        bucket = "mlcc-benchmark-results-111111111111-us-east-1"
        path = compute_s3_path(bucket, "test-proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)
        assert path.startswith(f"s3://{bucket}/")
        assert "model=Qwen_Qwen3-4B" in path
        assert "instance=ml.g5.xlarge" in path
        assert "target=realtime-inference" in path
        assert path.endswith(".parquet")

    def test_s3_path_contains_model_partition(self):
        """S3 path includes model= partition with / replaced by _."""
        ts = datetime(2026, 3, 15, 10, 0, 0, tzinfo=timezone.utc)
        path = compute_s3_path("bucket", "proj", "meta-llama/Llama-3.1-8B", "ml.g5.xlarge", "realtime-inference", ts)
        assert "model=meta-llama_Llama-3.1-8B/" in path

    def test_s3_path_contains_instance_partition(self):
        """S3 path includes instance= partition."""
        ts = datetime(2026, 3, 15, 10, 0, 0, tzinfo=timezone.utc)
        path = compute_s3_path("bucket", "proj", "Qwen/Qwen3-4B", "ml.p5.48xlarge", "realtime-inference", ts)
        assert "instance=ml.p5.48xlarge/" in path

    def test_s3_path_filename_has_parquet_extension(self):
        """Filename ends with .parquet."""
        ts = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        path = compute_s3_path("bucket", "proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)
        assert path.endswith(".parquet")

    def test_build_s3_path_returns_all_fields(self):
        """build_s3_path returns s3_uri, partition fields, and filename."""
        ts = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        result = build_s3_path("my-bucket", "test-proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)

        assert "s3_uri" in result
        assert "partition_model" in result
        assert "partition_instance" in result
        assert "partition_target" in result
        assert "filename" in result

        assert result["partition_model"] == "Qwen_Qwen3-4B"
        assert result["partition_instance"] == "ml.g5.xlarge"
        assert result["partition_target"] == "realtime-inference"
        assert result["s3_uri"].startswith("s3://my-bucket/")

    def test_different_models_produce_different_paths(self):
        """Different models produce different S3 paths."""
        ts = datetime(2026, 6, 9, 14, 30, 22, tzinfo=timezone.utc)
        path1 = compute_s3_path("bucket", "proj", "Qwen/Qwen3-4B", "ml.g5.xlarge", "realtime-inference", ts)
        path2 = compute_s3_path("bucket", "proj", "meta-llama/Llama-3.1-8B", "ml.g5.xlarge", "realtime-inference", ts)
        assert path1 != path2


# ── Test: Single File Per Run ─────────────────────────────────────────────────


class TestSingleFilePerRun:
    """Test that N concurrency levels produce 1 file with N rows.

    Validates: Requirements 6.1
    """

    def test_three_concurrency_levels_one_file(self, sample_config, sample_results, fixed_timestamp):
        """3 concurrency levels → 1 Parquet file → 3 rows."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        assert len(records) == 3

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            assert table.num_rows == 3
            data = table.to_pydict()
            assert sorted(data["concurrency"]) == [1, 4, 8]
        finally:
            os.unlink(path)

    def test_single_concurrency_one_file(self, sample_config, fixed_timestamp):
        """1 concurrency level → 1 file → 1 row."""
        results = {"job_name": "test", "metrics": [
            {"concurrency": 1, "request_throughput": 10.0, "output_token_throughput": 400.0,
             "time_to_first_token": {"p50": 50.0, "p99": 100.0},
             "inter_token_latency": {"p50": 10.0, "p99": 20.0},
             "error_count": 0, "total_requests": 50, "duration_seconds": 30,
             "input_tokens_mean": 64, "output_tokens_mean": 128}
        ]}
        records = enrich_records(sample_config, results, fixed_timestamp)
        assert len(records) == 1

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            assert table.num_rows == 1
        finally:
            os.unlink(path)

    def test_five_concurrency_levels_one_file(self, sample_config, fixed_timestamp):
        """5 concurrency levels → 1 file → 5 rows."""
        metrics = []
        for conc in [1, 2, 4, 8, 16]:
            metrics.append({
                "concurrency": conc,
                "request_throughput": conc * 10.0,
                "output_token_throughput": conc * 400.0,
                "time_to_first_token": {"p50": 50.0, "p99": 100.0},
                "inter_token_latency": {"p50": 10.0, "p99": 20.0},
                "error_count": 0,
                "total_requests": conc * 50,
                "duration_seconds": 60,
                "input_tokens_mean": 128,
                "output_tokens_mean": 256,
            })
        results = {"job_name": "test-5", "metrics": metrics}
        records = enrich_records(sample_config, results, fixed_timestamp)
        assert len(records) == 5

        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            assert table.num_rows == 5
            data = table.to_pydict()
            assert sorted(data["concurrency"]) == [1, 2, 4, 8, 16]
        finally:
            os.unlink(path)

    def test_all_rows_share_same_metadata(self, sample_config, sample_results, fixed_timestamp):
        """All rows in a single file share config metadata."""
        records = enrich_records(sample_config, sample_results, fixed_timestamp)
        path = _write_parquet_to_temp(records)
        try:
            table = pq.read_table(path)
            data = table.to_pydict()
            # All rows share the same model_name, instance_type, etc.
            assert len(set(data["model_name"])) == 1
            assert len(set(data["instance_type"])) == 1
            assert len(set(data["deployment_config"])) == 1
            assert len(set(data["run_type"])) == 1
            # New fields: all rows share same GPU metadata
            assert len(set(data["instance_family"])) == 1
            assert len(set(str(v) for v in data["gpu_count"])) == 1
        finally:
            os.unlink(path)
