from __future__ import annotations
"""Register list: list datasets, adapters, and models from registry.

Purpose: cmd_list_datasets, cmd_list_dataset_versions, cmd_list_adapters, cmd_list_models
Inputs: --project-name, --region, --technique, --source, --name
Outputs: JSON with datasets/adapters/models arrays
Caller: .register_helper.py dispatcher
Related: register_common.py (registry I/O), register_dataset.py (hub helpers)
"""

import os
import sys

from common import _output, _error_exit, _check_sagemaker_core
import register_common
from register_common import _load_registry
import dataset_store
from register_dataset import _get_hub_name_from_profile, _list_hub_datasets, _resolve_core_bucket
from register_model import _extract_version_from_arn


def _sidecar_to_list_entry(doc):
    """Project a sidecar document into the list-datasets 'local' entry shape."""
    versions = doc.get("versions") or []
    latest = versions[-1] if versions else {}
    return {
        "name": doc.get("name", ""),
        "technique": latest.get("technique", doc.get("technique", "")),
        "format": latest.get("format", doc.get("format", "jsonl")),
        "s3_uri": latest.get("s3_uri", doc.get("s3_uri", "")),
        "row_count": latest.get("rowCount", latest.get("row_count")),
        "latest_version": latest.get("version", doc.get("latestVersion", "1.0.0")),
        "version_count": len(versions) if versions else 1,
        "customMetadata": doc.get("customMetadata", {}),
        "origin": "local",
    }


def cmd_list_datasets(args):
    """List all registered datasets from the S3 sidecars (+ optional Hub remote).

    The ``{local, remote}`` JSON shape is preserved for bash callers: sidecar
    entries populate ``local``; ``remote`` reflects Hub contents when present.
    """
    source = getattr(args, 'source', 'all')
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    technique_filter = getattr(args, 'technique', None)

    remote_entries = []
    local_entries = []

    if source in ('remote', 'all'):
        hub_name = _get_hub_name_from_profile(region)
        if hub_name:
            remote_entries = _list_hub_datasets(hub_name, region)
            if technique_filter:
                remote_entries = [e for e in remote_entries if e.get('technique') == technique_filter]
        else:
            print('\u26a0\ufe0f  No AI Registry Hub configured \u2014 skipping remote datasets.', file=sys.stderr)

    if source in ('local', 'all'):
        core_bucket = _resolve_core_bucket(args)
        if not core_bucket:
            print('\u26a0\ufe0f  No Core bucket resolved \u2014 skipping registered datasets.', file=sys.stderr)
        else:
            try:
                s3_client = dataset_store._get_s3_client(region)
                docs = dataset_store.list_sidecars(s3_client, core_bucket)
            except dataset_store.TransportError as e:
                print(f'\u26a0\ufe0f  Could not list datasets: {e}', file=sys.stderr)
                docs = []
            for doc in docs:
                entry = _sidecar_to_list_entry(doc)
                if technique_filter and entry.get('technique') != technique_filter:
                    continue
                local_entries.append(entry)

    all_datasets = remote_entries + local_entries

    result = {'datasets': all_datasets}
    if source != 'local':
        result['remote'] = remote_entries
    if source != 'remote':
        result['local'] = local_entries
    result['source'] = source

    _output(result)


def cmd_list_dataset_versions(args):
    """List all versions for a specific dataset by name (from the S3 sidecar)."""
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    core_bucket = _resolve_core_bucket(args)
    if not core_bucket:
        _error_exit(
            "Could not resolve the MLCC Core bucket.\n"
            "    Pass --core-bucket <bucket> or set CORE_BUCKET.",
            code="MISSING_CORE_BUCKET",
        )

    s3_client = dataset_store._get_s3_client(region)
    try:
        sidecar = dataset_store.read_sidecar(s3_client, core_bucket, name)
    except dataset_store.TransportError as e:
        _error_exit(f"Could not read dataset sidecar: {e}", code="SIDECAR_READ_FAILED")

    if sidecar is None:
        _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")

    versions = sidecar.get("versions") or []
    result_versions = []
    for v in versions:
        result_versions.append({
            "version": v.get("version", "1.0.0"),
            "hash": v.get("hash"),
            "date": v.get("createdAt", v.get("registered_at", "")),
            "rows": v.get("rowCount", v.get("rows")),
            "s3_uri": v.get("s3_uri", ""),
        })

    _output({
        "name": name,
        "versions": result_versions,
    })


