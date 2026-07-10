from __future__ import annotations
"""Stage model: submit Processing Job to download model from HuggingFace to S3.

Purpose: cmd_submit, cmd_status, cmd_cancel subcommands for do/stage
Inputs: --model-name, --bucket, --project, --role-arn, --region, etc.
Outputs: JSON with job_name, status, s3_uri
Caller: .stage_helper.py dispatcher
Related: stage_adapter.py (adapter staging variant)
"""

import json
import os
import sys
import time

from common import _output, _error_exit, _check_sagemaker_core, _check_boto3


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
    """Submit a Processing Job to stage model from HuggingFace to S3."""
    _check_sagemaker_core()
    _check_boto3()

    import boto3
    from sagemaker.core.resources import ProcessingJob

    try:
        sts = boto3.client("sts", region_name=args.region)
        sts.get_caller_identity()
    except Exception as e:
        _error_exit(
            f"AWS credentials not configured or expired: {e}\n"
            "Run: aws configure",
            exit_code=4,
        )

    s3_uri = f"s3://{args.bucket}/models/{args.model_name}/"

    if not args.force:
        s3 = boto3.client("s3", region_name=args.region)
        try:
            s3.head_object(Bucket=args.bucket, Key=f"models/{args.model_name}/config.json")
            _output({"job_name": "", "status": "AlreadyStaged", "s3_uri": s3_uri})
            return
        except s3.exceptions.ClientError:
            pass

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    job_name = f"mlcc-stage-{args.project}-{timestamp}"
    job_name = job_name[:63].rstrip("-")
    job_name = "".join(c if c.isalnum() or c == "-" else "-" for c in job_name)

    entrypoint_s3_key = f"staging-jobs/{job_name}/entrypoint.sh"
    entrypoint_s3_uri = f"s3://{args.bucket}/{entrypoint_s3_key}"

    s3 = boto3.client("s3", region_name=args.region)
    try:
        s3.put_object(Bucket=args.bucket, Key=entrypoint_s3_key, Body=ENTRYPOINT_SCRIPT.encode("utf-8"))
    except Exception as e:
        _error_exit(f"Failed to upload entrypoint script to S3: {e}")

    environment = {"MODEL_ID": args.model_name, "S3_OUTPUT_URI": s3_uri}
    if args.hf_token:
        environment["HF_TOKEN"] = args.hf_token

    container_image = (
        f"763104351884.dkr.ecr.{args.region}.amazonaws.com/"
        "pytorch-training:2.1.0-cpu-py310-ubuntu20.04-sagemaker"
    )

    entrypoint_cmd = (
        f"aws s3 cp {entrypoint_s3_uri} /tmp/entrypoint.sh && "
        "chmod +x /tmp/entrypoint.sh && /tmp/entrypoint.sh"
    )

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

    if args.no_wait:
        _output({"job_name": job_name, "status": "Submitted", "s3_uri": s3_uri})

    _poll_job(job_name, s3_uri, args.region)


def _poll_job(job_name, s3_uri, region):
    """Poll Processing Job status every 30s until completion."""
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

    _output({"job_name": job_name, "status": "Completed", "s3_uri": s3_uri})


# ── Subcommand: status ────────────────────────────────────────────────────────


def cmd_status(args):
    """Check Processing Job status."""
    _check_sagemaker_core()

    from sagemaker.core.resources import ProcessingJob

    try:
        job_desc = ProcessingJob.get(processing_job_name=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to get Processing Job status: {e}")

    status = job_desc.processing_job_status
    failure_reason = getattr(job_desc, "failure_reason", None)

    _output({"job_name": args.job_name, "status": status, "failure_reason": failure_reason})


# ── Subcommand: cancel ────────────────────────────────────────────────────────


def cmd_cancel(args):
    """Cancel a running Processing Job."""
    _check_sagemaker_core()

    from sagemaker.core.resources import ProcessingJob

    try:
        job_desc = ProcessingJob.get(processing_job_name=args.job_name)
        status = job_desc.processing_job_status

        if status in ("Completed", "Failed", "Stopped"):
            _output({"job_name": args.job_name, "status": status, "message": f"Job already in terminal state: {status}"})

        job_desc.stop()
    except Exception as e:
        _error_exit(f"Failed to cancel Processing Job: {e}")

    _output({"job_name": args.job_name, "status": "Stopping"})
