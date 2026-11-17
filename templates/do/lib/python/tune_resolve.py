from __future__ import annotations
"""Tune resolve: resolve artifact paths and registry lookups.

Purpose: cmd_resolve subcommand + registry resolution helpers for do/tune
Inputs: --job-name, --region, --training-type, --model-package-group
Outputs: JSON with artifact_path, model_package_arn, output_type
Caller: .tune_helper.py dispatcher, tune_submit.py
Related: register_resolve.py (dataset/evaluator registry)
"""

import json
import os
import sys

from common import _output, _error_exit
from tune_status import _sanitize_for_json


def _resolve_dataset_name(dataset_name):
    """Resolve a registered dataset name to S3 URI (or ARN) via .register_helper.py.

    Calls the resolve-dataset subcommand of .register_helper.py and returns
    the resolved value. If the response contains an 'arn' field (Backlog #023,
    AI Registry mode), returns the ARN for use with SFTTrainer(training_dataset=arn).
    Otherwise returns the S3 URI for backward compatibility.
    """
    import subprocess

    script_dir = os.path.dirname(os.path.abspath(__file__))
    # .register_helper.py is in templates/do/ (two levels up from lib/python/)
    helper_path = os.path.join(script_dir, '..', '..', '.register_helper.py')

    if not os.path.exists(helper_path):
        _error_exit(
            f"Cannot resolve dataset '{dataset_name}': .register_helper.py not found. "
            f"Register datasets first with: ./do/register --dataset"
        )

    # BL163: scope the resolve to the active project's MLflow experiment by
    # forwarding PROJECT_NAME when it is in the environment (do/config exports
    # it). The resolver also falls back to the PROJECT_NAME env var itself, so
    # this is belt-and-suspenders; an unset name degrades to the read-both
    # (active + "0") default.
    _resolve_cmd = ["python3", helper_path, "resolve-dataset", "--name", dataset_name]
    _project_name = os.environ.get("PROJECT_NAME", "").strip()
    if _project_name:
        _resolve_cmd += ["--project-name", _project_name]

    try:
        result = subprocess.run(
            _resolve_cmd,
            capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired:
        _error_exit(f"Timeout resolving dataset '{dataset_name}' from registry")
    except Exception as e:
        _error_exit(f"Failed to resolve dataset '{dataset_name}': {e}")

    if result.returncode != 0:
        _error_exit(
            f"Dataset '{dataset_name}' not found in registry. "
            f"Register it first: ./do/register --dataset --dataset-name {dataset_name} --dataset-s3-uri s3://..."
        )

    # Parse JSON output from resolve-dataset
    try:
        output = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, ValueError):
        _error_exit(
            f"Failed to parse registry response for dataset '{dataset_name}'. "
            f"Raw output: {result.stdout[:200]}"
        )

    if "error" in output:
        _error_exit(
            f"Dataset '{dataset_name}' not found in registry: {output['error']}. "
            f"Register it first: ./do/register --dataset --dataset-name {dataset_name} --dataset-s3-uri s3://..."
        )

    # BL120/BL100: benchmark datasets use the AIPerf BYOD single_turn schema
    # (`text` column) and are meant for do/benchmark, not fine-tuning. Reject
    # them here with a clear error.
    if output.get("technique") == "benchmark":
        _error_exit(
            "This dataset was registered for benchmarking, not fine-tuning. "
            "Use do/benchmark instead."
        )

    # Prefer ARN if available (Backlog #023 — AI Registry mode)
    # When arn is present, use it directly with SFTTrainer(training_dataset=arn)
    arn = output.get("arn")
    if arn:
        return arn

    # Fallback: use S3 URI
    s3_uri = output.get("s3_uri", "")
    if not s3_uri:
        _error_exit(
            f"Dataset '{dataset_name}' resolved but has no S3 URI or ARN. "
            f"Re-register with: ./do/register --dataset --dataset-name {dataset_name} --dataset-s3-uri s3://..."
        )

    return s3_uri


