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
            "    launch-gate IAM (provisioned by `ml-container-creator bootstrap`,\n"
            "    module `training`). If this is a permissions error, run\n"
            "    `mcc bootstrap update --module training` to refresh the role.",
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

        # Step 2 (--finalize): register the edited local .py via the managed-Lambda
        # path. This is where the dual-trust role is required.
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
        _warn(
            "Registering from a local reward function makes SageMaker create and "
            "own a managed Lambda. This needs a DUAL-TRUST reward-Lambda role "
            "(trusted by BOTH sagemaker.amazonaws.com AND lambda.amazonaws.com) "
            "plus iam:PassRole \u2014 NOT the plain training role. Set "
            "MLCC_REWARD_LAMBDA_ROLE_ARN to that role, or the create will fail "
            "with a Lambda trust error. See docs/fine-tuning.md."
        )
        role_override = os.environ.get("MLCC_REWARD_LAMBDA_ROLE_ARN")
        _register(
            name=name, source=local_py, evaluator_type="reward_function",
            region=region,
            description=getattr(args, "description", None),
            verb="evaluator", register_hint="do/register evaluator",
            role_override=role_override,
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
