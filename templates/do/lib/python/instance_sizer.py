from __future__ import annotations
"""Built-in instance-sizing heuristic (MCP fallback).

A standalone Python port of the VRAM estimation formula from the MCP
instance-sizer server (servers/instance-sizer/lib/vram-estimator.js).
Used as a backstop when the MCP socket is unreachable — CI pipelines,
SSH sessions, or any environment without a live MCP server.

Same formula, same constants → same result as MCP for the subset of
logic ported here (weights + overhead + the KV-cache heuristic budgeted for
the SERVED context; no quota/reservation, no CUDA filtering).

BL240: the KV cache is budgeted for the context the server will actually
serve — min(model max_position_embeddings, engine default max_model_len) —
not the model's native maximum. The engine default is derived from the
serve.d manifest (env_var_prefix + dimension_map.max_model_len) and the
engine image defaults in model-servers.json; see resolve_served_context().
Mirror of servers/instance-sizer/lib/served-context.js, drift-checked by
test/unit/served-context-conformance.test.js.

Callers: deploy_prompts.py (via recommend()), .deploy_helper.py
"""

from typing import Any

# ---------------------------------------------------------------------------
# Constants — MUST match servers/instance-sizer/lib/vram-estimator.js
# ---------------------------------------------------------------------------

BYTES_PER_PARAM: dict[str, float] = {
    "float32": 4.0,
    "float16": 2.0,
    "bfloat16": 2.0,
    "int8": 1.0,
    "int4": 0.5,
}

OVERHEAD_FACTOR: float = 0.1  # 10% framework/CUDA overhead
DEFAULT_MAX_SEQUENCE_LENGTH: int = 4096  # KV heuristic reference length / fallback served context
DEFAULT_BATCH_SIZE: int = 1
KV_CACHE_FACTOR: float = 0.05  # KV bytes per parameter at DEFAULT_MAX_SEQUENCE_LENGTH, batch 1
TP_OVERHEAD_PER_GPU: float = 0.10  # 10% per additional GPU for tensor parallelism
BYTES_IN_GB: int = 1024**3

# ---------------------------------------------------------------------------
# Instance catalog subset — sorted by effective VRAM ascending.
# Each entry: (instance_type, per_gpu_vram_gb, gpu_count)
# ---------------------------------------------------------------------------

INSTANCE_CATALOG: list[tuple[str, int, int]] = [
    ("ml.g6.xlarge", 24, 1),
    ("ml.g6e.xlarge", 48, 1),
    ("ml.g6.12xlarge", 24, 4),
    ("ml.g6e.12xlarge", 48, 4),
    ("ml.g6e.48xlarge", 48, 8),
    ("ml.p6-b200.48xlarge", 192, 8),
]


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------


def estimate_kv_cache(
    parameter_count: float,
    max_sequence_length: int | None = None,
    batch_size: int | None = None,
) -> float:
    """KV-cache heuristic in bytes (mirror of vram-estimator.js estimateKvCache).

        kv_bytes = params * (seq_len / DEFAULT_MAX_SEQUENCE_LENGTH) * batch * KV_CACHE_FACTOR
    """
    seq = max_sequence_length or DEFAULT_MAX_SEQUENCE_LENGTH
    batch = batch_size or DEFAULT_BATCH_SIZE
    return parameter_count * (seq / DEFAULT_MAX_SEQUENCE_LENGTH) * batch * KV_CACHE_FACTOR


def estimate_vram(
    parameter_count: float,
    precision: str,
    max_sequence_length: int | None = None,
    batch_size: int | None = None,
) -> float:
    """Estimate VRAM required to serve a model (mirror of vram-estimator.js estimateVram).

        vram_gb = (params * bytes_per_param * (1 + OVERHEAD_FACTOR) + kv_bytes) / BYTES_IN_GB

    Args:
        parameter_count: Total model parameters (e.g. 7_000_000_000 for 7B).
        precision: Data type string — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.
        max_sequence_length: SERVED context the KV cache is budgeted for
            (resolve_served_context); defaults to DEFAULT_MAX_SEQUENCE_LENGTH.
        batch_size: Concurrent sequences; defaults to DEFAULT_BATCH_SIZE.

    Returns:
        Estimated VRAM in GB.
    """
    bpp = BYTES_PER_PARAM.get(precision, BYTES_PER_PARAM["float16"])
    weight_bytes = parameter_count * bpp
    vram_bytes = (
        weight_bytes
        + estimate_kv_cache(parameter_count, max_sequence_length, batch_size)
        + weight_bytes * OVERHEAD_FACTOR
    )
    return vram_bytes / BYTES_IN_GB


