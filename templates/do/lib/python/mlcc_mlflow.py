# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import hashlib
import os

# ---------------------------------------------------------------------------
# mlcc.* key vocabulary — the single source of truth for family metadata keys
# ---------------------------------------------------------------------------

# Tag keys (family membership + provenance)
TAG_FAMILY = "mlcc.family"                # base model id — the family key
TAG_ARTIFACT_TYPE = "mlcc.artifact_type"  # e.g. "base", "adapter", "draft", "dataset"
TAG_MANAGED_BY = "mlcc.managed_by"        # constant marker: "mlcc"
TAG_ARTIFACT_KIND = "mlcc.artifact_kind"  # BL164/ADR-013: "lora_adapter" | "full_model"
TAG_DELETED = "mlcc.deleted"              # "true" on runs whose dataset was deregistered
                                          # (do/register dataset --delete); the read/list
                                          # paths skip these. Soft-delete marker because
                                          # mlflow.delete_run is unreliable on SageMaker
                                          # MLflow Serverless.

# Param keys (lineage detail)
PARAM_BASE_MODEL_ID = "mlcc.base_model_id"
PARAM_BASE_MODEL_RUN_ID = "mlcc.base_model_run_id"
PARAM_ADAPTER_TYPE = "mlcc.adapter_type"
PARAM_TRAINING_TECHNIQUE = "mlcc.training_technique"
PARAM_DRAFT_ALGORITHM = "mlcc.draft_algorithm"

MANAGED_BY_VALUE = "mlcc"

# Maps family_params kwarg names to their canonical mlcc.* param key. Kwargs not
# in this map are ignored (forward-compatible — see family_params docstring).
_OPTIONAL_PARAM_KEYS = {
    "base_model_run_id": PARAM_BASE_MODEL_RUN_ID,
    "adapter_type": PARAM_ADAPTER_TYPE,
    "training_technique": PARAM_TRAINING_TECHNIQUE,
    "draft_algorithm": PARAM_DRAFT_ALGORITHM,
}


class MlflowUnavailableError(RuntimeError):
    """Raised when MLflow cannot be used to complete an operation.

    Covers "mlflow is not installed" (surfaced instead of a bare ImportError)
    and "no active run" for log_dataset. Underlying MLflow errors from a
    configured-but-unreachable server are wrapped in this type where doing so
    improves the message; callers render it via their own error formatting.
    """


# ---------------------------------------------------------------------------
# Pure helpers (no MLflow dependency)
# ---------------------------------------------------------------------------

def sanitize_name(hf_id):
    """Convert an HF id / arbitrary name into a registry-safe name.

    Replaces every ``/`` with ``--`` and removes spaces. The result never
    contains a ``/`` or a space, and re-sanitizing an already-safe name is a
    no-op (idempotent).

    CRITICAL: forward slashes in registered model names break MLflow loading
    (issue #8801), hence the ``--`` delimiter.

    Related: register (guard), log_dataset (name guard)
    """
    if not isinstance(hf_id, str):
        raise TypeError(f"sanitize_name expects a str, got {type(hf_id).__name__}")
    # Replace slashes with the double-dash delimiter, then remove spaces.
    # Order is irrelevant to the safety guarantee: "--" contains no "/" and no
    # space, so neither a "/" nor a space can survive regardless.
    return hf_id.replace("/", "--").replace(" ", "")


def _project_experiment_name(project_name=None):
    """The per-project MLflow experiment name = the sanitized project name.

    Resolution order (single derived source for every write and read path):
    the explicit ``project_name`` argument first (the register/model helpers
    pass ``args.project_name`` directly, since they run as subprocesses that may
    not inherit the shell's ``PROJECT_NAME``), then the ``PROJECT_NAME`` env var
    (exported by ``do/config`` / ``profile.sh``). Falls back to ``"Default"``
    only when neither yields a name, preserving today's behavior for a nameless
    context. ``sanitize_name`` makes the result a valid MLflow experiment name.

    BL163: replaces the hardcoded ``set_experiment("Default")`` so runs from
    different projects no longer collide in one experiment.
    """
    name = (project_name or "").strip()
    if not name:
        name = os.environ.get("PROJECT_NAME", "").strip()
    return sanitize_name(name) if name else "Default"


def _resolve_experiment_ids(client=None, project_name=None, all_projects=False):
    """Return the MLflow experiment id(s) to READ, honoring the BL163 scope.

    Default (OQ-3): the active project's experiment id PLUS ``"0"`` (OQ-4
    read-both — legacy pre-BL163 runs live in the Default experiment "0", so they
    stay visible without a data migration). ``all_projects=True`` returns every
    experiment id in the store (the ``--all`` opt-in).

    Resolves the active project's experiment by NAME via the client; when that
    experiment does not exist yet (nothing project-specific written), returns
    just ``["0"]`` — never errors on a missing experiment. Returns ``["0"]`` as
    the safe fallback whenever resolution is not possible (no client, mlflow
    absent, lookup failure), which matches the pre-BL163 default.
    """
    client = _resolve_search_client(client)
    if client is None:
        return ["0"]

    if all_projects:
        try:
            experiments = client.search_experiments()
        except Exception:  # noqa: BLE001 — fall back to read-both default
            return ["0"]
        ids = [getattr(e, "experiment_id", None) for e in experiments]
        ids = [i for i in ids if i is not None]
        return ids or ["0"]

    exp_name = _project_experiment_name(project_name)
    if exp_name == "Default":
        # Nameless context — the legacy single-experiment behavior.
        return ["0"]
    try:
        experiment = client.get_experiment_by_name(exp_name)
    except Exception:  # noqa: BLE001 — treat as not-yet-created
        experiment = None
    if experiment is None:
        return ["0"]
    exp_id = getattr(experiment, "experiment_id", None)
    if exp_id is None or exp_id == "0":
        return ["0"]
    return [exp_id, "0"]


def _resolve_search_client(client=None):
    """Return a usable MLflow client for experiment resolution, or None.

    Unlike ``_get_client`` this never raises when mlflow is absent — experiment
    resolution degrades to the ``["0"]`` fallback instead of failing the read.
    """
    if client is not None:
        return client
    try:
        from mlflow import MlflowClient
    except ImportError:
        return None
    try:
        return MlflowClient()
    except Exception:  # noqa: BLE001 — unconfigured/unreachable; degrade to fallback
        return None


