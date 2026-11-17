# SPDX-License-Identifier: Apache-2.0

"""Unit tests for gpu_metrics.py (BL086 + Wave 9 R1, R2, R6).

Covers:
  * METRIC_REGISTRY is a DERIVED view of serve.d/<engine>/manifest.json
    metric_signals (R2.1) — no engine names are hardcoded in gpu_metrics.
  * PromQL builders: dotted-label quoting, sum-across-series subqueries, ratio
    via increase() over the window (R2.4), native vs classic histograms (R6.1),
    the 24 h range cap.
  * Store transport: /api/v1/query on CloudWatch (SigV4 monitoring) and AMP
    (SigV4 aps); NaN / empty → no key (R1.4); DCGM FB_USED MiB → GB.
  * AMP discovery from the add-on configuration (R6.1) — present / absent.
  * Engine scrape: label sets SUMMED (R6.2), _created never leaks, the scrape
    path comes from the manifest (R2.3), raw counters kept for window ratios.
  * Per-level sidecar merge (R6.3).
Fixtures under test/fixtures/w9-metrics/ are real captures (see their
_provenance / file names), not invented values.
"""

import importlib.util
import json
import math
import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_LIB = os.path.join(_REPO, 'templates', 'do', 'lib', 'python')
_FIX = os.path.join(_REPO, 'test', 'fixtures', 'w9-metrics')
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

_spec = importlib.util.spec_from_file_location('gpu_metrics', os.path.join(_LIB, 'gpu_metrics.py'))
gpu_metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gpu_metrics)

import serve_manifest  # noqa: E402
import target_manifest  # noqa: E402

_REAL_VLLM = open(os.path.join(_FIX, 'vllm-0.31-fresh-ai-ml-metrics.txt'), encoding='utf-8').read()


def _window(minutes=10):
    end = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
    return end - timedelta(minutes=minutes), end


# ── Derived registry (R2.1) ────────────────────────────────────────────────────


class TestDerivedRegistry:
    def test_registry_mirrors_every_manifest_signal(self):
        engines = [e for e in serve_manifest.list_engines() if serve_manifest.metric_signals(e)]
        assert engines, 'at least one engine declares metric_signals'
        assert set(gpu_metrics.METRIC_REGISTRY) == set(engines)
        for engine in engines:
            for signal, decl in serve_manifest.metric_signals(engine).items():
                view = gpu_metrics.METRIC_REGISTRY[engine][signal]
                if decl['type'] == 'ratio':
                    assert view == {'num': decl['num'], 'den': decl['den']}
                else:
                    assert view == decl['name']

    def test_counter_pairs_use_the_exported_total_suffix(self):
        # CloudWatch PromQL and AMP both export counters with _total
        # (verified live: vllm:prefix_cache_hits_total has series; the bare
        # name has none).
        for engine in serve_manifest.list_engines():
            for decl in serve_manifest.metric_signals(engine).values():
                if decl['type'] == 'ratio':
                    assert decl['num'].endswith('_total') and decl['den'].endswith('_total')

    def test_no_engine_metric_name_literal_in_module(self):
        src = open(os.path.join(_LIB, 'gpu_metrics.py'), encoding='utf-8').read()
        for engine in serve_manifest.list_engines():
            for decl in serve_manifest.metric_signals(engine).values():
                for name in (decl.get('name'), decl.get('num'), decl.get('den')):
                    if name:
                        assert f"'{name}'" not in src, f'{name} is hardcoded in gpu_metrics.py'
        # The broken OTel aggregate names are gone (R2.2).
        for dead in ('KVCacheUtilization', 'QueueDepth', 'BatchSize', 'OTEL_METRIC_NAMES'):
            assert dead not in src


# ── Query builders ─────────────────────────────────────────────────────────────


