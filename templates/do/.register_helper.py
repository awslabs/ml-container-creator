#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Model Package Group helper for model registration.

Subcommands:
    create-mpg       - Create a Model Package Group (idempotent)
    register-model   - Register a model as a versioned Model Package
    register-adapter - Register an adapter as a versioned Model Package linked to base model

Uses sagemaker-core ModelPackageGroup and ModelPackage resource APIs (SDK v3).
No boto3 sagemaker client per NFR-3.

All output is JSON on stdout for bash consumption.
Diagnostic messages go to stderr.
"""

import argparse
import json
import logging
import os
import sys
import warnings

# Suppress noisy dependency version warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*urllib3.*")

# Suppress sagemaker-core INFO/WARNING logging that pollutes stdout
logging.getLogger("sagemaker.config").setLevel(logging.ERROR)
logging.getLogger("sagemaker.core").setLevel(logging.ERROR)
logging.getLogger("sagemaker").setLevel(logging.ERROR)


# ── Constants ─────────────────────────────────────────────────────────────────

MAX_METADATA_VALUE_LEN = 256


# ── Utility functions ─────────────────────────────────────────────────────────


def _error_exit(message, code="REGISTRATION_ERROR", exit_code=1):
    """Print error JSON to stdout, message to stderr, and exit."""
    print(f"Error: {message}", file=sys.stderr)
    print(json.dumps({"error": message, "code": code}))
    sys.exit(exit_code)


def _output(data):
    """Print JSON result to stdout and exit 0."""
    print(json.dumps(data))
    sys.exit(0)


def _warn(message):
    """Print warning to stderr."""
    print(f"⚠️  {message}", file=sys.stderr)


# ── Dependency check ──────────────────────────────────────────────────────────


def _check_sagemaker_core():
    """Verify sagemaker-core is installed."""
    try:
        from sagemaker.core.resources import ModelPackageGroup, ModelPackage  # noqa: F401
    except ImportError:
        _error_exit(
            "sagemaker-core is not installed. "
            "Please install: pip install 'sagemaker>=3.0.0' (includes sagemaker-core)",
            code="MISSING_DEPENDENCY",
        )


# ── Metadata helpers ──────────────────────────────────────────────────────────


def _truncate_metadata(props):
    """Truncate metadata values exceeding 256 chars with '…' suffix and log warning.

    Args:
        props: dict of metadata key-value pairs

    Returns:
        dict with all values as strings, truncated if necessary
    """
    result = {}
    for key, value in props.items():
        str_val = str(value) if value is not None else ""
        if len(str_val) > MAX_METADATA_VALUE_LEN:
            _warn(f"Metadata '{key}' truncated ({len(str_val)} → {MAX_METADATA_VALUE_LEN} chars)")
            str_val = str_val[: MAX_METADATA_VALUE_LEN - 1] + "…"
        result[key] = str_val
    return result


def _build_metadata(args):
    """Build customer_metadata_properties dict from CLI args.

    All values are converted to strings per SageMaker constraints (NFR-1).
    Values exceeding 256 chars are truncated with '…' suffix (AC-1.8).
    """
    props = {
        "deploymentConfig": args.deployment_config or "",
        "architecture": args.architecture or "",
        "backend": args.backend or "",
        "instanceType": args.instance_type or "",
        "modelName": args.model_name or "",
        "baseImage": args.base_image or "",
        "modelFormat": args.model_format or "",
        "generatorVersion": args.generator_version or "",
        "projectName": args.project_name or "",
    }

    # Add benchmark results if available
    if getattr(args, "benchmark_results", None):
        try:
            bench = json.loads(args.benchmark_results) if isinstance(args.benchmark_results, str) else args.benchmark_results
            if isinstance(bench, dict):
                for bkey, bval in bench.items():
                    props[f"benchmark_{bkey}"] = str(bval)
        except (json.JSONDecodeError, TypeError):
            _warn("Could not parse benchmark results, skipping")

    return _truncate_metadata(props)


def _build_adapter_metadata(args):
    """Build customer_metadata_properties dict for adapter registration.

    Includes all standard fields plus adapter-specific fields (AC-2.2):
    isAdapter, parentModelVersionArn, tuneTechnique, datasetS3Uri.
    """
    props = {
        "deploymentConfig": args.deployment_config or "",
        "architecture": args.architecture or "",
        "backend": args.backend or "",
        "instanceType": args.instance_type or "",
        "modelName": args.model_name or "",
        "baseImage": args.base_image or "",
        "modelFormat": args.model_format or "",
        "generatorVersion": args.generator_version or "",
        "projectName": args.project_name or "",
        # Adapter-specific metadata (AC-2.2)
        "isAdapter": "true",
        "parentModelVersionArn": args.parent_version_arn or "",
        "tuneTechnique": args.tune_technique or "",
        "datasetS3Uri": args.dataset_s3_uri or "",
    }

    return _truncate_metadata(props)


# ── Subcommand: create-mpg ────────────────────────────────────────────────────


def cmd_create_mpg(args):
    """Create a Model Package Group (idempotent — handles AlreadyExists).

    Returns JSON: {"mpg_arn": str, "created": bool}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ModelPackageGroup

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    print(f"Creating Model Package Group: {project_name}", file=sys.stderr)

    try:
        mpg = ModelPackageGroup.create(
            model_package_group_name=project_name,
            model_package_group_description=f"Models for {project_name}",
        )
        mpg_arn = mpg.model_package_group_arn
        _output({"mpg_arn": mpg_arn, "created": True})
    except Exception as e:
        error_msg = str(e).lower()
        if "already exists" in error_msg or "alreadyexists" in error_msg or "resource in use" in error_msg:
            # MPG already exists — retrieve its ARN
            print(f"Model Package Group '{project_name}' already exists", file=sys.stderr)
            try:
                mpg = ModelPackageGroup.get(model_package_group_name=project_name)
                mpg_arn = mpg.model_package_group_arn
                _output({"mpg_arn": mpg_arn, "created": False})
            except Exception as get_err:
                # Construct the ARN from known pattern
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
                _output({"mpg_arn": mpg_arn, "created": False})
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")


