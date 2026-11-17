# SPDX-License-Identifier: Apache-2.0

"""Benchmark Writer — Converts do/benchmark output to enriched Parquet for Athena.

Subcommands:
    write   - Validate, enrich, and write benchmark results to S3 as Parquet

All output is JSON on stdout for bash consumption.
Errors are structured JSON objects — never raw tracebacks.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone


# ── Constants ─────────────────────────────────────────────────────────────────

REQUIRED_FIELDS = [
    'project_name',
    'model_name',
    'instance_type',
    'deployment_config',
    'region',
    'metrics',
]

# Pattern for valid SageMaker instance types: ml.<family>.<size>
# Family segment allows a hyphen (e.g. Blackwell Ultra "p6-b300" in
# ml.p6-b300.48xlarge) — size segment (e.g. 48xlarge) never has one.
_INSTANCE_TYPE_RE = re.compile(r'^ml\.[a-z0-9-]+\.[a-z0-9]+$')

# Known model family patterns — maps regex to family label
# Known model family patterns — maps regex to family label.
# Patterns are searched against the model identifier (after org/ prefix stripping).
# Order matters: more specific patterns (e.g., deepseek-r1) must precede generic ones.
# Version dots are collapsed for family grouping (e.g., Llama-3.1 → llama3).
_MODEL_FAMILY_PATTERNS = [
    # DeepSeek — must come before qwen/llama because model names may contain those
    # (e.g., "DeepSeek-R1-Distill-Qwen-7B" contains "Qwen")
    (re.compile(r'deepseek[-_.]?r1', re.IGNORECASE), 'deepseek-r1'),
    (re.compile(r'deepseek[-_.]?v3', re.IGNORECASE), 'deepseek-v3'),
    (re.compile(r'deepseek[-_.]?v2', re.IGNORECASE), 'deepseek-v2'),
    (re.compile(r'deepseek[-_.]?coder', re.IGNORECASE), 'deepseek-coder'),
    (re.compile(r'deepseek[-_.]?math', re.IGNORECASE), 'deepseek-math'),
    (re.compile(r'deepseek', re.IGNORECASE), 'deepseek'),
    # Qwen family — version number without dots for family grouping
    (re.compile(r'qwen3', re.IGNORECASE), 'qwen3'),
    (re.compile(r'qwen2', re.IGNORECASE), 'qwen2'),
    (re.compile(r'qwen', re.IGNORECASE), 'qwen'),
    # Llama family — collapse version dots (3.1, 3.2 → llama3)
    (re.compile(r'codellama|code[-_]?llama', re.IGNORECASE), 'codellama'),
    (re.compile(r'llama[-_.]?3', re.IGNORECASE), 'llama3'),
    (re.compile(r'llama[-_.]?2', re.IGNORECASE), 'llama2'),
    (re.compile(r'llama', re.IGNORECASE), 'llama'),
    # Mistral/Mixtral
    (re.compile(r'mixtral', re.IGNORECASE), 'mixtral'),
    (re.compile(r'mistral', re.IGNORECASE), 'mistral'),
    # Microsoft Phi
    (re.compile(r'phi[-_.]?3', re.IGNORECASE), 'phi3'),
    (re.compile(r'phi[-_.]?2', re.IGNORECASE), 'phi2'),
    # Google Gemma
    (re.compile(r'gemma[-_.]?2', re.IGNORECASE), 'gemma2'),
    (re.compile(r'gemma', re.IGNORECASE), 'gemma'),
    # Others
    (re.compile(r'falcon', re.IGNORECASE), 'falcon'),
    (re.compile(r'starcoder', re.IGNORECASE), 'starcoder'),
    (re.compile(r'gpt[-_.]?oss', re.IGNORECASE), 'gpt-oss'),
]

# ── Athena / Glue column list (R11.1) ────────────────────────────────────────
# The ONE writer-side declaration of the benchmark_results columns (pyarrow-free
# so the drift test can import it without pyarrow). get_parquet_schema() builds
# from it; infra/bootstrap-modules/benchmark/stack.ts (BenchmarkResultsTable)
# and docs/athena-benchmark-ddl.sql must carry the same names + types —
# test/unit/test_benchmark_schema_drift.py fails on any disagreement.
# Kinds: string | double | int (int32 / Glue int) | boolean.
# Partition columns (model, instance, target) are NOT listed: they are encoded
# in the S3 path. To add a column: append here, append to stack.ts, add to the
# DDL, then `bootstrap update` the benchmark module (no ALTER TABLE).
PARQUET_COLUMNS = [
    # Identity
    ('project_name', 'string'),
    # Model + serving config
    ('model_name', 'string'),
    ('model_family', 'string'),
    ('instance_type', 'string'),
    ('deployment_config', 'string'),
    ('deployment_target', 'string'),
    ('quantization', 'string'),
    ('tensor_parallel_degree', 'int'),
    # Hardware metadata (instance catalog at write time)
    ('instance_family', 'string'),
    ('gpu_count', 'int'),
    ('gpu_type', 'string'),
    ('gpu_memory_gb', 'double'),
    # Configuration dimensions
    ('max_model_len', 'int'),
    ('enable_lora', 'boolean'),
    ('kv_cache_dtype', 'string'),
    ('serving_config', 'string'),
    # Workload
    ('workload', 'string'),
    ('concurrency', 'int'),
    ('input_tokens_mean', 'int'),
    ('output_tokens_mean', 'int'),
    ('streaming', 'boolean'),
    ('duration_seconds', 'int'),
    # Client-side metrics (AIPerf per-request JSONL)
    ('request_throughput_rps', 'double'),
    ('total_token_throughput_tps', 'double'),
    ('output_token_throughput_tps', 'double'),
    ('request_count', 'double'),
    ('ttft_avg_ms', 'double'),
    ('ttft_p50_ms', 'double'),
    ('ttft_p90_ms', 'double'),
    ('ttft_p99_ms', 'double'),
    ('itl_avg_ms', 'double'),
    ('itl_p50_ms', 'double'),
    ('itl_p90_ms', 'double'),
    ('itl_p99_ms', 'double'),
    ('e2e_latency_avg_ms', 'double'),
    ('e2e_latency_p50_ms', 'double'),
    ('e2e_latency_p90_ms', 'double'),
    ('e2e_latency_p99_ms', 'double'),
    ('prefill_tps_avg', 'double'),
    ('prefill_tps_p50', 'double'),
    ('output_token_tps_avg', 'double'),
    ('output_token_tps_p50', 'double'),
    ('output_token_tps_p90', 'double'),
    ('ttst_p50_ms', 'double'),
    ('ttst_p90_ms', 'double'),
    ('output_sequence_length_avg', 'double'),
    ('input_sequence_length_avg', 'double'),
    ('error_rate', 'double'),
    ('cost_per_1m_tokens', 'double'),
    ('benchmark_duration_sec', 'double'),
    # Run metadata
    ('run_type', 'string'),
    ('benchmark_job_name', 'string'),
    ('run_name', 'string'),
    ('mcc_version', 'string'),
    ('run_timestamp', 'string'),
    ('region', 'string'),
    ('adapter_name', 'string'),
    # GPU / engine signals (BL086; nullable — NULL = signal unavailable)
    ('gpu_utilization_avg', 'double'),
    ('gpu_utilization_max', 'double'),
    ('gpu_memory_used_avg_gb', 'double'),
    ('gpu_memory_util_avg', 'double'),
    ('kv_cache_util_avg', 'double'),
    ('kv_cache_util_max', 'double'),
    ('prefix_cache_hit_rate', 'double'),
    ('queue_depth_running_avg', 'double'),
    ('queue_depth_waiting_avg', 'double'),
    ('queue_depth_waiting_max', 'double'),
    ('metrics_source', 'string'),
    # ── Wave 9 (append-only below) ──
    # BL128 curated AIPerf time-weighted aggregates (R10.1)
    ('effective_concurrency_avg', 'double'),
    ('effective_concurrency_p90', 'double'),
    ('effective_total_tps_avg', 'double'),
    ('effective_total_tps_p90', 'double'),
    ('effective_decode_tps_avg', 'double'),
    ('effective_decode_tps_p90', 'double'),
    ('effective_prefill_tps_avg', 'double'),
    ('effective_prefill_tps_p90', 'double'),
    ('active_decode_tps_avg', 'double'),
    ('active_decode_tps_p90', 'double'),
    ('active_prefill_tps_avg', 'double'),
    ('active_prefill_tps_p90', 'double'),
    ('tokens_in_flight_avg', 'double'),
    ('tokens_in_flight_p90', 'double'),
    ('effective_latency_avg_ms', 'double'),
    ('effective_latency_p90_ms', 'double'),
    # R10.2
    ('aiperf_version', 'string'),
    ('spec_decode_acceptance_rate', 'double'),
    # Cost inputs (R8.3) + Bedrock comparison (R9.4)
    ('price_usd_per_hour', 'double'),
    ('price_source', 'string'),
    ('price_as_of', 'string'),
    ('price_component', 'string'),
    ('instance_count', 'int'),
    ('bedrock_model_id', 'string'),
    ('bedrock_cost_per_1m_tokens', 'double'),
]

# BL128 (R10.1): AIPerf profile_export_aiperf.json top-level key -> column stem
# and the unit family it must be in. Values in any other unit are NULL (never
# converted by guesswork). Verified against AIPerf 0.12.0 / 0.13.0 exports.
_AIPERF_CURATED = (
    ('effective_concurrency', 'effective_concurrency', 'requests'),
    ('effective_total_throughput', 'effective_total_tps', 'tps'),
    ('effective_decode_throughput', 'effective_decode_tps', 'tps'),
    ('effective_prefill_throughput', 'effective_prefill_tps', 'tps'),
    ('active_decode_throughput', 'active_decode_tps', 'tps'),
    ('active_prefill_throughput', 'active_prefill_tps', 'tps'),
    ('tokens_in_flight', 'tokens_in_flight', 'tokens'),
    ('effective_latency', 'effective_latency', 'ms'),
)
_AIPERF_UNIT_SCALE = {
    'requests': {'requests': 1.0},
    'tps': {'tokens/sec': 1.0, 'tokens/s': 1.0},
    'tokens': {'tokens': 1.0},
    'ms': {'ms': 1.0, 'sec': 1000.0, 's': 1000.0, 'us': 0.001, 'ns': 0.000001},
}


# ── Utility functions ─────────────────────────────────────────────────────────


def _error_exit(message):
    """Print JSON error to stdout and exit with code 1."""
    print(json.dumps({"error": message}))
    sys.exit(1)


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


# ── Derived field computation ─────────────────────────────────────────────────


def derive_model_family(model_name):
    """Derive model family from model_name.

    Examples:
        "Qwen/Qwen3-4B" → "qwen3"
        "meta-llama/Llama-3.1-8B" → "llama3"
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B" → "deepseek-r1"

    The function:
        1. Strips the org prefix (everything before /)
        2. Matches patterns from most-specific to least-specific
        3. Collapses version dots for family grouping (3.1, 3.2 → 3)

    Returns:
        str — lowercase family identifier, or "other" if no pattern matches,
              or "unknown" if model_name is empty/None.
    """
    if not model_name:
        return 'unknown'

    # Strip org prefix: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B" → "DeepSeek-R1-Distill-Qwen-7B"
    name = model_name.split('/')[-1] if '/' in model_name else model_name

    for pattern, family in _MODEL_FAMILY_PATTERNS:
        if pattern.search(name):
            return family
    return 'other'


# Alias for test compatibility
compute_model_family = derive_model_family


def derive_instance_family(instance_type):
    """Derive instance family from instance_type.

    Examples:
        "ml.g5.xlarge" → "g5"
        "ml.g6e.2xlarge" → "g6e"
        "ml.p5.48xlarge" → "p5"
        "ml.trn2.xlarge" → "trn2"

    Returns:
        str — instance family identifier, or "unknown" if pattern doesn't match.
    """
    if not instance_type:
        return 'unknown'
    match = re.match(r'^ml\.([a-z0-9]+)\.[a-z0-9]+$', instance_type)
    if match:
        return match.group(1)
    return 'unknown'


# Alias for test compatibility
compute_instance_family = derive_instance_family


def _load_helper(name):
    """Import a do/lib/python helper (pricing, target_manifest) by path.

    The writer lives at <project>/do/.benchmark_writer.py (source tree:
    templates/do/), so helpers are always at ./lib/python/<name>.py.
    """
    import importlib.util as _ilu
    if name in sys.modules:
        return sys.modules[name]
    lib_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python')
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    spec = _ilu.spec_from_file_location(name, os.path.join(lib_dir, f'{name}.py'))
    mod = _ilu.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _ic_hosting_targets(tm):
    """Targets whose descriptor allows inference components (verbs.add-ic)."""
    out = []
    for t in tm.list_targets():
        try:
            if (tm.read_manifest(t).get('verbs') or {}).get('add-ic') is True:
                out.append(t)
        except Exception:  # noqa: BLE001 — a malformed descriptor is not ours to judge here
            continue
    return out


def resolve_benchmarked_target(target, ic_name=None):
    """BL213: the deployment target a benchmark row is labelled with.

    ``target`` is do/benchmark's --deployment-target (else the config file's
    DEPLOYMENT_TARGET); aliases resolve to the canonical name via targets.d. The
    config value can be stale: one do/config holds a single DEPLOYMENT_TARGET
    focus and a single ENDPOINT_NAME that several targets overwrite, so a run
    against a realtime endpoint + inference component was labelled hyperpod-eks.
    When the run benchmarked an inference component (``ic_name``), the target
    must be one that hosts ICs (descriptor verbs.add-ic, never a literal list);
    if the labelled one does not and exactly one target does, that one is used.
    Returns '' when nothing is known (callers keep their existing default).
    """
    target = (target or '').strip()
    try:
        tm = _load_helper('target_manifest')
    except Exception:  # noqa: BLE001 — no descriptors: keep the given label
        return target
    if target:
        try:
            target = tm.resolve_target(target)
        except Exception:  # noqa: BLE001 — unknown target: keep it verbatim
            pass
    if ic_name:
        hosts = _ic_hosting_targets(tm)
        if target not in hosts and len(hosts) == 1:
            if target:
                print(f'⚠️  DEPLOYMENT_TARGET is {target}, but this run benchmarked inference component '
                      f'{ic_name}: labelling the rows {hosts[0]}', file=sys.stderr)
            target = hosts[0]
    return target


# ── BL128: curated AIPerf aggregates (R10) ───────────────────────────────────


def aiperf_aggregate_columns(data):
    """Map an AIPerf profile_export_aiperf.json dict to the 16 curated columns
    plus aiperf_version. Missing keys, missing stats or an unexpected unit
    yield None for that column (R10.3). Never raises."""
    cols = {}
    data = data if isinstance(data, dict) else {}
    for key, stem, family in _AIPERF_CURATED:
        metric = data.get(key)
        scale = None
        if isinstance(metric, dict):
            scale = _AIPERF_UNIT_SCALE[family].get(metric.get('unit'))
        for stat in ('avg', 'p90'):
            col = f'{stem}_{stat}_ms' if family == 'ms' else f'{stem}_{stat}'
            val = metric.get(stat) if isinstance(metric, dict) else None
            if scale is None or not isinstance(val, (int, float)) or isinstance(val, bool):
                cols[col] = None
            else:
                cols[col] = float(val) * scale
    version = data.get('aiperf_version')
    cols['aiperf_version'] = str(version) if version not in (None, '') else None
    return cols


def load_aiperf_aggregates(path):
    """Read one aiperf JSON and return its curated columns ({} when unreadable)."""
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, 'r') as f:
            return aiperf_aggregate_columns(json.load(f))
    except (OSError, ValueError):
        return {}


def find_aiperf_aggregates(results_path, aiperf_dir=None, concurrencies=()):
    """Locate the per-level aiperf JSON files for a write (R10.1).

    Returns {concurrency(int) | '*': columns}. Sweep: <aiperf_dir or the
    results file's directory>/results-concurrency-<L>.json per level.
    Single level: the results file itself when it IS the aiperf JSON, else its
    sibling profile_export_aiperf.json (key '*').
    """
    found = {}
    base_dir = aiperf_dir or (os.path.dirname(os.path.abspath(results_path)) if results_path else None)
    if base_dir:
        for conc in concurrencies:
            try:
                level = int(conc)
            except (TypeError, ValueError):
                continue
            cols = load_aiperf_aggregates(os.path.join(base_dir, f'results-concurrency-{level}.json'))
            if cols:
                found[level] = cols
    if found or not results_path:
        return found
    if os.path.basename(results_path) == 'profile_export_aiperf.json':
        cols = load_aiperf_aggregates(results_path)
    else:
        cols = load_aiperf_aggregates(os.path.join(os.path.dirname(os.path.abspath(results_path)),
                                                   'profile_export_aiperf.json'))
    if cols:
        found['*'] = cols
    return found


_AIPERF_COLUMN_NAMES = tuple(
    name for name, _kind in PARQUET_COLUMNS
    if name.startswith(('effective_', 'active_', 'tokens_in_flight_')) or name == 'aiperf_version'
)


def compute_partition_keys(timestamp):
    """Compute year and month partition keys from a timestamp.

    Args:
        timestamp: One of:
            - datetime object
            - ISO 8601 string ("2026-06-09T14:30:22Z" or "2026-06-09T14:30:22+00:00")
            - Compact string ("20260609T143022Z")
            - None (uses current UTC time)

    Returns:
        tuple (year: str, month: str) — zero-padded strings.
    """
    if timestamp is None:
        dt = datetime.now(timezone.utc)
    elif isinstance(timestamp, datetime):
        dt = timestamp
    elif isinstance(timestamp, str):
        # Try ISO 8601 variants
        ts = timestamp.strip()
        try:
            # Standard ISO: 2026-06-09T14:30:22Z or 2026-06-09T14:30:22+00:00
            if 'T' in ts and '-' in ts[:10]:
                ts_clean = ts.replace('Z', '+00:00')
                dt = datetime.fromisoformat(ts_clean)
            elif 'T' in ts:
                # Compact: 20260609T143022Z
                ts_clean = ts.rstrip('Z')
                dt = datetime.strptime(ts_clean, '%Y%m%dT%H%M%S')
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = datetime.now(timezone.utc)
        except (ValueError, TypeError):
            dt = datetime.now(timezone.utc)
    else:
        dt = datetime.now(timezone.utc)

    return (dt.strftime('%Y'), dt.strftime('%m'))


def compute_s3_path(bucket, project_name, model_name, instance_type, deployment_target, timestamp):
    """Construct the full S3 URI for a benchmark run Parquet file.

    Uses model/instance/target partitioning scheme.

    Args:
        bucket: S3 bucket name.
        project_name: MCC project name.
        model_name: HuggingFace model ID.
        instance_type: SageMaker instance type.
        deployment_target: Deployment target (realtime-inference, etc.).
        timestamp: datetime object for the run timestamp.

    Returns:
        str — full S3 URI.
    """
    # Sanitize model name for S3 path (/ → _)
    model_partition = model_name.replace('/', '_') if model_name else 'unknown'
    instance_partition = instance_type or 'unknown'
    target_partition = deployment_target or 'realtime-inference'
    ts_str = timestamp.strftime('%Y%m%dT%H%M%SZ')
    filename = f'run-{project_name}-{ts_str}.parquet'

    return f's3://{bucket}/results/model={model_partition}/instance={instance_partition}/target={target_partition}/{filename}'


def compute_partition_info(model_name, instance_type, deployment_target):
    """Compute partition metadata dict for model/instance/target scheme.

    Args:
        model_name: HuggingFace model ID (e.g., 'Qwen/Qwen3-0.6B').
        instance_type: SageMaker instance type (e.g., 'ml.g5.xlarge').
        deployment_target: Deployment target (e.g., 'realtime-inference').

    Returns:
        dict with keys: model, instance, target.
    """
    return {
        "model": model_name.replace('/', '_') if model_name else 'unknown',
        "instance": instance_type or 'unknown',
        "target": deployment_target or 'realtime-inference',
    }


def build_s3_path(bucket, project_name, model_name, instance_type, deployment_target, timestamp=None, region=''):
    """Construct the S3 path and partition info for a benchmark run.

    Args:
        bucket: S3 bucket name.
        region: AWS region string.
        project_name: MCC project name.
        timestamp: datetime object or None (defaults to now UTC).

    Returns:
        dict with keys: s3_uri, partition_model, partition_instance, partition_target, filename.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)

    year = timestamp.strftime('%Y')
    month = timestamp.strftime('%m')
    ts_str = timestamp.strftime('%Y%m%dT%H%M%SZ')
    model_partition = model_name.replace('/', '_') if model_name else 'unknown'
    instance_partition = instance_type or 'unknown'
    target_partition = deployment_target or 'realtime-inference'
    filename = f'run-{project_name}-{ts_str}.parquet'

    s3_uri = f's3://{bucket}/results/model={model_partition}/instance={instance_partition}/target={target_partition}/{filename}'

    return {
        's3_uri': s3_uri,
        'partition_model': model_partition,
        'partition_instance': instance_partition,
        'partition_target': target_partition,
        'filename': filename,
    }


