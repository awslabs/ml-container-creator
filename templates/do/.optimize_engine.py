from __future__ import annotations
# SPDX-License-Identifier: Apache-2.0

"""Athena-backed optimization engine for do/optimize.

Subcommands:
  recommend        — query Athena for proven configs better than current
  compare-baseline — compare local benchmark results vs Athena historical best
  bedrock-interpret — single headless Strands call to explain recommendations

Callers: templates/do/optimize (bash)

All output is JSON on stdout for bash consumption.
Errors are structured JSON objects — never raw tracebacks.
"""

import argparse
import importlib.util
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone


# ── Import derive_model_family from .benchmark_writer.py ──────────────────────

_WRITER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.benchmark_writer.py')
_writer_spec = importlib.util.spec_from_file_location('benchmark_writer', _WRITER_PATH)
_benchmark_writer = importlib.util.module_from_spec(_writer_spec)
_writer_spec.loader.exec_module(_benchmark_writer)

derive_model_family = _benchmark_writer.derive_model_family
derive_instance_family = _benchmark_writer.derive_instance_family


# ── Constants ─────────────────────────────────────────────────────────────────

SWEEPABLE_DIMENSIONS = [
    'quantization',
    'tensor_parallel_degree',
    'max_model_len',
    'kv_cache_dtype',
]

METRIC_DIRECTION = {
    'output_token_throughput_tps': 'higher_is_better',
    'request_throughput_rps': 'higher_is_better',
    'ttft_p90_ms': 'lower_is_better',
    'itl_p90_ms': 'lower_is_better',
    'e2e_latency_p90_ms': 'lower_is_better',
    'cost_per_1m_tokens': 'lower_is_better',
}

# Dimension → config key mapping, keyed by deployment target.
# TODO BL105: when serve-layer plugin manifests land, this dict is derivable from
# serve.d/<engine>/manifest.json (env_var_prefix + dimension → flag mapping).
# Until then, add new targets here when introducing new deployment targets.
_DIMENSION_CONFIG_KEY_BY_TARGET = {
    'realtime-inference': {
        'quantization':           'IC_ENV_VLLM_QUANTIZATION',
        'tensor_parallel_degree': 'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE',
        'max_model_len':          'IC_ENV_VLLM_MAX_MODEL_LEN',
        'kv_cache_dtype':         'IC_ENV_VLLM_KV_CACHE_DTYPE',
    },
    'hyperpod-eks': {
        'quantization':           'VLLM_QUANTIZATION',
        'tensor_parallel_degree': 'VLLM_TENSOR_PARALLEL_SIZE',
        'max_model_len':          'VLLM_MAX_MODEL_LEN',
        'kv_cache_dtype':         'VLLM_KV_CACHE_DTYPE',
    },
    'async-inference': {
        'quantization':           'VLLM_QUANTIZATION',
        'tensor_parallel_degree': 'VLLM_TENSOR_PARALLEL_SIZE',
        'max_model_len':          'VLLM_MAX_MODEL_LEN',
        'kv_cache_dtype':         'VLLM_KV_CACHE_DTYPE',
    },
}

def _dimension_config_key(dimension: str, deployment_target: str | None = None) -> str:
    """Return the do/config key for a benchmark dimension, resolved per deployment target."""
    target = (deployment_target or 'realtime-inference').lower()
    mapping = _DIMENSION_CONFIG_KEY_BY_TARGET.get(
        target, _DIMENSION_CONFIG_KEY_BY_TARGET['realtime-inference']
    )
    return mapping.get(dimension, '')

# Legacy alias — realtime-inference default; prefer _dimension_config_key() for new code
DIMENSION_CONFIG_KEY = _DIMENSION_CONFIG_KEY_BY_TARGET['realtime-inference']

# Metric aliases for --threshold parsing
METRIC_ALIASES = {
    'throughput': 'output_token_throughput_tps',
    'ttft': 'ttft_p90_ms',
    'itl': 'itl_p90_ms',
    'latency': 'e2e_latency_p90_ms',
    'cost': 'cost_per_1m_tokens',
}

# All comparison metrics for --compare-baseline
COMPARISON_METRICS = [
    'output_token_throughput_tps',
    'ttft_p90_ms',
    'itl_p90_ms',
    'e2e_latency_p90_ms',
]

# Reverse alias map for display
metric_aliases_reverse = {v: k for k, v in METRIC_ALIASES.items()}
metric_aliases_reverse.update({m: m for m in COMPARISON_METRICS})  # full name fallback

DEFAULT_THRESHOLD_PCT = 10.0

ATHENA_POLL_INTERVAL = 1.0
ATHENA_TIMEOUT = 30.0


# ── Utility functions ─────────────────────────────────────────────────────────


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


def _error_exit(message):
    """Print JSON error to stdout and exit with code 1."""
    print(json.dumps({"error": message}))
    sys.exit(1)


def _resolve_metric(name: str) -> str:
    """Resolve metric name from alias or full name."""
    return METRIC_ALIASES.get(name, name)


def _is_positive_int(value) -> bool:
    """True when value is a positive integer (accepts int or numeric string)."""
    if value is None:
        return False
    try:
        return int(value) > 0
    except (ValueError, TypeError):
        return False


