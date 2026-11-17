# SPDX-License-Identifier: Apache-2.0

"""GPU + engine efficiency metrics for do/benchmark and do/metrics (BL086, Wave 9).

Every per-engine and per-target fact is DERIVED (ADR-008), never hardcoded here:

  * Engine metric names come from ``serve.d/<engine>/manifest.json``
    ``metric_signals`` (read via serve_manifest.metric_signals). vLLM exports raw
    ``vllm:*`` names; counters carry ``_total``; ratios are counter pairs.
  * The metrics store, label selector, histogram form and dashboard come from
    ``targets.d/<target>/manifest.json`` ``observability`` (target_manifest).

Stores (keyed by the descriptor's ``observability.store``):

  * ``cloudwatch-promql`` — SageMaker AI detailed observability. PromQL instant
    queries at ``https://monitoring.<region>.amazonaws.com/api/v1/query`` with
    SigV4 service ``monitoring``. (The old ``/prometheus/api/v1/query`` path is
    a 404.) Histograms are native (OTel exponential) — query the bare name.
  * ``amp`` — the HyperPod observability add-on's Amazon Managed Service for
    Prometheus workspace (``<prometheusEndpoint>/api/v1/query``, SigV4 ``aps``),
    discovered from the add-on configuration. Histograms are classic
    (``_bucket`` + ``le``). Gauges aggregate across ALL pods of the deployment.
  * ``none`` — no AWS-native store. The opt-in port-forward ``/metrics`` poller
    (phase2_poller.py) is the fallback where the descriptor says
    ``fallback: engine-scrape``.

DCGM GPU metric names are NVIDIA-standard and identical in both stores, so they
are one cross-cutting constant (DCGM_SIGNALS), not per-engine data.

Window semantics: every query is an instant query evaluated at the END of the
measured load window over ``[<window>s]`` (capped at 86 400 s, the PromQL range
limit). Counter-pair ratios use ``increase()`` over the window, never lifetime
counters. An empty result or NaN yields NO key (NULL column), never 0.

Non-fatal contract: metrics collection NEVER fails the benchmark. Errors yield
missing keys plus at most one stderr warning per store per call.

CLI entrypoints (for do/benchmark bash):

    python3 gpu_metrics.py engine-metrics <base_url> <engine>
    python3 gpu_metrics.py merge-sidecars <dir> <concurrency>
"""

import glob
import json
import math
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import serve_manifest  # noqa: E402
import target_manifest  # noqa: E402


# ── DCGM_SIGNALS — cross-cutting (NVIDIA-standard, both stores) ───────────────
# Verified live 2026-10-26 on CloudWatch PromQL (sharp-gpt-bot, realtime) and
# AMP (fresh-ai-ml, HyperPod). DCGM_FI_DEV_FB_USED is in MiB (21400 on a 24 GB
# A10G), not bytes.
DCGM_SIGNALS = {
    'gpu_utilization': 'DCGM_FI_DEV_GPU_UTIL',       # percent
    'gpu_memory_util': 'DCGM_FI_DEV_MEM_COPY_UTIL',  # percent
    'gpu_memory_used': 'DCGM_FI_DEV_FB_USED',        # MiB
}

