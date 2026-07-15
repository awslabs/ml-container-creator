from __future__ import annotations
"""Tests for .optimize_engine.py — Athena query engine and recommendation logic."""

import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_ENGINE_PATH = os.path.join(
    os.path.dirname(__file__), '..', '..', 'templates', 'do', '.optimize_engine.py'
)
_ENGINE_PATH = os.path.normpath(_ENGINE_PATH)

_spec = importlib.util.spec_from_file_location('optimize_engine', _ENGINE_PATH)
_engine = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_engine)

AthenaQueryEngine = _engine.AthenaQueryEngine
RecommendationEngine = _engine.RecommendationEngine
_sanitize_partition_value = _engine._sanitize_partition_value
_parse_threshold_arg = _engine._parse_threshold_arg
SWEEPABLE_DIMENSIONS = _engine.SWEEPABLE_DIMENSIONS
METRIC_DIRECTION = _engine.METRIC_DIRECTION


# ── Test: _sanitize_partition_value ───────────────────────────────────────────


class TestSanitizePartitionValue:
    """Test partition value sanitization."""

    def test_slash_replaced_with_underscore(self):
        """Qwen/Qwen3-4B → qwen_qwen3-4b"""
        assert _sanitize_partition_value("Qwen/Qwen3-4B") == "qwen_qwen3-4b"

    def test_already_lowercase(self):
        assert _sanitize_partition_value("meta-llama/llama-3-8b") == "meta-llama_llama-3-8b"

    def test_empty_string(self):
        assert _sanitize_partition_value("") == ""

    def test_no_slash(self):
        assert _sanitize_partition_value("Qwen3-4B") == "qwen3-4b"

    def test_multiple_slashes(self):
        assert _sanitize_partition_value("org/sub/model") == "org_sub_model"


# ── Test: _parse_threshold_arg ────────────────────────────────────────────────


class TestParseThresholdArg:
    """Test threshold argument parsing."""

    def test_throughput_alias(self):
        """throughput:5 → ('output_token_throughput_tps', 5.0)"""
        metric, pct = _parse_threshold_arg("throughput:5")
        assert metric == "output_token_throughput_tps"
        assert pct == 5.0

    def test_ttft_alias(self):
        """ttft:20 → ('ttft_p90_ms', 20.0)"""
        metric, pct = _parse_threshold_arg("ttft:20")
        assert metric == "ttft_p90_ms"
        assert pct == 20.0

    def test_itl_alias(self):
        """itl:15 → ('itl_p90_ms', 15.0)"""
        metric, pct = _parse_threshold_arg("itl:15")
        assert metric == "itl_p90_ms"
        assert pct == 15.0

    def test_latency_alias(self):
        """latency:10 → ('e2e_latency_p90_ms', 10.0)"""
        metric, pct = _parse_threshold_arg("latency:10")
        assert metric == "e2e_latency_p90_ms"
        assert pct == 10.0

    def test_full_metric_name(self):
        """output_token_throughput_tps:5 → ('output_token_throughput_tps', 5.0)"""
        metric, pct = _parse_threshold_arg("output_token_throughput_tps:5")
        assert metric == "output_token_throughput_tps"
        assert pct == 5.0

    def test_invalid_format_no_colon(self):
        with pytest.raises(ValueError):
            _parse_threshold_arg("throughput5")

    def test_invalid_percentage(self):
        with pytest.raises(ValueError):
            _parse_threshold_arg("throughput:abc")


# ── Test: RecommendationEngine — no records ───────────────────────────────────


class TestRecommendationEngineNoRecords:
    """Test recommendation engine with empty records."""

    def test_no_records_returns_empty(self):
        """Empty records → empty recommendations."""
        engine = RecommendationEngine(
            current_config={
                'quantization': 'bf16',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
            },
            benchmark_records=[],
            target_metric='output_token_throughput_tps',
        )
        recs = engine.compute_recommendations()
        assert recs == []

    def test_no_records_all_dimensions_no_change(self):
        """Empty records → all dimensions in no_change."""
        engine = RecommendationEngine(
            current_config={
                'quantization': 'bf16',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
            },
            benchmark_records=[],
            target_metric='output_token_throughput_tps',
        )
        no_change = engine.compute_no_change_dimensions()
        assert set(no_change) == set(SWEEPABLE_DIMENSIONS)


# ── Test: RecommendationEngine — better quantization ──────────────────────────


