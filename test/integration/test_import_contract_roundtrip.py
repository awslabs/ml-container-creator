"""Integration test: Import contract round-trip verification (AC-6.3).

Verifies that a model registered via .register_helper.py stores all metadata
fields needed to reconstruct do/config variables. The test:
  1. Registers a model with all metadata fields (mocked SageMaker API)
  2. Queries the registered version (mock describe API returning stored metadata)
  3. Reconstructs do/config variables from the metadata
  4. Verifies all required config fields match the original input

Requirements validated: US-6 (AC-6.1, AC-6.3)
"""

import importlib.util
import json
import os
import sys
from argparse import Namespace
from unittest.mock import MagicMock, patch

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".register_helper.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("register_helper", _HELPER_PATH)
_register_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_register_helper)

_build_metadata = _register_helper._build_metadata
_truncate_metadata = _register_helper._truncate_metadata


# ── Test fixtures ─────────────────────────────────────────────────────────────

# The canonical config values used for registration
SAMPLE_CONFIG = {
    "deployment_config": "gpu-vllm",
    "architecture": "transformers",
    "backend": "vllm",
    "instance_type": "ml.g5.2xlarge",
    "model_name": "meta-llama/Llama-3.1-8B-Instruct",
    "base_image": "763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.29.0-lmi11.0.0-cu124",
    "model_format": "safetensors",
    "generator_version": "0.15.0",
    "project_name": "my-llm-project",
}

# Mapping from metadata keys to do/config environment variable names (AC-6.1)
METADATA_TO_CONFIG_VAR = {
    "deploymentConfig": "DEPLOYMENT_CONFIG",
    "architecture": "ARCHITECTURE",
    "backend": "BACKEND",
    "instanceType": "INSTANCE_TYPE",
    "modelName": "MODEL_NAME",
    "baseImage": "BASE_IMAGE",
    "modelFormat": "MODEL_FORMAT",
    "projectName": "PROJECT_NAME",
}

# Fields required for import (AC-6.1) — generatorVersion is informational only
REQUIRED_IMPORT_FIELDS = [
    "deploymentConfig",
    "architecture",
    "backend",
    "instanceType",
    "modelName",
    "baseImage",
    "modelFormat",
    "projectName",
]


def _make_register_args(**overrides):
    """Create a Namespace simulating CLI args for register-model."""
    args = {
        "project_name": SAMPLE_CONFIG["project_name"],
        "deployment_config": SAMPLE_CONFIG["deployment_config"],
        "architecture": SAMPLE_CONFIG["architecture"],
        "backend": SAMPLE_CONFIG["backend"],
        "instance_type": SAMPLE_CONFIG["instance_type"],
        "model_name": SAMPLE_CONFIG["model_name"],
        "base_image": SAMPLE_CONFIG["base_image"],
        "model_format": SAMPLE_CONFIG["model_format"],
        "generator_version": SAMPLE_CONFIG["generator_version"],
        "container_image": "763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:latest",
        "model_data_url": "s3://my-bucket/models/llama-3.1-8b/model.tar.gz",
        "region": "us-west-2",
        "role_arn": "arn:aws:iam::123456789012:role/SageMakerRole",
        "benchmark_results": None,
    }
    args.update(overrides)
    return Namespace(**args)


def _reconstruct_config_from_metadata(metadata):
    """Reconstruct do/config variables from stored metadata.

    This simulates what do/import would do: read customer_metadata_properties
    from a Model Package and produce environment variable assignments.

    Returns:
        dict mapping config variable names to their values
    """
    config = {}
    for meta_key, config_var in METADATA_TO_CONFIG_VAR.items():
        value = metadata.get(meta_key)
        if value is not None:
            config[config_var] = value
    return config


# ═══════════════════════════════════════════════════════════════════════════════
# Integration Test: Round-trip register → query → reconstruct (AC-6.3)
# ═══════════════════════════════════════════════════════════════════════════════