# ── Column contract (MLCC Athena columns ← abstract signals) ──────────────────
# Each entry: (column, series_agg, time_agg). series_agg combines series
# (GPUs / pods / engine instances): queue depth is a SUM across pods, KV cache
# and GPU utilization an AVG (max for the *_max columns). time_agg is the
# *_over_time function over the window. Engine-neutral: the names behind each
# signal come from the manifests.
_GAUGE_COLUMNS = {
    'kv_cache_util': (('kv_cache_util_avg', 'avg', 'avg'), ('kv_cache_util_max', 'max', 'max')),
    'queue_depth_running': (('queue_depth_running_avg', 'sum', 'avg'),),
    'queue_depth_waiting': (('queue_depth_waiting_avg', 'sum', 'avg'),
                            ('queue_depth_waiting_max', 'sum', 'max')),
    # SGLang exposes prefix-cache hit rate as a gauge ratio.
    'prefix_cache_hit_rate': (('prefix_cache_hit_rate', 'avg', 'avg'),),
}
# Counter-pair ratio signals → column (same name).
_RATIO_COLUMNS = ('prefix_cache_hit_rate', 'spec_decode_acceptance_rate')
_DCGM_COLUMNS = {
    'gpu_utilization': (('gpu_utilization_avg', 'avg', 'avg'), ('gpu_utilization_max', 'max', 'max')),
    'gpu_memory_util': (('gpu_memory_util_avg', 'avg', 'avg'),),
    'gpu_memory_used': (('gpu_memory_used_avg_gb', 'avg', 'avg'),),
}
_MIB_PER_GB = 1024.0

# Store transport facts, keyed by the descriptor's observability.store value.
_STORE_SIGV4 = {'cloudwatch-promql': 'monitoring', 'amp': 'aps'}
_QUERY_PATH = '/api/v1/query'
MAX_WINDOW_SECONDS = 86400
_SUBQUERY_STEP_SECONDS = 15


def _derive_registry():
    """Derived view {engine: {signal: name | {'num', 'den'}}} of the manifests."""
    registry = {}
    try:
        engines = serve_manifest.list_engines()
    except Exception:
        engines = []
    for engine in engines:
        signals = serve_manifest.metric_signals(engine)
        if not signals:
            continue
        view = {}
        for signal, decl in signals.items():
            if decl.get('type') == 'ratio':
                view[signal] = {'num': decl.get('num'), 'den': decl.get('den')}
            else:
                view[signal] = decl.get('name')
        registry[engine] = view
    return registry


# Kept for existing callers: a DERIVED view, never edited by hand. Add or rename
# an engine metric in serve.d/<engine>/manifest.json metric_signals instead.
METRIC_REGISTRY = _derive_registry()


# ── PromQL query builders (pure; unit-tested) ──────────────────────────────────

_PLAIN_LABEL_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def _escape_value(value):
    return str(value).replace('\\', '\\\\').replace('"', '\\"')


def build_matchers(label_map, values):
    """Return PromQL label matchers for the roles that have a value.

    ``label_map`` is the descriptor's role → label map; ``values`` is role →
    runtime value. Dotted OTel labels (``aws.sagemaker.endpoint.name``) are
    single-quoted, as the CloudWatch PromQL dialect requires.
    """
    matchers = []
    for role, label in (label_map or {}).items():
        value = (values or {}).get(role)
        if value in (None, ''):
            continue
        name = label if _PLAIN_LABEL_RE.match(label) else f"'{label}'"
        matchers.append(f'{name}="{_escape_value(value)}"')
    return matchers


def _series(name, matchers):
    return '{' + ','.join([f'__name__="{name}"'] + list(matchers)) + '}'


def window_seconds(start_time, end_time):
    """Run window in whole seconds, clamped to [1, MAX_WINDOW_SECONDS]."""
    secs = int(math.ceil((end_time - start_time).total_seconds()))
    return max(1, min(secs, MAX_WINDOW_SECONDS))


def gauge_query(name, matchers, window, series_agg, time_agg):
    """Gauge over the window. A SUM across series is taken per instant before the
    time aggregation (subquery), so queue depth means 'total in flight'."""
    sel = _series(name, matchers)
    if series_agg == 'sum':
        return f'{time_agg}_over_time(sum({sel})[{window}s:{_SUBQUERY_STEP_SECONDS}s])'
    return f'{series_agg}({time_agg}_over_time({sel}[{window}s]))'


def ratio_query(num, den, matchers, window):
    """Counter-pair ratio over the window (R2.4): increase(num) / increase(den)."""
    return (f'sum(increase({_series(num, matchers)}[{window}s])) / '
            f'sum(increase({_series(den, matchers)}[{window}s]))')


