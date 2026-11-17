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
        ev_type, ev_reference, ev_arn = _resolve_evaluator_name(args.evaluator_name)
        # BL117: native evaluator types are reward_function (RLVR/MTRL) and
        # reward_prompt (RLAIF). Tolerate the legacy lambda/model labels.
        if ev_type in ("reward_function", "lambda"):
            # RLVR custom_reward_function → the Lambda / hub-content ARN reference.
            args.reward_function = ev_reference
        else:
            # RLAIF reward_prompt → the hub-content evaluator ARN (NOT the S3 URI,
            # which fails the SDK's hub-content ARN validation). Fall back to the
            # reference only if no ARN was resolved.
            args.reward_prompt = ev_arn or ev_reference

    _check_sagemaker_sdk()

    # SDK v3 moved trainers from sagemaker.modules.train → sagemaker.train
    # Note: catch Exception (not just ImportError) because SDK v3 AIRHub
    # creates boto3 clients at class-definition time, which can raise
    # NoRegionError if AWS_DEFAULT_REGION is not set despite our best efforts.
    try:
        from sagemaker.train.sft_trainer import SFTTrainer
        from sagemaker.train.dpo_trainer import DPOTrainer
        from sagemaker.train.common import TrainingType
        # RFT techniques have DEDICATED trainers (sagemaker>=3.x). They are NOT
        # SFTTrainer — SFTTrainer accepts **kwargs and SILENTLY DROPS any
        # evaluator/reward config, which produced reward-less plain-SFT jobs that
        # looked like RLAIF/RLVR but trained with no reward signal. Each RFT
        # trainer takes the reward via a TYPE-SPECIFIC kwarg (see _rft_reward_kwargs).
        from sagemaker.train.rlaif_trainer import RLAIFTrainer
        from sagemaker.train.rlvr_trainer import RLVRTrainer
        from sagemaker.train.multi_turn_rl_trainer import MultiTurnRLTrainer
    except Exception:
        _error_exit(
            "Managed-customization trainers not found. Requires sagemaker>=3.x "
            "with sagemaker.train.{sft,dpo,rlaif,rlvr,multi_turn_rl}_trainer. "
            "Install: pip install --upgrade 'sagemaker>=3.0'"
        )

    # Technique → Trainer class mapping. RFT techniques use their DEDICATED
    # trainer (not SFTTrainer) so the reward evaluator is actually wired into the
    # SageMaker job rather than silently dropped.
    TRAINER_MAP = {
        "sft": SFTTrainer,
        "dpo": DPOTrainer,
        "rlaif": RLAIFTrainer,
        "rlvr": RLVRTrainer,
        "mtrl": MultiTurnRLTrainer,
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

    # Build hyperparameters dict.
    # BL128: do/tune now resolves the technique's knobs via the config builder and passes
    # them as a single --hyperparameters JSON blob, keyed by the canonical override-param
    # names (which ARE the SDK fine-tuning option names). The legacy named flags below are
    # kept as a FALLBACK for direct `tune_submit` calls (and map onto the same canonical
    # names); the blob overlays them so a do/tune invocation (which sends the blob) is
    # authoritative. The old hand-maintained 6-entry map is subsumed by the blob merge.
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
    # Overlay the builder's resolved knobs (BL128). Canonical names match by construction,
    # so this is a straight merge — no translation table.
    blob = getattr(args, "hyperparameters", None)
    if blob:
        import json as _json
        try:
            resolved = _json.loads(blob)
        except (ValueError, TypeError):
            _error_exit("--hyperparameters must be valid JSON")
        if isinstance(resolved, dict):
            hyperparameters.update(resolved)

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

            # RFT reward wiring (the whole point of RLAIF/RLVR/MTRL). Each dedicated
            # trainer takes the reward via its OWN kwarg — there is no shared
            # evaluator_config, and SFTTrainer would silently drop one. Pass the
            # type-specific kwarg so the reward is actually in the job spec:
            #   RLAIF -> RLAIFTrainer(reward_prompt=<hub-content evaluator ARN>)
            #   RLVR  -> RLVRTrainer(custom_reward_function=<lambda arn>)
            # (MTRL uses an agent_env, resolved separately; not a simple reward.)
            if technique == "rlaif":
                if not args.reward_prompt:
                    _error_exit(
                        "RLAIF requires a reward prompt. Register one with "
                        "`do/register prompt` and pass --evaluator-name, or pass "
                        "--reward-prompt <hub-content-arn> directly.",
                        code="MISSING_REWARD_PROMPT",
                    )
                trainer_kwargs["reward_prompt"] = args.reward_prompt
            elif technique == "rlvr":
                if not args.reward_function:
                    _error_exit(
                        "RLVR requires a reward function. Register one with "
                        "`do/register evaluator` and pass --evaluator-name, or pass "
                        "--reward-function <lambda-arn> directly.",
                        code="MISSING_REWARD_FUNCTION",
                    )
                trainer_kwargs["custom_reward_function"] = args.reward_function
                # RLVRTrainer runs a pre-submit reward-function smoke test that
                # reads the training dataset expecting .jsonl (load_file_content
                # extension=".jsonl"). But the managed verl trainer REQUIRES
                # parquet (RLHFDataset), so the training dataset is parquet and
                # that validation hard-fails: "File must have .jsonl extension".
                # Skip the pre-submit validation — the reward function still runs
                # during training; we only lose a client-side smoke test that is
                # incompatible with the parquet dataset the trainer itself needs.
                trainer_kwargs["skip_reward_validation"] = True
            elif technique == "mtrl":
                # MTRL is agent-based: MultiTurnRLTrainer requires an agent_env
                # (a CustomAgentLambda / its ARN) that runs the rollout and computes
                # the reward itself — there is NO reward_prompt/custom_reward_function.
                # Its __init__ signature also differs: it does NOT accept
                # training_type, and names the MPG `output_model_package_group`
                # (not `model_package_group`). So reshape trainer_kwargs for mtrl.
                if not getattr(args, "agent_env", None):
                    _error_exit(
                        "MTRL requires an agent environment. Provide a CustomAgentLambda "
                        "ARN with --agent-env (there is no reward function/prompt for mtrl).",
                        code="MISSING_AGENT_ENV",
                    )
                trainer_kwargs = {
                    "model": args.model_id,
                    "agent_env": args.agent_env,
                    "training_dataset": args.dataset_s3_uri,
                    "s3_output_path": output_path,
                }

            # Accept EULA for gated models (e.g., Meta Llama)
            # SDK v3.12+ accepts accept_eula as a constructor parameter
            if args.accept_eula:
                trainer_kwargs["accept_eula"] = True

            # Resolve model package group — create if it doesn't exist.
            # BL164: register the tuned model into the PROJECT group (one catalog
            # per project), NOT a separate "<project>-tune-models" group. The
            # managed trainer is MLflow-aware (it takes model_package_group +
            # mlflow_experiment_name and builds an mlflow_config), so passing the
            # project name + the per-project experiment consolidates the tune
            # output with do/register's bridge registrations. (Whether the
            # trainer routes the group through the MLflow bridge vs a verbatim
            # MPG is the one remaining live-run confirmation — BL164 Task 11.)
            mpg_name = args.model_package_group or args.project_name
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
            # MTRL's MultiTurnRLTrainer names the MPG `output_model_package_group`;
            # the other trainers use `model_package_group`.
            if technique == "mtrl":
                trainer_kwargs["output_model_package_group"] = mpg_name
            else:
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
            # BL164/BL166: pin the tune job's telemetry to the per-project
            # experiment via the trainer's NATIVE mlflow_experiment_name knob
            # (SDK-confirmed to exist), so job metrics land under the project
            # experiment — not a trainer-default/job-named one. Resolved from the
            # same single source the register paths use (_project_experiment_name).
            try:
                import mlcc_mlflow as _mm
                _exp = _mm._project_experiment_name(getattr(args, 'project_name', '') or '')
                if _exp and _exp != "Default":
                    trainer.mlflow_experiment_name = _exp
            except Exception:  # noqa: BLE001 — experiment pin is best-effort
                pass

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

            # RFT reward wiring (SDK v2 path): the dedicated RFT trainers take a
            # type-specific reward kwarg, same as the v3 path above. (No shared
            # evaluator_config dict — that was silently ignored by SFTTrainer.)
            if technique == "rlaif":
                if not args.reward_prompt:
                    _error_exit("RLAIF requires a reward prompt (--evaluator-name, or --reward-prompt <hub-content-arn>).",
                                code="MISSING_REWARD_PROMPT")
                trainer_kwargs["reward_prompt"] = args.reward_prompt
            elif technique == "rlvr":
                if not args.reward_function:
                    _error_exit("RLVR requires a reward function (--evaluator-name or --reward-function).",
                                code="MISSING_REWARD_FUNCTION")
                trainer_kwargs["custom_reward_function"] = args.reward_function
                # Skip the pre-submit reward smoke test: it reads the dataset as
                # .jsonl, but the managed trainer needs parquet (see v3 path note).
                trainer_kwargs["skip_reward_validation"] = True

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
