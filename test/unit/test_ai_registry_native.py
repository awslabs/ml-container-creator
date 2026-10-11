"""Unit tests for ai_registry_native (BL123, native AI Registry helpers).

All offline: no live AWS. DataSet.create / SDK availability / region are mocked
or patched so the behavior — not any account state — is what's asserted.

Validates: Req 1.5 (non-fatal), Req 3.2/3.3 (domain_id passthrough), Req 7.1/7.2
(region + SDK-floor guardrails), Req 11 (technique label→member map).
"""
import sys
from unittest.mock import MagicMock, patch

import pytest

import ai_registry_native as arn


# ── technique label → native member map (Req 11) ──────────────────────────────

class TestNativeMemberFor:
    def test_sft_maps_to_sft_member(self):
        assert arn.native_member_for("sft") == ("SFT", True)

    def test_dpo_maps_to_dpo_member(self):
        assert arn.native_member_for("dpo") == ("DPO", True)

    def test_rlvr_maps_to_rlvr_member(self):
        assert arn.native_member_for("rlvr") == ("RLVR", True)

    def test_rlaif_folds_into_rlvr_member(self):
        # RLAIF prompt corpora share RLVR's shape; intended technique lives in sidecar.
        assert arn.native_member_for("rlaif") == ("RLVR", True)

    def test_mtrl_folds_into_rlvr_member(self):
        assert arn.native_member_for("mtrl") == ("RLVR", True)

    def test_benchmark_is_sidecar_only(self):
        member, recognized = arn.native_member_for("benchmark")
        assert recognized is True
        assert member is None

    def test_unknown_label_not_recognized(self):
        assert arn.native_member_for("totally-made-up") == (None, False)

    def test_label_is_case_and_whitespace_insensitive(self):
        assert arn.native_member_for("  SFT  ") == ("SFT", True)

    def test_none_label_not_recognized(self):
        assert arn.native_member_for(None) == (None, False)

    def test_dataset_techniques_lists_all_six_labels(self):
        assert arn.dataset_techniques() == sorted(
            ["sft", "dpo", "rlvr", "rlaif", "mtrl", "benchmark"]
        )


# ── reward-artifact rejection (Req 11.5) ───────────────────────────────────────

class TestIsRewardArtifactLabel:
    @pytest.mark.parametrize("label", [
        "reward-prompt", "reward_prompt", "reward-function", "reward_function",
        "REWARD-PROMPT", "  reward_function  ",
    ])
    def test_reward_labels_detected(self, label):
        assert arn.is_reward_artifact_label(label) is True

    @pytest.mark.parametrize("label", ["sft", "dpo", "benchmark", None, ""])
    def test_non_reward_labels_pass(self, label):
        assert arn.is_reward_artifact_label(label) is False


# ── region guardrail (Req 7.1) ─────────────────────────────────────────────────

class TestRegionSupport:
    @pytest.mark.parametrize("region", [
        "us-east-1", "us-west-2", "ap-northeast-1", "eu-west-1",
    ])
    def test_supported_regions(self, region):
        assert arn.region_supports_ai_registry(region) is True

    @pytest.mark.parametrize("region", ["eu-central-1", "ap-south-1", "", None])
    def test_unsupported_regions(self, region):
        assert arn.region_supports_ai_registry(region) is False


# ── register_dataset_native: skip behavior (Req 7.1/7.2, non-fatal) ────────────

class TestRegisterDatasetNativeSkips:
    def test_unknown_technique_skips(self):
        with pytest.raises(arn.NativeRegistrySkipped) as ei:
            arn.register_dataset_native(
                name="d", s3_uri="s3://b/d/", technique="nope",
                region="us-west-2",
            )
        assert "no native AI Registry member" in str(ei.value)

    def test_benchmark_technique_skips_as_sidecar_only(self):
        with pytest.raises(arn.NativeRegistrySkipped) as ei:
            arn.register_dataset_native(
                name="d", s3_uri="s3://b/d/", technique="benchmark",
                region="us-west-2",
            )
        assert "sidecar-only" in str(ei.value)

    def test_unsupported_region_skips_before_sdk_touch(self):
        with pytest.raises(arn.NativeRegistrySkipped) as ei:
            arn.register_dataset_native(
                name="d", s3_uri="s3://b/d/", technique="sft",
                region="eu-central-1",
            )
        assert "does not support" in str(ei.value)

    def test_missing_sdk_skips_with_upgrade_message(self):
        # Technique + region OK, but SDK not available → degrade, not ImportError.
        with patch.object(arn, "check_ai_registry_available", return_value=False):
            with pytest.raises(arn.NativeRegistrySkipped) as ei:
                arn.register_dataset_native(
                    name="d", s3_uri="s3://b/d/", technique="sft",
                    region="us-west-2",
                )
        assert "upgrade sagemaker" in str(ei.value)