def _parse_threshold_arg(value: str) -> tuple[str, float]:
    """Parse 'metric:pct' threshold string.

    Examples:
        'throughput:5' → ('output_token_throughput_tps', 5.0)
        'ttft:20' → ('ttft_p90_ms', 20.0)
        'output_token_throughput_tps:5' → ('output_token_throughput_tps', 5.0)
    """
    parts = value.split(':', 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid threshold format: {value!r} (expected metric:pct)")
    metric_name = _resolve_metric(parts[0].strip())
    try:
        pct = float(parts[1].strip())
    except ValueError:
        raise ValueError(f"Invalid threshold percentage: {parts[1]!r}")
    return (metric_name, pct)


# GPU efficiency display columns (BL086) grouped by collection phase, used by
# the compare-baseline display layer to substitute "N/A" for columns that are
# structurally absent for a given deployment target (values stay DOUBLE/NULL in
# Athena — this substitution is display-only).
_NA_GPU_COLUMNS = ('gpu_utilization_avg', 'gpu_utilization_max',
                   'gpu_memory_util_avg', 'gpu_memory_used_avg_gb')
_NA_ENGINE_COLUMNS = ('prefix_cache_hit_rate', 'queue_depth_running_avg')


def _is_na_efficiency_column(column: str, source: str) -> bool:
    """True when `column` is structurally not-applicable for provenance `source`.

    Phase 1 (CloudWatch) GPU columns → N/A for 'engine_metrics_only' or 'none'.
    Phase 2 (engine /metrics) columns → N/A for 'cloudwatch_only' or 'none'.
    Display-only: Athena columns remain DOUBLE/NULL.
    """
    if column in _NA_GPU_COLUMNS:
        return source in ('engine_metrics_only', 'none')
    if column in _NA_ENGINE_COLUMNS:
        return source in ('cloudwatch_only', 'none')
    return False


def _sanitize_partition_value(name: str) -> str:
    """Sanitize a value for Athena partition matching.

    Replaces / with _, lowercases. Matches benchmark_writer partition scheme.
    """
    if not name:
        return ''
    return name.replace('/', '_').lower()


# ── Athena Query Engine ───────────────────────────────────────────────────────


class AthenaQueryEngine:
    """Queries the mlcc_ci.benchmark_results Athena table."""

    def __init__(self, glue_database: str = 'mlcc_ci', glue_table: str = 'benchmark_results',
                 bucket: str = '', region: str = 'us-east-1'):
        self.database = glue_database
        self.table = glue_table
        self.bucket = bucket
        self.region = region
        self._athena_client = None

    @property
    def athena_client(self):
        if self._athena_client is None:
            import boto3
            self._athena_client = boto3.client('athena', region_name=self.region)
        return self._athena_client

    def query_matching_configs(self, model_name: str, instance_type: str,
                               model_family: str | None = None,
                               instance_family: str | None = None,
                               limit: int = 100) -> tuple[list[dict], str]:
        """Query Athena with fallback chain: exact → family → cross-size.

        Returns (records, match_level) where match_level is
        'exact' | 'family' | 'cross-size'.
        """
        model_partition = _sanitize_partition_value(model_name)
        instance_partition = instance_type  # instance partition is already lower

        # Try exact match first
        sql = (
            f"SELECT model_name, instance_type, quantization, tensor_parallel_degree, "
            f"max_model_len, kv_cache_dtype, output_token_throughput_tps, "
            f"request_throughput_rps, ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, "
            f"cost_per_1m_tokens, concurrency, workload, benchmark_job_name, "
            f"run_timestamp, model_family, instance_family, "
            f"kv_cache_util_avg, prefix_cache_hit_rate, queue_depth_waiting_avg, metrics_source "
            f"FROM {self.database}.{self.table} "
            f"WHERE LOWER(model) = '{model_partition}' "
            f"AND instance = '{instance_partition}' "
            f"ORDER BY run_timestamp DESC "
            f"LIMIT {limit}"
        )
        records = self._run_query(sql)
        if records:
            return records, 'exact'

        # Fallback 1: model_family + instance_type
        if model_family:
            sql = (
                f"SELECT model_name, instance_type, quantization, tensor_parallel_degree, "
                f"max_model_len, kv_cache_dtype, output_token_throughput_tps, "
                f"request_throughput_rps, ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, "
                f"cost_per_1m_tokens, concurrency, workload, benchmark_job_name, "
                f"run_timestamp, model_family, instance_family, "
            f"kv_cache_util_avg, prefix_cache_hit_rate, queue_depth_waiting_avg, metrics_source "
                f"FROM {self.database}.{self.table} "
                f"WHERE model_family = '{model_family}' "
                f"AND instance = '{instance_partition}' "
                f"ORDER BY output_token_throughput_tps DESC "
                f"LIMIT {limit}"
            )
            records = self._run_query(sql)
            if records:
                return records, 'family'

        # Fallback 2: model_family + instance_family (cross-size)
        if model_family and instance_family:
            sql = (
                f"SELECT model_name, instance_type, quantization, tensor_parallel_degree, "
                f"max_model_len, kv_cache_dtype, output_token_throughput_tps, "
                f"request_throughput_rps, ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, "
                f"cost_per_1m_tokens, concurrency, workload, benchmark_job_name, "
                f"run_timestamp, model_family, instance_family, "
            f"kv_cache_util_avg, prefix_cache_hit_rate, queue_depth_waiting_avg, metrics_source "
                f"FROM {self.database}.{self.table} "
                f"WHERE model_family = '{model_family}' "
                f"AND instance_family = '{instance_family}' "
                f"ORDER BY output_token_throughput_tps DESC "
                f"LIMIT {limit}"
            )
            records = self._run_query(sql)
            if records:
                return records, 'cross-size'

        return [], 'none'

    def query_all_baselines(self, model_name: str, instance_type: str,
                            quantization: str, tensor_parallel_degree: int,
                            adapter_name: str | None = None,
                            before_timestamp: str | None = None,
                            max_model_len: int | None = None,
                            kv_cache_dtype: str | None = None,
                            pinned_job_name: str | None = None,
                            limit: int = 20) -> list[dict]:
        """Query all historical runs for this config, ordered by run_timestamp DESC.

        BL101: the Serving_Config_Key is extended with max_model_len and
        kv_cache_dtype *conditionally* — a filter is added only when the current
        run specifies the dimension (positive int max_model_len; non-empty,
        non-`auto` kv_cache_dtype). This prevents silently invalidating
        pre-existing baselines and runs that do not specify those dimensions.

        When pinned_job_name is set, the query targets that specific job name
        (overriding the rolling before_timestamp most-recent-prior logic).
        """
        model_partition = _sanitize_partition_value(model_name)
        adapter_clause = f"AND adapter_name = '{adapter_name}' " if adapter_name is not None else ''
        # Exclude current run — run_timestamp is varchar (ISO string), compare lexicographically
        time_clause = f"AND run_timestamp < '{before_timestamp}' " if before_timestamp else ''

        # ── Conditional key extension (BL101 R2.6) ──────────────────────────
        ext_clause = ''
        if _is_positive_int(max_model_len):
            ext_clause += f"AND max_model_len = {int(max_model_len)} "
        if kv_cache_dtype and str(kv_cache_dtype).strip().lower() not in ('', 'auto'):
            ext_clause += f"AND kv_cache_dtype = '{kv_cache_dtype}' "

        # ── Pinned baseline overrides recency ───────────────────────────────
        if pinned_job_name:
            # Target the specific pinned job; ignore the before_timestamp filter.
            pinned_clause = f"AND benchmark_job_name = '{pinned_job_name}' "
            time_clause = ''
        else:
            pinned_clause = ''

        sql = (
            f"SELECT output_token_throughput_tps, request_throughput_rps, "
            f"ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, "
            f"benchmark_job_name, run_timestamp, adapter_name, "
            # BL086 columns are nullable — wrap in TRY() so queries succeed on
            # tables that pre-date the BL086 schema migration (column not yet added).
            f"TRY(gpu_utilization_avg) AS gpu_utilization_avg, "
            f"TRY(kv_cache_util_avg) AS kv_cache_util_avg, "
            f"TRY(prefix_cache_hit_rate) AS prefix_cache_hit_rate, "
            f"TRY(queue_depth_waiting_avg) AS queue_depth_waiting_avg, "
            f"TRY(metrics_source) AS metrics_source "
            f"FROM {self.database}.{self.table} "
            f"WHERE LOWER(model) = '{model_partition}' "
            f"AND instance = '{instance_type}' "
            f"AND quantization = '{quantization}' "
            f"AND tensor_parallel_degree = {tensor_parallel_degree} "
            f"{ext_clause}"
            f"{adapter_clause}"
            f"{pinned_clause}"
            f"{time_clause}"
            f"ORDER BY run_timestamp DESC "
            f"LIMIT {limit}"
        )
        return self._run_query(sql)

    def query_best_baseline(self, model_name: str, instance_type: str,
                            quantization: str, tensor_parallel_degree: int,
                            adapter_name: str | None = None) -> dict | None:
        """Query single best result for exact config. Returns dict or None."""
        records = self.query_all_baselines(
            model_name=model_name,
            instance_type=instance_type,
            quantization=quantization,
            tensor_parallel_degree=tensor_parallel_degree,
            adapter_name=adapter_name,
        )
        return records[0] if records else None

    def query_peak(self, model_name: str, instance_type: str,
                   quantization: str, tensor_parallel_degree: int,
                   metric: str, workload: str | None = None,
                   max_model_len: int | None = None,
                   kv_cache_dtype: str | None = None) -> list[dict]:
        """Query the best historical records for the current Serving_Config_Key,
        sorted by `metric` in the correct direction (BL101 --peak).

        Returns records ordered best-first (index 0 is the peak).
        """
        model_partition = _sanitize_partition_value(model_name)
        workload_clause = f"AND workload = '{workload}' " if workload else ''
        ext_clause = ''
        if _is_positive_int(max_model_len):
            ext_clause += f"AND max_model_len = {int(max_model_len)} "
        if kv_cache_dtype and str(kv_cache_dtype).strip().lower() not in ('', 'auto'):
            ext_clause += f"AND kv_cache_dtype = '{kv_cache_dtype}' "

        direction = METRIC_DIRECTION.get(metric, 'higher_is_better')
        order = 'ASC' if direction == 'lower_is_better' else 'DESC'

        sql = (
            f"SELECT output_token_throughput_tps, request_throughput_rps, "
            f"ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, cost_per_1m_tokens, "
            f"benchmark_job_name, run_timestamp, workload, concurrency, "
            f"adapter_name, deployment_target "
            f"FROM {self.database}.{self.table} "
            f"WHERE LOWER(model) = '{model_partition}' "
            f"AND instance = '{instance_type}' "
            f"AND quantization = '{quantization}' "
            f"AND tensor_parallel_degree = {tensor_parallel_degree} "
            f"{ext_clause}"
            f"{workload_clause}"
            f"AND {metric} IS NOT NULL "
            f"ORDER BY {metric} {order} "
            f"LIMIT 50"
        )
        return self._run_query(sql)

    def query_list(self, model_name: str | None = None,
                   model_family: str | None = None,
                   workload: str | None = None,
                   sort_metric: str = 'output_token_throughput_tps',
                   limit: int = 100) -> list[dict]:
        """Query all runs for a model (exact name or family prefix), across all
        deployment targets, for the BL101 --list surface.
        """
        clauses = []
        if model_name:
            # Family-prefix support: match model_family OR exact model partition.
            model_partition = _sanitize_partition_value(model_name)
            family = _sanitize_partition_value(model_family) if model_family else None
            if family:
                clauses.append(
                    f"(LOWER(model) = '{model_partition}' "
                    f"OR LOWER(model) LIKE '{model_partition}%' "
                    f"OR model_family = '{family}')"
                )
            else:
                clauses.append(
                    f"(LOWER(model) = '{model_partition}' "
                    f"OR LOWER(model) LIKE '{model_partition}%')"
                )
        if workload:
            clauses.append(f"workload = '{workload}'")

        where = ('WHERE ' + ' AND '.join(clauses) + ' ') if clauses else ''
        direction = METRIC_DIRECTION.get(sort_metric, 'higher_is_better')
        order = 'ASC' if direction == 'lower_is_better' else 'DESC'

        sql = (
            f"SELECT model_name, instance_type, quantization, tensor_parallel_degree, "
            f"max_model_len, kv_cache_dtype, deployment_target, "
            f"workload, concurrency, output_token_throughput_tps, "
            f"ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, cost_per_1m_tokens, "
            f"adapter_name, benchmark_job_name, run_timestamp "
            f"FROM {self.database}.{self.table} "
            f"{where}"
            f"ORDER BY {sort_metric} {order} "
            f"LIMIT {limit}"
        )
        return self._run_query(sql)

    def _run_query(self, sql: str) -> list[dict]:
        """Execute query and return parsed results."""
        query_execution_id = self._execute_query(sql)
        if not query_execution_id:
            return []
        return self._parse_results(query_execution_id)

    def _execute_query(self, sql: str) -> str | None:
        """Execute via start_query_execution, poll every 1s, 30s timeout."""
        output_location = f"s3://{self.bucket}/athena-query-results/"

        try:
            response = self.athena_client.start_query_execution(
                QueryString=sql,
                QueryExecutionContext={'Database': self.database},
                ResultConfiguration={'OutputLocation': output_location},
            )
        except Exception as e:
            print(f"⚠️  Athena query failed: {e}", file=sys.stderr)
            return None

        query_execution_id = response['QueryExecutionId']

        # Poll for completion
        start_time = time.time()
        while True:
            elapsed = time.time() - start_time
            if elapsed > ATHENA_TIMEOUT:
                print("⚠️  Athena query timed out after 30s", file=sys.stderr)
                return None

            try:
                status_response = self.athena_client.get_query_execution(
                    QueryExecutionId=query_execution_id
                )
            except Exception as e:
                print(f"⚠️  Athena poll failed: {e}", file=sys.stderr)
                return None

            state = status_response['QueryExecution']['Status']['State']
            if state == 'SUCCEEDED':
                return query_execution_id
            elif state in ('FAILED', 'CANCELLED'):
                reason = status_response['QueryExecution']['Status'].get(
                    'StateChangeReason', 'unknown'
                )
                print(f"⚠️  Athena query {state}: {reason}", file=sys.stderr)
                return None

            time.sleep(ATHENA_POLL_INTERVAL)

    def _parse_results(self, query_execution_id: str) -> list[dict]:
        """get_query_results with NextToken pagination, skip header row."""
        records = []
        next_token = None
        header = None

        while True:
            kwargs = {'QueryExecutionId': query_execution_id, 'MaxResults': 1000}
            if next_token:
                kwargs['NextToken'] = next_token

            try:
                response = self.athena_client.get_query_results(**kwargs)
            except Exception as e:
                print(f"⚠️  Athena results fetch failed: {e}", file=sys.stderr)
                break

            rows = response['ResultSet']['Rows']

            if header is None:
                # First page: first row is the header
                if not rows:
                    break
                header = [col.get('VarCharValue', '') for col in rows[0]['Data']]
                rows = rows[1:]

            for row in rows:
                values = [col.get('VarCharValue', '') for col in row['Data']]
                record = dict(zip(header, values))
                # Convert numeric fields
                record = self._coerce_types(record)
                records.append(record)

            next_token = response.get('NextToken')
            if not next_token:
                break

        return records

    @staticmethod
    def _coerce_types(record: dict) -> dict:
        """Coerce known numeric fields from strings."""
        numeric_fields = [
            'output_token_throughput_tps', 'request_throughput_rps',
            'ttft_p90_ms', 'itl_p90_ms', 'e2e_latency_p90_ms',
            'cost_per_1m_tokens', 'concurrency', 'tensor_parallel_degree',
            'max_model_len',
            # GPU efficiency signals (BL086)
            'gpu_utilization_avg', 'gpu_utilization_max',
            'gpu_memory_used_avg_gb', 'gpu_memory_util_avg',
            'kv_cache_util_avg', 'kv_cache_util_max', 'prefix_cache_hit_rate',
            'queue_depth_running_avg', 'queue_depth_waiting_avg', 'queue_depth_waiting_max',
        ]
        for field in numeric_fields:
            if field in record and record[field]:
                try:
                    val = float(record[field])
                    # Use int for fields that should be integers
                    if field in ('concurrency', 'tensor_parallel_degree', 'max_model_len'):
                        record[field] = int(val)
                    else:
                        record[field] = val
                except (ValueError, TypeError):
                    pass
        return record


# ── Recommendation Engine ─────────────────────────────────────────────────────


class RecommendationEngine:
    """Computes serving config recommendations from benchmark data."""

    def __init__(self, current_config: dict, benchmark_records: list, target_metric: str,
                 deployment_target: str | None = None):
        self.current = current_config
        self.records = benchmark_records
        self.metric = target_metric
        self.deployment_target = deployment_target or 'realtime-inference'

    def compute_recommendations(self) -> list[dict]:
        """Compute ranked recommendations.

        For each sweepable dimension:
          1. Group records by that dimension's value
          2. Compute mean target_metric per group
          3. If best group != current value and is actionable: create recommendation
          4. Sort by abs(improvement_pct) descending

        Returns list of recommendation dicts.
        """
        if not self.records:
            return []

        direction = METRIC_DIRECTION.get(self.metric, 'higher_is_better')
        recommendations = []

        for dimension in SWEEPABLE_DIMENSIONS:
            current_value = self.current.get(dimension)
            if current_value is None:
                continue

            # Group records by this dimension's value
            groups: dict[str, list[float]] = {}
            for record in self.records:
                dim_val = record.get(dimension)
                metric_val = record.get(self.metric)
                # Skip records where the dimension value is empty/null — not a meaningful group
                if dim_val is None or dim_val == '' or metric_val is None:
                    continue
                # Only include records where the recommended value would be actionable
                dim_key = str(dim_val)
                if not dim_key.strip():
                    continue
                if dim_key not in groups:
                    groups[dim_key] = []
                groups[dim_key].append(float(metric_val))

            if not groups:
                continue

            # Compute mean metric per group
            group_means: dict[str, float] = {}
            for dim_key, values in groups.items():
                group_means[dim_key] = sum(values) / len(values)

            # Find best group
            if direction == 'higher_is_better':
                best_key = max(group_means, key=group_means.get)
            else:
                best_key = min(group_means, key=group_means.get)

            # Compare to current
            current_key = str(current_value)
            current_mean = group_means.get(current_key)

            if best_key == current_key:
                continue  # Already optimal for this dimension

            best_mean = group_means[best_key]

            # Calculate improvement
            if current_mean and current_mean != 0:
                if direction == 'higher_is_better':
                    improvement_pct = ((best_mean - current_mean) / current_mean) * 100
                else:
                    improvement_pct = ((current_mean - best_mean) / current_mean) * 100
            else:
                # No current baseline — can't compute relative improvement
                improvement_pct = 0.0

            # Only recommend if improvement is positive
            if improvement_pct <= 0:
                continue

            # Compute confidence from records for the best value
            best_records = groups[best_key]
            is_family_match = any(
                r.get('model_name') != self.current.get('model_name')
                for r in self.records
                if str(r.get(dimension)) == best_key
            )
            confidence, confidence_score = self._compute_confidence(best_records, is_family_match)

            # Find source job (most recent record with this dimension value)
            source_job = ''
            for record in self.records:
                if str(record.get(dimension)) == best_key:
                    source_job = record.get('benchmark_job_name', '')
                    break

            recommendations.append({
                'dimension': dimension,
                'config_key': _dimension_config_key(dimension, self.deployment_target),
                'current_value': current_value,
                'recommended_value': self._coerce_dimension_value(dimension, best_key),
                'improvement_pct': round(improvement_pct, 1),
                'confidence': confidence,
                'confidence_score': round(confidence_score, 2),
                'source_job': source_job,
                'num_runs': len(best_records),
                'baseline_metric_value': round(current_mean, 1) if current_mean else None,
                'recommended_metric_value': round(best_mean, 1),
                'metric': self.metric,
            })

        # Sort by improvement descending
        recommendations.sort(key=lambda r: r['improvement_pct'], reverse=True)
        return recommendations

    def compute_efficiency_recommendations(self) -> list[dict]:
        """Compute GPU-efficiency recommendations from the new signals (BL086).

        Efficiency rules fire only for records with valid provenance
        (metrics_source != 'none'), so rows lacking real signals never drive a
        recommendation (Property 4). Rules (design.md § Component 6):
          * kv_cache_util_avg > 0.95      → reduce IC_COPY_COUNT or increase VRAM
          * prefix_cache_hit_rate < 0.10  → review prompt templating
          * queue_depth_waiting_avg > 5   → scale IC_COPY_COUNT

        Returns a list of efficiency recommendation dicts.
        """
        recs: list[dict] = []
        if not self.records:
            return recs

        def _num(rec, key):
            val = rec.get(key)
            try:
                return float(val) if val not in (None, '') else None
            except (ValueError, TypeError):
                return None

        # Consider only records with real signal provenance.
        sourced = [
            r for r in self.records
            if str(r.get('metrics_source', 'none')).strip() not in ('', 'none')
        ]
        if not sourced:
            return recs

        def _avg(key):
            vals = [_num(r, key) for r in sourced]
            vals = [v for v in vals if v is not None]
            return (sum(vals) / len(vals)) if vals else None

        kv = _avg('kv_cache_util_avg')
        if kv is not None and kv > 0.95:
            recs.append({
                'type': 'efficiency',
                'signal': 'kv_cache_util_avg',
                'observed': round(kv, 3),
                'threshold': 0.95,
                'recommendation': 'Reduce IC_COPY_COUNT or increase VRAM — KV cache is nearly saturated.',
            })

        hit_rate = _avg('prefix_cache_hit_rate')
        if hit_rate is not None and hit_rate < 0.10:
            recs.append({
                'type': 'efficiency',
                'signal': 'prefix_cache_hit_rate',
                'observed': round(hit_rate, 3),
                'threshold': 0.10,
                'recommendation': 'Low prefix cache hit rate — review prompt templating for shared prefixes.',
            })

        waiting = _avg('queue_depth_waiting_avg')
        if waiting is not None and waiting > 5:
            recs.append({
                'type': 'efficiency',
                'signal': 'queue_depth_waiting_avg',
                'observed': round(waiting, 2),
                'threshold': 5,
                'recommendation': 'Requests are queueing — scale IC_COPY_COUNT to add capacity.',
            })

        return recs

    def compute_no_change_dimensions(self) -> list[str]:
        """Return dimensions where current value is already optimal."""
        if not self.records:
            return list(SWEEPABLE_DIMENSIONS)

        direction = METRIC_DIRECTION.get(self.metric, 'higher_is_better')
        no_change = []

        for dimension in SWEEPABLE_DIMENSIONS:
            current_value = self.current.get(dimension)
            if current_value is None:
                no_change.append(dimension)
                continue

            groups: dict[str, list[float]] = {}
            for record in self.records:
                dim_val = record.get(dimension)
                metric_val = record.get(self.metric)
                if dim_val is None or metric_val is None:
                    continue
                dim_key = str(dim_val)
                if dim_key not in groups:
                    groups[dim_key] = []
                groups[dim_key].append(float(metric_val))

            if not groups:
                no_change.append(dimension)
                continue

            group_means = {k: sum(v) / len(v) for k, v in groups.items()}
            if direction == 'higher_is_better':
                best_key = max(group_means, key=group_means.get)
            else:
                best_key = min(group_means, key=group_means.get)

            if best_key == str(current_value):
                no_change.append(dimension)

        return no_change

    @staticmethod
    def _compute_confidence(records_for_value: list[float],
                            is_family_match: bool) -> tuple[str, float]:
        """Compute confidence level.

        high:   >=5 runs with CV < 0.15
        medium: 2-4 runs, or >=5 with CV >= 0.15
        low:    1 run or family match
        """
        num_runs = len(records_for_value)

        if num_runs == 0:
            return 'low', 0.0

        if num_runs == 1 or is_family_match:
            score = 0.3 if is_family_match else 0.4
            return 'low', score

        cv = RecommendationEngine._cv(records_for_value)

        if num_runs >= 5 and cv < 0.15:
            score = min(1.0, (num_runs / 10.0) * (1.0 - cv))
            return 'high', score
        elif num_runs >= 2:
            score = min(0.7, (num_runs / 8.0) * (1.0 - cv))
            return 'medium', score

        return 'low', 0.3

    @staticmethod
    def _cv(values: list[float]) -> float:
        """Coefficient of variation = std/mean. Returns 0.0 if mean==0."""
        if not values:
            return 0.0
        mean = sum(values) / len(values)
        if mean == 0:
            return 0.0
        variance = sum((x - mean) ** 2 for x in values) / len(values)
        std = math.sqrt(variance)
        return std / abs(mean)

    @staticmethod
    def _coerce_dimension_value(dimension: str, value: str):
        """Coerce dimension value to appropriate type for output."""
        if dimension in ('tensor_parallel_degree', 'max_model_len'):
            try:
                return int(float(value))
            except (ValueError, TypeError):
                return value
        return value


# ── Bedrock Interpretation ────────────────────────────────────────────────────


def bedrock_interpret(recommendations: list[dict], context: dict, region: str) -> str | None:
    """Single headless Strands call to explain recommendations.

    Returns a 2-4 sentence plain-language analysis, or None on failure.
    """
    if not recommendations:
        return None

    # Check for opt-out
    if os.environ.get('MCC_NO_BEDROCK', '') == '1':
        return None

    try:
        import boto3
        bedrock_client = boto3.client('bedrock-runtime', region_name=region)

        # Load model_id from config/agent.json
        agent_config_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', '..', 'config', 'agent.json'
        )
        model_id = 'anthropic.claude-sonnet-4-5-20250929-v1:0'
        if os.path.exists(agent_config_path):
            try:
                with open(agent_config_path) as f:
                    agent_cfg = json.load(f)
                model_id = agent_cfg.get('modelId', model_id)
            except Exception:
                pass

        system_prompt = (
            "You are an ML infrastructure advisor. Given these optimization recommendations "
            "and project context, write a 2-4 sentence plain-language analysis. Mention "
            "specific risks from the capability matrix if relevant. Be specific about "
            "values and expected gains."
        )

        user_content = json.dumps({
            'recommendations': recommendations,
            'current_config': context,
        }, indent=2)

        response = bedrock_client.converse(
            modelId=model_id,
            messages=[{'role': 'user', 'content': [{'text': user_content}]}],
            system=[{'text': system_prompt}],
            inferenceConfig={'maxTokens': 300, 'temperature': 0.3},
        )

        output_message = response.get('output', {}).get('message', {})
        content_blocks = output_message.get('content', [])
        if content_blocks:
            return content_blocks[0].get('text', '')

        return None

    except Exception as e:
        print(f"⚠️  Bedrock interpretation failed: {e}", file=sys.stderr)
        return None


