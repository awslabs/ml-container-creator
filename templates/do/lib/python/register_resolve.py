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
from register_dataset import _get_hub_name_from_profile
from register_model import _extract_version_from_arn, _check_ai_registry


def cmd_resolve_dataset(args):
    """Resolve a registered dataset by name (with optional version pinning)."""
    name = args.name
    version_spec = getattr(args, "version", None)

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    if version_spec is not None:
        try:
            version_ordinal = int(version_spec)
            return _resolve_dataset_version(name, version_ordinal)
        except ValueError:
            return _resolve_dataset_version_by_semver(name, version_spec)

    # No version — resolve latest
    if _check_ai_registry():
        try:
            from sagemaker.ai_registry.dataset import DataSet

            dataset = DataSet.get(name=name)
            _output({
                "name": dataset.name if hasattr(dataset, 'name') else name,
                "s3_uri": dataset.source if hasattr(dataset, 'source') else "",
                "arn": dataset.arn if hasattr(dataset, 'arn') else None,
                "format": "jsonl",
                "technique": getattr(dataset, 'customization_technique', '').lower() if hasattr(dataset, 'customization_technique') else "",
                "version": None,
                "ordinal": None,
            })
        except Exception as e:
            print(f"AI Registry lookup failed for '{name}': {e}. Trying local registry.", file=sys.stderr)

    # Fallback: local registry
    entries = _load_registry(register_common._DATASETS_REGISTRY)
    for entry in entries:
        if entry.get("name") == name:
            output = dict(entry)
            if "arn" not in output:
                output["arn"] = None
            versions = entry.get("versions")
            if versions and len(versions) > 0:
                latest = versions[-1]
                output["s3_uri"] = latest.get("s3_uri", output.get("s3_uri", ""))
                output["version"] = latest.get("version")
                output["ordinal"] = len(versions)
            else:
                output["version"] = None
                output["ordinal"] = None
            _output(output)
            return

    # Hub fallback
    try:
        region = os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
        hub_name = _get_hub_name_from_profile(region)
        if hub_name:
            import boto3
            sm = boto3.client('sagemaker', region_name=region)
            resp = sm.describe_hub_content(
                HubName=hub_name, HubContentType='Dataset', HubContentName=name,
            )
            doc = json.loads(resp.get('HubContentDocument') or '{}')
            hub_s3_uri = doc.get('s3_uri') or doc.get('source')
            if hub_s3_uri:
                _output({'name': name, 's3_uri': hub_s3_uri, 'arn': None,
                         'format': doc.get('format', 'jsonl'), 'technique': doc.get('technique', 'unknown'),
                         'version': resp.get('HubContentVersion', ''), 'ordinal': None,
                         'origin': 'remote'})
                return
    except Exception as hub_err:
        print(f'\u26a0\ufe0f  Hub fallback failed: {hub_err}', file=sys.stderr)

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


def _resolve_dataset_version(name, version_ordinal):
    """Resolve a specific version (by ordinal) of a named dataset."""
    entries = _load_registry(register_common._DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions", [])

            if not versions:
                if version_ordinal == 1:
                    output = dict(entry)
                    output["version"] = "1.0.0"
                    output["ordinal"] = 1
                    if "arn" not in output:
                        output["arn"] = None
                    _output(output)
                else:
                    print(f"Error: Version v{version_ordinal} not found for dataset '{name}'", file=sys.stderr)
                    print(f"Available versions: v1 (1.0.0)", file=sys.stderr)
                    print(json.dumps({
                        "error": f"Version v{version_ordinal} not found for dataset '{name}'",
                        "code": "VERSION_NOT_FOUND",
                        "available_versions": [{"ordinal": 1, "version": "1.0.0"}],
                    }))
                    sys.exit(1)

            if version_ordinal < 1 or version_ordinal > len(versions):
                print(f"Error: Version v{version_ordinal} not found for dataset '{name}'", file=sys.stderr)
                available = []
                for i, v in enumerate(versions, 1):
                    ver_str = v.get("version", f"{i}.0.0")
                    available.append({"ordinal": i, "version": ver_str})
                    print(f"  v{i} ({ver_str})", file=sys.stderr)
                print(json.dumps({
                    "error": f"Version v{version_ordinal} not found for dataset '{name}'",
                    "code": "VERSION_NOT_FOUND",
                    "available_versions": available,
                }))
                sys.exit(1)

            target_version = versions[version_ordinal - 1]
            _output({
                "name": name,
                "s3_uri": target_version.get("s3_uri", entry.get("s3_uri", "")),
                "arn": entry.get("arn"),
                "format": target_version.get("format", entry.get("format", "jsonl")),
                "technique": target_version.get("technique", entry.get("technique", "")),
                "version": target_version.get("version", "1.0.0"),
                "ordinal": version_ordinal,
                "hash": target_version.get("hash"),
            })

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


def _resolve_dataset_version_by_semver(name, version_str):
    """Resolve a specific version of a named dataset by semver string match."""
    entries = _load_registry(register_common._DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions", [])

            if not versions:
                if version_str == "1.0.0":
                    output = dict(entry)
                    output["version"] = "1.0.0"
                    output["ordinal"] = 1
                    if "arn" not in output:
                        output["arn"] = None
                    _output(output)
                else:
                    print(f"Error: Version {version_str} not found for dataset '{name}'", file=sys.stderr)
                    print(f"Available versions: 1.0.0", file=sys.stderr)
                    print(json.dumps({
                        "error": f"Version {version_str} not found for dataset '{name}'",
                        "code": "VERSION_NOT_FOUND",
                        "available_versions": [{"ordinal": 1, "version": "1.0.0"}],
                    }))
                    sys.exit(1)

            for i, v in enumerate(versions, 1):
                ver = v.get("version", "")
                if ver == version_str:
                    _output({
                        "name": name,
                        "s3_uri": v.get("s3_uri", entry.get("s3_uri", "")),
                        "arn": entry.get("arn"),
                        "format": v.get("format", entry.get("format", "jsonl")),
                        "technique": v.get("technique", entry.get("technique", "")),
                        "version": ver,
                        "ordinal": i,
                        "hash": v.get("hash"),
                    })

            print(f"Error: Version {version_str} not found for dataset '{name}'", file=sys.stderr)
            available = []
            for i, v in enumerate(versions, 1):
                ver = v.get("version", f"{i}.0.0")
                available.append({"ordinal": i, "version": ver})
                print(f"  v{i} ({ver})", file=sys.stderr)
            print(json.dumps({
                "error": f"Version {version_str} not found for dataset '{name}'",
                "code": "VERSION_NOT_FOUND",
                "available_versions": available,
            }))
            sys.exit(1)

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


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