def ensure_project_experiment(project_name=None, client=None):
    """Create-or-resolve the per-project MLflow experiment; return its id or None.

    BL166: ensured at every lifecycle entry point (register/tune/train submit +
    deploy) so a job's first logged step has a project home (not a trainer-default
    bucket). Idempotent — whichever verb runs first creates it, the rest resolve
    it, so entry-point order never matters. Non-fatal: when MLflow is unconfigured
    the verb proceeds without it (returns None); NEVER creates a local mlruns dir.

    Reuses the BL163 single source for the name (``_project_experiment_name``) and
    the ref resolution (``_mlflow_configured`` applies the tracking env). Returns
    None for a nameless context (the shared "Default"/"0" case needs no create).
    """
    if not _mlflow_configured():
        return None
    name = _project_experiment_name(project_name)
    if name == "Default":
        return None
    try:
        import mlflow
        exp = mlflow.get_experiment_by_name(name)
        if exp is not None:
            return exp.experiment_id
        return mlflow.create_experiment(name)
    except Exception:  # noqa: BLE001 — a race or transient; set_experiment create-on-use still covers writes
        return None


def mlflow_env_for_job(project_name=None, config_path=None):
    """Return the MLflow env vars to inject into a TRAINING JOB's environment.

    BL166: a custom training container's MLflow autolog reads the tracking ref +
    experiment from its env. This returns the ``{env_var: value}`` dict to merge
    into the job Environment — the SAME ARN/URI split ``_mlflow_configured`` uses
    (ARN → ``MLFLOW_TRACKING_SERVER_ARN``, HTTPS URL → ``MLFLOW_TRACKING_URI``) so
    train/tune/register resolve the ref identically — plus
    ``MLFLOW_EXPERIMENT_NAME = _project_experiment_name(...)``.

    Returns an EMPTY dict when MLflow is unconfigured (the job submits exactly as
    today, no MLflow env, no error — never a local mlruns dir).
    """
    env = {}
    ref = None
    # Prefer an explicit env ref (standard MLflow), else resolve from the profile.
    if os.environ.get("MLFLOW_TRACKING_SERVER_ARN"):
        env["MLFLOW_TRACKING_SERVER_ARN"] = os.environ["MLFLOW_TRACKING_SERVER_ARN"]
    elif os.environ.get("MLFLOW_TRACKING_URI"):
        env["MLFLOW_TRACKING_URI"] = os.environ["MLFLOW_TRACKING_URI"]
    else:
        ref = _config_tracking_uri(config_path)
        if ref:
            if ref.startswith("arn:"):
                env["MLFLOW_TRACKING_SERVER_ARN"] = ref
            else:
                env["MLFLOW_TRACKING_URI"] = ref
    if not env:
        return {}
    exp_name = _project_experiment_name(project_name)
    if exp_name and exp_name != "Default":
        env["MLFLOW_EXPERIMENT_NAME"] = exp_name
    return env


# ---------------------------------------------------------------------------
# BL167: MLflow as the durable source of record — user-owned-reconcile hybrid.
# No state machine: local record first (always), MLflow second (warn+succeed on
# a TRANSIENT unreachable App, fatal on a REAL error), converge on an idempotent
# do/register re-run, detect drift with a cheap smoke-test read.
# ---------------------------------------------------------------------------

class MlflowTransientError(RuntimeError):
    """An MLflow write failed because the App was (probably) UNREACHABLE — a
    transient condition the user reconciles by re-running. Distinct from a REAL
    error (bad input, permissions) which is fatal."""


def _is_transient_mlflow_error(exc):
    """Conservatively classify an MLflow exception as transient (unreachable) vs
    real (bad request / permissions). AMBIGUOUS → FALSE (treat as real/fatal), so
    a genuine failure is never hidden behind a reconcile warning (design risk).

    Transient signals: connection/timeout/DNS/5xx/throttling. Real signals:
    4xx-class validation, access denied, not found, invalid parameter.
    """
    msg = str(exc).lower()
    real_markers = (
        "validation", "invalid", "accessdenied", "access denied", "not authorized",
        "notfound", "does not exist", "already exists", "badrequest", "bad request",
        "resourcenotfound",
    )
    if any(m in msg for m in real_markers):
        return False
    transient_markers = (
        "timeout", "timed out", "connection", "could not connect", "unreachable",
        "temporarily", "throttl", "serviceunavailable", "service unavailable",
        "503", "502", "504", "name resolution", "endpointconnectionerror",
    )
    return any(m in msg for m in transient_markers)


def hybrid_record(*, local_write, mlflow_write, name, kind):
    """Record a resource with MLflow as the durable record + the local store as a
    reconcilable copy (BL167 OQ-1). NO state machine.

    1. ``local_write()`` — ALWAYS first; fatal on failure (the local record must
       persist so a re-run can reconcile).
    2. ``mlflow_write()`` — attempted next. A REAL error (bad input/permissions)
       propagates (fatal). A TRANSIENT unreachable WARNS ("saved locally, not yet
       in MLflow — re-run `do/register <kind>` to reconcile") and returns
       ``degraded=True`` without failing registration.

    Idempotent: a plain re-run of ``do/register`` re-invokes this and converges
    MLflow to the local record — reconciliation IS the re-run, not a queue/daemon.

    Returns ``{"local": <local_write result>, "mlflow_degraded": bool}``.
    """
    local_result = local_write()  # fatal on failure — do not catch
    degraded = False
    try:
        mlflow_write()
    except MlflowUnavailableError:
        degraded = True
        _warn_sync(name, kind, "MLflow is not installed/available")
    except Exception as exc:  # noqa: BLE001 — classify transient vs real
        if _is_transient_mlflow_error(exc):
            degraded = True
            _warn_sync(name, kind, str(exc))
        else:
            raise  # REAL error — fatal, never hidden behind a reconcile warning
    return {"local": local_result, "mlflow_degraded": degraded}


def _warn_sync(name, kind, reason):
    import sys
    print(f"\u26a0\ufe0f  '{name}' saved locally but not yet recorded in MLflow "
          f"({reason}). Re-run `do/register {kind}` when the MLflow App is reachable "
          f"to reconcile.", file=sys.stderr)


