from __future__ import annotations
"""Register common: shared registry utilities and constants.

Purpose: Registry file path constants, load/save helpers shared by all register_* modules
Callers: register_model.py, register_dataset.py, register_list.py, register_resolve.py
Related: common.py (output/error utilities)
"""

import json
import os

# ── Constants ─────────────────────────────────────────────────────────────────

MAX_METADATA_VALUE_LEN = 256

_REGISTRY_DIR = os.path.join(os.path.expanduser("~"), ".ml-container-creator")
_CONFIG_PATH = os.path.join(_REGISTRY_DIR, "config.json")
# NOTE (BL092): The local datasets index is removed. `_DATASETS_REGISTRY` is
# intentionally no longer referenced by any dataset code path — the S3 sidecar
# (datasets/<name>/_dataset.json in the Core bucket) is the source of truth.
# The constant is retained only so a stray legacy file can be recognized/ignored;
# it is NOT read or written for dataset operations.
_DATASETS_REGISTRY = os.path.join(_REGISTRY_DIR, "datasets.json")
_EVALUATORS_REGISTRY = os.path.join(_REGISTRY_DIR, "evaluators.json")

# ── S3 sidecar layout ──────────────────────────────────────────────────────────
# Dataset bytes land at s3://<Core_Bucket>/datasets/<name>/ (existing behavior).
# The metadata index lives beside them as datasets/<name>/_dataset.json.

DATASETS_PREFIX = "datasets/"
SIDECAR_FILENAME = "_dataset.json"


def _sidecar_key(name):
    """S3 key for a dataset's sidecar: datasets/<name>/_dataset.json."""
    return f"{DATASETS_PREFIX}{name}/{SIDECAR_FILENAME}"


def _sidecar_uri(core_bucket, name):
    """Full s3:// URI for a dataset's sidecar."""
    return f"s3://{core_bucket}/{_sidecar_key(name)}"


def _canonical_dataset_uri(core_bucket, name):
    """Canonical dataset prefix: s3://<core_bucket>/datasets/<name>/."""
    return f"s3://{core_bucket}/{DATASETS_PREFIX}{name}/"


# ── Registry I/O ──────────────────────────────────────────────────────────────


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


# ── S3 URI helpers ────────────────────────────────────────────────────────────


def _parse_s3_uri(s3_uri):
    """Parse an S3 URI into (bucket, key) tuple."""
    if not s3_uri.startswith("s3://"):
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    parts = s3_uri[5:].split("/", 1)
    bucket = parts[0]
    key = parts[1] if len(parts) > 1 else ""
    return bucket, key


def _is_s3_prefix(key):
    """Determine if an S3 key represents a prefix (directory) vs single file."""
    if not key or key.endswith("/"):
        return True
    last_part = key.rstrip("/").split("/")[-1]
    return "." not in last_part
