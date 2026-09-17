# SPDX-License-Identifier: Apache-2.0

"""GPU efficiency metrics collection for do/benchmark (BL086).

Single engine-neutral place to gather GPU efficiency signals from two sources:

  * Phase 1 — CloudWatch via SageMaker AI detailed observability (GA), built on
    an AWS-managed OTel collector. Available for all engines and all targets,
    queried post-run. Per the BL081 spike, the OTel collector re-publishes both
    DCGM GPU-health metrics and native vLLM/SGLang engine metrics (KV cache,
    queue depth, batch size, TTFT/ITL/TPS) under OTel metric names
    (``KVCacheUtilization``, ``QueueDepth``, ``BatchSize``, ``TotalTPS``,
    ``TTFT``, ``ITL``) — NOT the raw ``vllm:``/``sglang:`` Prometheus names —
    queryable via PromQL at ``https://monitoring.<region>.amazonaws.com`` with
    SigV4. This is NOT the classic ``GetMetricData`` API on the
    ``/aws/sagemaker/Endpoints`` namespace. See collect_cloudwatch().
  * Phase 2 — Engine ``/metrics`` (Prometheus text) — KV cache utilization,
    prefix cache hit rate, and queue depth. HyperPod EKS only, opt-in, scraped
    via a port-forward after the run. Uses the raw ``vllm:``/``sglang:`` names
    from METRIC_REGISTRY. See collect_engine_metrics().

Prefix cache hit rate is available ONLY via the Phase 2 engine ``/metrics``
scrape; SageMaker detailed observability does not forward it to CloudWatch, so
Phase 1 never populates it.

METRIC_REGISTRY is the single source of truth mapping abstract signal names to
engine-specific Prometheus metric names for the Phase 2 ``/metrics`` scrape; a
new engine is added by extending it. The Phase 1 CloudWatch path uses the
distinct OTel metric names (see OTEL_METRIC_NAMES), not METRIC_REGISTRY.

Non-fatal contract (design.md § Error Handling): metrics collection NEVER fails
the benchmark. Any error/timeout → an empty dict, so the benchmark result is
still written and the corresponding Athena columns become NULL.

CLI entrypoint (for do/benchmark bash to call):

    python3 gpu_metrics.py engine-metrics <base_url> <engine>

prints the collected engine-metrics dict as JSON to stdout.
"""

import json
import sys


# ── METRIC_REGISTRY — single source of truth (Phase 2 engine /metrics scrape) ─
#
# Raw Prometheus metric names exposed on the engine ``/metrics`` endpoint, used
# by the Phase 2 port-forward scrape (collect_engine_metrics). Verified by the
# BL081 spike against the pinned catalog versions: vLLM 0.25.x
# (0.24.0/0.25.0/0.25.1) and SGLang 0.5.x (0.5.13/0.5.14/0.5.15). No renames
# occurred in those windows. A new engine is added by extending this dict.
#
# NOTE: These are NOT the names used by the Phase 1 CloudWatch path. SageMaker
# detailed observability re-publishes these under OTel names (see
# OTEL_METRIC_NAMES). Prefix cache hit rate has no CloudWatch equivalent and is
# collected ONLY here in Phase 2.
METRIC_REGISTRY = {
    'vllm': {
        # V1 engine canonical KV cache utilization gauge (0-1). NOT the Grafana
        # alias vllm:gpu_cache_usage_perc.
        'kv_cache_util': 'vllm:kv_cache_usage_perc',
        # Prefix cache is a COUNTER PAIR on 0.25.x — hit_rate = hits / queries,
        # computed in collect_engine_metrics (there is no single hit-rate gauge).
        'prefix_cache_queries': 'vllm:prefix_cache_queries',
        'prefix_cache_hits': 'vllm:prefix_cache_hits',
        'queue_depth_running': 'vllm:num_requests_running',
        'queue_depth_waiting': 'vllm:num_requests_waiting',
    },
    'sglang': {
        'kv_cache_util': 'sglang:token_usage',             # Gauge 0-1 (requires --enable-metrics)
        'prefix_cache_hit_rate': 'sglang:cache_hit_rate',  # Gauge 0-1 — already a computed ratio, not a counter pair
        'queue_depth_running': 'sglang:num_running_reqs',  # verified on 0.5.x (BL081)
        'queue_depth_waiting': 'sglang:num_queue_reqs',    # verified on 0.5.x (BL081)
    },
    # TRT-LLM, DJL/LMI: add as they are verified. These frameworks do NOT emit
    # engine metrics to CloudWatch detailed observability (Phase 1 yields DCGM
    # GPU metrics only for them).
}