def log_first_class_dataset(source, name, meta=None, context="training"):
    """Log a dataset as a FIRST-CLASS mlflow.data Dataset input (BL167 R1), so it
    is browsable in the Experiment Datasets catalog — not only the buried bare
    MetaDataset. Must be called inside an active MLflow run.

    Uses ``mlflow.data.from_pandas`` with the S3 ``source`` + the carried
    provenance as a tiny descriptor frame (no bytes downloaded — a 1-row schema
    marker), then ``log_input``. Complements (does not replace) ``log_dataset``'s
    run-input lineage edge. Best-effort/raises like any MLflow call so the caller's
    hybrid/guard decides fatality.
    """
    import mlflow
    safe_name = sanitize_name(name)
    provenance = _meta_provenance(meta)
    try:
        import pandas as pd
        # A minimal descriptor frame — carries the provenance, downloads nothing.
        frame = pd.DataFrame([{k: v for k, v in provenance.items()}] or [{}])
        ds = mlflow.data.from_pandas(frame, source=source, name=safe_name)
    except Exception:  # noqa: BLE001 — pandas/from_pandas unavailable → no first-class Dataset
        # Do NOT log the meta dataset here: every caller follows up with
        # log_dataset (the run-input lineage edge), so a fallback here logged the
        # same input twice whenever pandas was absent (BL234).
        return None
    mlflow.log_input(ds, context=context)
    return (safe_name, _derive_digest(source, safe_name, meta))


def register_prompt_native(name, template, aliases=None):
    """Register a reward PROMPT to the MLflow GenAI Prompt Registry (BL167 R2).

    Uses the ``mlflow.genai`` namespace (the bare ``mlflow.register_prompt`` is
    deprecated). Native versioning: re-registering the same name creates a new
    version. Optional aliases are assigned. Returns the registered prompt handle.
    Raises like any MLflow call so the caller's hybrid decides fatality.
    """
    import mlflow.genai as _genai
    safe_name = sanitize_name(name)
    prompt = _genai.register_prompt(name=safe_name, template=template)
    for alias in (aliases or []):
        try:
            _genai.set_prompt_alias(name=safe_name, alias=alias, version=prompt.version)
        except Exception:  # noqa: BLE001 — alias assignment best-effort
            pass
    return prompt


def mlflow_check_present(name, kind, client=None, project_name=None):
    """Cheap smoke-test read: is ``name`` present in MLflow for this kind?

    Used by the read paths (--list / resolve) to DETECT drift (local record exists
    but MLflow does not) and WARN. Best-effort: any failure returns None (unknown),
    so drift detection never breaks a read. ``kind`` ∈ {"dataset", "prompt"}.
    Reuses BL163 experiment resolution for datasets.
    """
    try:
        if kind == "prompt":
            import mlflow.genai as _genai
            safe = sanitize_name(name)
            return any(getattr(p, "name", None) == safe for p in _genai.search_prompts())
        if kind == "dataset":
            safe = sanitize_name(name)
            return resolve_dataset_by_name(name, client=client, project_name=project_name) is not None
    except Exception:  # noqa: BLE001 — detection is best-effort; unknown on failure
        return None
    return None


def family_tags(base_id, artifact_type):
    """Return the standard family-membership tag dict for an artifact.

    Always includes mlcc.family, mlcc.artifact_type, and mlcc.managed_by.
    ``mlcc.family`` equals ``base_id``; ``mlcc.managed_by`` is the constant
    marker ``"mlcc"`` used to distinguish MLCC-created artifacts in a shared
    MLflow instance.

    Related: register, search_family
    """
    return {
        TAG_FAMILY: base_id,
        TAG_ARTIFACT_TYPE: artifact_type,
        TAG_MANAGED_BY: MANAGED_BY_VALUE,
    }


def family_params(base_id, **kwargs):
    """Return the standard family-lineage param dict.

    Always includes mlcc.base_model_id. Optional lineage params are included
    only when the corresponding kwarg is supplied (non-None):
      base_model_run_id  -> mlcc.base_model_run_id
      adapter_type       -> mlcc.adapter_type
      training_technique -> mlcc.training_technique
      draft_algorithm    -> mlcc.draft_algorithm

    Kwargs that are absent or None add no key, so absent lineage stays
    distinguishable from empty lineage. Unrecognized kwargs are ignored
    (forward-compatible: downstream specs can pass through extra hints without a
    coordinated change here).

    Related: register
    """
    params = {PARAM_BASE_MODEL_ID: base_id}
    for kwarg, key in _OPTIONAL_PARAM_KEYS.items():
        value = kwargs.get(kwarg)
        if value is not None:
            params[key] = value
    return params


# ---------------------------------------------------------------------------
# MLflow-touching helpers (lazy import, injectable client)
# ---------------------------------------------------------------------------

def _get_client(client=None):
    """Return the given client, or resolve a default ``MlflowClient()``.

    Lazily imports mlflow so importing this module never requires MLflow. Raises
    MlflowUnavailableError (not a bare ImportError) when MLflow is absent.
    """
    if client is not None:
        return client
    try:
        from mlflow import MlflowClient
    except ImportError as exc:
        raise MlflowUnavailableError(
            "mlflow is not installed; install it to use search_family/register/"
            "log_dataset (pip install mlflow)"
        ) from exc
    return MlflowClient()


def _tag_value(model, key):
    """Read a tag value off a LoggedModel, tolerating dict- or attr-shaped tags."""
    tags = getattr(model, "tags", None)
    if tags is None and isinstance(model, dict):
        tags = model.get("tags")
    if isinstance(tags, dict):
        return tags.get(key)
    # Fall back to attribute access for exotic tag containers.
    return getattr(tags, key, None) if tags is not None else None


def search_family(base_id, client=None, experiment_ids=None):
    """Return all MLflow LoggedModels whose mlcc.family tag equals base_id.

    Queries the MLflow tracking store for LoggedModels filtered on the
    ``mlcc.family`` tag and exhausts pagination so the result is the full set.
    Returns a list (possibly empty). Every returned record has
    ``mlcc.family == base_id``; no record outside the family is returned.

    ``client`` is injectable for testing. ``experiment_ids`` scopes the search
    when the underlying client requires it; when omitted the module-level
    ``mlflow.search_logged_models`` is used, which searches the active
    experiment context.

    Related: family_tags, register
    """
    # Filter on the mlcc.family tag. MLflow's filter dialect backticks tag keys
    # that contain dots.
    filter_string = f"tags.`{TAG_FAMILY}` = '{base_id}'"

    results = []
    if client is not None:
        # Injected client: use its logged-model search API and exhaust pages.
        page_token = None
        while True:
            page = client.search_logged_models(
                experiment_ids=experiment_ids or [],
                filter_string=filter_string,
                page_token=page_token,
            )
            results.extend(list(page))
            page_token = getattr(page, "token", None)
            if not page_token:
                break
    else:
        try:
            import mlflow
        except ImportError as exc:
            raise MlflowUnavailableError(
                "mlflow is not installed; install it to use search_family "
                "(pip install mlflow)"
            ) from exc
        kwargs = {"filter_string": filter_string, "output_format": "list"}
        if experiment_ids is not None:
            kwargs["experiment_ids"] = experiment_ids
        results = list(mlflow.search_logged_models(**kwargs))

    # Defensive: guarantee the in-family invariant even if the store's filter is
    # looser than expected. Only keep records whose mlcc.family tag matches.
    return [m for m in results if _tag_value(m, TAG_FAMILY) == base_id]