class TestQueryBuilders:
    def test_dotted_labels_are_single_quoted_plain_labels_are_not(self):
        m = gpu_metrics.build_matchers(
            {'endpoint': 'aws.sagemaker.endpoint.name', 'namespace': 'namespace'},
            {'endpoint': 'ep-1', 'namespace': 'default'})
        assert m == ["'aws.sagemaker.endpoint.name'=\"ep-1\"", 'namespace="default"']

    def test_roles_without_values_are_dropped(self):
        assert gpu_metrics.build_matchers({'endpoint': 'x', 'inference_component': 'y'},
                                          {'endpoint': 'e', 'inference_component': None}) == ['x="e"']

    def test_sum_gauge_sums_series_before_time_aggregation(self):
        q = gpu_metrics.gauge_query('m', ['a="b"'], 95, 'sum', 'max')
        assert q.startswith('max_over_time(sum({__name__="m",a="b"})[95s:')

    def test_avg_gauge(self):
        assert gpu_metrics.gauge_query('m', [], 60, 'avg', 'avg') == 'avg(avg_over_time({__name__="m"}[60s]))'

    def test_ratio_is_increase_over_the_window(self):
        q = gpu_metrics.ratio_query('n_total', 'd_total', ['x="1"'], 120)
        assert 'increase({__name__="n_total",x="1"}[120s])' in q
        assert 'increase({__name__="d_total",x="1"}[120s])' in q
        assert ' / ' in q

    def test_native_vs_classic_histograms(self):
        native = gpu_metrics.quantile_query('h', ['x="1"'], 60, 0.99, 'native')
        classic = gpu_metrics.quantile_query('h', ['x="1"'], 60, 0.99, 'classic')
        assert '__name__="h",' in native and '_bucket' not in native
        assert '__name__="h_bucket"' in classic and 'by (le)' in classic

    def test_window_is_clamped_to_the_promql_range_limit(self):
        s = datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert gpu_metrics.window_seconds(s, s + timedelta(days=3)) == gpu_metrics.MAX_WINDOW_SECONDS
        assert gpu_metrics.window_seconds(s, s + timedelta(seconds=95.2)) == 96


# ── Store collection ───────────────────────────────────────────────────────────


class _Recorder:
    def __init__(self, value=1.0, by_substring=None):
        self.calls = []
        self.value = value
        self.by_substring = by_substring or {}

    def __call__(self, region, query, at_time, base_url, service):
        self.calls.append((query, at_time, base_url, service))
        for needle, value in self.by_substring.items():
            if needle in query:
                return value
        return self.value


class TestCollectStoreSignals:
    def _realtime(self):
        return target_manifest.observability('realtime-inference')

    def test_realtime_queries_manifest_names_with_descriptor_selector(self):
        rec = _Recorder()
        start, end = _window()
        out = gpu_metrics.collect_store_signals(
            self._realtime(), {'endpoint': 'ep', 'inference_component': 'ic'}, 'vllm',
            start, end, 'us-west-2', query_fn=rec)
        queries = ' '.join(c[0] for c in rec.calls)
        for decl in serve_manifest.metric_signals('vllm').values():
            if decl['type'] in ('gauge', 'ratio'):
                for name in (decl.get('name'), decl.get('num'), decl.get('den')):
                    if name:
                        assert f'__name__="{name}"' in queries
        for name in gpu_metrics.DCGM_SIGNALS.values():
            assert f'__name__="{name}"' in queries
        assert "'aws.sagemaker.endpoint.name'=\"ep\"" in queries
        assert all(c[1] == end for c in rec.calls), 'instant queries evaluate at window end'
        assert all(c[3] == 'monitoring' for c in rec.calls)
        assert all(c[2] == 'https://monitoring.us-west-2.amazonaws.com' for c in rec.calls)
        assert out['kv_cache_util_avg'] == 1.0

    def test_no_samples_yields_null_not_zero(self):
        start, end = _window()
        out = gpu_metrics.collect_store_signals(
            self._realtime(), {'endpoint': 'ep'}, 'vllm', start, end, 'us-west-2',
            query_fn=_Recorder(value=None))
        assert out == {}

    def test_fb_used_mib_converts_to_gb(self):
        start, end = _window()
        out = gpu_metrics.collect_store_signals(
            self._realtime(), {'endpoint': 'ep'}, None, start, end, 'us-west-2',
            query_fn=_Recorder(by_substring={'DCGM_FI_DEV_FB_USED': 21400.0}, value=None))
        assert out == {'gpu_memory_used_avg_gb': pytest.approx(21400.0 / 1024.0)}

    def test_engine_without_signals_queries_gpu_only(self):
        rec = _Recorder()
        start, end = _window()
        gpu_metrics.collect_store_signals(self._realtime(), {'endpoint': 'ep'}, 'flask',
                                          start, end, 'us-west-2', query_fn=rec)
        assert all('DCGM_' in c[0] for c in rec.calls)

    def test_store_none_and_missing_selector_do_nothing(self):
        start, end = _window()
        rec = _Recorder()
        assert gpu_metrics.collect_store_signals({'store': 'none'}, {'endpoint': 'e'}, 'vllm',
                                                 start, end, 'r', query_fn=rec) == {}
        assert gpu_metrics.collect_store_signals(self._realtime(), {}, 'vllm',
                                                 start, end, 'r', query_fn=rec) == {}
        assert rec.calls == []

    def test_transport_error_stops_with_one_warning(self, capsys):
        start, end = _window()
        calls = []

        def boom(*a):
            calls.append(a)
            raise urllib.error.HTTPError('u', 403, 'AccessDenied', {}, None)
        out = gpu_metrics.collect_store_signals(self._realtime(), {'endpoint': 'ep'}, 'vllm',
                                                start, end, 'r', query_fn=boom)
        assert out == {} and len(calls) == 1
        assert capsys.readouterr().err.count('query failed') == 1

    def test_bad_query_400_skips_only_that_signal(self):
        start, end = _window()

        def flaky(region, q, at, base, svc):
            if 'DCGM_FI_DEV_GPU_UTIL' in q:
                raise urllib.error.HTTPError('u', 400, 'bad_data', {}, None)
            return 2.0
        out = gpu_metrics.collect_store_signals(self._realtime(), {'endpoint': 'ep'}, 'vllm',
                                                start, end, 'r', query_fn=flaky)
        assert 'gpu_utilization_avg' not in out and out['kv_cache_util_avg'] == 2.0

    def test_hyperpod_uses_classic_amp_selectors(self):
        obs = target_manifest.observability('hyperpod-eks')
        rec = _Recorder()
        start, end = _window()
        gpu_metrics.collect_store_signals(obs, {'deployment': 'proj', 'namespace': 'default'}, 'vllm',
                                          start, end, 'us-west-2', amp_endpoint='https://aps.example/ws-1',
                                          query_fn=rec)
        assert all(c[3] == 'aps' and c[2] == 'https://aps.example/ws-1' for c in rec.calls)
        engine_q = [c[0] for c in rec.calls if 'vllm:' in c[0]]
        gpu_q = [c[0] for c in rec.calls if 'DCGM_' in c[0]]
        # Engine series are selected by the deployment label, DCGM by container.
        assert engine_q and all('resource_name="proj"' in q for q in engine_q)
        assert gpu_q and all('container="proj"' in q for q in gpu_q)