def _get_account_id():
    """Get AWS account ID from STS."""
    try:
        import boto3
        sts = boto3.client("sts")
        return sts.get_caller_identity()["Account"]
    except Exception:
        return "unknown"


# ── Subcommand: register-model ────────────────────────────────────────────────


def cmd_register_model(args):
    """Register a model as a versioned Model Package in the project's MPG.

    Creates the MPG if it doesn't exist (AC-1.1), then creates a new
    ModelPackageVersion (AC-1.2, AC-1.7). Stores metadata in
    customer_metadata_properties (AC-1.3, AC-1.8).

    Returns JSON: {"mpg_arn": str, "model_package_arn": str, "version": int}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ModelPackageGroup, ModelPackage

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    # Step 1: Create MPG if it doesn't exist (AC-1.1)
    mpg_arn = None
    try:
        mpg = ModelPackageGroup.create(
            model_package_group_name=project_name,
            model_package_group_description=f"Models for {project_name}",
        )
        mpg_arn = mpg.model_package_group_arn
        print(f"Created Model Package Group: {project_name}", file=sys.stderr)
    except Exception as e:
        error_msg = str(e).lower()
        if "already exists" in error_msg or "alreadyexists" in error_msg or "resource in use" in error_msg:
            print(f"Model Package Group '{project_name}' already exists", file=sys.stderr)
            try:
                mpg = ModelPackageGroup.get(model_package_group_name=project_name)
                mpg_arn = mpg.model_package_group_arn
            except Exception:
                # Construct ARN from known pattern
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")

    # Step 2: Build metadata (AC-1.3, AC-1.8)
    metadata = _build_metadata(args)

    # Step 3: Build inference specification
    container_image = args.container_image or ""
    model_data_url = args.model_data_url or ""

    inference_spec = {
        "Containers": [
            {
                "Image": container_image,
            }
        ],
        "SupportedContentTypes": ["application/json"],
        "SupportedResponseMIMETypes": ["application/json"],
    }
    # Only include ModelDataUrl if provided
    if model_data_url:
        inference_spec["Containers"][0]["ModelDataUrl"] = model_data_url

    # Step 4: Create Model Package version (AC-1.2, AC-1.7)
    description = f"{args.deployment_config or 'model'} on {args.instance_type or 'unknown'}"

    print(f"Registering model version in {project_name}...", file=sys.stderr)
    try:
        pkg = ModelPackage.create(
            model_package_group_name=project_name,
            model_package_description=description,
            inference_specification=inference_spec,
            customer_metadata_properties=metadata,
            model_approval_status="Approved",
        )

        model_package_arn = pkg.model_package_arn
        # Extract version number from ARN (format: .../project-name/version)
        version = _extract_version_from_arn(model_package_arn)

        print(f"Registered model version {version}: {model_package_arn}", file=sys.stderr)
        _output({
            "mpg_arn": mpg_arn,
            "model_package_arn": model_package_arn,
            "version": version,
        })
    except Exception as e:
        _error_exit(f"Failed to register model package: {e}", code="MODEL_REGISTER_FAILED")


def _extract_version_from_arn(arn):
    """Extract version number from a model package ARN.

    ARN format: arn:aws:sagemaker:<region>:<account>:model-package/<group>/<version>
    """
    try:
        parts = arn.split("/")
        return int(parts[-1])
    except (ValueError, IndexError):
        return 0


# ── Subcommand: register-adapter ─────────────────────────────────────────────


def cmd_register_adapter(args):
    """Register an adapter as a versioned Model Package linked to its base model.

    Creates the MPG if it doesn't exist (reuses AC-1.1 logic), then creates a new
    ModelPackageVersion with adapter-specific metadata (AC-2.1, AC-2.2):
    - isAdapter=true
    - parentModelVersionArn (links to base model version)
    - tuneTechnique (sft/dpo/rlvr)
    - datasetS3Uri (training dataset location)

    Returns JSON: {"mpg_arn": str, "model_package_arn": str, "version": int, "parent_version_arn": str}
    """
    _check_sagemaker_core()

    from sagemaker.core.resources import ModelPackageGroup, ModelPackage

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    parent_version_arn = args.parent_version_arn
    if not parent_version_arn:
        _error_exit("--parent-version-arn is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    # Step 1: Create MPG if it doesn't exist (reuses AC-1.1 logic)
    mpg_arn = None
    try:
        mpg = ModelPackageGroup.create(
            model_package_group_name=project_name,
            model_package_group_description=f"Models for {project_name}",
        )
        mpg_arn = mpg.model_package_group_arn
        print(f"Created Model Package Group: {project_name}", file=sys.stderr)
    except Exception as e:
        error_msg = str(e).lower()
        if "already exists" in error_msg or "alreadyexists" in error_msg or "resource in use" in error_msg:
            print(f"Model Package Group '{project_name}' already exists", file=sys.stderr)
            try:
                mpg = ModelPackageGroup.get(model_package_group_name=project_name)
                mpg_arn = mpg.model_package_group_arn
            except Exception:
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")

    # Step 2: Build adapter metadata (AC-2.2)
    metadata = _build_adapter_metadata(args)

    # Step 2.5: Check for existing adapter with same metadata (dedup, Backlog #024)
    # SFTTrainer with model_package_group_name= auto-registers adapters on completion.
    # If do/register also calls register-adapter, we get duplicate versions.
    # Best-effort dedup: check if latest versions already have matching metadata.
    try:
        from sagemaker.core.resources import ModelPackage as _MP
        packages = _MP.get_all(model_package_group_name=project_name)
        for pkg in packages:
            existing_meta = getattr(pkg, "customer_metadata_properties", None) or {}
            if (existing_meta.get("isAdapter") == "true" and
                existing_meta.get("parentModelVersionArn") == parent_version_arn and
                existing_meta.get("tuneTechnique") == (args.tune_technique or "") and
                existing_meta.get("datasetS3Uri") == (args.dataset_s3_uri or "")):
                # Duplicate detected — SFTTrainer likely already registered this
                existing_arn = pkg.model_package_arn
                existing_version = _extract_version_from_arn(existing_arn)
                print(f"Adapter already registered as version {existing_version} (likely by SFTTrainer)", file=sys.stderr)
                print(f"Supplementing with deployment metadata...", file=sys.stderr)
                # TODO: Update the existing version's metadata with deployment fields
                # For now, output the existing version info instead of creating a duplicate
                _output({
                    "mpg_arn": mpg_arn,
                    "model_package_arn": existing_arn,
                    "version": existing_version,
                    "parent_version_arn": parent_version_arn,
                    "deduplicated": True,
                })
    except Exception as dedup_err:
        # Dedup check is best-effort — proceed with registration if it fails
        print(f"Dedup check failed (non-fatal): {dedup_err}", file=sys.stderr)

    # Step 3: Build inference specification
    container_image = args.container_image or ""
    model_data_url = args.model_data_url or ""

    inference_spec = {
        "Containers": [
            {
                "Image": container_image,
            }
        ],
        "SupportedContentTypes": ["application/json"],
        "SupportedResponseMIMETypes": ["application/json"],
    }
    if model_data_url:
        inference_spec["Containers"][0]["ModelDataUrl"] = model_data_url

    # Step 4: Create adapter Model Package version (AC-2.1)
    technique = args.tune_technique or "unknown"
    description = f"adapter ({technique}) on {args.instance_type or 'unknown'}, parent: {parent_version_arn}"

    print(f"Registering adapter version in {project_name}...", file=sys.stderr)
    try:
        pkg = ModelPackage.create(
            model_package_group_name=project_name,
            model_package_description=description,
            inference_specification=inference_spec,
            customer_metadata_properties=metadata,
            model_approval_status="Approved",
        )

        model_package_arn = pkg.model_package_arn
        version = _extract_version_from_arn(model_package_arn)

        print(f"Registered adapter version {version}: {model_package_arn}", file=sys.stderr)
        _output({
            "mpg_arn": mpg_arn,
            "model_package_arn": model_package_arn,
            "version": version,
            "parent_version_arn": parent_version_arn,
        })
    except Exception as e:
        _error_exit(f"Failed to register adapter package: {e}", code="ADAPTER_REGISTER_FAILED")


# ── AI Registry + Local Registry Helpers ──────────────────────────────────────
# Use sagemaker.ai_registry.dataset.DataSet API (SDK v3) when available.
# Fall back to local JSON-based registry (~/.ml-container-creator/datasets.json)
# if the import fails (older SDK, Backlog #023).
# Evaluator API does not exist yet — evaluators always use local JSON.
# TODO: Once an evaluator registry API is available, upgrade evaluators too.

_REGISTRY_DIR = os.path.join(os.path.expanduser("~"), ".ml-container-creator")
_DATASETS_REGISTRY = os.path.join(_REGISTRY_DIR, "datasets.json")
_EVALUATORS_REGISTRY = os.path.join(_REGISTRY_DIR, "evaluators.json")


def _check_ai_registry():
    """Verify sagemaker.ai_registry.dataset is available."""
    try:
        from sagemaker.ai_registry.dataset import DataSet  # noqa: F401
        return True
    except (ImportError, Exception):
        # ImportError: module not installed
        # Other exceptions: module exists but fails at import (e.g., NoRegionError
        # from boto3 client created at class-definition time in AIRHub)
        return False


def _ensure_registry_dir():
    """Create the registry directory if it doesn't exist."""
    os.makedirs(_REGISTRY_DIR, exist_ok=True)


