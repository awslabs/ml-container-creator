#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Processing Job helper for adapter staging.

Subcommands:
    stage-from-tune  - Submit Processing Job to copy adapter from training output to S3
    status           - Check Processing Job status

All output is JSON on stdout for bash consumption.

Uses sagemaker-core ProcessingJob.create() / ProcessingJob.get() per SDK v3 policy.
"""

import argparse
import logging
import json
import os
import sys
import time
import warnings

# Suppress noisy dependency version warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*urllib3.*")

# Suppress sagemaker-core INFO/WARNING logging that pollutes stdout
logging.getLogger("sagemaker.config").setLevel(logging.ERROR)
logging.getLogger("sagemaker.core").setLevel(logging.ERROR)
logging.getLogger("sagemaker").setLevel(logging.ERROR)

# ── Constants ─────────────────────────────────────────────────────────────────
POLL_INTERVAL_SECONDS = 30
MAX_RUNTIME_SECONDS = 3600  # 1 hour timeout for adapter staging
INSTANCE_TYPE = "ml.m5.large"
VOLUME_SIZE_GB = 100

# ── Utility functions ─────────────────────────────────────────────────────────


def _error_exit(message, exit_code=1):
    """Print error to stderr and exit."""
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(exit_code)


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


# ── Dependency checks ─────────────────────────────────────────────────────────


def _check_sagemaker_core():
    """Verify sagemaker-core is installed."""
    try:
        from sagemaker.core.resources import ProcessingJob  # noqa: F401
    except ImportError:
        _error_exit(
            "sagemaker-core is not installed. "
            "Please install: pip install 'sagemaker>=3.0.0' (includes sagemaker-core)"
        )


def _check_boto3():
    """Verify boto3 is installed (needed for S3 entrypoint upload)."""
    try:
        import boto3  # noqa: F401
    except ImportError:
        _error_exit(
            "boto3 is not installed. "
            "Please install: pip install boto3"
        )


# ── Processing Job helpers ────────────────────────────────────────────────────


def _generate_job_name(project_name, adapter_name):
    """Generate a unique Processing Job name."""
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    # Job names must be <= 63 chars, start with alphanumeric
    base = f"mlcc-adapter-{project_name}-{adapter_name}"
    # Truncate base to leave room for timestamp
    max_base = 63 - len(timestamp) - 1
    if len(base) > max_base:
        base = base[:max_base]
    return f"{base}-{timestamp}"


def _upload_entrypoint(bucket, job_name, region):
    """Upload the processing job entrypoint script to S3.

    The entrypoint simply copies files from the Processing input path
    to the Processing output path (SageMaker handles S3 download/upload).

    Returns the S3 URI of the uploaded entrypoint.
    """
    import boto3

    entrypoint_content = """#!/bin/bash
