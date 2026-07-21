"""Unit tests for instance_sizer module.

Validates: Requirements FR-10.3, CP-6
"""
from __future__ import annotations

import json

import pytest

from instance_sizer import (
    BYTES_IN_GB,
    BYTES_PER_PARAM,
    INSTANCE_CATALOG,
    OVERHEAD_FACTOR,
    TP_OVERHEAD_PER_GPU,
    effective_vram,
    estimate_vram,
    recommend,
    recommend_for_model,
    resolve_model_params,
)


# ---------------------------------------------------------------------------
# VRAM estimation tests (subtask 2.2)
# ---------------------------------------------------------------------------


class TestEstimateVram:
    """Verify VRAM formula matches MCP server constants."""

    def test_7b_fp16(self) -> None:
        """7B params at fp16 → ~14.7 GB (params * 2 * 1.1 / 1024^3)."""
        vram = estimate_vram(7_000_000_000, "float16")
        expected = 7e9 * 2.0 * 1.1 / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_70b_fp16(self) -> None:
        """70B params at fp16 → ~143.5 GB."""
        vram = estimate_vram(70_000_000_000, "float16")
        expected = 70e9 * 2.0 * 1.1 / BYTES_IN_GB
        assert abs(vram - expected) < 0.01

    def test_7b_int4(self) -> None:
        """7B params at int4 → ~3.6 GB."""
        vram = estimate_vram(7_000_000_000, "int4")
        expected = 7e9 * 0.5 * 1.1 / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_7b_float32(self) -> None:
        """7B params at float32 → ~28.8 GB."""
        vram = estimate_vram(7_000_000_000, "float32")
        expected = 7e9 * 4.0 * 1.1 / BYTES_IN_GB
        assert abs(vram - expected) < 0.01

    @pytest.mark.parametrize("precision,bpp", list(BYTES_PER_PARAM.items()))
    def test_formula_matches_constants(self, precision: str, bpp: float) -> None:
        """For all precisions, formula is params * bpp * 1.1 / BYTES_IN_GB.

        Validates: Requirements CP-6
        """
        params = 13_000_000_000  # 13B
        vram = estimate_vram(params, precision)
        expected = params * bpp * (1 + OVERHEAD_FACTOR) / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_unknown_precision_falls_back_to_fp16(self) -> None:
        """Unknown precision string uses float16 bytes-per-param."""
        vram = estimate_vram(7_000_000_000, "unknown_dtype")
        expected = estimate_vram(7_000_000_000, "float16")
        assert vram == expected


# ---------------------------------------------------------------------------
# Effective VRAM / TP overhead tests (subtask 2.3)
# ---------------------------------------------------------------------------


class TestEffectiveVram:
    """Verify TP overhead formula matches MCP server's instance-ranker.js."""

    def test_single_gpu_no_overhead(self) -> None:
        """Single GPU returns full per-GPU VRAM."""
        assert effective_vram(24.0, 1) == 24.0

    def test_4_gpu_tp_overhead(self) -> None:
        """4 GPUs: effective = total - per_gpu * 0.10 * 3.

        For 4x 24GB: total=96, overhead=24*0.10*3=7.2, effective=88.8
        """
        result = effective_vram(24.0, 4)
        expected = 24.0 * 4 - 24.0 * TP_OVERHEAD_PER_GPU * 3
        assert abs(result - expected) < 0.001
        assert abs(result - 88.8) < 0.001

    def test_8_gpu_tp_overhead(self) -> None:
        """8 GPUs: effective = total - per_gpu * 0.10 * 7.

        For 8x 48GB: total=384, overhead=48*0.10*7=33.6, effective=350.4
        """
        result = effective_vram(48.0, 8)
        expected = 48.0 * 8 - 48.0 * TP_OVERHEAD_PER_GPU * 7
        assert abs(result - expected) < 0.001
        assert abs(result - 350.4) < 0.001

    def test_matches_mcp_formula(self) -> None:
        """TP formula: totalVram - perGpuMemory * 0.10 * (gpuCount - 1).

        Validates: Requirements CP-6
        """
        # ml.p6-b200.48xlarge: 8x 192GB
        per_gpu = 192.0
        gpu_count = 8
        result = effective_vram(per_gpu, gpu_count)
        # MCP formula: total - per_gpu * 0.10 * (gpu_count - 1)
        total = per_gpu * gpu_count
        mcp_result = total - per_gpu * 0.10 * (gpu_count - 1)
        assert result == mcp_result


