"""Unit tests for benchmark writer derived field computation.

Tests cover: model_family extraction, instance_family extraction,
cost_per_1m_tokens computation, and partition key derivation.

Requirements validated: 5.2, 5.3, 6.3
"""

import importlib.util
import os
import sys
from datetime import datetime, timezone

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_WRITER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".benchmark_writer.py"
)
_WRITER_PATH = os.path.normpath(_WRITER_PATH)

_spec = importlib.util.spec_from_file_location("benchmark_writer", _WRITER_PATH)
_benchmark_writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_benchmark_writer)

compute_model_family = _benchmark_writer.compute_model_family
compute_instance_family = _benchmark_writer.compute_instance_family
compute_partition_keys = _benchmark_writer.compute_partition_keys
# Wave 9 (R7.3/R8.1): the hardcoded $/hr table is gone; cost is computed by the
# shared pricing helper from a resolved price + billed instance count.
compute_cost = _benchmark_writer._load_helper('pricing').compute_cost


# ── Test: compute_model_family ────────────────────────────────────────────────


class TestComputeModelFamily:
    """Test model_family derivation from model_name.

    Validates: Requirements 5.2, 6.3
    """

    def test_qwen3_with_org(self):
        """Qwen/Qwen3-4B → qwen3"""
        assert compute_model_family("Qwen/Qwen3-4B") == "qwen3"

    def test_qwen3_8b(self):
        """Qwen/Qwen3-8B → qwen3"""
        assert compute_model_family("Qwen/Qwen3-8B") == "qwen3"

    def test_qwen2_5(self):
        """Qwen/Qwen2.5-72B-Instruct → qwen2 (version dots collapsed)"""
        assert compute_model_family("Qwen/Qwen2.5-72B-Instruct") == "qwen2"

    def test_llama3_1(self):
        """meta-llama/Llama-3.1-8B → llama3 (version dots collapsed)"""
        assert compute_model_family("meta-llama/Llama-3.1-8B") == "llama3"

    def test_llama3_1_instruct(self):
        """meta-llama/Llama-3.1-8B-Instruct → llama3"""
        assert compute_model_family("meta-llama/Llama-3.1-8B-Instruct") == "llama3"

    def test_llama2(self):
        """meta-llama/Llama-2-7b-chat-hf → llama2"""
        assert compute_model_family("meta-llama/Llama-2-7b-chat-hf") == "llama2"

    def test_deepseek_r1_distill(self):
        """deepseek-ai/DeepSeek-R1-Distill-Qwen-7B → deepseek-r1"""
        assert compute_model_family("deepseek-ai/DeepSeek-R1-Distill-Qwen-7B") == "deepseek-r1"

    def test_deepseek_v3(self):
        """deepseek-ai/DeepSeek-V3-0324 → deepseek-v3"""
        assert compute_model_family("deepseek-ai/DeepSeek-V3-0324") == "deepseek-v3"

    def test_deepseek_coder(self):
        """deepseek-ai/deepseek-coder-7b → deepseek-coder"""
        assert compute_model_family("deepseek-ai/deepseek-coder-7b") == "deepseek-coder"

    def test_mistral(self):
        """mistralai/Mistral-7B-v0.3 → mistral"""
        assert compute_model_family("mistralai/Mistral-7B-v0.3") == "mistral"

    def test_mixtral(self):
        """mistralai/Mixtral-8x7B-Instruct-v0.1 → mixtral"""
        assert compute_model_family("mistralai/Mixtral-8x7B-Instruct-v0.1") == "mixtral"

    def test_gemma2(self):
        """google/gemma-2-9b-it → gemma2"""
        assert compute_model_family("google/gemma-2-9b-it") == "gemma2"

    def test_phi3(self):
        """microsoft/Phi-3-mini-4k-instruct → phi3"""
        assert compute_model_family("microsoft/Phi-3-mini-4k-instruct") == "phi3"

    def test_falcon(self):
        """tiiuae/falcon-40b-instruct → falcon"""
        assert compute_model_family("tiiuae/falcon-40b-instruct") == "falcon"

    def test_empty_string(self):
        """Empty string → unknown"""
        assert compute_model_family("") == "unknown"

    def test_none(self):
        """None → unknown"""
        assert compute_model_family(None) == "unknown"

    def test_no_org_prefix(self):
        """Qwen3-4B (no org) → qwen3"""
        assert compute_model_family("Qwen3-4B") == "qwen3"

    def test_starcoder(self):
        """bigcode/starcoder2-15b → starcoder"""
        assert compute_model_family("bigcode/starcoder2-15b") == "starcoder"

    def test_unknown_model(self):
        """Completely unknown model → other"""
        assert compute_model_family("unknown-org/totally-new-model-7B") == "other"


# ── Test: compute_instance_family ─────────────────────────────────────────────


