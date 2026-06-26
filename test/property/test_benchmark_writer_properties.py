"""Property-based tests for benchmark writer module.

Uses Hypothesis to verify that the benchmark writer correctly handles
serialization round-trips, output completeness, and validation rejection
across a wide range of randomly generated inputs.

**Validates: Requirements 2.3, 6.3, 6.4**
"""

import importlib.util
import io
import os
import re
import math

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from datetime import datetime, timezone
from hypothesis import given, settings, assume
from hypothesis import strategies as st


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
_records_to_parquet_table = _benchmark_writer._records_to_parquet_table
validate_benchmark_input = _benchmark_writer.validate_benchmark_input
derive_model_family = _benchmark_writer.derive_model_family
derive_instance_family = _benchmark_writer.derive_instance_family
get_parquet_schema = _benchmark_writer.get_parquet_schema
resolve_instance_metadata = _benchmark_writer.resolve_instance_metadata
REQUIRED_FIELDS = _benchmark_writer.REQUIRED_FIELDS


# ── Hypothesis Strategies ─────────────────────────────────────────────────────

# Known model names that exercise different family derivation paths
_MODEL_NAMES = [
    "Qwen/Qwen3-4B",
    "Qwen/Qwen2.5-7B",
    "meta-llama/Llama-3.1-8B",
    "meta-llama/Llama-3.2-3B",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    "deepseek-ai/DeepSeek-V3-Base",
    "mistralai/Mistral-7B-v0.1",
    "mistralai/Mixtral-8x7B-v0.1",
    "microsoft/Phi-3-mini-4k-instruct",
    "google/gemma-2-9b",
    "tiiuae/falcon-7b",
    "bigcode/starcoder2-15b",
    "org/SomeCustomModel-13B",
]

# Known instance types that exercise pricing lookups
_INSTANCE_TYPES = [
    "ml.g5.xlarge",
    "ml.g5.2xlarge",
    "ml.g5.12xlarge",
    "ml.g5.48xlarge",
    "ml.g6.xlarge",
    "ml.g6.12xlarge",
    "ml.g6e.xlarge",
    "ml.g6e.12xlarge",
    "ml.p4d.24xlarge",
    "ml.p5.48xlarge",
    "ml.trn2.48xlarge",
]

_DEPLOYMENT_CONFIGS = [
    "transformers-vllm",
    "transformers-sglang",
    "transformers-tensorrt-llm",
    "transformers-lmi",
    "http-flask",
    "http-fastapi",
    "triton-python",
]

_DEPLOYMENT_TARGETS = [
    "realtime-inference",
    "async-inference",
    "batch-transform",
    "hyperpod-eks",
]

_REGIONS = [
    "us-east-1",
    "us-west-2",
    "eu-west-1",
    "ap-southeast-1",
]

_QUANTIZATIONS = ["none", "fp16", "fp8", "awq", "gptq", "int8", "int4"]


@st.composite
def valid_metric_entry(draw):
    """Generate a single valid metrics entry with realistic benchmark values."""
    concurrency = draw(st.integers(min_value=1, max_value=128))
    request_throughput = draw(st.floats(min_value=0.1, max_value=500.0, allow_nan=False, allow_infinity=False))
    output_token_throughput = draw(st.floats(min_value=1.0, max_value=5000.0, allow_nan=False, allow_infinity=False))
    total_requests = draw(st.integers(min_value=10, max_value=10000))
    error_count = draw(st.integers(min_value=0, max_value=total_requests))
    duration_seconds = draw(st.integers(min_value=10, max_value=600))
    input_tokens_mean = draw(st.integers(min_value=10, max_value=4096))
    output_tokens_mean = draw(st.integers(min_value=10, max_value=4096))

    ttft_p50 = draw(st.floats(min_value=1.0, max_value=5000.0, allow_nan=False, allow_infinity=False))
    ttft_p99 = draw(st.floats(min_value=ttft_p50, max_value=10000.0, allow_nan=False, allow_infinity=False))
    itl_p50 = draw(st.floats(min_value=0.1, max_value=200.0, allow_nan=False, allow_infinity=False))
    itl_p99 = draw(st.floats(min_value=itl_p50, max_value=500.0, allow_nan=False, allow_infinity=False))

    return {
        "concurrency": concurrency,
        "request_throughput": request_throughput,
        "output_token_throughput": output_token_throughput,
        "time_to_first_token": {"p50": ttft_p50, "p90": (ttft_p50 + ttft_p99) / 2, "p99": ttft_p99},
        "inter_token_latency": {"p50": itl_p50, "p90": (itl_p50 + itl_p99) / 2, "p99": itl_p99},
        "error_count": error_count,
        "total_requests": total_requests,
        "duration_seconds": duration_seconds,
        "input_tokens_mean": input_tokens_mean,
        "output_tokens_mean": output_tokens_mean,
    }


