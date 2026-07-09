#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Processing Job helper for model staging.

Subcommands:
    submit  - Submit a Processing Job to download model from HuggingFace → S3
    status  - Check Processing Job status
    cancel  - Cancel a running Processing Job

Uses sagemaker-core ProcessingJob resource API (SDK v3).
No SageMaker SDK v2 imports.

All output is JSON on stdout for bash consumption.
"""

import argparse
import json
import os
import sys
import time


# ── Inline dependency check ───────────────────────────────────────────────────


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
    """Verify boto3 is available (used for S3 entrypoint upload)."""
    try:
        import boto3  # noqa: F401
    except ImportError:
        _error_exit(
            "boto3 is not installed. "
            "Please install: pip install boto3"
        )


# ── Utility functions ─────────────────────────────────────────────────────────


def _error_exit(message, code=1):
    """Print error to stderr and exit."""
    print(message, file=sys.stderr)
    sys.exit(code)


def _output(data):
    """Print JSON result to stdout and exit 0."""
    print(json.dumps(data))
    sys.exit(0)


# ── Entrypoint script template ────────────────────────────────────────────────

ENTRYPOINT_SCRIPT = r"""#!/bin/bash
set -e
set -o pipefail

echo "=== MCC Model Staging Processing Job ==="
echo "Model: ${MODEL_ID}"
echo "Target: ${S3_OUTPUT_URI}"
echo ""

# Install dependencies
echo "Installing huggingface_hub and hf_transfer..."
pip install -q huggingface_hub hf_transfer 2>/dev/null || true

# Enable fast parallel downloads only if hf_transfer is available
if python3 -c "import hf_transfer" 2>/dev/null; then
    export HF_XET_HIGH_PERFORMANCE=1
else
    echo "hf_transfer not available - using standard download"
    unset HF_XET_HIGH_PERFORMANCE 2>/dev/null || true
fi

# Set HF token if provided
if [ -n "${HF_TOKEN:-}" ]; then
    echo "Using provided HuggingFace token"
fi

# Download model from HuggingFace
echo ""
echo "Downloading model: ${MODEL_ID}"

# Use 'hf' CLI if available (modern), fall back to python snapshot_download
DOWNLOAD_CMD=""
if command -v hf &>/dev/null; then
    DOWNLOAD_CMD="hf"
fi

DOWNLOAD_ARGS="${MODEL_ID} --local-dir /opt/ml/processing/model"
if [ -n "${HF_TOKEN:-}" ]; then
    DOWNLOAD_ARGS="${DOWNLOAD_ARGS} --token ${HF_TOKEN}"
fi

if [ -n "${DOWNLOAD_CMD}" ]; then
    ${DOWNLOAD_CMD} download ${DOWNLOAD_ARGS}
else
    # Fallback: use Python API directly
    python3 -c "
from huggingface_hub import snapshot_download
import os
token = os.environ.get('HF_TOKEN', None)
snapshot_download('${MODEL_ID}', local_dir='/opt/ml/processing/model', token=token)
"
fi

echo ""
echo "Download complete"

CACHE_PATH="/opt/ml/processing/model"
echo "Model path: ${CACHE_PATH}"

# Sync to S3
echo ""
echo "Syncing to S3: ${S3_OUTPUT_URI}"
aws s3 sync "${CACHE_PATH}" "${S3_OUTPUT_URI}" \
    --no-progress \
    --exclude "*.lock" \
    --exclude ".gitattributes"

