from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Register evaluator: native SageMaker AI Registry evaluator assets (BL117).

Replaces the local-``evaluators.json`` stub (retired as the record of truth) with
real ``sagemaker.ai_registry`` evaluator assets. Two evaluator TYPES, two verbs:

  - ``do/register evaluator`` → REWARD_FUNCTION (a Lambda scorer) → RLVR / MTRL.
    The primary source is an existing Lambda ARN (``--arn``) — SageMaker stores a
    reference, provisions nothing, needs no dual-trust role. ``--from-sample`` is
    the optional editable-sample on-ramp (managed-Lambda path; see Req 1A).
  - ``do/register prompt``   → REWARD_PROMPT (an S3 LLM-as-judge prompt) → RLAIF.

Both call the same ``Evaluator.create`` (BL122-verified standalone for both types:
`status: Available`, `JsonDoc` hub content, native semver, `role=` kwarg,
`reference` = the source URI/ARN pointer). The native asset is the record of
truth; ``register_resolve.cmd_resolve_evaluator`` reads it back by name.

Role + ``domain_id`` + region/SDK guards are the shared BL123 foundation
(``ai_registry_native``), consumed here — NOT re-implemented.
"""

import sys

from common import _output, _error_exit, _warn

# ── Evaluator name budget (BL122 §3 / Req 1.3) ─────────────────────────────────
#
# A REWARD_FUNCTION evaluator created from a local ``.py`` makes SageMaker create a
# managed Lambda named ``SageMaker-evaluator-<name>-<timestamp>``; Lambda caps
# ``functionName`` at 64 chars. Reserve the prefix (20) + a ``-`` + a 16-char
# timestamp (so 37 reserved) and bound the MLCC evaluator name to the remainder.
# The ARN path and the prompt path create no Lambda, so this applies only when the
# function source is local code (``--from-sample`` / a local ``.py``).
_LAMBDA_NAME_PREFIX = "SageMaker-evaluator-"
_LAMBDA_NAME_MAX = 64
_LAMBDA_TS_RESERVED = 17  # "-" + 16-char timestamp
EVALUATOR_NAME_BUDGET = _LAMBDA_NAME_MAX - len(_LAMBDA_NAME_PREFIX) - _LAMBDA_TS_RESERVED


def check_name_budget(name):
    """Return (ok, reason) for whether ``name`` fits the derived-Lambda budget.

    Only meaningful for the managed-Lambda (local-``.py`` / ``--from-sample``)
    reward-function path; the ARN and prompt paths provision no Lambda.
    """
    derived_len = len(_LAMBDA_NAME_PREFIX) + len(name or "") + _LAMBDA_TS_RESERVED
    if derived_len <= _LAMBDA_NAME_MAX:
        return True, ""
    return False, (
        f"evaluator name '{name}' is too long: the managed reward Lambda would be "
        f"named '{_LAMBDA_NAME_PREFIX}{name}-<timestamp>' ({derived_len} chars), "
        f"exceeding Lambda's {_LAMBDA_NAME_MAX}-char functionName limit. "
        f"Use a name of at most {EVALUATOR_NAME_BUDGET} characters."
    )


# ── MLCC-owned reward-Lambda deploy (--finalize) ───────────────────────────────


def _resolve_evaluator_bucket(region):  # noqa: ARG001 — kept for call-site compatibility
    """The bucket the reward-code backup is staged into: the CORE bucket (bucket
    consolidation R3.9 — evaluators are shared registered assets, like reward
    prompts, at evaluators/<name>/; the reward-Lambda role can read that prefix).
    Comes ONLY from the profile-resolved env (CORE_S3_BUCKET, passed by do/register
    from the profile key coreS3Bucket). Returns None when unset — the backup is
    best-effort, so the caller skips it rather than guessing a bucket name."""
    import os
    return os.environ.get("CORE_S3_BUCKET") or None


def _deploy_reward_lambda(*, name, local_py, role_arn, region):
    """Deploy ``local_py`` as a reward-function Lambda MLCC owns, returning its ARN.

    Mirrors what the SDK's Evaluator.create would do for a local source, but fixes
    its breakages: stages the code backup into the core bucket evaluators/<name>/ (not the
    nonexistent default), zips the file AS ``lambda_function.py`` so the standard
    ``lambda_function.lambda_handler`` entrypoint resolves (the materialized sample
    defines ``handler`` with a ``lambda_handler`` alias), and uses the dual-trust
    ``role_arn``. Idempotent on the function name: updates code if it already exists.
    """
    import io
    import os
    import zipfile
    import boto3

    # (a) Stage a readable backup of the source into the core bucket (evaluators/<name>/).
    import s3_layout  # noqa: PLC0415 — the single layout module
    bucket = _resolve_evaluator_bucket(region)
    key = s3_layout.evaluator_key(name)
    try:
        if not bucket:
            raise RuntimeError(
                "no core bucket in the active profile (coreS3Bucket); "
                "run: ml-container-creator bootstrap update --module core"
            )
        boto3.client("s3", region_name=region).upload_file(local_py, bucket, key)
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception as e:  # noqa: BLE001 — backup is best-effort, not fatal
        _warn(f"Could not stage reward-code backup to s3://{bucket}/{key}: {e}")

    # (b) Build the ZIP with the file named lambda_function.py so the handler
    # lambda_function.lambda_handler resolves (the sample exposes lambda_handler).
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(local_py, "lambda_function.py")
    zip_buf.seek(0)
    code_bytes = zip_buf.read()

    lam = boto3.client("lambda", region_name=region)
    fn_name = f"mlcc-reward-{name}"[:64]
    handler = "lambda_function.lambda_handler"
    runtime = "python3.12"

    # (c) Create (or update) the function with the dual-trust role.
    try:
        resp = lam.create_function(
            FunctionName=fn_name,
            Runtime=runtime,
            Role=role_arn,
            Handler=handler,
            Code={"ZipFile": code_bytes},
            Timeout=60,
            Description=f"MLCC reward function for evaluator '{name}'",
        )
        return resp["FunctionArn"]
    except lam.exceptions.ResourceConflictException:
        lam.update_function_code(FunctionName=fn_name, ZipFile=code_bytes)
        return lam.get_function(FunctionName=fn_name)["Configuration"]["FunctionArn"]


# ── Native evaluator create (both types) ───────────────────────────────────────


def _create_evaluator_native(*, name, source, evaluator_type, region,
                             description=None, role=None, domain_id=None):
    """Create a native AI Registry Evaluator asset of the given type.

    ``evaluator_type`` is the MLCC-facing string ``"reward_function"`` or
    ``"reward_prompt"`` — mapped here to the SDK's ``REWARD_FUNCTION`` /
    ``REWARD_PROMPT`` constants. Raises ``ai_registry_native.NativeRegistrySkipped``
    with a user-facing reason when the step is region/SDK-gated; lets genuine SDK
    errors propagate so the caller can surface them.

    Returns a result dict:
        {"arn", "version", "status", "type", "reference", "domain_tagged"}
    """
    import ai_registry_native as arn

    if not arn.region_supports_ai_registry(region):
        raise arn.NativeRegistrySkipped(
            f"region '{region}' does not support the AI Registry / evaluator assets "
            f"(supported: {', '.join(sorted(arn.AI_REGISTRY_REGIONS))}). "
            "Register in a supported region to enable managed RL."
        )
    if not arn.check_ai_registry_available():
        raise arn.NativeRegistrySkipped(
            "the installed sagemaker SDK does not expose sagemaker.ai_registry "
            "\u2014 upgrade sagemaker to enable native evaluator registration"
        )

    from sagemaker.ai_registry.air_constants import REWARD_FUNCTION, REWARD_PROMPT
    from sagemaker.ai_registry.evaluator import Evaluator

    type_member = REWARD_FUNCTION if evaluator_type == "reward_function" else REWARD_PROMPT

    create_kwargs = {
        "name": name,
        "source": source,
        "type": type_member,
    }
    if role:
        create_kwargs["role"] = role
    domain_tagged = False
    if domain_id:
        create_kwargs["domain_id"] = domain_id
        domain_tagged = True
    if description:
        create_kwargs["description"] = description

    evaluator = Evaluator.create(**create_kwargs)

    return {
        "arn": getattr(evaluator, "arn", None),
        "version": getattr(evaluator, "version", None),
        "status": getattr(evaluator, "status", None),
        "type": str(getattr(evaluator, "type", evaluator_type)),
        "reference": getattr(evaluator, "reference", source),
        "domain_tagged": domain_tagged,
    }


def _resolve_role_and_domain():
    """Resolve the evaluator role + Studio domain from the shared BL123 helpers."""
    import ai_registry_native as arn
    return arn.resolve_training_role(), arn.resolve_domain_id()


def _register(*, name, source, evaluator_type, region, description,
              verb, register_hint, role_override=None):
    """Shared register flow for both the evaluator and prompt verbs.

    ``role_override`` lets the managed-Lambda path pass the dual-trust
    reward-Lambda role instead of the default training role.

    NOTE: ``technique`` is intentionally NOT a parameter. It used to be echoed in
    the output JSON but was never persisted to the asset, resolvable, or consumed
    by do/tune (which uses its own --technique) — dead metadata. The evaluator
    TYPE (reward_function / reward_prompt) carries the meaningful distinction and
    IS persisted. The ``--technique`` CLI flag is still accepted-and-ignored for
    backward compatibility.
    """
    import ai_registry_native as arn

    role, domain_id = _resolve_role_and_domain()
    if role_override:
        role = role_override

    try:
        info = _create_evaluator_native(
            name=name, source=source, evaluator_type=evaluator_type, region=region,
            description=description, role=role, domain_id=domain_id,
        )
    except arn.NativeRegistrySkipped as skip:
        _error_exit(
            f"Evaluator registration skipped: {skip}",
            code="EVALUATOR_REGISTRATION_SKIPPED",
        )
    except Exception as e:  # noqa: BLE001 — surface SageMaker's error with guidance
        _error_exit(
            f"Failed to create the native evaluator '{name}' ({e}).\n"
            "    The evaluator role must be a SageMaker-trusted role carrying the\n"
            "    launch-gate IAM (the core execution role provisioned by\n"
            "    `ml-container-creator bootstrap`). If this is a permissions error, run\n"
            "    `mcc bootstrap update --module core` to refresh the role.",
            code="EVALUATOR_CREATE_FAILED",
        )

    if not info.get("domain_tagged"):
        print(
            "\u2139\ufe0f  Registered the evaluator but no Studio domain id is configured "
            "\u2014 it won't be tagged into Studio Assets. Provision the "
            "sagemaker-domain bootstrap module to enable Studio visibility.",
            file=sys.stderr,
        )
    print(
        f"Registered {verb} '{name}' ({info.get('type')}, native version "
        f"{info.get('version')}, status {info.get('status')}) \u2192 "
        f"{info.get('reference')}",
        file=sys.stderr,
    )

    _output({
        "name": name,
        "type": evaluator_type,
        "reference": info.get("reference"),
        "arn": info.get("arn"),
        "version": info.get("version"),
        "status": info.get("status"),
        "registered": True,
    })


# ── Subcommand: register-evaluator (REWARD_FUNCTION / code) ─────────────────────


def cmd_register_evaluator(args):
    """Register a code-based reward-function evaluator (REWARD_FUNCTION).

    Two concerns (Req 1 / 1A):
      (a) PRIMARY — an existing Lambda referenced by ``--arn`` (no managed Lambda,
          no dual-trust role).
      (b) OPTIONAL — ``--from-sample``: materialize an editable sample, then (with
          ``--finalize``) register it via the managed-Lambda path, which makes
          SageMaker create+own a Lambda and needs the dual-trust reward-Lambda
          role. Without ``--finalize`` this just writes the editable file and
          stops so the user edits the scorer first.
    """
    import os

    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    # --technique is accepted-and-ignored (back-compat): it was never persisted or
    # consumed; the evaluator TYPE carries the meaningful distinction.
    region = (
        getattr(args, "region", None)
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )

    from_sample = getattr(args, "from_sample", False)
    finalize = getattr(args, "finalize", False)
    arn = getattr(args, "arn", None) or getattr(args, "arn_or_uri", None)

    # ── Concern (b): editable doc-sourced sample on-ramp (Req 1A) ────────────
    if from_sample and not arn:
        import register_evaluator_sample as sample_mod

        local_py = sample_mod.sample_path_for(name)
        if not finalize:
            # Step 1: materialize the editable file and stop (user edits first).
            sample_mod.cmd_materialize_sample(args)
            return

        # Step 2 (--finalize): deploy the edited local .py as a Lambda WE own
        # (MLCC-owned deploy, not the SDK's _create_lambda_function), then register
        # the resulting ARN via the reliable --arn path. This fixes the SDK path's
        # three breakages: (a) it uploaded to a nonexistent default bucket
        # `sagemaker-<region>-<account>` → NoSuchBucket; we use the core bucket evaluators prefix;
        # (b) it hardcodes handler `lambda_function.lambda_handler`; we zip the file
        # AS `lambda_function.py` so that handler resolves; (c) it needs the
        # dual-trust role, now provisioned by the training bootstrap module and
        # threaded as MLCC_REWARD_LAMBDA_ROLE_ARN.
        if not os.path.exists(local_py):
            _error_exit(
                f"No reward function found at {local_py}. Run "
                f"`./do/register evaluator {name} --from-sample` first to "
                "materialize and edit it.",
                code="SAMPLE_NOT_MATERIALIZED",
            )
        ok, reason = check_name_budget(name)
        if not ok:
            _error_exit(reason, code="EVALUATOR_NAME_TOO_LONG")

        role_arn = os.environ.get("MLCC_REWARD_LAMBDA_ROLE_ARN")
        if not role_arn:
            _error_exit(
                "MLCC_REWARD_LAMBDA_ROLE_ARN is not set. The reward Lambda needs the "
                "dual-trust (sagemaker + lambda) role provisioned by the training "
                "bootstrap module. Re-provision it with:\n"
                "    ml-container-creator bootstrap --module training\n"
                "then retry. (Alternatively, deploy your own Lambda and register it "
                "with --arn <lambda-arn>.)",
                code="MISSING_REWARD_LAMBDA_ROLE",
            )

        lambda_arn = _deploy_reward_lambda(
            name=name, local_py=local_py, role_arn=role_arn, region=region,
        )
        print(
            f"\u2713 Deployed reward Lambda for '{name}': {lambda_arn}",
            file=sys.stderr,
        )
        # Register the ARN we just created — the reliable, reference-only path.
        _register(
            name=name, source=lambda_arn, evaluator_type="reward_function",
            region=region,
            description=getattr(args, "description", None),
            verb="evaluator", register_hint="do/register evaluator",
        )
        return

    # ── Concern (a): bring-your-own-Lambda by ARN (primary) ──────────────────
    if not arn:
        _error_exit(
            "--arn is required: pass the ARN of an existing reward-function Lambda.\n"
            "    (No Lambda yet? `do/register evaluator <name> --from-sample` seeds "
            "an editable one.)",
            code="MISSING_ARGUMENT",
        )

    _register(
        name=name, source=arn, evaluator_type="reward_function",
        region=region,
        description=getattr(args, "description", None),
        verb="evaluator", register_hint="do/register evaluator",
    )


# ── Subcommand: register-prompt (REWARD_PROMPT / LLM-as-judge) ──────────────────


def cmd_register_prompt(args):
    """Register a prompt-based reward evaluator (REWARD_PROMPT) for RLAIF.

    Option-1 sugar over the same ``Evaluator.create`` — the ``do/register prompt``
    verb lands a REWARD_PROMPT evaluator in the AI Registry from an S3 prompt file.
    """
    import os

    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    source = getattr(args, "prompt", None) or getattr(args, "arn_or_uri", None)
    if not source:
        _error_exit(
            "--prompt is required: pass the S3 URI of the reward prompt file.",
            code="MISSING_ARGUMENT",
        )

    region = (
        getattr(args, "region", None)
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )

    _register(
        name=name, source=source, evaluator_type="reward_prompt",
        region=region,
        description=getattr(args, "description", None),
        verb="prompt", register_hint="do/register prompt",
    )

    # BL167 R2: ADDITIVELY register the reward prompt in the MLflow GenAI Prompt
    # Registry (the AI-Registry evaluator above stays the Studio record + the
    # deploy-time reference do/tune resolves). Under the OQ-1 hybrid: the AI
    # Registry create already succeeded (fatal, done); the MLflow copy is
    # additive — a transient unreachable App WARNS and reconciles on re-run, a
    # real error is surfaced. Reward FUNCTIONS register nothing to MLflow.
    try:
        import mlcc_mlflow
        if mlcc_mlflow._mlflow_configured() and source.startswith("s3://"):
            template = _read_s3_text(source, region)
            if template:
                mlcc_mlflow.hybrid_record(
                    local_write=lambda: None,  # AI Registry already wrote the record
                    mlflow_write=lambda: mlcc_mlflow.register_prompt_native(name, template),
                    name=name, kind="prompt",
                )
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception as e:  # noqa: BLE001 — the AI Registry asset already stands
        import sys
        print(f"\u26a0\ufe0f  MLflow Prompt Registry copy skipped ({e}); the AI "
              "Registry evaluator stands.", file=sys.stderr)


def _read_s3_text(s3_uri, region=None):
    """Read a small text object (a reward prompt file) from S3; '' on any failure."""
    try:
        import boto3
        from urllib.parse import urlparse
        p = urlparse(s3_uri)
        obj = boto3.client("s3", region_name=region).get_object(
            Bucket=p.netloc, Key=p.path.lstrip("/"),
        )
        return obj["Body"].read().decode("utf-8")
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:  # noqa: BLE001 — best-effort; no template → skip MLflow copy
        return ""