@st.composite
def valid_benchmark_config(draw):
    """Generate a valid config context dict."""
    return {
        "project_name": draw(st.text(alphabet="abcdefghijklmnop0123456789-", min_size=3, max_size=20)),
        "model_name": draw(st.sampled_from(_MODEL_NAMES)),
        "instance_type": draw(st.sampled_from(_INSTANCE_TYPES)),
        "deployment_config": draw(st.sampled_from(_DEPLOYMENT_CONFIGS)),
        "deployment_target": draw(st.sampled_from(_DEPLOYMENT_TARGETS)),
        "tensor_parallel_degree": draw(st.sampled_from([1, 2, 4, 8])),
        "quantization": draw(st.sampled_from(_QUANTIZATIONS)),
        "enable_lora": draw(st.booleans()),
        "max_model_len": draw(st.sampled_from([None, 2048, 4096, 8192, 16384, 32768])),
        "kv_cache_dtype": draw(st.sampled_from([None, "auto", "fp16", "fp8", "int8"])),
        "base_image": draw(st.sampled_from([
            "vllm/vllm-openai:v0.8.5",
            "vllm/vllm-openai:v0.7.3",
            "nvcr.io/nvidia/tritonserver:24.01-py3",
            "sglang/sglang:v0.4.0",
        ])),
        "mcc_version": draw(st.sampled_from(["0.10.0", "0.10.1", "0.11.0", "1.0.0"])),
        "region": draw(st.sampled_from(_REGIONS)),
        "account_id": draw(st.text(alphabet="0123456789", min_size=12, max_size=12)),
        "run_type": draw(st.sampled_from(["ci", "path_prove", "optimization", "manual"])),
        "ci_run_id": draw(st.text(alphabet="abcdefghijklmnop0123456789-", min_size=5, max_size=30)),
    }


@st.composite
def valid_benchmark_results(draw, min_concurrency=1, max_concurrency=20):
    """Generate a valid benchmark results dict with N concurrency levels."""
    n = draw(st.integers(min_value=min_concurrency, max_value=max_concurrency))
    metrics = draw(st.lists(valid_metric_entry(), min_size=n, max_size=n))
    return {
        "job_name": draw(st.text(alphabet="abcdefghijklmnop0123456789-", min_size=5, max_size=40)),
        "metrics": metrics,
    }


@st.composite
def valid_run_timestamp(draw):
    """Generate a valid UTC timestamp in a reasonable range."""
    year = draw(st.integers(min_value=2024, max_value=2030))
    month = draw(st.integers(min_value=1, max_value=12))
    day = draw(st.integers(min_value=1, max_value=28))
    hour = draw(st.integers(min_value=0, max_value=23))
    minute = draw(st.integers(min_value=0, max_value=59))
    second = draw(st.integers(min_value=0, max_value=59))
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


# ── Property P1: Serialization Round-Trip ─────────────────────────────────────


