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
    """Truncate metadata values exceeding 256 chars with '…' suffix and log warning.

    Also DROPS empty-string values: SageMaker's CreateModelPackage rejects any
    CustomerMetadataProperties entry with a zero-length value ("Invalid length
    for parameter ... value: 0, valid min length: 1"). Optional fields that were
    not provided (e.g. modelFormat, generatorVersion for a transformers project)
    arrive here as "" and must be OMITTED, not sent as empty — otherwise the
    whole registration fails. Only non-empty metadata is included.
    """
    result = {}
    for key, value in props.items():
        str_val = str(value) if value is not None else ""
        if str_val == "":
            # Omit empty values — SageMaker rejects zero-length metadata entries.
            continue
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


def _build_inference_spec(args):
    """Build a SageMaker InferenceSpecification for a FULL model from the project
    serving config (BL164 OQ-3), so the bridge's Model Package is deployable.

    Only valid for a full_model: the container image + model S3 artifact +
    instance type are the model's OWN deploy target. Adapters log NO spec (a
    hot-loaded adapter has no standalone serving target). Returns None when the
    container image / model data are not both resolvable (register without a
    spec rather than a malformed one). Shape = the sagemaker_mlflow
    InferenceSpecification TypedDict (probe-confirmed keys).
    """
    container_image = (getattr(args, "container_image", "") or "").strip()
    model_data_url = (getattr(args, "model_data_url", "") or "").rstrip("/")
    instance_type = (getattr(args, "instance_type", "") or "").strip()
    if not container_image or not model_data_url:
        return None
    container = {"Image": container_image}
    container["ModelDataSource"] = {
        "S3DataSource": {
            "S3Uri": model_data_url + "/",
            "S3DataType": "S3Prefix",
            "CompressionType": "None",
        }
    }
    spec = {
        "Containers": [container],
        "SupportedContentTypes": ["application/json"],
        "SupportedResponseMIMETypes": ["application/json"],
    }
    if instance_type:
        spec["SupportedRealtimeInferenceInstanceTypes"] = [instance_type]
    return spec


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
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
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
            except (NameError, AttributeError):
                raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
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
            except (NameError, AttributeError):
                raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
            except Exception:
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")

    # Step 2: Build metadata (carried as MLflow version tags/params via the bridge).
    metadata = _build_metadata(args)
    model_data_url = (args.model_data_url or "").rstrip("/")

    # Step 3 (BL164): register the FULL model THROUGH the MLflow bridge so
    # SageMaker auto-creates the Model Package (no hand-rolled create_model_package).
    # A full model carries an inference spec built from the project serving config
    # (OQ-3) → the bridge's package is directly deployable. The group the bridge
    # creates is <registered-model-name>-<hash>; we register under the project
    # name so a project's full models share one bridge group.
    print(f"Registering model version via the MLflow bridge ({project_name})...", file=sys.stderr)
    try:
        import mlcc_mlflow
        if not mlcc_mlflow._mlflow_configured():
            _error_exit(
                "MLflow is not configured; model registration now flows through the "
                "MLflow bridge (BL164). Configure a tracking App via the profile "
                "(mlflowAppArn) and retry.",
                code="MLFLOW_NOT_CONFIGURED",
            )
        # Verb-intent default: register-model ⇒ full_model (OQ-2); --artifact-kind overrides.
        _kind = getattr(args, "artifact_kind", None) or "full_model"
        # Only a full model carries a deployable inference spec.
        inference_spec = _build_inference_spec(args) if _kind == "full_model" else None
        result = mlcc_mlflow.register_via_bridge(
            registered_model_name=project_name,
            model_data_url=model_data_url,
            artifact_kind=_kind,
            tags={k: v for k, v in (metadata or {}).items()},
            inference_spec=inference_spec,
        )
        model_package_arn = result.get("sagemaker_model_package_arn") or ""
        version = result.get("version")
        print(f"Registered full model (MLflow v{version}) → {model_package_arn}", file=sys.stderr)
        _output({
            # mpg_arn: the bridge owns the group; expose the base MPG arn when the
            # package ARN is known (callers use model_package_arn as parent-arn).
            "mpg_arn": mpg_arn,
            "model_package_arn": model_package_arn,
            "version": version,
            "mlflow_registered_model": result.get("registered_model_name"),
        })
    except mlcc_mlflow.MlflowUnavailableError as e:
        _error_exit(f"MLflow unavailable for registration: {e}", code="MLFLOW_UNAVAILABLE")
    except Exception as e:
        _error_exit(f"Failed to register model package via the bridge: {e}", code="MODEL_REGISTER_FAILED")


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
            except (NameError, AttributeError):
                raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
            except Exception:
                account_id = _get_account_id()
                mpg_arn = f"arn:aws:sagemaker:{region}:{account_id}:model-package-group/{project_name}"
        else:
            _error_exit(f"Failed to create Model Package Group: {e}", code="MPG_CREATE_FAILED")

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
            # BL123 (Req 6.1): record the dataset→model lineage edge by logging the
            # training dataset as an input on a run in this family. Non-fatal +
            # idempotent, and driven only by the dataset S3 URI (so it covers the
            # do/train GRPO path with no technique-specific code).
            _dataset_s3_uri = getattr(args, "dataset_s3_uri", "") or ""
            if _dataset_s3_uri:
                try:
                    import mlflow
                    import mlcc_mlflow as _mm
                    if _mm._mlflow_configured():
                        # _mlflow_configured() applies the tracking URI to the env
                        # as a side effect, so mlflow.* picks it up here.
                        active = mlflow.active_run()
                        if active is not None:
                            _mm.log_training_dataset_lineage(
                                dataset_s3_uri=_dataset_s3_uri,
                                dataset_name=adapter_name,
                            )
                        else:
                            # BL163: group the lineage run under the per-project
                            # experiment (sanitized project name) rather than the
                            # shared "Default", so model lineage runs no longer
                            # collide across projects. set_experiment creates it
                            # on first use (idempotent).
                            mlflow.set_experiment(_mm._project_experiment_name(project_name))
                            with mlflow.start_run(run_name=f"lineage-{adapter_name}"):
                                _mm.log_training_dataset_lineage(
                                    dataset_s3_uri=_dataset_s3_uri,
                                    dataset_name=adapter_name,
                                )
                except (NameError, AttributeError):
                    raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
                except Exception as lineage_err:  # noqa: BLE001 — lineage is best-effort
                    print(f"\u26a0\ufe0f  dataset\u2192model lineage edge skipped (non-fatal: "
                          f"{lineage_err}).", file=sys.stderr)
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
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception as dedup_err:
        print(f"Dedup check failed (non-fatal): {dedup_err}", file=sys.stderr)

    # Step 3 (BL164): register the ADAPTER THROUGH the MLflow bridge as a
    # lora_adapter — NO inference spec (a hot-loaded adapter has no standalone
    # serving target; this is the native fix for the old "adapter inherits the
    # base's serving config" bug, R4). The adapter's genuine lineage/identity
    # (base family, parent arn, technique, dataset) travels as version tags; the
    # base serving-config fields (deploymentConfig/baseImage/instanceType/…) are
    # DROPPED from the adapter version.
    model_data_url = (args.model_data_url or "").rstrip("/")
    base_id = getattr(args, "base_id", "") or ""

    # Adapter lineage/identity tags ONLY (no base serving config). artifact_kind
    # is added by register_via_bridge.
    adapter_tags = {
        "isAdapter": "true",
        "parentModelVersionArn": args.parent_version_arn or "",
        "tuneTechnique": args.tune_technique or "",
        "datasetS3Uri": args.dataset_s3_uri or "",
        "mlcc.base_model_id": base_id,
    }
    _dsv = getattr(args, "dataset_version", "") or ""
    if _dsv:
        adapter_tags["datasetVersion"] = _dsv
    # eval metrics stay as tags (model-card parity comes later via the native path)
    adapter_tags = _inject_eval_metrics(adapter_tags, args)
    adapter_tags = _truncate_metadata(adapter_tags)

    print(f"Registering adapter via the MLflow bridge ({project_name})...", file=sys.stderr)
    try:
        import mlcc_mlflow
        if not mlcc_mlflow._mlflow_configured():
            _error_exit(
                "MLflow is not configured; adapter registration now flows through "
                "the MLflow bridge (BL164). Configure a tracking App via the profile "
                "(mlflowAppArn) and retry.",
                code="MLFLOW_NOT_CONFIGURED",
            )
        # Verb-intent default: register-adapter ⇒ lora_adapter (OQ-2); --artifact-kind overrides.
        _kind = getattr(args, "artifact_kind", None) or "lora_adapter"
        result = mlcc_mlflow.register_via_bridge(
            registered_model_name=project_name,
            model_data_url=model_data_url,
            artifact_kind=_kind,
            tags=adapter_tags,
            # Only a full model carries a standalone serving spec; an adapter never does.
            inference_spec=(_build_inference_spec(args) if _kind == "full_model" else None),
            base_model_name=base_id or None,
        )
        model_package_arn = result.get("sagemaker_model_package_arn") or ""
        version = result.get("version")
        print(f"Registered adapter (MLflow v{version}) → {model_package_arn}", file=sys.stderr)

        # BL123 (Req 6.2): draw the base→derivative lineage edge in SageMaker ML
        # Lineage (parent_version_arn = base package; model_package_arn = this
        # adapter). Non-fatal + idempotent.
        if model_package_arn:
            try:
                mlcc_mlflow.add_derived_from_edge(
                    base_source_uri=parent_version_arn,
                    derivative_source_uri=model_package_arn,
                    region=region,
                )
            except (NameError, AttributeError):
                raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
            except Exception as lineage_err:  # noqa: BLE001 — lineage is best-effort
                print(f"\u26a0\ufe0f  base\u2192derivative lineage edge skipped (non-fatal: "
                      f"{lineage_err}).", file=sys.stderr)

        _output({
            "mpg_arn": mpg_arn,
            "model_package_arn": model_package_arn,
            "version": version,
            "parent_version_arn": parent_version_arn,
        })
    except mlcc_mlflow.MlflowUnavailableError as e:
        _error_exit(f"MLflow unavailable for adapter registration: {e}", code="MLFLOW_UNAVAILABLE")
    except Exception as e:
        _error_exit(f"Failed to register adapter via the bridge: {e}", code="ADAPTER_REGISTER_FAILED")