def engine_default_served_context(engine: str | None) -> tuple[int, str] | None:
    """The engine's default served context and the env var that carries it.

    Derived, not hardcoded: the serve.d manifest names the env var
    (env_var_prefix + dimension_map.max_model_len) and the engine image
    defaults in model-servers.json (first = newest entry) give its value.
    Returns None when the engine, its manifest, or the default is unknown.
    """
    if not engine or not isinstance(engine, str):
        return None
    try:
        import serve_manifest  # noqa: WPS433 — sibling module in lib/python

        manifest = serve_manifest.read_manifest(engine)
    except Exception:  # noqa: BLE001 — unknown engine / missing manifest
        return None
    suffix = (manifest.get("dimension_map") or {}).get("max_model_len")
    if not suffix or not isinstance(suffix, str):
        return None
    env_var = f"{manifest.get('env_var_prefix') or ''}{suffix}"
    import json  # noqa: WPS433
    import os  # noqa: WPS433

    for path in serve_manifest._candidate_model_servers_catalogs():
        if not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                catalog = json.load(f)
        except (OSError, ValueError):
            continue
        entries = catalog.get(engine) if isinstance(catalog, dict) else None
        if not isinstance(entries, list) or not entries:
            return None
        raw = ((entries[0] or {}).get("defaults") or {}).get("envVars", {}).get(env_var)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return None
        return (value, env_var) if value > 0 else None
    return None


def resolve_served_context(
    requested: int | None = None,
    max_position_embeddings: int | None = None,
    engine: str | None = None,
) -> dict[str, Any]:
    """Resolve the context the KV cache is budgeted for (mirror of resolveServedContext).

    An explicit request wins as-is; otherwise
    min(max_position_embeddings, engine default), with DEFAULT_MAX_SEQUENCE_LENGTH
    as the engine default when the engine declares none.

    Returns:
        {"servedContext": int, "source": str, "engineDefault": int}
    """
    info = engine_default_served_context(engine)
    engine_default = info[0] if info else DEFAULT_MAX_SEQUENCE_LENGTH
    if isinstance(requested, int) and requested > 0:
        return {"servedContext": requested, "source": "requested", "engineDefault": engine_default}
    default_source = f"engine-default:{engine}:{info[1]}" if info else "sizer-default"
    if (
        isinstance(max_position_embeddings, int)
        and 0 < max_position_embeddings < engine_default
    ):
        return {
            "servedContext": max_position_embeddings,
            "source": "model-max-position-embeddings",
            "engineDefault": engine_default,
        }
    return {"servedContext": engine_default, "source": default_source, "engineDefault": engine_default}


def effective_vram(per_gpu_gb: float, gpu_count: int) -> float:
    """Calculate effective usable VRAM after tensor-parallelism overhead.

    Each additional GPU beyond the first loses 10% of its per-GPU capacity
    to communication overhead:
        effective = total - per_gpu * 0.10 * (gpu_count - 1)

    This matches the MCP server's instance-ranker.js formula.

    Args:
        per_gpu_gb: VRAM per GPU in GB.
        gpu_count: Number of GPUs (tensor parallelism degree).

    Returns:
        Effective usable VRAM in GB.
    """
    if gpu_count <= 1:
        return per_gpu_gb
    total = per_gpu_gb * gpu_count
    overhead = per_gpu_gb * TP_OVERHEAD_PER_GPU * (gpu_count - 1)
    return total - overhead


