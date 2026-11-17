from __future__ import annotations
"""Native SageMaker AI Registry helpers (BL123).

Shared, dependency-light helpers for the native `sagemaker.ai_registry` path:
datasets register natively (and, via BL117, evaluators) so they appear in Studio
Assets, while MLCC's S3 sidecar stays the durable write record. Everything here is
NON-FATAL by contract — the caller's sidecar/MLflow path must survive any failure.

Key spike-derived facts (BL122, verified against sagemaker 3.23.0):
  - The AI Registry hub is COMPUTED (`AiRegistry-<region>-<account>`), NOT
    targetable; `DataSet.create` takes no hub kwarg. We use the SDK's native hub.
  - Studio Assets visibility requires passing `domain_id` (the `@domain` tag).
  - `DataSet.create(name, source, customization_technique=<member>, role=,
    domain_id=)` keeps a `source` S3 pointer (no copy) and auto-increments the
    native semver on same-name re-create.
  - `ai_registry` + Studio Lineage are region-gated.

This module hardcodes NO per-technique knowledge beyond the single label→member
map below (Req 11.3, derive-dont-hardcode): the SDK enum is the source of the
member set, and the map is the single place MLCC's technique labels bind to it.
"""

import json
import os
import sys

from register_common import _CONFIG_PATH

# Regions where ai_registry + Studio Lineage are available (Req 7.1).
AI_REGISTRY_REGIONS = frozenset({
    "us-east-1", "us-west-2", "ap-northeast-1", "eu-west-1",
})

# ── MLCC technique label → native CustomizationTechnique member name ───────────
#
# The native `CustomizationTechnique` enum NAMES only {SFT, DPO, RLVR} (verified
# sagemaker 3.23.0). MLCC accepts a wider set of *labels* on `do/register dataset`
# and maps each to the compatible native member (Req 11):
#   - SFT, DPO           → their own member (dataset-driven techniques).
#   - RLVR               → RLVR member.
#   - RLAIF, MTRL        → the RLVR member (their training input is a prompt
#                          corpus of the same shape); the INTENDED technique is
#                          recorded in the S3 sidecar so do/tune can resolve it.
#   - benchmark          → None: sidecar-only, NOT registered natively (it is an
#                          AIPerf BYOD benchmark corpus, not a customization input).
# A value of None means "no native member" → skip the native create, keep the
# sidecar. A label absent from this map is a reward ARTIFACT or an unknown value
# and is rejected by the caller with guidance to the evaluator verbs.
_TECHNIQUE_TO_MEMBER = {
    "sft": "SFT",
    "dpo": "DPO",
    "rlvr": "RLVR",
    "rlaif": "RLVR",
    "mtrl": "RLVR",
    "benchmark": None,
}

# Labels that are genuine reward ARTIFACTS, not datasets — rejected by
# do/register dataset with guidance to the evaluator verbs (Req 11.5).
_REWARD_ARTIFACT_LABELS = frozenset({"reward-prompt", "reward_prompt", "reward-function", "reward_function"})


def dataset_techniques():
    """The dataset technique labels do/register dataset accepts (sorted)."""
    return sorted(_TECHNIQUE_TO_MEMBER.keys())


def is_reward_artifact_label(label):
    """True when the label names a reward artifact (an evaluator, not a dataset)."""
    return (label or "").strip().lower() in _REWARD_ARTIFACT_LABELS


def native_member_for(technique):
    """Return (member_name, recognized) for an MLCC technique label.

    member_name is the native CustomizationTechnique member string to pass to
    DataSet.create, or None when the technique is sidecar-only (benchmark).
    recognized is False when the label is unknown (caller rejects it).
    """
    key = (technique or "").strip().lower()
    if key not in _TECHNIQUE_TO_MEMBER:
        return None, False
    return _TECHNIQUE_TO_MEMBER[key], True


# Data-file extensions the native registry can download + validate as a single
# object, in preference order (parquet first for managed-RL verl channels).
_NATIVE_SOURCE_EXTS = (".parquet", ".jsonl", ".ndjson", ".json")


def _is_prefix_uri(s3_uri):
    """True when the S3 URI names a prefix (trailing '/') rather than an object."""
    return isinstance(s3_uri, str) and s3_uri.startswith("s3://") and s3_uri.endswith("/")


