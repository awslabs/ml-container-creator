"""Unit tests for .register_helper.py Model Package Group helper.

Tests cover:
- Metadata truncation (AC-1.8)
- Metadata building with all required fields (AC-1.3, AC-6.1)
- Version extraction from ARN
- Error handling and JSON output contract
- CLI argument parsing
- Dataset registration (AC-2b.1, AC-2b.2)
- Evaluator registration (AC-2c.1, AC-2c.2)

Requirements validated: US-1, US-2b, US-2c
"""

import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch, ANY
from argparse import Namespace

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

_truncate_metadata = _register_helper._truncate_metadata
_build_metadata = _register_helper._build_metadata
_build_adapter_metadata = _register_helper._build_adapter_metadata
_extract_version_from_arn = _register_helper._extract_version_from_arn
_parse_s3_uri = _register_helper._parse_s3_uri
_is_s3_prefix = _register_helper._is_s3_prefix
_compute_content_hash = _register_helper._compute_content_hash
_increment_version = _register_helper._increment_version
MAX_METADATA_VALUE_LEN = _register_helper.MAX_METADATA_VALUE_LEN


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Metadata Truncation (AC-1.8)
# ═══════════════════════════════════════════════════════════════════════════════


class TestMetadataTruncation:
    """Test _truncate_metadata enforces 256-char limit with '…' suffix.

    Validates: Requirements AC-1.8
    """

    def test_short_values_unchanged(self):
        """Values within 256 chars are not modified."""
        props = {"key1": "short value", "key2": "another"}
        result = _truncate_metadata(props)
        assert result == {"key1": "short value", "key2": "another"}

    def test_exactly_256_chars_unchanged(self):
        """Values exactly 256 chars are not truncated."""
        val = "x" * 256
        result = _truncate_metadata({"key": val})
        assert result["key"] == val
        assert len(result["key"]) == 256

    def test_over_256_chars_truncated(self):
        """Values over 256 chars are truncated with '…' suffix."""
        val = "a" * 300
        result = _truncate_metadata({"key": val})
        assert len(result["key"]) == 256
        assert result["key"].endswith("…")
        assert result["key"] == "a" * 255 + "…"

    def test_truncation_preserves_other_keys(self):
        """Truncation of one key doesn't affect others."""
        props = {
            "short": "hello",
            "long": "b" * 500,
            "medium": "c" * 100,
        }
        result = _truncate_metadata(props)
        assert result["short"] == "hello"
        assert len(result["long"]) == 256
        assert result["long"].endswith("…")
        assert result["medium"] == "c" * 100

    def test_none_values_converted_to_empty_string(self):
        """None values become empty strings."""
        result = _truncate_metadata({"key": None})
        assert result["key"] == ""

    def test_numeric_values_converted_to_string(self):
        """Non-string values are converted to strings."""
        result = _truncate_metadata({"num": 42, "flag": True})
        assert result["num"] == "42"
        assert result["flag"] == "True"

    def test_truncation_warns_to_stderr(self, capsys):
        """Truncation logs a warning to stderr."""
        val = "x" * 300
        _truncate_metadata({"longKey": val})
        captured = capsys.readouterr()
        assert "longKey" in captured.err
        assert "truncated" in captured.err
        assert "300" in captured.err

    def test_empty_dict(self):
        """Empty input returns empty dict."""
        result = _truncate_metadata({})
        assert result == {}


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Metadata Building (AC-1.3, AC-6.1)
# ═══════════════════════════════════════════════════════════════════════════════


class TestBuildMetadata:
    """Test _build_metadata creates correct metadata dict.

    Validates: Requirements AC-1.3, AC-6.1
    """

    def _make_args(self, **kwargs):
        """Create a Namespace with all required register-model args."""
        defaults = {
            "project_name": "test-project",
            "deployment_config": "gpu-vllm",
            "architecture": "transformers",
            "backend": "vllm",
            "instance_type": "ml.g5.2xlarge",
            "model_name": "meta-llama/Llama-3.1-8B-Instruct",
            "base_image": "763104351884.dkr.ecr.us-east-1.amazonaws.com/image:tag",
            "model_format": "safetensors",
            "generator_version": "0.15.0",
            "benchmark_results": None,
        }
        defaults.update(kwargs)
        return Namespace(**defaults)

    def test_all_required_fields_present(self):
        """All AC-6.1 fields are present in metadata."""
        args = self._make_args()
        result = _build_metadata(args)

        required_fields = [
            "deploymentConfig", "architecture", "backend",
            "instanceType", "modelName", "baseImage",
            "modelFormat", "generatorVersion", "projectName",
        ]
        for field in required_fields:
            assert field in result, f"Missing required field: {field}"

    def test_metadata_values_are_strings(self):
        """All metadata values must be strings (NFR-1)."""
        args = self._make_args()
        result = _build_metadata(args)
        for key, val in result.items():
            assert isinstance(val, str), f"Value for '{key}' should be string, got {type(val)}"

    def test_metadata_field_values_correct(self):
        """Metadata field values match input args."""
        args = self._make_args()
        result = _build_metadata(args)
        assert result["deploymentConfig"] == "gpu-vllm"
        assert result["architecture"] == "transformers"
        assert result["backend"] == "vllm"
        assert result["instanceType"] == "ml.g5.2xlarge"
        assert result["modelName"] == "meta-llama/Llama-3.1-8B-Instruct"
        assert result["modelFormat"] == "safetensors"
        assert result["generatorVersion"] == "0.15.0"
        assert result["projectName"] == "test-project"

    def test_benchmark_results_included(self):
        """Benchmark results are added as metadata with benchmark_ prefix."""
        bench_json = json.dumps({"latency_p50": "23ms", "throughput": "100rps"})
        args = self._make_args(benchmark_results=bench_json)
        result = _build_metadata(args)
        assert result.get("benchmark_latency_p50") == "23ms"
        assert result.get("benchmark_throughput") == "100rps"

    def test_invalid_benchmark_results_skipped(self):
        """Invalid benchmark JSON doesn't cause failure."""
        args = self._make_args(benchmark_results="not-json")
        result = _build_metadata(args)
        # Should still have all standard fields
        assert "deploymentConfig" in result
        # No benchmark_ keys
        assert not any(k.startswith("benchmark_") for k in result)

    def test_empty_args_produce_empty_strings(self):
        """Missing/empty args produce empty string values (not None)."""
        args = self._make_args(
            model_name="",
            base_image="",
            model_format="",
        )
        result = _build_metadata(args)
        assert result["modelName"] == ""
        assert result["baseImage"] == ""
        assert result["modelFormat"] == ""

    def test_long_base_image_truncated(self):
        """A long base image value is truncated (AC-1.8)."""
        long_image = "x" * 300
        args = self._make_args(base_image=long_image)
        result = _build_metadata(args)
        assert len(result["baseImage"]) == 256
        assert result["baseImage"].endswith("…")


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Version Extraction from ARN
# ═══════════════════════════════════════════════════════════════════════════════


