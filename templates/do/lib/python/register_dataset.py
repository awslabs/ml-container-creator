from __future__ import annotations
"""Register dataset: dataset and evaluator registration with content-aware versioning.

Purpose: cmd_register_dataset, cmd_register_evaluator subcommands
Inputs: --name, --s3-uri, --format, --technique, --region, etc.
Outputs: JSON with name, s3_uri, version, hash, registered status
Caller: .register_helper.py dispatcher
Related: register_common.py (registry I/O), common.py (output utilities)
"""

import datetime
import hashlib
import json
import os
import struct
import sys

from common import _output, _error_exit, _warn
import register_common
from register_common import (
    _load_registry, _save_registry, _ensure_registry_dir,
    _parse_s3_uri, _is_s3_prefix,
)

# Expose module-level names for direct access, but functions below
# use register_common.X to pick up test patches on that module.
_REGISTRY_DIR = register_common._REGISTRY_DIR
_CONFIG_PATH = register_common._CONFIG_PATH
_DATASETS_REGISTRY = register_common._DATASETS_REGISTRY
_EVALUATORS_REGISTRY = register_common._EVALUATORS_REGISTRY


# ── Native AI Registry registration (BL123) ───────────────────────────────────
#
# The branded `mlcc-registry` hub path (create_hub_content + _get_hub_name_from_
# profile + _list_hub_datasets) was RETIRED in BL123: the BL122 spike proved the
# high-level ai_registry SDK computes its own hub (`AiRegistry-<region>-<account>`)
# and cannot be pointed at a named hub, and that Studio visibility comes from the
# `domain_id` tag, not hub choice. Native dataset registration now lives in
# ai_registry_native.register_dataset_native(); the S3 sidecar remains the durable
# write record.


def _register_dataset_native(*, name, s3_uri, technique, region, description, custom_metadata):
    """Additively register the dataset in the native AI Registry (non-fatal).

    Called AFTER the durable S3 sidecar write. Returns a (native_arn, native_info)
    tuple; native_arn is None when the step is skipped or fails. Any failure is
    swallowed into a warning — the sidecar the user asked for already persisted.
    When the native create records a technique the enum does not name (rlaif/mtrl
    → the RLVR member), the intended technique is already in the sidecar
    (`technique` field), so no extra write is needed here.
    """
    import ai_registry_native

    role = ai_registry_native.resolve_training_role()
    domain_id = ai_registry_native.resolve_domain_id()
    try:
        info = ai_registry_native.register_dataset_native(
            name=name, s3_uri=s3_uri, technique=technique, region=region,
            description=description, role=role, domain_id=domain_id,
        )
    except ai_registry_native.NativeRegistrySkipped as skip:
        print(f"\u2139\ufe0f  Native AI Registry registration skipped: {skip}", file=sys.stderr)
        return None, None
    except Exception as e:  # noqa: BLE001 — native registration is best-effort
        _warn(
            f"Native AI Registry registration failed ({e}); the S3 sidecar remains "
            "the durable record. The dataset is registered and usable; it just "
            "won't appear in Studio Assets until this succeeds."
        )
        return None, None

    native_arn = info.get("arn")
    if not info.get("domain_tagged"):
        print(
            "\u2139\ufe0f  Registered natively but no Studio domain id is configured "
            "\u2014 the dataset won't be tagged into Studio Assets. Provision the "
            "sagemaker-domain bootstrap module to enable Studio visibility.",
            file=sys.stderr,
        )
    else:
        print(
            f"Registered dataset '{name}' natively in the AI Registry "
            f"(member={info.get('member')}, native version={info.get('version')}) "
            "\u2014 visible in Studio Assets.",
            file=sys.stderr,
        )
    return native_arn, info


# ── Content hash helpers ──────────────────────────────────────────────────────


def _compute_content_hash(s3_uri, region):
    """Compute a content hash for a dataset at an S3 URI."""
    import boto3

    s3 = boto3.client("s3", region_name=region)
    bucket, key = _parse_s3_uri(s3_uri)

    if _is_s3_prefix(key):
        paginator = s3.get_paginator("list_objects_v2")
        etags = []
        prefix = key if key.endswith("/") else key + "/"
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                etag = obj["ETag"].strip('"')
                etags.append(f"{obj['Key']}:{etag}")
        if not etags:
            head = s3.head_object(Bucket=bucket, Key=key)
            return head["ETag"].strip('"')[:16]
        etags.sort()
        return hashlib.sha256("\n".join(etags).encode()).hexdigest()[:16]
    else:
        head = s3.head_object(Bucket=bucket, Key=key)
        return head["ETag"].strip('"')[:16]