# ── register_dataset_native: success path with a mocked SDK ────────────────────

def _install_fake_sdk(created_capture):
    """Install a fake sagemaker.ai_registry.dataset module into sys.modules.

    created_capture is a dict the fake DataSet.create fills with its kwargs so the
    test can assert what was passed (customization_technique, domain_id, etc.).
    Returns a cleanup callable.
    """
    import types

    mod = types.ModuleType("sagemaker.ai_registry.dataset")

    class CustomizationTechnique:
        SFT = "SFT-MEMBER"
        DPO = "DPO-MEMBER"
        RLVR = "RLVR-MEMBER"

    class DataSet:
        def __init__(self, arn_, version):
            self.arn = arn_
            self.version = version

        @staticmethod
        def create(**kwargs):
            created_capture.update(kwargs)
            return DataSet("arn:aws:sagemaker:us-west-2:1:hub-content/x", "2.0.0")

    mod.CustomizationTechnique = CustomizationTechnique
    mod.DataSet = DataSet

    saved = {k: sys.modules.get(k) for k in (
        "sagemaker", "sagemaker.ai_registry", "sagemaker.ai_registry.dataset",
    )}
    sys.modules["sagemaker"] = sys.modules.get("sagemaker") or types.ModuleType("sagemaker")
    sys.modules["sagemaker.ai_registry"] = types.ModuleType("sagemaker.ai_registry")
    sys.modules["sagemaker.ai_registry.dataset"] = mod

    def cleanup():
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    return cleanup


class TestRegisterDatasetNativeSuccess:
    def test_domain_id_passed_through_and_tagged(self):
        captured = {}
        cleanup = _install_fake_sdk(captured)
        try:
            with patch.object(arn, "check_ai_registry_available", return_value=True):
                result = arn.register_dataset_native(
                    name="calib", s3_uri="s3://b/datasets/calib/",
                    technique="sft", region="us-west-2",
                    description="hello", role="arn:aws:iam::1:role/r",
                    domain_id="d-abc123",
                )
        finally:
            cleanup()

        assert captured["name"] == "calib"
        assert captured["source"] == "s3://b/datasets/calib/"
        assert captured["customization_technique"] == "SFT-MEMBER"
        assert captured["role"] == "arn:aws:iam::1:role/r"
        assert captured["domain_id"] == "d-abc123"
        assert captured["description"] == "hello"
        assert result["member"] == "SFT"
        assert result["domain_tagged"] is True
        assert result["version"] == "2.0.0"
        assert result["arn"].startswith("arn:aws:sagemaker:")

    def test_rlaif_uses_rlvr_member_natively(self):
        captured = {}
        cleanup = _install_fake_sdk(captured)
        try:
            with patch.object(arn, "check_ai_registry_available", return_value=True):
                result = arn.register_dataset_native(
                    name="prompts", s3_uri="s3://b/datasets/prompts/",
                    technique="rlaif", region="us-west-2",
                )
        finally:
            cleanup()

        assert captured["customization_technique"] == "RLVR-MEMBER"
        assert result["member"] == "RLVR"

    def test_no_domain_id_means_not_tagged(self):
        captured = {}
        cleanup = _install_fake_sdk(captured)
        try:
            with patch.object(arn, "check_ai_registry_available", return_value=True):
                result = arn.register_dataset_native(
                    name="calib", s3_uri="s3://b/datasets/calib/",
                    technique="dpo", region="us-east-1",
                )
        finally:
            cleanup()

        assert "domain_id" not in captured
        assert result["domain_tagged"] is False


# ── profile resolution helpers ─────────────────────────────────────────────────

class TestProfileResolution:
    def test_resolve_domain_id_reads_active_profile(self):
        with patch.object(arn, "_active_profile_data",
                          return_value={"domainId": "d-xyz"}):
            assert arn.resolve_domain_id() == "d-xyz"

    def test_resolve_domain_id_absent_is_none(self):
        with patch.object(arn, "_active_profile_data", return_value={}):
            assert arn.resolve_domain_id() is None

    def test_resolve_training_role_prefers_env(self, monkeypatch):
        monkeypatch.setenv("MLCC_TRAINING_ROLE_ARN", "arn:env:role")
        with patch.object(arn, "_active_profile_data",
                          return_value={"roleArn": "arn:profile:role"}):
            assert arn.resolve_training_role() == "arn:env:role"

    def test_resolve_training_role_falls_back_to_profile(self, monkeypatch):
        monkeypatch.delenv("MLCC_TRAINING_ROLE_ARN", raising=False)
        with patch.object(arn, "_active_profile_data",
                          return_value={"roleArn": "arn:profile:role"}):
            assert arn.resolve_training_role() == "arn:profile:role"