class TestExtractVersionFromArn:
    """Test _extract_version_from_arn parses model package ARNs."""

    def test_valid_arn(self):
        """Extracts version number from a standard model package ARN."""
        arn = "arn:aws:sagemaker:us-west-2:123456789012:model-package/my-project/3"
        assert _extract_version_from_arn(arn) == 3

    def test_version_one(self):
        """Extracts version 1."""
        arn = "arn:aws:sagemaker:us-east-1:111222333444:model-package/test/1"
        assert _extract_version_from_arn(arn) == 1

    def test_invalid_arn_no_version(self):
        """Returns 0 for ARN without numeric version."""
        arn = "arn:aws:sagemaker:us-west-2:123456789012:model-package/my-project"
        assert _extract_version_from_arn(arn) == 0

    def test_invalid_arn_non_numeric(self):
        """Returns 0 for ARN with non-numeric version."""
        arn = "arn:aws:sagemaker:us-west-2:123:model-package/proj/abc"
        assert _extract_version_from_arn(arn) == 0

    def test_empty_string(self):
        """Returns 0 for empty string."""
        assert _extract_version_from_arn("") == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Error Handling and JSON Output
# ═══════════════════════════════════════════════════════════════════════════════


class TestErrorHandling:
    """Test error handling follows the JSON stdout contract."""

    def test_error_exit_outputs_json(self, capsys):
        """_error_exit prints JSON error to stdout and message to stderr."""
        with pytest.raises(SystemExit) as exc_info:
            _register_helper._error_exit("test error", code="TEST_CODE")

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        # JSON on stdout
        output = json.loads(captured.out)
        assert output["error"] == "test error"
        assert output["code"] == "TEST_CODE"
        # Message on stderr
        assert "test error" in captured.err

    def test_output_prints_json_and_exits_0(self, capsys):
        """_output prints JSON to stdout and exits with code 0."""
        with pytest.raises(SystemExit) as exc_info:
            _register_helper._output({"mpg_arn": "test-arn", "version": 1})

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert output["mpg_arn"] == "test-arn"
        assert output["version"] == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 5. CLI Argument Parsing
# ═══════════════════════════════════════════════════════════════════════════════