# ── Subcommand: recommend ─────────────────────────────────────────────────────


def cmd_recommend(args):
    """Query Athena for proven configs better than current."""
    model_name = args.model_name
    instance_type = args.instance_type

    if not model_name or not instance_type:
        _error_exit("--model-name and --instance-type are required")

    model_family = derive_model_family(model_name)
    instance_family = derive_instance_family(instance_type)

    # Build current config
    current_config = {
        'model_name': model_name,
        'model_family': model_family,
        'instance_type': instance_type,
        'instance_family': instance_family,
        'quantization': args.quantization,
        'tensor_parallel_degree': args.tensor_parallel,
        'max_model_len': args.max_model_len,
        'kv_cache_dtype': args.kv_cache_dtype,
    }

    # Query Athena
    engine = AthenaQueryEngine(
        glue_database=args.glue_database,
        glue_table=args.glue_table,
        bucket=args.bucket,
        region=args.region,
    )

    try:
        records, match_level = engine.query_matching_configs(
            model_name=model_name,
            instance_type=instance_type,
            model_family=model_family,
            instance_family=instance_family,
        )
    except Exception as e:
        _error_exit(f"Athena query failed: {e}")
        return  # unreachable but prevents fall-through

    # Compute recommendations
    rec_engine = RecommendationEngine(
        current_config=current_config,
        benchmark_records=records,
        target_metric=args.metric,
        deployment_target=os.environ.get('DEPLOYMENT_TARGET', 'realtime-inference'),
    )

    recommendations = rec_engine.compute_recommendations()
    no_change = rec_engine.compute_no_change_dimensions()
    efficiency_recommendations = rec_engine.compute_efficiency_recommendations()

    result = {
        'status': 'ok',
        'model_name': model_name,
        'instance_type': instance_type,
        'match_level': match_level,
        'target_metric': args.metric,
        'total_records_found': len(records),
        'current_config': current_config,
        'recommendations': recommendations,
        'efficiency_recommendations': efficiency_recommendations,
        'no_change_dimensions': no_change,
    }

    # Optionally add Bedrock interpretation
    if args.bedrock_interpret and (recommendations or efficiency_recommendations):
        analysis = bedrock_interpret(recommendations + efficiency_recommendations, current_config, args.region)
        if analysis:
            result['analysis'] = analysis

    _output(result)