def register(model_uri, name, tags=None, params=None, aliases=None, client=None):
    """Register a model in MLflow, guarding the name through sanitize_name.

    The registered name is always ``sanitize_name(name)``, so a caller can pass
    a raw HF id and the registry name is guaranteed slash/space free. ``tags``
    and ``params`` are attached to the registered model version; each alias in
    ``aliases`` is assigned to the created version.

    Returns the created model-version handle (an MLflow ``ModelVersion``), which
    callers use to locate the registration afterward.

    Related: sanitize_name, family_tags, family_params
    """
    safe_name = sanitize_name(name)
    tags = tags or {}
    params = params or {}
    aliases = aliases or []

    client = _get_client(client)

    # Ensure the registered model exists (create_registered_model is not
    # idempotent — swallow "already exists").
    try:
        client.create_registered_model(safe_name)
    except Exception:  # noqa: BLE001 — model may already exist; proceed to create version
        pass

    version = client.create_model_version(
        name=safe_name,
        source=model_uri,
        tags=tags or None,
    )

    # Attach lineage params as version tags (params live on runs, not versions;
    # the mlcc.* lineage detail travels as version-scoped tags here).
    for key, value in params.items():
        client.set_model_version_tag(safe_name, version.version, key, value)

    # Assign any aliases to the newly created version.
    for alias in aliases:
        client.set_registered_model_alias(safe_name, alias, version.version)

    return version


# Tag the bridge stamps on a registered model version once SageMaker has
# auto-created the corresponding Model Package (see register_via_bridge).
SAGEMAKER_MODEL_PACKAGE_ARN_TAG = "sagemaker.model_package_arn"


def register_via_bridge(*, registered_model_name, model_data_url, artifact_kind,
                        experiment_name=None, tags=None, params=None, aliases=None,
                        inference_spec=None, base_model_name=None,
                        model_type=None, client=None):
    """Register an S3-artifact model THROUGH MLflow so the SageMaker native bridge
    (AutoModelRegistrationEnabled) auto-creates the Model Package Group + version.

    This is the ONE registration seam for BL164 (ADR-013), uniform across base
    models, full fine-tunes, and LoRA adapters — all of which are S3 ARTIFACTS,
    not live MLflow model objects. LIVE-VERIFIED (BL164 probes): the mechanism is
      1. ``mlflow.create_external_model`` — register the S3 artifact as a logged
         model WITHOUT uploading a model object (``model_data_url`` is the S3
         weights/adapter prefix the register paths already have);
      2. (full_model only) ``sagemaker_mlflow.log_inference_specification`` on the
         logged-model id so the bridge's Model Package is directly deployable;
      3. ``mlflow.register_model(models:/<logged-model-id>, name)`` — the bridge
         fires and SageMaker auto-creates the Model Package Group+version.

    Kind-aware (OQ-1):
      - ``full_model`` (full fine-tune, base, hand ``do/register model``): logs an
        inference spec → deployable Model Package.
      - ``lora_adapter``: NO inference spec (hot-loaded, no standalone serving
        target); a native base->adapter lineage edge is tagged when
        ``base_model_name`` is given.

    ``artifact_kind`` is recorded as a version tag so the additive-deploy verbs
    gate by it (ADR-013). ``tags``/``params`` become version tags; ``aliases`` are
    assigned to the created version. ``experiment_name`` scopes the logged model
    to the per-project experiment (BL163); defaults to ``_project_experiment_name()``.

    Returns ``{registered_model_name, version, sagemaker_model_package_arn,
    logged_model_id}``. The ARN is read back from the version's
    ``sagemaker.model_package_arn`` tag — LIVE-VERIFIED present synchronously once
    ``register_model`` returns, so a single read-back suffices (no poll). The
    bridge group is ``<registered-model-name>-<hash>`` (6-hex App-id suffix, NO
    ``mlflow-`` prefix — do not assume one).

    Raises MlflowUnavailableError when mlflow is not installed. Real registration
    errors (bad input, permissions, a missing S3 artifact the bridge validates)
    propagate; the hybrid warn-and-reconcile posture for a TRANSIENT unreachable
    App is BL167's concern, not this helper's.
    """
    safe_name = sanitize_name(registered_model_name)
    tags = dict(tags or {})
    params = params or {}
    aliases = aliases or []
    tags[TAG_ARTIFACT_KIND] = artifact_kind
    if base_model_name:
        tags[TAG_FAMILY] = sanitize_name(base_model_name)

    try:
        import mlflow
    except ImportError as exc:
        raise MlflowUnavailableError(
            "mlflow is not installed; install it to register models "
            "(pip install mlflow)"
        ) from exc

    # Scope the logged model to the per-project experiment (BL163).
    mlflow.set_experiment(experiment_name or _project_experiment_name())

    # 1. Register the S3 artifact as an external logged model (no object upload).
    with mlflow.start_run():
        logged = mlflow.create_external_model(
            name=safe_name,
            model_type=model_type or ("lora-adapter" if artifact_kind == "lora_adapter"
                                      else "full-model"),
        )
    logged_model_id = logged.model_id

    # 2. Full models carry an inference spec → deployable Model Package. The spec
    #    MUST reference the real model_data_url; the bridge validates the S3 keys
    #    exist at CreateModelPackage time (probe-confirmed). Adapters log none.
    if artifact_kind == "full_model" and inference_spec is not None:
        try:
            import sagemaker_mlflow
            sagemaker_mlflow.log_inference_specification(
                logged_model_id, inference_specification=inference_spec,
            )
        except Exception as exc:  # noqa: BLE001 — spec is additive to the package
            import sys
            print(f"\u26a0\ufe0f  inference spec not attached ({exc}); the model "
                  "registers without a deployable spec.", file=sys.stderr)

    # 3. The bridge fires: mlflow.register_model → SageMaker auto-creates the MPG.
    mv = mlflow.register_model(f"models:/{logged_model_id}", safe_name, tags=tags or None)

    _client = _get_client(client)
    for key, value in params.items():
        _client.set_model_version_tag(safe_name, mv.version, key, value)
    for alias in aliases:
        _client.set_registered_model_alias(safe_name, alias, mv.version)

    # Read back the SageMaker Model Package ARN the bridge stamps (synchronous).
    sm_arn = None
    try:
        refreshed = _client.get_model_version(safe_name, mv.version)
        version_tags = getattr(refreshed, "tags", {}) or {}
        sm_arn = version_tags.get(SAGEMAKER_MODEL_PACKAGE_ARN_TAG)
    except Exception:  # noqa: BLE001 — ARN read-back is best-effort
        pass

    return {
        "registered_model_name": safe_name,
        "logged_model_id": logged_model_id,
        "version": mv.version,
        "sagemaker_model_package_arn": sm_arn,
    }


