from __future__ import annotations
"""Dataset store: S3 sidecar read/write/list for the centralized dataset registry.

Purpose: The dataset metadata index lives beside the data in the MLCC Core bucket
         as a JSON sidecar at ``datasets/<name>/_dataset.json`` — replacing the
         legacy local ``~/.ml-container-creator/datasets.json`` index.
Callers: register_dataset.py (write), register_resolve.py / register_list.py (read)
Related: register_common.py (sidecar key/URI helpers), common.py (output utilities)

The boto3 S3 client is injectable so tests can stub it (moto / hand-rolled fake).
"""

import json

from register_common import _sidecar_key, SIDECAR_FILENAME, DATASETS_PREFIX


class TransportError(Exception):
    """Raised when an S3 operation fails for a reason other than 'not found'.

    Distinguishes transport/permission errors from a legitimately-missing
    sidecar (which read_sidecar reports by returning None).
    """


def _get_s3_client(region=None):
    """Return a boto3 S3 client for the given region."""
    import boto3
    return boto3.client("s3", region_name=region)


def _is_not_found(exc):
    """Return True if a boto3 exception represents a 404 / NoSuchKey."""
    # botocore ClientError carries a response dict; a hand-rolled fake may set
    # a .response attribute or use a NoSuchKey/404 marker.
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error = response.get("Error", {})
        code = str(error.get("Code", ""))
        if code in ("404", "NoSuchKey", "NoSuchBucket"):
            return True
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if status == 404:
            return True
    name = exc.__class__.__name__
    return name in ("NoSuchKey", "404", "NoSuchBucket")


def read_sidecar(s3, core_bucket, name):
    """Read the sidecar document for a dataset.

    Returns the parsed dict, or None if the sidecar does not exist (404).
    Raises TransportError for any other failure (permissions, network, etc.)
    so callers can distinguish "not found" from "could not reach S3".
    """
    key = _sidecar_key(name)
    try:
        resp = s3.get_object(Bucket=core_bucket, Key=key)
        body = resp["Body"].read()
        if isinstance(body, bytes):
            body = body.decode("utf-8")
        return json.loads(body)
    except Exception as exc:  # noqa: BLE001 — classified below
        if _is_not_found(exc):
            return None
        raise TransportError(f"Failed to read sidecar for '{name}': {exc}") from exc


def write_sidecar(s3, core_bucket, name, doc):
    """Write the sidecar document for a dataset (idempotent put_object)."""
    key = _sidecar_key(name)
    body = json.dumps(doc, indent=2, sort_keys=False)
    try:
        s3.put_object(
            Bucket=core_bucket,
            Key=key,
            Body=body.encode("utf-8"),
            ContentType="application/json",
        )
    except Exception as exc:  # noqa: BLE001
        raise TransportError(f"Failed to write sidecar for '{name}': {exc}") from exc
    return key


def delete_sidecar(s3, core_bucket, name):
    """Delete the sidecar metadata object for a dataset.

    Removes ONLY ``datasets/<name>/_dataset.json`` — the metadata index. The
    dataset data bytes under ``datasets/<name>/`` are never touched (delete =
    de-register from the sidecar registry, not destroy data).

    Idempotent: a delete of a non-existent key is a no-op. Raises TransportError
    for non-404 failures so callers can distinguish transport from not-found.
    """
    key = _sidecar_key(name)
    try:
        s3.delete_object(Bucket=core_bucket, Key=key)
    except Exception as exc:  # noqa: BLE001
        if _is_not_found(exc):
            return
        raise TransportError(f"Failed to delete sidecar for '{name}': {exc}") from exc
    return key


def list_sidecars(s3, core_bucket):
    """List all dataset sidecar documents under ``datasets/``.

    Paginates over ``datasets/`` and reads each ``_dataset.json`` object.
    Returns a list of parsed sidecar dicts. Unreadable/corrupt sidecars are
    skipped (best-effort listing).
    """
    docs = []
    try:
        paginator = s3.get_paginator("list_objects_v2")
        pages = list(paginator.paginate(Bucket=core_bucket, Prefix=DATASETS_PREFIX))
    except Exception as exc:  # noqa: BLE001
        raise TransportError(f"Failed to list datasets: {exc}") from exc

    for page in pages:
        for obj in page.get("Contents", []):
            key = obj.get("Key", "")
            if not key.endswith("/" + SIDECAR_FILENAME) and not key.endswith(SIDECAR_FILENAME):
                continue
            # Only match datasets/<name>/_dataset.json (exactly one path segment)
            rel = key[len(DATASETS_PREFIX):] if key.startswith(DATASETS_PREFIX) else key
            parts = rel.split("/")
            if len(parts) != 2 or parts[1] != SIDECAR_FILENAME:
                continue
            try:
                resp = s3.get_object(Bucket=core_bucket, Key=key)
                body = resp["Body"].read()
                if isinstance(body, bytes):
                    body = body.decode("utf-8")
                docs.append(json.loads(body))
            except Exception:  # noqa: BLE001 — skip unreadable sidecar
                continue
    return docs