class _Resp:
    def __init__(self, body):
        self._b = json.dumps(body).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestPromqlTransport:
    def _run(self, body, **kw):
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen['url'] = req.full_url
            return _Resp(body)
        with mock.patch.object(gpu_metrics, '_sigv4_headers', return_value={}) as sig, \
                mock.patch('urllib.request.urlopen', side_effect=fake_urlopen):
            val = gpu_metrics._promql_instant_query('us-west-2', 'up', _window()[1], **kw)
        return val, seen['url'], sig.call_args

    def test_cloudwatch_uses_api_v1_query_not_the_404_path(self):
        val, url, sig = self._run({'status': 'success', 'data': {'result': [{'value': [0, '3.5']}]}})
        assert url == 'https://monitoring.us-west-2.amazonaws.com/api/v1/query'
        assert '/prometheus/' not in url
        assert sig[0][3] == 'monitoring' and val == 3.5

    def test_amp_uses_workspace_endpoint_and_aps(self):
        _v, url, sig = self._run({'status': 'success', 'data': {'result': []}},
                                 base_url='https://aps-workspaces.us-west-2.amazonaws.com/workspaces/ws-1',
                                 service='aps')
        assert url.endswith('/workspaces/ws-1/api/v1/query') and sig[0][3] == 'aps'

    @pytest.mark.parametrize('raw', ['NaN', '+Inf', '-Inf'])
    def test_non_finite_is_null(self, raw):
        val, _u, _s = self._run({'status': 'success', 'data': {'result': [{'value': [0, raw]}]}})
        assert val is None

    def test_empty_result_is_null(self):
        assert self._run({'status': 'success', 'data': {'result': []}})[0] is None


# ── AMP discovery (R6.1) ───────────────────────────────────────────────────────


class _SM:
    def describe_cluster(self, ClusterName):
        return {'Orchestrator': {'Eks': {'ClusterArn': 'arn:aws:eks:r:1:cluster/eks-name'}}}


class _EKS:
    def __init__(self, config=None, exc=None):
        self.config, self.exc, self.calls = config, exc, []

    def describe_addon(self, clusterName, addonName):
        self.calls.append((clusterName, addonName))
        if self.exc:
            raise self.exc
        return {'addon': {'configurationValues': json.dumps(self.config)}}


