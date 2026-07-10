from __future__ import annotations
"""Tune submission: submit a managed customization job via SageMaker.

Purpose: cmd_submit subcommand for do/tune
Inputs: --technique, --dataset-s3-uri, --model-id, --training-type, --role-arn, etc.
Outputs: JSON with job_name, job_arn, mlflow_url, model_package_group
Caller: .tune_helper.py dispatcher
Related: tune_resolve.py (_resolve_dataset_name, _resolve_evaluator_name)
"""

import json
import os
import sys
import time

from common import _output, _error_exit, _check_sagemaker_sdk
from tune_resolve import _resolve_dataset_name, _resolve_evaluator_name


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

    # ── Resolve --dataset-name from registry (AC-2b.4) ────────────────────────
    # --dataset-s3-uri wins if both are provided (backward compatible override)
    if not args.dataset_s3_uri and args.dataset_name:
        resolved_uri = _resolve_dataset_name(args.dataset_name)
        args.dataset_s3_uri = resolved_uri
    elif not args.dataset_s3_uri and not args.dataset_name:
        _error_exit(
            "Either --dataset-s3-uri or --dataset-name is required. "
            "Provide an S3 URI directly or a registered dataset name."
        )

    # ── Resolve --evaluator-name from registry (AC-2c.3, AC-2c.4) ────────────
    # --reward-function / --reward-prompt win if provided (backward compatible override)
    if args.evaluator_name and not args.reward_function and not args.reward_prompt:
        ev_type, ev_arn_or_uri = _resolve_evaluator_name(args.evaluator_name)
        if ev_type == "lambda":
            args.reward_function = ev_arn_or_uri
        else:
            args.reward_prompt = ev_arn_or_uri

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
