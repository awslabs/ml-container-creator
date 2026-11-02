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

# Sub-config keys under which multimodal / composite HF configs nest the
# language-model dimensions (e.g. Qwen3_5ForConditionalGeneration keeps
# hidden_size / num_hidden_layers / max_position_embeddings / dtype under
# "text_config"). MUST mirror NESTED_TEXT_CONFIG_KEYS in
# servers/instance-sizer/lib/model-resolver.js — enforced by
# test/unit/hf-size-extraction-conformance.test.js.
NESTED_TEXT_CONFIG_KEYS = ("text_config", "llm_config", "language_config")

# Presence of any of these means mixture-of-experts: the dense formula does not apply.
_MOE_CONFIG_KEYS = ("num_experts", "num_local_experts", "n_routed_experts", "moe_num_experts")

# safetensors dtype tags (HF Hub API "safetensors.parameters") -> estimator dtype names.
_SAFETENSORS_DTYPE_MAP = {
    "BF16": "bfloat16",
    "F16": "float16",
    "F32": "float32",
    "I8": "int8",
    "U8": "int8",
    "F8_E4M3": "int8",
    "F8_E5M2": "int8",
}


def _nested_text_config(config: dict[str, Any]) -> dict[str, Any] | None:
    for key in NESTED_TEXT_CONFIG_KEYS:
        sub = config.get(key)
        if isinstance(sub, dict):
            return sub
    return None


def _config_field(config: dict[str, Any], key: str) -> Any:
    """Read a field from the top level, falling back to the nested text config."""
    value = config.get(key)
    if value is not None:
        return value
    sub = _nested_text_config(config)
    if sub is not None:
        return sub.get(key)
    return None


def _estimate_params_from_config(config: dict[str, Any]) -> int | None:
    """Estimate parameter count of a DENSE transformer from config dimensions.

    layers * 12 * hidden^2 + vocab * hidden (x2 when embeddings are untied).
    Last resort only; returns None for mixture-of-experts configs.
    """
    hidden = _config_field(config, "hidden_size")
    layers = _config_field(config, "num_hidden_layers")
    if not hidden or not layers:
        return None
    if any(_config_field(config, k) for k in _MOE_CONFIG_KEYS):
        return None
    vocab = _config_field(config, "vocab_size") or 0
    tied = _config_field(config, "tie_word_embeddings") is True
    return layers * 12 * hidden * hidden + vocab * hidden * (1 if tied else 2)


