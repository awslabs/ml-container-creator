"""Unit tests for instance_sizer module.

Validates: Requirements FR-10.3, CP-6
"""
from __future__ import annotations

import json

import pytest

from instance_sizer import (
    BYTES_IN_GB,
    BYTES_PER_PARAM,
    DEFAULT_MAX_SEQUENCE_LENGTH,
    INSTANCE_CATALOG,
    KV_CACHE_FACTOR,
    OVERHEAD_FACTOR,
    TP_OVERHEAD_PER_GPU,
    effective_vram,
    estimate_vram,
    recommend,
    recommend_for_model,
    resolve_model_params,
    resolve_served_context,
)


def _kv(params: float, seq: int = DEFAULT_MAX_SEQUENCE_LENGTH) -> float:
    """KV-cache heuristic bytes (mirror of vram-estimator.js estimateKvCache)."""
    return params * (seq / DEFAULT_MAX_SEQUENCE_LENGTH) * KV_CACHE_FACTOR


# ---------------------------------------------------------------------------
# VRAM estimation tests (subtask 2.2)
# ---------------------------------------------------------------------------


class TestEstimateVram:
    """Verify VRAM formula matches MCP server constants."""

    def test_7b_fp16(self) -> None:
        """7B params at fp16 → ~14.7 GB ((params * 2 * 1.1 + kv) / 1024^3)."""
        vram = estimate_vram(7_000_000_000, "float16")
        expected = (7e9 * 2.0 * 1.1 + _kv(7e9)) / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_70b_fp16(self) -> None:
        """70B params at fp16 → ~143.5 GB."""
        vram = estimate_vram(70_000_000_000, "float16")
        expected = (70e9 * 2.0 * 1.1 + _kv(70e9)) / BYTES_IN_GB
        assert abs(vram - expected) < 0.01

    def test_7b_int4(self) -> None:
        """7B params at int4 → ~3.6 GB."""
        vram = estimate_vram(7_000_000_000, "int4")
        expected = (7e9 * 0.5 * 1.1 + _kv(7e9)) / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_7b_float32(self) -> None:
        """7B params at float32 → ~28.8 GB."""
        vram = estimate_vram(7_000_000_000, "float32")
        expected = (7e9 * 4.0 * 1.1 + _kv(7e9)) / BYTES_IN_GB
        assert abs(vram - expected) < 0.01

    @pytest.mark.parametrize("precision,bpp", list(BYTES_PER_PARAM.items()))
    def test_formula_matches_constants(self, precision: str, bpp: float) -> None:
        """For all precisions, formula is (params * bpp * 1.1 + kv) / BYTES_IN_GB.

        Validates: Requirements CP-6
        """
        params = 13_000_000_000  # 13B
        vram = estimate_vram(params, precision)
        expected = (params * bpp * (1 + OVERHEAD_FACTOR) + _kv(params)) / BYTES_IN_GB
        assert abs(vram - expected) < 0.001

    def test_kv_budget_scales_with_served_context(self) -> None:
        """BL240: the KV term follows the served context passed in, linearly."""
        params = 4_659_865_088
        short = estimate_vram(params, "bfloat16", DEFAULT_MAX_SEQUENCE_LENGTH)
        long = estimate_vram(params, "bfloat16", DEFAULT_MAX_SEQUENCE_LENGTH * 64)
        assert abs((long - short) - _kv(params) * 63 / BYTES_IN_GB) < 1e-6

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

        monkeypatch.setattr(instance_sizer, "_resolve_model_entry", lambda _: None)
        result = recommend_for_model("nonexistent/model")
        assert result is None

    def test_delegates_to_recommend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Resolves model name to params, then calls recommend()."""
        import instance_sizer

        # Simulate a 7B model resolution
        monkeypatch.setattr(instance_sizer, "_resolve_model_entry", lambda _: {"parameterCount": 7e9})
        result = recommend_for_model("meta-llama/Llama-2-7b-hf")
        expected = recommend(7.0, "float16")
        assert result == expected

    def test_passes_precision_through(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Precision argument is forwarded to recommend()."""
        import instance_sizer

        # Simulate a 70B model
        monkeypatch.setattr(instance_sizer, "_resolve_model_entry", lambda _: {"parameterCount": 70e9})
        result_fp16 = recommend_for_model("big-model/70b", "float16")
        result_int4 = recommend_for_model("big-model/70b", "int4")
        assert result_fp16 == recommend(70.0, "float16")
        assert result_int4 == recommend(70.0, "int4")

    def test_default_precision_is_fp16(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Default precision is float16 matching recommend() default."""
        import instance_sizer

        monkeypatch.setattr(instance_sizer, "_resolve_model_entry", lambda _: {"parameterCount": 13e9})
        explicit = recommend_for_model("model/13b", "float16")
        default = recommend_for_model("model/13b")
        assert explicit == default

    def test_long_native_context_budgets_served_context(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """BL240: a small model with a huge native context is sized for the
        engine's served context, not its native maximum."""
        import instance_sizer

        params = 4_659_865_088  # Qwen3.5-4B (Hub safetensors total)
        monkeypatch.setattr(
            instance_sizer,
            "_resolve_model_entry",
            lambda _: {"parameterCount": params, "maxPositionEmbeddings": 262144},
        )
        served = resolve_served_context(None, 262144, "vllm")["servedContext"]
        assert served < 262144
        assert recommend_for_model("Qwen/Qwen3.5-4B", "bfloat16", engine="vllm") == recommend(
            params / 1e9, "bfloat16", served
        )
        # The estimate the recommendation used fits a 24 GB GPU.
        assert estimate_vram(params, "bfloat16", served) < 24


class TestResolveServedContext:
    """BL240: served = explicit request | min(native, engine default)."""

    def test_engine_default_caps_native(self) -> None:
        r = resolve_served_context(None, 262144, "vllm")
        assert r["servedContext"] == r["engineDefault"] < 262144
        assert r["source"].startswith("engine-default:vllm:")

    def test_short_native_context_wins(self) -> None:
        r = resolve_served_context(None, 1024, "vllm")
        assert r["servedContext"] == min(1024, r["engineDefault"])

    def test_explicit_request_wins(self) -> None:
        assert resolve_served_context(131072, 262144, "vllm")["servedContext"] == 131072

    def test_unknown_engine_uses_reference_length(self) -> None:
        r = resolve_served_context(None, None, "no-such-engine")
        assert r == {
            "servedContext": DEFAULT_MAX_SEQUENCE_LENGTH,
            "source": "sizer-default",
            "engineDefault": DEFAULT_MAX_SEQUENCE_LENGTH,
        }


# ---------------------------------------------------------------------------
# resolve_model_params tests (subtask 2.5 — HF config.json lookup)
# ---------------------------------------------------------------------------


try:
    import huggingface_hub  # noqa: F401
    HAS_HUGGINGFACE_HUB = True
except ImportError:
    HAS_HUGGINGFACE_HUB = False


@pytest.mark.skipif(not HAS_HUGGINGFACE_HUB, reason="huggingface_hub not installed")
class TestResolveModelParams:
    """Verify resolve_model_params() parses HF config.json correctly.

    Validates: Requirements FR-10.3
    """

    @pytest.fixture(autouse=True)
    def _offline_hub_api(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Keep these tests offline: no HF Hub API (safetensors metadata) lookup."""
        import catalog_registration

        monkeypatch.setattr(catalog_registration, "_fetch_hub_info", lambda *a, **k: None)

    def test_hub_safetensors_total_wins_over_config(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """The Hub API safetensors total is authoritative over config fields."""
        import catalog_registration
        import huggingface_hub

        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"num_parameters": 1_000_000_000}))
        monkeypatch.setattr(huggingface_hub, "hf_hub_download", lambda **kwargs: str(config_file))
        monkeypatch.setattr(
            catalog_registration, "_fetch_hub_info",
            lambda *a, **k: {"safetensors": {"parameters": {"BF16": 4_500_000_000}, "total": 4_500_000_000}},
        )
        assert resolve_model_params("some-org/hub-model") == 4.5

    def test_multimodal_text_config_is_sized(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        """A config nesting the LM under text_config must not resolve to None."""
        import huggingface_hub

        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({
            "architectures": ["SomeForConditionalGeneration"],
            "text_config": {"hidden_size": 2560, "num_hidden_layers": 32, "vocab_size": 248320,
                            "tie_word_embeddings": True},
        }))
        monkeypatch.setattr(huggingface_hub, "hf_hub_download", lambda **kwargs: str(config_file))
        result = resolve_model_params("some-org/vlm")
        assert result is not None and result > 1.0

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
        """When no num_parameters, estimates layers * 12 * hidden^2 + embeddings.

        (The old hidden * layers * 12 formula dropped a factor of hidden and
        sized a Llama-3-8B-shaped config at ~0.0016B.)
        """
        config_data = {
            "hidden_size": 4096,
            "num_hidden_layers": 32,
            "vocab_size": 128256,
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
        published_b = 8.030261248  # safetensors total of meta-llama/Llama-3.1-8B (same shape)
        assert result is not None
        assert abs(result - published_b) / published_b < 0.15

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