def quantile_query(name, matchers, window, quantile, histogram_form):
    """histogram_quantile over the window for native (OTel) or classic histograms."""
    if histogram_form == 'classic':
        inner = f'sum by (le) (rate({_series(name + "_bucket", matchers)}[{window}s]))'
    else:
        inner = f'sum(rate({_series(name, matchers)}[{window}s]))'
    return f'histogram_quantile({quantile}, {inner})'


# ── Transport ──────────────────────────────────────────────────────────────────


def _sigv4_headers(method, url, region, service, payload, host):
    """Build SigV4 auth headers for a request using botocore credentials."""
    import botocore.session
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = botocore.session.get_session()
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError('no AWS credentials available for SigV4 signing')

    request = AWSRequest(
        method=method,
        url=url,
        data=payload,
        headers={'Host': host, 'Content-Type': 'application/x-www-form-urlencoded'},
    )
    SigV4Auth(credentials, service, region).add_auth(request)
    return dict(request.headers)


def store_base_url(store, region, amp_endpoint=None):
    """Base URL for a store (the query path is appended by the caller)."""
    if store == 'cloudwatch-promql':
        return f'https://monitoring.{region}.amazonaws.com'
    if store == 'amp':
        return (amp_endpoint or '').rstrip('/') or None
    return None


def _promql_instant_query(region, query, at_time, base_url=None, service='monitoring'):
    """Run one PromQL instant query; return a finite float or None.

    ``base_url`` defaults to the CloudWatch PromQL endpoint for ``region``. The
    path is always ``/api/v1/query``. Multiple result series are averaged (the
    builders aggregate, so this is normally one series). Empty result, NaN or
    ±Inf → None. Raises on transport / HTTP errors (the caller handles them).
    """
    import urllib.parse
    import urllib.request

    base = (base_url or store_base_url('cloudwatch-promql', region)).rstrip('/')
    url = base + _QUERY_PATH
    host = urllib.parse.urlparse(url).netloc

    params = {'query': query}
    if at_time is not None:
        params['time'] = str(int(at_time.timestamp()))
    payload = urllib.parse.urlencode(params)

    headers = _sigv4_headers('POST', url, region, service, payload, host)
    req = urllib.request.Request(url, data=payload.encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode('utf-8', errors='replace'))

    if body.get('status') != 'success':
        return None
    data = body.get('data', {})
    result = data.get('result', [])
    if data.get('resultType') == 'scalar' and isinstance(result, list) and len(result) == 2:
        result = [{'value': result}]
    values = []
    for series in result or []:
        val = series.get('value') if isinstance(series, dict) else None
        if val and len(val) == 2:
            try:
                f = float(val[1])
            except (ValueError, TypeError):
                continue
            if math.isfinite(f):
                values.append(f)
    if not values:
        return None
    return sum(values) / len(values)


def _warn(message):
    print(f'⚠️  {message}', file=sys.stderr)


# ── Store collection (Phase 1 realtime / HyperPod AMP) ─────────────────────────


def build_store_queries(engine, matchers, gpu_matchers, window):
    """Return [(column, query, transform)] for every signal this engine declares
    plus the DCGM GPU signals. ``transform`` converts the raw value (or None)."""
    queries = []
    for signal, metric in DCGM_SIGNALS.items():
        for column, s_agg, t_agg in _DCGM_COLUMNS[signal]:
            transform = (lambda v: v / _MIB_PER_GB) if signal == 'gpu_memory_used' else None
            queries.append((column, gauge_query(metric, gpu_matchers, window, s_agg, t_agg), transform))
    engine_signals = serve_manifest.metric_signals(engine) if engine else {}
    for signal, decl in engine_signals.items():
        kind = decl.get('type')
        if kind == 'ratio' and signal in _RATIO_COLUMNS:
            queries.append((signal, ratio_query(decl['num'], decl['den'], matchers, window), None))
        elif kind == 'gauge' and signal in _GAUGE_COLUMNS:
            for column, s_agg, t_agg in _GAUGE_COLUMNS[signal]:
                queries.append((column, gauge_query(decl['name'], matchers, window, s_agg, t_agg), None))
    return queries


