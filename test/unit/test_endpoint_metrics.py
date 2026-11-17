# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 9 R12 — endpoint_metrics.py (the do/metrics readout + dashboard pointer).

Stubbed clients only; no network.
"""

import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_LIB = os.path.join(_REPO, 'templates', 'do', 'lib', 'python')
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
_spec = importlib.util.spec_from_file_location('endpoint_metrics', os.path.join(_LIB, 'endpoint_metrics.py'))
em = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(em)

import serve_manifest  # noqa: E402
import target_manifest  # noqa: E402

_NOW = datetime(2026, 10, 23, 19, 26, 30, tzinfo=timezone.utc)


class TestWindow:
    @pytest.mark.parametrize('raw,expected', [('15', 15), (1, 1), ('1440', 1440)])
    def test_valid(self, raw, expected):
        assert em.parse_window(raw) == expected

    @pytest.mark.parametrize('raw', ['0', '1441', '-5', 'abc', '', '1.5', None])
    def test_invalid(self, raw):
        with pytest.raises(ValueError):
            em.parse_window(raw)

    def test_cli_bad_window_exits_2(self, capsys):
        assert em.main(['readout', '--target', 'realtime-inference', '--window', '0']) == 2
        assert 'Usage' in capsys.readouterr().err

    def test_cli_unknown_target_exits_3(self):
        assert em.main(['readout', '--target', 'no-such-target']) == 3


class TestFormatting:
    def test_none_is_no_data_never_zero(self):
        assert em.fmt_value(None) == 'no data'
        assert em.fmt_value(None, 'ms') == 'no data'
        assert em.fmt_value(0.0) != 'no data'

    def test_seconds_render_as_ms(self):
        assert em.fmt_value(0.0291, 'ms') == '29.1 ms'


class TestSkip:
    def test_every_store_less_target_is_skipped_with_reason(self):
        for target in target_manifest.list_targets():
            obs = target_manifest.observability(target)
            result = em.readout(target, 15, 'us-west-2', now=_NOW, query_fn=lambda *a: pytest.fail('queried'))
            if obs['store'] == 'none':
                assert result['status'] == 'skipped'
                assert target in result['reason'] and 'store' in result['reason']
            else:
                assert result['status'] == 'ok'


class _CW:
    def __init__(self, avg, mx):
        self.avg, self.mx, self.calls = avg, mx, []

    def get_metric_data(self, **kw):
        self.calls.append(kw)
        return {'MetricDataResults': [{'Id': 'avg', 'Values': self.avg}, {'Id': 'mx', 'Values': self.mx}]}


class TestReadout:
    def test_realtime_lines_queries_and_copy_concurrency(self):
        seen = []

        def q(region, query, at, base, service):
            seen.append((query, at, base, service))
            return 0.05 if 'histogram_quantile' in query else 2.0
        cw = _CW([1.0, 3.0], [4.0, 6.0])
        r = em.readout('realtime-inference', 10, 'us-west-2', endpoint='ep', ic='ic', engine='vllm',
                       now=_NOW, query_fn=q, cw_client=cw)
        by_key = {line['key']: line for line in r['lines']}
        assert by_key['ttft_seconds_p50']['value'] == 0.05
        assert by_key['copy_concurrency_avg']['value'] == 2.0 and by_key['copy_concurrency_max']['value'] == 6.0
        decl = target_manifest.observability('realtime-inference')['copy_concurrency']
        metric = cw.calls[0]['MetricDataQueries'][0]['MetricStat']['Metric']
        assert metric['MetricName'] == decl['metric'] and metric['Dimensions'][0] == {
            'Name': decl['dimension'], 'Value': 'ic'}
        assert all(s == 'monitoring' and at == _NOW for _q, at, _b, s in seen)
        ttft = serve_manifest.metric_signals('vllm')['ttft_seconds']['name']
        assert any(f'__name__="{ttft}"' in s[0] and '_bucket' not in s[0] for s in seen), 'native histogram'

    def test_engine_without_histograms_prints_no_data(self):
        r = em.readout('realtime-inference', 5, 'us-west-2', endpoint='ep', engine='sglang', now=_NOW,
                       query_fn=lambda *a: 1.0, cw_client=_CW([], []))
        by_key = {line['key']: line for line in r['lines']}
        assert by_key['ttft_seconds_p99']['value'] is None  # sglang declares no histogram names
        assert by_key['copy_concurrency_avg']['value'] is None  # no IC → no per-copy metric
        assert 'no data' in em.render(r)

    def test_query_failure_keeps_rows_and_notes_once(self):
        def boom(*a):
            raise RuntimeError('no AWS credentials available for SigV4 signing')
        r = em.readout('realtime-inference', 5, 'us-west-2', endpoint='ep', engine='vllm', now=_NOW,
                       query_fn=boom, cw_client=_CW([], []))
        assert all(line['value'] is None for line in r['lines'])
        assert 'query failed' in r['note']

    def test_hyperpod_uses_amp_classic_histograms(self, monkeypatch):
        monkeypatch.setattr(em.gpu_metrics, 'discover_amp', lambda *a, **k: ('https://aps/ws-1', None, None))
        seen = []
        em.readout('hyperpod-eks', 5, 'us-west-2', project='proj', namespace='default', engine='vllm',
                   cluster='hp', now=_NOW, query_fn=lambda *a: seen.append(a) or 1.0)
        assert seen and all(a[3] == 'https://aps/ws-1' and a[4] == 'aps' for a in seen)
        assert any('_bucket' in a[1] and 'by (le)' in a[1] for a in seen), 'classic histograms on AMP'
        assert any('resource_name="proj"' in a[1] for a in seen)


class _G:
    def __init__(self, workspaces):
        self.ws = workspaces

    def list_workspaces(self):
        return {'workspaces': self.ws}


class TestDashboard:
    def test_realtime_is_a_console_path_not_a_url(self):
        line = em.dashboard_line('realtime-inference', 'us-west-2', endpoint='ep')
        assert line.startswith('Dashboard: CloudWatch console')
        assert 'http' not in line

    def test_hyperpod_prints_the_api_returned_amg_endpoint(self, monkeypatch):
        monkeypatch.setattr(em.gpu_metrics, 'discover_amp', lambda *a, **k: ('https://aps/ws-1', 'g1', None))
        line = em.dashboard_line('hyperpod-eks', 'us-west-2', cluster='hp',
                                 grafana_client=_G([{'name': 'g1', 'endpoint': 'g-abc.grafana-workspace.example'}]))
        assert 'https://g-abc.grafana-workspace.example' in line

    def test_hyperpod_falls_back_to_the_amp_workspace_id(self, monkeypatch):
        monkeypatch.setattr(em.gpu_metrics, 'discover_amp', lambda *a, **k: ('https://aps/workspaces/ws-1', 'g1', None))
        line = em.dashboard_line('hyperpod-eks', 'us-west-2', cluster='hp', grafana_client=_G([]))
        assert 'ws-1' in line and "'g1' not found" in line and 'https://' not in line

    def test_hyperpod_without_addon_says_why(self, monkeypatch):
        monkeypatch.setattr(em.gpu_metrics, 'discover_amp', lambda *a, **k: (None, None, 'add-on x is not installed'))
        assert 'not installed' in em.dashboard_line('hyperpod-eks', 'us-west-2', cluster='hp')

    def test_store_less_targets_print_nothing(self):
        for target in target_manifest.list_targets():
            if not target_manifest.observability(target).get('dashboard'):
                assert em.dashboard_line(target, 'us-west-2') == ''

    def test_cli_dashboard(self, capsys):
        assert em.main(['dashboard', '--target', 'realtime-inference', '--region', 'us-west-2']) == 0
        assert 'CloudWatch console' in capsys.readouterr().out

    def test_cli_json_skip(self, capsys):
        assert em.main(['readout', '--target', 'eks', '--json']) == 0
        assert json.loads(capsys.readouterr().out)['status'] == 'skipped'


class TestSignalConsumers:
    """R14.2: every signal a serve manifest declares is consumed by a query
    builder (benchmark store queries or the do/metrics readout) — a declared but
    unread signal, or a renamed key, fails here instead of silently dropping."""

    def test_every_declared_signal_is_queried(self):
        engines = [e for e in serve_manifest.list_engines() if serve_manifest.metric_signals(e)]
        assert engines
        for target in target_manifest.list_targets():
            obs = target_manifest.observability(target)
            if obs['store'] == 'none':
                continue
            values = {role: 'x' for role in obs['selector']}
            for engine in engines:
                matchers = em.gpu_metrics.build_matchers(obs['selector'], values)
                queries = [q for _c, q, _t in em.gpu_metrics.build_store_queries(engine, matchers, matchers, 60)]
                queries += [q for _l, _k, q, _u in em.build_readout_queries(obs, values, engine, 60) if q]
                text = ' '.join(queries)
                for signal, decl in serve_manifest.metric_signals(engine).items():
                    for name in (decl.get('name'), decl.get('num'), decl.get('den')):
                        if name:
                            assert f'"{name}' in text, f'{engine}.{signal} ({name}) has no consumer on {target}'