class TestCLIParsing:
    """Test CLI argument parsing for subcommands."""

    def test_no_command_exits(self):
        """No subcommand shows help and exits."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog"]):
                _register_helper.main()

    def test_create_mpg_requires_project_name(self):
        """create-mpg requires --project-name."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "create-mpg"]):
                _register_helper.main()

    def test_register_model_requires_project_name(self):
        """register-model requires --project-name."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "register-model"]):
                _register_helper.main()


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Adapter Metadata Building (AC-2.2)
# ═══════════════════════════════════════════════════════════════════════════════


class TestBuildAdapterMetadata:
    """Test _build_adapter_metadata creates correct adapter metadata dict.

    Validates: Requirements AC-2.2
    """

    def _make_adapter_args(self, **kwargs):
        """Create a Namespace with all required register-adapter args."""
        defaults = {
            "project_name": "test-project",
            "parent_version_arn": "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1",
            "tune_technique": "sft",
            "dataset_s3_uri": "s3://bucket/datasets/train/",
            "deployment_config": "gpu-vllm",
            "architecture": "transformers",
            "backend": "vllm",
            "instance_type": "ml.g5.2xlarge",
            "model_name": "meta-llama/Llama-3.1-8B-Instruct",
            "base_image": "763104351884.dkr.ecr.us-east-1.amazonaws.com/image:tag",
            "model_format": "safetensors",
            "generator_version": "0.15.0",
        }
        defaults.update(kwargs)
        return Namespace(**defaults)

    def test_adapter_metadata_has_is_adapter_true(self):
        """Adapter metadata includes isAdapter=true (AC-2.2)."""
        args = self._make_adapter_args()
        result = _build_adapter_metadata(args)
        assert result["isAdapter"] == "true"

    def test_adapter_metadata_has_parent_version_arn(self):
        """Adapter metadata includes parentModelVersionArn (AC-2.2)."""
        args = self._make_adapter_args()
        result = _build_adapter_metadata(args)
        assert result["parentModelVersionArn"] == "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1"

    def test_adapter_metadata_has_tune_technique(self):
        """Adapter metadata includes tuneTechnique (AC-2.2)."""
        args = self._make_adapter_args(tune_technique="dpo")
        result = _build_adapter_metadata(args)
        assert result["tuneTechnique"] == "dpo"

    def test_adapter_metadata_has_dataset_s3_uri(self):
        """Adapter metadata includes datasetS3Uri (AC-2.2)."""
        args = self._make_adapter_args(dataset_s3_uri="s3://my-bucket/data/train/")
        result = _build_adapter_metadata(args)
        assert result["datasetS3Uri"] == "s3://my-bucket/data/train/"

    def test_adapter_metadata_includes_standard_fields(self):
        """Adapter metadata includes all standard model fields too."""
        args = self._make_adapter_args()
        result = _build_adapter_metadata(args)

        standard_fields = [
            "deploymentConfig", "architecture", "backend",
            "instanceType", "modelName", "baseImage",
            "modelFormat", "generatorVersion", "projectName",
        ]
        for field in standard_fields:
            assert field in result, f"Missing standard field: {field}"

    def test_adapter_metadata_all_values_are_strings(self):
        """All adapter metadata values must be strings (NFR-1)."""
        args = self._make_adapter_args()
        result = _build_adapter_metadata(args)
        for key, val in result.items():
            assert isinstance(val, str), f"Value for '{key}' should be string, got {type(val)}"

    def test_adapter_metadata_empty_optional_fields(self):
        """Empty optional fields become empty strings."""
        args = self._make_adapter_args(
            tune_technique="",
            dataset_s3_uri="",
        )
        result = _build_adapter_metadata(args)
        assert result["tuneTechnique"] == ""
        assert result["datasetS3Uri"] == ""
        # isAdapter should always be "true"
        assert result["isAdapter"] == "true"

    def test_adapter_metadata_truncates_long_values(self):
        """Long values in adapter metadata are truncated (AC-1.8)."""
        long_arn = "arn:aws:sagemaker:us-west-2:123456789012:model-package/" + "x" * 300
        args = self._make_adapter_args(parent_version_arn=long_arn)
        result = _build_adapter_metadata(args)
        assert len(result["parentModelVersionArn"]) == 256
        assert result["parentModelVersionArn"].endswith("…")

    def test_adapter_metadata_rlvr_technique(self):
        """Adapter metadata supports rlvr tune technique."""
        args = self._make_adapter_args(tune_technique="rlvr")
        result = _build_adapter_metadata(args)
        assert result["tuneTechnique"] == "rlvr"


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Register-Adapter CLI Parsing
# ═══════════════════════════════════════════════════════════════════════════════


class TestRegisterAdapterCLI:
    """Test CLI argument parsing for the register-adapter subcommand."""

    def test_register_adapter_requires_project_name(self):
        """register-adapter requires --project-name."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "register-adapter", "--parent-version-arn", "arn:test"]):
                _register_helper.main()

    def test_register_adapter_requires_parent_version_arn(self):
        """register-adapter requires --parent-version-arn."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "register-adapter", "--project-name", "test"]):
                _register_helper.main()

    def test_register_adapter_dispatches_correctly(self):
        """register-adapter subcommand dispatches to cmd_register_adapter."""
        with patch("sys.argv", [
            "prog", "register-adapter",
            "--project-name", "my-project",
            "--parent-version-arn", "arn:aws:sagemaker:us-west-2:123:model-package/my-project/1",
            "--tune-technique", "sft",
            "--dataset-s3-uri", "s3://bucket/data/",
        ]):
            # Mock the sagemaker imports and cmd function to avoid actual API calls
            with patch.object(_register_helper, "cmd_register_adapter") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.project_name == "my-project"
                assert call_args.parent_version_arn == "arn:aws:sagemaker:us-west-2:123:model-package/my-project/1"
                assert call_args.tune_technique == "sft"
                assert call_args.dataset_s3_uri == "s3://bucket/data/"

    def test_register_adapter_optional_args_default(self):
        """register-adapter optional args default to empty strings."""
        with patch("sys.argv", [
            "prog", "register-adapter",
            "--project-name", "my-project",
            "--parent-version-arn", "arn:test",
        ]):
            with patch.object(_register_helper, "cmd_register_adapter") as mock_cmd:
                _register_helper.main()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.tune_technique == ""
                assert call_args.dataset_s3_uri == ""
                assert call_args.deployment_config == ""
                assert call_args.container_image == ""


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Register-Adapter Command Logic
# ═══════════════════════════════════════════════════════════════════════════════


class TestCmdRegisterAdapter:
    """Test cmd_register_adapter function logic.

    Validates: Requirements AC-2.1, AC-2.2
    """

    def _make_adapter_args(self, **kwargs):
        """Create a Namespace with all required register-adapter args."""
        defaults = {
            "project_name": "test-project",
            "parent_version_arn": "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1",
            "tune_technique": "sft",
            "dataset_s3_uri": "s3://bucket/datasets/train/",
            "deployment_config": "gpu-vllm",
            "container_image": "image:latest",
            "model_data_url": "s3://bucket/adapter/model.tar.gz",
            "instance_type": "ml.g5.2xlarge",
            "architecture": "transformers",
            "backend": "vllm",
            "model_name": "meta-llama/Llama-3.1-8B-Instruct",
            "base_image": "image:tag",
            "model_format": "safetensors",
            "generator_version": "0.15.0",
            "region": "us-west-2",
            "role_arn": "arn:aws:iam::123456789012:role/SageMakerRole",
        }
        defaults.update(kwargs)
        return Namespace(**defaults)

    @patch("os.environ", {"AWS_DEFAULT_REGION": "us-west-2", "AWS_REGION": "us-west-2"})
    def test_register_adapter_creates_model_package_with_adapter_metadata(self):
        """cmd_register_adapter calls create_model_package with adapter metadata."""
        args = self._make_adapter_args()

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = "arn:aws:sagemaker:us-west-2:123:model-package-group/test-project"

        mock_sm_client = MagicMock()
        mock_sm_client.create_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        }

        with patch.dict("sys.modules", {
            "sagemaker": MagicMock(),
            "sagemaker.core": MagicMock(),
            "sagemaker.core.resources": MagicMock(),
        }):
            with patch("register_model._check_sagemaker_core"):
                mock_resources = MagicMock()
                mock_resources.ModelPackageGroup.create.return_value = mock_mpg
                mock_resources.ModelPackage.get_all.return_value = []

                with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                    with patch("boto3.client", return_value=mock_sm_client):
                        with pytest.raises(SystemExit) as exc_info:
                            _register_helper.cmd_register_adapter(args)

                        assert exc_info.value.code == 0

                        # Verify create_model_package was called with adapter metadata
                        create_call = mock_sm_client.create_model_package.call_args
                        metadata = create_call[1]["CustomerMetadataProperties"]
                        assert metadata["isAdapter"] == "true"
                        assert metadata["parentModelVersionArn"] == args.parent_version_arn
                        assert metadata["tuneTechnique"] == "sft"
                        assert metadata["datasetS3Uri"] == "s3://bucket/datasets/train/"

    @patch("os.environ", {"AWS_DEFAULT_REGION": "us-west-2", "AWS_REGION": "us-west-2"})
    def test_register_adapter_json_output_includes_parent_arn(self, capsys):
        """cmd_register_adapter JSON output includes parent_version_arn field."""
        args = self._make_adapter_args()

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = "arn:aws:sagemaker:us-west-2:123:model-package-group/test-project"

        mock_sm_client = MagicMock()
        mock_sm_client.create_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        }

        with patch.dict("sys.modules", {
            "sagemaker": MagicMock(),
            "sagemaker.core": MagicMock(),
            "sagemaker.core.resources": MagicMock(),
        }):
            with patch("register_model._check_sagemaker_core"):
                mock_resources = MagicMock()
                mock_resources.ModelPackageGroup.create.return_value = mock_mpg
                mock_resources.ModelPackage.get_all.return_value = []

                with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                    with patch("boto3.client", return_value=mock_sm_client):
                        with pytest.raises(SystemExit) as exc_info:
                            _register_helper.cmd_register_adapter(args)

                        assert exc_info.value.code == 0

                        captured = capsys.readouterr()
                        output = json.loads(captured.out)
                        assert "mpg_arn" in output
                        assert "model_package_arn" in output
                        assert "version" in output
                        assert output["parent_version_arn"] == args.parent_version_arn
                        assert output["version"] == 2

    def test_register_adapter_requires_project_name_at_runtime(self, capsys):
        """cmd_register_adapter exits with error if project_name is empty."""
        args = self._make_adapter_args(project_name="")
        mock_sagemaker = MagicMock()

        with patch("register_model._check_sagemaker_core"), \
             patch.dict(sys.modules, {
                 "sagemaker": mock_sagemaker,
                 "sagemaker.core": mock_sagemaker,
                 "sagemaker.core.resources": mock_sagemaker,
             }):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_register_adapter(args)

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["code"] == "MISSING_ARGUMENT"

    def test_register_adapter_requires_parent_version_arn_at_runtime(self, capsys):
        """cmd_register_adapter exits with error if parent_version_arn is empty."""
        args = self._make_adapter_args(parent_version_arn="")
        mock_sagemaker = MagicMock()

        with patch("register_model._check_sagemaker_core"), \
             patch.dict(sys.modules, {
                 "sagemaker": mock_sagemaker,
                 "sagemaker.core": mock_sagemaker,
                 "sagemaker.core.resources": mock_sagemaker,
             }):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_register_adapter(args)

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["code"] == "MISSING_ARGUMENT"
# ═══════════════════════════════════════════════════════════════════════════════
# 10. Evaluator Registration (AC-2c.1, AC-2c.2)
# ═══════════════════════════════════════════════════════════════════════════════


class TestRegisterEvaluator:
    """Test register-evaluator subcommand.

    Validates: Requirements AC-2c.1, AC-2c.2
    """

    def _make_evaluator_args(self, **kwargs):
        """Create a Namespace with all required register-evaluator args."""
        defaults = {
            "command": "register-evaluator",
            "name": "math-reward-fn",
            "eval_type": "lambda",
            "arn_or_uri": "arn:aws:lambda:us-west-2:123456789012:function:math-reward",
            "technique": "rlvr",
            "description": "Mathematical correctness evaluator",
            "project_name": "test-project",
        }
        defaults.update(kwargs)
        return Namespace(**defaults)

    def test_register_evaluator_outputs_json(self, capsys, tmp_path):
        """register-evaluator outputs valid JSON with required fields."""
        args = self._make_evaluator_args()

        with patch("register_common._EVALUATORS_REGISTRY", str(tmp_path / "evaluators.json")):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_register_evaluator(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["name"] == "math-reward-fn"
                assert output["type"] == "lambda"
                assert output["arn_or_uri"] == "arn:aws:lambda:us-west-2:123456789012:function:math-reward"
                assert output["technique"] == "rlvr"
                assert output["registered"] is True

    def test_register_evaluator_creates_registry_file(self, tmp_path):
        """register-evaluator creates the registry JSON file."""
        args = self._make_evaluator_args()
        registry_file = str(tmp_path / "evaluators.json")

        with patch("register_common._EVALUATORS_REGISTRY", registry_file):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit):
                    _register_helper.cmd_register_evaluator(args)

        assert os.path.exists(registry_file)
        with open(registry_file) as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["name"] == "math-reward-fn"
        assert data[0]["type"] == "lambda"
        assert data[0]["arn_or_uri"] == "arn:aws:lambda:us-west-2:123456789012:function:math-reward"
        assert data[0]["technique"] == "rlvr"
        assert data[0]["description"] == "Mathematical correctness evaluator"

    def test_register_evaluator_rlaif_preference_model(self, capsys, tmp_path):
        """register-evaluator supports RLAIF preference model type."""
        args = self._make_evaluator_args(
            name="pref-judge",
            eval_type="model",
            arn_or_uri="s3://bucket/models/preference-judge/",
            technique="rlaif",
            description="Preference model for DPO",
        )

        with patch("register_common._EVALUATORS_REGISTRY", str(tmp_path / "evaluators.json")):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_register_evaluator(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["type"] == "model"
                assert output["technique"] == "rlaif"
                assert output["arn_or_uri"] == "s3://bucket/models/preference-judge/"

    def test_register_evaluator_upserts_existing(self, tmp_path):
        """register-evaluator updates existing entry with same name."""
        registry_file = str(tmp_path / "evaluators.json")

        existing = [{"name": "math-reward-fn", "type": "lambda",
                     "arn_or_uri": "arn:old", "technique": "rlvr"}]
        with open(registry_file, "w") as f:
            json.dump(existing, f)

        args = self._make_evaluator_args()
        with patch("register_common._EVALUATORS_REGISTRY", registry_file):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit):
                    _register_helper.cmd_register_evaluator(args)

        with open(registry_file) as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["arn_or_uri"] == "arn:aws:lambda:us-west-2:123456789012:function:math-reward"

    def test_register_evaluator_requires_name(self, capsys, tmp_path):
        """register-evaluator errors if name is empty."""
        args = self._make_evaluator_args(name="")
        with patch("register_common._EVALUATORS_REGISTRY", str(tmp_path / "evaluators.json")):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_register_evaluator(args)
                assert exc_info.value.code == 1
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["code"] == "MISSING_ARGUMENT"

    def test_register_evaluator_requires_arn_or_uri(self, capsys, tmp_path):
        """register-evaluator errors if arn-or-uri is empty."""
        args = self._make_evaluator_args(arn_or_uri="")
        with patch("register_common._EVALUATORS_REGISTRY", str(tmp_path / "evaluators.json")):
            with patch("register_common._REGISTRY_DIR", str(tmp_path)):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_register_evaluator(args)
                assert exc_info.value.code == 1
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["code"] == "MISSING_ARGUMENT"
# ═══════════════════════════════════════════════════════════════════════════════
# 12. Resolve Evaluator (AC-2c.3, AC-2c.4)
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveEvaluator:
    """Test resolve-evaluator subcommand.

    Validates: Requirements AC-2c.3, AC-2c.4
    """

    def test_resolve_evaluator_found(self, capsys, tmp_path):
        """resolve-evaluator returns entry when name matches."""
        registry_file = str(tmp_path / "evaluators.json")
        entries = [
            {"name": "math-fn", "type": "lambda",
             "arn_or_uri": "arn:aws:lambda:us-west-2:123:function:math",
             "technique": "rlvr"},
        ]
        with open(registry_file, "w") as f:
            json.dump(entries, f)

        args = Namespace(name="math-fn", command="resolve-evaluator")
        with patch("register_common._EVALUATORS_REGISTRY", registry_file):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_resolve_evaluator(args)

            assert exc_info.value.code == 0
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["name"] == "math-fn"
            assert output["type"] == "lambda"
            assert output["arn_or_uri"] == "arn:aws:lambda:us-west-2:123:function:math"

    def test_resolve_evaluator_not_found(self, capsys, tmp_path):
        """resolve-evaluator returns error when name not found."""
        registry_file = str(tmp_path / "evaluators.json")
        with open(registry_file, "w") as f:
            json.dump([], f)

        args = Namespace(name="nonexistent", command="resolve-evaluator")
        with patch("register_common._EVALUATORS_REGISTRY", registry_file):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_resolve_evaluator(args)

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["code"] == "EVALUATOR_NOT_FOUND"


# ═══════════════════════════════════════════════════════════════════════════════
# 13. CLI Parsing for Dataset/Evaluator Subcommands
# ═══════════════════════════════════════════════════════════════════════════════


class TestDatasetEvaluatorCLIParsing:
    """Test CLI argument parsing for register-dataset and register-evaluator."""

    def test_register_dataset_cli_parses_all_args(self):
        """register-dataset parses all CLI arguments correctly."""
        with patch("sys.argv", [
            "prog", "register-dataset",
            "--name", "my-ds",
            "--s3-uri", "s3://bucket/data.jsonl",
            "--format", "parquet",
            "--technique", "dpo",
            "--row-count", "10000",
            "--column-schema", '{"col1": "string"}',
            "--project-name", "proj",
        ]):
            with patch.object(_register_helper, "cmd_register_dataset") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.name == "my-ds"
                assert call_args.s3_uri == "s3://bucket/data.jsonl"
                assert getattr(call_args, "format") == "parquet"
                assert call_args.technique == "dpo"
                assert call_args.row_count == 10000
                assert call_args.column_schema == '{"col1": "string"}'
                assert call_args.project_name == "proj"

    def test_register_evaluator_cli_parses_all_args(self):
        """register-evaluator parses all CLI arguments correctly."""
        with patch("sys.argv", [
            "prog", "register-evaluator",
            "--name", "my-eval",
            "--type", "lambda",
            "--arn-or-uri", "arn:aws:lambda:us-west-2:123:function:fn",
            "--technique", "rlvr",
            "--description", "Test evaluator",
            "--project-name", "proj",
        ]):
            with patch.object(_register_helper, "cmd_register_evaluator") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.name == "my-eval"
                assert call_args.eval_type == "lambda"
                assert call_args.arn_or_uri == "arn:aws:lambda:us-west-2:123:function:fn"
                assert call_args.technique == "rlvr"
                assert call_args.description == "Test evaluator"
                assert call_args.project_name == "proj"

    def test_register_dataset_requires_name_flag(self):
        """register-dataset requires --name flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "register-dataset", "--s3-uri", "s3://x"]):
                _register_helper.main()

    def test_register_dataset_requires_s3_uri_flag(self):
        """register-dataset requires --s3-uri flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", ["prog", "register-dataset", "--name", "x"]):
                _register_helper.main()

    def test_register_evaluator_requires_name_flag(self):
        """register-evaluator requires --name flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", [
                "prog", "register-evaluator",
                "--type", "lambda",
                "--arn-or-uri", "arn:x",
                "--technique", "rlvr",
            ]):
                _register_helper.main()

    def test_register_evaluator_requires_type_flag(self):
        """register-evaluator requires --type flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", [
                "prog", "register-evaluator",
                "--name", "x",
                "--arn-or-uri", "arn:x",
                "--technique", "rlvr",
            ]):
                _register_helper.main()

    def test_register_evaluator_requires_arn_or_uri_flag(self):
        """register-evaluator requires --arn-or-uri flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", [
                "prog", "register-evaluator",
                "--name", "x",
                "--type", "lambda",
                "--technique", "rlvr",
            ]):
                _register_helper.main()

    def test_register_evaluator_requires_technique_flag(self):
        """register-evaluator requires --technique flag."""
        with pytest.raises(SystemExit):
            with patch("sys.argv", [
                "prog", "register-evaluator",
                "--name", "x",
                "--type", "lambda",
                "--arn-or-uri", "arn:x",
            ]):
                _register_helper.main()

    def test_resolve_dataset_cli(self):
        """resolve-dataset parses --name arg."""
        with patch("sys.argv", ["prog", "resolve-dataset", "--name", "test-ds"]):
            with patch.object(_register_helper, "cmd_resolve_dataset") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.name == "test-ds"

    def test_resolve_evaluator_cli(self):
        """resolve-evaluator parses --name arg."""
        with patch("sys.argv", ["prog", "resolve-evaluator", "--name", "test-ev"]):
            with patch.object(_register_helper, "cmd_resolve_evaluator") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.name == "test-ev"