def _extract_base_image_version(base_image):
    """Extract version tag from a base image string.

    Examples:
        "vllm/vllm-openai:v0.8.5" → "v0.8.5"
        "nvcr.io/nvidia/tritonserver:24.01-py3" → "24.01-py3"
        "" → ""

    Returns:
        str — extracted tag or empty string.
    """
    if not base_image:
        return ''
    if ':' in base_image:
        return base_image.split(':')[-1]
    return ''


def _no_bedrock_prices(_model, _region):
    return {'input_usd_per_1m': None, 'output_usd_per_1m': None, 'reason': 'no Bedrock price resolver'}


def _cost_columns(cost_context, output_tps, model_name, adapter_name, region, isl_avg, osl_avg):
    """Cost + price-input + Bedrock columns for one level (R8.1, R8.3, R9).

    Returns (columns, reason_or_None, bedrock_result_or_None).
    """
    cols = {
        'cost_per_1m_tokens': None, 'price_usd_per_hour': None, 'price_source': None,
        'price_as_of': None, 'price_component': None, 'instance_count': None,
        'bedrock_model_id': None, 'bedrock_cost_per_1m_tokens': None,
    }
    if not cost_context:
        return cols, 'price not resolved', None
    pricing = _load_helper('pricing')
    price = cost_context.get('price') or {}
    count = cost_context.get('instance_count')
    cols.update({
        'price_usd_per_hour': price.get('usd_per_hour'),
        'price_source': price.get('source'),
        'price_as_of': price.get('as_of'),
        'price_component': price.get('component'),
        'instance_count': count,
    })
    cols['cost_per_1m_tokens'] = pricing.compute_cost(price.get('usd_per_hour'), count, output_tps)
    reason = None
    if cols['cost_per_1m_tokens'] is None:
        if price.get('usd_per_hour') is None:
            reason = f"no price: {price.get('reason') or 'unresolved'}"
        elif count is None:
            reason = f"no instance count: {cost_context.get('instance_count_reason') or 'unknown'}"
        else:
            reason = 'no measured output throughput'
    bedrock = pricing.bedrock_comparison(
        model_name, adapter_name=adapter_name, region=region,
        input_seq_len_avg=isl_avg, output_seq_len_avg=osl_avg,
        catalog=cost_context.get('bedrock_catalog') or {},
        price_resolver=cost_context.get('bedrock_price_resolver') or _no_bedrock_prices)
    cols['bedrock_model_id'] = bedrock.get('bedrock_model_id')
    cols['bedrock_cost_per_1m_tokens'] = bedrock.get('bedrock_cost_per_1m_tokens')
    return cols, reason, bedrock


# BL086 signal column groups (GPU / DCGM vs engine). Shared by enrich_records and
# _collect_gpu_signals.
_CW_KEYS = (
    'gpu_utilization_avg', 'gpu_utilization_max',
    'gpu_memory_used_avg_gb', 'gpu_memory_util_avg',
)
_ENGINE_KEYS = (
    'kv_cache_util_avg', 'kv_cache_util_max', 'prefix_cache_hit_rate',
    'queue_depth_running_avg', 'queue_depth_waiting_avg', 'queue_depth_waiting_max',
)