class TestImportContractRoundTrip:
    """Verify the import contract: register a model, query it, reconstruct config.

    Validates: Requirements AC-6.1, AC-6.3
    """

    def test_roundtrip_all_required_fields_preserved(self):
        """Register a model and verify all required fields survive the round-trip.

        Steps:
        1. Build metadata as .register_helper.py would during registration
        2. Simulate storing it in SageMaker (mock ModelPackage.create)
        3. Simulate querying it back (mock ModelPackage.get)
        4. Reconstruct do/config from returned metadata
        5. Verify all required fields match original input
        """
        args = _make_register_args()

        # Step 1: Build metadata (same as register-model does)
        metadata = _build_metadata(args)

        # Step 2: Simulate SageMaker storing and returning the metadata
        # In reality, SageMaker stores these as-is and returns them on describe
        stored_metadata = dict(metadata)  # SageMaker returns what was stored

        # Step 3: Reconstruct do/config from the queried metadata
        reconstructed = _reconstruct_config_from_metadata(stored_metadata)

        # Step 4: Verify all required fields match original input
        assert reconstructed["DEPLOYMENT_CONFIG"] == SAMPLE_CONFIG["deployment_config"]
        assert reconstructed["ARCHITECTURE"] == SAMPLE_CONFIG["architecture"]
        assert reconstructed["BACKEND"] == SAMPLE_CONFIG["backend"]
        assert reconstructed["INSTANCE_TYPE"] == SAMPLE_CONFIG["instance_type"]
        assert reconstructed["MODEL_NAME"] == SAMPLE_CONFIG["model_name"]
        assert reconstructed["BASE_IMAGE"] == SAMPLE_CONFIG["base_image"]
        assert reconstructed["MODEL_FORMAT"] == SAMPLE_CONFIG["model_format"]
        assert reconstructed["PROJECT_NAME"] == SAMPLE_CONFIG["project_name"]

    def test_roundtrip_via_mocked_sagemaker_api(self, capsys):
        """Full round-trip through mocked SageMaker create + describe APIs.

        Simulates the complete flow:
        1. cmd_register_model → calls ModelPackage.create with metadata
        2. ModelPackage.get → returns the stored metadata
        3. Reconstruct config → verify completeness
        """
        args = _make_register_args()

        # Capture what metadata gets passed to ModelPackage.create
        captured_metadata = {}

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = (
            "arn:aws:sagemaker:us-west-2:123456789012:model-package-group/my-llm-project"
        )

        mock_pkg = MagicMock()
        mock_pkg.model_package_arn = (
            "arn:aws:sagemaker:us-west-2:123456789012:model-package/my-llm-project/1"
        )

        def fake_model_package_create(**kwargs):
            captured_metadata.update(kwargs.get("customer_metadata_properties", {}))
            return mock_pkg

        mock_resources = MagicMock()
        mock_resources.ModelPackageGroup.create.return_value = mock_mpg
        mock_resources.ModelPackage.create.side_effect = fake_model_package_create

        # Simulate describe (get) returning the stored metadata
        mock_describe_pkg = MagicMock()
        mock_describe_pkg.customer_metadata_properties = None  # Will be set after create
        mock_describe_pkg.model_package_arn = mock_pkg.model_package_arn
        mock_describe_pkg.model_approval_status = "Approved"
        mock_describe_pkg.model_package_description = "gpu-vllm on ml.g5.2xlarge"

        with patch.object(_register_helper, "_check_sagemaker_core"):
            with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                # Step 1: Register model
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_register_model(args)
                assert exc_info.value.code == 0

        # Step 2: Verify metadata was captured during registration
        assert len(captured_metadata) > 0, "No metadata was passed to ModelPackage.create"

        # Step 3: Simulate querying the version back
        # (In production, ModelPackage.get returns customer_metadata_properties as-is)
        returned_metadata = dict(captured_metadata)

        # Step 4: Reconstruct do/config
        reconstructed = _reconstruct_config_from_metadata(returned_metadata)

        # Step 5: Verify all required import fields are present and correct
        for field in REQUIRED_IMPORT_FIELDS:
            assert field in returned_metadata, (
                f"Required import field '{field}' missing from stored metadata"
            )

        assert reconstructed["DEPLOYMENT_CONFIG"] == "gpu-vllm"
        assert reconstructed["ARCHITECTURE"] == "transformers"
        assert reconstructed["BACKEND"] == "vllm"
        assert reconstructed["INSTANCE_TYPE"] == "ml.g5.2xlarge"
        assert reconstructed["MODEL_NAME"] == "meta-llama/Llama-3.1-8B-Instruct"
        assert reconstructed["BASE_IMAGE"] == (
            "763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.29.0-lmi11.0.0-cu124"
        )
        assert reconstructed["MODEL_FORMAT"] == "safetensors"
        assert reconstructed["PROJECT_NAME"] == "my-llm-project"

    def test_roundtrip_metadata_keys_within_128_char_limit(self):
        """All metadata keys are within the 128-character NFR-1 limit."""
        args = _make_register_args()
        metadata = _build_metadata(args)

        for key in metadata:
            assert len(key) <= 128, (
                f"Metadata key '{key}' exceeds 128-char limit ({len(key)} chars)"
            )

    def test_roundtrip_metadata_values_within_256_char_limit(self):
        """All metadata values are within the 256-character NFR-1 limit."""
        args = _make_register_args()
        metadata = _build_metadata(args)

        for key, value in metadata.items():
            assert len(value) <= 256, (
                f"Metadata value for '{key}' exceeds 256-char limit ({len(value)} chars)"
            )

    def test_roundtrip_all_values_are_strings(self):
        """All metadata values are strings per NFR-1 (string-only constraint)."""
        args = _make_register_args()
        metadata = _build_metadata(args)

        for key, value in metadata.items():
            assert isinstance(value, str), (
                f"Metadata value for '{key}' is {type(value).__name__}, expected str"
            )

    def test_roundtrip_total_entries_within_50_limit(self):
        """Total metadata entries stay within the 50-entry NFR-1 limit."""
        # Worst case: model with benchmark results
        bench_results = {f"metric_{i}": f"value_{i}" for i in range(20)}
        args = _make_register_args(benchmark_results=json.dumps(bench_results))
        metadata = _build_metadata(args)

        assert len(metadata) <= 50, (
            f"Metadata has {len(metadata)} entries, exceeds 50-entry limit"
        )

    def test_roundtrip_with_long_model_name_truncation(self):
        """Long model names are truncated but still identifiable after round-trip."""
        long_model = "organization/" + "x" * 300
        args = _make_register_args(model_name=long_model)
        metadata = _build_metadata(args)

        # Value should be truncated
        assert len(metadata["modelName"]) == 256
        assert metadata["modelName"].endswith("…")

        # Round-trip: reconstructed value is the truncated version
        reconstructed = _reconstruct_config_from_metadata(metadata)
        assert reconstructed["MODEL_NAME"] == metadata["modelName"]
        # It starts with the original prefix
        assert reconstructed["MODEL_NAME"].startswith("organization/")

    def test_roundtrip_empty_optional_fields_stored_as_empty_strings(self):
        """Optional fields with no value are stored as empty strings, not omitted."""
        args = _make_register_args(
            model_format="",
            generator_version="",
        )
        metadata = _build_metadata(args)

        # Empty fields are present as empty strings
        assert "modelFormat" in metadata
        assert metadata["modelFormat"] == ""
        assert "generatorVersion" in metadata
        assert metadata["generatorVersion"] == ""

    def test_roundtrip_generator_version_informational(self):
        """generatorVersion is stored but not mapped to a do/config variable."""
        args = _make_register_args()
        metadata = _build_metadata(args)

        # generatorVersion IS in the metadata
        assert "generatorVersion" in metadata
        assert metadata["generatorVersion"] == "0.15.0"

        # But it's NOT in the reconstructed config (informational only)
        reconstructed = _reconstruct_config_from_metadata(metadata)
        assert "GENERATOR_VERSION" not in reconstructed

    def test_roundtrip_adapter_metadata_includes_base_fields(self):
        """Adapter registration also includes all required import fields."""
        adapter_args = Namespace(
            project_name="my-llm-project",
            deployment_config="gpu-vllm",
            architecture="transformers",
            backend="vllm",
            instance_type="ml.g5.2xlarge",
            model_name="meta-llama/Llama-3.1-8B-Instruct",
            base_image="763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:latest",
            model_format="safetensors",
            generator_version="0.15.0",
            parent_version_arn="arn:aws:sagemaker:us-west-2:123:model-package/my-llm-project/1",
            tune_technique="sft",
            dataset_s3_uri="s3://bucket/datasets/train/",
        )
        metadata = _register_helper._build_adapter_metadata(adapter_args)

        # All base import fields must be present
        for field in REQUIRED_IMPORT_FIELDS:
            assert field in metadata, (
                f"Required import field '{field}' missing from adapter metadata"
            )

        # Plus adapter-specific fields
        assert metadata["isAdapter"] == "true"
        assert metadata["parentModelVersionArn"].startswith("arn:aws:sagemaker:")
        assert metadata["tuneTechnique"] == "sft"
