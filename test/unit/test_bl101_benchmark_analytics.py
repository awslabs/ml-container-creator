# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL101 tests: extended Serving_Config_Key, --peak, --list, pinned baseline,
and the --gpu-metrics local reader."""

import importlib.util
import json
import os

import pytest


def _load(rel):
    path = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', rel))
    spec = importlib.util.spec_from_file_location(os.path.basename(path).replace('.', '_'), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_engine = _load('templates/do/.optimize_engine.py')
_gpu = _load('templates/do/lib/python/benchmark_gpu_metrics.py')


class _CapturingEngine(_engine.AthenaQueryEngine):
    """AthenaQueryEngine that records the SQL instead of hitting Athena."""

    def __init__(self, rows=None, **kw):
        super().__init__(bucket='test-bucket', **kw)
        self.last_sql = None
        self._rows = rows or []

    def _run_query(self, sql):
        self.last_sql = sql
        return self._rows


# ── Extended Serving_Config_Key (Req 2.6) ─────────────────────────────────────


class TestExtendedKeyConditional:
    def test_max_model_len_added_when_positive(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'ml.g6.24xlarge', 'none', 1, max_model_len=8192)
        assert 'max_model_len = 8192' in e.last_sql

    def test_max_model_len_omitted_when_none(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'ml.g6.24xlarge', 'none', 1, max_model_len=None)
        assert 'max_model_len' not in e.last_sql

    def test_max_model_len_omitted_when_zero(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'ml.g6.24xlarge', 'none', 1, max_model_len=0)
        assert 'max_model_len' not in e.last_sql

    def test_kv_cache_dtype_added_when_non_auto(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1, kv_cache_dtype='fp8')
        assert "kv_cache_dtype = 'fp8'" in e.last_sql

    def test_kv_cache_dtype_omitted_when_auto(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1, kv_cache_dtype='auto')
        assert 'kv_cache_dtype' not in e.last_sql

    def test_kv_cache_dtype_omitted_when_empty(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1, kv_cache_dtype='')
        assert 'kv_cache_dtype' not in e.last_sql

    def test_base_key_always_present(self):
        e = _CapturingEngine()
        e.query_all_baselines('Qwen/Qwen3-4B', 'ml.g6.12xlarge', 'none', 4)
        assert "quantization = 'none'" in e.last_sql
        assert 'tensor_parallel_degree = 4' in e.last_sql
        assert "instance = 'ml.g6.12xlarge'" in e.last_sql


class TestIsPositiveInt:
    @pytest.mark.parametrize('value,expected', [
        (1, True), ('8192', True), (0, False), (-1, False),
        (None, False), ('', False), ('auto', False),
    ])
    def test_is_positive_int(self, value, expected):
        assert _engine._is_positive_int(value) is expected


# ── Pinned baseline (Req 5) ───────────────────────────────────────────────────


class TestPinnedBaseline:
    def test_pinned_targets_job_name(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1, pinned_job_name='job-abc')
        assert "benchmark_job_name = 'job-abc'" in e.last_sql

    def test_pinned_ignores_before_timestamp(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1,
                              before_timestamp='2026-01-01 00:00:00',
                              pinned_job_name='job-abc')
        assert 'run_timestamp <' not in e.last_sql

    def test_unpinned_uses_before_timestamp(self):
        e = _CapturingEngine()
        e.query_all_baselines('m', 'i', 'none', 1,
                              before_timestamp='2026-01-01 00:00:00')
        assert "run_timestamp < '2026-01-01 00:00:00'" in e.last_sql


# ── --peak (Req 4) ────────────────────────────────────────────────────────────


class TestPeakMetricResolution:
    def test_alias_throughput(self):
        assert _engine._resolve_peak_metric('throughput') == 'output_token_throughput_tps'

    def test_alias_cost(self):
        assert _engine._resolve_peak_metric('cost') == 'cost_per_1m_tokens'

    def test_default_when_empty(self):
        assert _engine._resolve_peak_metric('') == 'output_token_throughput_tps'

    def test_full_name_passthrough(self):
        assert _engine._resolve_peak_metric('ttft_p90_ms') == 'ttft_p90_ms'

    def test_unknown_alias_rejected(self):
        with pytest.raises(SystemExit):
            _engine._resolve_peak_metric('bogus')


class TestPeakQuery:
    def test_lower_is_better_sorts_asc(self):
        e = _CapturingEngine()
        e.query_peak('m', 'i', 'none', 1, metric='ttft_p90_ms')
        assert 'ORDER BY ttft_p90_ms ASC' in e.last_sql

    def test_higher_is_better_sorts_desc(self):
        e = _CapturingEngine()
        e.query_peak('m', 'i', 'none', 1, metric='output_token_throughput_tps')
        assert 'ORDER BY output_token_throughput_tps DESC' in e.last_sql

    def test_workload_filter(self):
        e = _CapturingEngine()
        e.query_peak('m', 'i', 'none', 1, metric='output_token_throughput_tps', workload='rag')
        assert "workload = 'rag'" in e.last_sql

    def test_peak_extends_key(self):
        e = _CapturingEngine()
        e.query_peak('m', 'i', 'none', 1, metric='output_token_throughput_tps',
                     max_model_len=4096, kv_cache_dtype='fp8')
        assert 'max_model_len = 4096' in e.last_sql
        assert "kv_cache_dtype = 'fp8'" in e.last_sql


class TestCmdPeak:
    def _args(self, **kw):
        base = dict(model_name='m', instance_type='i', quantization='none',
                    tensor_parallel=1, max_model_len=None, kv_cache_dtype=None,
                    workload=None, metric='output_token_throughput_tps',
                    bucket='b', glue_database='mlcc_ci', glue_table='benchmark_results',
                    region='us-east-1', json_output=True)
        base.update(kw)
        return type('A', (), base)()

    def test_no_results_exit_0(self, monkeypatch, capsys):
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', lambda self, sql: [])
        with pytest.raises(SystemExit) as exc:
            _engine.cmd_peak(self._args())
        assert exc.value.code == 0

    def test_delta_from_peak(self, monkeypatch, capsys):
        rows = [
            {'output_token_throughput_tps': 200.0, 'run_timestamp': '2026-01-01 00:00:00',
             'benchmark_job_name': 'peak-job', 'workload': 'rag', 'deployment_target': 'hyperpod-eks'},
            {'output_token_throughput_tps': 150.0, 'run_timestamp': '2026-02-01 00:00:00',
             'benchmark_job_name': 'recent-job', 'workload': 'rag', 'deployment_target': 'hyperpod-eks'},
        ]
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', lambda self, sql: rows)
        with pytest.raises(SystemExit) as exc:
            _engine.cmd_peak(self._args())
        out = capsys.readouterr().out
        payload = json.loads(out.strip().splitlines()[0])
        assert payload['peak']['value'] == 200.0
        assert payload['most_recent']['value'] == 150.0
        assert payload['delta_from_peak_pct'] == -25.0
        assert exc.value.code == 0


# ── --list (Req 6) ────────────────────────────────────────────────────────────


class TestListQuery:
    def test_exact_and_prefix_match(self):
        e = _CapturingEngine()
        e.query_list(model_name='llama-3.1')
        assert "LIKE 'llama-3.1%'" in e.last_sql

    def test_family_clause(self):
        e = _CapturingEngine()
        e.query_list(model_name='meta-llama/Llama-3.1-8B', model_family='llama3')
        assert "model_family = 'llama3'" in e.last_sql

    def test_workload_filter(self):
        e = _CapturingEngine()
        e.query_list(model_name='m', workload='rag_document_qa')
        assert "workload = 'rag_document_qa'" in e.last_sql

    def test_sort_direction(self):
        e = _CapturingEngine()
        e.query_list(model_name='m', sort_metric='ttft_p90_ms')
        assert 'ORDER BY ttft_p90_ms ASC' in e.last_sql


class TestCmdList:
    def _args(self, **kw):
        base = dict(model='m', model_family=None, workload=None,
                    sort='output_token_throughput_tps', limit=100, bucket='b',
                    glue_database='mlcc_ci', glue_table='benchmark_results',
                    region='us-east-1', json_output=True)
        base.update(kw)
        return type('A', (), base)()

    def test_grouping_by_config_key(self, monkeypatch, capsys):
        rows = [
            {'model_name': 'm', 'instance_type': 'ml.g6.24xlarge', 'quantization': 'none',
             'tensor_parallel_degree': 1, 'max_model_len': 4096, 'kv_cache_dtype': 'auto',
             'deployment_target': 'realtime-inference', 'workload': 'rag', 'concurrency': 8,
             'output_token_throughput_tps': 100.0, 'ttft_p90_ms': 50.0, 'itl_p90_ms': 10.0,
             'e2e_latency_p90_ms': 200.0, 'adapter_name': '', 'benchmark_job_name': 'j1',
             'run_timestamp': '2026-01-01 00:00:00'},
            {'model_name': 'm', 'instance_type': 'ml.g6.48xlarge', 'quantization': 'none',
             'tensor_parallel_degree': 2, 'max_model_len': 4096, 'kv_cache_dtype': 'auto',
             'deployment_target': 'hyperpod-eks', 'workload': 'rag', 'concurrency': 8,
             'output_token_throughput_tps': 180.0, 'ttft_p90_ms': 40.0, 'itl_p90_ms': 8.0,
             'e2e_latency_p90_ms': 150.0, 'adapter_name': '', 'benchmark_job_name': 'j2',
             'run_timestamp': '2026-01-02 00:00:00'},
        ]
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', lambda self, sql: rows)
        with pytest.raises(SystemExit) as exc:
            _engine.cmd_list(self._args())
        out = capsys.readouterr().out
        payload = json.loads(out.strip().splitlines()[0])
        assert payload['status'] == 'ok'
        assert len(payload['groups']) == 2  # two distinct config keys
        assert exc.value.code == 0

    def test_no_results(self, monkeypatch, capsys):
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', lambda self, sql: [])
        with pytest.raises(SystemExit) as exc:
            _engine.cmd_list(self._args())
        payload = json.loads(capsys.readouterr().out.strip().splitlines()[0])
        assert payload['status'] == 'no_results'
        assert exc.value.code == 0


# ── Pinned baseline in compare-baseline (Req 5.4) ─────────────────────────────


class TestComparePinnedLabel:
    def _args(self, tmp_path, pinned):
        f = tmp_path / 'profile_export.jsonl'
        f.write_text(json.dumps({'metrics': {
            'output_token_throughput_tps': 100.0, 'ttft_p90_ms': 50.0,
            'itl_p90_ms': 10.0, 'e2e_latency_p90_ms': 200.0}}) + '\n')
        return type('A', (), dict(
            results_file=str(f), model_name='m', instance_type='i',
            quantization='none', tensor_parallel=1, max_model_len=None,
            kv_cache_dtype=None, pinned_baseline=pinned, bucket='b',
            glue_database='mlcc_ci', glue_table='benchmark_results',
            region='us-east-1', threshold=None, adapter_name=None,
            json_output=True))()

    def test_pinned_flag_in_json(self, tmp_path, monkeypatch, capsys):
        rows = [{'output_token_throughput_tps': 120.0, 'ttft_p90_ms': 45.0,
                 'itl_p90_ms': 9.0, 'e2e_latency_p90_ms': 180.0,
                 'benchmark_job_name': 'pinned-job', 'run_timestamp': '2026-01-01 00:00:00',
                 'adapter_name': '', 'metrics_source': 'none'}]
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', lambda self, sql: rows)
        with pytest.raises(SystemExit):
            _engine.cmd_compare_baseline(self._args(tmp_path, 'pinned-job'))
        payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert payload['pinned_baseline'] == 'pinned-job'

    def test_pinned_query_targets_job(self, tmp_path, monkeypatch):
        captured = {}

        def _cap(self, sql):
            captured['sql'] = sql
            return []
        monkeypatch.setattr(_engine.AthenaQueryEngine, '_run_query', _cap)
        with pytest.raises(SystemExit):
            _engine.cmd_compare_baseline(self._args(tmp_path, 'pinned-job'))
        assert "benchmark_job_name = 'pinned-job'" in captured['sql']


# ── --gpu-metrics local reader (Req 3) ────────────────────────────────────────


class TestGpuMetricsReader:
    def _write(self, tmp_path, obj):
        p = tmp_path / 'profile_export.jsonl'
        p.write_text(json.dumps(obj) + '\n')
        return str(p)

    def test_extract_flat_columns(self, tmp_path):
        f = self._write(tmp_path, {'metrics': {
            'gpu_utilization_avg': 88.5, 'kv_cache_util_avg': 0.42,
            'metrics_source': 'cloudwatch', 'output_token_throughput_tps': 123.4,
        }})
        m = _gpu.extract_metrics(f)
        assert m['gpu_utilization_avg'] == 88.5
        assert m['metrics_source'] == 'cloudwatch'

    def test_metrics_source_defaults_none(self, tmp_path):
        f = self._write(tmp_path, {'metrics': {'output_token_throughput_tps': 1.0}})
        m = _gpu.extract_metrics(f)
        assert _gpu._metrics_source(m) == 'none'

    def test_json_output(self, tmp_path, capsys):
        f = self._write(tmp_path, {'metrics': {
            'gpu_utilization_avg': 50.0, 'metrics_source': 'engine_metrics'}})
        rc = _gpu.main([f, '--json'])
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload['status'] == 'ok'
        assert payload['metrics']['metrics_source'] == 'engine_metrics'
        assert rc == 0

    def test_guidance_when_source_none(self, tmp_path, capsys):
        f = self._write(tmp_path, {'metrics': {'output_token_throughput_tps': 1.0}})
        _gpu.main([f])
        out = capsys.readouterr().out
        assert 'HP_BENCHMARK_METRICS_ENABLED' in out
        assert 'start-otel-enrichment' in out

    def test_missing_file_exit_0(self, tmp_path, capsys):
        rc = _gpu.main([str(tmp_path / 'nope.jsonl')])
        assert rc == 0

    def test_summary_only(self, tmp_path, capsys):
        f = self._write(tmp_path, {'metrics': {
            'output_token_throughput_tps': 123.4, 'ttft_p90_ms': 55.0, 'itl_p90_ms': 12.3}})
        _gpu.main([f, '--summary-only'])
        out = capsys.readouterr().out
        assert 'Throughput' in out
        assert '123.4' in out


# ── Display-layer N/A substitution for target-incompatible columns (BL086) ────


class TestNaColumnClassification:
    def test_gpu_columns_na_for_engine_metrics_only(self):
        for col in ('gpu_utilization_avg', 'gpu_utilization_max',
                    'gpu_memory_util_avg', 'gpu_memory_used_avg_gb'):
            assert _gpu._is_na_column(col, 'engine_metrics_only') is True

    def test_gpu_columns_na_for_none(self):
        assert _gpu._is_na_column('gpu_utilization_avg', 'none') is True

    def test_gpu_columns_not_na_for_cloudwatch_only(self):
        assert _gpu._is_na_column('gpu_utilization_avg', 'cloudwatch_only') is False

    def test_engine_columns_na_for_cloudwatch_only(self):
        for col in ('prefix_cache_hit_rate', 'queue_depth_running_avg'):
            assert _gpu._is_na_column(col, 'cloudwatch_only') is True

    def test_engine_columns_na_for_none(self):
        assert _gpu._is_na_column('prefix_cache_hit_rate', 'none') is True

    def test_engine_columns_not_na_for_engine_metrics_only(self):
        assert _gpu._is_na_column('prefix_cache_hit_rate', 'engine_metrics_only') is False

    def test_both_source_no_na(self):
        assert _gpu._is_na_column('gpu_utilization_avg', 'both') is False
        assert _gpu._is_na_column('prefix_cache_hit_rate', 'both') is False


class TestPrintFullNa:
    def _write(self, tmp_path, obj):
        p = tmp_path / 'profile_export.jsonl'
        p.write_text(json.dumps(obj) + '\n')
        return str(p)

    def test_gpu_util_shows_na_for_engine_metrics_only(self, tmp_path, capsys):
        f = self._write(tmp_path, {'metrics': {
            'kv_cache_util_avg': 0.5, 'metrics_source': 'engine_metrics_only'}})
        _gpu.main([f])
        out = capsys.readouterr().out
        # GPU utilization rows should read N/A (Phase 1 structurally absent).
        for line in out.splitlines():
            if 'GPU utilization' in line:
                assert 'N/A' in line

    def test_prefix_hit_shows_na_for_cloudwatch_only(self, tmp_path, capsys):
        f = self._write(tmp_path, {'metrics': {
            'gpu_utilization_avg': 70.0, 'metrics_source': 'cloudwatch_only'}})
        _gpu.main([f])
        out = capsys.readouterr().out
        for line in out.splitlines():
            if 'Prefix cache hit rate' in line:
                assert 'N/A' in line
            if 'GPU utilization avg' in line:
                # Phase 1 value present → not N/A.
                assert 'N/A' not in line
