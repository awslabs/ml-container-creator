#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Managed Model Customization helper.

Subcommands:
    submit   - Submit a new customization job
    status   - Get job status and metrics
    resolve  - Resolve output artifact path from job
    stage-hf - Download HF dataset to S3
    validate - Validate dataset format against schema

All output is JSON on stdout for bash consumption.
"""

import argparse
import json
import os
import sys
import time

# ── Inline dependency check ───────────────────────────────────────────────────
MIN_SAGEMAKER_VERSION = "2.232.0"


def _check_sagemaker_sdk():
    """Verify sagemaker SDK is installed with minimum version."""
    try:
        import sagemaker  # noqa: F401
        from packaging.version import Version
        if Version(sagemaker.__version__) < Version(MIN_SAGEMAKER_VERSION):
            _error_exit(
                f"sagemaker SDK version {sagemaker.__version__} is below minimum "
                f"required version {MIN_SAGEMAKER_VERSION}. "
                f"Please upgrade: pip install 'sagemaker>={MIN_SAGEMAKER_VERSION}'"
            )
    except ImportError:
        _error_exit(
            f"sagemaker Python SDK is not installed. "
            f"Please install: pip install 'sagemaker>={MIN_SAGEMAKER_VERSION}'"
        )


# ── Utility functions ─────────────────────────────────────────────────────────


def _error_exit(message):
    """Print JSON error to stdout and exit with code 1."""
    print(json.dumps({"error": message}))
    sys.exit(1)


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


# ── Subcommand: submit ────────────────────────────────────────────────────────


def cmd_submit(args):
    """Submit customization job via SFTTrainer/DPOTrainer.

    Returns: {"job_name": str, "job_arn": str, "mlflow_url": str|None}
    """
    _check_sagemaker_sdk()

    from sagemaker.modules.train.sft_trainer import SFTTrainer
    from sagemaker.modules.train.dpo_trainer import DPOTrainer
    from sagemaker.modules.train.common import TrainingType

    # Technique → Trainer class mapping
    TRAINER_MAP = {
        "sft": SFTTrainer,
        "dpo": DPOTrainer,
        # RLAIF and RLVR use SFTTrainer with evaluator config
        "rlaif": SFTTrainer,
        "rlvr": SFTTrainer,
    }

    technique = args.technique
    trainer_cls = TRAINER_MAP.get(technique)
    if not trainer_cls:
        _error_exit(f"Unsupported technique: {technique}")

    # Resolve training type
    training_type_map = {
        "lora": TrainingType.LORA,
        "full-rank": TrainingType.FULL_RANK,
    }
    training_type = training_type_map.get(args.training_type)
    if not training_type:
        _error_exit(f"Unsupported training type: {args.training_type}")

    # Build hyperparameters dict from optional overrides
    hyperparameters = {}
    if args.epochs is not None:
        hyperparameters["epochs"] = args.epochs
    if args.learning_rate is not None:
        hyperparameters["learning_rate"] = args.learning_rate
    if args.max_seq_length is not None:
        hyperparameters["max_seq_length"] = args.max_seq_length
    if args.lora_rank is not None:
        hyperparameters["lora_rank"] = args.lora_rank
    if args.lora_alpha is not None:
        hyperparameters["lora_alpha"] = args.lora_alpha
    if args.batch_size is not None:
        hyperparameters["batch_size"] = args.batch_size

    # Build trainer kwargs
    trainer_kwargs = {
        "model_id": args.model_id,
        "training_type": training_type,
        "train_data_uri": args.dataset_s3_uri,
        "output_path": f"s3://{args.output_bucket}/{args.project_name}/tune/{technique}/",
        "role": args.role_arn,
        "job_name": args.job_name,
    }

    # Add model package group for artifact registration
    if args.model_package_group:
        trainer_kwargs["model_package_group_name"] = args.model_package_group

    # Add hyperparameters if any were specified
    if hyperparameters:
        trainer_kwargs["hyperparameters"] = hyperparameters

    # Add evaluator config for RLVR/RLAIF techniques
    if technique in ("rlvr", "rlaif"):
        if args.reward_function:
            trainer_kwargs["evaluator_config"] = {
                "reward_function_arn": args.reward_function
            }
        elif args.reward_prompt:
            trainer_kwargs["evaluator_config"] = {
                "reward_prompt_s3_uri": args.reward_prompt
            }

    try:
        trainer = trainer_cls(**trainer_kwargs)
        trainer.train(wait=False)

        # Extract job info from the trainer
        job_name = trainer.training_job_name
        job_arn = getattr(trainer, "training_job_arn", None)

        # Attempt to get MLflow URL if available
        mlflow_url = None
        try:
            mlflow_url = getattr(trainer, "mlflow_tracking_uri", None)
        except Exception:
            pass

        _output({
            "job_name": job_name,
            "job_arn": job_arn or "",
            "mlflow_url": mlflow_url,
            "model_package_group": args.model_package_group or "",
        })

    except Exception as e:
        error_msg = str(e)
        # Provide helpful context for common errors
        if "AccessDeniedException" in error_msg or "AccessDenied" in error_msg:
            _error_exit(
                f"Access denied when submitting training job. "
                f"Ensure the role has sagemaker:CreateTrainingJob permission. "
                f"Details: {error_msg}"
            )
        elif "ResourceLimitExceeded" in error_msg:
            _error_exit(
                f"Resource limit exceeded. You may need to request a quota increase. "
                f"Details: {error_msg}"
            )
        elif "ValidationException" in error_msg and "license" in error_msg.lower():
            _error_exit(
                f"Model license not accepted. Accept the model license before "
                f"using this model for customization. Details: {error_msg}"
            )
        else:
            _error_exit(f"Failed to submit training job: {error_msg}")


# ── Subcommand: status ────────────────────────────────────────────────────────


def cmd_status(args):
    """Query job status via DescribeTrainingJob.

    Returns: {"status": str, "failure_reason": str|None,
              "metrics": dict|None, "elapsed_seconds": int}
    """
    import boto3

    client = boto3.client("sagemaker", region_name=args.region)

    try:
        response = client.describe_training_job(TrainingJobName=args.job_name)
    except client.exceptions.ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "ValidationException":
            _error_exit(f"Training job not found: {args.job_name}")
        _error_exit(f"Failed to describe training job: {e}")
    except Exception as e:
        _error_exit(f"Failed to describe training job: {e}")

    status = response.get("TrainingJobStatus", "Unknown")
    failure_reason = response.get("FailureReason")

    # Calculate elapsed time
    start_time = response.get("TrainingStartTime")
    end_time = response.get("TrainingEndTime")
    elapsed_seconds = 0

    if start_time:
        end = end_time if end_time else time.time()
        if hasattr(end, "timestamp"):
            end = end.timestamp()
        elapsed_seconds = int(end - start_time.timestamp())

    # Extract final metrics if available
    metrics = None
    final_metrics = response.get("FinalMetricDataList")
    if final_metrics:
        metrics = {}
        for metric in final_metrics:
            metrics[metric["MetricName"]] = metric["Value"]

    # Get output path if completed
    output_path = None
    if status == "Completed":
        model_artifacts = response.get("ModelArtifacts", {})
        output_path = model_artifacts.get("S3ModelArtifacts")

    _output({
        "status": status,
        "failure_reason": failure_reason,
        "metrics": metrics,
        "elapsed_seconds": elapsed_seconds,
        "output_path": output_path,
    })


# ── Subcommand: resolve ───────────────────────────────────────────────────────


def cmd_resolve(args):
    """Resolve artifact path within S3 output directory.

    Returns: {"artifact_path": str, "model_package_arn": str|None,
              "output_type": str}
    """
    import boto3

    client = boto3.client("sagemaker", region_name=args.region)

    try:
        response = client.describe_training_job(TrainingJobName=args.job_name)
    except Exception as e:
        _error_exit(f"Failed to describe training job: {e}")

    status = response.get("TrainingJobStatus")
    if status != "Completed":
        _error_exit(
            f"Cannot resolve artifacts for job in status: {status}. "
            f"Job must be Completed."
        )

    # Get the S3 model artifacts path
    model_artifacts = response.get("ModelArtifacts", {})
    artifact_path = model_artifacts.get("S3ModelArtifacts", "")

    if not artifact_path:
        _error_exit("No model artifacts found in training job output.")

    # Determine output type from training type
    output_type = "adapter" if args.training_type == "lora" else "full-model"

    # Try to find model package ARN if a model package group was used
    model_package_arn = None
    if args.model_package_group:
        try:
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
        "artifact_path": artifact_path,
        "model_package_arn": model_package_arn,
        "output_type": output_type,
    })


# ── Subcommand: stage-hf ─────────────────────────────────────────────────────


def cmd_stage_hf(args):
    """Download HF dataset to S3 using huggingface_hub.

    Handles auth via Secrets Manager or HF_TOKEN env var.

    Returns: {"s3_uri": str, "num_records": int}
    """
    try:
        from huggingface_hub import hf_hub_download, HfApi
    except ImportError:
        _error_exit(
            "huggingface_hub is not installed. "
            "Please install: pip install huggingface_hub"
        )

    import boto3
    import tempfile

    # Resolve HF token: Secrets Manager first, then env var
    hf_token = _resolve_hf_token(args.region, args.hf_secret_name)

    # Parse the HF reference
    org = args.hf_org
    name = args.hf_name
    split = args.hf_split or "train"
    dataset_id = f"{org}/{name}"

    # Download dataset files to a temp directory
    try:
        api = HfApi(token=hf_token)

        # List files in the dataset repo
        repo_files = api.list_repo_files(
            repo_id=dataset_id,
            repo_type="dataset",
            token=hf_token,
        )

        # Find the appropriate data file for the split
        data_files = _find_data_files(repo_files, split)
        if not data_files:
            _error_exit(
                f"No data files found for split '{split}' in dataset {dataset_id}. "
                f"Available files: {', '.join(repo_files[:20])}"
            )

        # Download and upload to S3
        s3_client = boto3.client("s3", region_name=args.region)
        s3_prefix = f"{args.project_name}/datasets/{org}/{name}/{split}"
        num_records = 0

        with tempfile.TemporaryDirectory() as tmpdir:
            for data_file in data_files:
                local_path = hf_hub_download(
                    repo_id=dataset_id,
                    filename=data_file,
                    repo_type="dataset",
                    token=hf_token,
                    local_dir=tmpdir,
                )

                # Count records (lines for JSONL)
                with open(local_path, "r") as f:
                    for line in f:
                        if line.strip():
                            num_records += 1

                # Upload to S3
                s3_key = f"{s3_prefix}/{os.path.basename(data_file)}"
                s3_client.upload_file(local_path, args.output_bucket, s3_key)

        s3_uri = f"s3://{args.output_bucket}/{s3_prefix}/{os.path.basename(data_files[0])}"

        _output({
            "s3_uri": s3_uri,
            "num_records": num_records,
        })

    except Exception as e:
        error_msg = str(e)
        if "404" in error_msg or "not found" in error_msg.lower():
            _error_exit(
                f"Dataset not found: {dataset_id}. "
                f"Check the dataset name and ensure it exists on Hugging Face Hub."
            )
        elif "401" in error_msg or "unauthorized" in error_msg.lower():
            _error_exit(
                f"Authentication failed for dataset {dataset_id}. "
                f"Ensure HF_TOKEN is set or configured via Secrets Manager."
            )
        else:
            _error_exit(f"Failed to stage HF dataset: {error_msg}")


def _resolve_hf_token(region, secret_name=None):
    """Resolve HF token from Secrets Manager or environment variable.

    Args:
        region: AWS region for Secrets Manager
        secret_name: Optional Secrets Manager secret name/ARN

    Returns:
        str or None: The HF token, or None if not available
    """
    # Try Secrets Manager first if a secret name is provided
    if secret_name:
        try:
            import boto3
            client = boto3.client("secretsmanager", region_name=region)
            response = client.get_secret_value(SecretId=secret_name)
            secret_value = response.get("SecretString", "")
            if secret_value:
                return secret_value.strip()
        except Exception:
            # Fall through to env var
            pass

    # Fall back to HF_TOKEN environment variable
    return os.environ.get("HF_TOKEN")


def _find_data_files(repo_files, split):
    """Find data files matching the requested split.

    Looks for common patterns: data/{split}.jsonl, {split}.jsonl,
    data/{split}-*.parquet, etc.

    Args:
        repo_files: List of file paths in the repo
        split: The dataset split name (e.g., "train")

    Returns:
        list: Matching file paths
    """
    # Priority order for file matching
    patterns = [
        f"data/{split}.jsonl",
        f"{split}.jsonl",
        f"data/{split}.json",
        f"{split}.json",
        f"data/{split}-00000-of-",
        f"{split}-00000-of-",
    ]

    # Exact match first
    for pattern in patterns[:4]:
        if pattern in repo_files:
            return [pattern]

    # Prefix match for sharded files
    matches = []
    for f in repo_files:
        for pattern in patterns[4:]:
            if pattern in f:
                matches.append(f)

    if matches:
        return sorted(matches)

    # Fallback: any JSONL file containing the split name
    jsonl_files = [f for f in repo_files if f.endswith(".jsonl") and split in f]
    if jsonl_files:
        return sorted(jsonl_files)

    # Last resort: any JSONL file in data/ directory
    data_jsonl = [f for f in repo_files if f.startswith("data/") and f.endswith(".jsonl")]
    if data_jsonl:
        return sorted(data_jsonl)

    return []


# ── Subcommand: validate ──────────────────────────────────────────────────────


def cmd_validate(args):
    """Validate dataset format against expected schema.

    The schema is passed as a JSON string argument.

    Returns: {"valid": bool, "error": str|None, "line_number": int|None,
              "malformed_line": str|None}
    """
    # Parse the schema from JSON argument
    try:
        schema = json.loads(args.schema)
    except json.JSONDecodeError as e:
        _error_exit(f"Invalid schema JSON: {e}")

    required_keys = schema.get("required", [])
    type_map = schema.get("types", {})

    # Read lines from stdin or file
    lines = []
    if args.file and args.file != "-":
        try:
            with open(args.file, "r") as f:
                for i, line in enumerate(f):
                    lines.append(line.rstrip("\n"))
                    if i >= 9:  # Only inspect first 10 lines
                        break
        except FileNotFoundError:
            _error_exit(f"Dataset file not found: {args.file}")
        except Exception as e:
            _error_exit(f"Failed to read dataset file: {e}")
    else:
        # Read from stdin
        for i, line in enumerate(sys.stdin):
            lines.append(line.rstrip("\n"))
            if i >= 9:  # Only inspect first 10 lines
                break

    # Validate each line
    for i, line in enumerate(lines):
        line_number = i + 1

        # Skip empty lines
        if not line or not line.strip():
            continue

        # Try to parse as JSON
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as e:
            _output({
                "valid": False,
                "error": f"Line {line_number} is not valid JSON: {e}",
                "line_number": line_number,
                "malformed_line": line,
                "expected_format": _build_expected_format(schema),
            })
            return

        # Check that parsed value is a dict
        if not isinstance(parsed, dict):
            _output({
                "valid": False,
                "error": f"Line {line_number} must be a JSON object.",
                "line_number": line_number,
                "malformed_line": line,
                "expected_format": _build_expected_format(schema),
            })
            return

        # Check required keys
        for key in required_keys:
            if key not in parsed:
                _output({
                    "valid": False,
                    "error": f'Line {line_number} is missing required key "{key}".',
                    "line_number": line_number,
                    "malformed_line": line,
                    "expected_format": _build_expected_format(schema),
                })
                return

        # Check types if specified
        for key, expected_type in type_map.items():
            if key not in parsed:
                continue

            value = parsed[key]
            if not _check_type(value, expected_type):
                actual_type = _get_type(value)
                _output({
                    "valid": False,
                    "error": (
                        f'Line {line_number} has key "{key}" with wrong type. '
                        f'Expected "{expected_type}", got "{actual_type}".'
                    ),
                    "line_number": line_number,
                    "malformed_line": line,
                    "expected_format": _build_expected_format(schema),
                })
                return

    _output({
        "valid": True,
        "error": None,
        "line_number": None,
        "malformed_line": None,
    })


def _check_type(value, expected_type):
    """Check if a value matches the expected schema type.

    Args:
        value: The value to check
        expected_type: One of "string", "array", "object", "number"

    Returns:
        bool: True if the value matches the expected type
    """
    if expected_type == "string":
        return isinstance(value, str)
    elif expected_type == "number":
        return isinstance(value, (int, float))
    elif expected_type == "array":
        return isinstance(value, list)
    elif expected_type == "object":
        return isinstance(value, dict)
    return True


def _get_type(value):
    """Get a human-readable type name for a value."""
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _build_expected_format(schema):
    """Build a human-readable expected format description from a schema.

    Args:
        schema: The dataset schema dict

    Returns:
        str: Description of expected format
    """
    required = schema.get("required", [])
    types = schema.get("types", {})

    fields = []
    for key in required:
        field_type = types.get(key, "any")
        fields.append(f'"{key}": <{field_type}>')

    return "Each line must be a JSON object with: {" + ", ".join(fields) + "}"


# ── CLI argument parsing ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Managed Model Customization helper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand to run")

    # ── submit ────────────────────────────────────────────────────────────────
    submit_parser = subparsers.add_parser("submit", help="Submit a customization job")
    submit_parser.add_argument("--model-id", required=True, help="Model ID")
    submit_parser.add_argument("--technique", required=True,
                               choices=["sft", "dpo", "rlaif", "rlvr"],
                               help="Customization technique")
    submit_parser.add_argument("--training-type", required=True,
                               choices=["lora", "full-rank"],
                               help="Training type (lora or full-rank)")
    submit_parser.add_argument("--dataset-s3-uri", required=True,
                               help="S3 URI of the training dataset")
    submit_parser.add_argument("--output-bucket", required=True,
                               help="S3 bucket for output artifacts")
    submit_parser.add_argument("--role-arn", required=True,
                               help="IAM execution role ARN")
    submit_parser.add_argument("--job-name", required=True,
                               help="Unique job name")
    submit_parser.add_argument("--project-name", required=True,
                               help="Project name for S3 path prefix")
    submit_parser.add_argument("--model-package-group", default=None,
                               help="Model package group name for registration")
    submit_parser.add_argument("--epochs", type=int, default=None,
                               help="Number of training epochs")
    submit_parser.add_argument("--learning-rate", type=float, default=None,
                               help="Learning rate")
    submit_parser.add_argument("--max-seq-length", type=int, default=None,
                               help="Maximum sequence length")
    submit_parser.add_argument("--lora-rank", type=int, default=None,
                               help="LoRA rank")
    submit_parser.add_argument("--lora-alpha", type=int, default=None,
                               help="LoRA alpha scaling factor")
    submit_parser.add_argument("--batch-size", type=int, default=None,
                               help="Global batch size")
    submit_parser.add_argument("--reward-function", default=None,
                               help="Lambda ARN for reward function (RLVR)")
    submit_parser.add_argument("--reward-prompt", default=None,
                               help="S3 URI for reward prompt (RLAIF)")

    # ── status ────────────────────────────────────────────────────────────────
    status_parser = subparsers.add_parser("status", help="Get job status and metrics")
    status_parser.add_argument("--job-name", required=True,
                               help="Training job name")
    status_parser.add_argument("--region", required=True,
                               help="AWS region")

    # ── resolve ───────────────────────────────────────────────────────────────
    resolve_parser = subparsers.add_parser("resolve",
                                           help="Resolve output artifact path")
    resolve_parser.add_argument("--job-name", required=True,
                                help="Training job name")
    resolve_parser.add_argument("--region", required=True,
                                help="AWS region")
    resolve_parser.add_argument("--training-type", required=True,
                                choices=["lora", "full-rank"],
                                help="Training type used for the job")
    resolve_parser.add_argument("--model-package-group", default=None,
                                help="Model package group name")

    # ── stage-hf ──────────────────────────────────────────────────────────────
    stage_hf_parser = subparsers.add_parser("stage-hf",
                                            help="Download HF dataset to S3")
    stage_hf_parser.add_argument("--hf-org", required=True,
                                 help="Hugging Face organization/user")
    stage_hf_parser.add_argument("--hf-name", required=True,
                                 help="Hugging Face dataset name")
    stage_hf_parser.add_argument("--hf-split", default="train",
                                 help="Dataset split (default: train)")
    stage_hf_parser.add_argument("--output-bucket", required=True,
                                 help="S3 bucket for staged dataset")
    stage_hf_parser.add_argument("--project-name", required=True,
                                 help="Project name for S3 path prefix")
    stage_hf_parser.add_argument("--region", required=True,
                                 help="AWS region")
    stage_hf_parser.add_argument("--hf-secret-name", default=None,
                                 help="Secrets Manager secret name for HF token")

    # ── validate ──────────────────────────────────────────────────────────────
    validate_parser = subparsers.add_parser("validate",
                                            help="Validate dataset format")
    validate_parser.add_argument("--schema", required=True,
                                 help="JSON string of the expected dataset schema")
    validate_parser.add_argument("--file", default="-",
                                 help="Path to dataset file (default: stdin)")

    # ── Parse and dispatch ────────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    command_map = {
        "submit": cmd_submit,
        "status": cmd_status,
        "resolve": cmd_resolve,
        "stage-hf": cmd_stage_hf,
        "validate": cmd_validate,
    }

    handler = command_map.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
