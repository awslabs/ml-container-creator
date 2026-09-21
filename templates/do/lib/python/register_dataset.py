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
import re
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


# ── Hub helpers ───────────────────────────────────────────────────────────────


def _parse_technique_from_description(description):
    """Parse [technique:sft] tag from a dataset description string."""
    match = re.search(r'\[technique:([^\]]+)\]', description or '')
    return match.group(1) if match else 'unknown'


def _list_hub_datasets(hub_name, region):
    """List datasets from AI Registry Hub."""
    try:
        import boto3
        sm = boto3.client('sagemaker', region_name=region)
        results = []
        kwargs = {'HubName': hub_name, 'HubContentType': 'Dataset'}
        while True:
            resp = sm.list_hub_contents(**kwargs)
            for item in resp.get('HubContentSummaries', []):
                technique = _parse_technique_from_description(
                    item.get('HubContentDescription', '')
                )
                results.append({
                    'name': item['HubContentName'],
                    'version': item.get('HubContentVersion', ''),
                    'technique': technique,
                    'created_at': str(item.get('CreationTime', '')),
                    'origin': 'remote',
                })
            next_token = resp.get('NextToken')
            if not next_token:
                break
            kwargs['NextToken'] = next_token
        return results
    except Exception as e:
        print(f'\u26a0\ufe0f  Could not list hub datasets: {e}', file=sys.stderr)
        return []


def _get_hub_name_from_profile(region=None):
    """Read aiRegistryHubName from the bootstrap profile config."""
    try:
        with open(register_common._CONFIG_PATH) as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return None

    profiles = config.get("profiles", {})
    if not profiles:
        return None

    # Priority 1: active profile (set by `mcc bootstrap use <profile>`)
    active_profile = config.get("activeProfile")
    if active_profile and active_profile in profiles:
        profile_data = profiles[active_profile]
        if isinstance(profile_data, dict):
            hub_name = profile_data.get("aiRegistryHubName")
            if hub_name:
                return hub_name

    # Priority 2: region match — profile key contains the region string
    if region:
        for profile_key, profile_data in profiles.items():
            if not isinstance(profile_data, dict):
                continue
            if region in profile_key:
                hub_name = profile_data.get("aiRegistryHubName")
                if hub_name:
                    return hub_name

    # Priority 3: first profile with a hub name (least specific fallback)
    for profile_data in profiles.values():
        if not isinstance(profile_data, dict):
            continue
        hub_name = profile_data.get("aiRegistryHubName")
        if hub_name:
            return hub_name

    return None


def _register_to_hub(hub_name, name, s3_uri, technique, description, region):
    """Register dataset to a specific hub by name.

    NOTE (2026-07-15): The SageMaker Hub 'DataSet' HubContentType (schema 2.0.0)
    is designed for benchmarking/workload datasets (fields: DatasetS3Bucket,
    DatasetS3Prefix, DatasetContextS3Uri, DatasetRoleArn) — NOT for SFT/DPO/RLVR
    training datasets. Fine-tuning datasets do not have a Hub registration path
    via import_hub_content. This function is a no-op stub pending investigation
    of the correct API (possibly sagemaker.ai_registry.dataset.DataSet.create()
    or a custom JsonDoc hub content type).

    Local JSON registry (~/.ml-container-creator/datasets.json) is the canonical
    store for fine-tuning datasets.
    """
    try:
        import boto3
        sm_client = boto3.client("sagemaker", region_name=region)
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
        if ("resourcenotfound" in error_msg or "resource not found" in error_msg
                or "does not exist" in error_msg or "hub" in error_msg and "not found" in error_msg):
            _warn(
                f"Hub '{hub_name}' not found. "
                "Run `ml-container-creator bootstrap` to provision the AI Registry hub."
            )
            print("    Falling back to local JSON registry.", file=sys.stderr)
            return None
        if "already exists" in error_msg or "resourceinuse" in error_msg:
            print(f"Dataset '{name}' already exists in hub '{hub_name}' (idempotent)", file=sys.stderr)
            try:
                describe_resp = sm_client.describe_hub_content(
                    HubName=hub_name, HubContentName=name, HubContentType="Dataset",
                )
                return describe_resp.get("HubContentArn", "")
            except Exception:
                return ""
        _warn(
            f"Failed to register dataset to hub '{hub_name}': {e}\n"
            "    If this persists, run `ml-container-creator bootstrap` to verify hub provisioning.\n"
            "    Falling back to local JSON registry."
        )
        return None


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

    # Step 4: Register via AI Registry Hub (preserved, non-authoritative)
    description = f"[hash:{content_hash}]" if content_hash else ""
    dataset_arn = None

    hub_name = _get_hub_name_from_profile(region)

    if hub_name:
        print(f"Targeting hub '{hub_name}' for dataset registration...", file=sys.stderr)
        hub_arn = _register_to_hub(hub_name, name, s3_uri, technique, description, region)
        if hub_arn is not None:
            dataset_arn = hub_arn

    # Step 5: Write the S3 sidecar (metadata source of truth)
    doc = _build_sidecar_doc(
        existing=existing, name=name, s3_uri=s3_uri, data_format=data_format,
        technique=technique, row_count=row_count, column_schema=column_schema,
        project_name=project_name, arn=dataset_arn, version=new_version,
        ordinal=ordinal, content_hash=content_hash, custom_metadata=custom_metadata,
    )

    try:
        dataset_store.write_sidecar(s3_client, core_bucket, name, doc)
    except dataset_store.TransportError as e:
        _error_exit(f"Failed to write dataset sidecar: {e}", code="SIDECAR_WRITE_FAILED")

    sidecar_uri = register_common._sidecar_uri(core_bucket, name)
    print(f"Registered dataset '{name}' v{ordinal} ({new_version}) \u2192 {s3_uri}", file=sys.stderr)
    print(f"Sidecar: {sidecar_uri}", file=sys.stderr)
    _output({
        "name": name,
        "s3_uri": s3_uri,
        "format": data_format,
        "technique": technique,
        "version": new_version,
        "hash": content_hash,
        "arn": dataset_arn,
        "sidecar_uri": sidecar_uri,
        "registered": True,
        "skipped": False,
    })


def cmd_register_evaluator(args):
    """Register an evaluator into the local registry."""
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

    entries = _load_registry(register_common._EVALUATORS_REGISTRY)

    entry = {
        "name": name,
        "type": eval_type,
        "arn_or_uri": arn_or_uri,
        "technique": technique,
        "description": description,
        "project_name": project_name,
        "registered_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    updated = False
    for i, existing in enumerate(entries):
        if existing.get("name") == name:
            entries[i] = entry
            updated = True
            break
    if not updated:
        entries.append(entry)

    _save_registry(register_common._EVALUATORS_REGISTRY, entries)

    print(f"Registered evaluator '{name}' ({eval_type}) \u2192 {arn_or_uri}", file=sys.stderr)
    _output({
        "name": name,
        "type": eval_type,
        "arn_or_uri": arn_or_uri,
        "technique": technique,
        "registered": True,
    })


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