class TestComputeInstanceFamily:
    """Test instance_family derivation from instance_type.

    Validates: Requirements 5.3, 6.3
    """

    def test_g5_xlarge(self):
        """ml.g5.xlarge → g5"""
        assert compute_instance_family("ml.g5.xlarge") == "g5"

    def test_g5_48xlarge(self):
        """ml.g5.48xlarge → g5"""
        assert compute_instance_family("ml.g5.48xlarge") == "g5"

    def test_g6e_2xlarge(self):
        """ml.g6e.2xlarge → g6e"""
        assert compute_instance_family("ml.g6e.2xlarge") == "g6e"

    def test_p5_48xlarge(self):
        """ml.p5.48xlarge → p5"""
        assert compute_instance_family("ml.p5.48xlarge") == "p5"

    def test_p4d_24xlarge(self):
        """ml.p4d.24xlarge → p4d"""
        assert compute_instance_family("ml.p4d.24xlarge") == "p4d"

    def test_inf2_xlarge(self):
        """ml.inf2.xlarge → inf2"""
        assert compute_instance_family("ml.inf2.xlarge") == "inf2"

    def test_trn1_32xlarge(self):
        """ml.trn1.32xlarge → trn1"""
        assert compute_instance_family("ml.trn1.32xlarge") == "trn1"

    def test_trn2_48xlarge(self):
        """ml.trn2.48xlarge → trn2"""
        assert compute_instance_family("ml.trn2.48xlarge") == "trn2"

    def test_g6_xlarge(self):
        """ml.g6.xlarge → g6"""
        assert compute_instance_family("ml.g6.xlarge") == "g6"

    def test_empty_string(self):
        """Empty string → unknown"""
        assert compute_instance_family("") == "unknown"

    def test_none(self):
        """None → unknown"""
        assert compute_instance_family(None) == "unknown"

    def test_invalid_format(self):
        """No dots → unknown"""
        assert compute_instance_family("invalid") == "unknown"


# ── Test: compute_cost (Wave 9 R8.1) ──────────────────────────────────────────


class TestComputeCost:
    """cost per 1M output tokens = usd/h x instance_count x 1e6 / (3600 x tok/s).

    Synthetic prices only — real prices come from the Pricing API (test_pricing.py).
    """

    def test_basic_computation(self):
        result = compute_cost(1.8, 1, 500.0)
        assert result == pytest.approx(1.8 * 1e6 / (3600 * 500.0), abs=1e-4)

    def test_high_throughput_lower_cost(self):
        assert compute_cost(2.0, 1, 100.0) > compute_cost(2.0, 1, 1000.0)

    def test_instance_count_multiplies(self):
        assert compute_cost(2.0, 3, 100.0) == pytest.approx(3 * compute_cost(2.0, 1, 100.0), abs=1e-3)

    def test_unknown_price_returns_none(self):
        assert compute_cost(None, 1, 500.0) is None

    def test_zero_throughput_returns_none(self):
        assert compute_cost(2.0, 1, 0) is None

    def test_negative_throughput_returns_none(self):
        assert compute_cost(2.0, 1, -10.0) is None

    def test_none_throughput_returns_none(self):
        assert compute_cost(2.0, 1, None) is None

    def test_result_is_rounded(self):
        result = compute_cost(1.234567, 1, 333.0)
        assert result == round(result, 4)


# ── Test: compute_partition_keys ──────────────────────────────────────────────


class TestComputePartitionKeys:
    """Test year/month partition key derivation.

    Validates: Requirements 6.3
    """

    def test_iso8601_with_z(self):
        """ISO 8601 with Z suffix → correct year/month."""
        year, month = compute_partition_keys("2026-06-09T14:30:22Z")
        assert year == "2026"
        assert month == "06"

    def test_iso8601_with_offset(self):
        """ISO 8601 with +00:00 offset → correct year/month."""
        year, month = compute_partition_keys("2026-01-15T08:00:00+00:00")
        assert year == "2026"
        assert month == "01"

    def test_december(self):
        """December timestamp → month=12."""
        year, month = compute_partition_keys("2025-12-31T23:59:59Z")
        assert year == "2025"
        assert month == "12"

    def test_january(self):
        """January timestamp → month=01 (zero-padded)."""
        year, month = compute_partition_keys("2026-01-01T00:00:00Z")
        assert year == "2026"
        assert month == "01"

    def test_compact_format(self):
        """Compact format 20260609T143022Z → correct year/month."""
        year, month = compute_partition_keys("20260609T143022Z")
        assert year == "2026"
        assert month == "06"

    def test_datetime_object(self):
        """datetime object → correct year/month."""
        dt = datetime(2026, 3, 15, 10, 30, 0, tzinfo=timezone.utc)
        year, month = compute_partition_keys(dt)
        assert year == "2026"
        assert month == "03"

    def test_none_returns_current(self):
        """None timestamp → returns current year/month."""
        year, month = compute_partition_keys(None)
        now = datetime.now(timezone.utc)
        assert year == str(now.year)
        assert month == f"{now.month:02d}"

    def test_month_zero_padded(self):
        """Single-digit months are zero-padded."""
        year, month = compute_partition_keys("2026-03-01T00:00:00Z")
        assert month == "03"
        assert len(month) == 2