def _count_newlines_streaming(s3_client, bucket, key):
    """Count newlines in an S3 object by streaming 1MB chunks."""
    count = 0
    start = 0
    chunk = 1024 * 1024
    while True:
        end = start + chunk - 1
        try:
            resp = s3_client.get_object(Bucket=bucket, Key=key, Range=f'bytes={start}-{end}')
            data = resp['Body'].read()
            count += data.count(b'\n')
            if len(data) < chunk:
                break
            start += chunk
        except Exception:
            break
    return count


def _count_rows_parquet(s3_client, bucket, key):
    """Extract row count from Parquet footer (no full file read needed)."""
    try:
        resp = s3_client.get_object(Bucket=bucket, Key=key, Range='bytes=-8')
        tail = resp['Body'].read()
        if len(tail) < 8 or tail[-4:] != b'PAR1':
            return None
        footer_len = struct.unpack('<I', tail[:4])[0]
        resp2 = s3_client.get_object(Bucket=bucket, Key=key, Range=f'bytes=-{footer_len + 8}')
        footer_data = resp2['Body'].read()
        footer_bytes = footer_data[:footer_len]
        idx = footer_bytes.find(b'\x0a\x00\x01')
        if idx == -1 or idx + 11 > len(footer_bytes):
            return None
        return struct.unpack('>q', footer_bytes[idx + 3:idx + 11])[0]
    except Exception:
        return None


def _count_rows(s3_uri, region):
    """Count rows in a dataset S3 file. Supports jsonl, csv/tsv, parquet. Non-fatal."""
    try:
        bucket, key = _parse_s3_uri(s3_uri)
        import boto3
        s3 = boto3.client('s3', region_name=region)
        ext = key.lower().rsplit('.', 1)[-1] if '.' in key else ''
        if ext in ('jsonl', 'ndjson'):
            return _count_newlines_streaming(s3, bucket, key)
        elif ext in ('csv', 'tsv'):
            return max(0, _count_newlines_streaming(s3, bucket, key) - 1)
        elif ext in ('parquet', 'parq'):
            return _count_rows_parquet(s3, bucket, key)
        return None
    except Exception as e:
        print(f'\u26a0\ufe0f  Row count failed: {e}', file=sys.stderr)
        return None


# ── Version helpers ───────────────────────────────────────────────────────────


def _get_latest_version(sidecar):
    """Get the latest version info for a dataset from its sidecar document.

    Args:
        sidecar: The parsed sidecar dict (or None if no sidecar exists yet).

    Returns:
        {"version": str, "hash": str|None, "ordinal": int} for the latest
        version, or None if there is no sidecar / no versions.
    """
    if not sidecar:
        return None

    versions = sidecar.get("versions") or []
    if not versions:
        return None

    latest = versions[-1]
    return {
        "version": latest.get("version", "1.0.0"),
        "hash": latest.get("hash"),
        "ordinal": len(versions),
    }


def _increment_version(version_str):
    """Increment a semver-like version string (minor bump)."""
    parts = version_str.split(".")
    if len(parts) != 3:
        return "1.1.0"
    major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
    return f"{major}.{minor + 1}.{patch}"


def _build_custom_metadata(args):
    """Assemble the customMetadata block from optional flags (unset omitted)."""
    custom = {}
    for field in ("attribution", "lineage", "origination", "application"):
        value = getattr(args, field, None)
        if value:
            custom[field] = value
    return custom


