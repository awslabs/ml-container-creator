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
_INSTANCE_TYPE_RE = re.compile(r'^ml\.[a-z0-9]+\.[a-z0-9]+$')

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

# Approximate on-demand $/hr for common SageMaker AI instances
INSTANCE_PRICING_USD_PER_HOUR = {
    'g5.xlarge': 1.408,
    'g5.2xlarge': 1.52,
    'g5.4xlarge': 2.03,
    'g5.8xlarge': 3.06,
    'g5.12xlarge': 7.09,
    'g5.16xlarge': 5.10,
    'g5.24xlarge': 10.18,
    'g5.48xlarge': 20.36,
    'g6.xlarge': 1.00,
    'g6.2xlarge': 1.21,
    'g6.4xlarge': 1.62,
    'g6.8xlarge': 2.44,
    'g6.12xlarge': 5.66,
    'g6.16xlarge': 4.07,
    'g6.24xlarge': 7.53,
    'g6.48xlarge': 15.06,
    'g6e.xlarge': 1.86,
    'g6e.2xlarge': 2.35,
    'g6e.4xlarge': 3.34,
    'g6e.12xlarge': 11.67,
    'g6e.48xlarge': 38.12,
    'p4d.24xlarge': 37.69,
    'p5.48xlarge': 65.85,
    'trn2.48xlarge': 21.50,
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


def compute_cost_per_1m_tokens(instance_type, tokens_per_second):
    """Estimate cost per 1M output tokens (USD).

    Uses approximate on-demand SageMaker AI instance pricing.
    If tokens_per_second is 0 or unknown, returns None.

    Args:
        instance_type: SageMaker AI instance type string.
        tokens_per_second: Output tokens/second throughput.

    Returns:
        float or None — estimated USD cost per 1M output tokens.
    """
    if not instance_type or not tokens_per_second:
        return None
    if tokens_per_second <= 0:
        return None

    # Extract instance spec (remove ml. prefix)
    instance_spec = instance_type.replace('ml.', '', 1) if instance_type.startswith('ml.') else instance_type
    cost_per_hour = INSTANCE_PRICING_USD_PER_HOUR.get(instance_spec)
    if cost_per_hour is None:
        return None

    # cost_per_1m_tokens = (cost_per_hour / tokens_per_second / 3600) * 1_000_000
    cost_per_token = cost_per_hour / (tokens_per_second * 3600)
    return round(cost_per_token * 1_000_000, 4)


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


def enrich_records(config, results, run_timestamp=None, instance_catalog=None):
    """Build enriched records from config context and benchmark results.

    Each metrics entry becomes one enriched record with all Athena columns populated.

    Args:
        config: dict with config context fields (project_name, model_name, etc.)
        results: dict with benchmark results (job_name, metrics array)
        run_timestamp: Optional datetime for run_timestamp. Defaults to now UTC.
        instance_catalog: Optional pre-loaded instance catalog dict. If None, loaded from disk.

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
        error_count = metric.get('error_count', 0)
        total_requests = scalar(metric.get('total_requests', 0))
        duration_seconds = scalar(metric.get('duration_seconds', 0), stat='avg')
        input_tokens_mean = metric.get('input_tokens_mean', 0)
        output_tokens_mean = metric.get('output_tokens_mean', 0)

        # Latency percentiles
        ttft = metric.get('time_to_first_token', {})
        itl = metric.get('inter_token_latency', {})

        # Error rate
        error_rate = (error_count / total_requests) if total_requests > 0 else 0.0

        # Status based on error rate
        if error_rate >= 1.0:
            status = 'failed'
        else:
            status = 'completed'

        # Cost computation
        cost = compute_cost_per_1m_tokens(instance_type, tokens_per_second)

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
            'cost_per_1m_tokens': cost,
            'benchmark_duration_sec': metric.get('benchmark_duration_sec', duration_seconds),
            'run_type': run_type,
            'benchmark_job_name': results.get('job_name', '') if isinstance(results, dict) else '',
            'mcc_version': mcc_version,
            'run_timestamp': run_timestamp.isoformat(),
            'region': region,
            'adapter_name': config.get('adapter_name', ''),
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
            return {
                'registered': False,
                'already_exists': True,
                'partition_values': partition_values,
                'location': location,
                'error': None,
            }
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
            return {
                'registered': False,
                'already_exists': True,
                'partition_values': partition_values,
                'location': location,
                'error': None,
            }
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
    """Load the instance catalog from servers/lib/catalogs/instances.json.

    Resolves the path relative to the project root (two levels up from templates/do/).
    Returns the 'catalog' dict mapping instance_type → metadata, or empty dict on failure.

    Returns:
        dict mapping instance type strings to their metadata dicts.
    """
    # Resolve relative to this file: templates/do/.benchmark_writer.py → project root
    this_dir = os.path.dirname(os.path.abspath(__file__))
    # Navigate up from templates/do/ to project root
    project_root = os.path.normpath(os.path.join(this_dir, '..', '..'))
    catalog_path = os.path.join(project_root, 'servers', 'lib', 'catalogs', 'instances.json')

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
    """Return the pyarrow schema matching the Athena DDL for benchmark_results.

    All columns defined in the Athena DDL are included. Partition columns
    (model, instance, target) are NOT included here — they are encoded in the
    S3 path and handled by Glue/Athena partitioning.
    """
    import pyarrow as pa

    return pa.schema([
        # Identity
        pa.field("project_name", pa.string()),

        # Model + Serving Config (queryable columns)
        pa.field("model_name", pa.string()),
        pa.field("model_family", pa.string()),
        pa.field("instance_type", pa.string()),
        pa.field("deployment_config", pa.string()),
        pa.field("deployment_target", pa.string()),
        pa.field("quantization", pa.string()),
        pa.field("tensor_parallel_degree", pa.int32()),

        # Hardware metadata (resolved from instance catalog at write time)
        pa.field("instance_family", pa.string()),
        pa.field("gpu_count", pa.int32()),
        pa.field("gpu_type", pa.string()),
        pa.field("gpu_memory_gb", pa.float64()),

        # Configuration dimensions (top-level for Athena queryability)
        pa.field("max_model_len", pa.int32()),
        pa.field("enable_lora", pa.bool_()),
        pa.field("kv_cache_dtype", pa.string()),

        # Full serving config (extensible JSON blob)
        pa.field("serving_config", pa.string()),

        # Workload
        pa.field("workload", pa.string()),
        pa.field("concurrency", pa.int32()),
        pa.field("input_tokens_mean", pa.int32()),
        pa.field("output_tokens_mean", pa.int32()),
        pa.field("streaming", pa.bool_()),
        pa.field("duration_seconds", pa.int32()),

        # Rich Metrics
        pa.field("request_throughput_rps", pa.float64()),
        pa.field("total_token_throughput_tps", pa.float64()),
        pa.field("output_token_throughput_tps", pa.float64()),
        pa.field("request_count", pa.float64()),
        pa.field("ttft_avg_ms", pa.float64()),
        pa.field("ttft_p50_ms", pa.float64()),
        pa.field("ttft_p90_ms", pa.float64()),
        pa.field("ttft_p99_ms", pa.float64()),
        pa.field("itl_avg_ms", pa.float64()),
        pa.field("itl_p50_ms", pa.float64()),
        pa.field("itl_p90_ms", pa.float64()),
        pa.field("itl_p99_ms", pa.float64()),
        pa.field("e2e_latency_avg_ms", pa.float64()),
        pa.field("e2e_latency_p50_ms", pa.float64()),
        pa.field("e2e_latency_p90_ms", pa.float64()),
        pa.field("e2e_latency_p99_ms", pa.float64()),
        pa.field("prefill_tps_avg", pa.float64()),
        pa.field("prefill_tps_p50", pa.float64()),
        pa.field("output_token_tps_avg", pa.float64()),
        pa.field("output_token_tps_p50", pa.float64()),
        pa.field("output_token_tps_p90", pa.float64()),
        pa.field("ttst_p50_ms", pa.float64()),
        pa.field("ttst_p90_ms", pa.float64()),
        pa.field("output_sequence_length_avg", pa.float64()),
        pa.field("input_sequence_length_avg", pa.float64()),
        pa.field("error_rate", pa.float64()),
        pa.field("cost_per_1m_tokens", pa.float64()),
        pa.field("benchmark_duration_sec", pa.float64()),

        # Run Metadata
        pa.field("run_type", pa.string()),
        pa.field("benchmark_job_name", pa.string()),
        pa.field("mcc_version", pa.string()),
        pa.field("run_timestamp", pa.string()),
        pa.field("region", pa.string()),
        pa.field("adapter_name", pa.string()),
    ])


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

    for rec in records:
        meta = rec.get('metadata', {})
        metrics = rec.get('metrics', {})

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

    # ── Validate before any S3 interaction ────────────────────────────────
    errors = validate_benchmark_input(input_data)
    if errors:
        emit_validation_error(errors)
        return  # Never reached, but explicit

    # ── Dry-run mode: output enriched records as JSON, skip S3 ──────────────
    if args.dry_run:
        timestamp = datetime.now(timezone.utc)

        # Split input_data back into config and results for enrich_records
        config_context = {k: v for k, v in input_data.items() if k != 'metrics'}
        results_obj = {'metrics': input_data['metrics']}
        if isinstance(benchmark_data, dict) and 'job_name' in benchmark_data:
            results_obj['job_name'] = benchmark_data['job_name']

        enriched_records = enrich_records(config_context, results_obj, timestamp)

        # Compute intended S3 path (use bucket if provided, else placeholder)
        bucket = args.bucket or f'mlcc-benchmark-results-<accountId>-{input_data["region"]}'
        s3_path = compute_s3_path(bucket, input_data.get('project_name', ''), input_data.get('model_name', ''), input_data.get('instance_type', ''), input_data.get('deployment_target', 'realtime-inference'), timestamp)
        partition = compute_partition_info(input_data.get('model_name', ''), input_data.get('instance_type', ''), input_data.get('deployment_target', 'realtime-inference'))

        _output({
            "dry_run": True,
            "s3_path": s3_path,
            "partition": partition,
            "record_count": len(enriched_records),
            "records": enriched_records,
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

    enriched_records = enrich_records(config_context, results_obj, timestamp)

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

    _output({
        "success": True,
        "s3_uri": s3_info['s3_uri'],
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
                }
                # Also capture IC_ENV_* serving config vars
                ic_env_map = {
                    'IC_ENV_VLLM_MAX_MODEL_LEN': 'max_model_len',
                    'IC_ENV_VLLM_QUANTIZATION': 'quantization',
                    'IC_ENV_VLLM_GPU_MEMORY_UTILIZATION': 'gpu_memory_utilization',
                    'IC_ENV_VLLM_KV_CACHE_DTYPE': 'kv_cache_dtype',
                    'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE': 'tensor_parallel_degree',
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
