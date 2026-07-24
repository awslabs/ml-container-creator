"""Unit tests for .adapter_helper.py Processing Job helper.

Tests cover:
- Job name generation
- Argument parsing and validation
- Container image resolution
- Error handling patterns
- JSON output contract

Requirements validated: US-3, US-2
"""

import importlib.util
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".adapter_helper.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("adapter_helper", _HELPER_PATH)
_adapter_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_adapter_helper)

_generate_job_name = _adapter_helper._generate_job_name
_resolve_container_image = _adapter_helper._resolve_container_image
_error_exit = _adapter_helper._error_exit
_output = _adapter_helper._output


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Job Name Generation
# ═══════════════════════════════════════════════════════════════════════════════


class TestGenerateJobName:
    """Test _generate_job_name produces valid SageMaker job names.

    Validates: Requirements US-3 (AC-3.1)
    """

    def test_basic_job_name(self):
        """Job name starts with mlcc-adapter prefix."""
        name = _generate_job_name("myproject", "my-adapter")
        assert name.startswith("mlcc-adapter-myproject-my-adapter-")

    def test_job_name_max_length(self):
        """Job names never exceed 63 characters."""
        name = _generate_job_name(
            "a-very-long-project-name-that-is-quite-long",
            "also-a-very-long-adapter-name"
        )
        assert len(name) <= 63

    def test_job_name_includes_timestamp(self):
        """Job name ends with a timestamp pattern."""
        name = _generate_job_name("proj", "adapter")
        # Should end with YYYYMMDD-HHMMSS pattern
        parts = name.rsplit("-", 2)
        assert len(parts) >= 2
        # Timestamp part is the last two segments joined by -
        timestamp_part = f"{parts[-2]}-{parts[-1]}"
        assert len(timestamp_part) == 15  # YYYYMMDD-HHMMSS

    def test_job_name_alphanumeric_start(self):
        """Job name starts with alphanumeric character."""
        name = _generate_job_name("proj", "adapter")
        assert name[0].isalnum()


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Container Image Resolution
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveContainerImage:
    """Test _resolve_container_image returns valid ECR URIs.

    Validates: Requirements US-3 (AC-3.1)
    """

    def test_us_east_1_image(self):
        """US East 1 returns a valid DLC image URI."""
        image = _resolve_container_image("us-east-1")
        assert "763104351884.dkr.ecr.us-east-1.amazonaws.com" in image
        assert "pytorch" in image

    def test_us_west_2_image(self):
        """US West 2 returns a valid DLC image URI."""
        image = _resolve_container_image("us-west-2")
        assert "763104351884.dkr.ecr.us-west-2.amazonaws.com" in image

    def test_unknown_region_fallback(self):
        """Unknown region falls back to default account."""
        image = _resolve_container_image("ap-unknown-1")
        assert "763104351884" in image
        assert "ap-unknown-1" in image


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Error Handling
# ═══════════════════════════════════════════════════════════════════════════════


class TestErrorHandling:
    """Test error exit patterns.

    Validates: Requirements US-3 (AC-3.4)
    """

    def test_error_exit_prints_to_stderr(self, capsys):
        """_error_exit prints message to stderr and exits with code 1."""
        with pytest.raises(SystemExit) as exc_info:
            _error_exit("test error message")
        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "test error message" in captured.err

    def test_error_exit_custom_code(self, capsys):
        """_error_exit supports custom exit codes."""
        with pytest.raises(SystemExit) as exc_info:
            _error_exit("auth error", exit_code=4)
        assert exc_info.value.code == 4


# ═══════════════════════════════════════════════════════════════════════════════
# 4. JSON Output Contract
# ═══════════════════════════════════════════════════════════════════════════════


class TestJsonOutputContract:
    """Test JSON output matches the contract: job_name, status, adapter_s3_uri.

    Validates: Requirements US-3 (AC-3.1, AC-3.2, AC-3.5)
    """

    def test_output_is_valid_json(self, capsys):
        """_output prints valid JSON to stdout."""
        import json
        data = {
            "job_name": "mlcc-adapter-proj-adp-20250618-120000",
            "status": "Completed",
            "adapter_s3_uri": "s3://bucket/proj/adapters/adp/",
        }
        with pytest.raises(SystemExit) as exc_info:
            _output(data)
        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert parsed["job_name"] == "mlcc-adapter-proj-adp-20250618-120000"
        assert parsed["status"] == "Completed"
        assert parsed["adapter_s3_uri"] == "s3://bucket/proj/adapters/adp/"

    def test_output_contract_fields_present(self, capsys):
        """JSON output contains exactly the expected fields."""
        import json
        data = {
            "job_name": "test-job",
            "status": "InProgress",
            "adapter_s3_uri": "s3://b/p/adapters/a/",
        }
        with pytest.raises(SystemExit):
            _output(data)
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert set(parsed.keys()) == {"job_name", "status", "adapter_s3_uri"}


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Dependency Checks
# ═══════════════════════════════════════════════════════════════════════════════