class TestSerializationRoundTrip:
    """Property P1: For any valid benchmark result JSON, serialize to Parquet
    and deserialize produces identical metric values.

    **Validates: Requirements 2.3**
    """

    @settings(max_examples=100, deadline=None)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(),
        timestamp=valid_run_timestamp(),
    )
    def test_numeric_metrics_survive_roundtrip(self, config, results, timestamp):
        """Numeric metric values (ttft_p50_ms, throughput_rps, etc.) are
        identical within float tolerance after Parquet serialize/deserialize."""
        # Enrich
        records = enrich_records(config, results, timestamp)
        assume(len(records) > 0)

        # Serialize to Parquet table
        table = _records_to_parquet_table(records)

        # Write to in-memory buffer and read back
        buf = io.BytesIO()
        pq.write_table(table, buf, compression='snappy')
        buf.seek(0)
        recovered_table = pq.read_table(buf)

        # Verify numeric columns are identical within float tolerance
        numeric_columns = [
            "ttft_p50_ms", "ttft_p99_ms", "itl_p50_ms", "itl_p99_ms",
            "request_throughput_rps", "output_token_throughput_tps", "error_rate",
            "cost_per_1m_tokens",
        ]

        for col_name in numeric_columns:
            original_col = table.column(col_name).to_pylist()
            recovered_col = recovered_table.column(col_name).to_pylist()
            assert len(original_col) == len(recovered_col), f"Length mismatch for {col_name}"
            for i, (orig, recov) in enumerate(zip(original_col, recovered_col)):
                if orig is None and recov is None:
                    continue
                assert orig is not None and recov is not None, (
                    f"{col_name}[{i}]: one is None (orig={orig}, recov={recov})"
                )
                assert math.isclose(orig, recov, rel_tol=1e-9, abs_tol=1e-12), (
                    f"{col_name}[{i}]: {orig} != {recov}"
                )

    @settings(max_examples=100, deadline=None)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(),
        timestamp=valid_run_timestamp(),
    )
    def test_string_values_survive_roundtrip(self, config, results, timestamp):
        """String values (config_id, model_name, etc.) are identical after
        Parquet serialize/deserialize."""
        records = enrich_records(config, results, timestamp)
        assume(len(records) > 0)

        table = _records_to_parquet_table(records)

        buf = io.BytesIO()
        pq.write_table(table, buf, compression='snappy')
        buf.seek(0)
        recovered_table = pq.read_table(buf)

        string_columns = [
            "project_name", "model_name", "model_family", "instance_type",
            "instance_family", "deployment_config", "deployment_target",
            "quantization", "mcc_version",
            "run_type", "benchmark_job_name",
            "kv_cache_dtype", "gpu_type",
        ]

        for col_name in string_columns:
            original_col = table.column(col_name).to_pylist()
            recovered_col = recovered_table.column(col_name).to_pylist()
            assert original_col == recovered_col, (
                f"String column {col_name} mismatch: {original_col} != {recovered_col}"
            )


# ── Property P2: Output Completeness ─────────────────────────────────────────


# Expected columns in enriched records from enrich_records()
_EXPECTED_COLUMNS = [
    "project_name", "model_name", "model_family", "instance_type",
    "instance_family", "deployment_config", "deployment_target",
    "quantization", "tensor_parallel_degree",
    "gpu_count", "gpu_type", "gpu_memory_gb",
    "max_model_len", "enable_lora", "kv_cache_dtype",
    "serving_config", "workload",
    "concurrency", "input_tokens_mean", "output_tokens_mean",
    "streaming", "duration_seconds",
    "request_throughput_rps", "total_token_throughput_tps",
    "output_token_throughput_tps",
    "ttft_p50_ms", "ttft_p99_ms", "itl_p50_ms", "itl_p99_ms",
    "error_rate", "cost_per_1m_tokens",
    "run_type", "benchmark_job_name", "mcc_version",
    "run_timestamp", "region",
]


class TestOutputCompleteness:
    """Property P2: For any valid input with N concurrency levels, writer
    produces exactly N records with all required columns.

    **Validates: Requirements 6.3**
    """

    @settings(max_examples=100)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(min_concurrency=1, max_concurrency=20),
        timestamp=valid_run_timestamp(),
    )
    def test_exactly_n_records_produced(self, config, results, timestamp):
        """For N concurrency levels, enrich_records produces exactly N records."""
        n_concurrency = len(results["metrics"])

        records = enrich_records(config, results, timestamp)

        assert len(records) == n_concurrency, (
            f"Expected {n_concurrency} records, got {len(records)}"
        )

    @settings(max_examples=100)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(),
        timestamp=valid_run_timestamp(),
    )
    def test_all_required_columns_present(self, config, results, timestamp):
        """Each record has all required columns (32 columns from Athena DDL)."""
        records = enrich_records(config, results, timestamp)
        assume(len(records) > 0)

        for i, record in enumerate(records):
            for col in _EXPECTED_COLUMNS:
                assert col in record, (
                    f"Record {i} missing column '{col}'. Keys: {list(record.keys())}"
                )

    @settings(max_examples=100)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(),
        timestamp=valid_run_timestamp(),
    )
    def test_model_family_correctly_derived(self, config, results, timestamp):
        """model_family is correctly derived from model_name."""
        records = enrich_records(config, results, timestamp)
        assume(len(records) > 0)

        expected_family = derive_model_family(config["model_name"])
        for record in records:
            assert record["model_family"] == expected_family, (
                f"Expected model_family '{expected_family}' for model '{config['model_name']}', "
                f"got '{record['model_family']}'"
            )

    @settings(max_examples=100)
    @given(
        config=valid_benchmark_config(),
        results=valid_benchmark_results(),
        timestamp=valid_run_timestamp(),
    )
    def test_instance_family_correctly_derived(self, config, results, timestamp):
        """instance_family is correctly derived from instance_type."""
        records = enrich_records(config, results, timestamp)
        assume(len(records) > 0)

        expected_family = derive_instance_family(config["instance_type"])
        for record in records:
            assert record["instance_family"] == expected_family, (
                f"Expected instance_family '{expected_family}' for "
                f"instance '{config['instance_type']}', got '{record['instance_family']}'"
            )


