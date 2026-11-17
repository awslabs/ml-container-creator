from __future__ import annotations
"""Register resolve: resolve datasets, evaluators, and model versions by name.

Purpose: cmd_resolve_dataset, cmd_resolve_evaluator, cmd_get_version subcommands
Inputs: --name, --version, --arn, --region
Outputs: JSON with resolved dataset/evaluator/version details
Caller: .register_helper.py dispatcher
Related: register_common.py (registry I/O), register_dataset.py (hub helpers)
"""

import json
import os
import sys

from common import _output, _error_exit, _check_sagemaker_core
import dataset_store
from register_dataset import _resolve_core_bucket
from register_model import _extract_version_from_arn, _check_ai_registry


class DatasetResolveError(Exception):
    """Resolution could not be attempted or completed for a non-not-found reason.

    Covers transport/permission errors, MLflow failures, and a missing Core
    bucket — i.e. cases distinct from "the dataset legitimately does not exist".
    Carries an optional ``code`` so the CLI can preserve its structured error
    codes (SIDECAR_READ_FAILED / MLFLOW_UNAVAILABLE / MISSING_CORE_BUCKET, ...).
    """

    def __init__(self, message, code="SIDECAR_READ_FAILED"):
        super().__init__(message)
        self.code = code


class DatasetNotFoundError(Exception):
    """No sidecar exists for the dataset name (or MLflow has no such input)."""


class DatasetVersionNotFoundError(Exception):
    """A specific version was requested but not present in the sidecar."""

    def __init__(self, message, available=None):
        super().__init__(message)
        self.available = available or []


def _select_version(versions, version_spec):
    """Select a version entry by ordinal or semver from a sidecar versions list.

    Returns (entry, ordinal) or (None, None) if not found. version_spec=None
    selects the latest version.
    """
    if not versions:
        return None, None

    if version_spec is None:
        return versions[-1], len(versions)

    # Ordinal (e.g. "2")
    try:
        ordinal = int(version_spec)
        if 1 <= ordinal <= len(versions):
            return versions[ordinal - 1], ordinal
        return None, None
    except ValueError:
        pass

    # Semver (e.g. "1.0.0")
    for i, v in enumerate(versions, 1):
        if v.get("version") == version_spec:
            return v, i
    return None, None


def _version_not_found(name, version_spec, versions):
    """Emit a VERSION_NOT_FOUND error (distinct from transport error)."""
    available = []
    for i, v in enumerate(versions, 1):
        ver_str = v.get("version", f"{i}.0.0")
        available.append({"ordinal": i, "version": ver_str})
        print(f"  v{i} ({ver_str})", file=sys.stderr)
    print(f"Error: Version {version_spec} not found for dataset '{name}'", file=sys.stderr)
    print(json.dumps({
        "error": f"Version {version_spec} not found for dataset '{name}'",
        "code": "VERSION_NOT_FOUND",
        "available_versions": available,
    }))
    sys.exit(1)


def cmd_resolve_dataset(args):
    """Resolve a registered dataset by name from the S3 sidecar.

    Version pinning: --version accepts an ordinal ("2") or semver ("1.0.0").
    Not-found (no sidecar / no matching version) exits non-zero with a
    DATASET_NOT_FOUND / VERSION_NOT_FOUND code, distinct from a transport error.
    """
    name = args.name
    version_spec = getattr(args, "version", None)

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    # Resolve core bucket up front so we can preserve the CLI's distinct
    # MISSING_CORE_BUCKET error (only meaningful for the non-MLflow S3 path).
    import mlcc_mlflow
    core_bucket = None
    if not mlcc_mlflow._mlflow_configured():
        core_bucket = _resolve_core_bucket(args)
        if not core_bucket:
            _error_exit(
                "Could not resolve the MLCC Core bucket for dataset resolution.\n"
                "    Pass --core-bucket <bucket> or set CORE_BUCKET.",
                code="MISSING_CORE_BUCKET",
            )

    try:
        resolved = resolve_dataset_uri(
            name,
            version=version_spec,
            region=getattr(args, "region", None),
            core_bucket=core_bucket,
            project_name=getattr(args, "project_name", None),
            all_projects=getattr(args, "all_projects", False),
        )
    except DatasetVersionNotFoundError as e:
        _version_not_found(name, version_spec, e.available)
    except DatasetNotFoundError:
        _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")
    except DatasetResolveError as e:
        # Transport / MLflow / permission error — distinct exit code (3) from
        # not-found so bash callers can tell "couldn't reach registry" apart
        # from "no such dataset". Preserve the structured error code.
        print(json.dumps({"error": str(e), "code": e.code}))
        print(f"\u26a0\ufe0f  {e}", file=sys.stderr)
        sys.exit(3)

    _output(resolved)


