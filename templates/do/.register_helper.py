#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Model Package Group helper for model registration.

Subcommands:
    create-mpg       - Create a Model Package Group (idempotent)
    register-model   - Register a model as a versioned Model Package
    register-adapter - Register an adapter as a versioned Model Package linked to base model
    register-dataset - Register a dataset with content-aware versioning
    resolve-dataset  - Resolve a dataset by name (with optional version)

Uses sagemaker-core ModelPackageGroup and ModelPackage resource APIs (SDK v3).
No boto3 sagemaker client per NFR-3.

All output is JSON on stdout for bash consumption.
Diagnostic messages go to stderr.

Dataset Versioning (F4 Research Spike Findings):
    - DataSet.create() in sagemaker.ai_registry.dataset does NOT accept a `hub_content_version`
      parameter directly. The API signature is: DataSet.create(name=, source=, customization_technique=).
    - DataSet.get() does NOT accept a version filter — it retrieves by name only (latest).
    - There is no `list_hub_content_versions` equivalent for DataSet objects.
    - Conclusion: Native versioning is NOT supported via the DataSet API.
    - Implementation approach: Use description field to embed hash (`[hash:<hex>] description`)
      and local JSON registry with `versions[]` array for version tracking.
    - Multipart S3 ETags (format: `hash-parts`) are not true content hashes but serve as
      change-detection proxies. This is documented and acceptable per design.