# ── Property P3: Validation Rejection ─────────────────────────────────────────


@st.composite
def input_missing_required_field(draw):
    """Generate a benchmark input dict with at least one required field
    missing or invalid."""
    # Start with a valid input
    config_id = draw(st.text(alphabet="0123456789abcdef", min_size=16, max_size=16))
    project_name = draw(st.text(alphabet="abcdefghijklmnop0123456789-", min_size=3, max_size=20))
    model_name = draw(st.sampled_from(_MODEL_NAMES))
    instance_type = draw(st.sampled_from(_INSTANCE_TYPES))
    deployment_config = draw(st.sampled_from(_DEPLOYMENT_CONFIGS))
    region = draw(st.sampled_from(_REGIONS))
    metrics = [{"concurrency": 1, "request_throughput": 10.0}]

    data = {
        "config_id": config_id,
        "project_name": project_name,
        "model_name": model_name,
        "instance_type": instance_type,
        "deployment_config": deployment_config,
        "region": region,
        "metrics": metrics,
    }

    # Choose which corruption strategy to apply
    strategy = draw(st.sampled_from([
        "remove_field",
        "empty_string",
        "null_field",
        "wrong_type",
        "invalid_instance_type",
        "empty_metrics",
        "metrics_not_list",
    ]))

    if strategy == "remove_field":
        field_to_remove = draw(st.sampled_from(REQUIRED_FIELDS))
        del data[field_to_remove]
    elif strategy == "empty_string":
        # Only apply to string fields
        string_fields = [f for f in REQUIRED_FIELDS if f != "metrics"]
        field = draw(st.sampled_from(string_fields))
        data[field] = ""
    elif strategy == "null_field":
        field = draw(st.sampled_from(REQUIRED_FIELDS))
        data[field] = None
    elif strategy == "wrong_type":
        string_fields = [f for f in REQUIRED_FIELDS if f != "metrics"]
        field = draw(st.sampled_from(string_fields))
        data[field] = draw(st.sampled_from([123, [], {}, True]))
    elif strategy == "invalid_instance_type":
        # instance_type must match ml.* pattern
        data["instance_type"] = draw(st.sampled_from([
            "g5.xlarge",        # missing ml. prefix
            "ml.invalid",       # missing size
            "",                 # empty
            "not-an-instance",  # completely wrong
        ]))
    elif strategy == "empty_metrics":
        data["metrics"] = []
    elif strategy == "metrics_not_list":
        data["metrics"] = draw(st.sampled_from(["string", 42, {}, True]))

    return data


class TestValidationRejection:
    """Property P3: For any input missing required fields, writer rejects
    without crash or S3 write.

    **Validates: Requirements 6.4**
    """

    @settings(max_examples=100)
    @given(data=input_missing_required_field())
    def test_invalid_input_returns_non_empty_errors(self, data):
        """validate_benchmark_input returns non-empty error list for invalid input."""
        errors = validate_benchmark_input(data)
        assert len(errors) > 0, (
            f"Expected validation errors for input: {data}, got empty list"
        )

    @settings(max_examples=100)
    @given(data=input_missing_required_field())
    def test_invalid_input_does_not_crash(self, data):
        """validate_benchmark_input never raises an exception for any input."""
        # This should complete without any exception
        try:
            errors = validate_benchmark_input(data)
        except SystemExit:
            pytest.fail("validate_benchmark_input should not call sys.exit")
        except Exception as e:
            pytest.fail(f"validate_benchmark_input raised unexpected exception: {e}")

    @settings(max_examples=100)
    @given(data=input_missing_required_field())
    def test_error_includes_field_name_and_reason(self, data):
        """Each validation error includes 'field' and 'reason' keys."""
        errors = validate_benchmark_input(data)
        assume(len(errors) > 0)

        for error in errors:
            assert "field" in error, f"Error missing 'field' key: {error}"
            assert "reason" in error, f"Error missing 'reason' key: {error}"
            assert isinstance(error["field"], str), f"'field' not a string: {error}"
            assert isinstance(error["reason"], str), f"'reason' not a string: {error}"
            assert len(error["field"]) > 0, f"'field' is empty: {error}"
            assert len(error["reason"]) > 0, f"'reason' is empty: {error}"
