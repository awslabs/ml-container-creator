# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""benchmark_gpu_metrics.py — Render GPU/engine efficiency signals (BL086/BL101).

Reads the most-recent local benchmark result (`profile_export.jsonl`) plus any
sibling metrics files, extracts the BL086 GPU/engine columns, and prints either
a human-readable summary or raw JSON.

Used by `do/benchmark --gpu-metrics` (Req 3) and, in `--summary-only` mode, by
`do/benchmark --set-baseline` to echo the pinned run's key throughput/latency.

CLI:
    benchmark_gpu_metrics.py <profile_export.jsonl> [--json] [--summary-only]
"""

import argparse
import json
import os
import sys


# BL086 GPU/engine efficiency signals surfaced by --gpu-metrics.
_GPU_FIELDS = (
    'gpu_utilization_avg',
    'gpu_utilization_max',
    'kv_cache_util_avg',
    'kv_cache_util_max',
    'queue_depth_waiting_avg',
    'prefix_cache_hit_rate',
    'metrics_source',
)

# Key throughput/latency metrics surfaced by --set-baseline confirmation.
_SUMMARY_FIELDS = (
    ('output_token_throughput_tps', 'Throughput (tok/s)'),
    ('ttft_p90_ms', 'TTFT P90 (ms)'),
    ('itl_p90_ms', 'ITL P90 (ms)'),
)

# AIPerf field → (our key, sub-key) mapping (mirrors .optimize_engine.py).
_AIPERF_METRIC_MAP = {
    'output_token_throughput': ('output_token_throughput_tps', 'avg'),
    'time_to_first_token': ('ttft_p90_ms', 'p90'),
    'time_to_first_output_token': ('ttft_p90_ms', 'p90'),
    'inter_token_latency': ('itl_p90_ms', 'p90'),
    'request_latency': ('e2e_latency_p90_ms', 'p90'),
}


def _coerce_float(value):
    try:
        return float(value) if value not in (None, '') else None
    except (ValueError, TypeError):
        return None


def _load_jsonl_records(path):
    """Return parsed JSON objects from a jsonl file (skip blank/invalid lines)."""
    records = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return records


def extract_metrics(jsonl_path, gpu_metrics_override=None):
    """Extract GPU/engine + throughput/latency metrics from a benchmark result.

    Looks at the profile_export.jsonl records, and sibling
    profile_export_aiperf.json / gpu_metrics.json when present. Returns a dict
    of the fields we know about; missing signals are simply absent.
    """
    out = {}

    # 1. Scan the jsonl for any flat BL086 columns / throughput fields.
    for record in _load_jsonl_records(jsonl_path):
        block = record.get('metrics', record) if isinstance(record, dict) else {}
        if not isinstance(block, dict):
            continue
        for field in _GPU_FIELDS:
            if field in block and block[field] not in (None, ''):
                out[field] = block[field]
        for our_key, _label in _SUMMARY_FIELDS:
            if our_key in block and block[our_key] not in (None, ''):
                out[our_key] = block[our_key]
        # AIPerf-style nested metrics
        for aiperf_key, (our_key, sub_key) in _AIPERF_METRIC_MAP.items():
            entry = block.get(aiperf_key)
            if isinstance(entry, dict) and entry.get(sub_key) is not None:
                out.setdefault(our_key, entry[sub_key])

    _dir = os.path.dirname(jsonl_path)

    # 2. Sibling gpu_metrics.json (written by the enrichment collector, if any).
    #    gpu_metrics_override takes priority (fixed .last_gpu_metrics.json from benchmarks/).
    if gpu_metrics_override and os.path.exists(gpu_metrics_override):
        gm_path = gpu_metrics_override
    else:
        gm_path = os.path.join(_dir, 'gpu_metrics.json')
    if os.path.exists(gm_path):
        try:
            with open(gm_path) as f:
                gm = json.load(f)
            if isinstance(gm, dict):
                for field in _GPU_FIELDS:
                    if field in gm and gm[field] not in (None, ''):
                        out[field] = gm[field]
        except (OSError, json.JSONDecodeError):
            pass

    # 3. Sibling profile_export_aiperf.json for throughput/latency fallback.
    aiperf_path = os.path.join(_dir, 'profile_export_aiperf.json')
    if os.path.exists(aiperf_path):
        try:
            with open(aiperf_path) as f:
                aiperf = json.load(f)
            if isinstance(aiperf, dict):
                for aiperf_key, (our_key, sub_key) in _AIPERF_METRIC_MAP.items():
                    entry = aiperf.get(aiperf_key)
                    if isinstance(entry, dict) and entry.get(sub_key) is not None:
                        out.setdefault(our_key, entry[sub_key])
        except (OSError, json.JSONDecodeError):
            pass

    return out


def _metrics_source(metrics):
    """Normalize metrics_source; default inferred from present keys, else 'none'."""
    src = str(metrics.get('metrics_source', '') or '').strip().lower()
    if src:
        return src
    # Infer from which keys are populated (sidecar from gpu_metrics.py lacks metrics_source)
    _engine_keys = {'kv_cache_util_avg', 'kv_cache_util_max', 'queue_depth_waiting_avg', 'prefix_cache_hit_rate'}
    _cw_keys = {'gpu_utilization_avg', 'gpu_utilization_max'}
    has_engine = any(metrics.get(k) is not None for k in _engine_keys)
    has_cw = any(metrics.get(k) is not None for k in _cw_keys)
    if has_engine and has_cw:
        return 'both'
    if has_engine:
        return 'engine_metrics_only'
    if has_cw:
        return 'cloudwatch_only'
    return 'none'


# GPU columns (Phase 1 CloudWatch): structurally N/A when Phase 1 was not
# applicable for the target (engine_metrics_only) or nothing was collected (none).
_GPU_COLUMNS = ('gpu_utilization_avg', 'gpu_utilization_max',
                'gpu_memory_util_avg', 'gpu_memory_used_avg_gb')
# Engine columns (Phase 2 /metrics): structurally N/A when Phase 2 was not
# applicable for the target (cloudwatch_only) or nothing was collected (none).
_ENGINE_COLUMNS = ('prefix_cache_hit_rate', 'queue_depth_running_avg')


def _is_na_column(column, source):
    """Return True when `column` is structurally not-applicable for `source`.

    GPU (Phase 1) columns → N/A for 'engine_metrics_only' or 'none'.
    Engine (Phase 2) columns → N/A for 'cloudwatch_only' or 'none'.
    """
    if column in _GPU_COLUMNS:
        return source in ('engine_metrics_only', 'none')
    if column in _ENGINE_COLUMNS:
        return source in ('cloudwatch_only', 'none')
    return False


def _print_guidance():
    """Phase 1 / Phase 2 enablement guidance (Req 3.4)."""
    print("\nℹ️  No GPU/engine metrics were collected for this run (metrics_source=none).")
    print("   Enable richer signals:")
    print("     Phase 1 — CloudWatch OTel enrichment (account-level):")
    print("       aws cloudwatch start-otel-enrichment --region <region>")
    print("     Phase 2 — engine /metrics scrape (HyperPod EKS, opt-in):")
    print("       Set HP_BENCHMARK_METRICS_ENABLED=true in do/config, then re-run the benchmark.")


def _print_summary_only(metrics):
    """Compact key-metric summary for --set-baseline confirmation."""
    print("   Key metrics of pinned run:")
    for key, label in _SUMMARY_FIELDS:
        val = _coerce_float(metrics.get(key))
        shown = '—' if val is None else str(round(val, 1))
        print(f"     {label:<20} {shown}")


def _print_full(metrics):
    """Human-readable GPU/engine metrics table (Req 3.1)."""
    source = _metrics_source(metrics)
    print("\n📈 GPU / engine efficiency (most recent local benchmark)\n")

    def _fmt(key, pct=False):
        # Structurally not-applicable for this target → "N/A" (distinct from a
        # collected-but-empty value, which renders as "—").
        if _is_na_column(key, source):
            return 'N/A'
        val = _coerce_float(metrics.get(key))
        if val is None:
            return '—'
        return f"{round(val, 2)}%" if pct else str(round(val, 3))

    rows = [
        ('GPU utilization avg', _fmt('gpu_utilization_avg', pct=True)),
        ('GPU utilization max', _fmt('gpu_utilization_max', pct=True)),
        ('KV cache util avg', _fmt('kv_cache_util_avg')),
        ('KV cache util max', _fmt('kv_cache_util_max')),
        ('Queue depth waiting avg', _fmt('queue_depth_waiting_avg')),
        ('Prefix cache hit rate', _fmt('prefix_cache_hit_rate')),
        ('Metrics source', source),
    ]
    for label, value in rows:
        print(f"   {label:<26} {value}")

    if source == 'none':
        _print_guidance()
    print()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Render local benchmark GPU/engine metrics')
    parser.add_argument('results_file', help='Path to profile_export.jsonl')
    parser.add_argument('--json', dest='json_output', action='store_true', default=False)
    parser.add_argument('--summary-only', dest='summary_only', action='store_true', default=False)
    parser.add_argument('--gpu-metrics-file', dest='gpu_metrics_file', default=None,
                        help='Override path to gpu_metrics.json (takes priority over per-run sidecar)')
    args = parser.parse_args(argv)

    if not args.results_file or not os.path.exists(args.results_file):
        if args.json_output:
            print(json.dumps({'status': 'no_results', 'metrics': {}}))
        else:
            print("ℹ️  No local benchmark results found.")
        return 0

    metrics = extract_metrics(args.results_file, gpu_metrics_override=args.gpu_metrics_file)

    if args.json_output:
        payload = dict(metrics)
        payload.setdefault('metrics_source', _metrics_source(metrics))
        print(json.dumps({'status': 'ok', 'metrics': payload}))
        return 0

    if args.summary_only:
        _print_summary_only(metrics)
        return 0

    _print_full(metrics)
    return 0


if __name__ == '__main__':
    sys.exit(main())