class TestDiscoverAmp:
    def _obs(self):
        return target_manifest.observability('hyperpod-eks')

    def test_reads_the_endpoint_from_the_descriptor_key(self):
        eks = _EKS({'ampWorkspace': {'prometheusEndpoint': 'https://aps/ws-9'},
                    'amgWorkspace': {'workspaceName': 'g'}})
        url, amg, reason = gpu_metrics.discover_amp(self._obs(), 'hp', 'r', _SM(), eks)
        assert (url, amg, reason) == ('https://aps/ws-9', 'g', None)
        assert eks.calls == [('eks-name', self._obs()['amp_discovery']['addon'])]

    def test_addon_absent_gives_a_reason(self):
        class ResourceNotFoundException(Exception):
            pass
        url, _amg, reason = gpu_metrics.discover_amp(self._obs(), 'hp', 'r', _SM(),
                                                     _EKS(exc=ResourceNotFoundException('nope')))
        assert url is None and 'not installed' in reason

    def test_key_missing_gives_a_reason(self):
        url, _amg, reason = gpu_metrics.discover_amp(self._obs(), 'hp', 'r', _SM(), _EKS({'other': 1}))
        assert url is None and 'ampWorkspace' in reason

    def test_collect_for_target_without_addon_returns_nothing(self, capsys):
        class ResourceNotFoundException(Exception):
            pass
        start, end = _window()
        rec = _Recorder()
        out, used = gpu_metrics.collect_for_target(
            'hyperpod-eks', {'deployment': 'p', 'namespace': 'default'}, 'vllm', start, end, 'r',
            hp_cluster_name='hp', query_fn=rec, sm_client=_SM(),
            eks_client=_EKS(exc=ResourceNotFoundException('x')))
        assert (out, used) == ({}, None) and rec.calls == []
        assert 'AMP not available' in capsys.readouterr().err

    def test_collect_for_target_with_addon_reports_amp(self):
        start, end = _window()
        out, used = gpu_metrics.collect_for_target(
            'hyperpod-eks', {'deployment': 'p', 'namespace': 'default'}, 'vllm', start, end, 'r',
            hp_cluster_name='hp', query_fn=_Recorder(value=0.5), sm_client=_SM(),
            eks_client=_EKS({'ampWorkspace': {'prometheusEndpoint': 'https://aps/ws'}}))
        assert used == 'amp' and out['kv_cache_util_avg'] == 0.5


# ── Engine scrape parser + collector ───────────────────────────────────────────


class _FakeResp:
    def __init__(self, text):
        self._text = text.encode('utf-8')
        self.url = None

    def read(self):
        return self._text

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_TWO_SERIES = """\
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0"} 3.0
vllm:num_requests_running{engine="1"} 4.0
"""


@pytest.fixture(params=['prometheus_client', 'regex'])
def parser_mode(request):
    """Run parser tests with prometheus_client AND with the stdlib regex
    fallback (CI's pytest step does not install prometheus_client)."""
    if request.param == 'regex':
        with mock.patch.dict(sys.modules, {'prometheus_client': None, 'prometheus_client.parser': None}):
            yield request.param
    else:
        pytest.importorskip('prometheus_client')
        yield request.param


class TestParsePrometheusText:
    def test_label_sets_are_summed_not_last_wins(self, parser_mode):
        assert gpu_metrics._parse_prometheus_text(_TWO_SERIES)['vllm:num_requests_running'] == 7.0

    def test_real_vllm_sample_resolves_counters_and_never_created(self, parser_mode):
        parsed = gpu_metrics._parse_prometheus_text(_REAL_VLLM)
        decl = serve_manifest.metric_signals('vllm')['prefix_cache_hit_rate']
        queries = gpu_metrics._counter(parsed, decl['den'])
        hits = gpu_metrics._counter(parsed, decl['num'])
        assert queries is not None and hits is not None
        # A _created sample is a unix timestamp; it must never be read as the counter.
        created = [v for k, v in parsed.items() if k.endswith('_created')]
        assert created and all(queries != v for v in created)
        assert queries < 1e9