def collect_store_signals(obs, values, engine, start_time, end_time, region,
                          amp_endpoint=None, query_fn=None):
    """Query a target's observability store over the run window.

    Args:
        obs: the target descriptor's ``observability`` block.
        values: role → runtime value for the selector roles (endpoint, variant,
            inference_component / deployment, namespace).
        engine: serve engine (MODEL_SERVER) whose metric_signals to query; None
            or an engine without signals → DCGM GPU signals only.
        start_time / end_time: datetimes of the measured load window.
        region: AWS region.
        amp_endpoint: the AMP workspace Prometheus endpoint (store amp).
        query_fn: injectable ``(region, query, at_time, base_url, service)``.

    Returns:
        dict of column → float for every query that returned data; {} when the
        store is ``none`` / unreachable. Never raises.
    """
    store = (obs or {}).get('store', 'none')
    service = _STORE_SIGV4.get(store)
    base = store_base_url(store, region, amp_endpoint)
    if not service or not base or start_time is None or end_time is None:
        return {}
    query = query_fn or _promql_instant_query
    window = window_seconds(start_time, end_time)
    matchers = build_matchers(obs.get('selector'), values)
    gpu_matchers = build_matchers(obs.get('gpu_selector') or obs.get('selector'), values)
    if not matchers:
        return {}

    out = {}
    for column, q, transform in build_store_queries(engine, matchers, gpu_matchers, window):
        try:
            value = query(region, q, end_time, base, service)
        except Exception as exc:  # noqa: BLE001 — non-fatal contract
            code = getattr(exc, 'code', None)
            if code in (400, 422):
                continue  # this one query is malformed for the store; keep going
            _warn(f'{store} metrics query failed ({code or type(exc).__name__}: {exc}); '
                  'GPU/engine columns for this run stay NULL')
            return out
        if value is None:
            continue
        out[column] = transform(value) if transform else value
    return out


def discover_amp(obs, hp_cluster_name, region, sm_client=None, eks_client=None):
    """Find the AMP workspace endpoint from the HyperPod observability add-on.

    Reads ``observability.amp_discovery`` (add-on name + dotted config key) from
    the descriptor. Returns ``(endpoint_url, amg_workspace_name, reason)``; the
    URL is None with a human-readable reason when the add-on or key is absent.
    """
    disc = (obs or {}).get('amp_discovery') or {}
    if not disc.get('addon') or not disc.get('endpoint_key'):
        return None, None, 'target declares no amp_discovery'
    if not hp_cluster_name:
        return None, None, 'HP_CLUSTER_NAME is not set'
    try:
        if sm_client is None or eks_client is None:
            import boto3
            sm_client = sm_client or boto3.client('sagemaker', region_name=region)
            eks_client = eks_client or boto3.client('eks', region_name=region)
        arn = (sm_client.describe_cluster(ClusterName=hp_cluster_name)
               .get('Orchestrator', {}).get('Eks', {}).get('ClusterArn') or '')
        eks_name = arn.rsplit('/', 1)[-1] if arn else ''
        if not eks_name:
            return None, None, f'HyperPod cluster {hp_cluster_name} has no EKS orchestrator'
        addon = eks_client.describe_addon(clusterName=eks_name, addonName=disc['addon']).get('addon', {})
        config = json.loads(addon.get('configurationValues') or '{}')
    except Exception as exc:  # noqa: BLE001 — absent add-on is a normal state
        name = type(exc).__name__
        if 'ResourceNotFound' in name or 'ResourceNotFound' in str(exc):
            return None, None, f"add-on {disc['addon']} is not installed"
        return None, None, f'add-on lookup failed ({name}: {exc})'

    def _dotted(obj, path):
        for part in path.split('.'):
            obj = obj.get(part) if isinstance(obj, dict) else None
        return obj

    endpoint = _dotted(config, disc['endpoint_key'])
    amg = _dotted(config, disc['amg_name_key']) if disc.get('amg_name_key') else None
    if not endpoint:
        return None, amg, f"add-on config has no {disc['endpoint_key']}"
    return endpoint, amg, None