def _build_sidecar_doc(*, existing, name, s3_uri, data_format, technique,
                       row_count, column_schema, project_name, arn,
                       version, ordinal, content_hash, custom_metadata):
    """Build (or extend) the sidecar document for a dataset registration."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    version_entry = {
        "version": version,
        "ordinal": ordinal,
        "s3_uri": s3_uri,
        "hash": content_hash,
        "format": data_format,
        "technique": technique,
        "rowCount": row_count,
        "createdAt": now,
    }
    if arn:
        version_entry["arn"] = arn

    if existing and existing.get("versions"):
        doc = dict(existing)
        versions = list(doc.get("versions", []))
        versions.append(version_entry)
        doc["versions"] = versions
    else:
        doc = {
            "name": name,
            "versions": [version_entry],
        }

    # Top-level fields reflect the latest version.
    doc["name"] = name
    doc["contentHash"] = content_hash
    doc["technique"] = technique
    doc["format"] = data_format
    doc["s3_uri"] = s3_uri
    doc["latestVersion"] = version
    if project_name:
        doc["projectName"] = project_name
    if column_schema:
        doc["columnSchema"] = column_schema

    # Merge custom metadata: keep any previously-recorded values, override with
    # newly-provided fields.
    merged_custom = dict(existing.get("customMetadata", {})) if existing else {}
    merged_custom.update(custom_metadata)
    if merged_custom:
        doc["customMetadata"] = merged_custom

    return doc


def _resolve_core_bucket(args):
    """Resolve the MLCC Core bucket from --core-bucket or environment."""
    return (
        getattr(args, "core_bucket", None)
        or os.environ.get("CORE_BUCKET")
        or os.environ.get("MLCC_CORE_BUCKET")
    )


def _log_dataset_to_mlflow(*, s3_uri, name, content_hash, row_count, data_format,
                           technique, source_type="s3-uri"):
    """Log the dataset to MLflow as a run input (BL110), non-fatally.

    Called only when MLflow is configured, AFTER the durable sidecar write.
    Creates/reuses an MLflow run (context ``"training"``, or ``"benchmark"`` when
    ``technique == "benchmark"`` per BL120) and delegates to
    ``mlcc_mlflow.log_dataset``. Any MLflow failure (unreachable server, run
    creation error, logging error) is NON-FATAL: the sidecar is already the
    durable record, so a warning is emitted and ``None`` is returned instead of
    failing a registration whose metadata already persisted to S3.

    Returns the ``(sanitized_name, digest)`` handle on success, else ``None``.
    """
    try:
        import mlflow
        import mlcc_mlflow

        meta = {
            "digest": content_hash,
            "source_type": source_type,
            "row_count": row_count,
            "format": data_format,
            "technique": technique,
            "s3_uri": s3_uri,
        }

        # BL120/BL100: benchmark datasets (AIPerf BYOD single_turn, `text` column;
        # consumed by do/benchmark --dataset) are logged with context="benchmark";
        # training datasets use "training".
        context = "benchmark" if technique == "benchmark" else "training"

        active = mlflow.active_run()
        if active is not None:
            return mlcc_mlflow.log_dataset(
                source=s3_uri, name=name, context=context, meta=meta,
            )
        # Set experiment explicitly so datasets appear in the "Default" experiment
        # in the MLflow UI (#/experiments/0/datasets). Without this, SageMaker
        # MLflow Serverless may auto-create a new experiment per-call.
        mlflow.set_experiment("Default")
        with mlflow.start_run(run_name=f"register-dataset-{name}"):
            return mlcc_mlflow.log_dataset(
                source=s3_uri, name=name, context=context, meta=meta,
            )
    except Exception as e:  # noqa: BLE001 — MLflow logging is best-effort
        _warn(
            f"MLflow dataset logging failed ({e}); the S3 sidecar remains the "
            "durable record."
        )
        return None


def cmd_register_dataset(args):
    """Register a dataset with content-aware versioning, writing an S3 sidecar."""
    import dataset_store

    name = args.name
    s3_uri = args.s3_uri
    data_format = getattr(args, "format", "jsonl")
    technique = args.technique
    row_count = args.row_count
    column_schema = args.column_schema
    project_name = args.project_name or ""
    force = getattr(args, "force", False)

    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")
    if not s3_uri:
        _error_exit("--s3-uri is required", code="MISSING_ARGUMENT")

    # Req 11.5: a reward prompt/function is an EVALUATOR, not a dataset. Reject it
    # here with guidance to the evaluator verbs rather than registering it as a
    # dataset. (This rejects the reward ARTIFACT, not the RFT prompt corpus, which
    # is a legitimate dataset accepted under the RLVR member.)
    import ai_registry_native
    if ai_registry_native.is_reward_artifact_label(technique):
        _error_exit(
            f"'{technique}' is a reward artifact (an evaluator), not a dataset.\n"
            "    Register a reward prompt with `do/register prompt` and a reward "
            "function with `do/register evaluator`.\n"
            "    `do/register dataset` is for training corpora (sft, dpo, rlvr, "
            "rlaif, mtrl) and benchmark data.",
            code="REWARD_ARTIFACT_NOT_DATASET",
        )

    core_bucket = _resolve_core_bucket(args)
    if not core_bucket:
        _error_exit(
            "Could not resolve the MLCC Core bucket for the dataset sidecar.\n"
            "    Pass --core-bucket <bucket> or set CORE_BUCKET.\n"
            "    Run `ml-container-creator bootstrap` to provision it.",
            code="MISSING_CORE_BUCKET",
        )

    if column_schema:
        try:
            json.loads(column_schema)
        except json.JSONDecodeError:
            _error_exit("--column-schema must be valid JSON", code="INVALID_ARGUMENT")

    custom_metadata = _build_custom_metadata(args)

    s3_client = dataset_store._get_s3_client(region)

    # Step 1: Compute content hash
    content_hash = None
    if region:
        try:
            content_hash = _compute_content_hash(s3_uri, region)
            print(f"Content hash: {content_hash}", file=sys.stderr)
        except Exception as e:
            _warn(f"Could not compute content hash: {e}. Proceeding without hash.")
    else:
        _warn("No region specified \u2014 skipping content hash computation.")

    # Auto-count rows if not provided
    if row_count is None and region:
        row_count = _count_rows(s3_uri, region)
        if row_count is not None:
            print(f'Row count: {row_count}', file=sys.stderr)
        else:
            print('Row count: skipped (unsupported format or error)', file=sys.stderr)

    # Step 2: Read the existing sidecar (source of truth for versioning)
    try:
        existing = dataset_store.read_sidecar(s3_client, core_bucket, name)
    except dataset_store.TransportError as e:
        _error_exit(f"Could not read dataset sidecar: {e}", code="SIDECAR_READ_FAILED")

    latest = _get_latest_version(existing)

    # Step 3: Version decision (idempotent on unchanged content hash)
    if latest is None:
        new_version = "1.0.0"
        ordinal = 1
        print(f"First registration of '{name}' \u2192 v1 ({new_version})", file=sys.stderr)
    else:
        latest_hash = latest["hash"]
        latest_version = latest["version"]
        ordinal = latest["ordinal"]

        if not force and content_hash is not None and latest_hash is not None and content_hash == latest_hash:
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

        new_version = _increment_version(latest_version)
        ordinal = ordinal + 1
        if force:
            print(f"Force re-registration of '{name}' \u2192 v{ordinal} ({new_version})", file=sys.stderr)
        else:
            print(f"Dataset changed \u2014 new version v{ordinal} ({new_version})", file=sys.stderr)

    # Step 4: Write the S3 sidecar (metadata source of truth). The native AI
    # Registry registration (Step 6) is additive and non-fatal, so the sidecar is
    # written FIRST — a native failure must never lose the record the user asked
    # for. The native ARN, when it succeeds, is backfilled below.
    #
    # The human --description (Req 10) is kept in the sidecar's customMetadata as a
    # distinct field from the technical [hash:...] marker; the latter stays the
    # dataset-level description content MLCC relies on.
    human_description = getattr(args, "description", None)
    if human_description:
        custom_metadata = dict(custom_metadata)
        custom_metadata["description"] = human_description

    doc = _build_sidecar_doc(
        existing=existing, name=name, s3_uri=s3_uri, data_format=data_format,
        technique=technique, row_count=row_count, column_schema=column_schema,
        project_name=project_name, arn=None, version=new_version,
        ordinal=ordinal, content_hash=content_hash, custom_metadata=custom_metadata,
    )

    try:
        dataset_store.write_sidecar(s3_client, core_bucket, name, doc)
    except dataset_store.TransportError as e:
        _error_exit(f"Failed to write dataset sidecar: {e}", code="SIDECAR_WRITE_FAILED")

    # Step 5: Additively register in the native AI Registry (BL123, non-fatal).
    # The native description is the human --description when given, else the
    # technical hash marker so the Studio entry is at least identifiable.
    native_description = human_description or (f"[hash:{content_hash}]" if content_hash else None)
    dataset_arn, _native_info = _register_dataset_native(
        name=name, s3_uri=s3_uri, technique=technique, region=region,
        description=native_description, custom_metadata=custom_metadata,
    )
    # Backfill the native ARN into the sidecar's latest version entry when the
    # native create succeeded, so the durable record carries the native pointer.
    if dataset_arn:
        try:
            latest_entry = doc["versions"][-1]
            latest_entry["arn"] = dataset_arn
            doc["arn"] = dataset_arn
            dataset_store.write_sidecar(s3_client, core_bucket, name, doc)
        except Exception as e:  # noqa: BLE001 — ARN backfill is best-effort
            _warn(f"Could not backfill the native ARN into the sidecar ({e}); "
                  "the native asset is registered regardless.")

    sidecar_uri = register_common._sidecar_uri(core_bucket, name)
    print(f"Registered dataset '{name}' v{ordinal} ({new_version}) \u2192 {s3_uri}", file=sys.stderr)
    print(f"Sidecar: {sidecar_uri}", file=sys.stderr)

    # Step 6 (BL110): When MLflow is configured, additionally log the dataset as
    # a MetaDataset run input. The sidecar above is the durable record, so a
    # MLflow failure here is non-fatal (see _log_dataset_to_mlflow).
    mlflow_logged = False
    try:
        import mlcc_mlflow
        if mlcc_mlflow._mlflow_configured():
            handle = _log_dataset_to_mlflow(
                s3_uri=s3_uri, name=name, content_hash=content_hash,
                row_count=row_count, data_format=data_format, technique=technique,
            )
            mlflow_logged = handle is not None
            if mlflow_logged:
                print(f"Logged dataset to MLflow as run input: {handle[0]}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — never let MLflow break a persisted registration
        _warn(f"MLflow dataset logging skipped ({e}); the S3 sidecar remains the record.")

    _output({
        "name": name,
        "s3_uri": s3_uri,
        "format": data_format,
        "technique": technique,
        "version": new_version,
        "hash": content_hash,
        "arn": dataset_arn,
        "sidecar_uri": sidecar_uri,
        "mlflow_logged": mlflow_logged,
        "registered": True,
        "skipped": False,
    })


# NOTE (BL117): cmd_register_evaluator moved to register_evaluator.py and was
# rewritten to create a native sagemaker.ai_registry Evaluator asset (both the
# REWARD_FUNCTION and REWARD_PROMPT types) instead of appending to the local
# evaluators.json stub, which is retired as the record of truth. The reward
# ARTIFACT (a prompt/function) is an evaluator, not a dataset — register it with
# `do/register evaluator` or `do/register prompt`.


# ── discover-dataset (Req B) ──────────────────────────────────────────────────


def cmd_discover_dataset(args):
    """Browse a HuggingFace dataset before registering it.

    Surfaces the shared HF discovery logic from ``dataset_qol.py`` (splits,
    per-split files, row counts, detected schema) and prints a recommended
    ``do/register dataset`` invocation. Discovery failures are non-fatal to the
    CLI: a clear message is emitted and the process exits non-zero.
    """
    import dataset_qol
    from tune_stage_hf import _resolve_hf_token

    dataset_id = getattr(args, "hf_id", None) or getattr(args, "name", None)
    if not dataset_id:
        _error_exit("--hf-id <org/name> is required", code="MISSING_ARGUMENT")
    if "/" not in dataset_id:
        _error_exit(
            f"Invalid dataset id: {dataset_id}. Expected org/name (e.g., timdettmers/openassistant-guanaco).",
            code="INVALID_ARGUMENT",
        )

    region = getattr(args, "region", None) or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION")
    split = getattr(args, "hf_split", None)
    secret_name = getattr(args, "hf_secret_name", None)
    hf_token = _resolve_hf_token(region, secret_name)

    try:
        discovery = dataset_qol.discover_hf_dataset(dataset_id, hf_token=hf_token, split=split)
    except dataset_qol.DiscoveryError as e:
        _error_exit(str(e), code="DISCOVERY_FAILED")

    recommendation = dataset_qol.recommended_register_invocation(
        dataset_id, discovery=discovery,
        name=getattr(args, "name", None), split=split,
    )

    _output({
        "dataset_id": dataset_id,
        "splits": discovery.get("splits", []),
        "files_by_split": discovery.get("files_by_split", {}),
        "row_counts": discovery.get("row_counts", {}),
        "schema": discovery.get("schema"),
        "schema_source": discovery.get("schema_source"),
        "recommended_register": recommendation,
    })


# ── delete-dataset (Req C) ────────────────────────────────────────────────────


def _parse_version_ref(version_ref):
    """Parse an optional ``@v<N>`` / ``v<N>`` / ``<N>`` version reference.

    Returns the ordinal (int) or None. Non-numeric refs return None so the
    caller can report an invalid-version error.
    """
    if version_ref is None or version_ref == "":
        return None
    ref = str(version_ref).strip()
    if ref.startswith("@"):
        ref = ref[1:]
    if ref.lower().startswith("v"):
        ref = ref[1:]
    if ref.isdigit():
        return int(ref)
    return None


def cmd_delete_dataset(args):
    """Remove a dataset entry from the S3 sidecar registry.

    Removes the whole sidecar (no version) or a single version entry (``@v<N>``).
    NEVER deletes the dataset data bytes under ``datasets/<name>/`` — only the
    ``_dataset.json`` metadata index is affected. When removing a single version
    that is not the last remaining one, the sidecar is rewritten without that
    version; removing the final version removes the whole sidecar.

    Confirmation is the CLI's responsibility (``do/register`` handles the prompt
    / ``--force``); this handler performs the mutation and reports not-found
    with a non-zero exit.
    """
    import dataset_store

    name = getattr(args, "name", None)
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    version_ref = getattr(args, "version", None)
    ordinal = None
    if version_ref:
        ordinal = _parse_version_ref(version_ref)
        if ordinal is None:
            _error_exit(
                f"Invalid version reference: {version_ref}. Expected @v<N> (e.g., @v2).",
                code="INVALID_ARGUMENT",
            )

    region = getattr(args, "region", None) or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION")
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

    sidecar_uri = register_common._sidecar_uri(core_bucket, name)

    # ── Whole-sidecar delete ──────────────────────────────────────────────────
    if ordinal is None:
        try:
            dataset_store.delete_sidecar(s3_client, core_bucket, name)
        except dataset_store.TransportError as e:
            _error_exit(f"Failed to delete dataset sidecar: {e}", code="SIDECAR_DELETE_FAILED")
        # Tag all matching MLflow runs as deleted so list_dataset_inputs() excludes them.
        # mlflow.delete_run() is not reliable on SageMaker MLflow Serverless; tagging works.
        try:
            import mlcc_mlflow
            if mlcc_mlflow._mlflow_configured():
                mlcc_mlflow.tag_dataset_runs_deleted(name)
        except Exception:  # noqa: BLE001 — MLflow tagging is best-effort
            pass
        print(f"Deregistered dataset '{name}' (sidecar removed; data bytes untouched)", file=sys.stderr)
        _output({
            "name": name,
            "deleted": True,
            "scope": "dataset",
            "sidecar_uri": sidecar_uri,
            "data_deleted": False,
        })

    # ── Single-version delete ─────────────────────────────────────────────────
    versions = sidecar.get("versions") or []
    match = next((v for v in versions if v.get("ordinal") == ordinal), None)
    if match is None:
        _error_exit(
            f"Version v{ordinal} not found for dataset '{name}'.",
            code="VERSION_NOT_FOUND",
        )

    remaining = [v for v in versions if v.get("ordinal") != ordinal]

    if not remaining:
        # Removing the final version removes the whole sidecar.
        try:
            dataset_store.delete_sidecar(s3_client, core_bucket, name)
        except dataset_store.TransportError as e:
            _error_exit(f"Failed to delete dataset sidecar: {e}", code="SIDECAR_DELETE_FAILED")
        print(f"Removed last version v{ordinal} of '{name}' → sidecar removed (data untouched)", file=sys.stderr)
        _output({
            "name": name,
            "deleted": True,
            "scope": "version",
            "version_ordinal": ordinal,
            "removed_last_version": True,
            "sidecar_uri": sidecar_uri,
            "data_deleted": False,
        })

    # Rewrite the sidecar without the removed version; refresh latest-* fields.
    doc = dict(sidecar)
    doc["versions"] = remaining
    latest = remaining[-1]
    doc["latestVersion"] = latest.get("version", doc.get("latestVersion", ""))
    if latest.get("hash") is not None:
        doc["contentHash"] = latest.get("hash")
    if latest.get("technique"):
        doc["technique"] = latest.get("technique")
    if latest.get("format"):
        doc["format"] = latest.get("format")
    if latest.get("s3_uri"):
        doc["s3_uri"] = latest.get("s3_uri")

    try:
        dataset_store.write_sidecar(s3_client, core_bucket, name, doc)
    except dataset_store.TransportError as e:
        _error_exit(f"Failed to update dataset sidecar: {e}", code="SIDECAR_WRITE_FAILED")

    print(f"Removed version v{ordinal} of '{name}' ({len(remaining)} version(s) remain; data untouched)", file=sys.stderr)
    _output({
        "name": name,
        "deleted": True,
        "scope": "version",
        "version_ordinal": ordinal,
        "removed_last_version": False,
        "remaining_versions": len(remaining),
        "sidecar_uri": sidecar_uri,
        "data_deleted": False,
    })