def _resolve_evaluator_name(evaluator_name):
    """Resolve a registered evaluator name to its type, source reference and ARN.

    BL117: evaluators are native sagemaker.ai_registry assets. Returns
    ``(evaluator_type, reference, arn)`` where ``evaluator_type`` is
    ``"reward_function"`` (RLVR/MTRL — register with ``do/register evaluator``) or
    ``"reward_prompt"`` (RLAIF — register with ``do/register prompt``),
    ``reference`` is the Lambda ARN or S3 prompt URI the native asset points at,
    and ``arn`` is the hub-content evaluator ARN. RLAIF ``reward_prompt`` needs
    the hub-content ARN (the SDK validates it against
    ^arn:aws:sagemaker:...:hub-content/<hub>/JsonDoc/<name>/<ver>$ and takes the
    ARN branch); the S3 ``reference`` fails that validation.
    """
    import subprocess

    script_dir = os.path.dirname(os.path.abspath(__file__))
    helper_path = os.path.join(script_dir, '..', '..', '.register_helper.py')

    if not os.path.exists(helper_path):
        _error_exit(
            f"Cannot resolve evaluator '{evaluator_name}': .register_helper.py not found. "
            f"Register a reward function with `./do/register evaluator` or a reward "
            f"prompt with `./do/register prompt`."
        )

    try:
        result = subprocess.run(
            ["python3", helper_path, "resolve-evaluator", "--name", evaluator_name],
            capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired:
        _error_exit(f"Timeout resolving evaluator '{evaluator_name}' from registry")
    except Exception as e:
        _error_exit(f"Failed to resolve evaluator '{evaluator_name}': {e}")

    if result.returncode != 0:
        _error_exit(
            f"Evaluator '{evaluator_name}' not found. Register a reward function with "
            f"`./do/register evaluator {evaluator_name} --arn <lambda-arn>` (RLVR/MTRL) "
            f"or a reward prompt with `./do/register prompt {evaluator_name} "
            f"--prompt <s3-uri>` (RLAIF)."
        )

    # Parse JSON output from resolve-evaluator
    try:
        output = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, ValueError):
        _error_exit(
            f"Failed to parse registry response for evaluator '{evaluator_name}'. "
            f"Raw output: {result.stdout[:200]}"
        )

    if "error" in output:
        _error_exit(
            f"Evaluator '{evaluator_name}' not found: {output['error']}. Register a "
            f"reward function with `./do/register evaluator` or a reward prompt with "
            f"`./do/register prompt`."
        )

    ev_type = output.get("type", "")
    # Native resolve returns `reference`; tolerate the legacy `arn_or_uri` field.
    reference = output.get("reference") or output.get("arn_or_uri") or ""
    arn = output.get("arn") or ""

    if not reference and not arn:
        _error_exit(
            f"Evaluator '{evaluator_name}' resolved but has no source reference. "
            f"Re-register it with `./do/register evaluator` or `./do/register prompt`."
        )

    return ev_type, reference, arn


def cmd_resolve(args):
    """Resolve artifact path within S3 output directory.

    Uses sagemaker-core TrainingJob.get() to read model_artifacts and
    output_data_config. Uses ModelPackage for model package lookup.

    Returns: {"artifact_path": str, "model_package_arn": str|None,
              "output_type": str}
    """
    # Set region before any sagemaker import (creates boto3 clients at import time)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    from sagemaker.core.resources import TrainingJob

    try:
        job = TrainingJob.get(training_job_name=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to describe training job: {e}")

    status = getattr(job, "training_job_status", None)
    if status != "Completed":
        _error_exit(
            f"Cannot resolve artifacts for job in status: {status}. "
            f"Job must be Completed."
        )

    # Get the S3 model artifacts path from TrainingJob resource
    model_artifacts = getattr(job, "model_artifacts", None)
    artifact_path = ""
    if model_artifacts:
        artifact_path = getattr(model_artifacts, "s3_model_artifacts", "") or ""

    if not artifact_path:
        _error_exit("No model artifacts found in training job output.")

    # Determine output type from training type
    output_type = "adapter" if args.training_type == "lora" else "full-model"

    # For LoRA adapters, the actual adapter files are in checkpoints/hf/ subdirectory
    # The S3ModelArtifacts path points to the top-level output directory
    if output_type == "adapter":
        # Ensure trailing slash for directory path
        if not artifact_path.endswith("/"):
            artifact_path += "/"
        artifact_path += "checkpoints/hf/"

    # Try to find model package ARN if a model package group was used
    model_package_arn = None
    if args.model_package_group:
        try:
            # Use boto3 for list_model_packages since sagemaker-core ModelPackage
            # doesn't have a direct list-by-group method with sort/limit
            import boto3
            mp_client = boto3.client("sagemaker", region_name=args.region)
            packages = mp_client.list_model_packages(
                ModelPackageGroupName=args.model_package_group,
                SortBy="CreationTime",
                SortOrder="Descending",
                MaxResults=1,
            )
            package_list = packages.get("ModelPackageSummaryList", [])
            if package_list:
                model_package_arn = package_list[0].get("ModelPackageArn")
        except Exception:
            # Model package lookup is best-effort
            pass

    _output({
        "artifact_path": _sanitize_for_json(artifact_path),
        "model_package_arn": _sanitize_for_json(model_package_arn),
        "output_type": output_type,
    })
