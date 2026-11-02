#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""do/metrics readout + native-dashboard pointer (Wave 9 R12, OQ-9.9).

Thin, read-only readout of the C4 diagnostic signals for a deployed endpoint,
over the last N minutes. Everything per-target comes from the descriptor's
``observability`` block and everything per-engine from the serve manifest's
``metric_signals`` (ADR-008); the PromQL builders are gpu_metrics.py's.

Subcommands:

    endpoint_metrics.py readout --target <t> --window <minutes> [--json]
        [--endpoint-name E] [--ic-name I] [--project P] [--namespace N]
        [--engine vllm] [--cluster C] [--region R]
    endpoint_metrics.py dashboard --target <t> [--endpoint-name E] [--cluster C] [--region R]

Readout lines (R12.1): server-side TTFT and e2e p50/p99, queue waiting avg/max,
running avg, KV-cache avg/max, GPU util avg, per-copy concurrency (realtime,
classic CloudWatch). A missing signal prints "no data", never 0.

Exit codes: 0 ok (including the R12.4 skip notice for targets without a
store); 2 usage (bad --window etc.); 3 unknown target.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import gpu_metrics  # noqa: E402
import serve_manifest  # noqa: E402
import target_manifest  # noqa: E402

DEFAULT_WINDOW_MINUTES = 15
MAX_WINDOW_MINUTES = 1440  # PromQL range selectors are capped at 24 h.

NO_DATA = 'no data'