# ═══════════════════════════════════════════════════════════════════════════════
# 12. List Adapters (AC-4.1, AC-4.2)
# ═══════════════════════════════════════════════════════════════════════════════


class TestListAdapters:
    """Test list-adapters subcommand.

    Validates: Requirements AC-4.1, AC-4.2
    """

    def test_list_adapters_returns_empty_on_missing_mpg(self, capsys):
        """list-adapters returns empty list when MPG doesn't exist."""
        args = Namespace(
            command="list-adapters",
            project_name="nonexistent-project",
            region="us-west-2",
        )

        # Mock sagemaker-core to raise "does not exist"
        with patch("register_list._check_sagemaker_core"):
            mock_resources = MagicMock()
            mock_resources.ModelPackage.get_all.side_effect = Exception(
                "Model Package Group 'nonexistent-project' does not exist"
            )
            with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_list_adapters(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["adapters"] == []

    def test_list_adapters_filters_by_is_adapter(self, capsys):
        """list-adapters only returns versions where isAdapter=true."""
        args = Namespace(
            command="list-adapters",
            project_name="test-project",
            region="us-west-2",
        )

        # Create mock model packages - one adapter, one base model
        mock_adapter = MagicMock()
        mock_adapter.model_package_arn = "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        mock_adapter.customer_metadata_properties = {
            "isAdapter": "true",
            "tuneTechnique": "sft",
            "datasetS3Uri": "s3://bucket/data/",
            "parentModelVersionArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/1",
        }
        mock_adapter.model_package_description = "adapter (sft)"
        mock_adapter.inference_specification = {
            "Containers": [{"ModelDataUrl": "s3://bucket/adapter.tar.gz"}]
        }
        mock_adapter.creation_time = "2025-06-18T12:00:00Z"

        mock_base = MagicMock()
        mock_base.model_package_arn = "arn:aws:sagemaker:us-west-2:123:model-package/test-project/1"
        mock_base.customer_metadata_properties = {
            "isAdapter": "false",
            "deploymentConfig": "gpu-vllm",
        }
        mock_base.model_package_description = "base model"
        mock_base.inference_specification = None
        mock_base.creation_time = "2025-06-17T10:00:00Z"

        with patch("register_list._check_sagemaker_core"):
            mock_resources = MagicMock()
            mock_resources.ModelPackage.get_all.return_value = [mock_adapter, mock_base]
            with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_list_adapters(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert len(output["adapters"]) == 1
                adapter = output["adapters"][0]
                assert adapter["arn"] == "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
                assert adapter["version"] == 2
                assert adapter["tuneTechnique"] == "sft"
                assert adapter["parentModelVersionArn"] == "arn:aws:sagemaker:us-west-2:123:model-package/test-project/1"
                assert adapter["modelDataUrl"] == "s3://bucket/adapter.tar.gz"

    def test_list_adapters_requires_project_name(self, capsys):
        """list-adapters exits with error if project_name is empty."""
        args = Namespace(
            command="list-adapters",
            project_name="",
            region="us-west-2",
        )

        with patch("register_list._check_sagemaker_core"):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_list_adapters(args)

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["code"] == "MISSING_ARGUMENT"

    def test_list_adapters_cli_dispatch(self):
        """list-adapters CLI subcommand dispatches correctly."""
        with patch("sys.argv", ["prog", "list-adapters", "--project-name", "my-proj", "--region", "us-east-1"]):
            with patch.object(_register_helper, "cmd_list_adapters") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.project_name == "my-proj"
                assert call_args.region == "us-east-1"

    def test_list_adapters_handles_api_failure_gracefully(self, capsys):
        """list-adapters returns empty list on generic API failure (non-fatal)."""
        args = Namespace(
            command="list-adapters",
            project_name="test-project",
            region="us-west-2",
        )

        with patch("register_list._check_sagemaker_core"):
            mock_resources = MagicMock()
            mock_resources.ModelPackage.get_all.side_effect = Exception("Connection timeout")
            with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_list_adapters(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["adapters"] == []


# ═══════════════════════════════════════════════════════════════════════════════
# 13. Get Version (AC-4.3)
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetVersion:
    """Test get-version subcommand.

    Validates: Requirements AC-4.3
    """

    def test_get_version_returns_metadata(self, capsys):
        """get-version returns version details including modelDataUrl."""
        args = Namespace(
            command="get-version",
            arn="arn:aws:sagemaker:us-west-2:123:model-package/test-project/2",
            region="us-west-2",
        )

        mock_sm_client = MagicMock()
        mock_sm_client.describe_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2",
            "ModelApprovalStatus": "Approved",
            "ModelPackageDescription": "adapter (sft) on ml.g5.2xlarge",
            "InferenceSpecification": {
                "Containers": [{"ModelDataUrl": "s3://bucket/adapter.tar.gz", "Image": "img:latest"}]
            },
            "CustomerMetadataProperties": {
                "isAdapter": "true",
                "tuneTechnique": "sft",
                "parentModelVersionArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/1",
            },
        }

        with patch("register_resolve._check_sagemaker_core"):
            with patch("boto3.client", return_value=mock_sm_client):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_get_version(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["arn"] == "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
                assert output["version"] == 2
                assert output["status"] == "Approved"
                assert output["modelDataUrl"] == "s3://bucket/adapter.tar.gz"
                assert output["metadata"]["isAdapter"] == "true"
                assert output["metadata"]["tuneTechnique"] == "sft"

    def test_get_version_requires_arn(self, capsys):
        """get-version exits with error if ARN is empty."""
        args = Namespace(
            command="get-version",
            arn="",
            region="us-west-2",
        )

        with patch("register_resolve._check_sagemaker_core"):
            with pytest.raises(SystemExit) as exc_info:
                _register_helper.cmd_get_version(args)

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            output = json.loads(captured.out)
            assert output["code"] == "MISSING_ARGUMENT"

    def test_get_version_handles_not_found(self, capsys):
        """get-version exits with error when version ARN is not found."""
        args = Namespace(
            command="get-version",
            arn="arn:aws:sagemaker:us-west-2:123:model-package/test-project/99",
            region="us-west-2",
        )

        with patch("register_resolve._check_sagemaker_core"):
            mock_resources = MagicMock()
            mock_resources.ModelPackage.get.side_effect = Exception("Model package does not exist")
            with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_get_version(args)

                assert exc_info.value.code == 1
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["code"] == "GET_VERSION_FAILED"

    def test_get_version_cli_dispatch(self):
        """get-version CLI subcommand dispatches correctly."""
        with patch("sys.argv", [
            "prog", "get-version",
            "--arn", "arn:aws:sagemaker:us-west-2:123:model-package/proj/1",
            "--region", "us-west-2",
        ]):
            with patch.object(_register_helper, "cmd_get_version") as mock_cmd:
                _register_helper.main()
                mock_cmd.assert_called_once()
                call_args = mock_cmd.call_args[0][0]
                assert call_args.arn == "arn:aws:sagemaker:us-west-2:123:model-package/proj/1"
                assert call_args.region == "us-west-2"

    def test_get_version_no_model_data_url(self, capsys):
        """get-version handles case where no model data URL is present."""
        args = Namespace(
            command="get-version",
            arn="arn:aws:sagemaker:us-west-2:123:model-package/test-project/1",
            region="us-west-2",
        )

        mock_sm_client = MagicMock()
        mock_sm_client.describe_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/1",
            "ModelApprovalStatus": "Approved",
            "ModelPackageDescription": "base model",
            "InferenceSpecification": {"Containers": [{"Image": "img:latest"}]},
            "CustomerMetadataProperties": {"isAdapter": "false"},
        }

        with patch("register_resolve._check_sagemaker_core"):
            with patch("boto3.client", return_value=mock_sm_client):
                with pytest.raises(SystemExit) as exc_info:
                    _register_helper.cmd_get_version(args)

                assert exc_info.value.code == 0
                captured = capsys.readouterr()
                output = json.loads(captured.out)
                assert output["modelDataUrl"] == ""
                output = json.loads(captured.out)
                assert output["modelDataUrl"] == ""
# ═══════════════════════════════════════════════════════════════════════════════
# 16. Adapter Dedup Verification (Backlog #024)
# ═══════════════════════════════════════════════════════════════════════════════


class TestAdapterDedup:
    """Test adapter dedup verification before registration.

    Validates: Backlog #024 — prevents duplicate adapter versions when
    SFTTrainer auto-registers and do/register also calls register-adapter.
    """

    def _make_adapter_args(self, **kwargs):
        """Create a Namespace with all required register-adapter args."""
        defaults = {
            "project_name": "test-project",
            "parent_version_arn": "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1",
            "tune_technique": "sft",
            "dataset_s3_uri": "s3://bucket/datasets/train/",
            "deployment_config": "gpu-vllm",
            "container_image": "image:latest",
            "model_data_url": "s3://bucket/adapter/model.tar.gz",
            "instance_type": "ml.g5.2xlarge",
            "architecture": "transformers",
            "backend": "vllm",
            "model_name": "meta-llama/Llama-3.1-8B-Instruct",
            "base_image": "image:tag",
            "model_format": "safetensors",
            "generator_version": "0.15.0",
            "region": "us-west-2",
            "role_arn": "arn:aws:iam::123456789012:role/SageMakerRole",
        }
        defaults.update(kwargs)
        return Namespace(**defaults)

    @patch("os.environ", {"AWS_DEFAULT_REGION": "us-west-2", "AWS_REGION": "us-west-2"})
    def test_dedup_detects_existing_adapter_and_skips_creation(self, capsys):
        """When a matching adapter already exists, dedup outputs existing version."""
        args = self._make_adapter_args()

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = "arn:aws:sagemaker:us-west-2:123:model-package-group/test-project"

        # Existing adapter package that matches the metadata
        mock_existing_pkg = MagicMock()
        mock_existing_pkg.model_package_arn = "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        mock_existing_pkg.customer_metadata_properties = {
            "isAdapter": "true",
            "parentModelVersionArn": "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1",
            "tuneTechnique": "sft",
            "datasetS3Uri": "s3://bucket/datasets/train/",
        }

        with patch.dict("sys.modules", {
            "sagemaker": MagicMock(),
            "sagemaker.core": MagicMock(),
            "sagemaker.core.resources": MagicMock(),
        }):
            with patch("register_model._check_sagemaker_core"):
                mock_resources = MagicMock()
                mock_resources.ModelPackageGroup.create.return_value = mock_mpg
                # get_all returns the existing matching adapter
                mock_resources.ModelPackage.get_all.return_value = [mock_existing_pkg]

                with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                    with pytest.raises(SystemExit) as exc_info:
                        _register_helper.cmd_register_adapter(args)

                    assert exc_info.value.code == 0
                    captured = capsys.readouterr()
                    output = json.loads(captured.out)
                    assert output["deduplicated"] is True
                    assert output["version"] == 2
                    assert output["model_package_arn"] == "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
                    assert output["parent_version_arn"] == args.parent_version_arn

                    # Verify ModelPackage.create was NOT called (dedup skipped it)
                    mock_resources.ModelPackage.create.assert_not_called()

    @patch("os.environ", {"AWS_DEFAULT_REGION": "us-west-2", "AWS_REGION": "us-west-2"})
    def test_no_dedup_when_no_matching_adapter_exists(self, capsys):
        """When no matching adapter exists, registration proceeds normally."""
        args = self._make_adapter_args()

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = "arn:aws:sagemaker:us-west-2:123:model-package-group/test-project"

        # Existing package that does NOT match (different technique)
        mock_non_matching_pkg = MagicMock()
        mock_non_matching_pkg.model_package_arn = "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        mock_non_matching_pkg.customer_metadata_properties = {
            "isAdapter": "true",
            "parentModelVersionArn": "arn:aws:sagemaker:us-west-2:123456789012:model-package/test-project/1",
            "tuneTechnique": "dpo",  # Different technique!
            "datasetS3Uri": "s3://bucket/datasets/other/",
        }

        mock_sm_client = MagicMock()
        mock_sm_client.create_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/3"
        }

        with patch.dict("sys.modules", {
            "sagemaker": MagicMock(),
            "sagemaker.core": MagicMock(),
            "sagemaker.core.resources": MagicMock(),
        }):
            with patch("register_model._check_sagemaker_core"):
                mock_resources = MagicMock()
                mock_resources.ModelPackageGroup.create.return_value = mock_mpg
                mock_resources.ModelPackage.get_all.return_value = [mock_non_matching_pkg]

                with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                    with patch("boto3.client", return_value=mock_sm_client):
                        with pytest.raises(SystemExit) as exc_info:
                            _register_helper.cmd_register_adapter(args)

                        assert exc_info.value.code == 0
                        captured = capsys.readouterr()
                        output = json.loads(captured.out)
                        # Should NOT be deduplicated
                        assert "deduplicated" not in output
                        assert output["version"] == 3
                        # Verify create_model_package WAS called
                        mock_sm_client.create_model_package.assert_called_once()

    @patch("os.environ", {"AWS_DEFAULT_REGION": "us-west-2", "AWS_REGION": "us-west-2"})
    def test_dedup_check_failure_is_non_fatal(self, capsys):
        """When dedup check fails, registration proceeds normally (best-effort)."""
        args = self._make_adapter_args()

        mock_mpg = MagicMock()
        mock_mpg.model_package_group_arn = "arn:aws:sagemaker:us-west-2:123:model-package-group/test-project"

        mock_sm_client = MagicMock()
        mock_sm_client.create_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-west-2:123:model-package/test-project/2"
        }

        with patch.dict("sys.modules", {
            "sagemaker": MagicMock(),
            "sagemaker.core": MagicMock(),
            "sagemaker.core.resources": MagicMock(),
        }):
            with patch("register_model._check_sagemaker_core"):
                mock_resources = MagicMock()
                mock_resources.ModelPackageGroup.create.return_value = mock_mpg
                # get_all raises an exception (e.g. permission denied)
                mock_resources.ModelPackage.get_all.side_effect = Exception("Access denied")

                with patch.dict("sys.modules", {"sagemaker.core.resources": mock_resources}):
                    with patch("boto3.client", return_value=mock_sm_client):
                        with pytest.raises(SystemExit) as exc_info:
                            _register_helper.cmd_register_adapter(args)

                        assert exc_info.value.code == 0
                        captured = capsys.readouterr()
                        output = json.loads(captured.out)
                        # Dedup check failed but registration succeeded
                        assert "deduplicated" not in output
                        assert output["version"] == 2
                        # Verify create_model_package WAS called
                        mock_sm_client.create_model_package.assert_called_once()
                        # Verify warning was printed
                        assert "Dedup check failed" in captured.err


