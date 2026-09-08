# SPDX-License-Identifier: Apache-2.0

"""Unit tests for .benchmark_writer.py GPU metrics integration (BL086).

Covers:
  * enrich_records() sets metrics_source='cloudwatch' when CloudWatch data present (Req 6.5)
  * enrich_records() sets metrics_source='none' when no signals (Req 6.6)
  * enrich_records() sets 'both' / 'engine_metrics' correctly (Req 3.3)
  * get_parquet_schema() includes all 11 new columns (Req 4.2)
  * missing signals become None columns (additive/nullable) (Req 4.3, 4.4)
"""

import importlib.util
import os
from datetime import datetime, timezone

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_WRITER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".benchmark_writer.py",
)
_WRITER_PATH = os.path.normpath(_WRITER_PATH)
_spec = importlib.util.spec_from_file_location("benchmark_writer", _WRITER_PATH)
_bw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bw)


_NEW_COLUMNS = [
    'gpu_utilization_avg', 'gpu_utilization_max', 'gpu_memory_used_avg_gb',
    'gpu_memory_util_avg', 'kv_cache_util_avg', 'kv_cache_util_max',
    'prefix_cache_hit_rate', 'queue_depth_running_avg', 'queue_depth_waiting_avg',
    'queue_depth_waiting_max', 'metrics_source',
]


def _config():
    return {
        'project_name': 'p', 'model_name': 'Qwen/Qwen3-4B',
        'instance_type': 'ml.g5.xlarge', 'deployment_config': 'transformers-vllm',
        'region': 'us-east-1',
    }


def _results():
    return {'metrics': [{'concurrency': 4, 'request_throughput': 5.0,
                         'output_token_throughput': 100.0, 'total_requests': 40}]}


def _ts():
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


# ── Parquet schema ─────────────────────────────────────────────────────────────


class TestParquetSchema:
    def test_schema_includes_all_11_new_columns(self):
        """Req 4.2: parquet schema includes the 11 new columns."""
        schema = _bw.get_parquet_schema()
        names = set(schema.names)
        for col in _NEW_COLUMNS:
            assert col in names, f"missing schema column: {col}"

    def test_metrics_source_is_string_others_double(self):
        schema = _bw.get_parquet_schema()
        field = schema.field('metrics_source')
        assert 'string' in str(field.type)
        for col in _NEW_COLUMNS:
            if col == 'metrics_source':
                continue
            assert 'double' in str(schema.field(col).type)


# ── Provenance (metrics_source) ────────────────────────────────────────────────


class TestMetricsSourceProvenance:
    def test_cloudwatch_when_only_cloudwatch_signals(self):
        """Req 6.5 / 2.3: CloudWatch present → 'cloudwatch'."""
        gpu = {'gpu_utilization_avg': 55.0, 'gpu_utilization_max': 80.0}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        assert recs[0]['metrics_source'] == 'cloudwatch'
        assert recs[0]['gpu_utilization_avg'] == 55.0

    def test_none_when_no_signals(self):
        """Req 6.6 / 2.4: empty collection → 'none', new columns NULL."""
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics={})
        assert recs[0]['metrics_source'] == 'none'
        for col in _NEW_COLUMNS:
            if col == 'metrics_source':
                continue
            assert recs[0][col] is None

    def test_none_when_gpu_metrics_omitted(self):
        recs = _bw.enrich_records(_config(), _results(), _ts())
        assert recs[0]['metrics_source'] == 'none'

    def test_engine_metrics_when_only_engine_signals(self):
        gpu = {'kv_cache_util_avg': 0.9, 'prefix_cache_hit_rate': 0.3}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        assert recs[0]['metrics_source'] == 'engine_metrics'
        assert recs[0]['kv_cache_util_avg'] == 0.9

    def test_both_when_cloudwatch_and_engine_signals(self):
        """Req 3.3: both sources → 'both'."""
        gpu = {'gpu_utilization_avg': 55.0, 'kv_cache_util_avg': 0.9}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        assert recs[0]['metrics_source'] == 'both'

    def test_explicit_metrics_source_is_honored(self):
        gpu = {'gpu_utilization_avg': 55.0, 'metrics_source': 'both'}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        assert recs[0]['metrics_source'] == 'both'


# ── Additive migration integrity ───────────────────────────────────────────────


class TestAdditiveMigration:
    def test_all_11_columns_present_even_when_empty(self):
        """Req 4.3/4.4: enriched record always exposes all 11 columns."""
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics={})
        for col in _NEW_COLUMNS:
            assert col in recs[0], f"missing column in record: {col}"

    def test_partial_signals_leave_others_null(self):
        gpu = {'gpu_utilization_avg': 42.0}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        r = recs[0]
        assert r['gpu_utilization_avg'] == 42.0
        assert r['gpu_utilization_max'] is None
        assert r['kv_cache_util_avg'] is None

    def test_records_convert_to_parquet_table(self):
        """The enriched records (with new columns) build a valid pyarrow table."""
        pytest.importorskip('pyarrow')
        gpu = {'gpu_utilization_avg': 55.0, 'kv_cache_util_avg': 0.9}
        recs = _bw.enrich_records(_config(), _results(), _ts(), gpu_metrics=gpu)
        table = _bw._records_to_parquet_table(recs)
        assert 'metrics_source' in table.schema.names
        assert table.num_rows == 1