def _make_uri_source(uri, meta=None):
    """Build a minimal DatasetSource instance wrapping ``uri`` (+ provenance).

    Subclasses the real MLflow ``DatasetSource`` (which provides ``to_json`` and
    is required by ``mlflow.log_input``) lazily, so importing this module never
    requires mlflow. The source records where a dataset came from (``uri``) plus
    the carried provenance (``meta`` minus the digest — row_count, format,
    technique, source_type, s3_uri) so ``--list`` and name resolution can
    reconstruct a full entry from MLflow alone (see ``_source_to_list_fields``).
    """
    from mlflow.data.dataset_source import DatasetSource

    provenance = _meta_provenance(meta)

    class _UriSource(DatasetSource):
        def __init__(self, uri, meta=None):
            self._uri = "" if uri is None else str(uri)
            self._meta = dict(meta) if isinstance(meta, dict) else {}

        @staticmethod
        def _get_source_type():
            return "mlcc_uri"

        def load(self):  # pragma: no cover - foundation default does not load bytes
            return self._uri

        @staticmethod
        def _can_resolve(raw_source):
            return isinstance(raw_source, str)

        @classmethod
        def _resolve(cls, raw_source):
            return cls(raw_source)

        def to_dict(self):
            d = {"uri": self._uri}
            if self._meta:
                d["meta"] = self._meta
            return d

        @classmethod
        def from_dict(cls, source_dict):
            return cls(source_dict.get("uri"), source_dict.get("meta"))

    return _UriSource(uri, provenance)


def _derive_digest(source, name, meta):
    """Return a digest for the dataset.

    Uses ``meta['digest']`` verbatim when present; otherwise derives a
    deterministic digest from the source + name so the same logical dataset
    yields the same digest. The digest identifies dataset *content* independent
    of its name.
    """
    if isinstance(meta, dict) and meta.get("digest"):
        return str(meta["digest"])
    basis = f"{source}\x00{name}".encode("utf-8")
    return hashlib.sha256(basis).hexdigest()[:32]


def log_dataset(source, name, context, meta=None, client=None):
    """Log a dataset as an MLflow run input and return a locating handle.

    Builds a MetaDataset (name, digest, source), applies ``sanitize_name`` to
    the recorded name, and records it against the active run as an input with
    the given ``context`` (e.g. ``"training"``, ``"eval"``). Idempotent by
    ``(sanitized name, digest)``: logging the same pair again does not create a
    duplicate input.

    Returns the ``(sanitized name, digest)`` pair — an identifier sufficient
    for ``--list`` and name resolution to locate the logged dataset later
    (Req 6.5). The active run id is discoverable via the standard MLflow API
    and ``resolve_dataset_by_name`` re-finds the dataset by its sanitized name.

    Contract owned by BL110 (v18-w2-03). Parameters (Req 6.1):
      source  — the dataset S3 URI; becomes the MetaDataset ``source``.
      name    — the dataset name as registered (raw; may contain ``/``/spaces).
      context — the MLflow input context string (for example ``"training"``).
      meta    — dict of extra metadata; ``meta['digest']`` (when present) is
                used verbatim as the digest, and remaining keys (row_count,
                format, technique, source_type, s3_uri) travel on the dataset
                source so ``--list`` can reconstruct a full entry without the
                sidecar.

    Related: sanitize_name, resolve_dataset_by_name, list_dataset_inputs
    """
    safe_name = sanitize_name(name)
    digest = _derive_digest(source, safe_name, meta)

    try:
        import mlflow
        from mlflow.data.meta_dataset import MetaDataset
    except ImportError as exc:
        raise MlflowUnavailableError(
            "mlflow is not installed; install it to use log_dataset "
            "(pip install mlflow)"
        ) from exc

    # An active run is required to log an input.
    active_run = mlflow.active_run()
    if active_run is None:
        raise MlflowUnavailableError(
            "log_dataset requires an active MLflow run; start one with "
            "mlflow.start_run() before logging a dataset input"
        )

    # Idempotence guard by (sanitized name, digest): skip if this run already
    # has a matching input.
    if _run_has_dataset_input(client, active_run, safe_name, digest):
        return (safe_name, digest)

    dataset = MetaDataset(
        source=_make_uri_source(source, meta=meta),
        name=safe_name,
        digest=digest,
    )
    mlflow.log_input(dataset, context=context)
    return (safe_name, digest)


def _meta_provenance(meta):
    """Return the carried provenance subset of ``meta`` (digest excluded).

    The extra metadata (row_count, format, technique, source_type, s3_uri) is
    carried on the dataset source so ``--list`` and name resolution can rebuild
    the full list/resolve entry from MLflow alone, without the S3 sidecar. The
    digest is a first-class MetaDataset field, so it is not duplicated here.
    Returns an empty dict when there is nothing to carry.
    """
    if not isinstance(meta, dict):
        return {}
    return {k: v for k, v in meta.items() if k != "digest" and v is not None}