# ═══════════════════════════════════════════════════════════════════════════════
# 17. Dataset Versioning (US-1: AC-1.1 through AC-1.8)
# ═══════════════════════════════════════════════════════════════════════════════


class TestParseS3Uri:
    """Test _parse_s3_uri utility function."""

    def test_simple_file(self):
        """Parses a single-file S3 URI."""
        bucket, key = _parse_s3_uri("s3://my-bucket/path/to/file.jsonl")
        assert bucket == "my-bucket"
        assert key == "path/to/file.jsonl"

    def test_prefix_with_slash(self):
        """Parses a prefix S3 URI with trailing slash."""
        bucket, key = _parse_s3_uri("s3://my-bucket/datasets/train/")
        assert bucket == "my-bucket"
        assert key == "datasets/train/"

    def test_bucket_only(self):
        """Parses a bucket-only URI."""
        bucket, key = _parse_s3_uri("s3://my-bucket/")
        assert bucket == "my-bucket"
        assert key == ""

    def test_invalid_uri_raises(self):
        """Non-S3 URI raises ValueError."""
        with pytest.raises(ValueError):
            _parse_s3_uri("https://example.com/file.txt")


class TestIsS3Prefix:
    """Test _is_s3_prefix heuristic."""

    def test_trailing_slash_is_prefix(self):
        assert _is_s3_prefix("datasets/train/") is True

    def test_file_with_extension_is_not_prefix(self):
        assert _is_s3_prefix("datasets/train.jsonl") is False

    def test_no_extension_is_prefix(self):
        assert _is_s3_prefix("datasets/train") is True

    def test_empty_key_is_prefix(self):
        assert _is_s3_prefix("") is True