def resolve_dataset_uri(name, *, version=None, region=None, core_bucket=None,
                        s3_client=None, project_name=None, all_projects=False):
    """Resolve a registered dataset name to its S3 URI and metadata.

    Shared resolution core used by both the ``resolve-dataset`` CLI
    (``cmd_resolve_dataset``) and other consumers (e.g. the do/benchmark
    dataset-picker BYOD path, BL100) so the sidecar/MLflow lookup lives in one
    place rather than being duplicated per caller.

    Version pinning: ``version`` accepts an ordinal ("2") or semver ("1.0.0");
    ``None`` selects the latest.

    Returns a dict with at least ``name``, ``s3_uri``, and ``format`` (plus
    ``arn``, ``technique``, ``version``, ``ordinal``, ``hash`` when available).

    Raises:
        DatasetNotFoundError: no sidecar / no matching version.
        DatasetVersionNotFoundError: a pinned version is not present.
        DatasetResolveError: transport/permission error, MLflow failure, or a
            missing Core bucket (resolution could not be completed — distinct
            from not-found).

    Unlike ``cmd_resolve_dataset`` this never calls ``sys.exit`` — callers
    decide how to surface failures.
    """
    if not name:
        raise DatasetResolveError("dataset name is required", code="MISSING_ARGUMENT")

    region = (
        region
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )

    # BL110: when MLflow is configured, resolve by name from MLflow run inputs
    # instead of the S3 sidecar.
    import mlcc_mlflow
    if mlcc_mlflow._mlflow_configured():
        try:
            entry = mlcc_mlflow.resolve_dataset_by_name(
                name, project_name=project_name, all_projects=all_projects,
            )
        except mlcc_mlflow.MlflowUnavailableError as e:
            raise DatasetResolveError(str(e), code="MLFLOW_UNAVAILABLE") from e
        except Exception as e:  # noqa: BLE001 — surface, do not silently fall back
            raise DatasetResolveError(str(e), code="MLFLOW_RESOLVE_FAILED") from e

        if entry is None:
            raise DatasetNotFoundError(f"Dataset not found: {name}")

        meta = entry.get("meta") or {}
        return {
            "name": entry.get("name", mlcc_mlflow.sanitize_name(name)),
            "s3_uri": entry.get("s3_uri", "") or meta.get("s3_uri", ""),
            "arn": meta.get("arn"),
            "format": meta.get("format", "jsonl"),
            "technique": meta.get("technique", ""),
            "version": meta.get("latest_version", "1.0.0"),
            "ordinal": meta.get("ordinal"),
            "hash": entry.get("digest"),
        }

    if not core_bucket:
        raise DatasetResolveError(
            "Could not resolve the MLCC Core bucket for dataset resolution. "
            "Pass core_bucket or set CORE_BUCKET.",
            code="MISSING_CORE_BUCKET",
        )

    s3 = s3_client if s3_client is not None else dataset_store._get_s3_client(region)

    try:
        sidecar = dataset_store.read_sidecar(s3, core_bucket, name)
    except dataset_store.TransportError as e:
        raise DatasetResolveError(str(e), code="SIDECAR_READ_FAILED") from e

    if sidecar is None:
        raise DatasetNotFoundError(f"Dataset not found: {name}")

    # BL167 (R4 / OQ-2): the VERSION ledger stays in the sidecar. mlflow.data
    # Datasets have no first-class semver ledger (unlike the Model Registry), so
    # @v<N> / semver pinning resolves from the sidecar `versions` array for both
    # pre- and post-BL167 datasets. Deprecating the sidecar version ledger is a
    # later patch if MLflow gains a fit; until then the sidecar is the index even
    # when MLflow holds the catalog.
    versions = sidecar.get("versions") or []
    entry, ordinal = _select_version(versions, version)

    if entry is None:
        if version is not None:
            raise DatasetVersionNotFoundError(
                f"Version {version} not found for dataset '{name}'",
                available=versions,
            )
        raise DatasetNotFoundError(f"Dataset not found: {name}")

    return {
        "name": name,
        "s3_uri": entry.get("s3_uri", sidecar.get("s3_uri", "")),
        "arn": entry.get("arn", sidecar.get("arn")),
        "format": entry.get("format", sidecar.get("format", "jsonl")),
        "technique": entry.get("technique", sidecar.get("technique", "")),
        "version": entry.get("version", "1.0.0"),
        "ordinal": ordinal,
        "hash": entry.get("hash"),
    }