def _run_has_dataset_input(client, active_run, safe_name, digest):
    """Return True if the active run already has an input dataset matching
    ``(safe_name, digest)``.

    Best-effort duplicate detection for log_dataset idempotence. On any lookup
    failure it returns False (treat as "no duplicate") so logging still proceeds
    — BL110 finalizes the precise strategy.
    """
    try:
        import mlflow
        client = client or _get_client(client)
        run = client.get_run(active_run.info.run_id)
        inputs = getattr(run, "inputs", None)
        dataset_inputs = getattr(inputs, "dataset_inputs", None) if inputs else None
        if not dataset_inputs:
            return False
        for di in dataset_inputs:
            ds = getattr(di, "dataset", None)
            ds_name = getattr(ds, "name", None)
            ds_digest = getattr(ds, "digest", None)
            if ds_name == safe_name and ds_digest == digest:
                return True
    except Exception:  # noqa: BLE001 — best-effort; fall through to "not present"
        return False
    return False


# ---------------------------------------------------------------------------
# BL110: configured/not branch + dataset read paths (list, resolve-by-name)
# ---------------------------------------------------------------------------

def _mlflow_configured(config_path=None):
    """Return True when MLflow tracking is configured for the project.

    A single, side-effect-free predicate (no network I/O) that decides the
    branch for all three dataset flows (register, ``--list``, resolve). MLflow
    is "configured" when a tracking URI is resolvable:

    - ``MLFLOW_TRACKING_URI`` (or ``MLFLOW_TRACKING_SERVER_ARN``) is set in the
      environment — the standard MLflow mechanism, checked first; or
    - the bootstrap/project config records a tracking URI for a profile
      (``mlflowTrackingUri`` / ``mlflowTrackingServerArn``).

    Keeping the check to config/env inspection (never a server ping) makes the
    branch decision deterministic and independent of transient reachability;
    reachability failures are handled separately by the callers.

    SIDE EFFECT (required for the local client to route): resolving a URI also
    calls ``mlflow.set_tracking_uri(uri)``. Setting only ``MLFLOW_TRACKING_URI`` /
    ``MLFLOW_TRACKING_SERVER_ARN`` in ``os.environ`` is NOT enough — if mlflow has
    already computed its default tracking URI (the local ``mlflow.db`` sqlite
    store), a later env mutation does not change the active client, so the
    sagemaker-mlflow App route never engages and ``register_via_bridge`` would
    write to a LOCAL registry and the bridge would never fire (BL164 live bug:
    "MPG registration returned incomplete data"). ``set_tracking_uri`` is what
    actually points the client at the ``arn:aws:sagemaker:...:mlflow-app/...``
    App (sagemaker-mlflow registers that scheme), so we call it here.
    """
    uri = (
        os.environ.get("MLFLOW_TRACKING_SERVER_ARN")
        or os.environ.get("MLFLOW_TRACKING_URI")
        or _config_tracking_uri(config_path)
    )
    if not uri:
        return False
    # Mirror the resolved value into the environment so remote tooling / the
    # sagemaker-mlflow plugin still sees it. ARNs (mlflow-app / mlflow-tracking-
    # server) go to MLFLOW_TRACKING_SERVER_ARN; HTTPS URLs go to MLFLOW_TRACKING_URI.
    if uri.startswith("arn:"):
        os.environ["MLFLOW_TRACKING_SERVER_ARN"] = uri
    else:
        os.environ["MLFLOW_TRACKING_URI"] = uri
    # Point the ACTIVE client at the resolved URI. Without this the client keeps
    # its default local sqlite store regardless of the env vars above.
    try:
        import mlflow
        if mlflow.get_tracking_uri() != uri:
            mlflow.set_tracking_uri(uri)
    except ImportError:
        # mlflow absent: the env vars are still set; callers that need mlflow
        # raise MlflowUnavailableError on their own import.
        pass
    return True


def _config_tracking_uri(config_path=None):
    """Read an MLflow tracking URI from the bootstrap/project config, or None.

    Inspects ``~/.ml-container-creator/config.json`` (or ``config_path``) for a
    tracking URI recorded on the active profile, then any profile. Never raises:
    a missing/corrupt config yields ``None`` (i.e. "not configured").
    """
    import json

    if config_path is None:
        config_path = os.path.join(
            os.path.expanduser("~"), ".ml-container-creator", "config.json"
        )
    try:
        with open(config_path) as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError, OSError):
        return None

    keys = ("mlflowTrackingUri", "mlflowTrackingServerArn", "mlflowAppArn")

    def _from(profile):
        if isinstance(profile, dict):
            for k in keys:
                v = profile.get(k)
                if v:
                    return v
        return None

    # Top-level (project config) first.
    top = _from(config)
    if top:
        return top

    profiles = config.get("profiles", {}) if isinstance(config, dict) else {}
    if not isinstance(profiles, dict):
        return None

    active = config.get("activeProfile")
    if active and active in profiles:
        v = _from(profiles[active])
        if v:
            return v
    for profile in profiles.values():
        v = _from(profile)
        if v:
            return v
    return None


def _source_uri_and_meta(dataset):
    """Extract (uri, meta) from a logged dataset's source dict.

    Reads the source produced by ``_make_uri_source`` — ``{"uri": ...,
    "meta": {...}}``. Tolerates a dataset exposing either a ``source`` object
    with ``to_dict``/``to_json`` or a plain source dict/string. Returns
    ``(uri, meta_dict)`` with best-effort fallbacks.
    """
    import json

    source = getattr(dataset, "source", None)
    src_dict = None
    if source is None:
        src_dict = None
    elif isinstance(source, dict):
        src_dict = source
    elif isinstance(source, str):
        try:
            src_dict = json.loads(source)
        except (json.JSONDecodeError, ValueError):
            return source, {}
    else:
        to_dict = getattr(source, "to_dict", None)
        if callable(to_dict):
            try:
                src_dict = to_dict()
            except Exception:  # noqa: BLE001
                src_dict = None
        if src_dict is None:
            to_json = getattr(source, "to_json", None)
            if callable(to_json):
                try:
                    src_dict = json.loads(to_json())
                except Exception:  # noqa: BLE001
                    src_dict = None

    if not isinstance(src_dict, dict):
        return "", {}
    uri = src_dict.get("uri", "")
    meta = src_dict.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {}
    return uri, meta