# ── OTEL_METRIC_NAMES — Phase 1 CloudWatch (SageMaker detailed observability) ──
#
# SageMaker AI detailed observability re-publishes engine + DCGM metrics under
# these OTel metric names, queried via PromQL at monitoring.<region>.amazonaws.com
# (SigV4). Confirmed by the BL081 spike. Engine metrics (KVCacheUtilization,
# QueueDepth, BatchSize, TotalTPS, TTFT, ITL) are forwarded for vLLM/SGLang only;
# DCGM GPU metrics are available on all GPU endpoints regardless of framework.
# Prefix cache hit rate is intentionally absent — it is /metrics-only (Phase 2).
OTEL_METRIC_NAMES = {
    # DCGM GPU health (all GPU endpoints).
    'gpu_utilization': 'DCGM_FI_DEV_GPU_UTIL',          # percent
    'gpu_memory_util': 'DCGM_FI_DEV_MEM_COPY_UTIL',     # percent
    'gpu_memory_used_bytes': 'DCGM_FI_DEV_FB_USED',     # framebuffer bytes → GB
    # Engine metrics (vLLM/SGLang only).
    'kv_cache_util': 'KVCacheUtilization',
    'queue_depth_waiting': 'QueueDepth',
    'queue_depth_running': 'BatchSize',
}


# ── CloudWatch collection (Phase 1, all engines/targets) ───────────────────────


def _sigv4_headers(method, url, region, service, payload, host):
    """Build SigV4 auth headers for a request using botocore credentials.

    Returns a dict of headers (including Authorization) or raises on failure.
    Kept separate so the query function stays readable and testable.
    """
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


def _promql_instant_query(region, query, at_time):
    """Run a single PromQL instant query against SageMaker detailed observability.

    Queries the AWS-managed OTel metrics store at
    ``https://monitoring.<region>.amazonaws.com/prometheus/api/v1/query`` with
    SigV4. Returns the scalar float value of the first result series, or None if
    the query yields no data. Raises on transport/HTTP errors (caller handles).
    """
    import urllib.parse
    import urllib.request

    host = f'monitoring.{region}.amazonaws.com'
    path = '/prometheus/api/v1/query'
    url = f'https://{host}{path}'

    params = {'query': query}
    if at_time is not None:
        # PromQL instant query accepts a unix timestamp for the evaluation time.
        params['time'] = str(int(at_time.timestamp()))
    payload = urllib.parse.urlencode(params)

    # SigV4 service for the SageMaker detailed observability PromQL endpoint is
    # 'monitoring' (per AWS docs), NOT 'aps'/Amazon Managed Prometheus — the
    # metrics are stored natively in CloudWatch, not AMP.
    headers = _sigv4_headers('POST', url, region, 'monitoring', payload, host)
    req = urllib.request.Request(url, data=payload.encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode('utf-8', errors='replace'))

    if body.get('status') != 'success':
        return None
    result = body.get('data', {}).get('result', [])
    if not result:
        return None
    # Instant vector: each entry has 'value' = [timestamp, "float-as-string"].
    values = []
    for series in result:
        val = series.get('value')
        if val and len(val) == 2:
            try:
                values.append(float(val[1]))
            except (ValueError, TypeError):
                continue
    if not values:
        return None
    # Aggregate across series (e.g. per-GPU) by mean; callers that need max use
    # a max_over_time PromQL query instead.
    return sum(values) / len(values)