class TestRecommendationEngineBetterQuantization:
    """Test that fp8 > bf16 records produce a quantization recommendation."""

    def _make_records(self):
        """Create records where fp8 outperforms bf16."""
        records = []
        # bf16 records: ~150 tps
        for i in range(5):
            records.append({
                'model_name': 'Qwen/Qwen3-4B',
                'quantization': 'bf16',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
                'output_token_throughput_tps': 145 + i * 2,
            })
        # fp8 records: ~210 tps (much better)
        for i in range(6):
            records.append({
                'model_name': 'Qwen/Qwen3-4B',
                'quantization': 'fp8',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
                'output_token_throughput_tps': 205 + i * 2,
            })
        return records

    def test_recommends_fp8(self):
        """Records show fp8 beats bf16 → recommends fp8."""
        engine = RecommendationEngine(
            current_config={
                'model_name': 'Qwen/Qwen3-4B',
                'quantization': 'bf16',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
            },
            benchmark_records=self._make_records(),
            target_metric='output_token_throughput_tps',
        )
        recs = engine.compute_recommendations()
        # Should have at least one recommendation for quantization
        quant_recs = [r for r in recs if r['dimension'] == 'quantization']
        assert len(quant_recs) == 1
        assert quant_recs[0]['recommended_value'] == 'fp8'
        assert quant_recs[0]['current_value'] == 'bf16'
        assert quant_recs[0]['improvement_pct'] > 30  # ~40% improvement

    def test_improvement_is_positive(self):
        """Improvement percentage is positive."""
        engine = RecommendationEngine(
            current_config={
                'model_name': 'Qwen/Qwen3-4B',
                'quantization': 'bf16',
                'tensor_parallel_degree': 1,
                'max_model_len': 4096,
                'kv_cache_dtype': 'auto',
            },
            benchmark_records=self._make_records(),
            target_metric='output_token_throughput_tps',
        )
        recs = engine.compute_recommendations()
        for r in recs:
            assert r['improvement_pct'] > 0


# ── Test: Confidence — high ───────────────────────────────────────────────────


class TestConfidenceHigh:
    """Test that 5+ consistent runs produce high confidence."""

    def test_five_consistent_runs_high_confidence(self):
        """5 runs with low variance → high confidence."""
        values = [200.0, 202.0, 198.0, 201.0, 199.0]  # CV ≈ 0.008
        confidence, score = RecommendationEngine._compute_confidence(values, False)
        assert confidence == 'high'
        assert score > 0.4

    def test_five_variable_runs_medium_confidence(self):
        """5 runs with high variance → medium confidence."""
        values = [100.0, 200.0, 150.0, 50.0, 300.0]  # high CV
        confidence, score = RecommendationEngine._compute_confidence(values, False)
        assert confidence == 'medium'


# ── Test: Confidence — low ────────────────────────────────────────────────────


class TestConfidenceLow:
    """Test that 1 run or family match produces low confidence."""

    def test_one_run_low_confidence(self):
        """1 run → low confidence."""
        values = [200.0]
        confidence, score = RecommendationEngine._compute_confidence(values, False)
        assert confidence == 'low'

    def test_family_match_low_confidence(self):
        """Family match (even with many runs) → low confidence."""
        values = [200.0, 202.0, 198.0, 201.0, 199.0]
        confidence, score = RecommendationEngine._compute_confidence(values, True)
        assert confidence == 'low'


# ── Test: AthenaQueryEngine SQL has partition predicates ───────────────────────


