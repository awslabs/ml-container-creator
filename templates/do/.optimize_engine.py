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

# Dimension → IC_ENV_ config key mapping
DIMENSION_CONFIG_KEY = {
    'quantization': 'IC_ENV_VLLM_QUANTIZATION',
    'tensor_parallel_degree': 'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE',
    'max_model_len': 'IC_ENV_VLLM_MAX_MODEL_LEN',
    'kv_cache_dtype': 'IC_ENV_VLLM_KV_CACHE_DTYPE',
}

# Metric aliases for --threshold parsing
METRIC_ALIASES = {
    'throughput': 'output_token_throughput_tps',
    'ttft': 'ttft_p90_ms',
    'itl': 'itl_p90_ms',
    'latency': 'e2e_latency_p90_ms',
}

# All comparison metrics for --compare-baseline
COMPARISON_METRICS = [
    'output_token_throughput_tps',
    'ttft_p90_ms',
    'itl_p90_ms',
    'e2e_latency_p90_ms',
]

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
            f"run_timestamp, model_family, instance_family "
            f"FROM {self.database}.{self.table} "
            f"WHERE model = '{model_partition}' "
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
                f"run_timestamp, model_family, instance_family "
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
                f"run_timestamp, model_family, instance_family "
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

    def query_best_baseline(self, model_name: str, instance_type: str,
                            quantization: str, tensor_parallel_degree: int) -> dict | None:
        """Query single best result for exact config. Returns dict or None."""
        model_partition = _sanitize_partition_value(model_name)
        instance_partition = instance_type

        sql = (
            f"SELECT output_token_throughput_tps, request_throughput_rps, "
            f"ttft_p90_ms, itl_p90_ms, e2e_latency_p90_ms, "
            f"benchmark_job_name, run_timestamp "
            f"FROM {self.database}.{self.table} "
            f"WHERE model = '{model_partition}' "
            f"AND instance = '{instance_partition}' "
            f"AND quantization = '{quantization}' "
            f"AND tensor_parallel_degree = {tensor_parallel_degree} "
            f"ORDER BY output_token_throughput_tps DESC "
            f"LIMIT 1"
        )
        records = self._run_query(sql)
        if records:
            return records[0]
        return None

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

    def __init__(self, current_config: dict, benchmark_records: list, target_metric: str):
        self.current = current_config
        self.records = benchmark_records
        self.metric = target_metric

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
                if dim_val is None or metric_val is None:
                    continue
                # Normalize to string for grouping
                dim_key = str(dim_val)
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
                'config_key': DIMENSION_CONFIG_KEY.get(dimension, ''),
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
    )

    recommendations = rec_engine.compute_recommendations()
    no_change = rec_engine.compute_no_change_dimensions()

    result = {
        'status': 'ok',
        'model_name': model_name,
        'instance_type': instance_type,
        'match_level': match_level,
        'target_metric': args.metric,
        'total_records_found': len(records),
        'current_config': current_config,
        'recommendations': recommendations,
        'no_change_dimensions': no_change,
    }

    # Optionally add Bedrock interpretation
    if args.bedrock_interpret and recommendations:
        analysis = bedrock_interpret(recommendations, current_config, args.region)
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

    # Query Athena for historical best
    engine = AthenaQueryEngine(
        glue_database=args.glue_database,
        glue_table=args.glue_table,
        bucket=args.bucket,
        region=args.region,
    )

    try:
        baseline = engine.query_best_baseline(
            model_name=model_name,
            instance_type=instance_type,
            quantization=args.quantization,
            tensor_parallel_degree=args.tensor_parallel,
        )
    except Exception as e:
        _error_exit(f"Athena query failed: {e}")
        return

    if not baseline:
        result = {
            'status': 'no_baseline',
            'has_baseline': False,
            'thresholds_applied': thresholds,
            'comparisons': [],
        }
        _output(result)
        return

    # Compare metrics
    comparisons = []
    has_regression = False

    for metric in COMPARISON_METRICS:
        baseline_val = baseline.get(metric)
        current_val = local_metrics.get(metric)

        if baseline_val is None or current_val is None:
            continue

        baseline_val = float(baseline_val)
        current_val = float(current_val)
        direction = METRIC_DIRECTION.get(metric, 'higher_is_better')
        threshold_pct = thresholds.get(metric, DEFAULT_THRESHOLD_PCT)

        if baseline_val != 0:
            delta_pct = ((current_val - baseline_val) / abs(baseline_val)) * 100
        else:
            delta_pct = 0.0

        # Determine if regression
        if direction == 'higher_is_better':
            # Regression if current is lower by more than threshold
            is_regression = delta_pct < -threshold_pct
        else:
            # Regression if current is higher by more than threshold
            is_regression = delta_pct > threshold_pct

        status = 'regression' if is_regression else 'pass'
        if is_regression:
            has_regression = True

        comparisons.append({
            'metric': metric,
            'baseline': round(baseline_val, 1),
            'current': round(current_val, 1),
            'delta_pct': round(delta_pct, 1),
            'direction': direction,
            'threshold_pct': threshold_pct,
            'status': status,
        })

    result = {
        'status': 'regression' if has_regression else 'pass',
        'has_baseline': True,
        'baseline_job': baseline.get('benchmark_job_name', ''),
        'baseline_timestamp': baseline.get('run_timestamp', ''),
        'thresholds_applied': thresholds,
        'comparisons': comparisons,
    }

    print(json.dumps(result))
    sys.exit(1 if has_regression else 0)


def _parse_local_results(results_file: str) -> dict:
    """Parse metrics from a profile_export.jsonl file.

    Returns dict with metric names as keys and values.
    """
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

                # Look for aggregate metrics in the record
                if 'output_token_throughput_tps' in record:
                    for m in COMPARISON_METRICS:
                        if m in record and record[m] is not None:
                            # Take the last (most complete) record's values
                            metrics[m] = float(record[m])
    except Exception:
        return {}

    return metrics


# ── Subcommand: bedrock-interpret (direct invocation) ─────────────────────────


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
    p_compare.add_argument('--bucket', required=True)
    p_compare.add_argument('--glue-database', default='mlcc_ci')
    p_compare.add_argument('--glue-table', default='benchmark_results')
    p_compare.add_argument('--region', default='us-east-1')
    p_compare.add_argument('--threshold', action='append',
                           help='metric:pct threshold (repeatable)')
    p_compare.add_argument('--json', dest='json_output', action='store_true', default=False)
    p_compare.set_defaults(func=cmd_compare_baseline)

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