# ---------------------------------------------------------------------------
# Instance recommendation tests (subtask 2.4)
# ---------------------------------------------------------------------------


class TestRecommend:
    """Verify recommend() picks correct instance tier."""

    def test_small_model_fits_single_gpu(self) -> None:
        """3B fp16 → ~6.1 GB → ml.g6.xlarge (24GB effective)."""
        result = recommend(3.0, "float16")
        assert result == "ml.g6.xlarge"

    def test_7b_fp16_fits_single_gpu(self) -> None:
        """7B fp16 → ~14.3 GB → ml.g6.xlarge (24GB effective)."""
        result = recommend(7.0, "float16")
        assert result == "ml.g6.xlarge"

    def test_13b_fp16_fits_single_48gb(self) -> None:
        """13B fp16 → ~26.6 GB → ml.g6e.xlarge (48GB effective)."""
        result = recommend(13.0, "float16")
        assert result == "ml.g6e.xlarge"

    def test_70b_fp16_needs_multi_gpu(self) -> None:
        """70B fp16 → ~143.5 GB → ml.g6e.12xlarge (4x48=163.2GB effective)."""
        result = recommend(70.0, "float16")
        assert result == "ml.g6e.12xlarge"

    def test_70b_int4_fits_smaller(self) -> None:
        """70B int4 → ~35.9 GB → ml.g6e.xlarge (48GB effective)."""
        result = recommend(70.0, "int4")
        assert result == "ml.g6e.xlarge"

    def test_very_large_model_gets_largest(self) -> None:
        """500B fp16 → ~1024 GB → ml.p6-b200.48xlarge (largest)."""
        result = recommend(500.0, "float16")
        assert result == "ml.p6-b200.48xlarge"

    def test_model_exceeding_all_returns_largest(self) -> None:
        """2000B fp16 far exceeds all instances → returns largest."""
        result = recommend(2000.0, "float16")
        assert result == "ml.p6-b200.48xlarge"

    def test_default_precision_is_fp16(self) -> None:
        """Default precision parameter is float16."""
        explicit = recommend(7.0, "float16")
        default = recommend(7.0)
        assert explicit == default

    def test_invalid_params_raises(self) -> None:
        """Non-positive model_params_b raises ValueError."""
        with pytest.raises(ValueError, match="must be positive"):
            recommend(0.0)
        with pytest.raises(ValueError, match="must be positive"):
            recommend(-1.0)

    def test_unknown_precision_uses_fp16(self) -> None:
        """Unknown precision falls back to float16 sizing."""
        result = recommend(7.0, "weird_type")
        expected = recommend(7.0, "float16")
        assert result == expected


# ---------------------------------------------------------------------------
# CP-6 parity tests
# ---------------------------------------------------------------------------