# ── Subcommand: compare-baseline ──────────────────────────────────────────────


def cmd_compare_baseline(args):
    """Compare local benchmark results vs Athena historical best."""
    model_name = args.model_name
    instance_type = args.instance_type

    if not model_name or not instance_type:
        _error_exit("--model-name and --instance-type are required")

    # Parse thresholds
    thresholds: dict[str, float] = {}
    if args.threshold:
        for t in args.threshold:
            metric_name, pct = _parse_threshold_arg(t)
            thresholds[metric_name] = pct

    # Apply defaults for any missing metrics
    if not thresholds:
        for m in COMPARISON_METRICS:
            thresholds[m] = DEFAULT_THRESHOLD_PCT

    # Read local results
    if not args.results_file or not os.path.exists(args.results_file):
        _error_exit(f"Results file not found: {args.results_file}")
        return

    local_metrics = _parse_local_results(args.results_file)
    if not local_metrics:
        _error_exit("Could not parse metrics from results file")
        return

    # Extract timestamp of current run to exclude it from baseline query (avoid self-comparison)
    _current_run_timestamp = None
    try:
        _aiperf_path = os.path.join(os.path.dirname(args.results_file), 'profile_export_aiperf.json')
        if os.path.exists(_aiperf_path):
            with open(_aiperf_path) as _f:
                _aiperf = json.load(_f)
            _ts = _aiperf.get('end_time') or _aiperf.get('start_time')
            if _ts:
                # Normalize to Athena TIMESTAMP format: "2026-07-15 14:00:04"
                _current_run_timestamp = str(_ts)[:19].replace('T', ' ')
    except Exception:
        pass  # Non-fatal — include all records if timestamp unavailable

    # Query Athena for historical best
    engine = AthenaQueryEngine(
        glue_database=args.glue_database,
        glue_table=args.glue_table,
        bucket=args.bucket,
        region=args.region,
    )

    # Query all historical runs
    _pinned = getattr(args, 'pinned_baseline', None) or None
    all_records = engine.query_all_baselines(
        model_name=model_name,
        instance_type=instance_type,
        quantization=args.quantization,
        tensor_parallel_degree=args.tensor_parallel,
        adapter_name=getattr(args, 'adapter_name', None),
        before_timestamp=None if _pinned else _current_run_timestamp,
        max_model_len=getattr(args, 'max_model_len', None),
        kv_cache_dtype=getattr(args, 'kv_cache_dtype', None),
        pinned_job_name=_pinned,
    )

    if not all_records:
        result = {'status': 'no_baseline', 'has_baseline': False,
                  'pinned_baseline': _pinned,
                  'thresholds_applied': thresholds, 'comparisons': []}
        _output(result)
        return

    # Most recent run is the primary comparison (Option B)
    most_recent = all_records[0]
    run_count = len(all_records)
    has_regression = False
    comparisons = []

    for metric in COMPARISON_METRICS:
        current_val = local_metrics.get(metric)
        recent_val = most_recent.get(metric)

        if current_val is None or recent_val is None:
            continue

        current_val = float(current_val)
        recent_val = float(recent_val)

        # All historical values for range computation (Option D)
        hist_vals = [float(r[metric]) for r in all_records if r.get(metric) is not None]
        hist_avg = sum(hist_vals) / len(hist_vals) if hist_vals else None
        hist_min = min(hist_vals) if hist_vals else None
        hist_max = max(hist_vals) if hist_vals else None

        direction = METRIC_DIRECTION.get(metric, 'higher_is_better')
        threshold_pct = thresholds.get(metric, DEFAULT_THRESHOLD_PCT)

        delta_pct = ((current_val - recent_val) / abs(recent_val)) * 100 if recent_val != 0 else 0.0

        if direction == 'higher_is_better':
            is_regression = delta_pct < -threshold_pct
        else:
            is_regression = delta_pct > threshold_pct

        if is_regression:
            has_regression = True

        comparisons.append({
            'metric': metric,
            'current': round(current_val, 1),
            'most_recent_baseline': round(recent_val, 1),
            'delta_pct': round(delta_pct, 1),
            'direction': direction,
            'threshold_pct': threshold_pct,
            'status': 'regression' if is_regression else 'pass',
            'historical': {
                'avg': round(hist_avg, 1) if hist_avg is not None else None,
                'min': round(hist_min, 1) if hist_min is not None else None,
                'max': round(hist_max, 1) if hist_max is not None else None,
                'runs': [round(float(r[metric]), 1) for r in all_records if r.get(metric) is not None],
            }
        })

    # ── GPU efficiency signals (BL086) ─────────────────────────────────────
    # Surface the new efficiency columns when populated; skip rows whose
    # provenance is 'none' (no real signals).
    _EFF_COLS = ('gpu_utilization_avg', 'kv_cache_util_avg',
                 'prefix_cache_hit_rate', 'queue_depth_waiting_avg')
    efficiency_rows = []
    for r in all_records:
        source = str(r.get('metrics_source', 'none') or 'none').strip()
        if source in ('', 'none'):
            continue
        row = {'metrics_source': source, 'run_timestamp': r.get('run_timestamp', '')}
        for col in _EFF_COLS:
            val = r.get(col)
            try:
                row[col] = float(val) if val not in (None, '') else None
            except (ValueError, TypeError):
                row[col] = None
        efficiency_rows.append(row)

    result = {
        'status': 'regression' if has_regression else 'pass',
        'has_baseline': True,
        'pinned_baseline': _pinned,
        'most_recent_job': most_recent.get('benchmark_job_name', ''),
        'most_recent_timestamp': most_recent.get('run_timestamp', ''),
        'run_count': run_count,
        'thresholds_applied': thresholds,
        'comparisons': comparisons,
        'efficiency': efficiency_rows,
    }

    if not args.json_output:
        # Header table: current vs most_recent with historical range
        _pin_label = ' [pinned]' if _pinned else ''
        note = f' (1 run — no prior comparison)' if run_count == 1 else f' ({run_count} historical runs)'
        print(f'\n📊 Performance Comparison vs. Historical Best{_pin_label}{note}\n')
        if _pinned:
            print(f'   Pinned baseline: {_pinned}\n')

        # Primary comparison table
        header = f'  {"METRIC":<30} {"CURRENT":>10} {"MOST RECENT":>12} {"DELTA":>8}  {"AVG":>10} {"MIN":>10} {"MAX":>10}  {"STATUS"}'
        sep = '  ' + '─' * (len(header) - 2)
        print(sep)
        print(header)
        print(sep)

        for comp in result['comparisons']:
            metric_short = metric_aliases_reverse.get(comp['metric'], comp['metric'])
            current = str(comp['current'])
            baseline = str(comp['most_recent_baseline'])
            d = comp['delta_pct']
            delta = f"{'+' if d > 0 else ('' if d == 0 else '')}{d}%" if d != 0 else '0.0%'
            hist = comp.get('historical', {})
            avg_str = str(hist.get('avg', '—')) if hist.get('avg') is not None else '—'
            min_str = str(hist.get('min', '—')) if hist.get('min') is not None else '—'
            max_str = str(hist.get('max', '—')) if hist.get('max') is not None else '—'
            status_icon = '⚠️ REGR' if comp['status'] == 'regression' else '✅ pass'
            print(f'  {metric_short:<30} {current:>10} {baseline:>12} {delta:>8}  {avg_str:>10} {min_str:>10} {max_str:>10}  {status_icon}')

        print(sep)

        # All historical runs table (Option C)
        print(f'\n  Historical runs:')
        run_header = f'  {"DATE":<22} {"ADAPTER":<22} {"THROUGHPUT":>12} {"TTFT P90":>10} {"ITL P90":>10} {"E2E P90":>10}'
        run_sep = '  ' + '─' * 80
        print(run_sep)
        print(run_header)
        print(run_sep)
        for r in all_records:
            ts = str(r.get('run_timestamp', ''))[:19].replace('T', ' ')
            adapter_label = str(r.get('adapter_name', '') or 'base')[:22]
            tput = str(round(float(r.get('output_token_throughput_tps', 0) or 0), 1))
            ttft = str(round(float(r.get('ttft_p90_ms', 0) or 0), 1))
            itl = str(round(float(r.get('itl_p90_ms', 0) or 0), 1))
            e2e = str(round(float(r.get('e2e_latency_p90_ms', 0) or 0), 1))
            print(f'  {ts:<22} {adapter_label:<22} {tput:>12} {ttft:>10} {itl:>10} {e2e:>10}')
        print(run_sep)

        # GPU efficiency signals table (BL086) — only rows with real provenance.
        if result['efficiency']:
            print(f'\n  GPU efficiency signals:')
            eff_header = f'  {"DATE":<22} {"SOURCE":<16} {"GPU_UTIL":>10} {"KV_CACHE":>10} {"PREFIX_HIT":>11} {"Q_WAIT":>8}'
            eff_sep = '  ' + '─' * 80
            print(eff_sep)
            print(eff_header)
            print(eff_sep)
            for r in result['efficiency']:
                ts = str(r.get('run_timestamp', ''))[:19].replace('T', ' ')
                src = str(r.get('metrics_source', ''))[:16]
                row_source = str(r.get('metrics_source', 'none') or 'none').strip().lower()

                def _f(v, column=None):
                    # Structurally not-applicable for this row's target → "N/A".
                    if column is not None and _is_na_efficiency_column(column, row_source):
                        return 'N/A'
                    return '—' if v is None else str(round(v, 3))
                print(f'  {ts:<22} {src:<16} '
                      f'{_f(r.get("gpu_utilization_avg"), "gpu_utilization_avg"):>10} '
                      f'{_f(r.get("kv_cache_util_avg"), "kv_cache_util_avg"):>10} '
                      f'{_f(r.get("prefix_cache_hit_rate"), "prefix_cache_hit_rate"):>11} '
                      f'{_f(r.get("queue_depth_waiting_avg"), "queue_depth_waiting_avg"):>8}')
            print(eff_sep)

        # Summary
        regression_count = sum(1 for c in result['comparisons'] if c['status'] == 'regression')
        if regression_count > 0:
            print(f'\n   ⚠️  {regression_count} regression(s) detected vs most recent run')
        else:
            print(f'\n   ✅ All metrics within threshold vs most recent run')
        print()
        sys.exit(1 if has_regression else 0)
    else:
        _output(result)