def collect_for_target(target, values, engine, start_time, end_time, region,
                       hp_cluster_name=None, query_fn=None, sm_client=None, eks_client=None):
    """Store signals for a deployment target, resolving AMP when needed.

    Returns ``(signals, store_used)`` where ``store_used`` is the descriptor's
    store when it contributed at least one value, else None. Never raises.
    """
    try:
        obs = target_manifest.observability(target)
    except Exception:
        return {}, None
    store = obs.get('store', 'none')
    amp_endpoint = None
    if store == 'amp':
        amp_endpoint, _amg, reason = discover_amp(obs, hp_cluster_name, region, sm_client, eks_client)
        if not amp_endpoint:
            print(f'ℹ️  AMP not available: {reason}', file=sys.stderr)
            return {}, None
    signals = collect_store_signals(obs, values, engine, start_time, end_time, region,
                                    amp_endpoint=amp_endpoint, query_fn=query_fn)
    return signals, (store if signals else None)


# ── Engine /metrics scrape (fallback; HyperPod EKS / EKS opt-in) ───────────────


def _parse_prometheus_text(text):
    """Parse Prometheus text exposition into {metric_name: float}.

    Samples of the same name with different label sets are SUMMED (R6.2), so a
    multi-engine / multi-series gauge or counter reads as its total, not the
    last line. Counter samples are indexed under both ``<name>_total`` and the
    bare family name. ``_created`` / ``_bucket`` / ``_sum`` / ``_count``
    samples keep their own names and never overwrite the family value.
    """
    values = {}

    def _add(name, value):
        values[name] = values.get(name, 0.0) + value

    try:
        from prometheus_client.parser import text_string_to_metric_families

        for family in text_string_to_metric_families(text):
            for sample in family.samples:
                val = float(sample.value)
                if not math.isfinite(val):
                    continue
                _add(sample.name, val)
                if sample.name == family.name + '_total':
                    _add(family.name, val)
        return values
    except Exception:
        values = {}

    # name, optional {labels} (greedy to the last '}'), value, optional timestamp.
    line_re = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)(\s+-?\d+)?\s*$')
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = line_re.match(line)
        if not m:
            continue
        try:
            val = float(m.group(3))
        except ValueError:
            continue
        if not math.isfinite(val):
            continue
        name = m.group(1)
        _add(name, val)
        if name.endswith('_total'):
            _add(name[:-len('_total')], val)
    return values


def _counter(parsed, name):
    """Counter lookup tolerant of the exposition's _total suffix."""
    if name in parsed:
        return parsed[name]
    if name.endswith('_total') and name[:-len('_total')] in parsed:
        return parsed[name[:-len('_total')]]
    if name + '_total' in parsed:
        return parsed[name + '_total']
    return None


