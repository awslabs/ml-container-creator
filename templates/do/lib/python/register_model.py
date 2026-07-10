from __future__ import annotations
"""Register model: create MPG, register models and adapters.

Purpose: cmd_create_mpg, cmd_register_model, cmd_register_adapter subcommands
Inputs: --project-name, --container-image, --model-data-url, metadata fields
Outputs: JSON with mpg_arn, model_package_arn, version
Caller: .register_helper.py dispatcher
Related: register_common.py (registry constants), common.py (output utilities)
"""

import json
import os
import sys

from common import _output, _error_exit, _warn, _check_sagemaker_core
from register_common import MAX_METADATA_VALUE_LEN


# ── Metadata helpers ──────────────────────────────────────────────────────────


def _truncate_metadata(props):
    """Truncate metadata values exceeding 256 chars with '…' suffix and log warning."""
    result = {}
    for key, value in props.items():
        str_val = str(value) if value is not None else ""
        if len(str_val) > MAX_METADATA_VALUE_LEN:
            _warn(f"Metadata '{key}' truncated ({len(str_val)} \u2192 {MAX_METADATA_VALUE_LEN} chars)")
            str_val = str_val[: MAX_METADATA_VALUE_LEN - 1] + "\u2026"
        result[key] = str_val
    return result


def _inject_eval_metrics(metadata, args):
    """Inject evaluation metrics from .mlcc/eval-results/ into metadata."""
    if metadata is None:
        metadata = {}

    script_dir = os.path.dirname(os.path.abspath(__file__))
    eval_results_dir = os.path.join(script_dir, "..", "..", "..", ".mlcc", "eval-results")

    if not os.path.isdir(eval_results_dir):
        return metadata

    adapter_name = getattr(args, 'adapter_name', '') or ''

    eval_file = None
    if adapter_name:
        candidate = os.path.join(eval_results_dir, f"{adapter_name}.json")
        if os.path.isfile(candidate):
            eval_file = candidate

    if not eval_file:
        try:
            json_files = [f for f in os.listdir(eval_results_dir) if f.endswith('.json')]
            if json_files:
                json_files.sort(key=lambda f: os.path.getmtime(os.path.join(eval_results_dir, f)), reverse=True)
                eval_file = os.path.join(eval_results_dir, json_files[0])
        except OSError:
            pass

    if not eval_file:
        return metadata

    try:
        with open(eval_file, 'r') as f:
            eval_data = json.load(f)
        metrics = eval_data.get("metrics", {})
        for metric_name, metric_value in metrics.items():
            key = f"eval_{metric_name}"
            str_val = str(metric_value)[:MAX_METADATA_VALUE_LEN]
            metadata[key] = str_val
        if metrics:
            _warn(f"Injected {len(metrics)} eval metric(s) from {os.path.basename(eval_file)}")
    except (IOError, json.JSONDecodeError, KeyError):
        pass

    return metadata


def _build_metadata(args):
    """Build customer_metadata_properties dict from CLI args."""
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
    """Build customer_metadata_properties dict for adapter registration."""
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
        "isAdapter": "true",
        "parentModelVersionArn": args.parent_version_arn or "",
        "tuneTechnique": args.tune_technique or "",
        "datasetS3Uri": args.dataset_s3_uri or "",
    }

    dataset_version = getattr(args, "dataset_version", "") or ""
    if dataset_version:
        props["datasetVersion"] = dataset_version

    return _truncate_metadata(props)


def _get_account_id():
    """Get AWS account ID from STS."""
    try:
        import boto3
        sts = boto3.client("sts")
        return sts.get_caller_identity()["Account"]
    except Exception:
        return "unknown"


def _extract_version_from_arn(arn):
    """Extract version number from a model package ARN."""
    try:
        parts = arn.split("/")
        return int(parts[-1])
    except (ValueError, IndexError):
        return 0


def _check_ai_registry():
    """Verify sagemaker.ai_registry.dataset is available."""
    try:
        from sagemaker.ai_registry.dataset import DataSet  # noqa: F401
        return True
    except (ImportError, Exception):
        return False


# ── Subcommand: create-mpg ────────────────────────────────────────────────────


def cmd_create_mpg(args):
    """Create a Model Package Group (idempotent — handles AlreadyExists)."""
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
            print(f"Model Package Group '{project_name}' already exists", file=sys.stderr)
            try:
                mpg = ModelPackageGroup.get(model_package_group_name=project_name)
                mpg_arn = mpg.model_package_group_arn
                _output({"mpg_arn": mpg_arn, "created": False})
            except Exception:
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
                _output({"mpg_arn": mpg_arn, "created": False})
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")


# ── Subcommand: register-model ────────────────────────────────────────────────