def parse_window(value) -> int:
    """--window in minutes: integer 1..1440, else ValueError (usage, exit 2)."""
    try:
        minutes = int(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError(f'--window must be an integer number of minutes (got {value!r})')
    if minutes < 1 or minutes > MAX_WINDOW_MINUTES:
        raise ValueError(f'--window must be between 1 and {MAX_WINDOW_MINUTES} minutes (got {minutes})')
    return minutes


def selector_values(obs: dict, endpoint=None, ic=None, project=None, namespace=None) -> dict:
    """Role → value for the descriptor selector (roles not in the selector are ignored)."""
    roles = {'endpoint': endpoint, 'inference_component': ic,
             'deployment': project, 'namespace': namespace}
    return {r: v for r, v in roles.items() if v and r in (obs.get('selector') or {})}


def build_readout_queries(obs: dict, values: dict, engine, window_s: int) -> list:
    """[(label, key, query, unit)] — the R12.1 lines, from manifests + descriptor."""
    form = obs.get('histogram_form', 'native')
    m = gpu_metrics.build_matchers(obs.get('selector'), values)
    gm = gpu_metrics.build_matchers(obs.get('gpu_selector') or obs.get('selector'), values)
    signals = serve_manifest.metric_signals(engine) if engine else {}
    rows = []

    def _hist(signal, label):
        decl = signals.get(signal)
        for q, tag in ((0.5, 'p50'), (0.99, 'p99')):
            key = f'{signal}_{tag}'
            if decl and decl.get('type') == 'histogram':
                rows.append((f'{label} {tag}', key,
                             gpu_metrics.quantile_query(decl['name'], m, window_s, q, form), 'ms'))
            else:
                rows.append((f'{label} {tag}', key, None, 'ms'))

    def _gauge(signal, label, series_agg, time_agg, key):
        decl = signals.get(signal)
        q = (gpu_metrics.gauge_query(decl['name'], m, window_s, series_agg, time_agg)
             if decl and decl.get('type') == 'gauge' else None)
        rows.append((label, key, q, ''))

    _hist('ttft_seconds', 'TTFT (server)')
    _hist('e2e_seconds', 'E2E latency (server)')
    _gauge('queue_depth_waiting', 'Queue waiting avg', 'sum', 'avg', 'queue_waiting_avg')
    _gauge('queue_depth_waiting', 'Queue waiting max', 'sum', 'max', 'queue_waiting_max')
    _gauge('queue_depth_running', 'Running avg', 'sum', 'avg', 'queue_running_avg')
    _gauge('kv_cache_util', 'KV cache avg', 'avg', 'avg', 'kv_cache_avg')
    _gauge('kv_cache_util', 'KV cache max', 'max', 'max', 'kv_cache_max')
    rows.append(('GPU util avg', 'gpu_util_avg',
                 gpu_metrics.gauge_query(gpu_metrics.DCGM_SIGNALS['gpu_utilization'], gm, window_s, 'avg', 'avg'),
                 '%'))
    return rows


def copy_concurrency(obs: dict, ic, start, end, region, cw_client=None):
    """Per-copy concurrency (avg, max) from classic CloudWatch GetMetricData,
    per the descriptor's ``copy_concurrency`` declaration. (None, None) when
    absent / no IC / no datapoints."""
    decl = obs.get('copy_concurrency')
    if not decl or not ic:
        return None, None
    try:
        if cw_client is None:
            import boto3
            cw_client = boto3.client('cloudwatch', region_name=region)
        period = max(60, int((end - start).total_seconds()) // 60 * 60 or 60)
        metric = {'Namespace': decl['namespace'], 'MetricName': decl['metric'],
                  'Dimensions': [{'Name': decl['dimension'], 'Value': ic}]}
        resp = cw_client.get_metric_data(
            StartTime=start, EndTime=end,
            MetricDataQueries=[
                {'Id': 'avg', 'MetricStat': {'Metric': metric, 'Period': period, 'Stat': 'Average'}},
                {'Id': 'mx', 'MetricStat': {'Metric': metric, 'Period': period, 'Stat': 'Maximum'}},
            ])
        by_id = {r['Id']: r.get('Values') or [] for r in resp.get('MetricDataResults', [])}
        avg_vals, max_vals = by_id.get('avg') or [], by_id.get('mx') or []
        avg = sum(avg_vals) / len(avg_vals) if avg_vals else None
        mx = max(max_vals) if max_vals else None
        return avg, mx
    except Exception:  # noqa: BLE001 — readout is best-effort
        return None, None


def fmt_value(value, unit='') -> str:
    """Human formatting; None → 'no data' (never 0)."""
    if value is None:
        return NO_DATA
    if unit == 'ms':
        return f'{value * 1000.0:.1f} ms'
    if unit == '%':
        return f'{value:.1f} %'
    return f'{value:.3g}' if abs(value) < 1000 else f'{value:.0f}'


# ── Dashboard pointer (R12.2) ──────────────────────────────────────────────────


def dashboard_line(target: str, region: str, endpoint=None, cluster=None,
                   sm_client=None, eks_client=None, grafana_client=None) -> str:
    """One line naming the target's native AWS dashboard.

    Only API-returned URLs are printed (the AMG workspace endpoint from
    ``grafana:ListWorkspaces``); console locations are printed as a path, not an
    unverified deep link. '' when the target declares no dashboard.
    """
    try:
        obs = target_manifest.observability(target)
    except Exception:
        return ''
    kind = obs.get('dashboard')
    if kind == 'sagemaker-ai-insights':
        scope = f', endpoint {endpoint}' if endpoint else ''
        return f'Dashboard: CloudWatch console → Insights → SageMaker AI ({region}{scope})'
    if kind == 'hyperpod-amg':
        amp, amg_name, reason = gpu_metrics.discover_amp(obs, cluster, region, sm_client, eks_client)
        if not amp and not amg_name:
            return f'Dashboard: HyperPod observability not available ({reason})'
        if amg_name:
            try:
                if grafana_client is None:
                    import boto3
                    grafana_client = boto3.client('grafana', region_name=region)
                for ws in grafana_client.list_workspaces().get('workspaces', []):
                    if ws.get('name') == amg_name and ws.get('endpoint'):
                        return f"Dashboard: Amazon Managed Grafana https://{ws['endpoint']} (workspace {amg_name})"
            except Exception:  # noqa: BLE001
                pass
        ws_id = amp.rstrip('/').rsplit('/', 1)[-1] if amp else 'unknown'
        missing = f" (AMG workspace '{amg_name}' not found)" if amg_name else ''
        return f'Dashboard: HyperPod observability AMP workspace {ws_id}{missing}'
    return ''


# ── Readout ────────────────────────────────────────────────────────────────────


def skip_notice(target: str, obs: dict) -> str:
    """R12.4 notice for targets without an AWS-native store."""
    hint = ''
    if obs.get('fallback') == 'engine-scrape':
        hint = (' Engine metrics are collected during do/benchmark when '
                'HP_BENCHMARK_METRICS_ENABLED=true (port-forward scrape).')
    return (f'ℹ️  do/metrics: skipped — {target} has no AWS-native metrics store '
            f"(observability.store: {obs.get('store', 'none')}).{hint}")


def readout(target, window_minutes, region, endpoint=None, ic=None, project=None, namespace=None,
            engine=None, cluster=None, now=None, query_fn=None, cw_client=None):
    """Compute the readout. Returns {'status': 'ok'|'skipped', 'lines': [...], ...}."""
    obs = target_manifest.observability(target)
    store = obs.get('store', 'none')
    if store == 'none':
        return {'status': 'skipped', 'target': target, 'reason': skip_notice(target, obs)}

    end = now or datetime.now(timezone.utc)
    start = end - timedelta(minutes=window_minutes)
    window_s = gpu_metrics.window_seconds(start, end)
    values = selector_values(obs, endpoint, ic, project, namespace)
    lines, note = [], None

    base, service = None, None
    if store == 'amp':
        base, _amg, reason = gpu_metrics.discover_amp(obs, cluster, region)
        service = 'aps'
        if not base:
            note = f'AMP not available: {reason}'
    else:
        base = gpu_metrics.store_base_url(store, region)
        service = 'monitoring'
    if not values:
        note = note or 'no endpoint / deployment configured for the selector'

    query = query_fn or gpu_metrics._promql_instant_query
    failed = False
    for label, key, q, unit in build_readout_queries(obs, values, engine, window_s):
        value = None
        if q and base and values and not failed:
            try:
                value = query(region, q, end, base, service)
            except Exception as exc:  # noqa: BLE001 — one warning, keep printing rows
                failed = True
                note = f'{store} query failed ({getattr(exc, "code", None) or type(exc).__name__})'
        lines.append({'label': label, 'key': key, 'value': value, 'unit': unit})

    if obs.get('copy_concurrency'):
        avg, mx = copy_concurrency(obs, ic, start, end, region, cw_client)
        lines.append({'label': 'Per-copy concurrency avg', 'key': 'copy_concurrency_avg', 'value': avg, 'unit': ''})
        lines.append({'label': 'Per-copy concurrency max', 'key': 'copy_concurrency_max', 'value': mx, 'unit': ''})

    return {'status': 'ok', 'target': target, 'store': store, 'window_minutes': window_minutes,
            'start': start.isoformat(), 'end': end.isoformat(), 'lines': lines, 'note': note}


def render(result: dict, dashboard: str = '') -> str:
    if result.get('status') == 'skipped':
        return result['reason']
    out = [f"📈 Endpoint metrics — last {result['window_minutes']} min ({result['store']})", '']
    for line in result['lines']:
        out.append(f"   {line['label']:<28} {fmt_value(line['value'], line['unit'])}")
    if result.get('note'):
        out.append('')
        out.append(f"   ⚠️  {result['note']}")
    if dashboard:
        out.append('')
        out.append(f'   {dashboard}')
    return '\n'.join(out)


def _parser():
    p = argparse.ArgumentParser(prog='endpoint_metrics.py', description=__doc__.split('\n')[0])
    sub = p.add_subparsers(dest='cmd')
    for name in ('readout', 'dashboard'):
        sp = sub.add_parser(name)
        sp.add_argument('--target', required=True)
        sp.add_argument('--region', default=os.environ.get('AWS_REGION', ''))
        sp.add_argument('--endpoint-name', default=None)
        sp.add_argument('--cluster', default=None)
        if name == 'readout':
            sp.add_argument('--window', default=str(DEFAULT_WINDOW_MINUTES))
            sp.add_argument('--ic-name', default=None)
            sp.add_argument('--project', default=None)
            sp.add_argument('--namespace', default=None)
            sp.add_argument('--engine', default=None)
            sp.add_argument('--json', action='store_true')
    return p


def main(argv=None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    if not args.cmd:
        parser.print_usage(sys.stderr)
        return 2
    try:
        target = target_manifest.resolve_target(args.target)
        target_manifest.read_manifest(target)
    except Exception as exc:  # noqa: BLE001
        print(f'❌ Unknown target {args.target!r}: {exc}', file=sys.stderr)
        return 3

    if args.cmd == 'dashboard':
        line = dashboard_line(target, args.region, args.endpoint_name, args.cluster)
        if line:
            print(line)
        return 0

    try:
        minutes = parse_window(args.window)
    except ValueError as exc:
        print(f'❌ {exc}', file=sys.stderr)
        print('   Usage: ./do/metrics [--window <minutes 1-1440>] [--target <target>]', file=sys.stderr)
        return 2

    result = readout(target, minutes, args.region, args.endpoint_name, args.ic_name, args.project,
                     args.namespace, args.engine, args.cluster)
    if args.json:
        print(json.dumps(result))
        return 0
    dash = '' if result.get('status') == 'skipped' else dashboard_line(
        target, args.region, args.endpoint_name, args.cluster)
    print(render(result, dash))
    return 0


if __name__ == '__main__':
    sys.exit(main())
