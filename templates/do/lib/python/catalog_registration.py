# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Model catalog auto-registration helper.

Called by do/stage after a successful model download to register the model's
metadata (parameter count, architecture, context length, dtype) into the
project-local model-sizes catalog override at .mlcc/model-sizes.json.

This file uses the same schema as servers/lib/catalogs/model-sizes.json
and is merged on top of the shipped catalog by the instance-sizer MCP server.

This makes the instance-sizer MCP server return accurate GPU utilization
estimates for models that are not in the bundled catalog.

Usage (from do/stage bash):
    python3 "${SCRIPT_DIR}/lib/python/catalog_registration.py" \
        --model-id "<org/model>" \
        --project-dir "<path>"

The script:
  1. Checks if the model is already in .mlcc/model-sizes.json (idempotent).
  2. Fetches config.json from S3 (staged path) or HuggingFace.
  3. Extracts parameter count, architecture, dtype, and max context length.
  4. Writes/merges the entry into .mlcc/model-sizes.json.
  5. Prints a user-visible notice.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Metadata extraction
# ---------------------------------------------------------------------------

def _estimate_params_from_config(config: dict[str, Any]) -> int | None:
    """Estimate parameter count from architecture dimensions (dense models)."""
    hidden = config.get("hidden_size")
    layers = config.get("num_hidden_layers")
    if hidden and layers:
        return hidden * layers * 12
    return None