class TestIncrementVersion:
    """Test _increment_version semver minor bump logic."""

    def test_initial_version(self):
        """1.0.0 → 1.1.0"""
        assert _increment_version("1.0.0") == "1.1.0"

    def test_subsequent_version(self):
        """1.1.0 → 1.2.0"""
        assert _increment_version("1.1.0") == "1.2.0"

    def test_high_minor(self):
        """1.9.0 → 1.10.0"""
        assert _increment_version("1.9.0") == "1.10.0"

    def test_invalid_format_returns_default(self):
        """Invalid format returns 1.1.0."""
        assert _increment_version("bad") == "1.1.0"


class TestComputeContentHash:
    """Test _compute_content_hash with mocked S3 calls.

    Validates: AC-1.5
    """

    def test_single_file_returns_etag_truncated(self):
        """Single file: returns S3 ETag truncated to 16 chars."""
        mock_s3 = MagicMock()
        mock_s3.head_object.return_value = {"ETag": '"abcdef1234567890abcdef1234567890"'}

        with patch("boto3.client", return_value=mock_s3):
            result = _compute_content_hash("s3://bucket/file.jsonl", "us-west-2")

        assert result == "abcdef1234567890"
        assert len(result) == 16
        mock_s3.head_object.assert_called_once_with(Bucket="bucket", Key="file.jsonl")

    def test_prefix_returns_sha256_of_sorted_etags(self):
        """Prefix: returns SHA256 of sorted key:etag strings, truncated to 16 chars."""
        mock_s3 = MagicMock()
        mock_paginator = MagicMock()
        mock_s3.get_paginator.return_value = mock_paginator
        mock_paginator.paginate.return_value = [
            {"Contents": [
                {"Key": "prefix/b.jsonl", "ETag": '"etag_b"'},
                {"Key": "prefix/a.jsonl", "ETag": '"etag_a"'},
            ]}
        ]

        with patch("boto3.client", return_value=mock_s3):
            result = _compute_content_hash("s3://bucket/prefix/", "us-west-2")

        # Expected: sort by key, concat, SHA256, truncate
        import hashlib
        expected_input = "prefix/a.jsonl:etag_a\nprefix/b.jsonl:etag_b"
        expected = hashlib.sha256(expected_input.encode()).hexdigest()[:16]
        assert result == expected
        assert len(result) == 16

    def test_same_content_same_hash(self):
        """Same S3 content always produces the same hash (deterministic)."""
        mock_s3 = MagicMock()
        mock_s3.head_object.return_value = {"ETag": '"consistent_etag_value_here"'}

        with patch("boto3.client", return_value=mock_s3):
            result1 = _compute_content_hash("s3://bucket/file.jsonl", "us-west-2")
            result2 = _compute_content_hash("s3://bucket/file.jsonl", "us-west-2")

        assert result1 == result2