def cmd_register_model(args):
    """Register a model as a versioned Model Package in the project's MPG."""
    _check_sagemaker_core()

    from sagemaker.core.resources import ModelPackageGroup

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    # Step 1: Create MPG if it doesn't exist
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

    # Step 2: Build metadata
    metadata = _build_metadata(args)

    # Step 3: Build inference specification
    container_image = args.container_image or ""
    model_data_url = (args.model_data_url or "").rstrip("/")

    # Step 4: Create Model Package version
    description = f"{args.deployment_config or 'model'} on {args.instance_type or 'unknown'}"

    print(f"Registering model version in {project_name}...", file=sys.stderr)
    try:
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)

        create_params = {
            "ModelPackageGroupName": project_name,
            "ModelPackageDescription": description,
            "ModelApprovalStatus": "Approved",
        }
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
                if not metadata:
                    metadata = {}
                metadata["modelDataUrl"] = model_data_url[:1024]
        if metadata:
            create_params["CustomerMetadataProperties"] = metadata

        response = sm_client.create_model_package(**create_params)
        model_package_arn = response["ModelPackageArn"]

        version = _extract_version_from_arn(model_package_arn)

        print(f"Registered model version {version}: {model_package_arn}", file=sys.stderr)
        _output({
            "mpg_arn": mpg_arn,
            "model_package_arn": model_package_arn,
            "version": version,
        })
    except Exception as e:
        _error_exit(f"Failed to register model package: {e}", code="MODEL_REGISTER_FAILED")


# ── Subcommand: register-adapter ─────────────────────────────────────────────


def cmd_register_adapter(args):
    """Register an adapter as a versioned Model Package linked to its base model."""
    _check_sagemaker_core()

    from sagemaker.core.resources import ModelPackageGroup

    project_name = args.project_name
    if not project_name:
        _error_exit("--project-name is required", code="MISSING_ARGUMENT")

    parent_version_arn = args.parent_version_arn
    if not parent_version_arn:
        _error_exit("--parent-version-arn is required", code="MISSING_ARGUMENT")

    region = args.region or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION", "us-west-2")
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ.setdefault("AWS_REGION", region)

    # Step 1: Create MPG if it doesn't exist
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

    # Step 2: Build adapter metadata
    metadata = _build_adapter_metadata(args)

    # Step 2.5: Dedup check
    try:
        from sagemaker.core.resources import ModelPackage as _MP
        packages = _MP.get_all(model_package_group_name=project_name)
        for pkg in packages:
            existing_meta = getattr(pkg, "customer_metadata_properties", None) or {}
            if (existing_meta.get("isAdapter") == "true" and
                existing_meta.get("parentModelVersionArn") == parent_version_arn and
                existing_meta.get("tuneTechnique") == (args.tune_technique or "") and
                existing_meta.get("datasetS3Uri") == (args.dataset_s3_uri or "")):
                existing_arn = pkg.model_package_arn
                existing_version = _extract_version_from_arn(existing_arn)
                print(f"Adapter already registered as version {existing_version} (likely by SFTTrainer)", file=sys.stderr)
                print(f"Supplementing with deployment metadata...", file=sys.stderr)
                _output({
                    "mpg_arn": mpg_arn,
                    "model_package_arn": existing_arn,
                    "version": existing_version,
                    "parent_version_arn": parent_version_arn,
                    "deduplicated": True,
                })
    except Exception as dedup_err:
        print(f"Dedup check failed (non-fatal): {dedup_err}", file=sys.stderr)

    # Step 3: Build inference specification
    container_image = args.container_image or ""
    model_data_url = (args.model_data_url or "").rstrip("/")

    # Step 4: Create adapter Model Package version
    technique = args.tune_technique or "unknown"
    description = f"adapter ({technique}) on {args.instance_type or 'unknown'}, parent: {parent_version_arn}"

    print(f"Registering adapter version in {project_name}...", file=sys.stderr)
    try:
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)

        create_params = {
            "ModelPackageGroupName": project_name,
            "ModelPackageDescription": description,
            "ModelApprovalStatus": "Approved",
        }
        if container_image and ".dkr.ecr." in container_image:
            create_params["InferenceSpecification"] = {
                "Containers": [{"Image": container_image}],
                "SupportedContentTypes": ["application/json"],
                "SupportedResponseMIMETypes": ["application/json"],
            }
            if model_data_url and model_data_url.endswith(".tar.gz"):
                create_params["InferenceSpecification"]["Containers"][0]["ModelDataUrl"] = model_data_url

        if model_data_url:
            if not metadata:
                metadata = {}
            metadata["modelDataUrl"] = model_data_url[:1024]

        metadata = _inject_eval_metrics(metadata, args)

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