class TestCP6Parity:
    """Verify Python heuristic produces same results as MCP server.

    CP-6: The built-in instance-sizer heuristic MUST produce the same
    recommendation as the MCP instance-sizer for any model where both
    use the same VRAM formula and precision input.

    Validates: Requirements CP-6
    """

    @pytest.mark.parametrize(
        "params_b,precision,expected_instance",
        [
            # Small models → single GPU
            (1.0, "float16", "ml.g6.xlarge"),      # ~2.0 GB
            (7.0, "float16", "ml.g6.xlarge"),      # ~14.3 GB
            (7.0, "int8", "ml.g6.xlarge"),         # ~7.2 GB
            (7.0, "int4", "ml.g6.xlarge"),         # ~3.6 GB
            # Medium models → single larger GPU or multi-GPU
            (13.0, "float16", "ml.g6e.xlarge"),    # ~26.6 GB
            (22.0, "float16", "ml.g6e.xlarge"),    # ~45.0 GB
            # Large models → multi-GPU
            (40.0, "float16", "ml.g6.12xlarge"),   # ~81.9 GB, needs 4xg6(88.8)
            (70.0, "float16", "ml.g6e.12xlarge"),  # ~143.5 GB, needs 4xg6e(163.2)
            # Very large models → 8-GPU
            (165.0, "float16", "ml.g6e.48xlarge"), # ~337.9 GB, fits 8xg6e(350.4)
            (175.0, "float16", "ml.p6-b200.48xlarge"),  # ~358.6 GB, exceeds 8xg6e(350.4)
            (500.0, "float16", "ml.p6-b200.48xlarge"),  # ~1024 GB
        ],
    )
    def test_parity_cases(
        self, params_b: float, precision: str, expected_instance: str
    ) -> None:
        """Known (params, precision) → expected instance mapping.

        These cases have been manually verified against the MCP server's
        vram-estimator.js + instance-ranker.js logic using the same
        constants and catalog.
        """
        result = recommend(params_b, precision)
        assert result == expected_instance

    def test_constants_match_mcp_server(self) -> None:
        """Verify Python constants match vram-estimator.js values."""
        # From servers/instance-sizer/lib/vram-estimator.js
        assert BYTES_PER_PARAM == {
            "float32": 4.0,
            "float16": 2.0,
            "bfloat16": 2.0,
            "int8": 1.0,
            "int4": 0.5,
        }
        assert OVERHEAD_FACTOR == 0.1
        assert BYTES_IN_GB == 1024**3

    def test_tp_overhead_matches_mcp_ranker(self) -> None:
        """Verify TP overhead constant matches instance-ranker.js."""
        assert TP_OVERHEAD_PER_GPU == 0.10

    def test_catalog_sorted_by_effective_vram(self) -> None:
        """Instance catalog must be sorted by effective VRAM ascending."""
        effective_vrams = [
            effective_vram(per_gpu, gpus)
            for _, per_gpu, gpus in INSTANCE_CATALOG
        ]
        assert effective_vrams == sorted(effective_vrams)


# ---------------------------------------------------------------------------
# recommend_for_model tests (subtask 2.4 — model name interface)
# ---------------------------------------------------------------------------


