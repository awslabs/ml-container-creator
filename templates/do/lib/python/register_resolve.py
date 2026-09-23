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
from register_common import _load_registry
import register_common
import dataset_store
from register_dataset import _get_hub_name_from_profile, _resolve_core_bucket
from register_model import _extract_version_from_arn, _check_ai_registry


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

    region = (
        getattr(args, "region", None)
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
    )
    core_bucket = _resolve_core_bucket(args)
    if not core_bucket:
        _error_exit(
            "Could not resolve the MLCC Core bucket for dataset resolution.\n"
            "    Pass --core-bucket <bucket> or set CORE_BUCKET.",
            code="MISSING_CORE_BUCKET",
        )

    s3_client = dataset_store._get_s3_client(region)

    try:
        sidecar = dataset_store.read_sidecar(s3_client, core_bucket, name)
    except dataset_store.TransportError as e:
        # Transport / permission error — distinct exit code from not-found.
        print(json.dumps({"error": str(e), "code": "SIDECAR_READ_FAILED"}))
        print(f"\u26a0\ufe0f  {e}", file=sys.stderr)
        sys.exit(3)

    if sidecar is None:
        _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")

    versions = sidecar.get("versions") or []
    entry, ordinal = _select_version(versions, version_spec)

    if entry is None:
        if version_spec is not None:
            _version_not_found(name, version_spec, versions)
        _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")

    _output({
        "name": name,
        "s3_uri": entry.get("s3_uri", sidecar.get("s3_uri", "")),
        "arn": entry.get("arn", sidecar.get("arn")),
        "format": entry.get("format", sidecar.get("format", "jsonl")),
        "technique": entry.get("technique", sidecar.get("technique", "")),
        "version": entry.get("version", "1.0.0"),
        "ordinal": ordinal,
        "hash": entry.get("hash"),
    })


def cmd_resolve_evaluator(args):
    """Resolve a registered evaluator by name."""
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    entries = _load_registry(register_common._EVALUATORS_REGISTRY)
    for entry in entries:
        if entry.get("name") == name:
            _output(entry)

    _error_exit(f"Evaluator not found: {name}", code="EVALUATOR_NOT_FOUND")


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