def collect_cloudwatch(endpoint_name, variant_name, ic_name, start_time, end_time, region):
    """Query SageMaker AI detailed observability (OTel) for GPU + engine signals.

    Uses PromQL over the AWS-managed OTel metrics store at
    ``https://monitoring.<region>.amazonaws.com`` (SigV4), NOT the classic
    ``GetMetricData`` API. Per the BL081 spike, the OTel collector re-publishes:

      * DCGM GPU health (all GPU endpoints): ``DCGM_FI_DEV_GPU_UTIL`` (%),
        ``DCGM_FI_DEV_MEM_COPY_UTIL`` (%), ``DCGM_FI_DEV_FB_USED`` (bytes → GB).
      * Native engine metrics (vLLM/SGLang only): ``KVCacheUtilization``,
        ``QueueDepth`` (waiting), ``BatchSize`` (running).

    Prefix cache hit rate is NOT forwarded to CloudWatch (Phase 2 /metrics only).

    Prerequisites (user-provisioned, not enforced here): the endpoint config has
    ``EnableDetailedObservability`` + BYOC ``ContainerMetricsConfig`` set, and the
    account has OTel enrichment enabled (``aws cloudwatch start-otel-enrichment``).
    When these are absent, queries return no data → keys are simply omitted.

    Args:
        endpoint_name: SageMaker endpoint name (PromQL label filter).
        variant_name:  Production variant name (e.g. 'AllTraffic').
        ic_name:       Inference component name, or '' / None if not IC-based.
        start_time:    datetime — start of the benchmark run window.
        end_time:      datetime — end of the benchmark run window.
        region:        AWS region.

    Returns:
        dict with any of ``gpu_utilization_avg``, ``gpu_utilization_max``,
        ``gpu_memory_used_avg_gb``, ``gpu_memory_util_avg``, ``kv_cache_util_avg``,
        ``kv_cache_util_max``, ``queue_depth_running_avg``,
        ``queue_depth_waiting_avg``, ``queue_depth_waiting_max`` when available;
        an empty dict ``{}`` on ANY error (non-fatal contract).
    """
    try:
        # Build a PromQL label matcher scoping to this endpoint / variant / IC.
        # SageMaker detailed observability uses dotted OTel resource labels that
        # must be single-quoted in PromQL (per AWS docs), NOT CloudWatch
        # dimension names like EndpointName.
        labels = [f"'aws.sagemaker.endpoint.name'=\"{endpoint_name}\""]
        if variant_name:
            labels.append(f"'aws.sagemaker.variant.name'=\"{variant_name}\"")
        if ic_name:
            labels.append(f"'aws.sagemaker.inference_component.name'=\"{ic_name}\"")
        selector = '{' + ','.join(labels) + '}'

        # Range over the benchmark window for avg/max aggregation.
        window_secs = max(int((end_time - start_time).total_seconds()), 60)
        rng = f'{window_secs}s'
        otel = OTEL_METRIC_NAMES

        def _avg_over(metric):
            return _promql_instant_query(
                region, f'avg_over_time({metric}{selector}[{rng}])', end_time
            )

        def _max_over(metric):
            return _promql_instant_query(
                region, f'max_over_time({metric}{selector}[{rng}])', end_time
            )

        out = {}

        # ── DCGM GPU health (all GPU endpoints) ──
        gpu_util_avg = _avg_over(otel['gpu_utilization'])
        if gpu_util_avg is not None:
            out['gpu_utilization_avg'] = gpu_util_avg
        gpu_util_max = _max_over(otel['gpu_utilization'])
        if gpu_util_max is not None:
            out['gpu_utilization_max'] = gpu_util_max

        gpu_mem_util_avg = _avg_over(otel['gpu_memory_util'])
        if gpu_mem_util_avg is not None:
            out['gpu_memory_util_avg'] = gpu_mem_util_avg

        gpu_mem_used_avg = _avg_over(otel['gpu_memory_used_bytes'])
        if gpu_mem_used_avg is not None:
            # DCGM framebuffer bytes → GB.
            out['gpu_memory_used_avg_gb'] = gpu_mem_used_avg / (1024 ** 3)

        # ── Engine metrics (vLLM/SGLang only; absent for other frameworks) ──
        kv_avg = _avg_over(otel['kv_cache_util'])
        if kv_avg is not None:
            out['kv_cache_util_avg'] = kv_avg
        kv_max = _max_over(otel['kv_cache_util'])
        if kv_max is not None:
            out['kv_cache_util_max'] = kv_max

        running_avg = _avg_over(otel['queue_depth_running'])
        if running_avg is not None:
            out['queue_depth_running_avg'] = running_avg

        waiting_avg = _avg_over(otel['queue_depth_waiting'])
        if waiting_avg is not None:
            out['queue_depth_waiting_avg'] = waiting_avg
        waiting_max = _max_over(otel['queue_depth_waiting'])
        if waiting_max is not None:
            out['queue_depth_waiting_max'] = waiting_max

        return out
    except Exception:
        # Non-fatal: any signing/transport/parse error → empty dict so the
        # benchmark still writes and the Athena columns become NULL.
        return {}


# ── Engine /metrics collection (Phase 2, HyperPod EKS opt-in) ──────────────────