class TestCollectEngineMetrics:
    def _collect(self, text, engine='vllm'):
        seen = {}

        def fake(url, timeout=None):
            seen['url'] = url
            return _FakeResp(text)
        with mock.patch('urllib.request.urlopen', side_effect=fake):
            out = gpu_metrics.collect_engine_metrics('http://localhost:8080', engine)
        return out, seen.get('url')

    def test_real_vllm_sample_maps_every_declared_gauge(self):
        out, url = self._collect(_REAL_VLLM)
        assert url == 'http://localhost:8080' + serve_manifest.metrics_endpoint('vllm')['path']
        for key in ('kv_cache_util_avg', 'kv_cache_util_max', 'queue_depth_running_avg',
                    'queue_depth_waiting_avg', 'queue_depth_waiting_max'):
            assert key in out and math.isfinite(out[key])
        assert 'prefix_cache_hit_rate' in out['_counters']

    def test_ratio_from_one_scrape_is_counters_over_counters(self):
        text = ('vllm:prefix_cache_queries_total{e="0"} 1000.0\n'
                'vllm:prefix_cache_hits_total{e="0"} 250.0\n')
        out, _u = self._collect(text)
        assert out['prefix_cache_hit_rate'] == pytest.approx(0.25)
        assert out['_counters']['prefix_cache_hit_rate'] == [250.0, 1000.0]

    def test_zero_denominator_yields_no_rate(self):
        out, _u = self._collect('vllm:prefix_cache_queries_total 0\nvllm:prefix_cache_hits_total 0\n')
        assert 'prefix_cache_hit_rate' not in out

    def test_spec_decode_absent_when_not_enabled(self):
        out, _u = self._collect(_REAL_VLLM)
        assert 'spec_decode_acceptance_rate' not in out

    def test_sglang_gauge_ratio(self):
        names = {s: d['name'] for s, d in serve_manifest.metric_signals('sglang').items()}
        text = '\n'.join([f'{names["kv_cache_util"]} 0.55', f'{names["prefix_cache_hit_rate"]} 0.73',
                          f'{names["queue_depth_running"]} 12', f'{names["queue_depth_waiting"]} 6']) + '\n'
        out, _u = self._collect(text, 'sglang')
        assert out['kv_cache_util_avg'] == pytest.approx(0.55)
        assert out['prefix_cache_hit_rate'] == pytest.approx(0.73)
        assert out['queue_depth_running_avg'] == 12 and out['queue_depth_waiting_avg'] == 6

    def test_timeout_and_unknown_engine_are_empty(self):
        with mock.patch('urllib.request.urlopen', side_effect=TimeoutError('t')):
            assert gpu_metrics.collect_engine_metrics('http://x', 'vllm') == {}
        assert gpu_metrics.collect_engine_metrics('http://x', 'not-an-engine') == {}


# ── Sidecars (R6.3) ────────────────────────────────────────────────────────────


class TestSidecars:
    def _write(self, d, name, payload):
        p = d / name
        p.write_text(json.dumps(payload))
        return p

    def test_merge_sums_queue_and_averages_utilization_per_level(self, tmp_path):
        self._write(tmp_path, 'gpu_metrics-c4-0.json', {'queue_depth_running_avg': 2.0, 'kv_cache_util_avg': 0.2,
                                                        'kv_cache_util_max': 0.3, 'sample_count': 5})
        self._write(tmp_path, 'gpu_metrics-c4-1.json', {'queue_depth_running_avg': 3.0, 'kv_cache_util_avg': 0.4,
                                                        'kv_cache_util_max': 0.9, 'sample_count': 6, 'partial': True})
        self._write(tmp_path, 'gpu_metrics-c8-0.json', {'queue_depth_running_avg': 99.0})
        merged = gpu_metrics.merge_sidecars(gpu_metrics.sidecar_paths(str(tmp_path), 4))
        assert merged['queue_depth_running_avg'] == 5.0
        assert merged['kv_cache_util_avg'] == pytest.approx(0.3)
        assert merged['kv_cache_util_max'] == 0.9
        assert merged['sample_count'] == 11 and merged['partial'] is True and merged['pod_count'] == 2

    def test_no_sidecars_is_empty(self, tmp_path):
        assert gpu_metrics.merge_sidecars(gpu_metrics.sidecar_paths(str(tmp_path), 1)) == {}


class TestCliEntrypoint:
    def test_engine_metrics_subcommand_prints_json_without_counters(self, capsys):
        with mock.patch('urllib.request.urlopen', return_value=_FakeResp(_REAL_VLLM)):
            rc = gpu_metrics._main(['gpu_metrics.py', 'engine-metrics', 'http://localhost:8080', 'vllm'])
        out = json.loads(capsys.readouterr().out)
        assert rc == 0 and 'kv_cache_util_avg' in out and '_counters' not in out

    def test_merge_sidecars_subcommand(self, tmp_path, capsys):
        (tmp_path / 'gpu_metrics-c2-0.json').write_text(json.dumps({'queue_depth_waiting_avg': 1.0}))
        assert gpu_metrics._main(['g', 'merge-sidecars', str(tmp_path), '2']) == 0
        assert json.loads(capsys.readouterr().out)['queue_depth_waiting_avg'] == 1.0

    def test_bad_usage_returns_1(self):
        assert gpu_metrics._main(['gpu_metrics.py']) == 1