def _normalize_dtype(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    v = raw.lower()
    if v.startswith("torch."):
        v = v[len("torch."):]
    if v in ("bfloat16", "bf16"):
        return "bfloat16"
    if v in ("float16", "fp16", "half"):
        return "float16"
    if v in ("float32", "fp32", "float"):
        return "float32"
    return None


def _dominant_safetensors_dtype(safetensors: Any) -> str | None:
    params = safetensors.get("parameters") if isinstance(safetensors, dict) else None
    if not isinstance(params, dict):
        return None
    best, best_count = None, -1
    for tag, count in params.items():
        if isinstance(count, (int, float)) and count > best_count and tag in _SAFETENSORS_DTYPE_MAP:
            best, best_count = _SAFETENSORS_DTYPE_MAP[tag], count
    return best


def _extract_from_hf_config(
    config: dict[str, Any],
    hub_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Extract sizing metadata from a HuggingFace config.json (+ Hub API metadata).

    Parameter-count precedence (source recorded in "parameterCountSource"):
      1. Hub API safetensors.total (read from the published weight headers)
      2. config num_parameters
      3. dense-transformer estimate from config dimensions (never for MoE)
    Fields that cannot be derived are omitted, never guessed — in particular
    maxPositionEmbeddings is NOT defaulted to 4096 (that default used to be
    written for every multimodal model, whose context lives in text_config).
    MUST stay in sync with extractFromHuggingFaceConfig() in
    servers/instance-sizer/lib/model-resolver.js (conformance-tested).
    """
    config = config or {}
    safetensors = (hub_info or {}).get("safetensors")
    total = safetensors.get("total") if isinstance(safetensors, dict) else None

    param_count: int | None = None
    param_source: str | None = None
    if isinstance(total, (int, float)) and total > 0:
        param_count, param_source = int(total), "huggingface-safetensors-metadata"
    elif _config_field(config, "num_parameters"):
        param_count, param_source = _config_field(config, "num_parameters"), "config.num_parameters"
    else:
        estimated = _estimate_params_from_config(config)
        if estimated:
            param_count, param_source = estimated, "config-dimension-estimate"

    architectures = config.get("architectures") or ((hub_info or {}).get("config") or {}).get("architectures")
    architecture = (architectures or ["unknown"])[0]
    dtype = (
        _normalize_dtype(_config_field(config, "torch_dtype"))
        or _normalize_dtype(_config_field(config, "dtype"))
        or _dominant_safetensors_dtype(safetensors)
        or "float16"
    )
    max_ctx = _config_field(config, "max_position_embeddings")
    num_layers = _config_field(config, "num_hidden_layers")
    hidden_size = _config_field(config, "hidden_size")
    num_attn_heads = _config_field(config, "num_attention_heads")
    num_kv_heads = _config_field(config, "num_key_value_heads") or num_attn_heads
    head_dim = _config_field(config, "head_dim") or (
        (hidden_size // num_attn_heads) if hidden_size and num_attn_heads else None
    )

    entry: dict[str, Any] = {
        "architecture": architecture,
        "defaultDtype": dtype,
    }
    if max_ctx:
        entry["maxPositionEmbeddings"] = max_ctx
    if param_count:
        entry["parameterCount"] = param_count
        entry["parameterCountSource"] = param_source
    if num_layers:
        entry["numLayers"] = num_layers
    if num_kv_heads:
        entry["numKvHeads"] = num_kv_heads
    if head_dim:
        entry["headDim"] = head_dim

    return entry


def _fetch_hub_info(model_id: str, hf_token: str | None = None) -> dict[str, Any] | None:
    """Fetch the HF Hub model API record (carries safetensors parameter counts).

    The API is public even for gated repos, so this works where config.json 401s.
    """
    try:
        import urllib.request
        url = f"https://huggingface.co/api/models/{model_id}"
        req = urllib.request.Request(url, headers={
            "User-Agent": "ml-container-creator/catalog-registration",
            **({"Authorization": f"Bearer {hf_token}"} if hf_token else {}),
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return None


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
LOCAL_MODELS_FILENAME = "models.json"


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


def _derive_family(model_id: str) -> str:
    """Derive a models.json 'family' from a model ID.

    Strips the org prefix and lowercases, e.g.:
        'zai-org/GLM-5.3'       → 'glm-5.3'
        'zai-org/GLM-5.3-Flash' → 'glm-5.3-flash'
        'THUDM/glm-4'           → 'glm-4'
    """
    base = model_id.rstrip("*")
    name = base.split("/", 1)[1] if "/" in base else base
    return name.strip().lower()


def _tags_from_architecture(architecture: str | None) -> list[str]:
    """Derive models.json tags from the HF architecture, defaulting to text-generation."""
    # All currently-supported staged models are causal LMs → text-generation.
    # Architecture is retained in the entry; tags stay conservative/minimal.
    return ["text-generation"]


def _write_models_json_entry(
    project_dir: str,
    pattern_key: str,
    model_id: str,
    architecture: str | None,
) -> None:
    """Write a companion entry to .mlcc/models.json keyed by the same glob pattern.

    The instance-sizer validation requires every model-sizes pattern to be backed
    by a models.json entry, so register_model() keeps both catalogs in sync. The
    entry follows the servers/lib/catalogs/models.json schema (minimum fields).
    Best-effort and non-fatal: any error is swallowed so staging still succeeds.
    """
    try:
        models_path = Path(project_dir) / ".mlcc" / LOCAL_MODELS_FILENAME

        if models_path.exists():
            try:
                catalog = json.loads(models_path.read_text())
            except Exception:
                catalog = {}
        else:
            catalog = {}
        if not isinstance(catalog, dict):
            catalog = {}

        # Idempotent: skip if the pattern is already present.
        if pattern_key in catalog:
            return

        catalog[pattern_key] = {
            "family": _derive_family(model_id),
            "gated": False,
            "tags": _tags_from_architecture(architecture),
            "architecture": architecture if architecture else None,
            "chatTemplate": "",
            "frameworkCompatibility": {"vllm": ">=0.5.0", "sglang": ">=0.3.0"},
            "validationLevel": "community-validated",
            "modelType": "transformer",
            "tasks": ["text-generation"],
        }

        models_path.parent.mkdir(parents=True, exist_ok=True)
        models_path.write_text(json.dumps(catalog, indent=2))
    except Exception:
        # Non-fatal — model-sizes registration is the primary path.
        pass


def _model_key_pattern(model_id: str) -> str:
    """Return the glob pattern key for this model (exact org/name + wildcard for variants)."""
    return model_id.rstrip("*") + "*"


def _is_already_registered(catalog: dict[str, Any], model_id: str) -> bool:
    """Return True if the model is already in the catalog WITH a usable size.

    An entry without a parameterCount (written by older versions for
    multimodal configs) cannot size the model, so it is treated as absent and
    re-registered.
    """
    models = catalog.get("models", {})
    if isinstance(models, dict):
        for pattern, entry in models.items():
            base = pattern.rstrip("*")
            if model_id == pattern or model_id.startswith(base):
                count = entry.get("parameterCount") if isinstance(entry, dict) else None
                if isinstance(count, (int, float)) and count > 0:
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
    # Authoritative parameter count: HF Hub safetensors metadata.
    hub_info = _fetch_hub_info(model_id, hf_token)

    if not hf_config and not hub_info:
        if verbose:
            print(f"   ⚠️  Could not fetch config.json — skipping catalog registration.")
            print(f"      Instance recommendations for {model_id!r} will show all GPU instances.")
        return False

    entry = _extract_from_hf_config(hf_config or {}, hub_info)
    if "parameterCount" not in entry:
        # Do not cache an entry that cannot size the model — it would shadow
        # later discovery. The instance-sizer reports "cannot size" instead.
        if verbose:
            print(f"   ⚠️  Could not determine the parameter count of {model_id!r} — skipping catalog registration.")
            print(f"      Pass --instance-type to do/deploy explicitly.")
        return False
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

    # Keep .mlcc/models.json in sync so every model-sizes pattern is backed by a
    # models.json entry (instance-sizer validation requirement).
    _write_models_json_entry(
        project_dir=project_dir,
        pattern_key=pattern_key,
        model_id=model_id,
        architecture=entry.get("architecture"),
    )

    if verbose:
        param_str = ""
        if "parameterCount" in entry:
            p = entry["parameterCount"]
            param_str = f"{p/1e9:.1f}B params" if p >= 1e9 else f"{p/1e6:.0f}M params"
        max_ctx = entry.get("maxPositionEmbeddings")
        ctx_str = f"{max_ctx:,} token context" if isinstance(max_ctx, int) else "context length unknown"
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