set -e
echo "Adapter staging: copying input to output..."
echo "Input contents:"
ls -la /opt/ml/processing/input/adapter/ || echo "No input files found"
echo ""
echo "Copying adapter files..."
cp -r /opt/ml/processing/input/adapter/* /opt/ml/processing/output/ 2>/dev/null || \
cp -r /opt/ml/processing/input/adapter/. /opt/ml/processing/output/
echo "Output contents:"
ls -la /opt/ml/processing/output/
echo ""
echo "Adapter staging complete."
"""

    s3_key = f"staging-jobs/{job_name}/entrypoint.sh"
    s3_uri = f"s3://{bucket}/{s3_key}"

    s3_client = boto3.client("s3", region_name=region)
    try:
        s3_client.put_object(
            Bucket=bucket,
            Key=s3_key,
            Body=entrypoint_content.encode("utf-8"),
            ContentType="text/x-shellscript",
        )
    except Exception as e:
        _error_exit(f"Failed to upload entrypoint to S3: {e}")

    return s3_uri


def _resolve_container_image(region):
    """Resolve the SageMaker-managed PyTorch CPU image URI for the region.

    Uses the standard SageMaker DLC (Deep Learning Container) PyTorch CPU image
    which includes AWS CLI and Python 3.10.
    """
    # SageMaker DLC account IDs per region
    # https://docs.aws.amazon.com/sagemaker/latest/dg/ecr-us-east-1.html
    dlc_accounts = {
        "us-east-1": "763104351884",
        "us-east-2": "763104351884",
        "us-west-1": "763104351884",
        "us-west-2": "763104351884",
        "eu-west-1": "763104351884",
        "eu-west-2": "763104351884",
        "eu-central-1": "763104351884",
        "ap-northeast-1": "763104351884",
        "ap-southeast-1": "763104351884",
        "ap-southeast-2": "763104351884",
        "ap-south-1": "763104351884",
        "ca-central-1": "763104351884",
    }
    account_id = dlc_accounts.get(region, "763104351884")
    # Use PyTorch CPU processing image
    return f"{account_id}.dkr.ecr.{region}.amazonaws.com/pytorch-training:2.2.0-cpu-py310-ubuntu20.04-sagemaker"


# ── Subcommand: stage-from-tune ───────────────────────────────────────────────


def cmd_stage_from_tune(args):
    """Submit a Processing Job to copy adapter from training output to S3 adapter location.

    Returns: {"job_name": str, "status": str, "adapter_s3_uri": str}
    """
    _check_sagemaker_core()
    _check_boto3()

    from sagemaker.core.resources import ProcessingJob

    # Validate required arguments
    if not args.training_output_s3_uri:
        _error_exit("--training-output-s3-uri is required")
    if not args.adapter_name:
        _error_exit("--adapter-name is required")
    if not args.bucket:
        _error_exit("--bucket is required")
    if not args.project:
        _error_exit("--project is required")
    if not args.role_arn:
        _error_exit("--role-arn is required")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    # Ensure region is set in env for sagemaker-core
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    # Generate job name
    job_name = _generate_job_name(args.project, args.adapter_name)

    # Build adapter output S3 URI
    adapter_s3_uri = f"s3://{args.bucket}/{args.project}/adapters/{args.adapter_name}/"

    # Resolve container image
    container_image = args.container_image or _resolve_container_image(region)

    # Upload entrypoint script to S3
    entrypoint_s3_uri = _upload_entrypoint(args.bucket, job_name, region)

    # Build entrypoint command — download script from S3 then execute
    entrypoint_cmd = (
        f"aws s3 cp {entrypoint_s3_uri} /tmp/entrypoint.sh && "
        "chmod +x /tmp/entrypoint.sh && /tmp/entrypoint.sh"
    )

    # Normalize training output S3 URI (ensure trailing slash for S3Prefix)
    training_output_s3_uri = args.training_output_s3_uri
    if not training_output_s3_uri.endswith("/"):
        training_output_s3_uri += "/"

    # Submit Processing Job via sagemaker-core
    try:
        job = ProcessingJob.create(
            processing_job_name=job_name,
            processing_resources={
                "cluster_config": {
                    "instance_count": 1,
                    "instance_type": INSTANCE_TYPE,
                    "volume_size_in_gb": VOLUME_SIZE_GB,
                }
            },
            processing_inputs=[{
                "input_name": "adapter",
                "s3_input": {
                    "s3_uri": training_output_s3_uri,
                    "s3_data_type": "S3Prefix",
                    "s3_input_mode": "File",
                    "local_path": "/opt/ml/processing/input/adapter",
                }
            }],
            processing_output_config={
                "outputs": [{
                    "output_name": "staged-adapter",
                    "s3_output": {
                        "s3_uri": adapter_s3_uri,
                        "s3_upload_mode": "EndOfJob",
                        "local_path": "/opt/ml/processing/output",
                    }
                }]
            },
            app_specification={
                "image_uri": container_image,
                "container_entrypoint": ["bash", "-c", entrypoint_cmd],
            },
            role_arn=args.role_arn,
            stopping_condition={"max_runtime_in_seconds": MAX_RUNTIME_SECONDS},
        )
    except Exception as e:
        error_msg = str(e)
        if "AccessDeniedException" in error_msg or "AccessDenied" in error_msg:
            _error_exit(
                f"Access denied when creating Processing Job. "
                f"Ensure the role has sagemaker:CreateProcessingJob permission. "
                f"Details: {error_msg}"
            )
        elif "ResourceLimitExceeded" in error_msg:
            _error_exit(
                f"Resource limit exceeded. You may need to request a quota increase. "
                f"Details: {error_msg}"
            )
        else:
            _error_exit(f"Failed to create Processing Job: {error_msg}")

    print(f"Processing Job submitted: {job_name}", file=sys.stderr)
    print(f"Adapter output: {adapter_s3_uri}", file=sys.stderr)

    # If --no-wait, return immediately
    if args.no_wait:
        _output({
            "job_name": job_name,
            "status": "InProgress",
            "adapter_s3_uri": adapter_s3_uri,
        })

    # Poll until completion
    print(f"Polling every {POLL_INTERVAL_SECONDS}s...", file=sys.stderr)
    while True:
        try:
            job_desc = ProcessingJob.get(processing_job_name=job_name)
            status = job_desc.processing_job_status
        except Exception as e:
            print(f"Warning: failed to get job status: {e}", file=sys.stderr)
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        print(
            f"  [{time.strftime('%H:%M:%S')}] Status: {status}",
            file=sys.stderr,
        )

        if status in ("Completed", "Failed", "Stopped"):
            break

        time.sleep(POLL_INTERVAL_SECONDS)

    # Handle terminal states
    if status == "Failed":
        failure_reason = getattr(job_desc, "failure_reason", None) or "Unknown failure"
        print(f"Processing Job failed: {failure_reason}", file=sys.stderr)
        sys.exit(1)

    if status == "Stopped":
        print("Processing Job was stopped.", file=sys.stderr)
        sys.exit(1)

    # Success
    _output({
        "job_name": job_name,
        "status": "Completed",
        "adapter_s3_uri": adapter_s3_uri,
    })


# ── Subcommand: status ────────────────────────────────────────────────────────


def cmd_status(args):
    """Check Processing Job status.

    Returns: {"job_name": str, "status": str, "failure_reason": str|None}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ProcessingJob

    if not args.job_name:
        _error_exit("--job-name is required")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        job_desc = ProcessingJob.get(processing_job_name=args.job_name)
    except Exception as e:
        error_msg = str(e)
        if "does not exist" in error_msg or "ValidationException" in error_msg:
            _error_exit(f"Processing Job not found: {args.job_name}")
        else:
            _error_exit(f"Failed to get Processing Job status: {error_msg}")

    status = job_desc.processing_job_status
    failure_reason = None

    if status == "Failed":
        failure_reason = getattr(job_desc, "failure_reason", None) or "Unknown failure"
        print(f"Processing Job failed: {failure_reason}", file=sys.stderr)

    _output({
        "job_name": args.job_name,
        "status": status,
        "failure_reason": failure_reason,
    })


# ── Argument parsing ──────────────────────────────────────────────────────────


def main():
    """Parse arguments and dispatch to subcommand."""
    parser = argparse.ArgumentParser(
        description="SageMaker Processing Job helper for adapter staging",
        prog=".adapter_helper.py",
    )
    subparsers = parser.add_subparsers(dest="subcommand", help="Subcommand")

    # ── stage-from-tune ───────────────────────────────────────────────────
    stage_parser = subparsers.add_parser(
        "stage-from-tune",
        help="Submit Processing Job to stage adapter from training output",
    )
    stage_parser.add_argument(
        "--training-output-s3-uri",
        required=True,
        help="S3 URI of training output (adapter artifacts)",
    )
    stage_parser.add_argument(
        "--adapter-name",
        required=True,
        help="Name of the adapter (used in output S3 path)",
    )
    stage_parser.add_argument(
        "--bucket",
        required=True,
        help="S3 bucket for adapter output",
    )
    stage_parser.add_argument(
        "--project",
        required=True,
        help="Project name (used in S3 path prefix)",
    )
    stage_parser.add_argument(
        "--role-arn",
        required=True,
        help="SageMaker execution role ARN",
    )
    stage_parser.add_argument(
        "--region",
        default=None,
        help="AWS region (default: from environment)",
    )
    stage_parser.add_argument(
        "--container-image",
        default=None,
        help="Override container image URI (default: SageMaker PyTorch CPU image)",
    )
    stage_parser.add_argument(
        "--no-wait",
        action="store_true",
        default=False,
        help="Return immediately after submitting the job",
    )

    # ── status ────────────────────────────────────────────────────────────
    status_parser = subparsers.add_parser(
        "status",
        help="Check Processing Job status",
    )
    status_parser.add_argument(
        "--job-name",
        required=True,
        help="Processing Job name to check",
    )
    status_parser.add_argument(
        "--region",
        default=None,
        help="AWS region (default: from environment)",
    )

    # ── Parse and dispatch ────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        sys.exit(1)

    if args.subcommand == "stage-from-tune":
        cmd_stage_from_tune(args)
    elif args.subcommand == "status":
        cmd_status(args)
    else:
        _error_exit(f"Unknown subcommand: {args.subcommand}")


if __name__ == "__main__":
    main()
