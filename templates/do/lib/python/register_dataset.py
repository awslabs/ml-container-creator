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
    # Hub registration not supported for fine-tuning datasets — local only.
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


def _get_latest_version(name):
    """Get the latest version info for a dataset from the local registry."""
    entries = _load_registry(register_common._DATASETS_REGISTRY)

    for entry in entries:
        if entry.get("name") == name:
            versions = entry.get("versions")
            if versions and len(versions) > 0:
                latest = versions[-1]
                return {
                    "version": latest.get("version", "1.0.0"),
                    "hash": latest.get("hash"),
                    "ordinal": len(versions),
                }
            else:
                return {
                    "version": "1.0.0",
                    "hash": None,
                    "ordinal": 1,
                }

    return None


def _increment_version(version_str):
    """Increment a semver-like version string (minor bump)."""
    parts = version_str.split(".")
    if len(parts) != 3:
        return "1.1.0"
    major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
    return f"{major}.{minor + 1}.{patch}"


def _write_dataset_version_to_local_registry(*, name, s3_uri, data_format, technique,
                                              row_count, column_schema, project_name,
                                              arn, version, content_hash):
    """Write a versioned dataset entry to the local JSON registry."""
    entries = _load_registry(register_common._DATASETS_REGISTRY)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    version_entry = {
        "version": version,
        "s3_uri": s3_uri,
        "hash": content_hash,
        "technique": technique,
        "rows": row_count,
        "registered_at": now,
    }

    found = False
    for i, existing in enumerate(entries):
        if existing.get("name") == name:
            found = True
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

            existing["versions"].append(version_entry)
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

    _save_registry(register_common._DATASETS_REGISTRY, entries)


def cmd_register_dataset(args):
    """Register a dataset with content-aware versioning."""
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

    if column_schema:
        try:
            json.loads(column_schema)
        except json.JSONDecodeError:
            _error_exit("--column-schema must be valid JSON", code="INVALID_ARGUMENT")

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

    # Step 2: Get latest version
    latest = _get_latest_version(name)

    # Step 3: Version decision
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

    # Step 4: Register via AI Registry (preferred)
    description = f"[hash:{content_hash}]" if content_hash else ""
    dataset_arn = None

    hub_name = _get_hub_name_from_profile(region)

    if hub_name:
        print(f"Targeting hub '{hub_name}' for dataset registration...", file=sys.stderr)
        hub_arn = _register_to_hub(hub_name, name, s3_uri, technique, description, region)
        if hub_arn is not None:
            dataset_arn = hub_arn
        else:
            print("Continuing with local JSON registry only.", file=sys.stderr)
    else:
        _warn(
            "No AI Registry hub configured in profile. "
            "Using local JSON registry only.\n"
            "    To enable hub registration, run `ml-container-creator bootstrap`."
        )

    # Step 5: Write to local registry with versioning
    _write_dataset_version_to_local_registry(
        name=name, s3_uri=s3_uri, data_format=data_format,
        technique=technique, row_count=row_count,
        column_schema=column_schema, project_name=project_name,
        arn=dataset_arn, version=new_version, content_hash=content_hash,
    )

    print(f"Registered dataset '{name}' v{ordinal} ({new_version}) \u2192 {s3_uri}", file=sys.stderr)
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
