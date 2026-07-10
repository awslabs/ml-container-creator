from __future__ import annotations
"""Tune status: query training job status and metrics.

Purpose: cmd_status subcommand for do/tune
Inputs: --job-name, --region
Outputs: JSON with status, failure_reason, metrics, elapsed_seconds, output_path
Caller: .tune_helper.py dispatcher
Related: tune_submit.py (submits the jobs this queries)
"""

import json
import os
import sys
import time

from common import _output, _error_exit


def _sanitize_for_json(value):
    """Convert sagemaker-core Unassigned sentinel values to None for JSON serialization.

    sagemaker-core uses an 'Unassigned' type instead of None for unset fields.
    This function converts any non-standard types to JSON-safe values.
    """
    if value is None:
        return None
    # Check for Unassigned type from sagemaker-core
    type_name = type(value).__name__
    if type_name == "Unassigned" or type_name == "UnassignedValue":
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {k: _sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_for_json(v) for v in value]
    # For other types, try str conversion as fallback
    try:
        # Check if it's JSON serializable as-is
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value) if value else None


def cmd_status(args):
    """Query job status via sagemaker-core TrainingJob.get().

    Falls back to boto3 ListTrainingJobs with name-contains if exact name not found
    (SDK v3 appends a timestamp suffix to the base job name).

    Returns: {"status": str, "failure_reason": str|None,
              "metrics": dict|None, "elapsed_seconds": int}
    """
    # Set region before any sagemaker import (creates boto3 clients at import time)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    from sagemaker.core.resources import TrainingJob
    from botocore.exceptions import ClientError

    # Try exact name first via sagemaker-core
    job = None
    try:
        job = TrainingJob.get(training_job_name=args.job_name)
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code != "ValidationException":
            _error_exit(f"Failed to describe training job: {e}")
        # Job not found by exact name — try name-contains search
    except Exception as e:
        _error_exit(f"Failed to describe training job: {e}")

    # Fallback: search by name prefix (SDK appends timestamp suffix)
    # Note: TrainingJob.get_all() with name_contains is not available in
    # sagemaker-core for list operations, so we use boto3 list_training_jobs
    # to find the actual name, then call TrainingJob.get() with it.
    if job is None:
        try:
            import boto3
            client = boto3.client("sagemaker", region_name=args.region)
            list_response = client.list_training_jobs(
                NameContains=args.job_name,
                SortBy="CreationTime",
                SortOrder="Descending",
                MaxResults=1,
            )
            summaries = list_response.get("TrainingJobSummaries", [])
            if summaries:
                actual_name = summaries[0]["TrainingJobName"]
                job = TrainingJob.get(training_job_name=actual_name)
            else:
                _error_exit(f"Training job not found: {args.job_name}")
        except Exception as e:
            _error_exit(f"Failed to find training job: {e}")

    # Read status attributes directly from the TrainingJob resource object.
    # sagemaker-core returns status values in the same casing as the API
    # (e.g., "InProgress", "Completed", "Failed", "Stopped").
    status = getattr(job, "training_job_status", "Unknown") or "Unknown"
    failure_reason = getattr(job, "failure_reason", None)

    # Calculate elapsed time
    start_time = getattr(job, "training_start_time", None)
    end_time = getattr(job, "training_end_time", None)
    # Convert Unassigned sentinel to None
    if start_time and type(start_time).__name__ in ("Unassigned", "UnassignedValue"):
        start_time = None
    if end_time and type(end_time).__name__ in ("Unassigned", "UnassignedValue"):
        end_time = None
    elapsed_seconds = 0

    if start_time:
        end = end_time if end_time else time.time()
        if hasattr(end, "timestamp"):
            end = end.timestamp()
        elapsed_seconds = int(end - start_time.timestamp())

    # Extract final metrics if available
    metrics = None
    final_metrics = getattr(job, "final_metric_data_list", None)
    if final_metrics and type(final_metrics).__name__ in ("Unassigned", "UnassignedValue"):
        final_metrics = None
    if final_metrics:
        metrics = {}
        for metric in final_metrics:
            # sagemaker-core returns metrics as objects with snake_case attributes
            metric_name = getattr(metric, "metric_name", None) or metric.get("MetricName", "")
            metric_value = getattr(metric, "value", None) or metric.get("Value", 0)
            metrics[metric_name] = metric_value

    # Get output path if completed
    output_path = None
    if status == "Completed":
        model_artifacts = getattr(job, "model_artifacts", None)
        if model_artifacts:
            output_path = getattr(model_artifacts, "s3_model_artifacts", None)

    _output({
        "status": _sanitize_for_json(status),
        "failure_reason": _sanitize_for_json(failure_reason),
        "metrics": _sanitize_for_json(metrics),
        "elapsed_seconds": elapsed_seconds,
        "output_path": _sanitize_for_json(output_path),
    })
