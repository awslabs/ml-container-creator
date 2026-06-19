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
    discover - Discover tune-eligible models from JumpStart Hub

All output is JSON on stdout for bash consumption.
"""

import argparse
import fnmatch
import json
import os
import re
import sys
import time
import warnings

# Suppress noisy dependency version warnings from requests/urllib3
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*urllib3.*")
warnings.filterwarnings("ignore", message=".*charset_normalizer.*")

# Suppress ALL logging to prevent sagemaker-core/rich from writing to stdout.
# This script outputs JSON on stdout — any other stdout output corrupts parsing.
import logging as _logging
_logging.disable(_logging.CRITICAL)
os.environ.setdefault("SAGEMAKER_LOG_LEVEL", "CRITICAL")

# ── Inline dependency check ───────────────────────────────────────────────────
MIN_SAGEMAKER_VERSION = "3.0"

_GLOB_METACHAR_RE = re.compile(r'[*?\[]')


def _check_sagemaker_sdk():
    """Verify sagemaker SDK is installed with minimum version."""
    try:
        import sagemaker  # noqa: F401
        # SDK v3 removed __version__; use importlib.metadata instead
        from importlib.metadata import version as pkg_version
        from packaging.version import Version
        installed = pkg_version("sagemaker")
        if Version(installed) < Version(MIN_SAGEMAKER_VERSION):
            _error_exit(
                f"sagemaker SDK version {installed} is below minimum "
                f"required version {MIN_SAGEMAKER_VERSION}. "
                f"Please upgrade: pip install --upgrade 'sagemaker>={MIN_SAGEMAKER_VERSION}'"
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
        import json as _json
        _json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value) if value else None


# ── Subcommand: submit ────────────────────────────────────────────────────────


def cmd_submit(args):
    """Submit customization job via SFTTrainer/DPOTrainer.

    Returns: {"job_name": str, "job_arn": str, "mlflow_url": str|None}
    """
    # Suppress SDK rich logging that pollutes stdout (we only want JSON output)
    import logging
    logging.disable(logging.CRITICAL)
    os.environ["SAGEMAKER_LOG_LEVEL"] = "CRITICAL"

    # Ensure region is set before ANY sagemaker import (v3 creates boto3 clients at import time)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ["AWS_DEFAULT_REGION"] = region
        os.environ.setdefault("AWS_REGION", region)

    _check_sagemaker_sdk()

    # SDK v3 moved trainers from sagemaker.modules.train → sagemaker.train
    # Note: catch Exception (not just ImportError) because SDK v3 AIRHub
    # creates boto3 clients at class-definition time, which can raise
    # NoRegionError if AWS_DEFAULT_REGION is not set despite our best efforts.
    try:
        from sagemaker.train.sft_trainer import SFTTrainer
        from sagemaker.train.dpo_trainer import DPOTrainer
        from sagemaker.train.common import TrainingType
    except Exception:
        try:
            from sagemaker.modules.train.sft_trainer import SFTTrainer
            from sagemaker.modules.train.dpo_trainer import DPOTrainer
            from sagemaker.modules.train.common import TrainingType
        except Exception:
            _error_exit(
                "SFTTrainer not found. Requires sagemaker>=3.0. "
                "Install: pip install --upgrade 'sagemaker>=3.0'"
            )

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
        "full-rank": getattr(TrainingType, 'FULL_RANK', None) or getattr(TrainingType, 'FULL', None),
    }
    training_type = training_type_map.get(args.training_type)
    if not training_type:
        _error_exit(f"Unsupported training type: {args.training_type}")

    # Build hyperparameters dict from optional overrides
    # Map CLI flag names to SDK v3 fine-tuning option names
    hyperparameters = {}
    if args.epochs is not None:
        hyperparameters["max_epochs"] = args.epochs
    if args.learning_rate is not None:
        hyperparameters["learning_rate"] = args.learning_rate
    if args.max_seq_length is not None:
        hyperparameters["dataset_max_len"] = args.max_seq_length
    if args.lora_rank is not None:
        hyperparameters["lora_rank"] = args.lora_rank
    if args.lora_alpha is not None:
        hyperparameters["lora_alpha"] = args.lora_alpha
    if args.batch_size is not None:
        hyperparameters["global_batch_size"] = args.batch_size

    # Build trainer kwargs — API differs between SDK v2 and v3
    output_path = f"s3://{args.output_bucket}/{args.project_name}/tune/{technique}/"

    # Detect SDK version to use appropriate API
    sdk_v3 = hasattr(trainer_cls, 'role')  # v3 trainers have role as a settable attribute

    try:
        if sdk_v3:
            # SDK v3 API: positional model, keyword training_dataset, s3_output_path
            trainer_kwargs = {
                "model": args.model_id,
                "training_type": training_type,
                "training_dataset": args.dataset_s3_uri,
                "s3_output_path": output_path,
            }
            # Accept EULA for gated models (e.g., Meta Llama)
            # SDK v3.12+ accepts accept_eula as a constructor parameter
            if args.accept_eula:
                trainer_kwargs["accept_eula"] = True

            # Resolve model package group — create if it doesn't exist
            # Using sagemaker-core ModelPackageGroup.create() per SDK v3 policy
            mpg_name = args.model_package_group or f"{args.project_name}-tune-models"
            try:
                from sagemaker.core.resources import ModelPackageGroup
                from botocore.exceptions import ClientError as _ClientError
                try:
                    ModelPackageGroup.get(model_package_group_name=mpg_name)
                except (_ClientError, Exception) as _mpg_err:
                    if "does not exist" in str(_mpg_err) or "ValidationException" in str(_mpg_err):
                        try:
                            ModelPackageGroup.create(
                                model_package_group_name=mpg_name,
                                model_package_group_description=f"Fine-tuned models for {args.project_name}",
                            )
                        except Exception:
                            pass  # May already exist or lack permissions — let the trainer handle it
            except ImportError:
                # sagemaker-core not available — skip MPG creation, let trainer handle it
                pass
            trainer_kwargs["model_package_group"] = mpg_name

            trainer = trainer_cls(**trainer_kwargs)
            trainer.role = args.role_arn
            trainer.base_job_name = args.job_name
            if hyperparameters:
                # SDK v3 expects hyperparameters with a .to_dict() method
                # Wrap our plain dict to satisfy the interface
                hp_obj = trainer.hyperparameters
                if hp_obj is not None and hasattr(hp_obj, '__dict__'):
                    for k, v in hyperparameters.items():
                        setattr(hp_obj, k, v)
                else:
                    # Fallback: create a simple wrapper
                    class _HyperParams:
                        def __init__(self, d):
                            self._data = d
                            for k, v in d.items():
                                setattr(self, k, v)
                        def to_dict(self):
                            return {k: v for k, v in self._data.items() if v is not None}
                    trainer.hyperparameters = _HyperParams(hyperparameters)

            # Use MLCC-owned MLflow app if available (avoids permission issues with Studio apps)
            mlflow_arn = os.environ.get('MLFLOW_APP_ARN', '')
            if mlflow_arn:
                trainer.mlflow_resource_arn = mlflow_arn

            # Suppress SDK print() output (e.g., "Training Job Name: ...")
            # that pollutes stdout and breaks JSON parsing by the shell script
            import io as _io
            _orig_stdout = sys.stdout
            sys.stdout = _io.StringIO()
            try:
                trainer.train(training_dataset=args.dataset_s3_uri, wait=False)
            finally:
                sys.stdout = _orig_stdout
        else:
            # SDK v2 API: model_id, train_data_uri, output_path, role, job_name
            trainer_kwargs = {
                "model_id": args.model_id,
                "training_type": training_type,
                "train_data_uri": args.dataset_s3_uri,
                "output_path": output_path,
                "role": args.role_arn,
                "job_name": args.job_name,
            }
            if args.model_package_group:
                trainer_kwargs["model_package_group_name"] = args.model_package_group
            if hyperparameters:
                trainer_kwargs["hyperparameters"] = hyperparameters

            # Add evaluator config for RLVR/RLAIF techniques
            if technique in ("rlvr", "rlaif"):
                if args.reward_function:
                    trainer_kwargs["evaluator_config"] = {"reward_function_arn": args.reward_function}
                elif args.reward_prompt:
                    trainer_kwargs["evaluator_config"] = {"reward_prompt_s3_uri": args.reward_prompt}

            # Accept EULA for gated models (e.g., Meta Llama)
            if args.accept_eula:
                trainer_kwargs["accept_eula"] = True

            trainer = trainer_cls(**trainer_kwargs)
            # Suppress SDK print() output that pollutes stdout
            import io as _io
            _orig_stdout = sys.stdout
            sys.stdout = _io.StringIO()
            try:
                trainer.train(wait=False)
            finally:
                sys.stdout = _orig_stdout

        # Extract job info from the trainer
        job_name = getattr(trainer, 'training_job_name', None) or getattr(trainer, 'base_job_name', None)
        job_arn = getattr(trainer, "training_job_arn", None)
        latest_job = getattr(trainer, 'latest_training_job', None)
        if latest_job:
            job_name = job_name or getattr(latest_job, 'name', None) or getattr(latest_job, 'job_name', None)
            job_arn = job_arn or getattr(latest_job, 'arn', None)

        # If we still don't have the actual job name (SDK appends suffix),
        # query ListTrainingJobs to find it by our base_job_name prefix.
        # Note: list_training_jobs with NameContains filter is not available
        # via sagemaker-core resource API, so boto3 is retained here.
        if not job_name or job_name == args.job_name:
            import boto3 as _boto3
            _sm = _boto3.client("sagemaker", region_name=args.region or os.environ.get("AWS_REGION", "us-west-2"))
            try:
                # Brief delay to allow job to register
                time.sleep(2)
                list_resp = _sm.list_training_jobs(
                    NameContains=args.job_name,
                    SortBy="CreationTime",
                    SortOrder="Descending",
                    MaxResults=1,
                )
                summaries = list_resp.get("TrainingJobSummaries", [])
                if summaries:
                    job_name = summaries[0]["TrainingJobName"]
                    job_arn = summaries[0].get("TrainingJobArn", job_arn)
            except Exception:
                pass  # Fall back to whatever we have

        # Attempt to get MLflow URL if available
        mlflow_url = None
        try:
            mlflow_url = getattr(trainer, "mlflow_tracking_uri", None)
        except Exception:
            pass

        _output({
            "job_name": job_name or args.job_name,
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
                f"Model requires EULA acceptance. Re-run with --accept-eula flag: "
                f"./do/tune --technique {technique} --accept-eula ... "
                f"Details: {error_msg}"
            )
        elif "ValidationException" in error_msg and "eula" in error_msg.lower():
            _error_exit(
                f"Model requires EULA acceptance. Re-run with --accept-eula flag: "
                f"./do/tune --technique {technique} --accept-eula ... "
                f"Details: {error_msg}"
            )
        else:
            _error_exit(f"Failed to submit training job: {error_msg}")


# ── Subcommand: status ────────────────────────────────────────────────────────


def cmd_status(args):
    """Query job status via sagemaker-core TrainingJob.get().

    Falls back to boto3 ListTrainingJobs with name-contains if exact name not found
    (SDK v3 appends a timestamp suffix to the base job name).

    Returns: {"status": str, "failure_reason": str|None,
              "metrics": dict|None, "elapsed_seconds": int}
    """
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


# ── Subcommand: resolve ───────────────────────────────────────────────────────


def cmd_resolve(args):
    """Resolve artifact path within S3 output directory.

    Uses sagemaker-core TrainingJob.get() to read model_artifacts and
    output_data_config. Uses ModelPackage for model package lookup.

    Returns: {"artifact_path": str, "model_package_arn": str|None,
              "output_type": str}
    """
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


# ── Subcommand: stage-hf ─────────────────────────────────────────────────────


def _get_required_columns(technique):
    """Return the required column names for a given technique."""
    schemas = {
        "sft": ["prompt", "completion"],
        "dpo": ["prompt", "chosen", "rejected"],
        "rlaif": ["prompt"],  # prompt is an array of messages
        "rlvr": ["prompt"],   # prompt is an array of messages
    }
    return schemas.get(technique, ["prompt", "completion"])


def _suggest_column_map(detected_columns, required_columns):
    """Suggest a --column-map based on common column name patterns."""
    # Common aliases for each required field
    aliases = {
        "prompt": ["question", "instruction", "input", "query", "text", "context", "user", "human"],
        "completion": ["answer", "output", "response", "assistant", "target", "label", "reply"],
        "chosen": ["chosen", "preferred", "good", "positive", "accepted"],
        "rejected": ["rejected", "dispreferred", "bad", "negative", "refused"],
    }

    suggestions = {}
    for req_col in required_columns:
        if req_col in detected_columns:
            continue  # Already present
        # Check aliases
        for alias in aliases.get(req_col, []):
            if alias in detected_columns:
                suggestions[req_col] = alias
                break

    if not suggestions:
        return None

    # Format as --column-map string
    mapping_str = ",".join(f"{k}={v}" for k, v in suggestions.items())
    return mapping_str


def _parse_column_map(column_map_str):
    """Parse a column map string like 'prompt=question,completion=answer' into a dict."""
    if not column_map_str:
        return {}
    mapping = {}
    for pair in column_map_str.split(","):
        pair = pair.strip()
        if "=" not in pair:
            continue
        target, source = pair.split("=", 1)
        mapping[target.strip()] = source.strip()
    return mapping


def _apply_column_map(record, column_map):
    """Apply column mapping to a record: rename source columns to target names."""
    if not column_map:
        return record
    mapped = dict(record)
    for target, source in column_map.items():
        if source in mapped and target not in mapped:
            mapped[target] = mapped.pop(source)
    return mapped


def _detect_chat_columns(record, required_columns, schema_types):
    """Detect which required columns contain chat-format data.

    Only inspects columns whose schema type is "string". Columns with
    "array" type (RLAIF/RLVR) are excluded from detection entirely.

    Args:
        record: The first record (dict) after column mapping
        required_columns: List of required column names for the technique
        schema_types: Dict mapping column name -> expected type from schema

    Returns:
        dict: Maps column_name -> detection_result where detection_result is:
              {"type": "single_dict"} or
              {"type": "message_list", "strategy": "extract"|"same_role"|"multi_role", "count": int}
              Only columns detected as chat-format are included.
    """
    results = {}
    for column in required_columns:
        # Only inspect columns whose schema type is "string"
        if schema_types.get(column) != "string":
            continue

        # Skip if column is not present in the record
        if column not in record:
            continue

        value = record[column]

        # Check for Single_Message_Dict: dict with both "role" and "content" keys
        if isinstance(value, dict) and "role" in value and "content" in value:
            results[column] = {"type": "single_dict"}
            continue

        # Check for Message_List: non-empty list whose first element is a dict
        # with both "role" and "content" keys
        if isinstance(value, list) and len(value) > 0:
            first_element = value[0]
            if isinstance(first_element, dict) and "role" in first_element and "content" in first_element:
                count = len(value)
                if count == 1:
                    strategy = "extract"
                elif all(
                    isinstance(elem, dict) and elem.get("role") == first_element["role"]
                    for elem in value
                ):
                    strategy = "same_role"
                else:
                    strategy = "multi_role"
                results[column] = {"type": "message_list", "strategy": strategy, "count": count}
                continue

    return results


def _flatten_value(value, detection_result):
    """Flatten a chat-format column value to a plain string.

    Args:
        value: The column value (dict, list, string, or other)
        detection_result: The detection metadata for this column

    Returns:
        str: The flattened string value

    Raises:
        ValueError: If the value cannot be converted at all (str() also fails)
    """
    import json

    # Edge case: string pass-through
    if isinstance(value, str):
        return value

    # Edge case: None → ""
    if value is None:
        return ""

    # Edge case: empty list → ""
    if isinstance(value, list) and len(value) == 0:
        return ""

    det_type = detection_result.get("type")

    if det_type == "single_dict":
        if isinstance(value, dict):
            role = value.get("role", "")
            if "content" in value:
                content = value["content"]
                if isinstance(content, str):
                    return content
                # Non-string content: format as "role: json_content"
                return f"{role}: {json.dumps(content)}"
            else:
                # No content key: format as "role: remaining_values"
                remaining = {k: v for k, v in value.items() if k != "role"}
                return f"{role}: {json.dumps(remaining)}"

    elif det_type == "message_list":
        strategy = detection_result.get("strategy")

        if isinstance(value, list) and len(value) > 0:
            if strategy == "extract":
                # Extract single element's content
                elem = value[0]
                if isinstance(elem, dict):
                    content = elem.get("content")
                    if content is None:
                        return ""
                    if isinstance(content, str):
                        return content
                    return f"{elem.get('role', '')}: {json.dumps(content)}"
                return ""

            elif strategy == "same_role":
                # Join all content fields with newline
                parts = []
                for elem in value:
                    if isinstance(elem, dict):
                        content = elem.get("content")
                        if content is None or content == "":
                            parts.append("")
                        elif isinstance(content, str):
                            parts.append(content)
                        else:
                            parts.append(json.dumps(content))
                    else:
                        parts.append("")
                return "\n".join(parts)

            elif strategy == "multi_role":
                # Format as "role: content" per line
                lines = []
                for elem in value:
                    if isinstance(elem, dict):
                        role = elem.get("role", "")
                        content = elem.get("content")
                        if content is None:
                            content = ""
                        elif not isinstance(content, str):
                            content = json.dumps(content)
                        lines.append(f"{role}: {content}")
                    else:
                        lines.append("")
                return "\n".join(lines)

    # Fallback for unexpected types: int/bool → str()
    try:
        return str(value)
    except Exception as e:
        raise ValueError(f"Cannot convert value to string: {e}")


def _flatten_record(record, chat_columns):
    """Apply flattening to all chat-format columns in a record.

    Args:
        record: The mapped record dict
        chat_columns: Detection results from _detect_chat_columns

    Returns:
        dict: The record with chat-format columns replaced by flat strings
    """
    flattened = dict(record)
    for column_name, detection_result in chat_columns.items():
        if column_name in flattened:
            flattened[column_name] = _flatten_value(flattened[column_name], detection_result)
    return flattened


def _log_flatten_info(chat_columns, no_transform):
    """Log auto-flatten detection and strategy information.

    Logs regardless of --no-transform state (per requirement 6.3/6.4).
    When --no-transform is active, detection still runs for logging purposes.

    All output goes to stderr to avoid polluting stdout JSON output.

    Args:
        chat_columns: Detection results dict (from _detect_chat_columns)
        no_transform: Whether --no-transform flag is active
    """
    for column_name, detection_result in chat_columns.items():
        print(f"\u2139\ufe0f  Auto-converted column '{column_name}' from chat-format to string", file=sys.stderr)
        det_type = detection_result.get("type")
        if det_type == "single_dict":
            print("    Format: extracted content field", file=sys.stderr)
        elif det_type == "message_list":
            strategy = detection_result.get("strategy")
            count = detection_result.get("count", 0)
            if strategy == "multi_role":
                print(f"    Format: role: content (multi-turn, {count} messages)", file=sys.stderr)
            elif strategy == "same_role":
                print(f"    Format: newline-joined content ({count} messages, same role)", file=sys.stderr)
            elif strategy == "extract":
                print("    Format: extracted content field", file=sys.stderr)


def _get_schema_types(technique):
    """Return a dict mapping column names to their expected types for a technique.

    Args:
        technique: One of 'sft', 'dpo', 'rlaif', 'rlvr'

    Returns:
        dict: Maps column_name -> expected type ("string" or "array")
    """
    schemas = {
        "sft": {"prompt": "string", "completion": "string"},
        "dpo": {"prompt": "string", "chosen": "string", "rejected": "string"},
        "rlaif": {"prompt": "array"},
        "rlvr": {"prompt": "array"},
    }
    return schemas.get(technique, {"prompt": "string", "completion": "string"})


def _validate_dataset_columns(first_record, technique, column_map_str, dataset_id, take=None):
    """Validate that the first record has required columns after mapping.

    Returns (mapped_record, column_map_dict) on success.
    Calls _error_exit with helpful suggestions on failure.
    If take is provided, includes --take N in the suggested command.
    """
    column_map = _parse_column_map(column_map_str)
    mapped = _apply_column_map(first_record, column_map)
    required = _get_required_columns(technique)
    detected = list(first_record.keys())

    missing = [col for col in required if col not in mapped]
    if not missing:
        return mapped, column_map

    # Build helpful error message
    lines = [
        f"Dataset columns don't match {technique.upper()} requirements.",
        f"",
        f"   Required columns: {', '.join(required)}",
        f"   Detected columns: {', '.join(detected)}",
        f"   Missing: {', '.join(missing)}",
    ]

    # Suggest a column map
    suggestion = _suggest_column_map(detected, required)
    if suggestion:
        lines.append(f"")
        lines.append(f"   💡 Suggested fix:")
        take_suffix = f" --take {take}" if take else ""
        lines.append(f"      ./do/tune --technique {technique} --dataset hf://{dataset_id} --column-map {suggestion}{take_suffix}")
    else:
        lines.append(f"")
        lines.append(f"   💡 Use --column-map to rename columns:")
        example_map = ",".join(f"{r}=<your_column>" for r in missing)
        take_suffix = f" --take {take}" if take else ""
        lines.append(f"      ./do/tune --technique {technique} --dataset hf://{dataset_id} --column-map {example_map}{take_suffix}")

    lines.append(f"")
    lines.append(f"   First record sample:")
    # Show truncated first record
    for k, v in list(first_record.items())[:5]:
        val_str = str(v)[:80] + ("..." if len(str(v)) > 80 else "")
        lines.append(f"      {k}: {val_str}")

    _error_exit("\n".join(lines))


def _check_empty_fields(record, required_columns):
    """Return list of required column names that are empty/blank in this record."""
    empty = []
    for col in required_columns:
        value = record.get(col, "")
        if value is None or (isinstance(value, str) and not value.strip()):
            empty.append(col)
    return empty


def cmd_stage_hf(args):
    """Download HF dataset to S3 using huggingface_hub.

    Handles auth via Secrets Manager or HF_TOKEN env var.

    Returns: {"s3_uri": str, "num_records": int}
    """
    # Suppress HF Hub progress bars — they pollute stdout which must be clean JSON
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

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

        # Apply file filter if --hf-file is provided
        hf_file_pattern = getattr(args, 'hf_file', None)

        if not data_files and hf_file_pattern:
            # Split-based lookup found nothing, but user specified a file filter.
            # Fall back to filtering directly from all data files in the repo.
            all_data_files = [
                f for f in repo_files
                if f.endswith(('.parquet', '.jsonl', '.json'))
                and not f.startswith('.')
            ]
            if all_data_files:
                data_files = _filter_data_files(all_data_files, hf_file_pattern)
        elif hf_file_pattern and data_files:
            # Normal case: apply file filter to split-matched results
            data_files = _filter_data_files(data_files, hf_file_pattern)

        if not data_files:
            _error_exit(
                f"No data files found for split '{split}' in dataset {dataset_id}. "
                f"Available files: {', '.join(repo_files[:20])}"
            )

        # Download and upload to S3
        s3_client = boto3.client("s3", region_name=args.region)
        s3_prefix = f"{args.project_name}/datasets/{org}/{name}/{split}"
        num_records = 0
        empty_field_counts = {}  # Track empty required fields: {field_name: count}

        with tempfile.TemporaryDirectory() as tmpdir:
            # Schema divergence check (skip for single file)
            if len(data_files) > 1:
                column_map = _parse_column_map(getattr(args, 'column_map', None))
                technique = getattr(args, 'technique', 'sft')
                no_transform = getattr(args, 'no_transform', False)
                file_records = _inspect_file_schemas(
                    data_files, dataset_id, hf_token, tmpdir,
                    column_map, technique, no_transform
                )
                _check_schema_divergence(file_records, dataset_id, technique)

            for data_file in data_files:
                local_path = hf_hub_download(
                    repo_id=dataset_id,
                    filename=data_file,
                    repo_type="dataset",
                    token=hf_token,
                    local_dir=tmpdir,
                )

                # Handle Parquet files: convert to JSONL for SageMaker compatibility
                if data_file.endswith(".parquet"):
                    try:
                        import pyarrow.parquet as pq
                        import json as json_mod

                        table = pq.read_table(local_path)
                        jsonl_filename = os.path.splitext(os.path.basename(data_file))[0] + ".jsonl"
                        jsonl_path = os.path.join(tmpdir, jsonl_filename)

                        # Parse column map and validate against first record
                        column_map = _parse_column_map(getattr(args, 'column_map', None))
                        technique = getattr(args, 'technique', 'sft')
                        no_transform = getattr(args, 'no_transform', False)
                        batches = table.to_batches(max_chunksize=1)
                        first_record = batches[0].to_pylist()[0] if batches else {}
                        _validate_dataset_columns(first_record, technique, getattr(args, 'column_map', None), f"{org}/{name}", take=getattr(args, 'take', None))

                        # Apply column map to first record for detection
                        mapped_first = _apply_column_map(first_record, column_map)
                        required_columns = _get_required_columns(technique)
                        schema_types = _get_schema_types(technique)

                        # Detect chat-format columns on first record
                        chat_columns = _detect_chat_columns(mapped_first, required_columns, schema_types)

                        # Log detection results if any chat columns found
                        if chat_columns:
                            _log_flatten_info(chat_columns, no_transform)

                        # If --no-transform is active and chat-format detected, halt with error
                        if no_transform and chat_columns:
                            col_name = next(iter(chat_columns))
                            det = chat_columns[col_name]
                            det_type = det.get("type")
                            strategy = det.get("strategy", "")
                            if det_type == "single_dict":
                                strategy_desc = "single message dict with role+content"
                            elif strategy == "extract":
                                strategy_desc = "message list (single element)"
                            elif strategy == "same_role":
                                strategy_desc = f"message list ({det.get('count', 0)} messages, same role)"
                            elif strategy == "multi_role":
                                strategy_desc = f"message list (multi-turn, {det.get('count', 0)} messages)"
                            else:
                                strategy_desc = det_type
                            _error_exit(
                                f"Column '{col_name}' contains chat-format data (detected: {det_type}) but --no-transform is active.\n\n"
                                f"   Remove --no-transform to enable automatic conversion:\n"
                                f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} [--column-map ...]\n\n"
                                f"   Detected format: {strategy_desc}"
                            )

                        take_limit = getattr(args, 'take', None)
                        with open(jsonl_path, "w", encoding="utf-8") as out_f:
                            for batch in table.to_batches():
                                for row in batch.to_pylist():
                                    if take_limit and num_records >= take_limit:
                                        break
                                    mapped_row = _apply_column_map(row, column_map)
                                    if chat_columns and not no_transform:
                                        mapped_row = _flatten_record(mapped_row, chat_columns)
                                    # Track empty required fields
                                    for col in _check_empty_fields(mapped_row, required_columns):
                                        empty_field_counts[col] = empty_field_counts.get(col, 0) + 1
                                    out_f.write(json_mod.dumps(mapped_row, ensure_ascii=False) + "\n")
                                    num_records += 1
                                if take_limit and num_records >= take_limit:
                                    break

                        # Upload converted JSONL
                        # Verify file has content before uploading
                        file_size = os.path.getsize(jsonl_path)
                        if file_size == 0:
                            _error_exit(
                                f"Converted JSONL file is empty (0 bytes) after processing "
                                f"{num_records} records. This is a bug — please report it."
                            )
                        s3_key = f"{s3_prefix}/{jsonl_filename}"
                        s3_client.upload_file(jsonl_path, args.output_bucket, s3_key)

                    except ImportError:
                        _error_exit(
                            "Dataset is in Parquet format but pyarrow is not installed. "
                            "Please install: pip install pyarrow"
                        )
                else:
                    # JSONL file — validate columns and apply mapping
                    import json as json_mod
                    column_map = _parse_column_map(getattr(args, 'column_map', None))
                    technique = getattr(args, 'technique', 'sft')
                    no_transform = getattr(args, 'no_transform', False)

                    # Read first line to validate
                    chat_columns = {}
                    with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                        first_line = f.readline().strip()
                        if first_line:
                            first_record = json_mod.loads(first_line)
                            _validate_dataset_columns(first_record, technique, getattr(args, 'column_map', None), f"{org}/{name}", take=getattr(args, 'take', None))

                            # Apply column map to first record for detection
                            mapped_first = _apply_column_map(first_record, column_map)
                            required_columns = _get_required_columns(technique)
                            schema_types = _get_schema_types(technique)

                            # Detect chat-format columns on first record
                            chat_columns = _detect_chat_columns(mapped_first, required_columns, schema_types)

                            # Log detection results if any chat columns found
                            if chat_columns:
                                _log_flatten_info(chat_columns, no_transform)

                            # If --no-transform is active and chat-format detected, halt with error
                            if no_transform and chat_columns:
                                col_name = next(iter(chat_columns))
                                det = chat_columns[col_name]
                                det_type = det.get("type")
                                strategy = det.get("strategy", "")
                                if det_type == "single_dict":
                                    strategy_desc = "single message dict with role+content"
                                elif strategy == "extract":
                                    strategy_desc = "message list (single element)"
                                elif strategy == "same_role":
                                    strategy_desc = f"message list ({det.get('count', 0)} messages, same role)"
                                elif strategy == "multi_role":
                                    strategy_desc = f"message list (multi-turn, {det.get('count', 0)} messages)"
                                else:
                                    strategy_desc = det_type
                                _error_exit(
                                    f"Column '{col_name}' contains chat-format data (detected: {det_type}) but --no-transform is active.\n\n"
                                    f"   Remove --no-transform to enable automatic conversion:\n"
                                    f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} [--column-map ...]\n\n"
                                    f"   Detected format: {strategy_desc}"
                                )

                    # Rewrite the file with mapped (and optionally flattened) columns
                    should_flatten = bool(chat_columns) and not no_transform
                    take_limit = getattr(args, 'take', None)
                    if column_map or should_flatten or take_limit:
                        mapped_path = local_path + ".mapped"
                        with open(local_path, "r", encoding="utf-8", errors="replace") as f_in, \
                             open(mapped_path, "w", encoding="utf-8") as f_out:
                            for line in f_in:
                                if take_limit and num_records >= take_limit:
                                    break
                                line = line.strip()
                                if not line:
                                    continue
                                record = json_mod.loads(line)
                                mapped_record = _apply_column_map(record, column_map)
                                if should_flatten:
                                    mapped_record = _flatten_record(mapped_record, chat_columns)
                                # Track empty required fields
                                for col in _check_empty_fields(mapped_record, _get_required_columns(technique)):
                                    empty_field_counts[col] = empty_field_counts.get(col, 0) + 1
                                f_out.write(json_mod.dumps(mapped_record, ensure_ascii=False) + "\n")
                                num_records += 1
                        local_path = mapped_path
                    else:
                        # Count records (and truncate if --take specified)
                        take_limit = getattr(args, 'take', None)
                        if take_limit:
                            # Need to rewrite the file truncated
                            mapped_path = local_path + ".mapped"
                            with open(local_path, "r", encoding="utf-8", errors="replace") as f_in, \
                                 open(mapped_path, "w", encoding="utf-8") as f_out:
                                for line in f_in:
                                    if num_records >= take_limit:
                                        break
                                    if line.strip():
                                        f_out.write(line)
                                        num_records += 1
                            local_path = mapped_path
                        else:
                            with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                                for line in f:
                                    if line.strip():
                                        num_records += 1

                    # Upload to S3
                    s3_key = f"{s3_prefix}/{os.path.basename(data_file)}"
                    s3_client.upload_file(local_path, args.output_bucket, s3_key)

        # Use the first file's name for the S3 URI (JSONL extension for Parquet conversions)
        first_file = data_files[0]
        if first_file.endswith(".parquet"):
            output_filename = os.path.splitext(os.path.basename(first_file))[0] + ".jsonl"
        else:
            output_filename = os.path.basename(first_file)
        s3_uri = f"s3://{args.output_bucket}/{s3_prefix}/{output_filename}"

        # Warn if required columns have many empty values
        if num_records > 0 and empty_field_counts:
            for field, count in empty_field_counts.items():
                pct = (count / num_records) * 100
                if pct > 30:
                    print(
                        f"\u26a0\ufe0f  Warning: {pct:.0f}% of records ({count}/{num_records}) "
                        f"have empty '{field}' after column mapping.\n"
                        f"   SageMaker may reject these as invalid samples.\n"
                        f"   Consider using a different --column-map or dataset.",
                        file=sys.stderr,
                    )

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

    # Prefix match for sharded files (deduplicate via set)
    matches = set()
    for f in repo_files:
        for pattern in patterns[4:]:
            if pattern in f:
                matches.add(f)

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

    # Final fallback: any JSONL/JSON file in the repo root (single-file datasets)
    root_data = [f for f in repo_files if "/" not in f and (f.endswith(".jsonl") or f.endswith(".json")) and not f.startswith(".")]
    if root_data:
        return sorted(root_data)

    return []


def _is_glob_pattern(pattern):
    """Return True if pattern contains glob metacharacters (*, ?, [)."""
    return bool(_GLOB_METACHAR_RE.search(pattern))


def _filter_data_files(data_files, pattern):
    """Filter data files by glob or substring pattern.

    If the pattern is empty or None, returns all files (no-filter).
    If the pattern contains glob metacharacters (*, ?, [), uses fnmatch
    against the full relative path. Otherwise, performs substring match
    on the basename.

    Args:
        data_files: List of file paths from _find_data_files
        pattern: The filter pattern string

    Returns:
        list: Filtered file paths that match the pattern

    Raises:
        SystemExit: via _error_exit if no files match (includes available files list)
    """
    if not pattern:
        return data_files

    if _is_glob_pattern(pattern):
        matched = [f for f in data_files if fnmatch.fnmatch(f, pattern)]
    else:
        matched = [f for f in data_files if pattern in os.path.basename(f)]

    if not matched:
        file_list = "\n".join(f"  • {f}" for f in data_files)
        _error_exit(
            f"No files matched pattern '{pattern}'.\n\n"
            f"Available files:\n{file_list}"
        )

    return matched


def _inspect_file_schemas(data_files, dataset_id, hf_token, tmpdir,
                          column_map, technique, no_transform):
    """Inspect first record of each file to extract effective column sets.

    Downloads each file, reads its first record, applies column-map and
    flattening, then returns the resulting column names.

    Args:
        data_files: List of file paths to inspect
        dataset_id: HF dataset identifier for downloads
        hf_token: Authentication token
        tmpdir: Temporary directory for downloads
        column_map: Parsed column mapping dict
        technique: Technique name for schema types
        no_transform: Whether --no-transform is active

    Returns:
        list: [(filename, set_of_column_names), ...] for each file
    """
    from huggingface_hub import hf_hub_download

    required_columns = _get_required_columns(technique)
    schema_types = _get_schema_types(technique)
    results = []

    for data_file in data_files:
        local_path = hf_hub_download(
            repo_id=dataset_id,
            filename=data_file,
            repo_type="dataset",
            token=hf_token,
            local_dir=tmpdir,
        )

        first_record = {}

        if data_file.endswith(".parquet"):
            try:
                import pyarrow.parquet as pq

                table = pq.read_table(local_path)
                batches = table.to_batches(max_chunksize=1)
                if batches:
                    first_record = batches[0].to_pylist()[0]
            except ImportError:
                _error_exit(
                    "Dataset is in Parquet format but pyarrow is not installed. "
                    "Please install: pip install pyarrow"
                )
        else:
            import json as json_mod

            with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                first_line = f.readline().strip()
                if first_line:
                    first_record = json_mod.loads(first_line)

        # Apply column mapping
        mapped_record = _apply_column_map(first_record, column_map)

        # Apply flattening if --no-transform is not active
        if not no_transform:
            chat_columns = _detect_chat_columns(mapped_record, required_columns, schema_types)
            if chat_columns:
                mapped_record = _flatten_record(mapped_record, chat_columns)

        results.append((data_file, set(mapped_record.keys())))

    return results


def _check_schema_divergence(file_records, dataset_id, technique):
    """Check that all files have identical effective columns.

    Args:
        file_records: List of (filename, first_record_columns) tuples where
                      first_record_columns is the set of column names after
                      column-map and flattening
        dataset_id: The dataset identifier (for error messages)
        technique: The technique name (for error messages)

    Returns:
        None on success (all schemas match)

    Raises:
        SystemExit: via _error_exit with per-file column listing and
                    ?file= remediation suggestion if schemas differ
    """
    if not file_records:
        return None

    # Compare all column sets to the first file's columns
    first_columns = file_records[0][1]
    all_identical = all(cols == first_columns for _, cols in file_records)

    if all_identical:
        return None

    # Build per-file column listing
    file_sections = []
    for filename, columns in file_records:
        sorted_cols = ", ".join(sorted(columns))
        file_sections.append(
            f"  \U0001f4c4 {filename}\n"
            f"     Columns: {sorted_cols}"
        )

    # Derive remediation pattern from first file's basename
    first_file = file_records[0][0]
    basename = os.path.basename(first_file)
    # Strip extension and wrap with wildcards for a useful pattern
    name_without_ext = os.path.splitext(basename)[0]
    # Use a distinctive portion — take the first numeric segment if present
    import re as _re
    numeric_match = _re.search(r'\d+', name_without_ext)
    if numeric_match:
        pattern_suggestion = f"*{numeric_match.group()}*"
    else:
        pattern_suggestion = f"*{name_without_ext}*"

    # Build available files list
    available_files = "\n".join(
        f"     \u2022 {filename}" for filename, _ in file_records
    )

    # Build the full error message
    file_listing = "\n\n".join(file_sections)
    message = (
        f"Schema divergence detected in dataset {dataset_id}.\n"
        f"Files have different columns after applying column-map and transforms:\n\n"
        f"{file_listing}\n\n"
        f"\U0001f4a1 Use ?file=<pattern> to select compatible files:\n"
        f"   ./do/tune --technique {technique} --dataset hf://{dataset_id}?file={pattern_suggestion}\n\n"
        f"   Available files:\n{available_files}"
    )

    _error_exit(message)


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


# ── Subcommand: discover ──────────────────────────────────────────────────────


def cmd_discover(args):
    """Query JumpStart Hub for tune-eligible models matching a family.

    NOTE: This subcommand intentionally stays on boto3.client('sagemaker')
    because list_hub_contents / Hub API is NOT available in sagemaker-core.
    This is a documented exception per the SDK v3 migration policy.

    Returns: {"models": [str], "count": int}
    """
    region = args.region or os.environ.get('AWS_REGION', 'us-east-1')

    family = args.family or ""
    # Map family names to Hub content name prefixes
    FAMILY_PREFIX_MAP = {
        "qwen-2.5": "huggingface-llm-qwen2-5",
        "qwen-3": "huggingface-reasoning-qwen3",
        "llama-3": "meta-textgeneration-llama-3",
        "deepseek-r1": "deepseek-llm-r1-distill",
        "gpt-oss": "openai-reasoning-gpt-oss",
    }

    prefix = FAMILY_PREFIX_MAP.get(family, args.filter or "")
    if not prefix:
        _error_exit("No family or filter provided for discovery")

    try:
        import boto3
    except ImportError:
        _error_exit("Hub discovery failed: boto3 is not installed. Install with: pip install boto3")

    try:
        # Documented exception: Hub API (list_hub_contents) is not available in
        # sagemaker-core, so we retain boto3.client('sagemaker') here.
        client = boto3.client("sagemaker", region_name=region)
        models = []
        paginator = client.get_paginator('list_hub_contents')
        pages = paginator.paginate(
            HubName="SageMakerPublicHub",
            HubContentType="Model",
            NameContains=prefix,
            MaxResults=20
        )
        for page in pages:
            for item in page.get('HubContentSummaries', []):
                if item.get('HubContentStatus') == 'Available':
                    models.append(item['HubContentName'])

        _output({"models": models[:5], "count": len(models)})

    except Exception as e:
        _error_exit(f"Hub discovery failed: {e}")


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
    submit_parser.add_argument("--region", default=None,
                               help="AWS region (defaults to AWS_REGION env var)")
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
    submit_parser.add_argument("--accept-eula", action="store_true", default=False,
                               help="Accept model EULA for gated models (e.g., Llama)")

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
    stage_hf_parser.add_argument("--hf-file", default=None,
                                 help="File filter pattern (glob or substring)")
    stage_hf_parser.add_argument("--output-bucket", required=True,
                                 help="S3 bucket for staged dataset")
    stage_hf_parser.add_argument("--project-name", required=True,
                                 help="Project name for S3 path prefix")
    stage_hf_parser.add_argument("--region", required=True,
                                 help="AWS region")
    stage_hf_parser.add_argument("--hf-secret-name", default=None,
                                 help="Secrets Manager secret name for HF token")
    stage_hf_parser.add_argument("--column-map", default=None,
                                 help="Column mapping (e.g., prompt=question,completion=answer)")
    stage_hf_parser.add_argument("--technique", default="sft",
                                 choices=["sft", "dpo", "rlaif", "rlvr"],
                                 help="Customization technique (determines required columns)")
    stage_hf_parser.add_argument("--no-transform", action="store_true", default=False,
                                 help="Disable automatic chat-format flattening")
    stage_hf_parser.add_argument("--take", type=int, default=None,
                                 help="Take only the first N records from the dataset")

    # ── validate ──────────────────────────────────────────────────────────────
    validate_parser = subparsers.add_parser("validate",
                                            help="Validate dataset format")
    validate_parser.add_argument("--schema", required=True,
                                 help="JSON string of the expected dataset schema")
    validate_parser.add_argument("--file", default="-",
                                 help="Path to dataset file (default: stdin)")

    # ── discover ──────────────────────────────────────────────────────────────
    discover_parser = subparsers.add_parser("discover",
                                            help="Discover tune-eligible models from JumpStart Hub")
    discover_parser.add_argument("--family", default="",
                                 help="Model family name (e.g., qwen-3, llama-3, deepseek-r1)")
    discover_parser.add_argument("--filter", default="",
                                 help="Hub content name prefix filter (overrides family mapping)")
    discover_parser.add_argument("--region", default="",
                                 help="AWS region (default: AWS_REGION env or us-east-1)")

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
        "discover": cmd_discover,
    }

    handler = command_map.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