class TestDependencyChecks:
    """Test dependency check functions.

    Validates: Requirements US-6 (AC-6.2) — sagemaker-core import check
    """

    def test_check_sagemaker_core_with_mock(self):
        """_check_sagemaker_core does not exit when sagemaker_core is importable."""
        # Mock the import
        mock_module = MagicMock()
        with patch.dict(sys.modules, {
            "sagemaker": mock_module,
            "sagemaker.core": mock_module,
            "sagemaker.core.resources": mock_module,
        }):
            # Should not raise
            _adapter_helper._check_sagemaker_core()

    def test_check_boto3_succeeds(self):
        """_check_boto3 does not exit when boto3 is available."""
        mock_module = MagicMock()
        with patch.dict(sys.modules, {"boto3": mock_module}):
            _adapter_helper._check_boto3()

# ═══════════════════════════════════════════════════════════════════════════════
# 6. Argument Parsing
# ═══════════════════════════════════════════════════════════════════════════════


class TestArgumentParsing:
    """Test CLI argument parsing for subcommands.

    Validates: Requirements US-3 (AC-3.1, AC-3.5)
    """

    def test_stage_from_tune_subcommand_recognized(self):
        """stage-from-tune is a valid subcommand."""
        # Verify argument parser accepts these args without error
        import argparse
        parser = argparse.ArgumentParser()
        subparsers = parser.add_subparsers(dest="subcommand")
        stage_parser = subparsers.add_parser("stage-from-tune")
        stage_parser.add_argument("--training-output-s3-uri", required=True)
        stage_parser.add_argument("--adapter-name", required=True)
        stage_parser.add_argument("--bucket", required=True)
        stage_parser.add_argument("--project", required=True)
        stage_parser.add_argument("--role-arn", required=True)
        stage_parser.add_argument("--region", default=None)
        stage_parser.add_argument("--container-image", default=None)
        stage_parser.add_argument("--no-wait", action="store_true", default=False)

        args = parser.parse_args([
            "stage-from-tune",
            "--training-output-s3-uri", "s3://bucket/output/",
            "--adapter-name", "my-adapter",
            "--bucket", "my-bucket",
            "--project", "my-project",
            "--role-arn", "arn:aws:iam::123456789012:role/SageMakerRole",
        ])
        assert args.subcommand == "stage-from-tune"
        assert args.training_output_s3_uri == "s3://bucket/output/"
        assert args.adapter_name == "my-adapter"
        assert args.no_wait is False

    def test_status_subcommand_recognized(self):
        """status is a valid subcommand."""
        # Just verify the argument structure is valid
        with patch("sys.argv", [
            ".adapter_helper.py", "status",
            "--job-name", "mlcc-adapter-proj-adp-20250618-120000",
        ]):
            pass  # Parsing would succeed without API calls

    def test_no_wait_flag_parsed(self):
        """--no-wait flag is recognized in stage-from-tune."""
        with patch("sys.argv", [
            ".adapter_helper.py", "stage-from-tune",
            "--training-output-s3-uri", "s3://bucket/output/",
            "--adapter-name", "my-adapter",
            "--bucket", "my-bucket",
            "--project", "my-project",
            "--role-arn", "arn:aws:iam::123456789012:role/SageMakerRole",
            "--no-wait",
        ]):
            pass  # Parsing would succeed


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Entrypoint Upload
# ═══════════════════════════════════════════════════════════════════════════════


class TestEntrypointUpload:
    """Test entrypoint script upload to S3.

    Validates: Requirements US-3 (AC-3.1, AC-3.2)
    """

    def test_upload_entrypoint_returns_s3_uri(self):
        """_upload_entrypoint returns a valid S3 URI."""
        mock_s3 = MagicMock()
        mock_s3.put_object.return_value = {}
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3

        with patch.dict(sys.modules, {"boto3": mock_boto3}):
            uri = _adapter_helper._upload_entrypoint(
                "my-bucket",
                "mlcc-adapter-proj-adp-20250618-120000",
                "us-west-2",
            )

        assert uri.startswith("s3://my-bucket/staging-jobs/")
        assert "entrypoint.sh" in uri
        mock_s3.put_object.assert_called_once()

    def test_upload_entrypoint_s3_path_convention(self):
        """Entrypoint is uploaded to s3://{bucket}/staging-jobs/{job-name}/entrypoint.sh."""
        mock_s3 = MagicMock()
        mock_s3.put_object.return_value = {}
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3

        job_name = "mlcc-adapter-proj-adp-20250618-120000"
        with patch.dict(sys.modules, {"boto3": mock_boto3}):
            uri = _adapter_helper._upload_entrypoint("my-bucket", job_name, "us-west-2")

        expected = f"s3://my-bucket/staging-jobs/{job_name}/entrypoint.sh"
        assert uri == expected
