# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 9 half 9A — .benchmark_writer.py value-filling (R1.2, R1.3, R3, R4, R5, R6.3).

All AWS access is stubbed; fixtures in test/fixtures/w9-metrics/ are real
AIPerf captures (see their _provenance), not invented values.
"""

import importlib.util
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_FIX = os.path.join(_REPO, 'test', 'fixtures', 'w9-metrics')
_WRITER = os.path.join(_REPO, 'templates', 'do', '.benchmark_writer.py')
_BENCHMARK = os.path.join(_REPO, 'templates', 'do', 'benchmark')


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_bw = _load(_WRITER, 'benchmark_writer_w9')
_engine = _load(os.path.join(_REPO, 'templates', 'do', '.optimize_engine.py'), 'optimize_engine_w9')


def _config(**kw):
    base = {'project_name': 'p', 'model_name': 'Qwen/Qwen3-4B', 'instance_type': 'ml.g5.xlarge',
            'deployment_config': 'transformers-vllm', 'region': 'us-west-2'}
    base.update(kw)
    return base


class _Args:
    def __init__(self, **kw):
        defaults = dict(gpu_metrics_file=None, gpu_metrics_dir=None, endpoint_name=None, ic_name=None,
                        variant_name=None, run_start=None, run_end=None, benchmark_job_name=None)
        defaults.update(kw)
        self.__dict__.update(defaults)


@pytest.fixture(autouse=True)
def _reset_caches():
    _bw._JOB_DESCRIPTIONS.clear()
    _bw._WINDOW_SOURCES.clear()
    yield


# ── R3: error_rate ─────────────────────────────────────────────────────────────


class TestErrorRate:
    def test_errored_jsonl_records_are_counted(self):
        path = os.path.join(_FIX, 'profile-export-1err-8ok.jsonl')
        records = [json.loads(line) for line in open(path)]
        n_err = sum(1 for r in records if r.get('error') is not None)
        assert n_err >= 1, 'fixture must contain a real errored record'
        metric = _bw._parse_jsonl_to_metrics(path, concurrency=2)['metrics'][0]
        assert metric['error_count'] == n_err
        rec = _bw.enrich_records(_config(), {'metrics': [metric]}, instance_catalog={})[0]
        assert rec['error_rate'] == pytest.approx(n_err / len(records))

    def test_all_success_still_writes_zero(self, tmp_path):
        src = os.path.join(_FIX, 'profile-export-1err-8ok.jsonl')
        ok = tmp_path / 'ok.jsonl'
        ok.write_text(''.join(line for line in open(src) if json.loads(line).get('error') is None))
        metric = _bw._parse_jsonl_to_metrics(str(ok), concurrency=1)['metrics'][0]
        rec = _bw.enrich_records(_config(), {'metrics': [metric]}, instance_catalog={})[0]
        assert rec['error_rate'] == 0.0

    def test_aiperf_percent_is_converted_and_preferred(self):
        agg = json.load(open(os.path.join(_FIX, 'aiperf-with-errors.json')))
        assert agg['request_error_rate']['unit'] == '%'
        metric = {'concurrency': 1, 'total_requests': 100, 'error_count': 50,
                  'request_error_rate': agg['request_error_rate']}
        rec = _bw.enrich_records(_config(), {'metrics': [metric]}, instance_catalog={})[0]
        assert rec['error_rate'] == pytest.approx(agg['request_error_rate']['avg'] / 100.0)

    def test_unknown_is_null_not_zero(self):
        rec = _bw.enrich_records(_config(), {'metrics': [{'concurrency': 1, 'total_requests': 10}]},
                                 instance_catalog={})[0]
        assert rec['error_rate'] is None

    def test_level_context_attaches_the_sibling_aiperf_rate(self, tmp_path):
        shutil.copy(os.path.join(_FIX, 'profile-export-1err-8ok.jsonl'), tmp_path / 'profile_export.jsonl')
        shutil.copy(os.path.join(_FIX, 'aiperf-with-errors.json'), tmp_path / 'profile_export_aiperf.json')
        metric = _bw._parse_jsonl_to_metrics(str(tmp_path / 'profile_export.jsonl'), concurrency=2)['metrics'][0]
        _bw.collect_level_context(_Args(), {'deployment_target': 'eks'}, [metric],
                                  str(tmp_path / 'profile_export.jsonl'))
        rec = _bw.enrich_records(_config(), {'metrics': [metric]}, instance_catalog={})[0]
        assert rec['error_rate'] == pytest.approx(0.01)


# ── R4.1: catalog path in a generated project layout ───────────────────────────


class TestCatalogGeneratedLayout:
    def test_gpu_columns_resolve_from_project_mlcc_instances(self, tmp_path):
        project = tmp_path / 'proj'
        (project / 'do').mkdir(parents=True)
        (project / '.mlcc').mkdir()
        shutil.copy(_WRITER, project / 'do' / '.benchmark_writer.py')
        shutil.copy(os.path.join(_REPO, 'servers', 'lib', 'catalogs', 'instances.json'),
                    project / '.mlcc' / 'instances.json')
        mod = _load(str(project / 'do' / '.benchmark_writer.py'), 'bw_generated_layout')
        catalog = mod.load_instance_catalog()
        gpu_entries = {k: v for k, v in catalog.items() if (v.get('gpus') or 0) > 0}
        assert gpu_entries, 'the project-local catalog must be found (no source-tree fallback here)'
        for itype, entry in gpu_entries.items():
            meta = mod.resolve_instance_metadata(itype, catalog)
            assert meta['gpu_count'] == entry['gpus']
            assert meta['gpu_type'] is not None and meta['gpu_memory_gb'] is not None


# ── R1.2: run window precedence ────────────────────────────────────────────────


class _SMStub:
    def __init__(self, desc):
        self.desc, self.calls = desc, []

    def describe_ai_benchmark_job(self, AIBenchmarkJobName):
        self.calls.append(AIBenchmarkJobName)
        return self.desc


_JOB_TIMES = {'StartTime': datetime(2026, 10, 23, 19, 22, 30, tzinfo=timezone.utc),
              'EndTime': datetime(2026, 10, 23, 19, 26, 31, tzinfo=timezone.utc)}


class TestRunWindow:
    def test_aiperf_start_end_win_and_are_utc(self):
        agg = json.load(open(os.path.join(_FIX, 'aiperf-fresh-ai-ml-c2.json')))
        start, end, src = _bw.resolve_run_window(os.path.join(_FIX, 'aiperf-fresh-ai-ml-c2.json'),
                                                 'job', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
                                                 sm_client=_SMStub(_JOB_TIMES))
        assert src == 'aiperf'
        assert start.tzinfo is not None and start.utcoffset().total_seconds() == 0
        assert start.isoformat().startswith(agg['start_time'][:19])
        assert end > start

    def test_job_times_are_second(self, tmp_path):
        stub = _SMStub(_JOB_TIMES)
        start, end, src = _bw.resolve_run_window(None, 'job-1', '2026-01-01T00:00:00Z',
                                                 '2026-01-01T01:00:00Z', sm_client=stub)
        assert (start, end, src) == (_JOB_TIMES['StartTime'], _JOB_TIMES['EndTime'], 'benchmark-job')
        assert stub.calls == ['job-1']

    def test_bash_run_start_end_are_last(self):
        start, end, src = _bw.resolve_run_window(None, None, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')
        assert src == 'run-start/run-end' and (end - start).total_seconds() == 300

    def test_nothing_usable(self):
        assert _bw.resolve_run_window(None, None, None, None) == (None, None, None)

    @pytest.mark.parametrize('value', [1793042512, 1793042512000, 1793042512000000, 1793042512000000000])
    def test_epoch_units(self, value):
        assert _bw._parse_time(value) == datetime.fromtimestamp(1793042512, tz=timezone.utc)

    def test_resume_path_gets_a_window_from_the_job(self, monkeypatch):
        """--status (resume) passes only --benchmark-job-name: the window and the
        realtime endpoint / IC selector come from DescribeAIBenchmarkJob."""
        desc = dict(_JOB_TIMES, BenchmarkTarget={'Endpoint': {
            'Identifier': 'ep-from-job', 'InferenceComponents': [{'Identifier': 'ic-from-job'}]}})
        monkeypatch.setattr(_bw, 'describe_benchmark_job', lambda job, region, client=None: desc)
        gm = _bw._load_gpu_metrics()
        seen = []
        monkeypatch.setattr(gm, 'collect_for_target',
                            lambda t, v, e, s, en, r, **kw: (seen.append((v, s, en)) or ({'gpu_utilization_avg': 1.0}, t)))
        signals = _bw._collect_gpu_signals(_Args(benchmark_job_name='j'), {'deployment_target': 'realtime-inference'})
        assert signals['metrics_source'] == 'cloudwatch_only'
        values, start, end = seen[0]
        assert values == {'endpoint': 'ep-from-job', 'inference_component': 'ic-from-job'}
        assert (start, end) == (_JOB_TIMES['StartTime'], _JOB_TIMES['EndTime'])


# ── R1.3 / R5.1: per-level windows, identity and signals in a sweep ────────────


def _sweep_dir(tmp_path, levels):
    agg = json.load(open(os.path.join(_FIX, 'aiperf-fresh-ai-ml-c2.json')))
    metrics = []
    for i, level in enumerate(levels):
        a = dict(agg)
        a['start_time'] = f'2026-10-23T19:{10 + 5 * i:02d}:00'
        a['end_time'] = f'2026-10-23T19:{12 + 5 * i:02d}:00'
        (tmp_path / f'results-concurrency-{level}.json').write_text(json.dumps(a))
        (tmp_path / f'job-concurrency-{level}.txt').write_text(f'proj-benchmark-level{level}\n')
        metrics.append({'concurrency': level, 'total_requests': 10, 'error_count': 0,
                        'output_token_throughput': 10.0 * level})
    (tmp_path / 'results.json').write_text(json.dumps({'metrics': metrics}))
    return metrics


class TestSweepLevels:
    def test_each_level_gets_its_own_window_job_and_signals(self, tmp_path, monkeypatch):
        metrics = _sweep_dir(tmp_path, [1, 4])
        gm = _bw._load_gpu_metrics()
        windows = []

        def fake(target, values, engine, start, end, region, **kw):
            windows.append((start, end))
            return {'kv_cache_util_avg': float(len(windows))}, 'cloudwatch-promql'
        monkeypatch.setattr(gm, 'collect_for_target', fake)
        monkeypatch.setattr(_bw, 'describe_benchmark_job', lambda *a, **k: {})
        by_level = _bw.collect_level_context(_Args(endpoint_name='ep', ic_name='ic'),
                                             {'deployment_target': 'realtime-inference'}, metrics,
                                             str(tmp_path / 'results.json'))
        assert set(by_level) == {1, 4}
        assert len(set(windows)) == 2, 'one Phase 1 query set per level, each with its own window'
        records = _bw.enrich_records(_config(), {'metrics': metrics, 'job_name': 'parent'},
                                     instance_catalog={}, gpu_metrics_by_concurrency=by_level)
        by_conc = {r['concurrency']: r for r in records}
        assert by_conc[1]['kv_cache_util_avg'] != by_conc[4]['kv_cache_util_avg']
        assert by_conc[1]['benchmark_job_name'] == 'proj-benchmark-level1'
        assert by_conc[4]['benchmark_job_name'] == 'proj-benchmark-level4'

    def test_level_artifacts_single_level_sibling(self, tmp_path):
        (tmp_path / 'profile_export.jsonl').write_text('')
        (tmp_path / 'profile_export_aiperf.json').write_text('{}')
        aiperf, job = _bw.level_artifacts(str(tmp_path / 'profile_export.jsonl'), 2)
        assert aiperf == str(tmp_path / 'profile_export_aiperf.json') and job is None


# ── R6.3: sidecars are per job + level; the fixed file is never an input ────────


class TestSidecarInputs:
    def test_only_this_levels_sidecars_are_read(self, tmp_path):
        job = tmp_path / 'benchmarks' / 'job-1'
        job.mkdir(parents=True)
        (tmp_path / 'benchmarks' / '.last_gpu_metrics.json').write_text(json.dumps({'kv_cache_util_avg': 0.99}))
        (job / 'gpu_metrics-c8-0.json').write_text(json.dumps({'kv_cache_util_avg': 0.5}))
        sig = _bw._collect_gpu_signals(_Args(gpu_metrics_dir=str(job)), {'deployment_target': 'hyperpod-eks'}, 2)
        assert sig['metrics_source'] == 'none' and 'kv_cache_util_avg' not in sig
        (job / 'gpu_metrics-c2-0.json').write_text(json.dumps({'kv_cache_util_avg': 0.25,
                                                                'queue_depth_running_avg': 1.0}))
        (job / 'gpu_metrics-c2-1.json').write_text(json.dumps({'kv_cache_util_avg': 0.75,
                                                                'queue_depth_running_avg': 2.0}))
        sig = _bw._collect_gpu_signals(_Args(gpu_metrics_dir=str(job)), {'deployment_target': 'hyperpod-eks'}, 2)
        assert sig['metrics_source'] == 'engine_metrics_only'
        assert sig['kv_cache_util_avg'] == pytest.approx(0.5)
        assert sig['queue_depth_running_avg'] == 3.0

    def test_benchmark_never_passes_the_fixed_sidecar_to_the_writer(self):
        text = open(_BENCHMARK, encoding='utf-8').read()
        blocks = re.findall(r'\.benchmark_writer\.py"? write \\\n(?:.*\\\n)*.*', text)
        assert len(blocks) >= 4, 'single, status/resume, sweep and eks write calls'
        for block in blocks:
            assert '.last_gpu_metrics' not in block and '--gpu-metrics-file' not in block
            assert '--gpu-metrics-dir' in block


# ── R5: identity on the write path + pinned-baseline lookup ─────────────────────


class TestWritePathIdentity:
    def test_write_path_persists_job_and_run_name(self, tmp_path, monkeypatch):
        pytest.importorskip('pyarrow')
        shutil.copy(os.path.join(_FIX, 'profile-export-1err-8ok.jsonl'), tmp_path / 'profile_export.jsonl')
        captured = []
        real = _bw._records_to_parquet_table

        def capture(records):
            captured.extend(records)
            return real(records)
        monkeypatch.setattr(_bw, '_records_to_parquet_table', capture)
        monkeypatch.setattr(_bw, '_upload_to_s3', lambda *a, **k: None)
        monkeypatch.setattr(_bw, 'register_partition', lambda **k: {'registered': True, 'error': None})
        monkeypatch.setattr(sys, 'argv', [
            'w', 'write', '--results-file', str(tmp_path / 'profile_export.jsonl'), '--bucket', 'b',
            '--project-name', 'p', '--region', 'us-west-2', '--instance-type', 'ml.g5.xlarge',
            '--benchmark-job-name', 'p-benchmark-20261026-000000', '--run-name', 'calm-fox_chat_2'])
        cfg = tmp_path / 'config'
        cfg.write_text('export MODEL_NAME="Qwen/Qwen3-4B"\nexport DEPLOYMENT_CONFIG="transformers-vllm"\n'
                       'export DEPLOYMENT_TARGET="eks"\n')
        sys.argv += ['--config-file', str(cfg)]
        with pytest.raises(SystemExit) as exc:
            _bw.main()
        assert exc.value.code == 0
        assert captured and captured[0]['benchmark_job_name'] == 'p-benchmark-20261026-000000'
        assert captured[0]['run_name'] == 'calm-fox_chat_2'

    def test_pinned_baseline_query_matches_a_new_row(self):
        row = _bw.enrich_records(_config(), {'metrics': [{'concurrency': 2, 'total_requests': 1}],
                                             'job_name': 'p-benchmark-20261026-000000',
                                             'run_name': 'calm-fox_chat_2'}, instance_catalog={})[0]

        class _Athena(_engine.AthenaQueryEngine):
            def __init__(self):
                super().__init__(bucket='b')

            def _run_query(self, sql):
                # Evaluate only the pinned predicate against the written row.
                m = re.search(r"benchmark_job_name = '([^']*)' OR TRY\(run_name\) = '([^']*)'", sql)
                return [row] if m and (row['benchmark_job_name'] == m.group(1)
                                       or row['run_name'] == m.group(2)) else []
        for pinned in (row['benchmark_job_name'], row['run_name']):
            hits = _Athena().query_all_baselines('Qwen/Qwen3-4B', 'ml.g5.xlarge', 'none', 1,
                                                 pinned_job_name=pinned)
            assert hits == [row]