def cmd_list_adapters(args):
    """List adapter versions from the project's Model Package Group."""
    _check_sagemaker_core()

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        from sagemaker.core.resources import ModelPackage

        packages = ModelPackage.get_all(model_package_group_name=project_name)

        adapters = []
        for pkg in packages:
            metadata = getattr(pkg, "customer_metadata_properties", None) or {}
            if metadata.get("isAdapter") == "true":
                arn = pkg.model_package_arn
                version = _extract_version_from_arn(arn)

                model_data_url = ""
                inference_spec = getattr(pkg, "inference_specification", None)
                if inference_spec and isinstance(inference_spec, dict):
                    containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
                    if containers:
                        model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")

                created_at = ""
                if hasattr(pkg, "creation_time") and pkg.creation_time:
                    created_at = str(pkg.creation_time)

                adapters.append({
                    "arn": arn,
                    "version": version,
                    "tuneTechnique": metadata.get("tuneTechnique", ""),
                    "datasetS3Uri": metadata.get("datasetS3Uri", ""),
                    "parentModelVersionArn": metadata.get("parentModelVersionArn", ""),
                    "createdAt": created_at,
                    "description": getattr(pkg, "model_package_description", "") or "",
                    "modelDataUrl": model_data_url,
                })

        _output({"adapters": adapters})

    except Exception as e:
        error_msg = str(e).lower()
        if "does not exist" in error_msg or "not found" in error_msg:
            print(f"Model Package Group '{project_name}' not found \u2014 no registry adapters", file=sys.stderr)
        else:
            print(f"Warning: Could not query registry for adapters: {e}", file=sys.stderr)
        _output({"adapters": []})


def cmd_list_models(args):
    """List base model versions (non-adapter) from the project's Model Package Group."""
    _check_sagemaker_core()

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        from sagemaker.core.resources import ModelPackage

        packages = ModelPackage.get_all(model_package_group_name=project_name)

        models = []
        for pkg in packages:
            metadata = getattr(pkg, "customer_metadata_properties", None) or {}
            if metadata.get("isAdapter") == "true":
                continue

            arn = pkg.model_package_arn
            version = _extract_version_from_arn(arn)

            model_data_url = ""
            container_image = ""
            inference_spec = getattr(pkg, "inference_specification", None)
            if inference_spec and isinstance(inference_spec, dict):
                containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
                if containers:
                    model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")
                    container_image = containers[0].get("Image", "") or containers[0].get("image", "")

            created_at = ""
            if hasattr(pkg, "creation_time") and pkg.creation_time:
                created_at = str(pkg.creation_time)

            models.append({
                "arn": arn,
                "version": version,
                "deploymentConfig": metadata.get("deploymentConfig", ""),
                "modelName": metadata.get("modelName", ""),
                "instanceType": metadata.get("instanceType", ""),
                "modelDataUrl": model_data_url,
                "containerImage": container_image,
                "createdAt": created_at,
                "description": getattr(pkg, "model_package_description", "") or "",
            })

        _output({"models": models})

    except Exception as e:
        error_msg = str(e).lower()
        if "does not exist" in error_msg or "not found" in error_msg:
            print(f"Model Package Group '{project_name}' not found \u2014 no registry models", file=sys.stderr)
        else:
            print(f"Warning: Could not query registry for models: {e}", file=sys.stderr)
        _output({"models": []})