def _native_hub_name(sm_client, region):
    """Resolve the computed native AI Registry hub name (AiRegistry-<region>-<acct>).

    The SDK computes its own hub; we discover it by listing hubs and matching the
    ``AiRegistry-`` prefix (falling back to deriving it from the caller account).
    Returns None when it cannot be determined.
    """
    try:
        token = None
        while True:
            kw = {"NextToken": token} if token else {}
            resp = sm_client.list_hubs(**kw)
            for h in resp.get("HubSummaries", []):
                hub_name = h.get("HubName", "")
                if hub_name.startswith("AiRegistry-"):
                    return hub_name
            token = resp.get("NextToken")
            if not token:
                break
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:  # noqa: BLE001 — fall through to the derived name
        pass

    try:
        import boto3
        account = boto3.client("sts", region_name=region).get_caller_identity()["Account"]
        return f"AiRegistry-{region}-{account}"
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:  # noqa: BLE001
        return None


def _resolve_evaluator_native(name, region):
    """Resolve a native evaluator by name via the AI Registry SDK.

    Uses ``Evaluator.get(name)`` — the SDK's own resolution, which locates the
    AI Registry hub the same way ``Evaluator.create`` does. (An earlier
    implementation called ``describe_hub_content`` against a GUESSED hub name
    ``AiRegistry-<region>-<account>``; the real SDK-created hub has an opaque
    generated id, so the guess never matched and resolution always failed with
    "not found" even for assets that existed — which also broke
    ``do/tune --evaluator-name``.)

    Returns ``{name, type, reference, arn, version}`` or None when not found.
    ``type`` is the MLCC-facing ``reward_function``/``reward_prompt`` string so
    ``do/tune`` routes it to the right job input. Raises on transport/permission
    errors (distinct from not-found).
    """
    from sagemaker.ai_registry.evaluator import Evaluator

    try:
        ev = Evaluator.get(name)
    except Exception as e:  # noqa: BLE001
        if "ResourceNotFound" in type(e).__name__ or "does not exist" in str(e) \
                or "not found" in str(e).lower():
            return None
        raise

    if ev is None:
        return None

    return {
        "name": getattr(ev, "name", name),
        "type": _sdk_type_to_mlcc(getattr(ev, "type", "")),
        "reference": getattr(ev, "reference", "") or "",
        "arn": getattr(ev, "arn", None),
        "version": getattr(ev, "version", None),
    }


def cmd_resolve_evaluator(args):
    """Resolve a registered evaluator by name from the native AI Registry.

    BL117 retired the local ``evaluators.json`` as the record of truth; evaluators
    are native ``sagemaker.ai_registry`` assets. Resolution reads the native hub.
    Returns ``{name, type, reference, arn, version}``; ``type`` is
    ``reward_function`` (RLVR/MTRL) or ``reward_prompt`` (RLAIF) so ``do/tune``
    threads the right job input.
    """
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    region = (
        getattr(args, "region", None)
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )

    # SDK-floor / region guard: outside a supported region (or on an SDK without
    # ai_registry) the native hub cannot be read — surface a clear not-supported
    # error rather than a raw boto failure.
    try:
        import ai_registry_native as _arn
        if not _arn.region_supports_ai_registry(region):
            _error_exit(
                f"Evaluators are not available in region '{region}'. "
                f"Managed RL evaluators require one of: "
                f"{', '.join(sorted(_arn.AI_REGISTRY_REGIONS))}.",
                code="EVALUATOR_REGION_UNSUPPORTED",
            )
    except ImportError:
        pass

    try:
        resolved = _resolve_evaluator_native(name, region)
    except Exception as e:  # noqa: BLE001 — transport/permission (distinct from not-found)
        print(json.dumps({"error": str(e), "code": "EVALUATOR_RESOLVE_FAILED"}))
        print(f"\u26a0\ufe0f  Failed to resolve evaluator '{name}': {e}", file=sys.stderr)
        sys.exit(3)

    if resolved is None:
        _error_exit(f"Evaluator not found: {name}", code="EVALUATOR_NOT_FOUND")

    _output(resolved)