def _error_rate_from_aiperf(value):
    """AIPerf ``request_error_rate`` → ratio 0-1, or None when unusable.

    AIPerf 0.13 reports it as ``{"unit": "%", "avg": <percent>}`` (verified on
    live AIPerf output: 1 errored of 100 requests → {"unit": "%", "avg": 1.0}).
    A bare number or a dict without a percent unit is taken as a ratio.
    """
    if isinstance(value, dict):
        avg = value.get('avg')
        if not isinstance(avg, (int, float)) or isinstance(avg, bool):
            return None
        unit = str(value.get('unit') or '').strip()
        return float(avg) / 100.0 if unit == '%' else float(avg)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def resolve_error_rate(metric, total_requests):
    """R3.1: AIPerf ``request_error_rate`` when the level's aggregate has it,
    else errored records / total records. All-success → 0.0; unknown → None."""
    explicit = metric.get('error_rate')
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool):
        return float(explicit)
    from_aiperf = _error_rate_from_aiperf(metric.get('request_error_rate'))
    if from_aiperf is not None:
        return from_aiperf
    if 'error_count' in metric and total_requests and total_requests > 0:
        try:
            return float(metric.get('error_count') or 0) / float(total_requests)
        except (TypeError, ValueError):
            return None
    return None


def enrich_records(config, results, run_timestamp=None, instance_catalog=None, gpu_metrics=None,
                   cost_context=None, aiperf_aggregates=None, gpu_metrics_by_concurrency=None):
    """Build enriched records from config context and benchmark results.

    Each metrics entry becomes one enriched record with all Athena columns populated.

    Args:
        config: dict with config context fields (project_name, model_name, etc.)
        results: dict with benchmark results (job_name, metrics array)
        run_timestamp: Optional datetime for run_timestamp. Defaults to now UTC.
        instance_catalog: Optional pre-loaded instance catalog dict. If None, loaded from disk.
        gpu_metrics: Optional dict of collected GPU efficiency signals (BL086).
            May contain any of: gpu_utilization_avg, gpu_utilization_max,
            gpu_memory_used_avg_gb, gpu_memory_util_avg, kv_cache_util_avg,
            kv_cache_util_max, prefix_cache_hit_rate, queue_depth_running_avg,
            queue_depth_waiting_avg, queue_depth_waiting_max. It may also carry a
            'metrics_source' key set by the caller; when absent, provenance is
            derived from which signal groups are present. Missing signals → NULL
            columns (additive-only migration).
        cost_context: Optional dict from _resolve_cost_context() (Wave 9 R7-R9):
            {'price': pricing.resolve_instance_price() result, 'instance_count',
            'instance_count_reason', 'bedrock_catalog', 'bedrock_price_resolver'}.
            None → every cost / price / Bedrock column is NULL (with a reason
            kept in the record's private '_cost_reason').
        aiperf_aggregates: Optional {concurrency | '*': columns} from
            find_aiperf_aggregates() (BL128 R10). Missing → NULL columns.
        gpu_metrics_by_concurrency: Optional {concurrency: signals} (Wave 9
            R1.3): per-level signals collected over each level's own window. A
            level present here uses its own dict instead of ``gpu_metrics``.

    Returns:
        list of enriched record dicts (one per concurrency level).
    """
    if run_timestamp is None:
        run_timestamp = datetime.now(timezone.utc)

    model_name = config.get('model_name', '')
    instance_type = config.get('instance_type', '')
    project_name = config.get('project_name', '')
    deployment_config = config.get('deployment_config', '')
    region = config.get('region', '')

    # Derived fields
    model_family = derive_model_family(model_name)
    instance_family = derive_instance_family(instance_type)

    # Resolve instance metadata from catalog (AC-2.8)
    hw_meta = resolve_instance_metadata(instance_type, instance_catalog)
    gpu_count = hw_meta['gpu_count']
    gpu_type = hw_meta['gpu_type']
    gpu_memory_gb = hw_meta['gpu_memory_gb']

    # Optional context fields
    deployment_target = config.get('deployment_target', 'realtime-inference')
    try:
        tensor_parallel_degree = int(config.get('tensor_parallel_degree', 1))
    except (ValueError, TypeError):
        tensor_parallel_degree = 1

    quantization = config.get('quantization', 'none')
    enable_lora = config.get('enable_lora', False)
    base_image = config.get('base_image', '')
    base_image_version = config.get('base_image_version', '') or _extract_base_image_version(base_image)
    mcc_version = config.get('mcc_version', '')
    run_type = config.get('run_type', 'ci')
    ci_run_id = config.get('ci_run_id', '')
    account_id = config.get('account_id', '')

    # Configuration dimensions (nullable)
    max_model_len_raw = config.get('max_model_len')
    max_model_len = int(max_model_len_raw) if max_model_len_raw not in (None, '', 0) else None
    kv_cache_dtype = config.get('kv_cache_dtype') or None


    # Get metrics from results
    metrics = results.get('metrics', []) if isinstance(results, dict) else []

    # ── GPU efficiency signals (BL086; per level since Wave 9 R1.3) ───────────
    # The 11 BL086 columns are additive/nullable: absent signals → None (NULL).
    by_level = gpu_metrics_by_concurrency or {}

    def _gpu_columns_for(level):
        signals = by_level.get(level) if level in by_level else (gpu_metrics or {})
        signals = signals or {}
        cols = {k: signals.get(k) for k in (_CW_KEYS + _ENGINE_KEYS)}
        # Provenance: honor an explicit metrics_source from the caller, else
        # derive from which signal groups actually contributed.
        source = signals.get('metrics_source')
        if source is None:
            _has_cw = any(signals.get(k) is not None for k in _CW_KEYS)
            _has_engine = any(signals.get(k) is not None for k in _ENGINE_KEYS)
            if _has_cw and _has_engine:
                source = 'both'
            elif _has_cw:
                source = 'cloudwatch'
            elif _has_engine:
                source = 'engine_metrics'
            else:
                source = 'none'
        cols['metrics_source'] = source
        # Collected value for a column whose schema entry 9B owns (R10.2): put in
        # the record so a schema that declares it persists it; a schema that does
        # not simply ignores the key.
        if signals.get('spec_decode_acceptance_rate') is not None:
            cols['spec_decode_acceptance_rate'] = signals['spec_decode_acceptance_rate']
        return cols

    # Helper: unwrap aiperf metric dicts to scalar values
    # Derived metrics: {'unit': 'requests/sec', 'avg': 9.57} → 9.57
    # Record metrics: {'unit': 'ms', 'avg': 181.9, 'p50': 183.2, ...} → passed to .get('p50') etc.
    def scalar(val, stat='avg'):
        if isinstance(val, dict):
            return val.get(stat, 0.0)
        return val if val is not None else 0.0

    records = []
    for metric in metrics:
        concurrency = scalar(metric.get('concurrency', 0))
        throughput_rps = scalar(metric.get('request_throughput', 0.0))
        tokens_per_second = scalar(metric.get('output_token_throughput', 0.0))
        total_requests = scalar(metric.get('total_requests', metric.get('request_count', 0)))
        try:
            gpu_columns = _gpu_columns_for(int(concurrency))
        except (TypeError, ValueError):
            gpu_columns = _gpu_columns_for(None)
        duration_seconds = scalar(metric.get('duration_seconds', 0), stat='avg')
        input_tokens_mean = metric.get('input_tokens_mean', 0)
        output_tokens_mean = metric.get('output_tokens_mean', 0)

        # Latency percentiles
        ttft = metric.get('time_to_first_token', {})
        itl = metric.get('inter_token_latency', {})

        # Error rate (R3.1): AIPerf request_error_rate, else errored/total; None
        # (NULL) when neither is known — never a fabricated 0.0.
        error_rate = resolve_error_rate(metric, total_requests)

        # Status based on error rate
        if error_rate is not None and error_rate >= 1.0:
            status = 'failed'
        else:
            status = 'completed'

        # Cost (R8.1): usd/h x instance_count x 1e6 / (3600 x output tok/s),
        # from the resolved price + billed count. Any missing input → NULL.
        cost_cols, cost_reason, bedrock = _cost_columns(
            cost_context, tokens_per_second, model_name, config.get('adapter_name', ''), region,
            scalar(metric.get('input_sequence_length', metric.get('input_sequence_length_avg', 0.0))),
            scalar(metric.get('output_sequence_length', metric.get('output_sequence_length_avg', 0.0))))

        # BL128 curated AIPerf aggregates for this level (R10.1).
        _agg = aiperf_aggregates or {}
        try:
            _level_key = int(concurrency)
        except (TypeError, ValueError):
            _level_key = None
        agg_cols = _agg.get(_level_key) or _agg.get('*') or {}
        aiperf_cols = {k: agg_cols.get(k) for k in _AIPERF_COLUMN_NAMES}

        # Build serving_config JSON blob from all available config params
        serving_config_dict = {
            k: v for k, v in {
                'quantization': quantization,
                'tensor_parallel_degree': tensor_parallel_degree,
                'enable_lora': enable_lora,
                'base_image': base_image,
                'kv_cache_dtype': config.get('kv_cache_dtype', 'auto'),
                'max_model_len': config.get('max_model_len', ''),
                'vllm_version': config.get('vllm_version', ''),
                'gpu_memory_utilization': config.get('gpu_memory_utilization', ''),
                'ic_gpu_count': config.get('ic_gpu_count', ''),
                'ic_copy_count': config.get('ic_copy_count', ''),
                'adapter_name': config.get('adapter_name', ''),
            }.items() if v not in ('', None)
        }

        # Extract richer latency metrics
        e2e_latency = metric.get('e2e_latency', {})
        prefill = metric.get('prefill_throughput', {})
        output_tps = metric.get('output_token_throughput_detail', {})

        record = {
            'project_name': project_name,
            'model_name': model_name,
            'model_family': model_family,
            'instance_type': instance_type,
            'deployment_config': deployment_config,
            'deployment_target': deployment_target,
            'quantization': quantization,
            'tensor_parallel_degree': tensor_parallel_degree,
            'instance_family': instance_family,
            'gpu_count': gpu_count,
            'gpu_type': gpu_type,
            'gpu_memory_gb': gpu_memory_gb,
            'max_model_len': max_model_len,
            'enable_lora': enable_lora,
            'kv_cache_dtype': kv_cache_dtype,
            'serving_config': json.dumps(serving_config_dict),
            'workload': config.get('workload', 'manual'),
            'concurrency': concurrency,
            'input_tokens_mean': input_tokens_mean,
            'output_tokens_mean': output_tokens_mean,
            'streaming': config.get('streaming', True),
            'duration_seconds': duration_seconds,
            'request_throughput_rps': throughput_rps,
            'total_token_throughput_tps': scalar(metric.get('total_token_throughput', 0.0)),
            'output_token_throughput_tps': scalar(metric.get('output_token_throughput', 0.0)),
            'request_count': scalar(metric.get('request_count', metric.get('total_requests', 0))),
            'ttft_avg_ms': ttft.get('avg', 0.0),
            'ttft_p50_ms': ttft.get('p50', 0.0),
            'ttft_p90_ms': ttft.get('p90', 0.0),
            'ttft_p99_ms': ttft.get('p99', 0.0),
            'itl_avg_ms': itl.get('avg', 0.0),
            'itl_p50_ms': itl.get('p50', 0.0),
            'itl_p90_ms': itl.get('p90', 0.0),
            'itl_p99_ms': itl.get('p99', 0.0),
            'e2e_latency_avg_ms': e2e_latency.get('avg', 0.0),
            'e2e_latency_p50_ms': e2e_latency.get('p50', 0.0),
            'e2e_latency_p90_ms': e2e_latency.get('p90', 0.0),
            'e2e_latency_p99_ms': e2e_latency.get('p99', 0.0),
            'prefill_tps_avg': prefill.get('avg', 0.0),
            'prefill_tps_p50': prefill.get('p50', 0.0),
            'output_token_tps_avg': output_tps.get('avg', 0.0),
            'output_token_tps_p50': output_tps.get('p50', 0.0),
            'output_token_tps_p90': output_tps.get('p90', 0.0),
            'ttst_p50_ms': metric.get('time_to_second_token', {}).get('p50', 0.0),
            'ttst_p90_ms': metric.get('time_to_second_token', {}).get('p90', 0.0),
            'output_sequence_length_avg': metric.get('output_sequence_length_avg', 0.0),
            'output_sequence_length_avg': scalar(metric.get('output_sequence_length', metric.get('output_sequence_length_avg', 0.0))),
            'input_sequence_length_avg': scalar(metric.get('input_sequence_length', metric.get('input_sequence_length_avg', 0.0))),
            'error_rate': error_rate,
            'cost_per_1m_tokens': cost_cols['cost_per_1m_tokens'],
            'benchmark_duration_sec': metric.get('benchmark_duration_sec', duration_seconds),
            'run_type': run_type,
            # R5.1: a sweep level carries its own child job name; else the run's.
            'benchmark_job_name': (metric.get('benchmark_job_name')
                                   or (results.get('job_name', '') if isinstance(results, dict) else '')),
            'run_name': results.get('run_name', '') if isinstance(results, dict) else '',
            'mcc_version': mcc_version,
            'run_timestamp': run_timestamp.isoformat(),
            'region': region,
            'adapter_name': config.get('adapter_name', ''),
            # GPU efficiency signals + provenance (BL086); None → NULL column.
            **gpu_columns,
            # Wave 9: BL128 aggregates, spec-decode acceptance (R10.2), cost
            # inputs (R8.3) and the Bedrock comparison (R9.4).
            **aiperf_cols,
            # Per-level value (Wave 9 R1.3 / R2.4 window ratio); None → NULL.
            'spec_decode_acceptance_rate': gpu_columns.get('spec_decode_acceptance_rate'),
            **cost_cols,
            # Private (not a Parquet column): feeds the printed cost summary.
            '_cost_reason': cost_reason,
            '_bedrock': bedrock,
        }
        records.append(record)

    return records