def _parse_local_results(results_file: str) -> dict:
    """Parse metrics from a profile_export.jsonl file.

    Returns dict with metric names as keys and values.
    """
    # AIPerf metric name mapping: AIPerf field → (our metric name, sub-key)
    # profile_export_aiperf.json uses different names and nested dicts.
    AIPERF_METRIC_MAP = {
        'output_token_throughput': ('output_token_throughput_tps', 'avg'),
        'request_throughput':      ('request_throughput_rps', 'avg'),
        'time_to_first_token':     ('ttft_p90_ms', 'p90'),
        'time_to_first_output_token': ('ttft_p90_ms', 'p90'),  # alternate name
        'inter_token_latency':     ('itl_p90_ms', 'p90'),
        'request_latency':         ('e2e_latency_p90_ms', 'p90'),
    }

    def _extract_aiperf(data: dict) -> dict:
        """Extract our standard metrics from a profile_export_aiperf.json dict."""
        out = {}
        for aiperf_key, (our_key, sub_key) in AIPERF_METRIC_MAP.items():
            if aiperf_key in data and isinstance(data[aiperf_key], dict):
                val = data[aiperf_key].get(sub_key)
                if val is not None:
                    out[our_key] = float(val)
        return out

    metrics = {}
    try:
        with open(results_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # AIPerf profile_export.jsonl records have shape {metadata, metrics}
                # or flat top-level keys depending on AIPerf version.
                # Try nested {metrics: {key: {avg, p90...}}} first.
                record_metrics = record.get('metrics', record)

                # Try AIPerf nested dict format
                extracted = _extract_aiperf(record_metrics)
                if extracted:
                    metrics.update(extracted)
                # Also try flat keys (older format)
                elif 'output_token_throughput_tps' in record_metrics:
                    for m in COMPARISON_METRICS:
                        if m in record_metrics and record_metrics[m] is not None:
                            metrics[m] = float(record_metrics[m])

        # Fallback: try profile_export_aiperf.json in same directory
        if not metrics:
            import os
            aiperf_path = os.path.join(
                os.path.dirname(results_file), 'profile_export_aiperf.json'
            )
            if os.path.exists(aiperf_path):
                with open(aiperf_path) as f:
                    aiperf = json.load(f)
                metrics = _extract_aiperf(aiperf)

    except Exception:
        return {}

    return metrics


# ── Subcommand: bedrock-interpret (direct invocation) ─────────────────────────


def _resolve_peak_metric(name: str) -> str:
    """Resolve a --peak/--metric alias to a full metric name.

    Accepts the documented aliases (throughput/ttft/itl/latency/cost) and full
    metric names. Rejects anything else with a clear error (never silently
    falls back to the default) per Req 4.4.
    """
    if not name:
        return 'output_token_throughput_tps'
    resolved = METRIC_ALIASES.get(name, name)
    if resolved not in METRIC_DIRECTION:
        valid = ', '.join(sorted(METRIC_ALIASES.keys()))
        _error_exit(
            f"Unrecognized metric: {name!r}. Valid aliases: {valid} "
            f"(or a full metric name)."
        )
    return resolved


def cmd_peak(args):
    """Show the best historical record for the current Serving_Config_Key
    on a workload, and compare the most-recent run to that peak (BL101)."""
    metric = _resolve_peak_metric(getattr(args, 'metric', None))

    engine = AthenaQueryEngine(
        glue_database=args.glue_database,
        glue_table=args.glue_table,
        bucket=args.bucket,
        region=args.region,
    )

    records = engine.query_peak(
        model_name=args.model_name,
        instance_type=args.instance_type,
        quantization=args.quantization,
        tensor_parallel_degree=args.tensor_parallel,
        metric=metric,
        workload=getattr(args, 'workload', None) or None,
        max_model_len=getattr(args, 'max_model_len', None),
        kv_cache_dtype=getattr(args, 'kv_cache_dtype', None),
    )

    if not records:
        result = {'status': 'no_results', 'metric': metric, 'peak': None}
        if getattr(args, 'json_output', False):
            _output(result)
        print(f"\nℹ️  No historical records found for this configuration"
              f"{(' on workload ' + args.workload) if getattr(args, 'workload', None) else ''}.")
        sys.exit(0)

    peak = records[0]
    # Most recent run = record with the max run_timestamp among the set.
    most_recent = max(records, key=lambda r: str(r.get('run_timestamp', '')))

    def _fnum(v):
        try:
            return float(v) if v not in (None, '') else None
        except (ValueError, TypeError):
            return None

    peak_val = _fnum(peak.get(metric))
    recent_val = _fnum(most_recent.get(metric))
    delta_pct = None
    if peak_val is not None and recent_val is not None and peak_val != 0:
        delta_pct = round(((recent_val - peak_val) / abs(peak_val)) * 100, 1)

    result = {
        'status': 'ok',
        'metric': metric,
        'peak': {
            'value': round(peak_val, 2) if peak_val is not None else None,
            'run_timestamp': peak.get('run_timestamp', ''),
            'benchmark_job_name': peak.get('benchmark_job_name', ''),
            'workload': peak.get('workload', ''),
            'deployment_target': peak.get('deployment_target', ''),
        },
        'most_recent': {
            'value': round(recent_val, 2) if recent_val is not None else None,
            'run_timestamp': most_recent.get('run_timestamp', ''),
            'benchmark_job_name': most_recent.get('benchmark_job_name', ''),
        },
        'delta_from_peak_pct': delta_pct,
    }

    if getattr(args, 'json_output', False):
        _output(result)

    label = metric_aliases_reverse.get(metric, metric)
    print(f'\n🏔️  Peak {label} for this configuration\n')
    print(f'   Best value:   {result["peak"]["value"]}')
    print(f'   When:         {str(peak.get("run_timestamp", ""))[:19].replace("T", " ")}')
    print(f'   Job:          {peak.get("benchmark_job_name", "")}')
    if peak.get('workload'):
        print(f'   Workload:     {peak.get("workload")}')
    if peak.get('deployment_target'):
        print(f'   Target:       {peak.get("deployment_target")}')
    if delta_pct is not None:
        arrow = '↑' if delta_pct > 0 else ('↓' if delta_pct < 0 else '=')
        print(f'\n   Most recent:  {result["most_recent"]["value"]} '
              f'({arrow} {abs(delta_pct)}% vs peak)')
    print()
    sys.exit(0)


def cmd_list(args):
    """List all benchmark runs for a model across configs / workloads / targets,
    grouped by Serving_Config_Key (BL101 --list)."""
    sort_metric = _resolve_peak_metric(getattr(args, 'sort', None) or 'output_token_throughput_tps')

    engine = AthenaQueryEngine(
        glue_database=args.glue_database,
        glue_table=args.glue_table,
        bucket=args.bucket,
        region=args.region,
    )

    records = engine.query_list(
        model_name=getattr(args, 'model', None) or None,
        model_family=getattr(args, 'model_family', None) or None,
        workload=getattr(args, 'workload', None) or None,
        sort_metric=sort_metric,
        limit=getattr(args, 'limit', 100) or 100,
    )

    if not records:
        if getattr(args, 'json_output', False):
            _output({'status': 'no_results', 'groups': []})
        print('\nℹ️  No benchmark records found matching the given filters.')
        sys.exit(0)

    # Apply client-side filters (--min-tp, --quantization, --max-model-len, --kv-cache-dtype, --exclude-instance)
    min_tp = getattr(args, 'min_tp', None)
    filter_quant = getattr(args, 'filter_quantization', None)
    filter_max_len = getattr(args, 'filter_max_model_len', None)
    filter_kv = getattr(args, 'filter_kv_cache_dtype', None)
    _excl_raw = getattr(args, 'exclude_instances', '') or ''
    exclude_instances = {x.strip() for x in _excl_raw.split(',') if x.strip()}
    _incl_raw = getattr(args, 'include_instances', '') or ''
    include_instances = {x.strip() for x in _incl_raw.split(',') if x.strip()}

    def _passes_filters(r):
        if min_tp is not None and (r.get('tensor_parallel_degree') or 1) < min_tp:
            return False
        if filter_quant is not None and str(r.get('quantization', 'none')) != filter_quant:
            return False
        if filter_max_len is not None:
            rl = r.get('max_model_len')
            if rl is None or int(rl) != filter_max_len:
                return False
        if filter_kv is not None and str(r.get('kv_cache_dtype', 'auto')) != filter_kv:
            return False
        if r.get('instance_type') in exclude_instances:
            return False
        if include_instances and r.get('instance_type') not in include_instances:
            return False
        return True

    records = [r for r in records if _passes_filters(r)]

    if not records:
        if getattr(args, 'json_output', False):
            _output({'status': 'no_results', 'groups': []})
        print('\nℹ️  No benchmark records match the given filters.')
        sys.exit(0)

    # Group by Serving_Config_Key
    def _key(r):
        return (
            r.get('model_name', ''), r.get('instance_type', ''),
            str(r.get('quantization', 'none')), str(r.get('tensor_parallel_degree', '')),
            str(r.get('max_model_len', '')), str(r.get('kv_cache_dtype', 'auto')),
            r.get('deployment_target', ''),
        )

    groups: dict = {}
    for r in records:
        groups.setdefault(_key(r), []).append(r)

    if getattr(args, 'json_output', False):
        out_groups = []
        for k, rows in groups.items():
            out_groups.append({
                'config': {
                    'model_name': k[0], 'instance_type': k[1], 'quantization': k[2],
                    'tensor_parallel_degree': k[3], 'max_model_len': k[4],
                    'kv_cache_dtype': k[5], 'deployment_target': k[6],
                },
                'runs': rows,
            })
        _output({'status': 'ok', 'sort_metric': sort_metric, 'groups': out_groups})

    print(f'\n📋 Benchmark runs (sorted by {metric_aliases_reverse.get(sort_metric, sort_metric)})\n')
    for k, rows in groups.items():
        print(f'  ▸ {k[0]}  |  {k[1]}  |  quant={k[2]}  tp={k[3]}  '
              f'max_len={k[4] or "—"}  kv={k[5]}  target={k[6]}')
        rh = (f'    {"WORKLOAD":<20} {"CONC":>5} {"TPUT":>9} {"TTFT_P90":>9} '
              f'{"ITL_P90":>9} {"E2E_P90":>9} {"ADAPTER":<16} {"TIMESTAMP":<20}')
        print(rh)
        for r in rows:
            def _r(v):
                try:
                    return str(round(float(v), 1)) if v not in (None, '') else '—'
                except (ValueError, TypeError):
                    return '—'
            print(f'    {str(r.get("workload", ""))[:20]:<20} '
                  f'{str(r.get("concurrency", "")):>5} '
                  f'{_r(r.get("output_token_throughput_tps")):>9} '
                  f'{_r(r.get("ttft_p90_ms")):>9} '
                  f'{_r(r.get("itl_p90_ms")):>9} '
                  f'{_r(r.get("e2e_latency_p90_ms")):>9} '
                  f'{str(r.get("adapter_name", "") or "base")[:16]:<16} '
                  f'{str(r.get("run_timestamp", ""))[:19].replace("T", " "):<20}')
        print()
    sys.exit(0)


def cmd_bedrock_interpret(args):
    """Direct bedrock interpretation invocation."""
    try:
        recommendations = json.loads(args.recommendations_json)
    except (json.JSONDecodeError, TypeError):
        print('')
        sys.exit(0)

    try:
        current_config = json.loads(args.current_config_json)
    except (json.JSONDecodeError, TypeError):
        current_config = {}

    result = bedrock_interpret(recommendations, current_config, args.region)
    print(result or '')
    sys.exit(0)


# ── Argparse ──────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description='Athena-backed optimization engine for do/optimize'
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # ── recommend ─────────────────────────────────────────────────────────────
    p_recommend = subparsers.add_parser('recommend',
                                        help='Query Athena for proven configs')
    p_recommend.add_argument('--model-name', required=True)
    p_recommend.add_argument('--instance-type', required=True)
    p_recommend.add_argument('--quantization', default='bf16')
    p_recommend.add_argument('--tensor-parallel', type=int, default=1)
    p_recommend.add_argument('--max-model-len', type=int, default=4096)
    p_recommend.add_argument('--kv-cache-dtype', default='auto')
    p_recommend.add_argument('--metric', default='output_token_throughput_tps')
    p_recommend.add_argument('--bucket', required=True)
    p_recommend.add_argument('--glue-database', default='mlcc_ci')
    p_recommend.add_argument('--glue-table', default='benchmark_results')
    p_recommend.add_argument('--region', default='us-east-1')
    p_recommend.add_argument('--bedrock-interpret', action='store_true', default=False)
    p_recommend.set_defaults(func=cmd_recommend)

    # ── compare-baseline ──────────────────────────────────────────────────────
    p_compare = subparsers.add_parser('compare-baseline',
                                      help='Compare local results vs historical best')
    p_compare.add_argument('--results-file', required=True)
    p_compare.add_argument('--model-name', required=True)
    p_compare.add_argument('--instance-type', required=True)
    p_compare.add_argument('--quantization', default='bf16')
    p_compare.add_argument('--tensor-parallel', type=int, default=1)
    p_compare.add_argument('--max-model-len', type=int, default=None,
                           help='BL101: conditionally added to the key when > 0')
    p_compare.add_argument('--kv-cache-dtype', default=None,
                           help='BL101: conditionally added to the key when non-empty/non-auto')
    p_compare.add_argument('--pinned-baseline', default=None,
                           help='BL101: pin comparison to a specific benchmark job name')
    p_compare.add_argument('--bucket', required=True)
    p_compare.add_argument('--glue-database', default='mlcc_ci')
    p_compare.add_argument('--glue-table', default='benchmark_results')
    p_compare.add_argument('--region', default='us-east-1')
    p_compare.add_argument('--threshold', action='append',
                           help='metric:pct threshold (repeatable)')
    p_compare.add_argument('--adapter-name', default=None,
                           help='Filter baseline to this adapter name (empty string = base model only)')
    p_compare.add_argument('--json', dest='json_output', action='store_true', default=False)
    p_compare.set_defaults(func=cmd_compare_baseline)

    # ── peak (BL101) ──────────────────────────────────────────────────────────
    p_peak = subparsers.add_parser('peak',
                                   help='Show best historical record for the current config')
    p_peak.add_argument('--model-name', required=True)
    p_peak.add_argument('--instance-type', required=True)
    p_peak.add_argument('--quantization', default='none')
    p_peak.add_argument('--tensor-parallel', type=int, default=1)
    p_peak.add_argument('--max-model-len', type=int, default=None)
    p_peak.add_argument('--kv-cache-dtype', default=None)
    p_peak.add_argument('--workload', default=None)
    p_peak.add_argument('--metric', default='output_token_throughput_tps')
    p_peak.add_argument('--bucket', required=True)
    p_peak.add_argument('--glue-database', default='mlcc_ci')
    p_peak.add_argument('--glue-table', default='benchmark_results')
    p_peak.add_argument('--region', default='us-east-1')
    p_peak.add_argument('--json', dest='json_output', action='store_true', default=False)
    p_peak.set_defaults(func=cmd_peak)

    # ── list (BL101) ──────────────────────────────────────────────────────────
    p_list = subparsers.add_parser('list',
                                   help='List all benchmark runs grouped by config key')
    p_list.add_argument('--model', default=None,
                        help='Exact model name or family prefix (e.g. llama-3.1)')
    p_list.add_argument('--model-family', dest='model_family', default=None,
                        help='Optional pre-derived model family for prefix matching')
    p_list.add_argument('--workload', default=None)
    p_list.add_argument('--sort', default='output_token_throughput_tps')
    p_list.add_argument('--limit', type=int, default=100)
    p_list.add_argument('--min-tp', dest='min_tp', type=int, default=None,
                        help='Minimum tensor parallel degree')
    p_list.add_argument('--quantization', dest='filter_quantization', default=None)
    p_list.add_argument('--max-model-len', dest='filter_max_model_len', type=int, default=None)
    p_list.add_argument('--kv-cache-dtype', dest='filter_kv_cache_dtype', default=None)
    p_list.add_argument('--exclude-instance', dest='exclude_instances', default='',
                        metavar='INSTANCES',
                        help='Comma-separated instance types to exclude (e.g. ml.m5.large,ml.g6.2xlarge)')
    p_list.add_argument('--include-instance', dest='include_instances', default='',
                        metavar='INSTANCES',
                        help='Comma-separated instance types to include (whitelist)')
    p_list.add_argument('--bucket', required=True)
    p_list.add_argument('--glue-database', default='mlcc_ci')
    p_list.add_argument('--glue-table', default='benchmark_results')
    p_list.add_argument('--region', default='us-east-1')
    p_list.add_argument('--json', dest='json_output', action='store_true', default=False)
    p_list.set_defaults(func=cmd_list)

    # ── bedrock-interpret ─────────────────────────────────────────────────────
    p_bedrock = subparsers.add_parser('bedrock-interpret',
                                      help='Explain recommendations via Bedrock')
    p_bedrock.add_argument('--recommendations-json', required=True)
    p_bedrock.add_argument('--current-config-json', default='{}')
    p_bedrock.add_argument('--region', default='us-east-1')
    p_bedrock.set_defaults(func=cmd_bedrock_interpret)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
