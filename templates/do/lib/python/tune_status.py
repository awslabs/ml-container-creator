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
        except Exception:
            pass  # Will try Jobs API fallback below

    # Fallback 2: SageMaker Jobs API (describe_job / list_jobs).
    # Managed customization on newer instance types (e.g., g6e) may route
    # through the Jobs API (CreateJob) rather than CreateTrainingJob.
    # These jobs won't appear in list_training_jobs.
    if job is None:
        try:
            import boto3
            client = boto3.client("sagemaker", region_name=args.region)

            # Try exact name via describe_job first
            job_info = None
            for category in ("AgentRFT", "AgentRFTEvaluation"):
                try:
                    job_info = client.describe_job(
                        JobName=args.job_name,
                        JobCategory=category,
                    )
                    break
                except client.exceptions.ResourceNotFound:
                    continue
                except Exception:
                    continue

            # If not found by exact name, try list_jobs with name filter
            if not job_info:
                try:
                    list_resp = client.list_jobs(
                        NameContains=args.job_name,
                        SortBy="CreationTime",
                        SortOrder="Descending",
                        MaxResults=1,
                    )
                    job_summaries = list_resp.get("JobSummaries", [])
                    if job_summaries:
                        actual_name = job_summaries[0]["JobName"]
                        category = job_summaries[0].get("JobCategory", "AgentRFT")
                        job_info = client.describe_job(
                            JobName=actual_name,
                            JobCategory=category,
                        )
                except Exception:
                    pass

            if job_info:
                # Convert Jobs API response to our standard output format
                status = job_info.get("JobStatus", "Unknown")
                failure_reason = None
                if status == "Failed":
                    transitions = job_info.get("SecondaryStatusTransitions", [])
                    for t in reversed(transitions):
                        if t.get("Status") == "Failed" and t.get("StatusMessage"):
                            failure_reason = t["StatusMessage"]
                            break

                creation_time = job_info.get("CreationTime")
                end_time = job_info.get("EndTime")
                elapsed_seconds = 0
                if creation_time:
                    end = end_time if end_time else __import__('datetime').datetime.now(
                        __import__('datetime').timezone.utc)
                    elapsed_seconds = int((end - creation_time).total_seconds())

                _output({
                    "status": status,
                    "failure_reason": failure_reason,
                    "metrics": None,
                    "elapsed_seconds": elapsed_seconds,
                    "output_path": None,
                })
        except Exception:
            pass

    if job is None:
        _error_exit(f"Training job not found: {args.job_name}")

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