def _sdk_type_to_mlcc(sdk_type):
    """Map an SDK evaluator type (``RewardFunction``/``RewardPrompt``) to the
    MLCC-facing string (``reward_function``/``reward_prompt``)."""
    return "reward_prompt" if "prompt" in str(sdk_type).lower() else "reward_function"


def _list_evaluators_native(region, evaluator_type=None):
    """List native evaluator assets via the AI Registry SDK.

    Uses ``Evaluator.get_all()`` — the SDK's own enumeration, which resolves the
    AI Registry hub exactly the way ``Evaluator.create`` does. (An earlier
    implementation listed ``JsonDoc`` hub content via a GUESSED hub name
    ``AiRegistry-<region>-<account>``; the real SDK-created hub has an opaque
    generated id, so the guess never matched and listing always came back empty.)

    ``evaluator_type`` (optional MLCC string) filters to REWARD_FUNCTION or
    REWARD_PROMPT. Returns ``{name, type, version, arn, reference}`` dicts. Raises
    on transport/permission errors.
    """
    from sagemaker.ai_registry.evaluator import Evaluator
    from sagemaker.ai_registry.air_constants import REWARD_FUNCTION, REWARD_PROMPT

    sdk_type = None
    if evaluator_type == "reward_function":
        sdk_type = REWARD_FUNCTION
    elif evaluator_type == "reward_prompt":
        sdk_type = REWARD_PROMPT

    try:
        results = Evaluator.get_all(type=sdk_type) if sdk_type else Evaluator.get_all()
    except Exception as e:  # noqa: BLE001
        if "ResourceNotFound" in type(e).__name__ or "does not exist" in str(e):
            return []
        raise

    out = []
    for ev in list(results or []):
        name = getattr(ev, "name", None)
        if not name:
            continue
        out.append({
            "name": name,
            "type": _sdk_type_to_mlcc(getattr(ev, "type", "")),
            "version": getattr(ev, "version", None),
            "arn": getattr(ev, "arn", None),
            "reference": getattr(ev, "reference", None),
        })
    return out


def cmd_list_evaluators(args):
    """List registered evaluators from the native AI Registry.

    Discovery parity with ``list-datasets``: evaluators/prompts were only
    resolvable by name before. ``--evaluator-type reward_function|reward_prompt``
    filters to one kind so ``do/register evaluator --list`` (reward functions) and
    ``do/register prompt --list`` (reward prompts) each show the relevant set.
    """
    region = (
        getattr(args, "region", None)
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )
    evaluator_type = getattr(args, "evaluator_type", None)

    try:
        import ai_registry_native as _arn
        if not _arn.region_supports_ai_registry(region):
            _error_exit(
                f"Evaluators are not available in region '{region}'. "
                f"Managed RL evaluators require one of: "
                f"{', '.join(sorted(_arn.AI_REGISTRY_REGIONS))}.",
                code="EVALUATOR_REGION_UNSUPPORTED",
            )
    except ImportError:
        pass

    try:
        evaluators = _list_evaluators_native(region, evaluator_type)
    except Exception as e:  # noqa: BLE001 — transport/permission (distinct from empty)
        print(json.dumps({"error": str(e), "code": "EVALUATOR_LIST_FAILED"}))
        print(f"\u26a0\ufe0f  Failed to list evaluators: {e}", file=sys.stderr)
        sys.exit(3)

    _output({"evaluators": evaluators, "count": len(evaluators)})


def cmd_get_version(args):
    """Get details for a specific model package version by ARN."""
    _check_sagemaker_core()

    version_arn = args.arn
    if not version_arn:
        _error_exit("--arn is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)

        pkg_response = sm_client.describe_model_package(ModelPackageName=version_arn)

        model_data_url = ""
        inference_spec = pkg_response.get("InferenceSpecification")
        if inference_spec and isinstance(inference_spec, dict):
            containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
            if containers:
                model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")

        metadata = pkg_response.get("CustomerMetadataProperties", {})

        if not model_data_url and metadata.get("modelDataUrl"):
            model_data_url = metadata["modelDataUrl"]

        status = pkg_response.get("ModelApprovalStatus", "")
        description = pkg_response.get("ModelPackageDescription", "")
        version = _extract_version_from_arn(version_arn)

        _output({
            "arn": version_arn,
            "version": version,
            "status": status,
            "description": description,
            "modelDataUrl": model_data_url,
            "metadata": metadata,
        })

    except Exception as e:
        _error_exit(f"Failed to get version details for {version_arn}: {e}", code="GET_VERSION_FAILED")