def collect_engine_metrics(base_url, engine, timeout=30):
    """GET the engine's metrics endpoint once and map its declared signals.

    The path comes from the manifest ``metrics_endpoint.path`` (R2.3); an engine
    without a metrics_endpoint or metric_signals yields {}.

    Returns point-in-time values: ``kv_cache_util_avg/_max``,
    ``queue_depth_running_avg``, ``queue_depth_waiting_avg/_max``, ratio values
    (``prefix_cache_hit_rate``, ``spec_decode_acceptance_rate``; for counter
    pairs this is the LIFETIME ratio of one scrape), plus ``_counters``
    {signal: [num, den]} so the poller can compute the ratio over the run window
    from the first and last sample. {} on any error (non-fatal contract).
    """
    try:
        signals = serve_manifest.metric_signals(engine)
        endpoint = serve_manifest.metrics_endpoint(engine) if signals else None
    except Exception:
        return {}
    if not signals or not endpoint or not endpoint.get('path'):
        return {}

    try:
        import urllib.request

        url = base_url.rstrip('/') + endpoint['path']
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            text = resp.read().decode('utf-8', errors='replace')
        parsed = _parse_prometheus_text(text)
    except Exception:
        return {}

    out = {}
    counters = {}
    for signal, decl in signals.items():
        kind = decl.get('type')
        if kind == 'gauge' and signal in _GAUGE_COLUMNS:
            value = parsed.get(decl['name'])
            if value is None:
                continue
            for column, _s, _t in _GAUGE_COLUMNS[signal]:
                out[column] = value
        elif kind == 'ratio' and signal in _RATIO_COLUMNS:
            num = _counter(parsed, decl['num'])
            den = _counter(parsed, decl['den'])
            if num is None or den is None:
                continue
            counters[signal] = [num, den]
            if den > 0:
                out[signal] = num / den
    if counters:
        out['_counters'] = counters
    return out


# ── Per-job / per-level sidecars (R6.3) ────────────────────────────────────────

# Merge rules across pods: queue depth is a total (sum); utilization and ratio
# signals are means; *_max of utilization is the max.
_SUM_KEYS = ('queue_depth_running_avg', 'queue_depth_waiting_avg', 'queue_depth_waiting_max')
_MAX_KEYS = ('kv_cache_util_max', 'gpu_utilization_max')
_MEAN_KEYS = ('kv_cache_util_avg', 'prefix_cache_hit_rate', 'spec_decode_acceptance_rate',
              'gpu_utilization_avg', 'gpu_memory_util_avg', 'gpu_memory_used_avg_gb')


def sidecar_paths(directory, concurrency):
    """Per-pod sidecar files for one level: gpu_metrics-c<level>-<pod>.json."""
    if not directory or concurrency is None:
        return []
    return sorted(glob.glob(os.path.join(directory, f'gpu_metrics-c{int(concurrency)}-*.json')))


def merge_sidecars(paths):
    """Merge per-pod poller outputs for one level into one signal dict."""
    docs = []
    for p in paths:
        try:
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict) and d:
                docs.append(d)
        except (OSError, ValueError):
            continue
    if not docs:
        return {}

    def _nums(key):
        return [float(d[key]) for d in docs
                if isinstance(d.get(key), (int, float)) and not isinstance(d.get(key), bool)]

    out = {}
    for key in _SUM_KEYS:
        vals = _nums(key)
        if vals:
            out[key] = sum(vals)
    for key in _MAX_KEYS:
        vals = _nums(key)
        if vals:
            out[key] = max(vals)
    for key in _MEAN_KEYS:
        vals = _nums(key)
        if vals:
            out[key] = sum(vals) / len(vals)
    out['sample_count'] = int(sum(_nums('sample_count')))
    out['partial'] = any(bool(d.get('partial')) for d in docs)
    out['pod_count'] = len(docs)
    out['metrics_source'] = 'engine_metrics_only'
    return out


# ── CLI entrypoint ─────────────────────────────────────────────────────────────


def _main(argv):
    if len(argv) >= 4 and argv[1] == 'engine-metrics':
        result = collect_engine_metrics(argv[2], argv[3])
        result.pop('_counters', None)
        print(json.dumps(result))
        return 0
    if len(argv) >= 4 and argv[1] == 'merge-sidecars':
        try:
            level = int(argv[3])
        except ValueError:
            print(json.dumps({"error": "concurrency must be an integer"}))
            return 1
        print(json.dumps(merge_sidecars(sidecar_paths(argv[2], level))))
        return 0
    print(json.dumps({"error": "usage: gpu_metrics.py engine-metrics <base_url> <engine> | "
                               "merge-sidecars <dir> <concurrency>"}))
    return 1


if __name__ == '__main__':
    sys.exit(_main(sys.argv))
