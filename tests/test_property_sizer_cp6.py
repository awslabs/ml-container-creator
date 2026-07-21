"""Property-based test: built-in sizer matches MCP formula (CP-6).

**Validates: Requirements CP-6**

The built-in instance-sizer heuristic MUST produce the same recommendation
as the MCP instance-sizer for any model where both use the same VRAM formula
and precision input. This test independently re-implements the MCP formula
and verifies agreement with the built-in heuristic across random inputs.
"""
import os
import sys

import pytest
from hypothesis import given, settings, HealthCheck, assume
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

from instance_sizer import (  # noqa: E402
    BYTES_PER_PARAM,
    OVERHEAD_FACTOR,
    TP_OVERHEAD_PER_GPU,
    BYTES_IN_GB,
    INSTANCE_CATALOG,
    estimate_vram,
    effective_vram,
    recommend,
)

# ---------------------------------------------------------------------------
# Independent MCP formula re-implementation (test oracle)
# ---------------------------------------------------------------------------

# These constants mirror what the MCP server uses — same values as the
# built-in heuristic by design.
MCP_BYTES_PER_PARAM = {
    "float32": 4.0,
    "float16": 2.0,
    "bfloat16": 2.0,
    "int8": 1.0,
    "int4": 0.5,
}

MCP_OVERHEAD_FACTOR = 0.1  # 10%
MCP_TP_OVERHEAD_PER_GPU = 0.10  # 10% per additional GPU
MCP_BYTES_IN_GB = 1024**3

# Same catalog (type, per_gpu_vram_gb, gpu_count), sorted ascending by effective VRAM
MCP_INSTANCE_CATALOG = [
    ("ml.g6.xlarge", 24, 1),
    ("ml.g6e.xlarge", 48, 1),
    ("ml.g6.12xlarge", 24, 4),
    ("ml.g6e.12xlarge", 48, 4),
    ("ml.g6e.48xlarge", 48, 8),
    ("ml.p6-b200.48xlarge", 192, 8),
]


def mcp_estimate_vram(parameter_count: float, precision: str) -> float:
    """MCP's VRAM estimation: params * bytes_per_param * 1.1 / bytes_in_gb."""
    bpp = MCP_BYTES_PER_PARAM.get(precision, MCP_BYTES_PER_PARAM["float16"])
    vram_bytes = parameter_count * bpp * (1 + MCP_OVERHEAD_FACTOR)
    return vram_bytes / MCP_BYTES_IN_GB


def mcp_effective_vram(per_gpu_gb: float, gpu_count: int) -> float:
    """MCP's effective VRAM after tensor-parallelism overhead."""
    if gpu_count <= 1:
        return per_gpu_gb
    total = per_gpu_gb * gpu_count
    overhead = per_gpu_gb * MCP_TP_OVERHEAD_PER_GPU * (gpu_count - 1)
    return total - overhead


def mcp_recommend(model_params_b: float, precision: str = "float16") -> str:
    """Simulate MCP instance-sizer/recommend with same formula."""
    parameter_count = model_params_b * 1e9
    vram_needed = mcp_estimate_vram(parameter_count, precision)

    for instance_type, per_gpu_gb, gpu_count in MCP_INSTANCE_CATALOG:
        available = mcp_effective_vram(per_gpu_gb, gpu_count)
        if available >= vram_needed:
            return instance_type

    # If nothing fits, return the largest instance
    return MCP_INSTANCE_CATALOG[-1][0]


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Realistic model sizes: 0.1B to 500B parameters
st_model_params_b = st.floats(min_value=0.1, max_value=500.0, allow_nan=False, allow_infinity=False)

# All valid precision types
st_precision = st.sampled_from(list(BYTES_PER_PARAM.keys()))


# ---------------------------------------------------------------------------
# Property-based tests
# ---------------------------------------------------------------------------


