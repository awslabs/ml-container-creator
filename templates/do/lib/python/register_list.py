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
from register_dataset import _resolve_core_bucket
from register_model import _extract_version_from_arn


# ── BL056: MLflow-queried adapter listing (flat default, family grouping toggle) ──


def _adapter_entry_from_logged_model(model):
    """Project an adapter LoggedModel into the --list adapter entry shape.

    Reads the sanitized registered name plus the ``mlcc.adapter_type`` and
    ``mlcc.base_model_run_id`` lineage params off the LoggedModel, tolerating
    attr- or dict-shaped tag/param containers.

    Related: mlcc_mlflow.search_family
    """
    import mlcc_mlflow

    name = getattr(model, "name", None)
    if not name and isinstance(model, dict):
        name = model.get("name", "")

    adapter_type = _model_param(model, mlcc_mlflow.PARAM_ADAPTER_TYPE)
    base_model_run_id = _model_param(model, mlcc_mlflow.PARAM_BASE_MODEL_RUN_ID)

    return {
        "name": name or "",
        "adapter_type": adapter_type or "",
        "base_model_run_id": base_model_run_id or "",
    }


def _model_param(model, key):
    """Read a param/tag value off a LoggedModel, tolerating attr/dict shapes.

    BL-FAM records the mlcc.* lineage detail as version-scoped tags, so the
    values live in the model's ``params`` or ``tags`` container depending on the
    store. Checks both, tolerating attr- and dict-shaped containers.
    """
    for container_attr in ("params", "tags"):
        container = getattr(model, container_attr, None)
        if container is None and isinstance(model, dict):
            container = model.get(container_attr)
        if isinstance(container, dict) and key in container:
            return container[key]
        value = getattr(container, key, None) if container is not None else None
        if value is not None:
            return value
    return None


def _is_adapter_member(model):
    """Return True if a LoggedModel is tagged mlcc.artifact_type == 'adapter'."""
    import mlcc_mlflow

    return mlcc_mlflow._tag_value(model, mlcc_mlflow.TAG_ARTIFACT_TYPE) == "adapter"


def _group_adapters_by_family(base_ids, client=None):
    """Return ``{base_id: [adapter LoggedModel, ...]}`` grouped by mlcc.family.

    Invoked only when the ``--group-by-family`` toggle is on (BL056 Req 5). For
    each ``base_id``, ``mlcc_mlflow.search_family(base_id)`` enumerates family
    members; entries with ``mlcc.artifact_type == 'adapter'`` are collected under
    that base. Because ``search_family`` guarantees every returned member has
    ``mlcc.family == base_id``, each adapter is grouped under exactly its own
    family.

    Related: mlcc_mlflow.search_family
    """
    import mlcc_mlflow

    grouped = {}
    for base_id in base_ids:
        members = mlcc_mlflow.search_family(base_id, client=client)
        grouped[base_id] = [m for m in members if _is_adapter_member(m)]
    return grouped


def _list_adapters(base_ids, group_by_family=False, client=None):
    """Return the ``--list`` shape for MLflow-queried adapters (BL056 Req 5).

    Default (``group_by_family=False``): a **flat** adapter listing;
    ``search_family`` is NOT called. Only when ``group_by_family=True`` are
    adapters grouped under their base model via ``_group_adapters_by_family``.

    Flat shape:   ``{"adapters": [entry, ...]}``
    Grouped shape:``{"families": [{"base_id": ..., "adapters": [entry, ...]}, ...]}``

    Related: _group_adapters_by_family, mlcc_mlflow.search_family
    """
    import mlcc_mlflow

    if not group_by_family:
        # Flat default: enumerate members across the given base ids without
        # producing the nested family shape. search_family is the enumeration
        # primitive; grouping (the family-nested transform) is the toggled path.
        adapters = []
        for base_id in base_ids:
            members = mlcc_mlflow.search_family(base_id, client=client)
            adapters.extend(
                _adapter_entry_from_logged_model(m)
                for m in members
                if _is_adapter_member(m)
            )
        return {"adapters": adapters}

    grouped = _group_adapters_by_family(base_ids, client=client)
    families = [
        {
            "base_id": base_id,
            "adapters": [_adapter_entry_from_logged_model(m) for m in members],
        }
        for base_id, members in grouped.items()
    ]
    return {"families": families}


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