class TestRecommendForModel:
    """Verify recommend_for_model() resolves model name and recommends.

    Validates: Requirements FR-10.3, CP-6
    """

    def test_returns_none_when_model_not_found(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Returns None when resolve_model_params fails."""
        import instance_sizer

        monkeypatch.setattr(instance_sizer, "resolve_model_params", lambda _: None)
        result = recommend_for_model("nonexistent/model")
        assert result is None

    def test_delegates_to_recommend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Resolves model name to params, then calls recommend()."""
        import instance_sizer

        # Simulate a 7B model resolution
        monkeypatch.setattr(instance_sizer, "resolve_model_params", lambda _: 7.0)
        result = recommend_for_model("meta-llama/Llama-2-7b-hf")
        expected = recommend(7.0, "float16")
        assert result == expected

    def test_passes_precision_through(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Precision argument is forwarded to recommend()."""
        import instance_sizer

        # Simulate a 70B model
        monkeypatch.setattr(instance_sizer, "resolve_model_params", lambda _: 70.0)
        result_fp16 = recommend_for_model("big-model/70b", "float16")
        result_int4 = recommend_for_model("big-model/70b", "int4")
        assert result_fp16 == recommend(70.0, "float16")
        assert result_int4 == recommend(70.0, "int4")

    def test_default_precision_is_fp16(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Default precision is float16 matching recommend() default."""
        import instance_sizer

        monkeypatch.setattr(instance_sizer, "resolve_model_params", lambda _: 13.0)
        explicit = recommend_for_model("model/13b", "float16")
        default = recommend_for_model("model/13b")
        assert explicit == default


# ---------------------------------------------------------------------------
# resolve_model_params tests (subtask 2.5 — HF config.json lookup)
# ---------------------------------------------------------------------------


class TestResolveModelParams:
    """Verify resolve_model_params() parses HF config.json correctly.

    Validates: Requirements FR-10.3
    """

    def test_returns_params_from_num_parameters_field(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """When config.json has num_parameters, returns value in billions."""
        config_data = {"num_parameters": 7_000_000_000}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/some-model")
        assert result == 7.0

    def test_estimates_from_architecture_dimensions(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """When no num_parameters, estimates from hidden_size * num_hidden_layers * 12."""
        config_data = {
            "hidden_size": 4096,
            "num_hidden_layers": 32,
        }
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/arch-model")
        # 4096 * 32 * 12 = 1_572_864 params → 1_572_864 / 1e9 ≈ 0.001573
        expected = (4096 * 32 * 12) / 1e9
        assert result is not None
        assert abs(result - expected) < 1e-9

    def test_returns_none_when_fields_missing(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Returns None when config has neither num_parameters nor arch dims."""
        config_data = {"model_type": "bert"}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/minimal-model")
        assert result is None

    def test_returns_none_when_only_hidden_size_present(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Returns None when hidden_size is present but num_hidden_layers is missing."""
        config_data = {"hidden_size": 4096}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/partial-model")
        assert result is None

    def test_returns_none_when_only_num_hidden_layers_present(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Returns None when num_hidden_layers is present but hidden_size is missing."""
        config_data = {"num_hidden_layers": 32}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/layers-only-model")
        assert result is None

    def test_returns_none_on_download_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Returns None when hf_hub_download raises an exception."""
        import huggingface_hub

        def mock_download_fails(**kwargs):
            raise ConnectionError("Network unreachable")

        monkeypatch.setattr(
            huggingface_hub, "hf_hub_download", mock_download_fails
        )

        result = resolve_model_params("nonexistent/model-404")
        assert result is None

    def test_returns_none_on_invalid_json(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Returns None when config.json contains invalid JSON."""
        config_file = tmp_path / "config.json"
        config_file.write_text("not valid json {{{")

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/bad-json-model")
        assert result is None

    def test_prefers_num_parameters_over_architecture_estimate(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """When both num_parameters and arch dims exist, uses num_parameters."""
        config_data = {
            "num_parameters": 13_000_000_000,
            "hidden_size": 4096,
            "num_hidden_layers": 32,
        }
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("some-org/full-config-model")
        # Should use num_parameters (13B), not architecture estimate
        assert result == 13.0

    def test_passes_correct_args_to_hf_hub_download(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Verifies hf_hub_download is called with correct repo_id and filename."""
        config_data = {"num_parameters": 7_000_000_000}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        captured_kwargs: dict = {}

        def capturing_download(**kwargs):
            captured_kwargs.update(kwargs)
            return str(config_file)

        import huggingface_hub

        monkeypatch.setattr(huggingface_hub, "hf_hub_download", capturing_download)

        resolve_model_params("meta-llama/Llama-2-7b-hf")

        assert captured_kwargs["repo_id"] == "meta-llama/Llama-2-7b-hf"
        assert captured_kwargs["filename"] == "config.json"
        assert captured_kwargs["timeout"] == 5

    def test_large_model_num_parameters(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """Correctly converts large num_parameters (70B) to billions."""
        config_data = {"num_parameters": 70_000_000_000}
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import huggingface_hub

        monkeypatch.setattr(
            huggingface_hub,
            "hf_hub_download",
            lambda **kwargs: str(config_file),
        )

        result = resolve_model_params("big-model/70b")
        assert result == 70.0