"""

import argparse
import hashlib
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
        if not str_val:
            continue  # SageMaker requires min length 1 for metadata values — skip empty
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
    isAdapter, parentModelVersionArn, tuneTechnique, datasetS3Uri, datasetVersion.
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

    # Include dataset version lineage if available (AC-2.7)
    dataset_version = getattr(args, "dataset_version", "") or ""
    if dataset_version:
        props["datasetVersion"] = dataset_version

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

    # Step 4: Create Model Package version (AC-1.2, AC-1.7)
    description = f"{args.deployment_config or 'model'} on {args.instance_type or 'unknown'}"

    print(f"Registering model version in {project_name}...", file=sys.stderr)
    try:
        # Use boto3 directly — sagemaker-core v2.14 has a KeyError bug in ModelPackage.create()
        # where it tries to read response["ModelPackageName"] but the API returns "ModelPackageArn".
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)

        create_params = {
            "ModelPackageGroupName": project_name,
            "ModelPackageDescription": description,
            "ModelApprovalStatus": "Approved",
        }
        # Only include InferenceSpecification if container image is a valid ECR URI.
        # Non-ECR images (e.g., vllm/vllm-openai:v0.20.2 from DockerHub) cause
        # ValidationException: "Provided image is not a valid ECR image."
        if container_image and ".dkr.ecr." in container_image:
            create_params["InferenceSpecification"] = {
                "Containers": [{"Image": container_image}],
                "SupportedContentTypes": ["application/json"],
                "SupportedResponseMIMETypes": ["application/json"],
            }
            if model_data_url:
                create_params["InferenceSpecification"]["Containers"][0]["ModelDataUrl"] = model_data_url
        if model_data_url:
            if "InferenceSpecification" not in create_params:
                # Store model data URL in metadata if no container image
                if not metadata:
                    metadata = {}
                metadata["modelDataUrl"] = model_data_url[:1024]
        if metadata:
            create_params["CustomerMetadataProperties"] = metadata

        response = sm_client.create_model_package(**create_params)
        model_package_arn = response["ModelPackageArn"]

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

    # Step 4: Create adapter Model Package version (AC-2.1)
    technique = args.tune_technique or "unknown"
    description = f"adapter ({technique}) on {args.instance_type or 'unknown'}, parent: {parent_version_arn}"

    print(f"Registering adapter version in {project_name}...", file=sys.stderr)
    try:
        # Use boto3 directly — sagemaker-core v2.14 has a KeyError bug in ModelPackage.create()
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)

        create_params = {
            "ModelPackageGroupName": project_name,
            "ModelPackageDescription": description,
            "ModelApprovalStatus": "Approved",
        }
        # Only include InferenceSpecification if container image is a valid ECR URI.
        # Non-ECR images (e.g., vllm/vllm-openai:v0.20.2 from DockerHub) cause
        # ValidationException: "Provided image is not a valid ECR image."
        if container_image and ".dkr.ecr." in container_image:
            create_params["InferenceSpecification"] = {
                "Containers": [{"Image": container_image}],
                "SupportedContentTypes": ["application/json"],
                "SupportedResponseMIMETypes": ["application/json"],
            }
            if model_data_url:
                create_params["InferenceSpecification"]["Containers"][0]["ModelDataUrl"] = model_data_url
        elif model_data_url:
            if not metadata:
                metadata = {}
            metadata["modelDataUrl"] = model_data_url[:1024]
        if metadata:
            create_params["CustomerMetadataProperties"] = metadata

        response = sm_client.create_model_package(**create_params)
        model_package_arn = response["ModelPackageArn"]

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
_CONFIG_PATH = os.path.join(_REGISTRY_DIR, "config.json")
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


def _get_hub_name_from_profile(region=None):
    """Read aiRegistryHubName from the bootstrap profile config.

    Looks up ~/.ml-container-creator/config.json and finds the profile
    matching the given region. If no region is provided or no matching
    profile is found, returns the first profile with an aiRegistryHubName.

    Args:
        region: AWS region to match against profile keys (format: <region>-<accountId>)

    Returns:
        Hub name string (e.g., "mlcc-registry-123456789012") or None if not found.
    """
    try:
        with open(_CONFIG_PATH) as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return None

    profiles = config.get("profiles", {})
    if not profiles:
        return None

    # Try to find a profile matching the region
    if region:
        for profile_key, profile_data in profiles.items():
            if not isinstance(profile_data, dict):
                continue
            # Profile key format: <region>-<accountId>
            if profile_key.startswith(region):
                hub_name = profile_data.get("aiRegistryHubName")
                if hub_name:
                    return hub_name

    # Fallback: return the first profile that has an aiRegistryHubName
    for profile_data in profiles.values():
        if not isinstance(profile_data, dict):
            continue
        hub_name = profile_data.get("aiRegistryHubName")
        if hub_name:
            return hub_name

    return None


def _register_to_hub(hub_name, name, s3_uri, technique, description, region):
    """Register dataset to a specific hub by name.

    Two-phase approach (AC-2.4):
      Phase 1: Check if DataSet.create() accepts a hub_name/config option.
      Phase 2: If no SDK option, use boto3 create_hub_content directly.

    Must target the specific hub by name — never relies on SDK auto-discovery (AC-2.2).

    Args:
        hub_name: The hub name to target (e.g., "mlcc-registry-123456789012")
        name: Dataset name
        s3_uri: S3 URI of the dataset
        technique: Tuning technique string (e.g., "sft")
        description: Dataset description (may contain hash tag)
        region: AWS region

    Returns:
        str: Hub content ARN if successful, None if failed (caller should fall back)
    """
    # ── Phase 1: Check if DataSet.create() accepts hub config ─────────────
    # The sagemaker.ai_registry.dataset.DataSet.create() API signature is:
    #   DataSet.create(name=, source=, customization_technique=, description=)
    # It does NOT accept a hub_name, hub_config, or similar parameter.
    # There is no documented env var or session config to override the target hub.
    # Conclusion: SDK DataSet.create() cannot target a specific hub by name.
    # Proceed to Phase 2.

    # ── Phase 2: Use boto3 create_hub_content directly ────────────────────
    try:
        import boto3

        sm_client = boto3.client("sagemaker", region_name=region)

        # Build the document schema for the dataset hub content
        hub_content_document = json.dumps({
            "Source": s3_uri,
            "CustomizationTechnique": technique or "sft",
        })

        create_params = {
            "HubName": hub_name,
            "HubContentName": name,
            "HubContentType": "Dataset",
            "DocumentSchemaVersion": "1.0.0",
            "HubContentDocument": hub_content_document,
        }

        if description:
            create_params["HubContentDescription"] = description

        response = sm_client.create_hub_content(**create_params)
        hub_content_arn = response.get("HubContentArn", "")
        print(f"Registered dataset '{name}' to hub '{hub_name}' (ARN: {hub_content_arn})", file=sys.stderr)
        return hub_content_arn

    except Exception as e:
        error_msg = str(e).lower()

        # Hub not found — clear actionable message (AC-2.5)
        if ("resourcenotfound" in error_msg or "resource not found" in error_msg
                or "does not exist" in error_msg or "hub" in error_msg and "not found" in error_msg):
            _warn(
                f"Hub '{hub_name}' not found. "
                "Run `ml-container-creator bootstrap` to provision the AI Registry hub."
            )
            print(
                "    Falling back to local JSON registry.",
                file=sys.stderr,
            )
            return None

        # Already exists — idempotent, treat as success
        if "already exists" in error_msg or "resourceinuse" in error_msg:
            print(f"Dataset '{name}' already exists in hub '{hub_name}' (idempotent)", file=sys.stderr)
            # Try to retrieve the ARN
            try:
                describe_resp = sm_client.describe_hub_content(
                    HubName=hub_name,
                    HubContentName=name,
                    HubContentType="Dataset",
                )
                return describe_resp.get("HubContentArn", "")
            except Exception:
                return ""

        # Any other error — warn and fall back
        _warn(
            f"Failed to register dataset to hub '{hub_name}': {e}\n"
            "    If this persists, run `ml-container-creator bootstrap` to verify hub provisioning.\n"
            "    Falling back to local JSON registry."
        )
        return None


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


# ── Dataset Versioning Helpers ─────────────────────────────────────────────────


def _parse_s3_uri(s3_uri):
    """Parse an S3 URI into (bucket, key) tuple.

    Args:
        s3_uri: S3 URI in format s3://bucket/key or s3://bucket/prefix/

    Returns:
        Tuple of (bucket, key)
    """
    if not s3_uri.startswith("s3://"):
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    parts = s3_uri[5:].split("/", 1)
    bucket = parts[0]
    key = parts[1] if len(parts) > 1 else ""
    return bucket, key


def _is_s3_prefix(key):
    """Determine if an S3 key represents a prefix (directory) vs single file.

    Heuristic: ends with '/' or has no file extension in the last path component.
    """
    if not key or key.endswith("/"):
        return True
    last_part = key.rstrip("/").split("/")[-1]
    return "." not in last_part


def _compute_content_hash(s3_uri, region):
    """Compute a content hash for a dataset at an S3 URI.

    Single file: S3 ETag (truncated to 16 chars). For non-multipart uploads,
    the ETag is the MD5 of the content. For multipart uploads, ETag is in
    format `hash-parts` — not a true content hash but serves as a change-detection proxy.

    Directory/prefix: Sort all object keys under prefix, concatenate
    "key:etag" strings, then SHA256 the result. Truncated to 16 hex chars.

    Args:
        s3_uri: S3 URI (s3://bucket/key or s3://bucket/prefix/)
        region: AWS region for the S3 client

    Returns:
        16-character hex hash string
    """
    import boto3

    s3 = boto3.client("s3", region_name=region)
    bucket, key = _parse_s3_uri(s3_uri)

    if _is_s3_prefix(key):
        # Prefix/directory — list and hash all objects
        paginator = s3.get_paginator("list_objects_v2")
        etags = []
        prefix = key if key.endswith("/") else key + "/"
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                etag = obj["ETag"].strip('"')
                etags.append(f"{obj['Key']}:{etag}")
        if not etags:
            # Try without trailing slash (might be a single object path without extension)
            head = s3.head_object(Bucket=bucket, Key=key)
            return head["ETag"].strip('"')[:16]
        etags.sort()
        return hashlib.sha256("\n".join(etags).encode()).hexdigest()[:16]
    else:
        # Single file — use ETag directly
        head = s3.head_object(Bucket=bucket, Key=key)
        return head["ETag"].strip('"')[:16]


def _get_latest_version(name):
    """Get the latest version info for a dataset from the local registry.

    Checks local JSON registry for the most recent version of a named dataset.
    Returns the latest version string and its content hash, or None if not found.

    Args:
        name: Dataset name to look up

    Returns:
        dict with keys: version (str), hash (str|None), ordinal (int)
        or None if dataset not found
    """
    entries = _load_registry(_DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions")
            if versions and len(versions) > 0:
                # Return the last version (most recent)
                latest = versions[-1]
                return {
                    "version": latest.get("version", "1.0.0"),
                    "hash": latest.get("hash"),
                    "ordinal": len(versions),
                }
            else:
                # Legacy entry without versions — treat as v1.0.0 with hash=null (NFR-3)
                return {
                    "version": "1.0.0",
                    "hash": None,
                    "ordinal": 1,
                }

    return None


def _increment_version(version_str):
    """Increment a semver-like version string (minor bump).

    1.0.0 → 1.1.0, 1.1.0 → 1.2.0, etc.

    Args:
        version_str: Current version string (e.g., "1.0.0")

    Returns:
        New version string with minor incremented
    """
    parts = version_str.split(".")
    if len(parts) != 3:
        return "1.1.0"
    major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
    return f"{major}.{minor + 1}.{patch}"


# ── Subcommand: register-dataset ─────────────────────────────────────────────


def cmd_register_dataset(args):
    """Register a dataset with content-aware versioning.

    Version logic (AC-1.1 through AC-1.8):
    1. Compute content hash of the S3 URI
    2. Look up latest version for this name
    3. If no existing entry → create version 1.0.0
    4. If hash matches latest → skip (print "Dataset unchanged (v{N})")
    5. If hash differs → create new version (minor increment)
    6. --force flag bypasses hash comparison (always creates new version)

    Uses sagemaker.ai_registry.dataset.DataSet API (SDK v3) when available.
    Falls back to local JSON registry if the API is not installed.

    Returns JSON: {"name": str, "s3_uri": str, "format": str, "technique": str,
                   "version": str, "hash": str|null, "arn": str|null, "registered": bool, "skipped": bool}
    """
    name = args.name
    s3_uri = args.s3_uri
    data_format = getattr(args, "format", "jsonl")
    technique = args.technique
    row_count = args.row_count
    column_schema = args.column_schema
    project_name = args.project_name or ""
    force = getattr(args, "force", False)

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

    # ── Step 1: Compute content hash (AC-1.5) ─────────────────────────────────
    content_hash = None
    if region:
        try:
            content_hash = _compute_content_hash(s3_uri, region)
            print(f"Content hash: {content_hash}", file=sys.stderr)
        except Exception as e:
            _warn(f"Could not compute content hash: {e}. Proceeding without hash.")
    else:
        _warn("No region specified — skipping content hash computation.")

    # ── Step 2: Get latest version (AC-1.2) ───────────────────────────────────
    latest = _get_latest_version(name)

    # ── Step 3: Version decision (AC-1.3, AC-1.4, AC-1.7) ────────────────────
    if latest is None:
        # First registration — version 1.0.0 (AC-1.1)
        new_version = "1.0.0"
        ordinal = 1
        print(f"First registration of '{name}' → v1 ({new_version})", file=sys.stderr)
    else:
        latest_hash = latest["hash"]
        latest_version = latest["version"]
        ordinal = latest["ordinal"]

        if not force and content_hash is not None and latest_hash is not None and content_hash == latest_hash:
            # Hash matches — skip (AC-1.3)
            print(f"Dataset unchanged (v{ordinal})", file=sys.stderr)
            _output({
                "name": name,
                "s3_uri": s3_uri,
                "format": data_format,
                "technique": technique,
                "version": latest_version,
                "hash": latest_hash,
                "arn": None,
                "registered": False,
                "skipped": True,
            })

        # Hash differs or force — create new version (AC-1.4, AC-1.7)
        new_version = _increment_version(latest_version)
        ordinal = ordinal + 1
        if force:
            print(f"Force re-registration of '{name}' → v{ordinal} ({new_version})", file=sys.stderr)
        else:
            print(f"Dataset changed — new version v{ordinal} ({new_version})", file=sys.stderr)

    # ── Step 4: Register via AI Registry (preferred) ──────────────────────────
    description = f"[hash:{content_hash}]" if content_hash else ""
    dataset_arn = None

    # ── Step 4a: Try hub-targeted registration (AC-2.1, AC-2.2) ───────────
    hub_name = _get_hub_name_from_profile(region)

    if hub_name:
        # Hub name available in profile — target it explicitly (never auto-discover)
        print(f"Targeting hub '{hub_name}' for dataset registration...", file=sys.stderr)
        hub_arn = _register_to_hub(hub_name, name, s3_uri, technique, description, region)
        if hub_arn is not None:
            dataset_arn = hub_arn
        else:
            # Hub registration failed — fall back to local JSON only (AC-2.5)
            print("Continuing with local JSON registry only.", file=sys.stderr)
    else:
        # No hub name in profile (legacy/pre-bootstrap) — local JSON only (AC-2.3)
        _warn(
            "No AI Registry hub configured in profile. "
            "Using local JSON registry only.\n"
            "    To enable hub registration, run `ml-container-creator bootstrap`."
        )

    # ── Step 5: Write to local registry with versioning (AC-1.8) ──────────────
    _write_dataset_version_to_local_registry(
        name=name, s3_uri=s3_uri, data_format=data_format,
        technique=technique, row_count=row_count,
        column_schema=column_schema, project_name=project_name,
        arn=dataset_arn, version=new_version, content_hash=content_hash,
    )

    print(f"Registered dataset '{name}' v{ordinal} ({new_version}) → {s3_uri}", file=sys.stderr)
    _output({
        "name": name,
        "s3_uri": s3_uri,
        "format": data_format,
        "technique": technique,
        "version": new_version,
        "hash": content_hash,
        "arn": dataset_arn,
        "registered": True,
        "skipped": False,
    })


def _write_dataset_version_to_local_registry(*, name, s3_uri, data_format, technique,
                                              row_count, column_schema, project_name,
                                              arn, version, content_hash):
    """Write a versioned dataset entry to the local JSON registry.

    Schema (AC-1.8, backward compatible):
    - Each dataset has a `versions[]` array
    - Existing entries without `versions` are treated as v1.0.0 with hash=null (NFR-3)
    - New versions are appended to the array

    Args:
        name: Dataset name
        s3_uri: S3 URI of the dataset
        data_format: Format (jsonl/parquet/csv)
        technique: Tuning technique
        row_count: Number of rows (optional)
        column_schema: Column schema JSON string (optional)
        project_name: Project name for context
        arn: AI Registry ARN (if registered there)
        version: Version string (e.g., "1.0.0")
        content_hash: Content hash string (16-char hex) or None
    """
    import datetime

    entries = _load_registry(_DATASETS_REGISTRY)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    version_entry = {
        "version": version,
        "s3_uri": s3_uri,
        "hash": content_hash,
        "technique": technique,
        "rows": row_count,
        "registered_at": now,
    }

    # Find existing entry for this name
    found = False
    for i, existing in enumerate(entries):
        if existing.get("name") == name:
            found = True
            # Migrate legacy entry (no versions array) to new schema
            if "versions" not in existing:
                legacy_version = {
                    "version": "1.0.0",
                    "s3_uri": existing.get("s3_uri", ""),
                    "hash": None,
                    "technique": existing.get("technique", ""),
                    "rows": existing.get("row_count"),
                    "registered_at": existing.get("registered_at", now),
                }
                existing["versions"] = [legacy_version]

            # Append new version
            existing["versions"].append(version_entry)

            # Update top-level fields to reflect latest
            existing["s3_uri"] = s3_uri
            existing["format"] = data_format
            existing["technique"] = technique
            existing["row_count"] = row_count
            existing["column_schema"] = column_schema
            existing["project_name"] = project_name
            existing["arn"] = arn
            existing["registered_at"] = now
            existing["latest_version"] = version
            existing["content_hash"] = content_hash
            entries[i] = existing
            break

    if not found:
        # New dataset entry
        entry = {
            "name": name,
            "s3_uri": s3_uri,
            "format": data_format,
            "technique": technique,
            "row_count": row_count,
            "column_schema": column_schema,
            "project_name": project_name,
            "arn": arn,
            "registered_at": now,
            "latest_version": version,
            "content_hash": content_hash,
            "versions": [version_entry],
        }
        entries.append(entry)

    _save_registry(_DATASETS_REGISTRY, entries)


# ── Subcommand: list-datasets ─────────────────────────────────────────────────


def cmd_list_datasets(args):
    """List all registered datasets grouped by name with version summary (AC-3.1).

    Enhanced output includes version_count and latest_version per dataset entry.
    Groups by name and shows: NAME, TECHNIQUE, VERSIONS (count), LATEST, ROWS, S3_URI.

    Returns JSON: {"datasets": [{..., "version_count": int, "latest_version": str}, ...]}
    """
    entries = _load_registry(_DATASETS_REGISTRY)

    # Filter by technique if provided
    technique = getattr(args, 'technique', None)
    if technique:
        entries = [e for e in entries if e.get('technique') == technique]

    # Enhance each entry with version_count and latest_version (AC-3.1)
    enhanced = []
    for entry in entries:
        item = dict(entry)
        versions = entry.get("versions", [])
        if versions:
            item["version_count"] = len(versions)
            item["latest_version"] = versions[-1].get("version", "1.0.0")
        else:
            # Legacy entry without versions array — treat as v1.0.0 (NFR-3)
            item["version_count"] = 1
            item["latest_version"] = item.get("latest_version", "1.0.0")
        enhanced.append(item)

    _output({"datasets": enhanced})


# ── Subcommand: list-dataset-versions ─────────────────────────────────────────


def cmd_list_dataset_versions(args):
    """List all versions for a specific dataset by name (AC-3.3).

    Returns all versions with: VERSION, HASH, DATE, ROWS, S3_URI.

    Args (via argparse):
        --name: Dataset name (required)

    Returns JSON: {"name": str, "versions": [{"version": str, "hash": str|null,
                   "date": str, "rows": int|null, "s3_uri": str}, ...]}
    or error if dataset not found.
    """
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    entries = _load_registry(_DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions", [])
            if not versions:
                # Legacy entry without versions array — present as single v1.0.0 (NFR-3)
                versions = [{
                    "version": "1.0.0",
                    "hash": None,
                    "registered_at": entry.get("registered_at", ""),
                    "rows": entry.get("row_count"),
                    "s3_uri": entry.get("s3_uri", ""),
                }]

            # Normalize output format
            result_versions = []
            for v in versions:
                result_versions.append({
                    "version": v.get("version", "1.0.0"),
                    "hash": v.get("hash"),
                    "date": v.get("registered_at", ""),
                    "rows": v.get("rows"),
                    "s3_uri": v.get("s3_uri", ""),
                })

            _output({
                "name": name,
                "versions": result_versions,
            })

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


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
    """Resolve a registered dataset by name (with optional version pinning).

    Uses SageMaker AI Registry DataSet.get() when available, falls back to
    local JSON registry. Includes ARN in output when available (Backlog #023).

    Version resolution (AC-2.1, AC-2.4):
    - --version N: resolve the Nth version (ordinal, 1-based) for this name
    - No --version: resolve latest (existing behavior)
    - If requested version doesn't exist: print available versions and exit 1 (AC-2.5)

    Returns JSON: {"name": str, "s3_uri": str, "arn": str|null, "format": str, "technique": str, "version": str|null, "ordinal": int|null}
    or error if not found.
    """
    name = args.name
    version_ordinal = getattr(args, "version", None)

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    # If version is specified, use version-aware resolution
    if version_ordinal is not None:
        return _resolve_dataset_version(name, version_ordinal)

    # No version — resolve latest (existing behavior)
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
                "version": None,
                "ordinal": None,
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
            # Include latest version info if available
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

    _error_exit(f"Dataset not found: {name}", code="DATASET_NOT_FOUND")


def _resolve_dataset_version(name, version_ordinal):
    """Resolve a specific version (by ordinal) of a named dataset.

    Ordinal is 1-based: @v1 = first registered version, @v2 = second, etc.
    Internally, versions may be semver strings (1.0.0, 1.1.0, 1.2.0).

    If the version doesn't exist, prints available versions and exits 1 (AC-2.5).

    Args:
        name: Dataset name
        version_ordinal: 1-based version ordinal (e.g., 2 for the 2nd version)
    """
    # Load local registry
    entries = _load_registry(_DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions", [])

            if not versions:
                # Legacy entry without versions array — treat as v1
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

            # Check if requested ordinal is valid (1-based index)
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

            # Resolve the specific version (0-based index from 1-based ordinal)
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

    # Dataset name not found at all
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
    adapter_parser.add_argument("--dataset-version", default="", help="Dataset version ordinal (lineage: trained on dataset X version N)")
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
        help="Register a dataset with content-aware versioning",
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
    dataset_parser.add_argument("--region", default=None, help="AWS region (for S3 hash computation)")
    dataset_parser.add_argument("--force", action="store_true", default=False,
                                help="Force new version even if content hash matches (AC-1.7)")

    # ── list-datasets ─────────────────────────────────────────────────────────
    list_datasets_parser = subparsers.add_parser(
        "list-datasets",
        help="List all registered datasets from the local registry",
    )
    list_datasets_parser.add_argument("--technique", default=None, choices=["sft", "dpo", "rlaif", "rlvr"],
                                      help="Filter by tuning technique")

    # ── list-dataset-versions ─────────────────────────────────────────────
    list_dataset_versions_parser = subparsers.add_parser(
        "list-dataset-versions",
        help="List all versions for a specific dataset by name (AC-3.3)",
    )
    list_dataset_versions_parser.add_argument("--name", required=True, help="Dataset name to list versions for")

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
    resolve_dataset_parser.add_argument("--version", type=int, default=None,
                                        help="Version ordinal to resolve (e.g., 2 for the 2nd version). Default: latest.")

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

    # Set region before any sagemaker-core import (creates boto3 clients at import time)
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

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
    elif args.command == "list-dataset-versions":
        cmd_list_dataset_versions(args)
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