def recommend(
    model_params_b: float,
    precision: str = "float16",
    served_context: int | None = None,
) -> str:
    """Recommend the smallest instance that fits the model.

    Iterates the catalog (sorted by effective VRAM ascending) and returns
    the first instance whose effective VRAM meets or exceeds the model's
    estimated requirement.

    Args:
        model_params_b: Model size in *billions* of parameters (e.g. 7.0).
        precision: Data type — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.
        served_context: Context the KV cache is budgeted for
            (resolve_served_context); defaults to DEFAULT_MAX_SEQUENCE_LENGTH.

    Returns:
        SageMaker instance type string (e.g. "ml.g6.xlarge").

    Raises:
        ValueError: If model_params_b is not positive.
    """
    if model_params_b <= 0:
        raise ValueError(
            f"model_params_b must be positive, got {model_params_b}"
        )

    parameter_count = model_params_b * 1e9
    vram_needed = estimate_vram(parameter_count, precision, served_context)

    for instance_type, per_gpu_gb, gpu_count in INSTANCE_CATALOG:
        available = effective_vram(per_gpu_gb, gpu_count)
        if available >= vram_needed:
            return instance_type

    # If nothing fits, return the largest instance
    return INSTANCE_CATALOG[-1][0]


def recommend_for_model(
    model_name: str,
    precision: str = "float16",
    engine: str | None = None,
) -> str | None:
    """Recommend the smallest instance for a model identified by name.

    Higher-level wrapper matching the MCP instance-sizer/recommend interface:
    takes a model name string, resolves its size and native context via HF Hub,
    budgets KV cache for the served context (resolve_served_context), then
    delegates to recommend() for instance selection.

    Args:
        model_name: HF Hub model identifier (e.g. "meta-llama/Llama-2-7b-hf").
        precision: Data type — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.
        engine: Serving engine (serve.d name, e.g. "vllm"); selects the default
            served context. None → DEFAULT_MAX_SEQUENCE_LENGTH.

    Returns:
        SageMaker instance type string (e.g. "ml.g6.xlarge"), or None if the
        model's parameter count cannot be resolved.
    """
    entry = _resolve_model_entry(model_name)
    count = (entry or {}).get("parameterCount")
    if not count:
        return None
    served = resolve_served_context(
        None, (entry or {}).get("maxPositionEmbeddings"), engine
    )
    return recommend(count / 1e9, precision, served["servedContext"])


def resolve_model_params(model_name: str) -> float | None:
    """Attempt to resolve parameter count from Hugging Face Hub.

    Precedence (same as the MCP server's model-resolver.js and
    catalog_registration._extract_from_hf_config):
      1. HF Hub API safetensors.total (authoritative; public even for gated repos)
      2. config.json ``num_parameters``
      3. dense-transformer estimate from config dimensions, reading the nested
         ``text_config`` of multimodal models (never for MoE)

    Args:
        model_name: HF Hub model identifier (e.g. "meta-llama/Llama-2-7b-hf").

    Returns:
        Parameter count in billions (e.g. 7.0), or None if lookup fails.
    """
    entry = _resolve_model_entry(model_name)
    count = (entry or {}).get("parameterCount")
    return count / 1e9 if count else None


def _resolve_model_entry(model_name: str) -> dict[str, Any] | None:
    """Resolve the model-sizes entry (parameterCount, maxPositionEmbeddings, ...)
    from the HF Hub, using the same extraction as do/stage. None on failure."""
    import catalog_registration  # noqa: WPS433 — sibling module in lib/python

    hub_info = catalog_registration._fetch_hub_info(model_name)

    config: dict[str, Any] = {}
    try:
        from huggingface_hub import hf_hub_download  # noqa: WPS433
        import json

        config_path = hf_hub_download(
            repo_id=model_name,
            filename="config.json",
            force_download=False,
            timeout=5,
        )

        with open(config_path) as f:
            config = json.load(f)
    except Exception:  # noqa: BLE001
        config = {}

    if not config and not hub_info:
        return None
    return catalog_registration._extract_from_hf_config(config, hub_info)