echo ""
echo "Model staged successfully to: ${S3_OUTPUT_URI}"
"""


# ── Subcommand: submit ────────────────────────────────────────────────────────


def cmd_submit(args):
    """Submit a Processing Job to stage model from HuggingFace to S3.

    Returns JSON: {"job_name": str, "status": str, "s3_uri": str}
    """
    _check_sagemaker_core()
    _check_boto3()

    import boto3
    from sagemaker.core.resources import ProcessingJob

    # Validate AWS credentials
    try:
        sts = boto3.client("sts", region_name=args.region)
        sts.get_caller_identity()
    except Exception as e:
        _error_exit(
            f"AWS credentials not configured or expired: {e}\n"
            "Run: aws configure",
            code=4,
        )

    # Build S3 URI for staged model
    s3_uri = f"s3://{args.bucket}/models/{args.model_name}/"

    # Idempotency: check if model already exists at target S3 path
    if not args.force:
        s3 = boto3.client("s3", region_name=args.region)
        try:
            s3.head_object(
                Bucket=args.bucket,
                Key=f"models/{args.model_name}/config.json",
            )
            # Model already staged
            _output({
                "job_name": "",
                "status": "AlreadyStaged",
                "s3_uri": s3_uri,
            })
            return
        except s3.exceptions.ClientError:
            pass  # Not staged yet, proceed

    # Generate job name with timestamp
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    job_name = f"mlcc-stage-{args.project}-{timestamp}"
    # SageMaker job names max 63 chars, must match [a-zA-Z0-9](-*[a-zA-Z0-9])*
    job_name = job_name[:63].rstrip("-")
    # Replace invalid characters
    job_name = "".join(c if c.isalnum() or c == "-" else "-" for c in job_name)

    # Upload entrypoint script to S3
    entrypoint_s3_key = f"staging-jobs/{job_name}/entrypoint.sh"
    entrypoint_s3_uri = f"s3://{args.bucket}/{entrypoint_s3_key}"

    s3 = boto3.client("s3", region_name=args.region)
    try:
        s3.put_object(
            Bucket=args.bucket,
            Key=entrypoint_s3_key,
            Body=ENTRYPOINT_SCRIPT.encode("utf-8"),
        )
    except Exception as e:
        _error_exit(f"Failed to upload entrypoint script to S3: {e}")

    # Build environment variables for the container
    environment = {
        "MODEL_ID": args.model_name,
        "S3_OUTPUT_URI": s3_uri,
    }
    if args.hf_token:
        environment["HF_TOKEN"] = args.hf_token

    # Container image: SageMaker-managed PyTorch CPU image
    container_image = (
        f"763104351884.dkr.ecr.{args.region}.amazonaws.com/"
        "pytorch-training:2.1.0-cpu-py310-ubuntu20.04-sagemaker"
    )

    # Build the entrypoint command that downloads + executes the script from S3
    entrypoint_cmd = (
        f"aws s3 cp {entrypoint_s3_uri} /tmp/entrypoint.sh && "
        "chmod +x /tmp/entrypoint.sh && /tmp/entrypoint.sh"
    )

    # Submit Processing Job via sagemaker-core
    print(f"Submitting Processing Job: {job_name}", file=sys.stderr)
    try:
        ProcessingJob.create(
            processing_job_name=job_name,
            processing_resources={
                "cluster_config": {
                    "instance_count": 1,
                    "instance_type": args.instance_type,
                    "volume_size_in_gb": args.volume_size_gb,
                }
            },
            app_specification={
                "image_uri": container_image,
                "container_entrypoint": ["bash", "-c", entrypoint_cmd],
            },
            environment=environment,
            role_arn=args.role_arn,
            stopping_condition={"max_runtime_in_seconds": 86400},
        )
    except Exception as e:
        error_msg = str(e)
        if "AccessDeniedException" in error_msg or "AccessDenied" in error_msg:
            _error_exit(
                f"Access denied creating Processing Job. "
                f"Ensure the execution role has sagemaker:CreateProcessingJob permission.\n"
                f"Details: {error_msg}"
            )
        _error_exit(f"Failed to create Processing Job: {error_msg}")

    # If --no-wait, return immediately with job name
    if args.no_wait:
        _output({
            "job_name": job_name,
            "status": "Submitted",
            "s3_uri": s3_uri,
        })

    # Poll every 30s until terminal state
    _poll_job(job_name, s3_uri, args.region)


def _poll_job(job_name, s3_uri, region):
    """Poll Processing Job status every 30s until completion.

    On success: output JSON to stdout.
    On failure: print failure_reason to stderr, exit 1.
    """
    from sagemaker.core.resources import ProcessingJob

    print(f"Polling Processing Job status (every 30s)...", file=sys.stderr)

    while True:
        try:
            job_desc = ProcessingJob.get(processing_job_name=job_name)
        except Exception as e:
            print(f"Warning: failed to get job status (retrying): {e}", file=sys.stderr)
            time.sleep(30)
            continue

        status = job_desc.processing_job_status

        print(f"Status: {status}", file=sys.stderr)

        if status in ("Completed", "Failed", "Stopped"):
            break

        time.sleep(30)

    if status == "Failed":
        failure_reason = getattr(job_desc, "failure_reason", None) or "Unknown"
        print(f"Processing Job failed: {failure_reason}", file=sys.stderr)
        sys.exit(1)

    if status == "Stopped":
        print(f"Processing Job was stopped: {job_name}", file=sys.stderr)
        sys.exit(1)

    # Success
    _output({
        "job_name": job_name,
        "status": "Completed",
        "s3_uri": s3_uri,
    })


# ── Subcommand: status ────────────────────────────────────────────────────────


def cmd_status(args):
    """Check Processing Job status.

    Returns JSON: {"job_name": str, "status": str, "failure_reason": str|None}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ProcessingJob

    try:
        job_desc = ProcessingJob.get(processing_job_name=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to get Processing Job status: {e}")

    status = job_desc.processing_job_status
    failure_reason = getattr(job_desc, "failure_reason", None)

    _output({
        "job_name": args.job_name,
        "status": status,
        "failure_reason": failure_reason,
    })


# ── Subcommand: cancel ────────────────────────────────────────────────────────


def cmd_cancel(args):
    """Cancel a running Processing Job.

    Returns JSON: {"job_name": str, "status": str}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ProcessingJob

    try:
        job_desc = ProcessingJob.get(processing_job_name=args.job_name)
        status = job_desc.processing_job_status

        if status in ("Completed", "Failed", "Stopped"):
            _output({
                "job_name": args.job_name,
                "status": status,
                "message": f"Job already in terminal state: {status}",
            })

        job_desc.stop()
    except Exception as e:
        _error_exit(f"Failed to cancel Processing Job: {e}")

    _output({
        "job_name": args.job_name,
        "status": "Stopping",
    })


# ── CLI argument parsing ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Processing Job helper for model staging"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # submit
    submit_parser = subparsers.add_parser("submit", help="Submit a Processing Job")
    submit_parser.add_argument("--model-name", required=True, help="HuggingFace model ID")
    submit_parser.add_argument("--bucket", required=True, help="S3 bucket for staging")
    submit_parser.add_argument("--project", required=True, help="Project name")
    submit_parser.add_argument("--role-arn", required=True, help="IAM execution role ARN")
    submit_parser.add_argument("--region", required=True, help="AWS region")
    submit_parser.add_argument("--hf-token", default="", help="HuggingFace token (for gated models)")
    submit_parser.add_argument("--instance-type", default="ml.m5.xlarge", help="Instance type")
    submit_parser.add_argument("--volume-size-gb", type=int, default=2048, help="Volume size in GB")
    submit_parser.add_argument("--no-wait", action="store_true", help="Return immediately without polling")
    submit_parser.add_argument("--force", action="store_true", help="Re-stage even if already present")
    submit_parser.set_defaults(func=cmd_submit)

    # status
    status_parser = subparsers.add_parser("status", help="Check Processing Job status")
    status_parser.add_argument("--job-name", required=True, help="Processing Job name")
    status_parser.add_argument("--region", default=None, help="AWS region")
    status_parser.set_defaults(func=cmd_status)

    # cancel
    cancel_parser = subparsers.add_parser("cancel", help="Cancel a Processing Job")
    cancel_parser.add_argument("--job-name", required=True, help="Processing Job name")
    cancel_parser.add_argument("--region", default=None, help="AWS region")
    cancel_parser.set_defaults(func=cmd_cancel)

    args = parser.parse_args()

    # Set region in environment if provided (sagemaker-core uses env vars)
    region = getattr(args, "region", None)
    if region:
        os.environ.setdefault("AWS_DEFAULT_REGION", region)
        os.environ.setdefault("AWS_REGION", region)

    args.func(args)


if __name__ == "__main__":
    main()