class TestSizerMatchesMCP:
    """Property: built-in sizer matches MCP for all valid inputs.

    **Validates: Requirements CP-6**

    The built-in instance-sizer heuristic MUST produce the same
    recommendation as the MCP instance-sizer for any model where both
    use the same VRAM formula and precision input.
    """

    @given(model_params_b=st_model_params_b, precision=st_precision)
    @settings(
        max_examples=200,
        deadline=5000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_recommend_matches_mcp(self, model_params_b, precision):
        """Built-in recommend() matches MCP for any valid model_params_b and precision."""
        builtin_result = recommend(model_params_b, precision)
        mcp_result = mcp_recommend(model_params_b, precision)

        assert builtin_result == mcp_result, (
            f"Sizer mismatch for model_params_b={model_params_b}, "
            f"precision={precision}: "
            f"built-in={builtin_result}, MCP={mcp_result}"
        )

    @given(
        parameter_count=st.floats(
            min_value=1e6, max_value=500e9, allow_nan=False, allow_infinity=False
        ),
        precision=st_precision,
    )
    @settings(
        max_examples=200,
        deadline=5000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_estimate_vram_matches_mcp(self, parameter_count, precision):
        """Built-in estimate_vram() matches MCP formula for any parameter count."""
        builtin_vram = estimate_vram(parameter_count, precision)
        mcp_vram = mcp_estimate_vram(parameter_count, precision)

        assert abs(builtin_vram - mcp_vram) < 1e-9, (
            f"VRAM estimate mismatch for params={parameter_count}, "
            f"precision={precision}: "
            f"built-in={builtin_vram}, MCP={mcp_vram}"
        )

    @given(
        per_gpu_gb=st.floats(min_value=1.0, max_value=256.0, allow_nan=False, allow_infinity=False),
        gpu_count=st.sampled_from([1, 2, 4, 8]),
    )
    @settings(
        max_examples=200,
        deadline=5000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_effective_vram_matches_mcp(self, per_gpu_gb, gpu_count):
        """Built-in effective_vram() matches MCP formula for any GPU config."""
        builtin_eff = effective_vram(per_gpu_gb, gpu_count)
        mcp_eff = mcp_effective_vram(per_gpu_gb, gpu_count)

        assert abs(builtin_eff - mcp_eff) < 1e-9, (
            f"Effective VRAM mismatch for per_gpu_gb={per_gpu_gb}, "
            f"gpu_count={gpu_count}: "
            f"built-in={builtin_eff}, MCP={mcp_eff}"
        )


# ---------------------------------------------------------------------------
# Edge case tests (deterministic examples)
# ---------------------------------------------------------------------------


class TestSizerEdgeCases:
    """Deterministic edge-case tests for sizer behavior.

    **Validates: Requirements CP-6**
    """

    def test_very_small_model_fits_smallest_instance(self):
        """A tiny model (0.1B, float16) should fit on ml.g6.xlarge (24GB)."""
        result = recommend(0.1, "float16")
        assert result == "ml.g6.xlarge", f"Expected ml.g6.xlarge, got {result}"

    def test_very_large_model_uses_largest_instance(self):
        """A huge model (500B, float32) should fall to the largest instance."""
        result = recommend(500.0, "float32")
        assert result == "ml.p6-b200.48xlarge", f"Expected ml.p6-b200.48xlarge, got {result}"

    @pytest.mark.parametrize("precision", list(BYTES_PER_PARAM.keys()))
    def test_all_precisions_produce_same_as_mcp(self, precision):
        """Each precision type matches MCP for a 7B model."""
        builtin_result = recommend(7.0, precision)
        mcp_result = mcp_recommend(7.0, precision)
        assert builtin_result == mcp_result, (
            f"Mismatch for 7B model, precision={precision}: "
            f"built-in={builtin_result}, MCP={mcp_result}"
        )

    def test_boundary_exact_fit_g6_xlarge(self):
        """Model at exact 24GB boundary: both implementations agree."""
        # ml.g6.xlarge: 24GB, 1 GPU -> effective = 24GB
        # vram_needed = params_b * 1e9 * bpp * 1.1 / 1024^3
        # For float16 (bpp=2): params_b * 1e9 * 2 * 1.1 / 1073741824 = 24
        # params_b = 24 * 1073741824 / (1e9 * 2 * 1.1)
        params_b = 24 * BYTES_IN_GB / (1e9 * 2.0 * 1.1)
        result = recommend(params_b, "float16")
        mcp_result = mcp_recommend(params_b, "float16")
        # Key property: both implementations agree at the boundary
        assert result == mcp_result

    def test_boundary_just_over_g6_xlarge(self):
        """Model that needs just over 24GB jumps to next tier."""
        # Just over 24GB effective VRAM for float16
        params_b = 24 * BYTES_IN_GB / (1e9 * 2.0 * 1.1) + 0.001
        result = recommend(params_b, "float16")
        mcp_result = mcp_recommend(params_b, "float16")
        assert result == mcp_result
        assert result == "ml.g6e.xlarge"  # Next tier: 48GB single GPU

    def test_boundary_exact_fit_g6e_xlarge(self):
        """Model at exact 48GB boundary: both implementations agree."""
        # ml.g6e.xlarge: 48GB, 1 GPU -> effective = 48GB
        params_b = 48 * BYTES_IN_GB / (1e9 * 2.0 * 1.1)
        result = recommend(params_b, "float16")
        mcp_result = mcp_recommend(params_b, "float16")
        # Key property: both implementations agree at the boundary
        assert result == mcp_result

    def test_int4_allows_larger_models_on_smaller_instances(self):
        """int4 precision (0.5 bytes) should allow larger models on smaller instances."""
        # With int4, a 7B model needs: 7e9 * 0.5 * 1.1 / 1073741824 ≈ 3.59 GB
        result = recommend(7.0, "int4")
        assert result == "ml.g6.xlarge"

    def test_float32_needs_larger_instance(self):
        """float32 (4 bytes) needs more VRAM than float16 for same model."""
        # 7B float32: 7e9 * 4 * 1.1 / 1073741824 ≈ 28.7 GB > 24 GB
        result_f32 = recommend(7.0, "float32")
        result_f16 = recommend(7.0, "float16")
        # float32 should need a bigger (or equal) instance
        catalog_types = [t for t, _, _ in INSTANCE_CATALOG]
        assert catalog_types.index(result_f32) >= catalog_types.index(result_f16)