def list_dataset_inputs(client=None, experiment_ids=None, project_name=None,
                        all_projects=False):
    """Return the deduplicated dataset run inputs recorded by ``log_dataset``.

    Reads dataset inputs across MLflow runs and returns one record per
    ``(name, digest)`` pair (most recent wins), each a dict:
    ``{"name", "digest", "s3_uri", "meta": {...}}``. This is the read source
    for ``--list`` when MLflow is configured. ``client`` is injectable for
    testing.

    BL163 scope: when ``experiment_ids`` is not given explicitly, it is resolved
    via ``_resolve_experiment_ids`` — the active project's experiment plus "0"
    (read-both) by default, or every experiment when ``all_projects=True``. An
    explicit ``experiment_ids`` still wins (used by tests).

    Raises MlflowUnavailableError when MLflow is not installed. Underlying store
    errors propagate so a configured-but-unreachable store surfaces to the
    caller rather than silently returning empty.
    """
    if experiment_ids is None:
        experiment_ids = _resolve_experiment_ids(
            client=client, project_name=project_name, all_projects=all_projects,
        )
    runs = _search_runs(client=client, experiment_ids=experiment_ids)
    # On the module (real mlflow) path, search_runs returns lightweight summaries
    # that may not include full inputs, so re-fetch each run to populate
    # dataset_inputs. An injected client (test / client path) already returns
    # full runs, so skip the re-fetch entirely — and avoid assuming a dict shape.
    if client is None:
        try:
            import mlflow as _mlflow
            full_runs = []
            for run in runs:
                run_id = getattr(getattr(run, 'info', None), 'run_id', None)
                if run_id:
                    try:
                        full = _mlflow.get_run(run_id)
                        # Skip runs tagged deleted by do/register dataset --delete
                        tags = getattr(full, 'data', None)
                        tag_dict = getattr(tags, 'tags', {}) if tags else {}
                        if tag_dict.get(TAG_DELETED) == "true":
                            continue
                        full_runs.append(full)
                    except (NameError, AttributeError):
                        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
                    except Exception:
                        full_runs.append(run)  # fallback to summary on error
                else:
                    full_runs.append(run)
            # Sort newest-first by start_time so the most recent registration wins
            full_runs.sort(
                key=lambda r: getattr(getattr(r, 'info', None), 'start_time', 0) or 0,
                reverse=True,
            )
            runs = full_runs
        except ImportError:
            pass  # mlflow absent — fall through with the summary runs


    by_key = {}
    for run in runs:
        for di in _run_dataset_inputs(run):
            ds = getattr(di, "dataset", None)
            if ds is None:
                continue
            name = getattr(ds, "name", None)
            digest = getattr(ds, "digest", None)
            if name is None:
                continue
            uri, meta = _source_uri_and_meta(ds)
            # Only keep the first (newest) entry per (name, digest) pair.
            # search_runs returns newest-first; do NOT overwrite or the oldest run wins.
            if (name, digest) not in by_key:
                by_key[(name, digest)] = {
                "name": name,
                "digest": digest,
                "s3_uri": uri or meta.get("s3_uri", ""),
                "meta": meta,
                }
    return list(by_key.values())


def resolve_dataset_by_name(name, client=None, experiment_ids=None,
                            project_name=None, all_projects=False):
    """Resolve a dataset by name from MLflow run inputs, or None.

    Matches on ``sanitize_name(name)`` (the recorded name) and returns the most
    recent matching input as ``{"name", "digest", "s3_uri", "meta"}``, or None
    when no dataset with that name is recorded. Used by ``do/tune --dataset X``
    name resolution when MLflow is configured.

    Re-registering a dataset whose CONTENT changed (e.g. the BL179
    `.json` → `.from_array.jsonl` fix) produces a NEW digest, so MLflow holds
    MULTIPLE ``(name, digest)`` inputs for the same name — the old one does not
    get overwritten. ``list_dataset_inputs`` returns them newest-first, so we
    must keep the FIRST match (the newest registration); taking the last would
    resolve to the STALE URI (observed: do/tune resolving to a dead `.json` that
    the trainer rejects with "S3 training dataset path does not exist").

    BL163 scope: resolves the read experiment id(s) the same way
    ``list_dataset_inputs`` does (active project + "0" by default, all when
    ``all_projects=True``) unless ``experiment_ids`` is given explicitly.

    Raises MlflowUnavailableError when MLflow is not installed.
    """
    safe_name = sanitize_name(name)
    for entry in list_dataset_inputs(
        client=client, experiment_ids=experiment_ids,
        project_name=project_name, all_projects=all_projects,
    ):
        if entry.get("name") == safe_name:
            return entry  # newest-first order → first match is the most recent
    return None


def _search_runs(client=None, experiment_ids=None):
    """Return an iterable of MLflow runs, via an injected client or mlflow.

    Injected client: uses ``search_runs`` and exhausts pagination. Module path:
    uses ``mlflow.search_runs(... output_format="list")``. Raises
    MlflowUnavailableError if mlflow is absent (module path).
    """
    if client is not None:
        results = []
        search = getattr(client, "search_runs", None)
        if search is None:
            return results
        page_token = None
        while True:
            page = search(
                experiment_ids=experiment_ids or [],
                page_token=page_token,
            )
            results.extend(list(page))
            page_token = getattr(page, "token", None)
            if not page_token:
                break
        return results
    try:
        import mlflow
    except ImportError as exc:
        raise MlflowUnavailableError(
            "mlflow is not installed; install it to list/resolve datasets "
            "(pip install mlflow)"
        ) from exc
    kwargs = {"output_format": "list"}
    if experiment_ids is not None:
        kwargs["experiment_ids"] = experiment_ids
    else:
        # Default to experiment 0 ("Default") when no explicit IDs are given.
        # Without this, SageMaker MLflow Serverless may search only the active
        # experiment context rather than the Default experiment where
        # register_dataset writes its runs.
        kwargs["experiment_ids"] = ["0"]
    return list(mlflow.search_runs(**kwargs))


def _run_dataset_inputs(run):
    """Return a run's dataset inputs list, tolerating attr/dict shapes."""
    inputs = getattr(run, "inputs", None)
    if inputs is None and isinstance(run, dict):
        inputs = run.get("inputs")
    dataset_inputs = getattr(inputs, "dataset_inputs", None) if inputs is not None else None
    if dataset_inputs is None and isinstance(inputs, dict):
        dataset_inputs = inputs.get("dataset_inputs")
    return dataset_inputs or []