def validate_input(config, results):
    """Validate config context and results for completeness.

    Two-argument interface: takes separate config and results dicts,
    merges them, and delegates to validate_benchmark_input.

    Args:
        config: dict with config context fields.
        results: dict with benchmark results (must have 'metrics' key).

    Returns:
        list of {"field": str, "reason": str} dicts for each validation failure.
        Empty list means validation passed.
    """
    merged = {}
    if isinstance(config, dict):
        merged.update(config)
    if isinstance(results, dict):
        metrics = results.get('metrics')
        if metrics is not None:
            merged['metrics'] = metrics
    return validate_benchmark_input(merged)


# ── Validation ────────────────────────────────────────────────────────────────


def validate_benchmark_input(data):
    """Validate that all required fields are present and valid.

    Args:
        data: dict containing the merged benchmark input (config context + results).
              If data is not a dict, returns a single root-level error.

    Returns:
        list of {"field": str, "reason": str} dicts for each validation failure.
        Empty list means validation passed.
    """
    # Guard against non-dict input
    if not isinstance(data, dict):
        return [{"field": "_root", "reason": "input must be a JSON object"}]

    errors = []

    for field in REQUIRED_FIELDS:
        value = data.get(field)

        if field == 'metrics':
            # metrics must be a non-empty list of objects
            if value is None:
                errors.append({
                    "field": field,
                    "reason": "required field is missing"
                })
            elif not isinstance(value, list) or len(value) == 0:
                errors.append({
                    "field": field,
                    "reason": "must be a non-empty array"
                })
            else:
                # Validate each metrics entry
                for i, entry in enumerate(value):
                    if not isinstance(entry, dict):
                        errors.append({
                            "field": f"metrics[{i}]",
                            "reason": "each metrics entry must be an object"
                        })
                        continue
                    # Each metrics entry must have concurrency as an integer
                    conc = entry.get('concurrency')
                    if conc is None:
                        errors.append({
                            "field": f"metrics[{i}].concurrency",
                            "reason": "required field is missing"
                        })
                    elif not isinstance(conc, int) or isinstance(conc, bool):
                        errors.append({
                            "field": f"metrics[{i}].concurrency",
                            "reason": "must be an integer"
                        })
        elif field == 'instance_type':
            # instance_type must be a non-empty string matching ml.* pattern
            if value is None:
                errors.append({
                    "field": field,
                    "reason": "required field is missing"
                })
            elif not isinstance(value, str):
                errors.append({
                    "field": field,
                    "reason": "must be a non-empty string"
                })
            elif value.strip() == '':
                errors.append({
                    "field": field,
                    "reason": "must be a non-empty string"
                })
            elif not _INSTANCE_TYPE_RE.match(value):
                errors.append({
                    "field": field,
                    "reason": "must match ml.* pattern (e.g., ml.g5.xlarge)"
                })
        else:
            # String fields must be present and non-empty
            if value is None:
                errors.append({
                    "field": field,
                    "reason": "required field is missing"
                })
            elif not isinstance(value, str):
                errors.append({
                    "field": field,
                    "reason": "must be a non-empty string"
                })
            elif value.strip() == '':
                errors.append({
                    "field": field,
                    "reason": "must be a non-empty string"
                })

    return errors


def emit_validation_error(errors):
    """Output structured validation error JSON and exit with code 1.

    Args:
        errors: list of {"field": str, "reason": str} dicts.

    Output format:
        {"error": true, "validation_errors": [...]}

    Exits with code 1 — does NOT write to S3.
    """
    output = {
        "error": True,
        "validation_errors": errors
    }
    print(json.dumps(output))
    sys.exit(1)


# ── Partition Registration ────────────────────────────────────────────────────


def _column_signature(columns):
    """[(name, type)] for a Glue column list (comments ignored)."""
    out = []
    for col in columns or []:
        if isinstance(col, dict):
            out.append((col.get('Name'), col.get('Type')))
    return out


def reconcile_partition_columns(glue_client, glue_database, glue_table, partition_values, table_sd):
    """R11.4: make an existing partition's column list match the table's.

    A partition registered before a schema change keeps its old column list,
    which hides the new columns for every file under it. Compares (name, type)
    lists and calls UpdatePartition ONLY when they differ (idempotent).
    Returns (reconciled: bool, error: str | None). Never raises.
    """
    try:
        resp = glue_client.get_partition(
            DatabaseName=glue_database, TableName=glue_table, PartitionValues=partition_values)
    except Exception as e:
        return False, f"GetPartition failed: {e}"
    partition = resp.get('Partition') if isinstance(resp, dict) else None
    if not isinstance(partition, dict):
        return False, None
    part_sd = partition.get('StorageDescriptor') or {}
    table_cols = table_sd.get('Columns') or []
    if _column_signature(part_sd.get('Columns')) == _column_signature(table_cols):
        return False, None
    new_sd = {k: v for k, v in part_sd.items()}
    new_sd['Columns'] = table_cols
    partition_input = {
        'Values': partition.get('Values') or partition_values,
        'StorageDescriptor': new_sd,
    }
    if isinstance(partition.get('Parameters'), dict):
        partition_input['Parameters'] = partition['Parameters']
    try:
        glue_client.update_partition(
            DatabaseName=glue_database, TableName=glue_table,
            PartitionValueList=partition_values, PartitionInput=partition_input)
    except Exception as e:
        return False, f"UpdatePartition failed: {e}"
    return True, None


def _already_exists_result(glue_client, glue_database, glue_table, partition_values, location, table_sd):
    reconciled, error = reconcile_partition_columns(
        glue_client, glue_database, glue_table, partition_values, table_sd)
    return {
        'registered': False,
        'already_exists': True,
        'reconciled': reconciled,
        'partition_values': partition_values,
        'location': location,
        'error': error,
    }