def _resolve_prefix_to_object(s3_uri, region):
    """Resolve an s3:// PREFIX to a single representative data object URI.

    Lists the prefix and returns the s3:// URI of one data file, preferring
    parquet, then jsonl/ndjson/json. Ignores the `_dataset.json` sidecar and any
    hidden/zero-byte keys. Returns None if the prefix holds no registrable data
    object (caller then skips native registration with a clear reason). Best-effort:
    any listing error returns None rather than raising (native path is non-fatal).
    """
    try:
        import boto3
        from urllib.parse import urlparse

        parsed = urlparse(s3_uri)
        bucket = parsed.netloc
        prefix = parsed.path.lstrip("/")
        s3 = boto3.client("s3", region_name=region)
        candidates = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                base = key.rsplit("/", 1)[-1]
                if not base or base.startswith(".") or base == "_dataset.json":
                    continue
                if obj.get("Size", 0) <= 0:
                    continue
                if base.lower().endswith(_NATIVE_SOURCE_EXTS):
                    candidates.append(key)
        if not candidates:
            return None

        def _rank(key):
            low = key.lower()
            for i, ext in enumerate(_NATIVE_SOURCE_EXTS):
                if low.endswith(ext):
                    return i
            return len(_NATIVE_SOURCE_EXTS)

        candidates.sort(key=lambda k: (_rank(k), k))
        return f"s3://{bucket}/{candidates[0]}"
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:  # noqa: BLE001 — prefix resolution is best-effort (non-fatal)
        return None


def check_ai_registry_available():
    """True when the installed sagemaker SDK exposes sagemaker.ai_registry.

    Reuses the dormant probe shape from register_model._check_ai_registry so a
    too-old SDK degrades to the sidecar path with a clear upgrade message instead
    of raising a raw ImportError (Req 7.2).
    """
    try:
        from sagemaker.ai_registry.dataset import DataSet  # noqa: F401
        return True
    except Exception:  # noqa: BLE001 — any import/attr failure = not available
        return False


def region_supports_ai_registry(region):
    """True when the region supports ai_registry + Studio Lineage (Req 7.1)."""
    return (region or "") in AI_REGISTRY_REGIONS


def _active_profile_data():
    """Return the active profile dict from ~/.ml-container-creator/config.json.

    Mirrors the active-profile resolution used elsewhere (activeProfile key →
    profiles map). Returns {} when the config/profile is missing or unreadable so
    callers degrade gracefully.
    """
    try:
        with open(_CONFIG_PATH) as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    profiles = config.get("profiles") or {}
    active = config.get("activeProfile")
    if active and active in profiles and isinstance(profiles[active], dict):
        return profiles[active]
    # Fall back to the first profile dict if no active one is marked.
    for data in profiles.values():
        if isinstance(data, dict):
            return data
    return {}


def resolve_domain_id():
    """Return the Studio Domain_Id from the active profile, or None (Req 3.2/3.3).

    Prefer the denormalized top-level ``domainId`` the bootstrap writes, but FALL
    BACK to ``moduleOutputs['sagemaker-domain'].DomainId`` when it is absent. The
    bootstrap denormalizer only backfills the top-level key when it runs with the
    sagemaker-domain module in its outputs, so a profile provisioned with the
    module BEFORE that step existed (or via an add-module that short-circuited on
    "already provisioned") has the DomainId in moduleOutputs but no top-level key.
    Reading both makes resolution independent of denormalization timing.

    Absent in both → the asset is still created natively but without the @domain
    tag (not Studio-visible); the caller notes this and does not fail.
    """
    profile = _active_profile_data()
    domain_id = profile.get("domainId")
    if not domain_id:
        module_outputs = profile.get("moduleOutputs") or {}
        sm_domain = module_outputs.get("sagemaker-domain") or {}
        if isinstance(sm_domain, dict):
            domain_id = sm_domain.get("DomainId")
    return domain_id or None


def resolve_training_role():
    """Return the training role ARN from the active profile, or None.

    DataSet.create needs a sagemaker-trusted role (the launch gate). Falls back to
    an explicit env override so a caller can pass one in CI.
    """
    return (
        os.environ.get("MLCC_TRAINING_ROLE_ARN")
        or _active_profile_data().get("roleArn")
        or None
    )


class NativeRegistrySkipped(Exception):
    """Raised to signal a non-fatal skip with a user-facing reason."""


# SageMaker hub-content name constraint (ImportHubContent): the name must match
# ``[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}`` — ONLY alphanumerics and hyphens, must start
# with an alphanumeric, max 63 chars. This is STRICTER than MLflow's name rules
# (mlcc_mlflow.sanitize_name keeps underscores, which are valid for MLflow), so the
# native path needs its OWN sanitizer — otherwise a perfectly valid MLflow/dataset
# name like ``Intel_orca_dpo`` is accepted by MLflow but REJECTED by the AI Registry
# with a ValidationException, and (because native registration is non-fatal) the
# failure is swallowed and the dataset silently never appears in Studio Assets
# (BL171). Do NOT "fix" this by changing sanitize_name — underscores must stay legal
# for MLflow; the hub-content regex is a native-only constraint.
def sanitize_hub_content_name(name):
    """Coerce an arbitrary dataset name into a SageMaker hub-content name.

    Maps any character outside ``[A-Za-z0-9]`` to ``-``, collapses runs of ``-``,
    trims leading/trailing ``-``, and truncates to 63 chars (re-trimming a trailing
    ``-`` left by truncation). Guarantees a leading alphanumeric by prefixing ``d-``
    when the result would otherwise start non-alphanumeric or be empty. Idempotent
    on an already-valid name. Returns a string matching
    ``[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}``.
    """
    import re
    if not isinstance(name, str):
        name = str(name)
    # Replace every illegal char with a hyphen, then collapse/trim hyphen runs.
    safe = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    # Must start with an alphanumeric (the regex's first char class).
    if not safe or not safe[0].isalnum():
        safe = "d-" + safe.lstrip("-")
    # Max 63 chars; truncation may leave a trailing hyphen, so re-trim.
    safe = safe[:63].rstrip("-")
    return safe or "dataset"