# ═══════════════════════════════════════════════════════════════════════════════
# Hub Targeting Tests (US-2: AC-2.1 through AC-2.5)
# ═══════════════════════════════════════════════════════════════════════════════

_get_hub_name_from_profile = _register_helper._get_hub_name_from_profile
_register_to_hub = _register_helper._register_to_hub


class TestGetHubNameFromProfile:
    """Test _get_hub_name_from_profile reads hub name from bootstrap config.

    Validates: Requirements AC-2.1
    """

    def test_reads_hub_name_from_matching_region_profile(self, tmp_path):
        """Returns hub name from profile matching the given region."""
        config = {
            "profiles": {
                "us-west-2-123456789012": {
                    "awsRegion": "us-west-2",
                    "aiRegistryHubName": "mlcc-registry-123456789012",
                    "aiRegistryHubArn": "arn:aws:sagemaker:us-west-2:123456789012:hub/mlcc-registry-123456789012",
                },
                "us-east-1-999888777666": {
                    "awsRegion": "us-east-1",
                    "aiRegistryHubName": "mlcc-registry-999888777666",
                },
            }
        }
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            assert result == "mlcc-registry-123456789012"

    def test_returns_none_when_no_config_file(self, tmp_path):
        """Returns None when config.json doesn't exist (legacy install)."""
        config_path = tmp_path / "nonexistent" / "config.json"

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            assert result is None

    def test_returns_none_when_no_hub_name_in_profile(self, tmp_path):
        """Returns None when profile exists but has no aiRegistryHubName (AC-2.3)."""
        config = {
            "profiles": {
                "us-west-2-123456789012": {
                    "awsRegion": "us-west-2",
                    "bucketName": "mlcc-123456789012",
                }
            }
        }
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            assert result is None

    def test_returns_none_when_profiles_empty(self, tmp_path):
        """Returns None when profiles dict is empty."""
        config = {"profiles": {}}
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            assert result is None

    def test_fallback_to_first_profile_with_hub_name(self, tmp_path):
        """When region doesn't match, returns first profile with hub name."""
        config = {
            "profiles": {
                "eu-west-1-111222333444": {
                    "awsRegion": "eu-west-1",
                    "aiRegistryHubName": "mlcc-registry-111222333444",
                }
            }
        }
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            # Region doesn't match any profile key
            result = _get_hub_name_from_profile("us-west-2")
            assert result == "mlcc-registry-111222333444"

    def test_returns_none_when_no_region_and_no_hub(self, tmp_path):
        """Returns None when no region provided and no profiles have hub name."""
        config = {
            "profiles": {
                "us-west-2-123456789012": {
                    "awsRegion": "us-west-2",
                }
            }
        }
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile(None)
            assert result is None

    def test_handles_malformed_json(self, tmp_path):
        """Returns None gracefully on malformed JSON."""
        config_path = tmp_path / "config.json"
        config_path.write_text("not valid json {{{")

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            assert result is None

    def test_handles_non_dict_profile_entry(self, tmp_path):
        """Skips non-dict profile entries without crashing."""
        config = {
            "profiles": {
                "us-west-2-123456789012": "not-a-dict",
                "us-east-1-999888777666": {
                    "aiRegistryHubName": "mlcc-registry-999888777666",
                }
            }
        }
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config))

        with patch("register_common._CONFIG_PATH", str(config_path)):
            result = _get_hub_name_from_profile("us-west-2")
            # Should skip the non-dict entry and find the valid one
            assert result == "mlcc-registry-999888777666"


