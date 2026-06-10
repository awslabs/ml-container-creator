#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
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
    'config_id',
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


def compute_s3_path(bucket, config_id, region, timestamp):
    """Construct the full S3 URI for a benchmark run Parquet file.

    Args:
        bucket: S3 bucket name.
        config_id: Configuration ID.
        region: AWS region string.
        timestamp: datetime object for the run timestamp.

    Returns:
        str — full S3 URI.
    """
    year = timestamp.strftime('%Y')
    month = timestamp.strftime('%m')
    ts_str = timestamp.strftime('%Y%m%dT%H%M%SZ')
    filename = f'run-{config_id}-{ts_str}.parquet'

    return f's3://{bucket}/region={region}/year={year}/month={month}/{filename}'


def compute_partition_info(region, timestamp):
    """Compute partition metadata dict.

    Args:
        region: AWS region string.
        timestamp: datetime object.

    Returns:
        dict with keys: region, year, month.
    """
    return {
        "region": region,
        "year": timestamp.strftime('%Y'),
        "month": timestamp.strftime('%m'),
    }


def build_s3_path(bucket, region, config_id, timestamp=None):
    """Construct the S3 path and partition info for a benchmark run.

    Args:
        bucket: S3 bucket name.
        region: AWS region string.
        config_id: Configuration ID.
        timestamp: datetime object or None (defaults to now UTC).

    Returns:
        dict with keys: s3_uri, partition_region, partition_year, partition_month, filename.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)

    year = timestamp.strftime('%Y')
    month = timestamp.strftime('%m')
    ts_str = timestamp.strftime('%Y%m%dT%H%M%SZ')
    filename = f'run-{config_id}-{ts_str}.parquet'

    s3_uri = f's3://{bucket}/region={region}/year={year}/month={month}/{filename}'

    return {
        's3_uri': s3_uri,
        'partition_region': region,
        'partition_year': year,
        'partition_month': month,
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


def enrich_records(config, results, run_timestamp=None):
    """Build enriched records from config context and benchmark results.

    Each metrics entry becomes one enriched record with all Athena columns populated.

    Args:
        config: dict with config context fields (config_id, model_name, etc.)
        results: dict with benchmark results (job_name, metrics array)
        run_timestamp: Optional datetime for run_timestamp. Defaults to now UTC.

    Returns:
        list of enriched record dicts (one per concurrency level).
    """
    if run_timestamp is None:
        run_timestamp = datetime.now(timezone.utc)

    model_name = config.get('model_name', '')
    instance_type = config.get('instance_type', '')
    config_id = config.get('config_id', '')
    deployment_config = config.get('deployment_config', '')
    region = config.get('region', '')

    # Derived fields
    model_family = derive_model_family(model_name)
    instance_family = derive_instance_family(instance_type)

    # Optional context fields
    deployment_target = config.get('deployment_target', 'realtime-inference')
    tensor_parallel_degree = config.get('tensor_parallel_degree', 1)
    quantization = config.get('quantization', 'none')
    enable_lora = config.get('enable_lora', False)
    base_image = config.get('base_image', '')
    base_image_version = config.get('base_image_version', '') or _extract_base_image_version(base_image)
    mcc_version = config.get('mcc_version', '')
    run_type = config.get('run_type', 'ci')
    ci_run_id = config.get('ci_run_id', '')
    account_id = config.get('account_id', '')

    # Partition keys
    year = run_timestamp.strftime('%Y')
    month = run_timestamp.strftime('%m')

    # Get metrics from results
    metrics = results.get('metrics', []) if isinstance(results, dict) else []

    records = []
    for metric in metrics:
        concurrency = metric.get('concurrency', 0)
        throughput_rps = metric.get('request_throughput', 0.0)
        tokens_per_second = metric.get('output_token_throughput', 0.0)
        error_count = metric.get('error_count', 0)
        total_requests = metric.get('total_requests', 0)
        duration_seconds = metric.get('duration_seconds', 0)
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

        record = {
            'config_id': config_id,
            'model_name': model_name,
            'model_family': model_family,
            'instance_type': instance_type,
            'instance_family': instance_family,
            'deployment_config': deployment_config,
            'deployment_target': deployment_target,
            'run_timestamp': run_timestamp.isoformat(),
            'tensor_parallel_degree': tensor_parallel_degree,
            'quantization': quantization,
            'enable_lora': enable_lora,
            'base_image': base_image,
            'base_image_version': base_image_version,
            'mcc_version': mcc_version,
            'concurrency': concurrency,
            'input_tokens_mean': input_tokens_mean,
            'output_tokens_mean': output_tokens_mean,
            'duration_seconds': duration_seconds,
            'ttft_p50_ms': ttft.get('p50', 0.0),
            'ttft_p99_ms': ttft.get('p99', 0.0),
            'itl_p50_ms': itl.get('p50', 0.0),
            'itl_p99_ms': itl.get('p99', 0.0),
            'throughput_rps': throughput_rps,
            'tokens_per_second': tokens_per_second,
            'cost_per_1m_tokens': cost,
            'error_rate': error_rate,
            'status': status,
            'run_type': run_type,
            'ci_run_id': ci_run_id,
            'ci_stage': 'stage2-benchmark',
            'benchmark_job_name': results.get('job_name', '') if isinstance(results, dict) else '',
            'account_id': account_id,
            'region': region,
            'year': year,
            'month': month,
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


def register_partition(bucket, region, year, month,
                       glue_database='mlcc_ci', glue_table='benchmark_results',
                       glue_client=None):
    """Register a partition in the Glue catalog via BatchCreatePartition.

    After writing Parquet to S3, this function ensures the partition is
    registered in the Glue Data Catalog so the data is immediately
    queryable via Athena. If the partition already exists, the error is
    swallowed silently (idempotent behavior).

    Args:
        bucket: S3 bucket name.
        region: Partition region value (e.g., 'us-east-1').
        year: Partition year value as string (e.g., '2026').
        month: Partition month value as string (e.g., '06').
        glue_database: Glue database name (default: mlcc_ci).
        glue_table: Glue table name (default: benchmark_results).
        glue_client: Optional pre-configured boto3 Glue client (for testing).
                     If None, a new client is created for the given region.

    Returns:
        dict with keys:
            - registered (bool): True if partition was newly created
            - already_exists (bool): True if partition already existed
            - partition_values (list): [region, year, month]
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

    partition_values = [region, year, month]
    location = f's3://{bucket}/region={region}/year={year}/month={month}/'

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


