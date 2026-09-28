from __future__ import annotations
"""MLflow model-family foundation: shared tag/param/search/register conventions.

Purpose: Centralize how MLCC groups related models (a base model and its
         adapters, draft models, and other derived artifacts) into a "family"
         in MLflow, and how it records dataset lineage. Names derived from
         Hugging Face ids (e.g. ``meta-llama/Llama-3.1-8B-Instruct``) contain
         ``/`` and spaces that are invalid or ambiguous in registry names, so
         this module owns a sanitizer plus the ``mlcc.*`` tag/param vocabulary.
Callers: do/tune flow (tune_submit.py), do/register flow (register_model.py,
         BL056), and dataset flows (BL110).
Related: dataset_store.py (injectable-client + typed-error pattern),
         common.py (callers own their own output/error formatting).

CRITICAL naming constraint: forward slashes in registered model names BREAK
MLflow loading (MLflow issue #8801). ``sanitize_name`` therefore replaces every
``/`` with ``--`` (double dash) and removes spaces, and is applied as a guard
inside ``register`` and ``log_dataset`` so a raw HF id can never reach the
registry as-is.

Design notes:
- The pure helpers (``sanitize_name``, ``family_tags``, ``family_params``) have
  no external dependency and can be imported/called even where MLflow is not
  installed. Importing this module is side-effect free.
- The MLflow-touching helpers (``search_family``, ``register``, ``log_dataset``)
  lazily ``import mlflow`` inside the function body, mirroring how
  ``register_model.py`` defers ``import boto3`` / ``sagemaker``.
- The MLflow client is injectable via an optional ``client=`` parameter
  (mirroring the injectable S3 client in ``dataset_store.py``), so tests pass a
  stub/mock and no real MLflow server is contacted.
- This module raises typed exceptions and returns values; it never prints JSON
  or calls ``sys.exit`` — formatting/exit codes are the caller's responsibility.
"""

import hashlib
import os

# ---------------------------------------------------------------------------
# mlcc.* key vocabulary — the single source of truth for family metadata keys
# ---------------------------------------------------------------------------

# Tag keys (family membership + provenance)
TAG_FAMILY = "mlcc.family"                # base model id — the family key
TAG_ARTIFACT_TYPE = "mlcc.artifact_type"  # e.g. "base", "adapter", "draft", "dataset"
TAG_MANAGED_BY = "mlcc.managed_by"        # constant marker: "mlcc"

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
    """
    if os.environ.get("MLFLOW_TRACKING_URI") or os.environ.get("MLFLOW_TRACKING_SERVER_ARN"):
        return True
    return bool(_config_tracking_uri(config_path))


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

    keys = ("mlflowTrackingUri", "mlflowTrackingServerArn")

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


def list_dataset_inputs(client=None, experiment_ids=None):
    """Return the deduplicated dataset run inputs recorded by ``log_dataset``.

    Reads dataset inputs across MLflow runs and returns one record per
    ``(name, digest)`` pair (most recent wins), each a dict:
    ``{"name", "digest", "s3_uri", "meta": {...}}``. This is the read source
    for ``--list`` when MLflow is configured. ``client`` is injectable for
    testing; ``experiment_ids`` scopes the search when required.

    Raises MlflowUnavailableError when MLflow is not installed. Underlying store
    errors propagate so a configured-but-unreachable store surfaces to the
    caller rather than silently returning empty.
    """
    runs = _search_runs(client=client, experiment_ids=experiment_ids)

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
            by_key[(name, digest)] = {
                "name": name,
                "digest": digest,
                "s3_uri": uri or meta.get("s3_uri", ""),
                "meta": meta,
            }
    return list(by_key.values())


def resolve_dataset_by_name(name, client=None, experiment_ids=None):
    """Resolve a dataset by name from MLflow run inputs, or None.

    Matches on ``sanitize_name(name)`` (the recorded name) and returns the most
    recent matching input as ``{"name", "digest", "s3_uri", "meta"}``, or None
    when no dataset with that name is recorded. Used by ``do/tune --dataset X``
    name resolution when MLflow is configured.

    Raises MlflowUnavailableError when MLflow is not installed.
    """
    safe_name = sanitize_name(name)
    match = None
    for entry in list_dataset_inputs(client=client, experiment_ids=experiment_ids):
        if entry.get("name") == safe_name:
            match = entry  # later runs overwrite → most-recent wins
    return match


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