class TestRegisterToHub:
    """Test _register_to_hub targets specific hub by name.

    Validates: Requirements AC-2.2, AC-2.4, AC-2.5
    """

    @patch("boto3.client")
    def test_successful_registration_returns_arn(self, mock_boto_client):
        """Successful create_hub_content returns the hub content ARN."""
        mock_sm = MagicMock()
        mock_sm.create_hub_content.return_value = {
            "HubContentArn": "arn:aws:sagemaker:us-west-2:123:hub/mlcc-registry-123/dataset/my-dataset"
        }
        mock_boto_client.return_value = mock_sm

        result = _register_to_hub(
            hub_name="mlcc-registry-123",
            name="my-dataset",
            s3_uri="s3://bucket/data.jsonl",
            technique="sft",
            description="[hash:abc123]",
            region="us-west-2",
        )

        assert result == "arn:aws:sagemaker:us-west-2:123:hub/mlcc-registry-123/dataset/my-dataset"
        mock_sm.create_hub_content.assert_called_once()
        call_kwargs = mock_sm.create_hub_content.call_args[1]
        assert call_kwargs["HubName"] == "mlcc-registry-123"
        assert call_kwargs["HubContentName"] == "my-dataset"
        assert call_kwargs["HubContentType"] == "Dataset"

    @patch("boto3.client")
    def test_hub_not_found_returns_none_with_message(self, mock_boto_client, capsys):
        """Hub not found returns None and prints actionable message (AC-2.5)."""
        mock_sm = MagicMock()
        mock_sm.create_hub_content.side_effect = Exception(
            "An error occurred (ResourceNotFound): Hub mlcc-registry-123 does not exist"
        )
        mock_boto_client.return_value = mock_sm

        result = _register_to_hub(
            hub_name="mlcc-registry-123",
            name="my-dataset",
            s3_uri="s3://bucket/data.jsonl",
            technique="sft",
            description="",
            region="us-west-2",
        )

        assert result is None
        captured = capsys.readouterr()
        assert "ml-container-creator bootstrap" in captured.err
        assert "Falling back to local JSON registry" in captured.err

    @patch("boto3.client")
    def test_already_exists_is_idempotent(self, mock_boto_client):
        """Already-exists error is treated as success (idempotent)."""
        mock_sm = MagicMock()
        mock_sm.create_hub_content.side_effect = Exception(
            "An error occurred (ResourceInUse): Hub content 'my-dataset' already exists"
        )
        mock_sm.describe_hub_content.return_value = {
            "HubContentArn": "arn:aws:sagemaker:us-west-2:123:hub/mlcc-registry-123/dataset/my-dataset"
        }
        mock_boto_client.return_value = mock_sm

        result = _register_to_hub(
            hub_name="mlcc-registry-123",
            name="my-dataset",
            s3_uri="s3://bucket/data.jsonl",
            technique="sft",
            description="",
            region="us-west-2",
        )

        assert result == "arn:aws:sagemaker:us-west-2:123:hub/mlcc-registry-123/dataset/my-dataset"

    @patch("boto3.client")
    def test_other_error_returns_none_with_helpful_message(self, mock_boto_client, capsys):
        """Other errors return None and print helpful error message."""
        mock_sm = MagicMock()
        mock_sm.create_hub_content.side_effect = Exception(
            "An error occurred (AccessDenied): User is not authorized"
        )
        mock_boto_client.return_value = mock_sm

        result = _register_to_hub(
            hub_name="mlcc-registry-123",
            name="my-dataset",
            s3_uri="s3://bucket/data.jsonl",
            technique="sft",
            description="",
            region="us-west-2",
        )

        assert result is None
        captured = capsys.readouterr()
        assert "Failed to register dataset to hub" in captured.err
        assert "ml-container-creator bootstrap" in captured.err