def register_dataset_native(*, name, s3_uri, technique, region,
                            description=None, role=None, domain_id=None):
    """Create (or version++) a native AI Registry DataSet for Studio discoverability.

    Additive + NON-FATAL (Req 1.5): the caller has already written the durable S3
    sidecar; this layers a versioned, Studio-discoverable entry pointing at the
    SAME S3 URI (no copy). Returns a result dict on success:
        {"arn": <hub-content-arn>, "version": <native semver>, "member": <member>,
         "domain_tagged": <bool>}
    Raises NativeRegistrySkipped (non-fatal, with reason) when the step is skipped
    (region/SDK/technique) and lets genuine SDK errors propagate to the caller,
    which converts them to a warning.

    `technique` is an MLCC label (sft/dpo/rlvr/rlaif/mtrl/benchmark); the mapping
    to the native member is applied here via the single map.
    """
    member, recognized = native_member_for(technique)
    if not recognized:
        raise NativeRegistrySkipped(
            f"technique '{technique}' has no native AI Registry member"
        )
    if member is None:
        raise NativeRegistrySkipped(
            f"technique '{technique}' is sidecar-only (not a customization input)"
        )

    if not region_supports_ai_registry(region):
        raise NativeRegistrySkipped(
            f"region '{region}' does not support the AI Registry / Studio Lineage "
            f"(supported: {', '.join(sorted(AI_REGISTRY_REGIONS))})"
        )

    if not check_ai_registry_available():
        raise NativeRegistrySkipped(
            "the installed sagemaker SDK does not expose sagemaker.ai_registry "
            "— upgrade sagemaker to enable native asset registration"
        )

    from sagemaker.ai_registry.dataset import CustomizationTechnique, DataSet

    technique_member = getattr(CustomizationTechnique, member, None)
    if technique_member is None:
        raise NativeRegistrySkipped(
            f"the installed SDK's CustomizationTechnique has no '{member}' member"
        )

    # The AI Registry hub-content name is STRICTER than the dataset/MLflow name
    # (no underscores, leading alnum, <=63 chars). Sanitize here so a valid MLflow
    # name is never silently rejected by ImportHubContent (BL171). Note the
    # remap so the user can find the Studio asset under its sanitized name.
    hub_name = sanitize_hub_content_name(name)
    if hub_name != name:
        print(
            f"\u2139\ufe0f  AI Registry asset name '{name}' \u2192 '{hub_name}' "
            "(hub-content names allow only letters, digits, and hyphens).",
            file=sys.stderr,
        )

    # The SDK's DataSet.create downloads the source as a SINGLE object
    # (AIRHub.download_from_s3 → s3.download_file) and validates its format. A
    # prefix source (e.g. the managed-RL verl training channel 's3://.../data/')
    # therefore 404s — you cannot HeadObject/GetObject a prefix. The training
    # channel legitimately IS a prefix (ODP-2), so we keep the sidecar/channel URI
    # as the prefix but point the STUDIO-DISCOVERABLE native asset at a single
    # representative data object inside it. This is why RLVR/RLAIF/MTRL datasets
    # (parquet-dir sources) never appeared in Studio Assets while DPO (single-file
    # source) did.
    native_source = s3_uri
    if _is_prefix_uri(s3_uri):
        resolved = _resolve_prefix_to_object(s3_uri, region)
        if resolved is None:
            raise NativeRegistrySkipped(
                f"source '{s3_uri}' is a prefix with no single registrable data "
                "object; the training channel is registered in the S3 sidecar, but "
                "the native AI Registry needs a single file"
            )
        native_source = resolved
        print(
            f"\u2139\ufe0f  AI Registry source '{s3_uri}' \u2192 '{native_source}' "
            "(native registry needs a single file; training channel stays the prefix).",
            file=sys.stderr,
        )

    create_kwargs = {
        "name": hub_name,
        "source": native_source,
        "customization_technique": technique_member,
    }
    if role:
        create_kwargs["role"] = role
    domain_tagged = False
    if domain_id:
        create_kwargs["domain_id"] = domain_id
        domain_tagged = True
    if description:
        create_kwargs["description"] = description

    dataset = DataSet.create(**create_kwargs)

    return {
        "arn": getattr(dataset, "arn", None),
        "version": getattr(dataset, "version", None),
        "member": member,
        # The hub-content name actually used (sanitized from the caller's name when
        # it contained hub-illegal chars). Surfaced so the caller can record the
        # AI-Registry identity alongside the dataset/MLflow name when they differ.
        "hub_content_name": hub_name,
        "domain_tagged": domain_tagged,
    }
