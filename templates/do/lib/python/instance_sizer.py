from __future__ import annotations
"""Built-in instance-sizing heuristic (MCP fallback).

A standalone Python port of the VRAM estimation formula from the MCP
instance-sizer server (servers/instance-sizer/lib/vram-estimator.js).
Used as a backstop when the MCP socket is unreachable — CI pipelines,
SSH sessions, or any environment without a live MCP server.

Same formula, same constants → same result as MCP for the subset of
logic ported here (no KV cache, no quota/reservation, no CUDA filtering).

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


def estimate_vram(parameter_count: float, precision: str) -> float:
    """Estimate VRAM required to hold model weights with overhead.

    Uses the simplified heuristic (no KV cache):
        vram_gb = (params * bytes_per_param * 1.1) / BYTES_IN_GB

    Args:
        parameter_count: Total model parameters (e.g. 7_000_000_000 for 7B).
        precision: Data type string — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.

    Returns:
        Estimated VRAM in GB.
    """
    bpp = BYTES_PER_PARAM.get(precision, BYTES_PER_PARAM["float16"])
    vram_bytes = parameter_count * bpp * (1 + OVERHEAD_FACTOR)
    return vram_bytes / BYTES_IN_GB


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


def recommend(model_params_b: float, precision: str = "float16") -> str:
    """Recommend the smallest instance that fits the model.

    Iterates the catalog (sorted by effective VRAM ascending) and returns
    the first instance whose effective VRAM meets or exceeds the model's
    estimated requirement.

    Args:
        model_params_b: Model size in *billions* of parameters (e.g. 7.0).
        precision: Data type — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.

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
    vram_needed = estimate_vram(parameter_count, precision)

    for instance_type, per_gpu_gb, gpu_count in INSTANCE_CATALOG:
        available = effective_vram(per_gpu_gb, gpu_count)
        if available >= vram_needed:
            return instance_type

    # If nothing fits, return the largest instance
    return INSTANCE_CATALOG[-1][0]


def recommend_for_model(model_name: str, precision: str = "float16") -> str | None:
    """Recommend the smallest instance for a model identified by name.

    Higher-level wrapper matching the MCP instance-sizer/recommend interface:
    takes a model name string, resolves it to a parameter count via HF Hub,
    then delegates to recommend() for instance selection.

    Args:
        model_name: HF Hub model identifier (e.g. "meta-llama/Llama-2-7b-hf").
        precision: Data type — one of the keys in BYTES_PER_PARAM.
                   Falls back to float16 if unrecognized.

    Returns:
        SageMaker instance type string (e.g. "ml.g6.xlarge"), or None if the
        model's parameter count cannot be resolved.
    """
    params_b = resolve_model_params(model_name)
    if params_b is None:
        return None
    return recommend(params_b, precision)


def resolve_model_params(model_name: str) -> float | None:
    """Attempt to resolve parameter count from Hugging Face Hub.

    Downloads config.json for *model_name* and extracts the parameter
    count. Falls back to estimating from architecture dimensions if
    ``num_parameters`` is not present.

    Estimation formula (matches MCP server's model-resolver.js):
        params ≈ hidden_size * num_hidden_layers * 12

    Args:
        model_name: HF Hub model identifier (e.g. "meta-llama/Llama-2-7b-hf").

    Returns:
        Parameter count in billions (e.g. 7.0), or None if lookup fails.
    """
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
            config: dict[str, Any] = json.load(f)

        # Direct parameter count field
        if "num_parameters" in config:
            return config["num_parameters"] / 1e9

        # Estimate from architecture dimensions
        hidden_size = config.get("hidden_size")
        num_layers = config.get("num_hidden_layers")
        if hidden_size and num_layers:
            estimated = hidden_size * num_layers * 12
            return estimated / 1e9

        return None  # noqa: TRY300

    except Exception:  # noqa: BLE001
        return None
