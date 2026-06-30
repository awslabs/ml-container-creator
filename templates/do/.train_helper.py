#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Training Job helper (SDK v3).

Subcommands:
    submit  - Create a training job via TrainingJob.create()
    status  - Get job status via TrainingJob.get()
    resolve - Extract artifact path from completed job
    stop    - Stop a running training job

All output is JSON on stdout for bash consumption.
Pattern: grep -E '^\\{' | tail -1 to extract JSON from mixed output.
"""

import argparse
import json
import os
import sys
import warnings

# Suppress noisy dependency warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*urllib3.*")

# Suppress ALL logging to prevent sagemaker-core/rich from writing to stdout
import logging as _logging
_logging.disable(_logging.CRITICAL)
os.environ.setdefault("SAGEMAKER_LOG_LEVEL", "CRITICAL")


# ── Utility functions ─────────────────────────────────────────────────────────

def _error_exit(message):
    """Print JSON error to stdout and exit with code 1."""
    print(json.dumps({"error": True, "message": message}))
    sys.exit(1)


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


def _sanitize_for_json(value):
    """Convert sagemaker-core Unassigned sentinel values to None."""
    if value is None:
        return None
    type_name = type(value).__name__
    if type_name in ("Unassigned", "UnassignedValue"):
        return None
    return value


# ── cmd_submit ────────────────────────────────────────────────────────────────

def cmd_submit(args):
    """Create a SageMaker Training Job via SDK v3.

    Reads job configuration from a JSON file (same format as the old
    CreateTrainingJob CLI input), then submits via TrainingJob.create().

    Returns: {"job_name": str, "job_arn": str, "status": "InProgress"}
    """
    # Set region BEFORE any sagemaker import (Bug 26 pattern)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    # Read config file
    try:
        with open(args.config, 'r') as f:
            config = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        _error_exit(f"Failed to read config file: {e}")

    # Import SDK v3 TrainingJob (same pattern as .tune_helper.py cmd_status)
    try:
        from sagemaker.core.resources import TrainingJob
    except ImportError:
        _error_exit(
            "sagemaker SDK v3 not installed. "
            "Install: pip install 'sagemaker>=3.0'"
        )

    # Extract fields from the CreateTrainingJob-format config
    job_name = config.get('TrainingJobName', '')
    role_arn = config.get('RoleArn', '')
    algo_spec = config.get('AlgorithmSpecification', {})
    resource_config = config.get('ResourceConfig', {})
    input_data_config = config.get('InputDataConfig', [])
    output_data_config = config.get('OutputDataConfig', {})
    stopping_condition = config.get('StoppingCondition', {})
    hyper_parameters = config.get('HyperParameters', {})
    checkpoint_config = config.get('CheckpointConfig')
    environment = config.get('Environment', {})
    enable_spot = config.get('EnableManagedSpotTraining', False)
    tags = config.get('Tags', [])

    # Build SDK v3 create kwargs (snake_case per Pydantic v2)
    create_kwargs = {
        'training_job_name': job_name,
        'role_arn': role_arn,
        'algorithm_specification': {
            'training_image': algo_spec.get('TrainingImage', ''),
            'training_input_mode': algo_spec.get('TrainingInputMode', 'File'),
        },
        'resource_config': {
            'instance_type': resource_config.get('InstanceType', 'ml.g5.xlarge'),
            'instance_count': resource_config.get('InstanceCount', 1),
            'volume_size_in_gb': resource_config.get('VolumeSizeInGB', 50),
        },
        'output_data_config': {
            's3_output_path': output_data_config.get('S3OutputPath', ''),
        },
        'stopping_condition': {
            'max_runtime_in_seconds': stopping_condition.get('MaxRuntimeInSeconds', 86400),
        },
    }

    # Input data channels
    if input_data_config:
        channels = []
        for channel in input_data_config:
            ch = {
                'channel_name': channel.get('ChannelName', 'training'),
                'data_source': {
                    's3_data_source': {
                        's3_data_type': channel.get('DataSource', {}).get('S3DataSource', {}).get('S3DataType', 'S3Prefix'),
                        's3_uri': channel.get('DataSource', {}).get('S3DataSource', {}).get('S3Uri', ''),
                        's3_data_distribution_type': channel.get('DataSource', {}).get('S3DataSource', {}).get('S3DataDistributionType', 'FullyReplicated'),
                    }
                }
            }
            channels.append(ch)
        create_kwargs['input_data_config'] = channels

    # Hyperparameters (all values must be strings)
    if hyper_parameters:
        create_kwargs['hyper_parameters'] = {
            str(k): str(v) for k, v in hyper_parameters.items()
        }

    # Metric definitions
    metric_defs = algo_spec.get('MetricDefinitions', [])
    if metric_defs:
        create_kwargs['algorithm_specification']['metric_definitions'] = [
            {'name': m.get('Name', ''), 'regex': m.get('Regex', '')}
            for m in metric_defs
        ]

    # Managed spot training
    if enable_spot:
        create_kwargs['enable_managed_spot_training'] = True
        max_wait = stopping_condition.get('MaxWaitTimeInSeconds')
        if max_wait:
            create_kwargs['stopping_condition']['max_wait_time_in_seconds'] = max_wait

    # Checkpoint config
    if checkpoint_config:
        create_kwargs['checkpoint_config'] = {
            's3_uri': checkpoint_config.get('S3Uri', ''),
        }

    # Environment
    if environment:
        create_kwargs['environment'] = environment

    # Tags
    if tags:
        create_kwargs['tags'] = [
            {'key': t.get('Key', ''), 'value': t.get('Value', '')}
            for t in tags
        ]

    # Submit the job
    try:
        job = TrainingJob.create(**create_kwargs)
        job_arn = getattr(job, 'training_job_arn', '') or ''
        _output({
            "job_name": job_name,
            "job_arn": _sanitize_for_json(job_arn) or job_name,
            "status": "InProgress"
        })
    except Exception as e:
        error_msg = str(e)
        if "AccessDenied" in error_msg or "AccessDeniedException" in error_msg:
            _error_exit(
                f"Access denied when submitting training job. "
                f"Ensure the role has sagemaker:CreateTrainingJob permission. "
                f"Details: {error_msg}"
            )
        else:
            _error_exit(f"Failed to create training job: {error_msg}")


# ── cmd_status ────────────────────────────────────────────────────────────────

def cmd_status(args):
    """Query job status via TrainingJob.get().

    Returns: {"status": str, "secondary_status": str, "failure_reason": str|null,
              "elapsed_seconds": int|null, "metrics": dict|null,
              "display": str, "model_artifacts": str|null}
    """
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    try:
        from sagemaker.core.resources import TrainingJob
    except ImportError:
        _error_exit("sagemaker SDK v3 not installed.")

    # Get job
    try:
        job = TrainingJob.get(training_job_name=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to describe training job '{args.job_name}': {e}")

    status = _sanitize_for_json(getattr(job, 'training_job_status', 'Unknown')) or 'Unknown'
    secondary = _sanitize_for_json(getattr(job, 'secondary_status', '')) or ''
    failure_reason = _sanitize_for_json(getattr(job, 'failure_reason', None))

    # Elapsed time
    elapsed_seconds = None
    start_time = _sanitize_for_json(getattr(job, 'training_start_time', None))
    end_time = _sanitize_for_json(getattr(job, 'training_end_time', None))
    if start_time:
        from datetime import datetime, timezone
        try:
            if end_time:
                elapsed_seconds = int((end_time - start_time).total_seconds())
            else:
                now = datetime.now(timezone.utc)
                elapsed_seconds = int((now - start_time).total_seconds())
        except (TypeError, AttributeError):
            pass

    # Metrics
    metrics = None
    final_metrics = _sanitize_for_json(getattr(job, 'final_metric_data_list', None))
    if final_metrics:
        try:
            metrics = {
                m.metric_name: m.value
                for m in final_metrics
                if hasattr(m, 'metric_name') and hasattr(m, 'value')
            }
        except (TypeError, AttributeError):
            pass

    # Model artifacts
    model_artifacts = None
    artifacts_obj = _sanitize_for_json(getattr(job, 'model_artifacts', None))
    if artifacts_obj:
        model_artifacts = _sanitize_for_json(getattr(artifacts_obj, 's3_model_artifacts', None))

    # Build display line
    emoji_map = {'InProgress': '🔄', 'Completed': '✅', 'Failed': '❌', 'Stopped': '⏹️'}
    emoji = emoji_map.get(status, '❓')
    display_parts = [f"   {emoji} {status}"]
    if secondary:
        display_parts.append(f"| {secondary}")
    if elapsed_seconds is not None:
        hours = elapsed_seconds // 3600
        mins = (elapsed_seconds % 3600) // 60
        secs = elapsed_seconds % 60
        if hours > 0:
            display_parts.append(f"| elapsed: {hours}h {mins}m {secs}s")
        elif mins > 0:
            display_parts.append(f"| elapsed: {mins}m {secs}s")
        else:
            display_parts.append(f"| elapsed: {secs}s")

    _output({
        "status": status,
        "secondary_status": secondary,
        "failure_reason": failure_reason,
        "elapsed_seconds": elapsed_seconds,
        "metrics": metrics,
        "model_artifacts": model_artifacts,
        "display": " ".join(display_parts),
    })


# ── cmd_resolve ───────────────────────────────────────────────────────────────

def cmd_resolve(args):
    """Extract model artifact or checkpoint S3 path from a training job.

    With --checkpoints: returns checkpoint_config.s3_uri (for --resume).
    Without: returns model artifacts path (for adapter staging).

    Returns: {"artifact_path": str, "output_type": str, "checkpoint_path": str|null}
    """
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    try:
        from sagemaker.core.resources import TrainingJob
    except ImportError:
        _error_exit("sagemaker SDK v3 not installed.")

    try:
        job = TrainingJob.get(training_job_name=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to describe training job '{args.job_name}': {e}")

    # If --checkpoints flag, return checkpoint path (job can be any status)
    if getattr(args, 'checkpoints', False):
        checkpoint_config = _sanitize_for_json(getattr(job, 'checkpoint_config', None))
        checkpoint_path = None
        if checkpoint_config:
            checkpoint_path = _sanitize_for_json(getattr(checkpoint_config, 's3_uri', None))

        # Fallback: derive from output path
        if not checkpoint_path:
            output_config = _sanitize_for_json(getattr(job, 'output_data_config', None))
            if output_config:
                s3_output = _sanitize_for_json(getattr(output_config, 's3_output_path', None))
                if s3_output:
                    checkpoint_path = f"{s3_output.rstrip('/')}/checkpoints/"

        _output({
            "checkpoint_path": checkpoint_path or "",
            "job_name": args.job_name,
        })
        return

    # Normal resolve: require completed status
    status = _sanitize_for_json(getattr(job, 'training_job_status', 'Unknown')) or 'Unknown'
    if status != 'Completed':
        _error_exit(f"Job '{args.job_name}' is not completed (status: {status})")

    artifacts_obj = _sanitize_for_json(getattr(job, 'model_artifacts', None))
    if not artifacts_obj:
        _error_exit(f"No model artifacts found for job '{args.job_name}'")

    artifact_path = _sanitize_for_json(getattr(artifacts_obj, 's3_model_artifacts', None))
    if not artifact_path:
        _error_exit(f"No S3 model artifacts path for job '{args.job_name}'")

    # Detect output type based on technique hint
    output_type = "full-model"
    technique = getattr(args, 'technique', None)
    if technique and technique in ('sft', 'dpo'):
        output_type = "adapter"

    _output({
        "artifact_path": artifact_path,
        "output_type": output_type,
    })


# ── cmd_stop ──────────────────────────────────────────────────────────────────

def cmd_stop(args):
    """Stop a running training job.

    Returns: {"stopped": true, "job_name": str}
    """
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    try:
        from sagemaker.core.resources import TrainingJob
    except ImportError:
        _error_exit("sagemaker SDK v3 not installed.")

    try:
        job = TrainingJob.get(training_job_name=args.job_name)
        job.stop()
        _output({"stopped": True, "job_name": args.job_name})
    except Exception as e:
        _error_exit(f"Failed to stop training job '{args.job_name}': {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    """Parse arguments and dispatch to subcommand handler."""
    parser = argparse.ArgumentParser(description='SageMaker Training Job helper (SDK v3)')
    subparsers = parser.add_subparsers(dest='command', required=True)

    # submit
    submit_parser = subparsers.add_parser('submit', help='Create a training job')
    submit_parser.add_argument('--config', required=True, help='Path to job config JSON')
    submit_parser.add_argument('--region', help='AWS region')

    # status
    status_parser = subparsers.add_parser('status', help='Get job status')
    status_parser.add_argument('--job-name', required=True, help='Training job name')
    status_parser.add_argument('--region', help='AWS region')

    # resolve
    resolve_parser = subparsers.add_parser('resolve', help='Resolve artifacts from completed job')
    resolve_parser.add_argument('--job-name', required=True, help='Training job name')
    resolve_parser.add_argument('--technique', help='Training technique (for output type hint)')
    resolve_parser.add_argument('--checkpoints', action='store_true', help='Return checkpoint S3 path instead of model artifacts')
    resolve_parser.add_argument('--region', help='AWS region')

    # stop
    stop_parser = subparsers.add_parser('stop', help='Stop a running job')
    stop_parser.add_argument('--job-name', required=True, help='Training job name')
    stop_parser.add_argument('--region', help='AWS region')

    args = parser.parse_args()

    commands = {
        'submit': cmd_submit,
        'status': cmd_status,
        'resolve': cmd_resolve,
        'stop': cmd_stop,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f"Unknown command: {args.command}")


if __name__ == '__main__':
    main()