def _parse_prometheus_text(text):
    """Parse Prometheus text exposition format into {metric_name: float}.

    Ignores HELP/TYPE comment lines and metric labels — for the gauges/counters
    we consume, the last (or only) sample value per base metric name is used.
    Prefers prometheus_client if available, else a small regex parser.
    """
    values = {}
    try:
        from prometheus_client.parser import text_string_to_metric_families

        for family in text_string_to_metric_families(text):
            for sample in family.samples:
                # sample.name includes counter suffixes (e.g. _total); the family
                # name is the base. Store under both so registry lookups by base
                # name succeed regardless of suffix.
                values[sample.name] = float(sample.value)
                values[family.name] = float(sample.value)
        return values
    except Exception:
        pass

    # Regex fallback — no external dependency.
    import re

    line_re = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+)\s*$')
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = line_re.match(line)
        if not m:
            continue
        name = m.group(1)
        try:
            val = float(m.group(3))
        except ValueError:
            continue
        values[name] = val
        # Also index without a trailing _total so counter-pair lookups by base
        # name resolve.
        if name.endswith('_total'):
            values[name[:-len('_total')]] = val
    return values


def collect_engine_metrics(base_url, engine, timeout=30):
    """GET ``{base_url}/metrics`` and map engine signals via METRIC_REGISTRY.

    Args:
        base_url: Engine base URL (e.g. 'http://localhost:8080').
        engine:   Engine key into METRIC_REGISTRY (e.g. 'vllm', 'sglang').
        timeout:  HTTP timeout in seconds.

    Returns:
        dict with keys ``kv_cache_util_avg``, ``prefix_cache_hit_rate``,
        ``queue_depth_running_avg``, ``queue_depth_waiting_avg``, and
        ``queue_depth_waiting_max`` when available; an empty dict ``{}`` on ANY
        error/timeout (non-fatal contract).

    Notes:
        * vLLM prefix cache is a counter pair → hit_rate = hits / queries.
        * SGLang exposes ``sglang:cache_hit_rate`` directly as a gauge ratio.
        * Post-run single scrape: *_avg and *_max reflect the single sampled
          value (point-in-time); columns exist for parity with multi-sample
          collectors and future in-run sampling.
    """
    registry = METRIC_REGISTRY.get(engine)
    if not registry:
        return {}

    try:
        import urllib.request

        url = base_url.rstrip('/') + '/metrics'
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            text = resp.read().decode('utf-8', errors='replace')

        parsed = _parse_prometheus_text(text)
        out = {}

        # KV cache utilization (gauge 0-1).
        kv_name = registry.get('kv_cache_util')
        if kv_name and kv_name in parsed:
            out['kv_cache_util_avg'] = parsed[kv_name]
            out['kv_cache_util_max'] = parsed[kv_name]

        # Prefix cache hit rate.
        if 'prefix_cache_hit_rate' in registry:
            # SGLang: already a computed ratio gauge.
            rate_name = registry['prefix_cache_hit_rate']
            if rate_name in parsed:
                out['prefix_cache_hit_rate'] = parsed[rate_name]
        elif 'prefix_cache_hits' in registry and 'prefix_cache_queries' in registry:
            # vLLM: counter pair → hit_rate = hits / queries.
            hits = parsed.get(registry['prefix_cache_hits'])
            queries = parsed.get(registry['prefix_cache_queries'])
            if hits is not None and queries is not None and queries > 0:
                out['prefix_cache_hit_rate'] = hits / queries

        # Queue depth (running / waiting gauges).
        running_name = registry.get('queue_depth_running')
        if running_name and running_name in parsed:
            out['queue_depth_running_avg'] = parsed[running_name]

        waiting_name = registry.get('queue_depth_waiting')
        if waiting_name and waiting_name in parsed:
            out['queue_depth_waiting_avg'] = parsed[waiting_name]
            out['queue_depth_waiting_max'] = parsed[waiting_name]

        return out
    except Exception:
        # Non-fatal: timeout / connection / parse error → empty dict.
        return {}


# ── CLI entrypoint ─────────────────────────────────────────────────────────────


def _main(argv):
    if len(argv) >= 4 and argv[1] == 'engine-metrics':
        base_url = argv[2]
        engine = argv[3]
        result = collect_engine_metrics(base_url, engine)
        print(json.dumps(result))
        return 0
    print(json.dumps({"error": "usage: gpu_metrics.py engine-metrics <base_url> <engine>"}))
    return 1


if __name__ == '__main__':
    sys.exit(_main(sys.argv))