def register_partition(bucket, model, instance, target,
                       glue_database='mlcc_ci', glue_table='benchmark_results',
                       glue_client=None, region='us-east-1'):
    """Register a partition in the Glue catalog via BatchCreatePartition.

    After writing Parquet to S3, this function ensures the partition is
    registered in the Glue Data Catalog so the data is immediately
    queryable via Athena. If the partition already exists, the error is
    swallowed silently (idempotent behavior).

    Uses model/instance/target partitioning scheme matching the S3 data layout.

    Args:
        bucket: S3 bucket name.
        model: Model partition value (model name with / replaced by _, e.g., 'Qwen_Qwen3-0.6B').
        instance: Instance partition value (e.g., 'ml.g5.xlarge').
        target: Deployment target partition value (e.g., 'realtime-inference').
        glue_database: Glue database name (default: mlcc_ci).
        glue_table: Glue table name (default: benchmark_results).
        glue_client: Optional pre-configured boto3 Glue client (for testing).
                     If None, a new client is created for the given region.
        region: AWS region for the Glue client (default: us-east-1).

    Returns:
        dict with keys:
            - registered (bool): True if partition was newly created
            - already_exists (bool): True if partition already existed
            - partition_values (list): [model, instance, target]
            - location (str): S3 location for the partition
            - error (str|None): Error message if registration failed for
                                a reason other than already-exists

    Note:
        Per the design doc error handling table, partition registration
        failure is non-fatal — results are still readable via MSCK REPAIR TABLE.
        The caller should log a warning on error, not crash.
    """
    import boto3

    if glue_client is None:
        glue_client = boto3.client('glue', region_name=region)

    partition_values = [model, instance, target]
    location = f's3://{bucket}/results/model={model}/instance={instance}/target={target}/'

    # Get table StorageDescriptor to inherit columns/serde
    try:
        table_response = glue_client.get_table(
            DatabaseName=glue_database,
            Name=glue_table,
        )
    except Exception as e:
        error_msg = str(e)
        if 'EntityNotFoundException' in error_msg:
            return {
                'registered': False,
                'already_exists': False,
                'partition_values': partition_values,
                'location': location,
                'error': f"Table {glue_database}.{glue_table} not found in Glue catalog",
            }
        return {
            'registered': False,
            'already_exists': False,
            'partition_values': partition_values,
            'location': location,
            'error': f"Failed to get table metadata: {error_msg}",
        }

    table_sd = table_response['Table']['StorageDescriptor']

    # Build partition StorageDescriptor inheriting from table
    partition_sd = {
        'Columns': table_sd['Columns'],
        'Location': location,
        'InputFormat': table_sd.get('InputFormat', 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat'),
        'OutputFormat': table_sd.get('OutputFormat', 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat'),
        'SerdeInfo': table_sd.get('SerdeInfo', {
            'SerializationLibrary': 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            'Parameters': {'serialization.format': '1'},
        }),
        'Compressed': table_sd.get('Compressed', True),
    }

    partition_input = {
        'Values': partition_values,
        'StorageDescriptor': partition_sd,
        'Parameters': {
            'classification': 'parquet',
            'parquet.compression': 'SNAPPY',
        },
    }

    try:
        response = glue_client.batch_create_partition(
            DatabaseName=glue_database,
            TableName=glue_table,
            PartitionInputList=[partition_input],
        )
    except Exception as e:
        # Handle AlreadyExistsException thrown as an API exception
        if 'AlreadyExistsException' in str(e):
            return _already_exists_result(glue_client, glue_database, glue_table,
                                          partition_values, location, table_sd)
        return {
            'registered': False,
            'already_exists': False,
            'partition_values': partition_values,
            'location': location,
            'error': f"Failed to register partition: {e}",
        }

    # Check for errors in the batch response
    batch_errors = response.get('Errors', [])
    if batch_errors:
        error_detail = batch_errors[0].get('ErrorDetail', {})
        error_code = error_detail.get('ErrorCode', '')

        if error_code == 'AlreadyExistsException':
            return _already_exists_result(glue_client, glue_database, glue_table,
                                          partition_values, location, table_sd)
        else:
            error_msg = error_detail.get('ErrorMessage', 'unknown error')
            return {
                'registered': False,
                'already_exists': False,
                'partition_values': partition_values,
                'location': location,
                'error': f"Partition registration failed: {error_code} — {error_msg}",
            }

    return {
        'registered': True,
        'already_exists': False,
        'partition_values': partition_values,
        'location': location,
        'error': None,
    }


# ── Parquet Serialization ─────────────────────────────────────────────────────


def load_instance_catalog():
    """Load the instance catalog from the project-local .mlcc cache or the MLCC source tree.

    Resolution order:
    1. <project_root>/.mlcc/instances.json  (copied by src/app.js at generate time)
    2. <mlcc_source>/servers/lib/catalogs/instances.json (fallback for dev/test environment)

    Returns:
        dict mapping instance type strings to their metadata dicts.
    """
    this_dir = os.path.dirname(os.path.abspath(__file__))

    # 1. Project-local .mlcc cache. This writer lives at
    #    <project>/do/.benchmark_writer.py, so the project root is ONE level up
    #    (R4.1: the old '..', '..' resolved past it and never found the file).
    project_root = os.path.dirname(this_dir)
    mlcc_cache_path = os.path.join(project_root, '.mlcc', 'instances.json')
    try:
        with open(mlcc_cache_path, 'r') as f:
            data = json.load(f)
        # catalog_registration.py stores the catalog under 'instances' key
        catalog = data.get('catalog') or data.get('instances') or data
        if isinstance(catalog, dict):
            return catalog
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        pass

    # 2. MLCC source tree fallback (dev/test: templates/do/ → templates/ → repo root)
    source_root = os.path.normpath(os.path.join(this_dir, '..', '..'))
    catalog_path = os.path.join(source_root, 'servers', 'lib', 'catalogs', 'instances.json')
    try:
        with open(catalog_path, 'r') as f:
            data = json.load(f)
        return data.get('catalog', {})
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return {}


def resolve_instance_metadata(instance_type, instance_catalog=None):
    """Resolve GPU metadata from the instance catalog for a given instance_type.

    Args:
        instance_type: SageMaker instance type (e.g., 'ml.g5.xlarge').
        instance_catalog: Optional pre-loaded catalog dict. If None, loads from disk.

    Returns:
        dict with keys: gpu_count (int|None), gpu_type (str|None), gpu_memory_gb (float|None).
        All values are None if instance_type is not found in catalog.
    """
    if instance_catalog is None:
        instance_catalog = load_instance_catalog()

    entry = instance_catalog.get(instance_type)
    if entry is None:
        return {'gpu_count': None, 'gpu_type': None, 'gpu_memory_gb': None}

    return {
        'gpu_count': entry.get('gpus'),
        'gpu_type': entry.get('gpuType'),
        'gpu_memory_gb': entry.get('gpuMemoryGb'),
    }


def get_parquet_schema():
    """Return the pyarrow schema for benchmark_results, built from PARQUET_COLUMNS.

    Partition columns (model, instance, target) are NOT included here — they
    are encoded in the S3 path and handled by Glue/Athena partitioning.
    """
    import pyarrow as pa

    kind_to_type = {
        'string': pa.string(),
        'double': pa.float64(),
        'int': pa.int32(),
        'boolean': pa.bool_(),
    }
    return pa.schema([pa.field(name, kind_to_type[kind]) for name, kind in PARQUET_COLUMNS])


def _records_to_parquet_table(records):
    """Convert a list of enriched record dicts to a pyarrow Table.

    Args:
        records: List of dicts from enrich_records(). Each dict has string keys
                 matching the Athena DDL column names.

    Returns:
        pyarrow.Table with the correct schema and Snappy-compatible types.
    """
    import pyarrow as pa
    from datetime import datetime as dt

    schema = get_parquet_schema()

    # Build column arrays from the record dicts
    arrays = []
    for field in schema:
        col_name = field.name
        values = []
        for record in records:
            val = record.get(col_name)

            # Handle run_timestamp: ensure it's a string (schema is pa.string())
            if col_name == 'run_timestamp' and isinstance(val, dt):
                val = val.isoformat()
            elif col_name == 'run_timestamp' and val is None:
                val = None

            values.append(val)

        arrays.append(pa.array(values, type=field.type))

    return pa.table(arrays, schema=schema)


def _upload_to_s3(local_path, bucket, s3_uri, region):
    """Upload a local file to S3.

    Args:
        local_path: Path to the local Parquet file.
        bucket: S3 bucket name.
        s3_uri: Full S3 URI (s3://bucket/key).
        region: AWS region for the S3 client.
    """
    import boto3

    # Extract key from s3_uri
    # s3://bucket/key → key
    s3_key = s3_uri.replace(f's3://{bucket}/', '', 1)

    s3_client = boto3.client('s3', region_name=region)
    s3_client.upload_file(local_path, bucket, s3_key)




def _parse_jsonl_to_metrics(jsonl_path, concurrency=None):
    """Parse profile_export.jsonl and aggregate into metrics format.

    The JSONL file contains one JSON object per request with:
    - metadata: {session_num, request_start_ns, request_end_ns, ...}
    - metrics: {request_latency: {value, unit}, time_to_first_token: {value, unit}, ...}

    Returns a dict compatible with the existing validation/enrichment pipeline:
    {
        "metrics": [{concurrency, request_throughput, time_to_first_token: {avg,p50,p90,p99}, ...}]
    }
    """
    import math

    def _percentile(sorted_vals, pct):
        if not sorted_vals:
            return 0.0
        idx = (pct / 100.0) * (len(sorted_vals) - 1)
        lower = int(math.floor(idx))
        upper = int(math.ceil(idx))
        if lower == upper:
            return sorted_vals[lower]
        frac = idx - lower
        return sorted_vals[lower] * (1 - frac) + sorted_vals[upper] * frac

    def _get_val(metrics_dict, key):
        """Extract scalar value from a metric dict like {value: X, unit: "ms"}."""
        m = metrics_dict.get(key)
        if isinstance(m, dict):
            return m.get('value')
        return m

    records = []
    try:
        with open(jsonl_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except (FileNotFoundError, IOError) as e:
        return {"error": str(e)}

    if not records:
        return {"metrics": []}

    # Collect per-request metrics
    latencies = []
    ttfts = []
    itls = []
    ttsts = []
    output_tokens = []
    input_tokens = []
    prefill_tps = []
    output_tps = []
    start_times = []
    end_times = []
    # R3: AIPerf marks a failed request with a top-level `error` object
    # ({type, message, cause_chain}); successful records omit it. Errored
    # records carry no latency metrics, so the latency stats below already
    # exclude them.
    error_count = 0

    for rec in records:
        meta = rec.get('metadata', {})
        metrics = rec.get('metrics', {})
        if rec.get('error') is not None:
            error_count += 1

        lat = _get_val(metrics, 'request_latency')
        if lat is not None:
            latencies.append(lat)

        ttft = _get_val(metrics, 'time_to_first_token')
        if ttft is None:
            ttft = _get_val(metrics, 'time_to_first_output_token')
        if ttft is not None:
            ttfts.append(ttft)

        itl = _get_val(metrics, 'inter_token_latency')
        if itl is not None:
            itls.append(itl)

        ttst = _get_val(metrics, 'time_to_second_token')
        if ttst is not None:
            ttsts.append(ttst)

        otc = _get_val(metrics, 'output_token_count')
        if otc is not None:
            output_tokens.append(otc)

        isl = _get_val(metrics, 'input_sequence_length')
        if isl is not None:
            input_tokens.append(isl)

        ptps = _get_val(metrics, 'prefill_throughput_per_user')
        if ptps is not None:
            prefill_tps.append(ptps)

        otps = _get_val(metrics, 'output_token_throughput_per_user')
        if otps is not None:
            output_tps.append(otps)

        rs = meta.get('request_start_ns')
        re_ = meta.get('request_end_ns')
        if rs is not None:
            start_times.append(rs)
        if re_ is not None:
            end_times.append(re_)

    # Sort for percentiles
    latencies.sort()
    ttfts.sort()
    itls.sort()
    ttsts.sort()
    prefill_tps.sort()
    output_tps.sort()

    # Compute system throughput
    if start_times and end_times:
        duration_ns = max(end_times) - min(start_times)
        duration_s = duration_ns / 1e9 if duration_ns > 0 else 1.0
    else:
        duration_s = 1.0
    duration_s = max(duration_s, 0.001)

    n = len(records)
    req_throughput = n / duration_s
    total_out_tokens = sum(output_tokens) if output_tokens else 0
    token_throughput = total_out_tokens / duration_s

    # Determine concurrency (from arg or infer from max concurrent)
    conc = concurrency if concurrency is not None else n

    # Build metrics entry matching the schema expected by enrich_records
    entry = {
        'concurrency': conc,
        'request_throughput': req_throughput,
        'output_token_throughput': token_throughput,
        'total_token_throughput': (total_out_tokens + sum(input_tokens)) / duration_s if input_tokens else token_throughput,
        'total_requests': n,
        'error_count': error_count,
        'request_count': n,
        'duration_seconds': duration_s,
        'time_to_first_token': {
            'avg': sum(ttfts) / len(ttfts) if ttfts else 0.0,
            'p50': _percentile(ttfts, 50),
            'p90': _percentile(ttfts, 90),
            'p99': _percentile(ttfts, 99),
        },
        'inter_token_latency': {
            'avg': sum(itls) / len(itls) if itls else 0.0,
            'p50': _percentile(itls, 50),
            'p90': _percentile(itls, 90),
            'p99': _percentile(itls, 99),
        },
        'e2e_latency': {
            'avg': sum(latencies) / len(latencies) if latencies else 0.0,
            'p50': _percentile(latencies, 50),
            'p90': _percentile(latencies, 90),
            'p99': _percentile(latencies, 99),
        },
        'request_latency': {
            'avg': sum(latencies) / len(latencies) if latencies else 0.0,
            'p50': _percentile(latencies, 50),
            'p90': _percentile(latencies, 90),
            'p99': _percentile(latencies, 99),
        },
        'time_to_second_token': {
            'avg': sum(ttsts) / len(ttsts) if ttsts else 0.0,
            'p50': _percentile(ttsts, 50),
            'p90': _percentile(ttsts, 90),
        },
        'prefill_throughput': {
            'avg': sum(prefill_tps) / len(prefill_tps) if prefill_tps else 0.0,
            'p50': _percentile(prefill_tps, 50),
        },
        'output_token_throughput_detail': {
            'avg': sum(output_tps) / len(output_tps) if output_tps else 0.0,
            'p50': _percentile(output_tps, 50),
            'p90': _percentile(output_tps, 90),
        },
        'output_sequence_length': sum(output_tokens) / len(output_tokens) if output_tokens else 0.0,
        'input_sequence_length': sum(input_tokens) / len(input_tokens) if input_tokens else 0.0,
        'input_tokens_mean': int(sum(input_tokens) / len(input_tokens)) if input_tokens else 0,
        'output_tokens_mean': int(sum(output_tokens) / len(output_tokens)) if output_tokens else 0,
    }

    return {"metrics": [entry]}


# ── Command: write ────────────────────────────────────────────────────────────


# ── Wave 9 (R1, R6): per-level run window + store / scrape signals ───────────

# metrics_source provenance, keyed by the target descriptor's
# observability.store value (not by target name): which source contributed.
_STORE_PROVENANCE = {'cloudwatch-promql': 'cloudwatch_only', 'amp': 'amp'}
_SCRAPE_PROVENANCE = 'engine_metrics_only'

_GM_MODULE = None
# Window sources used by this write (printed once, R1.2).
_WINDOW_SOURCES = set()
_JOB_DESCRIPTIONS = {}


def _load_gpu_metrics():
    """Import do/lib/python/gpu_metrics.py (sibling lib of this writer)."""
    global _GM_MODULE
    if _GM_MODULE is None:
        import importlib.util as _ilu
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python', 'gpu_metrics.py')
        spec = _ilu.spec_from_file_location('gpu_metrics', path)
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _GM_MODULE = mod
    return _GM_MODULE


def _parse_time(value):
    """AIPerf / ISO / epoch timestamp → aware UTC datetime, or None.

    AIPerf 0.13 writes ``start_time``/``end_time`` as naive ISO strings in UTC
    (verified: job created 15:22 EDT, start_time 19:25 UTC). Epoch numbers are
    accepted in s / ms / us / ns by magnitude. Datetimes pass through.
    """
    if value is None or value == '':
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        v = float(value)
        if v > 1e17:      # nanoseconds
            v /= 1e9
        elif v > 1e14:    # microseconds
            v /= 1e6
        elif v > 1e11:    # milliseconds
            v /= 1e3
        try:
            return datetime.fromtimestamp(v, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def level_artifacts(results_path, concurrency):
    """Locate a level's AIPerf aggregate JSON and child job name (if any).

    * Sweep: ``<dir>/results-concurrency-<L>.json`` and ``<dir>/job-concurrency-<L>.txt``
      (written by do/benchmark's per-level copy step).
    * Single level: the sibling ``profile_export_aiperf.json`` of the JSONL, or
      the results file itself when it IS the AIPerf aggregate.
    Returns ``(aiperf_path_or_None, job_name_or_None)``.
    """
    if not results_path:
        return None, None
    d = os.path.dirname(os.path.abspath(results_path))
    aiperf, job = None, None
    try:
        level = int(concurrency) if concurrency is not None else None
    except (TypeError, ValueError):
        level = None
    if level is not None:
        per_level = os.path.join(d, f'results-concurrency-{level}.json')
        if os.path.isfile(per_level):
            aiperf = per_level
        try:
            with open(os.path.join(d, f'job-concurrency-{level}.txt'), encoding='utf-8') as f:
                job = f.read().strip() or None
        except OSError:
            job = None
    if aiperf is None:
        if results_path.endswith('.jsonl'):
            sibling = os.path.join(d, 'profile_export_aiperf.json')
            aiperf = sibling if os.path.isfile(sibling) else None
        elif os.path.basename(results_path) == 'profile_export_aiperf.json':
            aiperf = results_path
    return aiperf, job


def _load_json_quiet(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def describe_benchmark_job(job_name, region, client=None):
    """Read-only DescribeAIBenchmarkJob (cached per run); {} on any error."""
    if not job_name:
        return {}
    if job_name in _JOB_DESCRIPTIONS:
        return _JOB_DESCRIPTIONS[job_name]
    desc = {}
    try:
        if client is None:
            import boto3
            client = boto3.client('sagemaker', region_name=region or None)
        desc = client.describe_ai_benchmark_job(AIBenchmarkJobName=job_name) or {}
    except Exception:  # noqa: BLE001 — non-fatal: the next window source applies
        desc = {}
    _JOB_DESCRIPTIONS[job_name] = desc
    return desc


def resolve_run_window(aiperf_path=None, job_name=None, run_start=None, run_end=None,
                       region=None, sm_client=None):
    """R1.2 measured load window, in precedence order:

    1. ``start_time``/``end_time`` of the level's AIPerf aggregate JSON;
    2. ``DescribeAIBenchmarkJob`` ``StartTime``/``EndTime`` (includes job
       provisioning, so it is wider than the load);
    3. the bash ``--run-start/--run-end`` values.
    Returns ``(start, end, source)``; all None when no source is usable.
    """
    if aiperf_path:
        data = _load_json_quiet(aiperf_path) or {}
        start, end = _parse_time(data.get('start_time')), _parse_time(data.get('end_time'))
        if start and end and end > start:
            return start, end, 'aiperf'
    if job_name:
        desc = describe_benchmark_job(job_name, region, sm_client)
        start, end = _parse_time(desc.get('StartTime')), _parse_time(desc.get('EndTime'))
        if start and end and end > start:
            return start, end, 'benchmark-job'
    start, end = _parse_time(run_start), _parse_time(run_end)
    if start and end and end > start:
        return start, end, 'run-start/run-end'
    return None, None, None


def _selector_values(store, args, input_data, job_desc, target):
    """Role → value for the descriptor selector of this store."""
    if store == 'cloudwatch-promql':
        bt = ((job_desc or {}).get('BenchmarkTarget') or {}).get('Endpoint') or {}
        ics = bt.get('InferenceComponents') or []
        endpoint = getattr(args, 'endpoint_name', None) or bt.get('Identifier')
        ic = getattr(args, 'ic_name', None) or (ics[0].get('Identifier') if ics else None)
        values = {'endpoint': endpoint, 'inference_component': ic}
        if getattr(args, 'variant_name', None):
            values['variant'] = args.variant_name
        return values if endpoint else {}
    if store == 'amp':
        namespace = input_data.get('hp_namespace')
        if not namespace:
            try:
                optional = _load_gpu_metrics().target_manifest.read_manifest(target).get('optional_vars', {})
                namespace = optional.get('HP_NAMESPACE')
            except Exception:
                namespace = None
        deployment = input_data.get('project_name')
        return {'deployment': deployment, 'namespace': namespace} if deployment else {}
    return {}


def _scrape_signals(args, concurrency):
    """Engine-scrape fallback: an explicit --gpu-metrics-file, else this level's
    per-pod sidecars in --gpu-metrics-dir (R6.3). The fixed
    benchmarks/.last_gpu_metrics.json is never read here."""
    out = {}
    gpu_metrics_file = getattr(args, 'gpu_metrics_file', None)
    if gpu_metrics_file:
        data = _load_json_quiet(gpu_metrics_file) or {}
        out = {k: v for k, v in data.items()
               if k not in ('error', 'metrics_source', '_counters') and v is not None}
    gpu_metrics_dir = getattr(args, 'gpu_metrics_dir', None)
    if not out and gpu_metrics_dir and concurrency is not None:
        try:
            gm = _load_gpu_metrics()
            merged = gm.merge_sidecars(gm.sidecar_paths(gpu_metrics_dir, concurrency))
        except Exception:
            merged = {}
        out = {k: v for k, v in merged.items() if k != 'metrics_source' and v is not None}
    return out


def _has_signal(signals):
    return any(signals.get(k) is not None
               for k in (_CW_KEYS + _ENGINE_KEYS + ('spec_decode_acceptance_rate',)))


def _collect_gpu_signals(args, input_data, concurrency=None, aiperf_path=None, job_name=None):
    """Assemble GPU + engine signals for one benchmark level (BL086, Wave 9).

    Store (from the target descriptor's ``observability``): realtime queries
    CloudWatch PromQL, hyperpod-eks queries the add-on's AMP workspace — both
    over this level's measured window (resolve_run_window). Fallback (when the
    descriptor declares ``fallback: engine-scrape``): the opt-in port-forward
    poller sidecars fill any signal the store did not return.

    ``metrics_source`` provenance (table keyed by store, not target name):
      * cloudwatch_only     — only the CloudWatch PromQL store contributed.
      * amp                 — only the AMP store contributed.
      * engine_metrics_only — only the engine scrape contributed.
      * both                — the store and the scrape both contributed.
      * none                — nothing was collected.
    Never raises.
    """
    target = (input_data.get('deployment_target') or 'realtime-inference').strip().lower()
    region = input_data.get('region') or os.environ.get('AWS_REGION', '')
    try:
        gm = _load_gpu_metrics()
        obs = gm.target_manifest.observability(target)
    except Exception:
        gm, obs = None, {'store': 'none'}
    store = obs.get('store', 'none')

    store_signals = {}
    if gm is not None and store in _STORE_PROVENANCE:
        job = job_name or getattr(args, 'benchmark_job_name', None)
        start, end, source = resolve_run_window(
            aiperf_path, job, getattr(args, 'run_start', None), getattr(args, 'run_end', None), region)
        need_target = store == 'cloudwatch-promql' and not (
            getattr(args, 'endpoint_name', None) and getattr(args, 'ic_name', None))
        job_desc = describe_benchmark_job(job, region) if (job and need_target) else {}
        values = _selector_values(store, args, input_data, job_desc, target)
        if values and start is None:
            print('⚠️  No run window (no AIPerf start/end, job times or --run-start/--run-end); '
                  'GPU/engine columns stay NULL', file=sys.stderr)
        elif values:
            _WINDOW_SOURCES.add(source)
            try:
                store_signals, _used = gm.collect_for_target(
                    target, values, input_data.get('model_server'), start, end, region,
                    hp_cluster_name=input_data.get('hp_cluster_name'))
            except Exception:
                store_signals = {}

    scrape = _scrape_signals(args, concurrency) if obs.get('fallback') == 'engine-scrape' else {}

    signals = dict(scrape)
    signals.update(store_signals)
    has_store, has_scrape = _has_signal(store_signals), _has_signal(scrape)
    if has_store and has_scrape:
        signals['metrics_source'] = 'both'
    elif has_store:
        signals['metrics_source'] = _STORE_PROVENANCE[store]
    elif has_scrape:
        signals['metrics_source'] = _SCRAPE_PROVENANCE
    else:
        signals['metrics_source'] = 'none'
    return signals


def _read_config_vars(config_path, names):
    """Read plain VAR=value / export VAR="value" (and ${VAR:-default}) entries
    for ``names`` from a do/config file. Missing file → {}."""
    out = {}
    if not config_path or not names:
        return out
    try:
        with open(config_path, 'r') as f:
            lines = f.read().split('\n')
    except (OSError, IOError):
        return out
    for line in lines:
        line = line.strip()
        if line.startswith('export '):
            line = line[7:]
        if '=' not in line or line.startswith('#'):
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        if key not in names:
            continue
        value = value.strip().strip('"').strip("'")
        if value.startswith('${') and ':-' in value:
            value = value.split(':-', 1)[1].rstrip('}')
        if value.startswith('${') or value.startswith('$('):
            continue
        out[key] = value
    return out


def _resolve_cost_context(args, input_data, allow_api=True):
    """Resolve the price, billed instance count and Bedrock price lookup for a
    write (Wave 9 R7-R9). Service/component/count basis come from the target
    descriptor's ``pricing`` block. Never raises: any failure yields a context
    whose missing pieces carry a reason (→ NULL columns)."""
    try:
        pricing = _load_helper('pricing')
        target_manifest = _load_helper('target_manifest')
    except Exception as e:
        return {'price': {'usd_per_hour': None, 'reason': f'pricing helper unavailable: {e}'},
                'instance_count': None, 'instance_count_reason': 'pricing helper unavailable'}

    instance_type = input_data.get('instance_type', '')
    region = input_data.get('region', '') or os.environ.get('AWS_REGION', '')
    target = (input_data.get('deployment_target') or 'realtime-inference').strip()
    try:
        target = target_manifest.resolve_target(target)
    except Exception:
        pass

    price = pricing.resolve_instance_price(
        instance_type, region, target, cache_path=pricing.default_cache_path(),
        snapshot_path=pricing.default_snapshot_path(), allow_api=allow_api)
    # Design §10: a live-API failure is a warning naming the reason (and the
    # IAM action when it is an AccessDenied), whether or not a fallback hit.
    _api_note = price.get('fallback_reason') or price.get('reason') or ''
    if allow_api and 'pricing-api:' in _api_note and 'skipped (offline)' not in _api_note:
        print(f"⚠️  Pricing API lookup failed ({_api_note}); "
              f"price source: {price.get('source') or 'none (cost NULL)'}", file=sys.stderr)

    # Billed instance count (R8.2). Env first (do/benchmark sources do/config),
    # then the config file for standalone runs.
    try:
        spec_count = (target_manifest.pricing(target) or {}).get('instance_count') or {}
    except Exception:
        spec_count = {}
    var_names = {v for v in (spec_count.get('replicas_var'), spec_count.get('gpus_per_replica_var'),
                             'ENDPOINT_NAME') if v}
    env = _read_config_vars(getattr(args, 'config_file', None), var_names)
    env.update({k: os.environ[k] for k in var_names if os.environ.get(k)})
    hw = resolve_instance_metadata(instance_type)
    count, count_reason = pricing.compute_instance_count(
        target, gpus_per_instance=hw.get('gpu_count'), env=env,
        endpoint_name=getattr(args, 'endpoint_name', None) or env.get('ENDPOINT_NAME'),
        region=region, allow_api=allow_api)

    memo = {}

    def bedrock_prices(model, reg):
        key = (model, reg)
        if key not in memo:
            memo[key] = pricing.resolve_bedrock_prices(
                model, reg, cache_path=pricing.default_cache_path(),
                snapshot_path=pricing.default_snapshot_path(), allow_api=allow_api)
        return memo[key]

    return {
        'price': price,
        'instance_count': count,
        'instance_count_reason': count_reason,
        'bedrock_catalog': pricing.load_bedrock_catalog(),
        'bedrock_price_resolver': bedrock_prices,
    }


def _cost_summary(records):
    """Printed cost lines (R8.4/R8.5/R9.4) for a set of enriched records."""
    try:
        return _load_helper('pricing').cost_summary_lines(records)
    except Exception as e:
        return [f'cost summary unavailable: {e}']


def _public_records(records):
    """Strip the writer-private '_'-prefixed keys before JSON output."""
    return [{k: v for k, v in r.items() if not k.startswith('_')} for r in records]


def collect_level_context(args, input_data, metrics, results_path):
    """Per-level identity, error rate and signals for every metrics entry.

    Mutates each metric in place with ``benchmark_job_name`` (a sweep level's
    child job, R5.1) and ``request_error_rate`` (from that level's AIPerf JSON,
    R3.1) when available, and returns ``{concurrency: signals}`` (R1.3).
    """
    by_level = {}
    for metric in metrics or []:
        if not isinstance(metric, dict):
            continue
        conc = metric.get('concurrency')
        try:
            level = int(conc.get('avg') if isinstance(conc, dict) else conc)
        except (TypeError, ValueError):
            level = None
        aiperf_path, job = level_artifacts(results_path, level)
        if job and not metric.get('benchmark_job_name'):
            metric['benchmark_job_name'] = job
        if aiperf_path and 'request_error_rate' not in metric:
            agg = _load_json_quiet(aiperf_path) or {}
            if agg.get('request_error_rate') is not None:
                metric['request_error_rate'] = agg['request_error_rate']
        if level is not None and level not in by_level:
            by_level[level] = _collect_gpu_signals(args, input_data, level, aiperf_path, job)
    if _WINDOW_SOURCES:
        print(f"ℹ️  Metrics window source: {', '.join(sorted(_WINDOW_SOURCES))}", file=sys.stderr)
    return by_level


def cmd_write(args):
    """Validate, enrich, and write benchmark results to S3 as Parquet.

    Validation occurs before any S3 interaction. If validation fails,
    a structured error is emitted and no write occurs.
    """
    # Load benchmark results (JSON or JSONL)
    results_path = args.results_file or args.input
    if not results_path:
        _error_exit("--results-file (or --input) is required")

    if results_path.endswith('.jsonl'):
        # Parse JSONL (per-request data) and aggregate into metrics format
        benchmark_data = _parse_jsonl_to_metrics(results_path, concurrency=getattr(args, 'concurrency', None))
        if 'error' in benchmark_data:
            _error_exit(f"Failed to parse JSONL: {benchmark_data['error']}")
    else:
        try:
            with open(results_path, 'r') as f:
                benchmark_data = json.load(f)
        except FileNotFoundError:
            _error_exit(f"Results file not found: {results_path}")
        except json.JSONDecodeError as e:
            _error_exit(f"Invalid JSON in results file: {e}")
        except Exception as e:
            _error_exit(f"Failed to read results file: {e}")

    # Build the combined input data for validation
    # Merge CLI-provided fields with the benchmark results
    input_data = {}

    # Fields from config file (if provided)
    if args.config_file:
        try:
            config_context = _load_config_file(args.config_file)
            input_data.update(config_context)
        except Exception as e:
            _error_exit(f"Failed to read config file: {e}")

    # Fields from the benchmark results file
    if isinstance(benchmark_data, dict):
        metrics = benchmark_data.get('metrics')
        if metrics is not None:
            input_data['metrics'] = metrics
        else:
            # Single-level benchmark: raw results at top level without a 'metrics' wrapper.
            # Wrap into the expected array format for validation and enrichment.
            # Detect by presence of known metric fields (request_throughput, output_token_throughput, etc.)
            metric_indicators = ['request_throughput', 'output_token_throughput', 'time_to_first_token',
                                 'inter_token_latency', 'request_latency', 'concurrency']
            if any(k in benchmark_data for k in metric_indicators):
                # Use BENCHMARK_CONCURRENCY from config if concurrency not in the results
                if 'concurrency' not in benchmark_data:
                    benchmark_data['concurrency'] = int(input_data.get('benchmark_concurrency', 10))
                input_data['metrics'] = [benchmark_data]
        # Also pull any config fields from the results file
        for field in ['model_name', 'instance_type', 'deployment_config', 'project_name', 'region']:
            if field in benchmark_data and field not in input_data:
                input_data[field] = benchmark_data[field]
    elif isinstance(benchmark_data, list):
        # If the results file is just a raw metrics array
        input_data['metrics'] = benchmark_data

    # CLI args override config file and results file values
    if args.project_name:
        input_data['project_name'] = args.project_name
    if args.workload:
        input_data['workload'] = args.workload
    if args.region:
        input_data['region'] = args.region
    if args.adapter_name:
        input_data['adapter_name'] = args.adapter_name

    if getattr(args, 'instance_type', None):
        input_data['instance_type'] = args.instance_type
    # BL213: label the row with the target actually benchmarked, not whatever
    # DEPLOYMENT_TARGET the config file holds now.
    _bench_target = resolve_benchmarked_target(
        getattr(args, 'deployment_target', None) or input_data.get('deployment_target'),
        getattr(args, 'ic_name', None))
    if _bench_target:
        input_data['deployment_target'] = _bench_target

    # ── Validate before any S3 interaction ────────────────────────────────
    errors = validate_benchmark_input(input_data)
    if errors:
        emit_validation_error(errors)
        return  # Never reached, but explicit

    # ── Collect GPU efficiency signals (BL086), per level (Wave 9 R1.3) ────
    # Non-fatal: any collection error yields no signals (metrics_source='none').
    # Also fills each level's child job name and AIPerf error rate (R3, R5).
    gpu_by_level = collect_level_context(args, input_data, input_data['metrics'], results_path)
    gpu_signals = next(iter(gpu_by_level.values())) if len(gpu_by_level) == 1 else {}

    # ── Dry-run mode: output enriched records as JSON, skip S3 ──────────────
    if args.dry_run:
        timestamp = datetime.now(timezone.utc)

        # Split input_data back into config and results for enrich_records
        config_context = {k: v for k, v in input_data.items() if k != 'metrics'}
        results_obj = {'metrics': input_data['metrics']}
        if isinstance(benchmark_data, dict) and 'job_name' in benchmark_data:
            results_obj['job_name'] = benchmark_data['job_name']
        if not results_obj.get('job_name') and getattr(args, 'benchmark_job_name', None):
            results_obj['job_name'] = args.benchmark_job_name
        if getattr(args, 'run_name', None):
            results_obj['run_name'] = args.run_name

        # Dry run makes no live pricing / DescribeEndpoint call (cache + snapshot only).
        cost_context = _resolve_cost_context(args, input_data, allow_api=False)
        aiperf_aggs = find_aiperf_aggregates(
            results_path, getattr(args, 'aiperf_dir', None),
            [m.get('concurrency') for m in input_data['metrics'] if isinstance(m, dict)])
        enriched_records = enrich_records(config_context, results_obj, timestamp, gpu_metrics=gpu_signals,
                                          cost_context=cost_context, aiperf_aggregates=aiperf_aggs,
                                          gpu_metrics_by_concurrency=gpu_by_level)
        cost_lines = _cost_summary(enriched_records)

        # Compute intended S3 path (use bucket if provided, else placeholder)
        bucket = args.bucket or '<benchmark bucket (profile benchmarkS3Bucket)>'
        s3_path = compute_s3_path(bucket, input_data.get('project_name', ''), input_data.get('model_name', ''), input_data.get('instance_type', ''), input_data.get('deployment_target', 'realtime-inference'), timestamp)
        partition = compute_partition_info(input_data.get('model_name', ''), input_data.get('instance_type', ''), input_data.get('deployment_target', 'realtime-inference'))

        _output({
            "dry_run": True,
            "s3_path": s3_path,
            "partition": partition,
            "record_count": len(enriched_records),
            "records": _public_records(enriched_records),
            "cost_summary": cost_lines,
        })
        return  # Never reached after _output

    # ── Write to S3 (requires bucket) ─────────────────────────────────────
    if not args.bucket:
        _error_exit("--bucket is required when not using --dry-run")

    region = input_data.get('region', os.environ.get('AWS_REGION', ''))
    timestamp = datetime.now(timezone.utc)

    # Split input_data back into config and results for enrich_records
    config_context = {k: v for k, v in input_data.items() if k != 'metrics'}
    results_obj = {'metrics': input_data['metrics']}
    if isinstance(benchmark_data, dict) and 'job_name' in benchmark_data:
        results_obj['job_name'] = benchmark_data['job_name']
    # R5.1: the write path persists --benchmark-job-name too (previously only the
    # dry-run path did, so every Athena row had benchmark_job_name = '').
    if not results_obj.get('job_name') and getattr(args, 'benchmark_job_name', None):
        results_obj['job_name'] = args.benchmark_job_name
    if getattr(args, 'run_name', None):
        results_obj['run_name'] = args.run_name

    cost_context = _resolve_cost_context(args, input_data, allow_api=True)
    aiperf_aggs = find_aiperf_aggregates(
        results_path, getattr(args, 'aiperf_dir', None),
        [m.get('concurrency') for m in input_data['metrics'] if isinstance(m, dict)])
    enriched_records = enrich_records(config_context, results_obj, timestamp, gpu_metrics=gpu_signals,
                                      cost_context=cost_context, aiperf_aggregates=aiperf_aggs,
                                      gpu_metrics_by_concurrency=gpu_by_level)

    if not enriched_records:
        _error_exit("No records produced from benchmark metrics")

    # Compute S3 path
    s3_info = build_s3_path(args.bucket, input_data.get('project_name', ''), input_data.get('model_name', ''), input_data.get('instance_type', ''), input_data.get('deployment_target', 'realtime-inference'), timestamp, region=region)

    # Write Parquet to a temp file then upload to S3
    try:
        import tempfile
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as e:
        _error_exit(f"Missing dependency: {e}. Install: pip install pyarrow")

    # Build pyarrow table from enriched records
    table = _records_to_parquet_table(enriched_records)

    # Write to temp file with Snappy compression
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as tmp:
            tmp_path = tmp.name

        pq.write_table(table, tmp_path, compression='snappy')

        # Upload to S3
        _upload_to_s3(tmp_path, args.bucket, s3_info['s3_uri'], region)

    except Exception as e:
        _error_exit(f"Failed to write Parquet to S3: {e}")
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    # Register partition in Glue catalog to make data immediately queryable.
    # This is best-effort — failure is non-fatal per design doc error handling.
    # Data remains readable via MSCK REPAIR TABLE as a fallback.
    partition_result = None
    try:
        partition_result = register_partition(
            bucket=args.bucket,
            model=s3_info['partition_model'],
            instance=s3_info['partition_instance'],
            target=s3_info['partition_target'],
            region=region,
        )
    except SystemExit:
        # register_partition calls _error_exit on some failures; catch to avoid
        # terminating the process — the Parquet write already succeeded.
        partition_result = {"registered": False, "error": "partition registration failed (non-fatal)"}
    except Exception as e:
        partition_result = {"registered": False, "error": str(e)}

    if partition_result and partition_result.get('error'):
        print(
            f"\u26a0\ufe0f  Partition registration warning: {partition_result['error']}",
            file=sys.stderr,
        )

    # Cost summary (R8.4/R8.5): human lines on stderr (stdout stays JSON).
    cost_lines = _cost_summary(enriched_records)
    print('\n💲 Cost (' + input_data.get('deployment_target', 'realtime-inference') + '):', file=sys.stderr)
    for line in cost_lines:
        print(f'   {line}', file=sys.stderr)

    _output({
        "success": True,
        "s3_uri": s3_info['s3_uri'],
        "cost_summary": cost_lines,
        "partition": {
            "model": s3_info['partition_model'],
            "instance": s3_info['partition_instance'],
            "target": s3_info['partition_target'],
        },
        "rows_written": len(enriched_records),
        "project_name": input_data.get('project_name', ''),
        "run_timestamp": timestamp.isoformat(),
        "partition_registration": partition_result,
    })


def _load_config_file(config_path):
    """Load configuration context from a do/config shell file or JSON file.

    Supports two formats:
    - JSON file: parsed directly
    - Shell config file: extracts export VAR="value" assignments

    Returns:
        dict with recognized config fields.
    """
    context = {}

    try:
        # Try JSON first
        with open(config_path, 'r') as f:
            content = f.read().strip()

        if content.startswith('{'):
            data = json.loads(content)
            # Map known JSON fields to our expected names
            field_map = {
                'project_name': 'project_name',
                'projectName': 'project_name',
                'model_name': 'model_name',
                'modelName': 'model_name',
                'MODEL_NAME': 'model_name',
                'instance_type': 'instance_type',
                'instanceType': 'instance_type',
                'INSTANCE_TYPE': 'instance_type',
                'deployment_config': 'deployment_config',
                'deploymentConfig': 'deployment_config',
                'DEPLOYMENT_CONFIG': 'deployment_config',
                'region': 'region',
                'REGION': 'region',
                'deployment_target': 'deployment_target',
                'deploymentTarget': 'deployment_target',
                'tensor_parallel_degree': 'tensor_parallel_degree',
                'tensorParallelDegree': 'tensor_parallel_degree',
                'quantization': 'quantization',
                'enable_lora': 'enable_lora',
                'enableLora': 'enable_lora',
                'base_image': 'base_image',
                'baseImage': 'base_image',
                'base_image_version': 'base_image_version',
                'baseImageVersion': 'base_image_version',
                'mcc_version': 'mcc_version',
                'mccVersion': 'mcc_version',
                'account_id': 'account_id',
                'accountId': 'account_id',
            }
            for source_key, target_key in field_map.items():
                if source_key in data and target_key not in context:
                    val = data[source_key]
                    # Keep non-string types for certain fields
                    if target_key in ('tensor_parallel_degree',):
                        context[target_key] = int(val) if val is not None else val
                    elif target_key in ('enable_lora',):
                        context[target_key] = bool(val)
                    else:
                        context[target_key] = str(val) if val is not None else val
            return context

        # Parse shell-style config (export VAR="value" or VAR="value")
        for line in content.split('\n'):
            line = line.strip()
            if line.startswith('#') or not line:
                continue
            # Remove 'export ' prefix
            if line.startswith('export '):
                line = line[7:]
            # Parse VAR=value or VAR="value"
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                # Handle shell default syntax: ${VAR:-default} → extract default
                if value.startswith('${') and ':-' in value:
                    value = value.split(':-', 1)[1].rstrip('}')
                # Skip unresolved shell variables (e.g., ${INSTANCE_TYPE})
                if value.startswith('${') or value.startswith('$('):
                    continue
                # Map shell var names to our field names
                shell_map = {
                    'PROJECT_NAME': 'project_name',
                    'MODEL_NAME': 'model_name',
                    'HF_MODEL_ID': 'hf_model_id',
                    'INSTANCE_TYPE': 'instance_type',
                    'INSTANCE_POOLS': 'instance_pools',
                    'DEPLOYED_INSTANCE_TYPE': 'deployed_instance_type',
                    'BENCHMARK_INSTANCE_TYPE': 'benchmark_instance_type',
                    'DEPLOYMENT_CONFIG': 'deployment_config',
                    'DEPLOYMENT_TARGET': 'deployment_target',
                    'AWS_REGION': 'region',
                    'REGION': 'region',
                    'ACCOUNT_ID': 'account_id',
                    'MCC_VERSION': 'mcc_version',
                    'BASE_IMAGE': 'base_image',
                    'BASE_IMAGE_VERSION': 'base_image_version',
                    'BENCHMARK_CONCURRENCY': 'benchmark_concurrency',
                    # Wave 9: store lookup inputs (engine metric names, AMP
                    # discovery, AMP namespace selector).
                    'MODEL_SERVER': 'model_server',
                    'HP_CLUSTER_NAME': 'hp_cluster_name',
                    'HP_NAMESPACE': 'hp_namespace',
                }
                # Also capture IC_ENV_* serving config vars
                ic_env_map = {
                    'IC_ENV_VLLM_MAX_MODEL_LEN': 'max_model_len',
                    'IC_ENV_VLLM_QUANTIZATION': 'quantization',
                    'IC_ENV_VLLM_GPU_MEMORY_UTILIZATION': 'gpu_memory_utilization',
                    'IC_ENV_VLLM_KV_CACHE_DTYPE': 'kv_cache_dtype',
                    'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE': 'tensor_parallel_degree',
                    # HyperPod EKS: no IC config — map VLLM_* env vars directly.
                    # IC_ENV_* takes precedence (set later in the loop) for SMAI path.
                    'VLLM_QUANTIZATION': 'quantization',
                    'VLLM_MAX_MODEL_LEN': 'max_model_len',
                    'VLLM_KV_CACHE_DTYPE': 'kv_cache_dtype',
                    'VLLM_TENSOR_PARALLEL_SIZE': 'tensor_parallel_degree',
                    # HP_GPU_COUNT as fallback for tensor_parallel_degree when VLLM_TENSOR_PARALLEL_SIZE absent
                    'HP_GPU_COUNT': 'tensor_parallel_degree',
                }
                if key in shell_map:
                    context[shell_map[key]] = value
                elif key in ic_env_map:
                    context[ic_env_map[key]] = value

    except Exception:
        pass

    # Prefer HF_MODEL_ID over MODEL_NAME for the model_name field.
    # After do/stage runs, MODEL_NAME is rewritten to an S3 URI which is
    # unsuitable for S3 result paths (nested s3:// in path) and model family
    # derivation.  HF_MODEL_ID preserves the original HuggingFace repo ID.
    if context.get('hf_model_id'):
        context['model_name'] = context.pop('hf_model_id')
    elif context.get('model_name', '').startswith('s3://'):
        # Fallback: if no HF_MODEL_ID but MODEL_NAME is an S3 URI, extract
        # the model slug from the S3 path (last non-empty segment)
        parts = context['model_name'].rstrip('/').split('/')
        context['model_name'] = parts[-1] if parts else context['model_name']

    # Resolve instance_type precedence:
    #   BENCHMARK_INSTANCE_TYPE (live-resolved, persisted by do/benchmark) > INSTANCE_TYPE > INSTANCE_POOLS fallback
    if context.get('benchmark_instance_type'):
        context['instance_type'] = context.pop('benchmark_instance_type')
    elif context.get('deployed_instance_type'):
        context['instance_type'] = context.pop('deployed_instance_type')
    # Fall back to INSTANCE_POOLS when neither is set.
    # Heterogeneous pool configs may not have a standalone INSTANCE_TYPE value
    # but always define INSTANCE_POOLS as a JSON array with Priority fields.
    if not context.get('instance_type') and context.get('instance_pools'):
        try:
            pools = json.loads(context['instance_pools'])
            if pools:
                # Pick the highest-priority (lowest number) instance
                best = min(pools, key=lambda p: p.get('Priority', 999))
                context['instance_type'] = best.get('InstanceType', '')
        except (json.JSONDecodeError, TypeError, KeyError):
            pass
    context.pop('instance_pools', None)  # Don't leak raw JSON into record

    # Also scan IC config files (do/ic/*.conf) for IC_ENV_* serving params
    # These override do/config values for serving-specific settings
    try:
        import glob
        config_dir = os.path.dirname(os.path.abspath(config_path))
        ic_dir = os.path.join(config_dir, 'ic')
        ic_env_map = {
            'IC_ENV_VLLM_MAX_MODEL_LEN': 'max_model_len',
            'IC_ENV_VLLM_QUANTIZATION': 'quantization',
            'IC_ENV_VLLM_GPU_MEMORY_UTILIZATION': 'gpu_memory_utilization',
            'IC_ENV_VLLM_KV_CACHE_DTYPE': 'kv_cache_dtype',
            'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE': 'tensor_parallel_degree',
        }
        for conf_file in sorted(glob.glob(os.path.join(ic_dir, '*.conf'))):
            with open(conf_file, 'r') as f:
                for line in f:
                    match = re.match(r'^export\s+([A-Z_][A-Z0-9_]*)=["\']?([^"\']*)["\']?\s*$', line.strip())
                    if match:
                        key, value = match.group(1), match.group(2)
                        if key in ic_env_map and value:
                            context[ic_env_map[key]] = value
    except Exception:
        pass  # IC config scanning is best-effort

    return context


# ── CLI entry point ───────────────────────────────────────────────────────────


def main():
    """Parse CLI args and dispatch to subcommand."""
    parser = argparse.ArgumentParser(
        description='Benchmark Writer — Convert benchmark results to Athena-compatible Parquet'
    )
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # write subcommand
    write_parser = subparsers.add_parser('write', help='Write benchmark results to S3')
    write_parser.add_argument(
        '--input',
        help='Path to benchmark results JSON file (alias for --results-file)'
    )
    write_parser.add_argument(
        '--results-file', dest='results_file',
        help='Path to benchmark results JSON file'
    )
    write_parser.add_argument(
        '--config-file', dest='config_file',
        help='Path to config file (do/config or JSON) for context fields'
    )
    write_parser.add_argument(
        '--project-name', dest='project_name',
        help='MCC project name (human-readable identifier)'
    )
    write_parser.add_argument(
        '--workload', default='manual',
        help='Named workload profile (from workload-picker MCP, default: manual)'
    )
    write_parser.add_argument(
        '--concurrency', type=int, default=None,
        help='Concurrency level (passed to JSONL aggregation if results are per-request)'
    )
    write_parser.add_argument(
        '--bucket',
        help='S3 bucket name for results (required unless --dry-run)'
    )
    write_parser.add_argument(
        '--region',
        help='AWS region'
    )
    write_parser.add_argument(
        '--adapter-name', dest='adapter_name', default=None,
        help='LoRA adapter name (differentiates adapter benchmarks from base model in Athena)'
    )

    write_parser.add_argument(
        '--instance-type', dest='instance_type', default=None,
        help='Override instance type (use when actual provisioned instance differs from config, e.g. heterogeneous pools)'
    )
    write_parser.add_argument(
        '--dry-run', dest='dry_run', action='store_true',
        help='Output enriched records as JSON without writing to S3'
    )

    # ── GPU efficiency signals (BL086) ─────────────────────────────────────
    write_parser.add_argument(
        '--endpoint-name', dest='endpoint_name', default=None,
        help='SageMaker endpoint name (enables post-run CloudWatch GPU enrichment)'
    )
    write_parser.add_argument(
        '--variant-name', dest='variant_name', default=None,
        help='Production variant name for CloudWatch GPU enrichment (default: AllTraffic)'
    )
    write_parser.add_argument(
        '--ic-name', dest='ic_name', default=None,
        help='Inference component name for per-IC CloudWatch GPU enrichment'
    )
    write_parser.add_argument(
        '--deployment-target', dest='deployment_target', default=None,
        help='The deployment target this run benchmarked (BL213; overrides the config file '
             'DEPLOYMENT_TARGET, which can be stale; aliases resolve via targets.d)'
    )

    write_parser.add_argument(
        '--benchmark-job-name', dest='benchmark_job_name', default=None,
        help='AIPerf benchmark job name (written as benchmark_job_name in Athena)'
    )
    write_parser.add_argument(
        '--run-name', dest='run_name', default=None,
        help='Human-readable run identifier (petname_workload_concurrency) written as run_name in Athena'
    )
    write_parser.add_argument(
        '--run-start', dest='run_start', default=None,
        help='ISO 8601 UTC benchmark run start time (for the CloudWatch query window)'
    )
    write_parser.add_argument(
        '--run-end', dest='run_end', default=None,
        help='ISO 8601 UTC benchmark run end time (for the CloudWatch query window)'
    )
    write_parser.add_argument(
        '--aiperf-dir', dest='aiperf_dir', default=None,
        help='Directory holding per-level results-concurrency-<L>.json AIPerf aggregate files '
             '(BL128; default: the results file directory, or the sibling profile_export_aiperf.json)'
    )
    write_parser.add_argument(
        '--gpu-metrics-file', dest='gpu_metrics_file', default=None,
        help='Path to a JSON file of pre-collected engine /metrics signals (Phase 2 EKS scrape)'
    )
    write_parser.add_argument(
        '--gpu-metrics-dir', dest='gpu_metrics_dir', default=None,
        help='Directory of THIS run\'s per-pod, per-level scrape sidecars '
             '(gpu_metrics-c<level>-<pod>.json); merged per level (Wave 9 R6.3)'
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == 'write':
        cmd_write(args)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # Catch all unexpected exceptions and emit structured error
        # This ensures we NEVER produce a raw traceback
        print(json.dumps({"error": f"unexpected error: {e}"}))
        sys.exit(1)
