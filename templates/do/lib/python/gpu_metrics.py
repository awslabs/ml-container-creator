# SPDX-License-Identifier: Apache-2.0

"""GPU efficiency metrics collection for do/benchmark (BL086).

Single engine-neutral place to gather GPU efficiency signals from two sources:

  * CloudWatch (SageMaker detailed observability via the OTel collector) — GPU
    utilization and memory. Available for all engines and all targets, queried
    post-run. See collect_cloudwatch().
  * Engine ``/metrics`` (Prometheus text) — KV cache utilization, prefix cache
    hit rate, and queue depth. HyperPod EKS only, opt-in, scraped via a
    port-forward after the run. See collect_engine_metrics().

METRIC_REGISTRY is the single source of truth mapping abstract signal names to
engine-specific Prometheus metric names; a new engine is added by extending it.

Non-fatal contract (design.md § Error Handling): metrics collection NEVER fails
the benchmark. Any error/timeout → an empty dict, so the benchmark result is
still written and the corresponding Athena columns become NULL.

CLI entrypoint (for do/benchmark bash to call):

    python3 gpu_metrics.py engine-metrics <base_url> <engine>

prints the collected engine-metrics dict as JSON to stdout.
"""

import json
import sys


# ── METRIC_REGISTRY — single source of truth ──────────────────────────────────
#
# Metric names verified from official docs (see design.md § "Preflight
# Verification Gate"): vLLM v0.11.2 metrics reference and SGLang production
# metrics. A new engine is added by extending this dict — no schema/query change.
METRIC_REGISTRY = {
    'vllm': {
        # V1 engine canonical KV cache utilization gauge (0-1). NOT the Grafana
        # alias vllm:gpu_cache_usage_perc.
        'kv_cache_util': 'vllm:kv_cache_usage_perc',
        # Prefix cache is a COUNTER PAIR on v0.25 — hit_rate = hits / queries,
        # computed in collect_engine_metrics (there is no single hit-rate gauge).
        'prefix_cache_queries': 'vllm:prefix_cache_queries',
        'prefix_cache_hits': 'vllm:prefix_cache_hits',
        'queue_depth_running': 'vllm:num_requests_running',
        'queue_depth_waiting': 'vllm:num_requests_waiting',
    },
    'sglang': {
        'kv_cache_util': 'sglang:token_usage',            # Gauge 0-1 (requires --enable-metrics)
        'prefix_cache_hit_rate': 'sglang:cache_hit_rate',  # Gauge 0-1 — already a computed ratio, not a counter pair
        'queue_depth_running': 'sglang:num_running_reqs',  # TODO: verify on v0.5.15
        'queue_depth_waiting': 'sglang:num_queue_reqs',    # TODO: verify on v0.5.15
    },
    # TRT-LLM, DJL/LMI: add as they are verified.
}


# ── CloudWatch collection (Phase 1, all engines/targets) ───────────────────────


def collect_cloudwatch(endpoint_name, variant_name, ic_name, start_time, end_time, region):
    """Query CloudWatch (SageMaker detailed observability / OTel) for GPU signals.

    Uses SageMaker detailed observability, which scrapes the container metrics
    via the OTel collector and publishes them to CloudWatch, queryable via the
    ``GetMetricData`` API against the OTel/DCGM-sourced GPU metrics for the
    endpoint (per inference component when ``ic_name`` is provided).

    Args:
        endpoint_name: SageMaker endpoint name.
        variant_name:  Production variant name (e.g. 'AllTraffic').
        ic_name:       Inference component name, or '' / None if not IC-based.
        start_time:    datetime — start of the benchmark run window.
        end_time:      datetime — end of the benchmark run window.
        region:        AWS region.

    Returns:
        dict with keys ``gpu_utilization_avg``, ``gpu_utilization_max``,
        ``gpu_memory_used_avg_gb``, and ``gpu_memory_util_avg`` when data is
        available; an empty dict ``{}`` on ANY error (non-fatal contract).
    """
    try:
        import boto3

        cw = boto3.client('cloudwatch', region_name=region)

        # Dimensions: per-IC when an inference component is supplied, else per-variant.
        dimensions = [{'Name': 'EndpointName', 'Value': endpoint_name}]
        if variant_name:
            dimensions.append({'Name': 'VariantName', 'Value': variant_name})
        if ic_name:
            dimensions.append({'Name': 'InferenceComponentName', 'Value': ic_name})

        # SageMaker detailed observability publishes DCGM-sourced GPU metrics via
        # the OTel collector under the endpoint namespace.
        namespace = '/aws/sagemaker/Endpoints'
        period = 60

        def _metric_query(qid, metric_name, stat):
            return {
                'Id': qid,
                'MetricStat': {
                    'Metric': {
                        'Namespace': namespace,
                        'MetricName': metric_name,
                        'Dimensions': dimensions,
                    },
                    'Period': period,
                    'Stat': stat,
                },
                'ReturnData': True,
            }

        queries = [
            _metric_query('gpu_util_avg', 'GPUUtilization', 'Average'),
            _metric_query('gpu_util_max', 'GPUUtilization', 'Maximum'),
            _metric_query('gpu_mem_util_avg', 'GPUMemoryUtilization', 'Average'),
        ]

        resp = cw.get_metric_data(
            MetricDataQueries=queries,
            StartTime=start_time,
            EndTime=end_time,
            ScanBy='TimestampAscending',
        )

        results = {r['Id']: r.get('Values', []) for r in resp.get('MetricDataResults', [])}

        def _avg(values):
            return (sum(values) / len(values)) if values else None

        def _max(values):
            return max(values) if values else None

        out = {}
        gpu_util_avg = _avg(results.get('gpu_util_avg', []))
        gpu_util_max = _max(results.get('gpu_util_max', []))
        gpu_mem_util_avg = _avg(results.get('gpu_mem_util_avg', []))

        if gpu_util_avg is not None:
            out['gpu_utilization_avg'] = gpu_util_avg
        if gpu_util_max is not None:
            out['gpu_utilization_max'] = gpu_util_max
        if gpu_mem_util_avg is not None:
            out['gpu_memory_util_avg'] = gpu_mem_util_avg
            # GPU memory used (GB) is not directly exposed as a distinct metric in
            # all configurations; when only the utilization % is available we leave
            # gpu_memory_used_avg_gb absent (→ NULL) rather than fabricate a value.

        return out
    except Exception:
        # Non-fatal: any AWS/boto3 error → empty dict so the benchmark still writes.
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