def get_parquet_schema():
    """Return the pyarrow schema matching the Athena DDL for benchmark_results.

    All columns defined in the Athena DDL are included. Partition columns
    (region, year, month) are NOT included here — they are encoded in the
    S3 path and handled by Glue/Athena partitioning.
    """
    import pyarrow as pa

    return pa.schema([
        # Core dimensions
        pa.field("config_id", pa.string()),
        pa.field("model_name", pa.string()),
        pa.field("model_family", pa.string()),
        pa.field("instance_type", pa.string()),
        pa.field("instance_family", pa.string()),
        pa.field("deployment_config", pa.string()),
        pa.field("deployment_target", pa.string()),
        pa.field("run_timestamp", pa.timestamp("ms", tz="UTC")),

        # Configuration dimensions
        pa.field("tensor_parallel_degree", pa.int32()),
        pa.field("quantization", pa.string()),
        pa.field("enable_lora", pa.bool_()),
        pa.field("base_image", pa.string()),
        pa.field("base_image_version", pa.string()),
        pa.field("mcc_version", pa.string()),

        # Workload dimensions
        pa.field("concurrency", pa.int32()),
        pa.field("input_tokens_mean", pa.int32()),
        pa.field("output_tokens_mean", pa.int32()),
        pa.field("duration_seconds", pa.int32()),

        # Result metrics
        pa.field("ttft_p50_ms", pa.float64()),
        pa.field("ttft_p99_ms", pa.float64()),
        pa.field("itl_p50_ms", pa.float64()),
        pa.field("itl_p99_ms", pa.float64()),
        pa.field("throughput_rps", pa.float64()),
        pa.field("tokens_per_second", pa.float64()),
        pa.field("cost_per_1m_tokens", pa.float64()),
        pa.field("error_rate", pa.float64()),
        pa.field("status", pa.string()),

        # Provenance
        pa.field("run_type", pa.string()),
        pa.field("ci_run_id", pa.string()),
        pa.field("ci_stage", pa.string()),
        pa.field("benchmark_job_name", pa.string()),
        pa.field("account_id", pa.string()),
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

            # Handle run_timestamp: convert ISO string to datetime
            if col_name == 'run_timestamp' and isinstance(val, str):
                try:
                    val = dt.fromisoformat(val.replace('Z', '+00:00'))
                except (ValueError, TypeError):
                    val = None
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


# ── Command: write ────────────────────────────────────────────────────────────


def cmd_write(args):
    """Validate, enrich, and write benchmark results to S3 as Parquet.

    Validation occurs before any S3 interaction. If validation fails,
    a structured error is emitted and no write occurs.
    """
    # Load benchmark results JSON
    results_path = args.results_file or args.input
    if not results_path:
        _error_exit("--results-file (or --input) is required")

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
        # Also pull any config fields from the results file
        for field in ['model_name', 'instance_type', 'deployment_config', 'config_id', 'region']:
            if field in benchmark_data and field not in input_data:
                input_data[field] = benchmark_data[field]
    elif isinstance(benchmark_data, list):
        # If the results file is just a raw metrics array
        input_data['metrics'] = benchmark_data

    # CLI args override config file and results file values
    if args.config_id:
        input_data['config_id'] = args.config_id
    if args.region:
        input_data['region'] = args.region

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
        s3_path = compute_s3_path(bucket, input_data['config_id'], input_data['region'], timestamp)
        partition = compute_partition_info(input_data['region'], timestamp)

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

    region = input_data['region']
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
    s3_info = build_s3_path(args.bucket, region, input_data['config_id'], timestamp)

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
            region=region,
            year=s3_info['partition_year'],
            month=s3_info['partition_month'],
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
            "region": s3_info['partition_region'],
            "year": s3_info['partition_year'],
            "month": s3_info['partition_month'],
        },
        "rows_written": len(enriched_records),
        "config_id": input_data['config_id'],
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
                'config_id': 'config_id',
                'configId': 'config_id',
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
                # Map shell var names to our field names
                shell_map = {
                    'CONFIG_ID': 'config_id',
                    'MODEL_NAME': 'model_name',
                    'INSTANCE_TYPE': 'instance_type',
                    'DEPLOYMENT_CONFIG': 'deployment_config',
                    'DEPLOYMENT_TARGET': 'deployment_target',
                    'AWS_REGION': 'region',
                    'REGION': 'region',
                    'ACCOUNT_ID': 'account_id',
                    'MCC_VERSION': 'mcc_version',
                    'BASE_IMAGE': 'base_image',
                    'BASE_IMAGE_VERSION': 'base_image_version',
                }
                if key in shell_map:
                    context[shell_map[key]] = value

    except Exception:
        pass

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
        '--config-id', dest='config_id',
        help='Configuration ID (SHA-256 hash, 16 chars)'
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