def _extract_from_hf_config(config: dict[str, Any]) -> dict[str, Any]:
    """Extract sizing metadata from a HuggingFace config.json."""
    param_count = config.get("num_parameters") or _estimate_params_from_config(config)
    architecture = (config.get("architectures") or ["unknown"])[0]
    dtype = config.get("torch_dtype") or "float16"
    max_ctx = config.get("max_position_embeddings") or 4096
    num_layers = config.get("num_hidden_layers")
    num_kv_heads = config.get("num_key_value_heads") or config.get("num_attention_heads")
    hidden_size = config.get("hidden_size")
    num_attn_heads = config.get("num_attention_heads")
    head_dim = config.get("head_dim") or (
        (hidden_size // num_attn_heads) if hidden_size and num_attn_heads else None
    )

    entry: dict[str, Any] = {
        "architecture": architecture,
        "defaultDtype": dtype,
        "maxPositionEmbeddings": max_ctx,
    }
    if param_count:
        entry["parameterCount"] = param_count
    if num_layers:
        entry["numLayers"] = num_layers
    if num_kv_heads:
        entry["numKvHeads"] = num_kv_heads
    if head_dim:
        entry["headDim"] = head_dim

    return entry


def _fetch_config_from_s3(staged_uri: str, model_id: str) -> dict[str, Any] | None:
    """Try to read config.json from the staged S3 path."""
    import subprocess, tempfile
    config_uri = staged_uri.rstrip("/") + "/config.json"
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        tmp = f.name
    try:
        result = subprocess.run(
            ["aws", "s3", "cp", config_uri, tmp, "--quiet"],
            capture_output=True, timeout=15
        )
        if result.returncode == 0:
            with open(tmp) as fh:
                return json.load(fh)
    except Exception:
        pass
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass
    return None


def _fetch_config_from_hf(model_id: str, hf_token: str | None = None) -> dict[str, Any] | None:
    """Fetch config.json from HuggingFace Hub."""
    try:
        import urllib.request
        url = f"https://huggingface.co/{model_id}/resolve/main/config.json"
        req = urllib.request.Request(url, headers={
            "User-Agent": "ml-container-creator/catalog-registration",
            **({"Authorization": f"Bearer {hf_token}"} if hf_token else {}),
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Catalog read/write


LOCAL_CATALOG_FILENAME = "model-sizes.json"


def _load_local_catalog(catalog_path: Path) -> dict[str, Any]:
    """Load the project-local model-sizes override file."""
    if catalog_path.exists():
        try:
            return json.loads(catalog_path.read_text())
        except Exception:
            pass
    return {"catalogVersion": "local", "models": {}}


def _save_local_catalog(catalog_path: Path, catalog: dict[str, Any]) -> None:
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(json.dumps(catalog, indent=2))


def _model_key_pattern(model_id: str) -> str:
    """Return the glob pattern key for this model (exact org/name + wildcard for variants)."""
    return model_id.rstrip("*") + "*"


def _is_already_registered(catalog: dict[str, Any], model_id: str) -> bool:
    """Return True if the model (or a glob pattern matching it) is already in the catalog."""
    models = catalog.get("models", {})
    if isinstance(models, dict):
        for pattern in models:
            base = pattern.rstrip("*")
            if model_id == pattern or model_id.startswith(base):
                return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def register_model(
    model_id: str,
    project_dir: str,
    staged_uri: str | None = None,
    hf_token: str | None = None,
    verbose: bool = True,
) -> bool:
    """
    Register model metadata in .mlcc/model-sizes.json.

    Returns True if the catalog was updated, False if skipped (already registered
    or metadata could not be resolved).
    """
    catalog_path = Path(project_dir) / ".mlcc" / LOCAL_CATALOG_FILENAME
    catalog = _load_local_catalog(catalog_path)

    if _is_already_registered(catalog, model_id):
        return False

    if verbose:
        print(f"\n📊 Registering model in local catalog: {model_id}")
        print(f"   Fetching architecture metadata...", flush=True)

    # Try S3 first (already downloaded), then HuggingFace
    hf_config: dict[str, Any] | None = None
    source = ""
    if staged_uri:
        hf_config = _fetch_config_from_s3(staged_uri, model_id)
        if hf_config:
            source = "S3"
    if not hf_config:
        hf_config = _fetch_config_from_hf(model_id, hf_token)
        if hf_config:
            source = "HuggingFace"

    if not hf_config:
        if verbose:
            print(f"   ⚠️  Could not fetch config.json — skipping catalog registration.")
            print(f"      Instance recommendations for {model_id!r} will show all GPU instances.")
        return False

    entry = _extract_from_hf_config(hf_config)
    entry["modelId"] = _model_key_pattern(model_id)
    entry["source"] = "local"

    # Add to models dict using glob pattern as key (same schema as model-sizes.json)
    pattern_key = _model_key_pattern(model_id)
    models = catalog.setdefault("models", {})
    if not isinstance(models, dict):
        catalog["models"] = {}
        models = catalog["models"]
    models[pattern_key] = {k: v for k, v in entry.items() if k not in ("modelId", "source")}

    _save_local_catalog(catalog_path, catalog)

    if verbose:
        param_str = ""
        if "parameterCount" in entry:
            p = entry["parameterCount"]
            param_str = f"{p/1e9:.1f}B params" if p >= 1e9 else f"{p/1e6:.0f}M params"
        ctx_str = f"{entry.get('maxPositionEmbeddings', '?'):,} token context"
        dtype_str = entry.get("defaultDtype", "")
        arch_str = entry.get("architecture", "")
        print(f"   ✅ Registered in .mlcc/model-sizes.json")
        print(f"      {arch_str} · {param_str} · {dtype_str} · {ctx_str}")
        print(f"      GPU utilization estimates will now be accurate for this model.")
        print()

    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Register model metadata in the project-local model-sizes catalog."
    )
    parser.add_argument("--model-id", required=True, help="HuggingFace model ID (org/name)")
    parser.add_argument("--project-dir", required=True, help="Project directory (contains do/config)")
    parser.add_argument("--staged-uri", default="", help="S3 URI where model was staged")
    parser.add_argument("--hf-token", default="", help="HuggingFace token (for gated models)")
    parser.add_argument("--quiet", action="store_true", help="Suppress output")
    args = parser.parse_args()

    updated = register_model(
        model_id=args.model_id,
        project_dir=args.project_dir,
        staged_uri=args.staged_uri or None,
        hf_token=args.hf_token or None,
        verbose=not args.quiet,
    )
    sys.exit(0)