def tag_dataset_runs_deleted(name, client=None, project_name=None, all_projects=False):
    """Tag all MLflow runs for a given dataset name as deleted.

    Used by do/register dataset --delete so that list_dataset_inputs()
    excludes them. mlflow.delete_run() does not reliably work on
    SageMaker MLflow Serverless — tagging is the portable alternative.

    BL163 scope: resolves the experiment id(s) to scan the same way the read
    paths do (active project + "0" read-both by default, all when
    ``all_projects=True``), so a scoped delete finds the active project's runs
    AND any legacy runs in experiment "0".
    """
    try:
        import mlflow as _mlflow
        _client = client or _mlflow.tracking.MlflowClient()
        experiment_ids = _resolve_experiment_ids(
            client=_client, project_name=project_name, all_projects=all_projects,
        )
        # Keep the module-path search (mlflow.search_runs) as before — only the
        # experiment scope changed from the hardcoded ["0"] to the resolved set.
        runs = _search_runs(client=client, experiment_ids=experiment_ids)
        for run in runs:
            run_id = run.info.run_id if hasattr(run, 'info') else run.get('run_id', '')
            full = _mlflow.get_run(run_id)
            for di in _run_dataset_inputs(full):
                ds = getattr(di, 'dataset', None)
                if ds and getattr(ds, 'name', '') == name:
                    _client.set_tag(run_id, TAG_DELETED, "true")
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:  # noqa: BLE001 — best-effort
        pass



# ---------------------------------------------------------------------------
# BL123: native SageMaker ML Lineage edges (dataset→model, base→derivative)
#
# SageMaker auto-creates lineage ARTIFACTS for registered models, datasets, and
# evaluators (spike Probe 5); only the EDGES between them must be added. These
# helpers add those edges, driven by the v1.8 ``mlcc.family`` metadata, so MLCC
# turns its existing family tags into native lineage rather than maintaining a
# parallel graph. Both are NON-FATAL and IDEMPOTENT (Req 6.3): a lineage failure
# (IAM, transient, already-exists) never breaks the tune/register the user asked
# for.
# ---------------------------------------------------------------------------


def log_training_dataset_lineage(*, dataset_s3_uri, dataset_name, context="training",
                                 meta=None):
    """Record a dataset→model lineage edge by logging the dataset as a run input.

    BL123 Req 6.1. SageMaker's Studio Lineage graph lights up the dataset→model
    edge from an ``mlflow.log_input`` on the run that produced the model. This
    wraps ``log_dataset`` so the tune/train/register flow can record that edge
    with the training dataset — covering the ``do/train`` GRPO path too, since it
    is driven only by the dataset S3 URI (no technique/engine-specific logic).

    NON-FATAL + IDEMPOTENT: no active run, MLflow unconfigured, or any logging
    error returns False with a warning rather than raising; a repeat call with
    the same (name, digest) is de-duplicated by ``log_dataset``.

    Returns True when the input was logged (or already present), else False.
    """
    if not dataset_s3_uri:
        return False
    try:
        import mlflow
    except ImportError:
        return False
    try:
        if mlflow.active_run() is None:
            # No run to attach the input to — nothing to do (the managed do/tune
            # path owns its own run on the SageMaker side; this is for flows where
            # MLCC controls the run).
            return False
        log_dataset(
            source=dataset_s3_uri,
            name=dataset_name or dataset_s3_uri,
            context=context,
            meta=meta or {"s3_uri": dataset_s3_uri},
        )
        return True
    except Exception as exc:  # noqa: BLE001 — lineage is best-effort
        import sys
        print(f"\u26a0\ufe0f  Dataset\u2192model lineage edge skipped ({exc}); "
              "the model and dataset are registered regardless.", file=sys.stderr)
        return False


def _resolve_lineage_artifact_arn(sm_client, source_uri):
    """Return the SageMaker lineage Artifact ARN whose Source.SourceUri matches.

    SageMaker auto-creates an Artifact for each registered model/dataset; its
    SourceUri is the model-package ARN (or dataset/hub-content ARN). We list
    artifacts by source URI and return the first ARN, or None when none exists
    yet (the caller treats that as a non-fatal skip).
    """
    try:
        resp = sm_client.list_artifacts(SourceUri=source_uri, MaxResults=1)
    except Exception:  # noqa: BLE001 — treat any lookup failure as "not found"
        return None
    summaries = resp.get("ArtifactSummaries") or []
    if not summaries:
        return None
    return summaries[0].get("ArtifactArn")


def add_derived_from_edge(*, base_source_uri, derivative_source_uri, region=None,
                          sm_client=None):
    """Add a base→derivative ``DerivedFrom`` lineage edge (Req 6.2).

    Resolves the two auto-created lineage Artifacts (by their Source URIs — e.g.
    the base model-package ARN and the derivative adapter model-package ARN) and
    calls ``AddAssociation(SourceArn=base, DestinationArn=derivative,
    AssociationType='DerivedFrom')``. The user never calls AddAssociation; MLCC
    draws the edge from the already-resolved ``mlcc.family`` /
    ``mlcc.base_model_run_id`` linkage at register time.

    NON-FATAL + IDEMPOTENT (Req 6.3): a missing artifact, an already-existing
    association, an IAM/transient error — all return False with a warning rather
    than raising. Returns True when the edge was added (or already present).
    """
    import sys
    if not base_source_uri or not derivative_source_uri:
        return False
    try:
        import boto3
        client = sm_client or boto3.client("sagemaker", region_name=region)
    except Exception as exc:  # noqa: BLE001
        print(f"\u26a0\ufe0f  base\u2192derivative lineage edge skipped (no SageMaker client: {exc}).",
              file=sys.stderr)
        return False

    base_arn = _resolve_lineage_artifact_arn(client, base_source_uri)
    deriv_arn = _resolve_lineage_artifact_arn(client, derivative_source_uri)
    if not base_arn or not deriv_arn:
        print("\u2139\ufe0f  base\u2192derivative lineage edge skipped: the lineage artifacts "
              "are not available yet (they are auto-created asynchronously). The "
              "family linkage is still recorded in the model metadata.",
              file=sys.stderr)
        return False

    try:
        client.add_association(
            SourceArn=base_arn,
            DestinationArn=deriv_arn,
            AssociationType="DerivedFrom",
        )
        print(f"Recorded base\u2192derivative lineage edge (DerivedFrom): "
              f"{base_source_uri} \u2192 {derivative_source_uri}", file=sys.stderr)
        return True
    except Exception as exc:  # noqa: BLE001 — already-exists / IAM / transient
        msg = str(exc).lower()
        if "already" in msg or "exist" in msg:
            # Idempotent: the edge is already there — treat as success.
            return True
        print(f"\u26a0\ufe0f  base\u2192derivative lineage edge skipped ({exc}); the family "
              "linkage is still recorded in the model metadata.", file=sys.stderr)
        return False
