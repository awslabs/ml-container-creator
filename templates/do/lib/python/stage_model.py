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

# Install dependencies.
# IMPORTANT: do NOT upgrade huggingface_hub. The DLC ships a working copy, and
# reinstalling/upgrading it has pulled an httpx2-based build whose streaming
# decoder is incompatible with the image's compression extension, crashing the
# download with "TypeError: process() takes no keyword arguments". So install
# huggingface_hub ONLY if it is genuinely missing (never upgrade the baked-in
# version), and add hf_transfer only if absent.
echo "Ensuring huggingface_hub + hf_transfer are available (no upgrade)..."
python3 -c "import huggingface_hub" 2>/dev/null || pip install -q huggingface_hub 2>/dev/null || true
python3 -c "import hf_transfer" 2>/dev/null || pip install -q hf_transfer 2>/dev/null || true

# Enable fast parallel downloads only if hf_transfer is importable.
if python3 -c "import hf_transfer" 2>/dev/null; then
    export HF_XET_HIGH_PERFORMANCE=1
    export HF_HUB_ENABLE_HF_TRANSFER=1
else
    echo "hf_transfer not available - using standard download"
fi

# Set HF token if provided — export explicitly for all child processes
# and persist to token cache so xet transfer and all download paths use it
if [ -n "${HF_TOKEN:-}" ]; then
    echo "Using provided HuggingFace token"
    export HF_TOKEN
    # Write token directly to huggingface cache (most reliable across all library versions)
    mkdir -p ~/.cache/huggingface
    echo -n "${HF_TOKEN}" > ~/.cache/huggingface/token
fi

# Download model from HuggingFace
echo ""
echo "Downloading model: ${MODEL_ID}"

# Download via the Python API.
#
# ROOT CAUSE (observed in the DLC image): huggingface_hub v2.x switched its HTTP
# backend to `httpx2`, whose streaming response decoder calls the compression
# object's `.process(data, output_buffer_limit=...)` with a keyword argument the
# image's (older) brotli/zstd extension does not accept — crashing EVERY download
# with "TypeError: process() takes no keyword arguments". This is on the normal
# streaming path, not the fast/xet path, so toggling hf_transfer does not help.
#
# FIX: make the Hub send an UNCOMPRESSED response body (Accept-Encoding: identity)
# so the broken decompressor is never invoked. We install a client factory that
# forces that header (the huggingface_hub v2 extension point), falling back to a
# session-header hook on v1.x; if neither hook is present the download still runs.
python3 - <<'PYEOF'
import os
from huggingface_hub import snapshot_download

model_id = os.environ["MODEL_ID"]
token = os.environ.get("HF_TOKEN") or None
local_dir = "/opt/ml/processing/model"

# Force uncompressed responses to dodge the httpx2 decoder incompatibility.
_forced = False
try:
    # huggingface_hub v2.x: install a client whose default headers disable
    # response compression (see the v2 migration guide / set_client_factory).
    from huggingface_hub.utils import httpx as _hf_httpx  # noqa: F401
    from huggingface_hub.utils import set_client_factory

    def _client_factory(**kwargs):
        headers = dict(kwargs.pop("headers", {}) or {})
        headers["Accept-Encoding"] = "identity"
        return _hf_httpx.Client(headers=headers, **kwargs)

    set_client_factory(_client_factory)
    _forced = True
    print("Forcing Accept-Encoding: identity via huggingface_hub v2 client factory.")
except Exception as e:
    print(f"v2 client factory unavailable ({type(e).__name__}); trying v1 session hook.")

if not _forced:
    try:
        # huggingface_hub v1.x (requests-based): add the header to the shared session.
        from huggingface_hub.utils import _http as _hf_http
        _orig_get_session = _hf_http.get_session

        def _patched_get_session():
            s = _orig_get_session()
            s.headers["Accept-Encoding"] = "identity"
            return s

        _hf_http.get_session = _patched_get_session
        _forced = True
        print("Forcing Accept-Encoding: identity via huggingface_hub v1 session hook.")
    except Exception as e:
        print(f"v1 session hook unavailable ({type(e).__name__}); proceeding without override.")

snapshot_download(model_id, local_dir=local_dir, token=token)
PYEOF

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
