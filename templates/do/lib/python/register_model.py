from __future__ import annotations
"""Register model: create MPG, register models and adapters.

Purpose: cmd_create_mpg, cmd_register_model, cmd_register_adapter subcommands
Inputs: --project-name, --container-image, --model-data-url, metadata fields
Outputs: JSON with mpg_arn, model_package_arn, version
Caller: .register_helper.py dispatcher
Related: register_common.py (registry constants), common.py (output utilities)
"""

import json
import logging
import os
import sys

from common import _output, _error_exit, _warn, _check_sagemaker_core
from register_common import MAX_METADATA_VALUE_LEN

logger = logging.getLogger(__name__)


class BaseRunNotFoundError(RuntimeError):
    """Raised when the base model's MLflow run id cannot be resolved for a family.

    Emitted by ``_resolve_base_source_run_id`` when ``search_family`` returns no
    base member (empty family, or no member with ``mlcc.artifact_type == 'base'``).
    ``cmd_register_adapter`` catches it and fails fast **before** any adapter
    registration, so an adapter is never recorded with a missing/guessed base
    link (enforces the Req 3 resolve-before-register ordering under failure too).

    Related: _resolve_base_source_run_id, cmd_register_adapter
    """


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
                    if str(bval):
                        props[f"benchmark_{bkey}"] = str(bval)
        except (json.JSONDecodeError, TypeError):
            _warn("Could not parse benchmark results, skipping")

    return _truncate_metadata(props)


def _build_adapter_metadata(args):
    """Build customer_metadata_properties dict for adapter registration.

    BL056 (Req 4): mirrors the MLflow family linkage into the SageMaker MPG by
    adding ``mlcc.family`` and ``mlcc.base_model_id`` (both = the base id) to the
    metadata that feeds ``create_model_package``. All existing keys are
    preserved; these two are additive. Base ids are short, so ``_truncate_metadata``
    is a no-op for them in practice.
    """
    base_id = getattr(args, "base_id", "") or ""
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
        # BL056 additions (Req 4): family linkage mirrored into the MPG version.
        "mlcc.family": base_id,
        "mlcc.base_model_id": base_id,
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


def _resolve_base_source_run_id(base_id, client=None):
    """Resolve the base model's MLflow run id (Source_Run_Id) for ``base_id``.

    Looks up the family via ``mlcc_mlflow.search_family(base_id)``, selects the
    base member (``mlcc.artifact_type == 'base'``), and returns its source run
    id. This runs **before** the adapter is registered so the adapter's lineage
    links to the correct base run (BL056 Req 3).

    Raises ``BaseRunNotFoundError`` when no base member is present in the family
    (empty search result, or no member tagged ``artifact_type == 'base'``), so
    the caller can fail fast without registering an adapter with a missing base
    link.

    Related: mlcc_mlflow.search_family, cmd_register_adapter
    """
    import mlcc_mlflow

    members = mlcc_mlflow.search_family(base_id, client=client)
    for member in members:
        if mlcc_mlflow._tag_value(member, mlcc_mlflow.TAG_ARTIFACT_TYPE) == "base":
            run_id = _base_member_run_id(member)
            if run_id:
                return run_id

    raise BaseRunNotFoundError(
        f"No base model run found for family '{base_id}'; cannot resolve the "
        f"base source_run_id required to register the adapter with lineage."
    )


def _base_member_run_id(member):
    """Read a base LoggedModel's source run id, tolerating attr/dict shapes.

    MLflow ``LoggedModel`` records expose the producing run via ``source_run_id``.
    Falls back to ``run_id`` and to dict-style access so injected test doubles
    and real records both work.
    """
    for attr in ("source_run_id", "run_id"):
        value = getattr(member, attr, None)
        if value:
            return value
    if isinstance(member, dict):
        return member.get("source_run_id") or member.get("run_id")
    return None


def _register_adapter_in_mlflow(base_id, adapter_name, model_uri, source_run_id,
                                adapter_type, client=None):
    """Register the adapter as a family sub-model in MLflow (BL056 Reqs 1, 2).

    Writes a ``<base_id>__adapter__<name>`` registered model through
    ``mlcc_mlflow.register`` (which applies the ``sanitize_name`` guard), tagged
    with ``family_tags(base_id, 'adapter')`` and parameterized with
    ``family_params(base_id, base_model_run_id=source_run_id, adapter_type=...)``.

    Naming-failure fallback (Req 1.2): if the registry resolves/accepts a name
    other than the intended ``<base_id>__adapter__<name>``, registration is NOT
    failed or rolled back — the adapter is registered under the resolved name and
    a warning recording the naming/lineage divergence is logged.

    Returns the ``(intended_name, registered_name)`` pair.

    Related: mlcc_mlflow.register, mlcc_mlflow.family_tags, mlcc_mlflow.family_params
    """
    import mlcc_mlflow

    intended_name = f"{base_id}__adapter__{adapter_name}"
    version = mlcc_mlflow.register(
        model_uri=model_uri,
        name=intended_name,
        tags=mlcc_mlflow.family_tags(base_id, "adapter"),
        params=mlcc_mlflow.family_params(
            base_id,
            base_model_run_id=source_run_id,
            adapter_type=(adapter_type or None),
        ),
        client=client,
    )

    # The registry identity is sanitize_name(intended_name). If the name the
    # registry actually used diverges from the intended sub-model name, record a
    # warning (Req 1.2) but keep the registration.
    expected_name = mlcc_mlflow.sanitize_name(intended_name)
    registered_name = getattr(version, "name", None) or expected_name
    if registered_name != expected_name:
        logger.warning(
            "BL056 adapter naming/lineage violation: adapter for family '%s' "
            "was registered as '%s' instead of the intended family sub-model "
            "name '%s' (sanitized: '%s'). Registration succeeded under the "
            "resolved name; lineage may not group under the base model.",
            base_id, registered_name, intended_name, expected_name,
        )

    return intended_name, registered_name


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

    # Step 2.1: BL056 — register the adapter as a family sub-model in MLflow.
    # Resolve the base source_run_id FIRST (Req 3), then register with family
    # tags/params (Reqs 1, 2). Gated on --base-id: pre-BL056 callers that do not
    # supply a family id skip MLflow family tracking (MPG mirror still applies).
    base_id = getattr(args, "base_id", "") or ""
    adapter_name = getattr(args, "adapter_name", "") or ""
    mlflow_registered_name = None
    if base_id and adapter_name:
        try:
            # Resolve-before-register: this MUST complete before register(...).
            source_run_id = _resolve_base_source_run_id(base_id)
            _, mlflow_registered_name = _register_adapter_in_mlflow(
                base_id=base_id,
                adapter_name=adapter_name,
                model_uri=(args.model_data_url or "").rstrip("/"),
                source_run_id=source_run_id,
                adapter_type=(args.tune_technique or None),
            )
            print(
                f"Registered adapter family sub-model in MLflow: {mlflow_registered_name}",
                file=sys.stderr,
            )
        except BaseRunNotFoundError as e:
            # Fail fast BEFORE any adapter registration — never link to a
            # missing/guessed base run (enforces Req 3 under the failure path).
            _error_exit(str(e), code="BASE_RUN_NOT_FOUND")
        except Exception as e:
            # MLflow unavailable/unconfigured (or other MLflow errors): the
            # adapter cannot be recorded as a family sub-model, which is a hard
            # error, not a silent skip.
            _error_exit(
                f"Failed to register adapter as a family sub-model in MLflow: {e}",
                code="MLFLOW_UNAVAILABLE",
            )

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