class TestAthenaQueryEngineSQL:
    """Test that Athena queries include partition predicates."""

    @patch('boto3.client')
    def test_exact_match_query_has_partition(self, mock_boto3_client):
        """Verify SQL contains WHERE model and instance partition predicates."""
        mock_athena = MagicMock()
        mock_boto3_client.return_value = mock_athena

        # Mock start_query_execution
        mock_athena.start_query_execution.return_value = {
            'QueryExecutionId': 'test-123'
        }
        # Mock get_query_execution (succeeded immediately)
        mock_athena.get_query_execution.return_value = {
            'QueryExecution': {'Status': {'State': 'SUCCEEDED'}}
        }
        # Mock get_query_results (empty)
        mock_athena.get_query_results.return_value = {
            'ResultSet': {'Rows': [{'Data': [{'VarCharValue': 'col1'}]}]}
        }

        engine = AthenaQueryEngine(
            glue_database='mlcc_ci',
            glue_table='benchmark_results',
            bucket='test-bucket',
            region='us-east-1',
        )

        engine.query_matching_configs(
            model_name='Qwen/Qwen3-4B',
            instance_type='ml.g6e.xlarge',
            model_family='qwen3',
            instance_family='g6e',
        )

        # Verify the SQL includes partition predicates
        call_args = mock_athena.start_query_execution.call_args
        sql = call_args[1]['QueryString'] if 'QueryString' in (call_args[1] or {}) else call_args[0][0] if call_args[0] else ''
        if not sql and call_args.kwargs:
            sql = call_args.kwargs.get('QueryString', '')

        assert "WHERE model = " in sql or "WHERE model_family = " in sql
        assert "instance" in sql.lower()

    @patch('boto3.client')
    def test_baseline_query_has_partition(self, mock_boto3_client):
        """Baseline query has model partition predicate."""
        mock_athena = MagicMock()
        mock_boto3_client.return_value = mock_athena

        mock_athena.start_query_execution.return_value = {
            'QueryExecutionId': 'test-456'
        }
        mock_athena.get_query_execution.return_value = {
            'QueryExecution': {'Status': {'State': 'SUCCEEDED'}}
        }
        mock_athena.get_query_results.return_value = {
            'ResultSet': {'Rows': [{'Data': [{'VarCharValue': 'col1'}]}]}
        }

        engine = AthenaQueryEngine(
            glue_database='mlcc_ci',
            glue_table='benchmark_results',
            bucket='test-bucket',
            region='us-east-1',
        )

        engine.query_best_baseline(
            model_name='Qwen/Qwen3-4B',
            instance_type='ml.g6e.xlarge',
            quantization='bf16',
            tensor_parallel_degree=1,
        )

        call_args = mock_athena.start_query_execution.call_args
        sql = call_args.kwargs.get('QueryString', '')
        assert "WHERE LOWER(model) = " in sql
        assert "instance = " in sql


# ── Test: compare-baseline no baseline ────────────────────────────────────────


class TestCompareBaselineNoBaseline:
    """Test compare-baseline when no historical data exists."""

    @patch('boto3.client')
    def test_no_baseline_returns_no_baseline_status(self, mock_boto3_client, tmp_path):
        """AthenaQueryEngine returns None → JSON has has_baseline: false."""
        mock_athena = MagicMock()
        mock_boto3_client.return_value = mock_athena

        # Mock empty results (query succeeds but no data)
        mock_athena.start_query_execution.return_value = {
            'QueryExecutionId': 'test-789'
        }
        mock_athena.get_query_execution.return_value = {
            'QueryExecution': {'Status': {'State': 'SUCCEEDED'}}
        }
        # Return only header row (no data)
        mock_athena.get_query_results.return_value = {
            'ResultSet': {
                'Rows': [
                    {'Data': [
                        {'VarCharValue': 'output_token_throughput_tps'},
                        {'VarCharValue': 'ttft_p90_ms'},
                    ]}
                ]
            }
        }

        # Create a fake results file
        results_file = tmp_path / "profile_export.jsonl"
        results_file.write_text(json.dumps({
            'output_token_throughput_tps': 200.0,
            'ttft_p90_ms': 45.0,
            'itl_p90_ms': 12.0,
            'e2e_latency_p90_ms': 890.0,
        }) + '\n')

        # Directly test the query engine
        engine = AthenaQueryEngine(
            glue_database='mlcc_ci',
            glue_table='benchmark_results',
            bucket='test-bucket',
            region='us-east-1',
        )

        result = engine.query_best_baseline(
            model_name='Qwen/Qwen3-4B',
            instance_type='ml.g6e.xlarge',
            quantization='bf16',
            tensor_parallel_degree=1,
        )

        assert result is None


# ── Test: CV computation ──────────────────────────────────────────────────────


class TestCVComputation:
    """Test coefficient of variation helper."""

    def test_cv_identical_values(self):
        """All same values → CV = 0."""
        assert RecommendationEngine._cv([10.0, 10.0, 10.0]) == 0.0

    def test_cv_empty_list(self):
        """Empty list → CV = 0."""
        assert RecommendationEngine._cv([]) == 0.0

    def test_cv_zero_mean(self):
        """Zero mean → CV = 0 (avoid division by zero)."""
        assert RecommendationEngine._cv([0.0, 0.0, 0.0]) == 0.0

    def test_cv_positive_for_varied_values(self):
        """Varied values → positive CV."""
        cv = RecommendationEngine._cv([100.0, 200.0, 150.0])
        assert cv > 0