def _load_registry(path):
    """Load a registry JSON file. Returns list of entries."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, IOError):
        return []


def _save_registry(path, entries):
    """Save entries to a registry JSON file."""
    _ensure_registry_dir()
    with open(path, "w") as f:
        json.dump(entries, f, indent=2)


# ── Subcommand: register-dataset ─────────────────────────────────────────────


def cmd_register_dataset(args):
    """Register a dataset into SageMaker AI Registry (preferred) or local registry (fallback).

    Uses sagemaker.ai_registry.dataset.DataSet API (SDK v3) when available.
    Falls back to local JSON registry if the API is not installed (Backlog #023).

    Returns JSON: {"name": str, "s3_uri": str, "format": str, "technique": str, "arn": str|null, "registered": bool}
    """
    name = args.name
    s3_uri = args.s3_uri
    data_format = getattr(args, "format", "jsonl")
    technique = args.technique
    row_count = args.row_count
    column_schema = args.column_schema
    project_name = args.project_name or ""

    # Set region before any sagemaker import (creates boto3 clients at import time)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")
    if not s3_uri:
        _error_exit("--s3-uri is required", code="MISSING_ARGUMENT")

    # Validate column schema if provided
    if column_schema:
        try:
            json.loads(column_schema)
        except json.JSONDecodeError:
            _error_exit("--column-schema must be valid JSON", code="INVALID_ARGUMENT")

    # Try SageMaker AI Registry API first (Backlog #023)
    if _check_ai_registry():
        try:
            from sagemaker.ai_registry.dataset import DataSet
            from sagemaker.ai_registry.dataset import CustomizationTechnique

            # Map technique string to enum
            technique_enum = None
            technique_map = {t.name.lower(): t for t in CustomizationTechnique}
            if technique.lower() in technique_map:
                technique_enum = technique_map[technique.lower()]

            print(f"Registering dataset '{name}' via SageMaker AI Registry...", file=sys.stderr)
            dataset = DataSet.create(
                name=name,
                source=s3_uri,
                customization_technique=technique_enum,
            )
            dataset_arn = dataset.arn

            # Also write to local registry for offline fallback
            _write_dataset_to_local_registry(
                name=name, s3_uri=s3_uri, data_format=data_format,
                technique=technique, row_count=row_count,
                column_schema=column_schema, project_name=project_name,
                arn=dataset_arn,
            )

            print(f"Registered dataset '{name}' → {s3_uri} (ARN: {dataset_arn})", file=sys.stderr)
            _output({
                "name": name,
                "s3_uri": s3_uri,
                "format": data_format,
                "technique": technique,
                "arn": dataset_arn,
                "registered": True,
            })
        except Exception as e:
            _warn(f"AI Registry registration failed: {e}. Falling back to local registry.")
            # Fall through to local registry below
    else:
        _warn(
            "sagemaker.ai_registry.dataset.DataSet not available (older SDK). "
            "Using local registry fallback."
        )

    # Fallback: local JSON registry
    _write_dataset_to_local_registry(
        name=name, s3_uri=s3_uri, data_format=data_format,
        technique=technique, row_count=row_count,
        column_schema=column_schema, project_name=project_name,
        arn=None,
    )

    print(f"Registered dataset '{name}' → {s3_uri} (local registry)", file=sys.stderr)
    _output({
        "name": name,
        "s3_uri": s3_uri,
        "format": data_format,
        "technique": technique,
        "arn": None,
        "registered": True,
    })


def _write_dataset_to_local_registry(*, name, s3_uri, data_format, technique,
                                      row_count, column_schema, project_name, arn):
    """Write a dataset entry to the local JSON registry (for offline fallback)."""
    import datetime

    entries = _load_registry(_DATASETS_REGISTRY)

    entry = {
        "name": name,
        "s3_uri": s3_uri,
        "format": data_format,
        "technique": technique,
        "row_count": row_count,
        "column_schema": column_schema,
        "project_name": project_name,
        "arn": arn,
        "registered_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    # Upsert: replace existing entry with same name, or append
    updated = False
    for i, existing in enumerate(entries):
        if existing.get("name") == name:
            entries[i] = entry
            updated = True
            break
    if not updated:
        entries.append(entry)

    _save_registry(_DATASETS_REGISTRY, entries)


# ── Subcommand: list-datasets ─────────────────────────────────────────────────


def cmd_list_datasets(args):
    """List all registered datasets from the local registry.

    Returns JSON: {"datasets": [...]}
    """
    entries = _load_registry(_DATASETS_REGISTRY)
    # Filter by technique if provided
    technique = getattr(args, 'technique', None)
    if technique:
        entries = [e for e in entries if e.get('technique') == technique]
    _output({"datasets": entries})


# ── Subcommand: register-evaluator ───────────────────────────────────────────


def cmd_register_evaluator(args):
    """Register an evaluator into the local registry.

    Evaluators are Lambda ARN (RLVR) or preference model S3 URI (RLAIF).
    NOTE: The evaluator registry API does not exist yet in the SDK.
    Once an evaluator registry API is available, this should be upgraded
    to use it (similar to how cmd_register_dataset uses DataSet API).
    For now, evaluators always use local JSON.

    Returns JSON: {"name": str, "type": str, "arn_or_uri": str, "technique": str, "registered": bool}
    """
    name = args.name
    eval_type = args.eval_type
    arn_or_uri = args.arn_or_uri
    technique = args.technique
    description = args.description or ""
    project_name = args.project_name or ""

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")
    if not arn_or_uri:
        _error_exit("--arn-or-uri is required", code="MISSING_ARGUMENT")

    # Load existing evaluators
    entries = _load_registry(_EVALUATORS_REGISTRY)

    # Build evaluator entry
    import datetime
    entry = {
        "name": name,
        "type": eval_type,
        "arn_or_uri": arn_or_uri,
        "technique": technique,
        "description": description,
        "project_name": project_name,
        "registered_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    # Upsert: replace existing entry with same name, or append
    updated = False
    for i, existing in enumerate(entries):
        if existing.get("name") == name:
            entries[i] = entry
            updated = True
            break
    if not updated:
        entries.append(entry)

    # Save
    _save_registry(_EVALUATORS_REGISTRY, entries)

    print(f"Registered evaluator '{name}' ({eval_type}) → {arn_or_uri}", file=sys.stderr)
    _output({
        "name": name,
        "type": eval_type,
        "arn_or_uri": arn_or_uri,
        "technique": technique,
        "registered": True,
    })


# ── Subcommand: list-adapters ─────────────────────────────────────────────────


def cmd_list_adapters(args):
    """List adapter versions from the project's Model Package Group.

    Queries MPG for versions where customer_metadata_properties.isAdapter == "true".
    Falls back to empty list if SageMaker API is unreachable (non-fatal).

    Returns JSON: {"adapters": [{"arn": str, "version": int, "tuneTechnique": str,
                                  "datasetS3Uri": str, "parentModelVersionArn": str,
                                  "createdAt": str, "description": str, "modelDataUrl": str}]}
    """
    _check_sagemaker_core()

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        from sagemaker.core.resources import ModelPackage

        # List all model packages in the group
        packages = ModelPackage.get_all(model_package_group_name=project_name)

        adapters = []
        for pkg in packages:
            metadata = getattr(pkg, "customer_metadata_properties", None) or {}
            if metadata.get("isAdapter") == "true":
                # Extract version from ARN
                arn = pkg.model_package_arn
                version = _extract_version_from_arn(arn)

                # Extract model data URL from inference spec if available
                model_data_url = ""
                inference_spec = getattr(pkg, "inference_specification", None)
                if inference_spec and isinstance(inference_spec, dict):
                    containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
                    if containers:
                        model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")

                # Get creation time
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
        # Non-fatal: return empty list on API failures
        if "does not exist" in error_msg or "not found" in error_msg:
            print(f"Model Package Group '{project_name}' not found — no registry adapters", file=sys.stderr)
        else:
            print(f"Warning: Could not query registry for adapters: {e}", file=sys.stderr)
        _output({"adapters": []})


# ── Subcommand: list-models ────────────────────────────────────────────────────


def cmd_list_models(args):
    """List base model versions (non-adapter) from the project's Model Package Group.

    Queries MPG for versions where customer_metadata_properties.isAdapter != "true".
    Falls back to empty list if SageMaker API is unreachable (non-fatal).

    Returns JSON: {"models": [{"arn": str, "version": int, "deploymentConfig": str,
                                "modelName": str, "instanceType": str,
                                "modelDataUrl": str, "containerImage": str,
                                "createdAt": str, "description": str}]}
    """
    _check_sagemaker_core()

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        from sagemaker.core.resources import ModelPackage

        # List all model packages in the group
        packages = ModelPackage.get_all(model_package_group_name=project_name)

        models = []
        for pkg in packages:
            metadata = getattr(pkg, "customer_metadata_properties", None) or {}
            # Filter out adapters — only include base models
            if metadata.get("isAdapter") == "true":
                continue

            # Extract version from ARN
            arn = pkg.model_package_arn
            version = _extract_version_from_arn(arn)

            # Extract model data URL and container image from inference spec
            model_data_url = ""
            container_image = ""
            inference_spec = getattr(pkg, "inference_specification", None)
            if inference_spec and isinstance(inference_spec, dict):
                containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
                if containers:
                    model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")
                    container_image = containers[0].get("Image", "") or containers[0].get("image", "")

            # Get creation time
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
        # Non-fatal: return empty list on API failures
        if "does not exist" in error_msg or "not found" in error_msg:
            print(f"Model Package Group '{project_name}' not found — no registry models", file=sys.stderr)
        else:
            print(f"Warning: Could not query registry for models: {e}", file=sys.stderr)
        _output({"models": []})


# ── Subcommand: get-version ──────────────────────────────────────────────────


def cmd_get_version(args):
    """Get details for a specific model package version by ARN.

    Returns JSON with full version metadata including model data URL.

    Returns JSON: {"arn": str, "version": int, "status": str, "description": str,
                   "modelDataUrl": str, "metadata": dict}
    """
    _check_sagemaker_core()

    version_arn = args.arn
    if not version_arn:
        _error_exit("--arn is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    try:
        from sagemaker.core.resources import ModelPackage

        pkg = ModelPackage.get(model_package_arn=version_arn)

        # Extract model data URL from inference spec
        model_data_url = ""
        inference_spec = getattr(pkg, "inference_specification", None)
        if inference_spec and isinstance(inference_spec, dict):
            containers = inference_spec.get("Containers") or inference_spec.get("containers") or []
            if containers:
                model_data_url = containers[0].get("ModelDataUrl", "") or containers[0].get("model_data_url", "")

        # Get metadata
        metadata = getattr(pkg, "customer_metadata_properties", None) or {}

        # Get status
        status = getattr(pkg, "model_approval_status", "") or ""

        # Get description
        description = getattr(pkg, "model_package_description", "") or ""

        # Get version from ARN
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


# ── Subcommand: resolve-dataset ──────────────────────────────────────────────


def cmd_resolve_dataset(args):
    """Resolve a registered dataset by name.

    Uses SageMaker AI Registry DataSet.get() when available, falls back to
    local JSON registry. Includes ARN in output when available (Backlog #023).

    Returns JSON: {"name": str, "s3_uri": str, "arn": str|null, "format": str, "technique": str, ...}
    or error if not found.
    """
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    # Try SageMaker AI Registry API first
    if _check_ai_registry():
        try:
            from sagemaker.ai_registry.dataset import DataSet

            dataset = DataSet.get(name=name)
            # Build response from AI Registry object
            _output({
                "name": dataset.name if hasattr(dataset, 'name') else name,
                "s3_uri": dataset.source if hasattr(dataset, 'source') else "",
                "arn": dataset.arn if hasattr(dataset, 'arn') else None,
                "format": "jsonl",  # AI Registry may not store format
                "technique": getattr(dataset, 'customization_technique', '').lower() if hasattr(dataset, 'customization_technique') else "",
            })
        except Exception as e:
            # AI Registry lookup failed — fall through to local registry
            print(f"AI Registry lookup failed for '{name}': {e}. Trying local registry.", file=sys.stderr)

    # Fallback: local registry
    entries = _load_registry(_DATASETS_REGISTRY)
    for entry in entries:
        if entry.get("name") == name:
            # Include arn field if present in local registry (Backlog #023)
            output = dict(entry)
            if "arn" not in output:
                output["arn"] = None
            _output(output)

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


# ── Subcommand: resolve-evaluator ────────────────────────────────────────────


def cmd_resolve_evaluator(args):
    """Resolve a registered evaluator by name.

    Returns JSON: {"name": str, "type": str, "arn_or_uri": str, "technique": str, ...}
    or error if not found.
    """
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    entries = _load_registry(_EVALUATORS_REGISTRY)
    for entry in entries:
        if entry.get("name") == name:
            _output(entry)

    _error_exit(f"Evaluator not found: {name}", code="EVALUATOR_NOT_FOUND")


# ── CLI argument parsing ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Model Package Group helper for model registration",
        prog=".register_helper.py",
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # ── create-mpg ────────────────────────────────────────────────────────
    mpg_parser = subparsers.add_parser(
        "create-mpg",
        help="Create a Model Package Group (idempotent)",
    )
    mpg_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    mpg_parser.add_argument("--region", default=None, help="AWS region")

    # ── register-model ────────────────────────────────────────────────────
    reg_parser = subparsers.add_parser(
        "register-model",
        help="Register a model as a versioned Model Package",
    )
    reg_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    reg_parser.add_argument("--deployment-config", default="", help="Deployment config (e.g., gpu-vllm)")
    reg_parser.add_argument("--container-image", default="", help="Container image URI")
    reg_parser.add_argument("--model-data-url", default="", help="Model data S3 URI")
    reg_parser.add_argument("--instance-type", default="", help="Instance type (e.g., ml.g5.2xlarge)")
    reg_parser.add_argument("--architecture", default="", help="Architecture (e.g., transformers)")
    reg_parser.add_argument("--backend", default="", help="Backend (e.g., vllm)")
    reg_parser.add_argument("--model-name", default="", help="Model name (e.g., meta-llama/Llama-3.1-8B)")
    reg_parser.add_argument("--base-image", default="", help="Base container image")
    reg_parser.add_argument("--model-format", default="", help="Model format (e.g., safetensors)")
    reg_parser.add_argument("--generator-version", default="", help="Generator version")
    reg_parser.add_argument("--region", default=None, help="AWS region")
    reg_parser.add_argument("--role-arn", default="", help="IAM execution role ARN")
    reg_parser.add_argument("--benchmark-results", default=None, help="Benchmark results JSON string")

    # ── register-adapter ──────────────────────────────────────────────────
    adapter_parser = subparsers.add_parser(
        "register-adapter",
        help="Register an adapter as a versioned Model Package linked to base model",
    )
    adapter_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    adapter_parser.add_argument("--parent-version-arn", required=True, help="Base model version ARN in the same MPG")
    adapter_parser.add_argument("--tune-technique", default="", help="Tune technique (sft/dpo/rlvr)")
    adapter_parser.add_argument("--dataset-s3-uri", default="", help="Training dataset S3 URI")
    adapter_parser.add_argument("--deployment-config", default="", help="Deployment config (e.g., gpu-vllm)")
    adapter_parser.add_argument("--container-image", default="", help="Container image URI")
    adapter_parser.add_argument("--model-data-url", default="", help="Model/adapter data S3 URI")
    adapter_parser.add_argument("--instance-type", default="", help="Instance type (e.g., ml.g5.2xlarge)")
    adapter_parser.add_argument("--architecture", default="", help="Architecture (e.g., transformers)")
    adapter_parser.add_argument("--backend", default="", help="Backend (e.g., vllm)")
    adapter_parser.add_argument("--model-name", default="", help="Model name (e.g., meta-llama/Llama-3.1-8B)")
    adapter_parser.add_argument("--base-image", default="", help="Base container image")
    adapter_parser.add_argument("--model-format", default="", help="Model format (e.g., safetensors)")
    adapter_parser.add_argument("--generator-version", default="", help="Generator version")
    adapter_parser.add_argument("--region", default=None, help="AWS region")
    adapter_parser.add_argument("--role-arn", default="", help="IAM execution role ARN")

    # ── register-dataset ─────────────────────────────────────────────────
    dataset_parser = subparsers.add_parser(
        "register-dataset",
        help="Register a dataset into the local registry (AI Registry fallback)",
    )
    dataset_parser.add_argument("--name", required=True, help="Dataset name (unique identifier)")
    dataset_parser.add_argument("--s3-uri", required=True, help="S3 URI of the dataset")
    dataset_parser.add_argument("--format", default="jsonl", choices=["jsonl", "parquet", "csv"],
                                help="Dataset format (jsonl/parquet/csv)")
    dataset_parser.add_argument("--technique", default="sft", choices=["sft", "dpo", "rlaif", "rlvr"],
                                help="Associated tuning technique")
    dataset_parser.add_argument("--row-count", type=int, default=None, help="Number of rows in dataset")
    dataset_parser.add_argument("--column-schema", default=None,
                                help="Column schema as JSON string")
    dataset_parser.add_argument("--project-name", default=None, help="Project name for context")

    # ── list-datasets ─────────────────────────────────────────────────────────
    list_datasets_parser = subparsers.add_parser(
        "list-datasets",
        help="List all registered datasets from the local registry",
    )
    list_datasets_parser.add_argument("--technique", default=None, choices=["sft", "dpo", "rlaif", "rlvr"],
                                      help="Filter by tuning technique")

    # ── register-evaluator ────────────────────────────────────────────────
    evaluator_parser = subparsers.add_parser(
        "register-evaluator",
        help="Register an evaluator (Lambda ARN or preference model) into the local registry",
    )
    evaluator_parser.add_argument("--name", required=True, help="Evaluator name (unique identifier)")
    evaluator_parser.add_argument("--type", required=True, choices=["lambda", "model"],
                                  help="Evaluator type (lambda/model)", dest="eval_type")
    evaluator_parser.add_argument("--arn-or-uri", required=True,
                                  help="Lambda ARN (RLVR) or model S3 URI (RLAIF)")
    evaluator_parser.add_argument("--technique", required=True, choices=["rlvr", "rlaif"],
                                  help="Associated technique (rlvr/rlaif)")
    evaluator_parser.add_argument("--description", default="", help="Evaluator description")
    evaluator_parser.add_argument("--project-name", default=None, help="Project name for context")

    # ── list-adapters ─────────────────────────────────────────────────────
    list_adapters_parser = subparsers.add_parser(
        "list-adapters",
        help="List adapter versions from the project's Model Package Group",
    )
    list_adapters_parser.add_argument("--project-name", required=True, help="Project name (MPG name)")
    list_adapters_parser.add_argument("--region", default=None, help="AWS region")

    # ── list-models ───────────────────────────────────────────────────────
    list_models_parser = subparsers.add_parser(
        "list-models",
        help="List base model versions (non-adapter) from the project's Model Package Group",
    )
    list_models_parser.add_argument("--project-name", required=True, help="Project name (MPG name)")
    list_models_parser.add_argument("--region", default=None, help="AWS region")

    # ── get-version ───────────────────────────────────────────────────────
    get_version_parser = subparsers.add_parser(
        "get-version",
        help="Get details for a specific model package version by ARN",
    )
    get_version_parser.add_argument("--arn", required=True, help="Model package version ARN")
    get_version_parser.add_argument("--region", default=None, help="AWS region")

    # ── resolve-dataset ───────────────────────────────────────────────────
    resolve_dataset_parser = subparsers.add_parser(
        "resolve-dataset",
        help="Resolve a registered dataset by name",
    )
    resolve_dataset_parser.add_argument("--name", required=True, help="Dataset name to resolve")

    # ── resolve-evaluator ─────────────────────────────────────────────────
    resolve_evaluator_parser = subparsers.add_parser(
        "resolve-evaluator",
        help="Resolve a registered evaluator by name",
    )
    resolve_evaluator_parser.add_argument("--name", required=True, help="Evaluator name to resolve")

    # ── Parse and dispatch ────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "create-mpg":
        cmd_create_mpg(args)
    elif args.command == "register-model":
        cmd_register_model(args)
    elif args.command == "register-adapter":
        cmd_register_adapter(args)
    elif args.command == "register-dataset":
        cmd_register_dataset(args)
    elif args.command == "list-datasets":
        cmd_list_datasets(args)
    elif args.command == "register-evaluator":
        cmd_register_evaluator(args)
    elif args.command == "list-adapters":
        cmd_list_adapters(args)
    elif args.command == "list-models":
        cmd_list_models(args)
    elif args.command == "get-version":
        cmd_get_version(args)
    elif args.command == "resolve-dataset":
        cmd_resolve_dataset(args)
    elif args.command == "resolve-evaluator":
        cmd_resolve_evaluator(args)
    else:
        _error_exit(f"Unknown subcommand: {args.command}", code="UNKNOWN_COMMAND")


if __name__ == "__main__":
    main()