def _mlflow_input_to_list_entry(entry):
    """Project an MLflow dataset run input onto the 'local' list-entry shape.

    ``entry`` is a ``{"name", "digest", "s3_uri", "meta"}`` dict from
    ``mlcc_mlflow.list_dataset_inputs``. The carried ``meta`` (row_count,
    format, technique) reconstructs the same fields ``_sidecar_to_list_entry``
    produces, so bash callers see an identical entry shape.
    """
    meta = entry.get("meta") or {}
    return {
        "name": entry.get("name", ""),
        "technique": meta.get("technique", ""),
        "format": meta.get("format", "jsonl"),
        "s3_uri": entry.get("s3_uri", "") or meta.get("s3_uri", ""),
        "row_count": meta.get("row_count"),
        "latest_version": meta.get("latest_version", "1.0.0"),
        "version_count": 1,
        "customMetadata": {},
        "origin": "local",
    }


def cmd_list_datasets(args):
    """List all registered datasets from the S3 sidecars (+ optional Hub remote).

    The ``{local, remote}`` JSON shape is preserved for bash callers: sidecar
    entries populate ``local``; ``remote`` reflects Hub contents when present.
    """
    import mlcc_mlflow

    source = getattr(args, 'source', 'all')
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    technique_filter = getattr(args, 'technique', None)

    # BL123: the branded-hub "remote" listing was retired (the native AI Registry
    # hub is SDK-computed and not enumerated by MLCC's list — the S3 sidecar /
    # MLflow is the canonical read source). `remote` is kept as an always-empty
    # key so the {local, remote} JSON shape stays stable for bash callers.
    remote_entries = []
    local_entries = []

    if source in ('local', 'all'):
        # BL110 Req 2.1 / Property 5: when MLflow is configured it is the read
        # source for --list (run inputs recorded by log_dataset), projected onto
        # the same list-entry shape; the S3 sidecar is the fallback ONLY when
        # MLflow is not configured. The branch is decided by the single
        # _mlflow_configured() predicate so list/resolve/register stay consistent.
        if mlcc_mlflow._mlflow_configured():
            try:
                inputs = mlcc_mlflow.list_dataset_inputs()
            except mlcc_mlflow.MlflowUnavailableError as e:
                # Configured-but-unreachable is a hard error on a read path (no
                # durable side effect to protect); do not silently read the
                # sidecar, which would hide the misconfiguration (design: Error Handling).
                _error_exit(
                    f"MLflow is configured but could not be read: {e}",
                    code="MLFLOW_READ_FAILED",
                )
            for entry in inputs:
                list_entry = _mlflow_input_to_list_entry(entry)
                if technique_filter and list_entry.get('technique') != technique_filter:
                    continue
                local_entries.append(list_entry)
        else:
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


def _resolve_base_ids(args):
    """Collect the base ids to group adapters under for the family view.

    Accepts ``--base-id`` (repeatable, ``args.base_id`` as a list or single
    string) and/or ``--base-ids`` (a comma-separated string). Returns a
    de-duplicated, order-preserving list of non-empty base ids.
    """
    base_ids = []
    single = getattr(args, "base_id", None)
    if isinstance(single, (list, tuple)):
        base_ids.extend(single)
    elif single:
        base_ids.append(single)

    joined = getattr(args, "base_ids", None)
    if joined:
        base_ids.extend(part.strip() for part in str(joined).split(","))

    seen = set()
    result = []
    for bid in base_ids:
        if bid and bid not in seen:
            seen.add(bid)
            result.append(bid)
    return result


def cmd_list_adapters(args):
    """List adapter versions from the project's Model Package Group.

    BL056 (Req 5): when ``--group-by-family`` is passed, the listing is served
    from MLflow (family-aware) instead of the MPG — adapters are grouped under
    their base model by ``mlcc.family``. The default (no toggle) remains the
    flat MPG-backed SageMaker view below, and ``search_family`` is not called.
    """
    group_by_family = getattr(args, "group_by_family", False)
    if group_by_family:
        # MLflow-queried, family-grouped view. The base ids to group under come
        # from --base-id (repeatable) or the comma-separated --base-ids.
        base_ids = _resolve_base_ids(args)
        try:
            result = _list_adapters(base_ids, group_by_family=True)
        except Exception as e:
            _error_exit(
                f"Failed to list adapters by family from MLflow: {e}",
                code="MLFLOW_UNAVAILABLE",
            )
        _output(result)

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
