# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Unit tests for templates/do/lib/python/ic_update.py

Tests cover:
- build_update_spec with various combinations of model_data and image
- update_inference_component API call
- poll_until_ready with InService, Failed, and timeout scenarios
- describe_ic error handling (IC not found)
- main flow integration (mocked boto3)
"""
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

# Add the template python lib to the path
TEMPLATE_LIB = Path(__file__).resolve().parent.parent.parent / "templates" / "do" / "lib" / "python"
sys.path.insert(0, str(TEMPLATE_LIB))

import ic_update


class TestBuildUpdateSpec:
    """Tests for build_update_spec()."""

    def test_model_data_only(self):
        spec = ic_update.build_update_spec({}, model_data="s3://bucket/model.tar.gz")
        assert spec == {"Container": {"ArtifactUrl": "s3://bucket/model.tar.gz"}}

    def test_image_only(self):
        spec = ic_update.build_update_spec({}, image="123456.dkr.ecr.us-east-1.amazonaws.com/repo:tag")
        assert spec == {"Container": {"Image": "123456.dkr.ecr.us-east-1.amazonaws.com/repo:tag"}}

    def test_both_model_data_and_image(self):
        spec = ic_update.build_update_spec(
            {},
            model_data="s3://bucket/model.tar.gz",
            image="123456.dkr.ecr.us-east-1.amazonaws.com/repo:new-tag"
        )
        assert spec == {
            "Container": {
                "ArtifactUrl": "s3://bucket/model.tar.gz",
                "Image": "123456.dkr.ecr.us-east-1.amazonaws.com/repo:new-tag"
            }
        }

    def test_neither_returns_none(self):
        spec = ic_update.build_update_spec({})
        assert spec is None

    def test_empty_strings_treated_as_no_update(self):
        spec = ic_update.build_update_spec({}, model_data="", image="")
        assert spec is None


class TestUpdateInferenceComponent:
    """Tests for update_inference_component()."""

    def test_calls_api_with_correct_params(self):
        mock_client = MagicMock()
        mock_client.update_inference_component.return_value = {"InferenceComponentArn": "arn:..."}

        spec = {"Container": {"ArtifactUrl": "s3://bucket/model.tar.gz"}}
        result = ic_update.update_inference_component(mock_client, "my-ic-12345", spec)

        mock_client.update_inference_component.assert_called_once_with(
            InferenceComponentName="my-ic-12345",
            Specification=spec,
        )


class TestPollUntilReady:
    """Tests for poll_until_ready()."""

    def test_immediate_in_service(self):
        mock_client = MagicMock()
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentStatus": "InService"
        }

        result = ic_update.poll_until_ready(mock_client, "my-ic", timeout=60, poll_interval=1)
        assert result["status"] == "InService"
        assert "elapsed_seconds" in result

    def test_transitions_to_in_service(self):
        mock_client = MagicMock()
        mock_client.describe_inference_component.side_effect = [
            {"InferenceComponentStatus": "Updating"},
            {"InferenceComponentStatus": "Updating"},
            {"InferenceComponentStatus": "InService"},
        ]

        with patch("time.sleep"):
            result = ic_update.poll_until_ready(mock_client, "my-ic", timeout=120, poll_interval=1)

        assert result["status"] == "InService"
        assert mock_client.describe_inference_component.call_count == 3

    def test_failed_status(self):
        mock_client = MagicMock()
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentStatus": "Failed",
            "FailureReason": "Container startup failed"
        }

        result = ic_update.poll_until_ready(mock_client, "my-ic", timeout=60, poll_interval=1)
        assert result["error"] is True
        assert "Container startup failed" in result["message"]

    def test_timeout(self):
        mock_client = MagicMock()
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentStatus": "Updating"
        }

        # Use a very short timeout and mock time so we exceed it
        with patch("time.time") as mock_time, patch("time.sleep"):
            # First call returns 0, subsequent calls return increasing values
            mock_time.side_effect = [0, 0, 100, 100]
            result = ic_update.poll_until_ready(mock_client, "my-ic", timeout=60, poll_interval=1)

        assert result["error"] is True
        assert "Timeout" in result["message"]

    def test_client_error_during_poll(self):
        from botocore.exceptions import ClientError

        mock_client = MagicMock()
        mock_client.describe_inference_component.side_effect = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
            "DescribeInferenceComponent"
        )

        with patch("time.time", side_effect=[0, 0]):
            result = ic_update.poll_until_ready(mock_client, "my-ic", timeout=60, poll_interval=1)

        assert result["error"] is True
        assert "DescribeInferenceComponent failed" in result["message"]


class TestDescribeIc:
    """Tests for describe_ic()."""

    def test_returns_response(self):
        mock_client = MagicMock()
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentName": "my-ic",
            "InferenceComponentStatus": "InService",
            "Specification": {"Container": {"Image": "img:latest"}}
        }

        result = ic_update.describe_ic(mock_client, "my-ic")
        assert result["InferenceComponentStatus"] == "InService"

    def test_raises_on_not_found(self):
        from botocore.exceptions import ClientError

        mock_client = MagicMock()
        mock_client.describe_inference_component.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "IC does not exist"}},
            "DescribeInferenceComponent"
        )

        with pytest.raises(ClientError):
            ic_update.describe_ic(mock_client, "nonexistent-ic")


class TestMainFlow:
    """Integration tests for the main() function with mocked boto3."""

    @patch("ic_update.boto3")
    def test_successful_update_with_model_data(self, mock_boto3, capsys):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client

        # describe_inference_component responses: first for validation, then polling
        mock_client.describe_inference_component.side_effect = [
            # Initial describe (validation)
            {
                "InferenceComponentName": "proj-default-111",
                "InferenceComponentStatus": "InService",
                "Specification": {"Container": {"Image": "img:latest"}}
            },
            # Poll - InService immediately
            {
                "InferenceComponentStatus": "InService"
            },
        ]
        mock_client.update_inference_component.return_value = {"InferenceComponentArn": "arn:..."}

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "proj-default-111",
            "--region", "us-east-1",
            "--model-data", "s3://bucket/new-model.tar.gz",
        ]):
            ic_update.main()

        captured = capsys.readouterr()
        output = json.loads(captured.out.strip())
        assert output["status"] == "InService"
        assert output["ic_name"] == "proj-default-111"
        assert "ModelDataUrl" in output["updated_fields"]

    @patch("ic_update.boto3")
    def test_ic_not_found_exits_1(self, mock_boto3):
        from botocore.exceptions import ClientError

        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.describe_inference_component.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "IC does not exist"}},
            "DescribeInferenceComponent"
        )

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "nonexistent-ic",
            "--region", "us-east-1",
            "--model-data", "s3://bucket/model.tar.gz",
        ]):
            with pytest.raises(SystemExit) as exc_info:
                ic_update.main()
            assert exc_info.value.code == 1

    @patch("ic_update.boto3")
    def test_ic_not_in_service_exits_1(self, mock_boto3, capsys):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentName": "proj-default-111",
            "InferenceComponentStatus": "Creating",
        }

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "proj-default-111",
            "--region", "us-east-1",
            "--model-data", "s3://bucket/model.tar.gz",
        ]):
            with pytest.raises(SystemExit) as exc_info:
                ic_update.main()
            assert exc_info.value.code == 1

    @patch("ic_update.boto3")
    def test_no_model_data_or_image_exits_1(self, mock_boto3, capsys):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client
        mock_client.describe_inference_component.return_value = {
            "InferenceComponentName": "proj-default-111",
            "InferenceComponentStatus": "InService",
            "Specification": {},
        }

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "proj-default-111",
            "--region", "us-east-1",
        ]):
            with pytest.raises(SystemExit) as exc_info:
                ic_update.main()
            assert exc_info.value.code == 1

    @patch("ic_update.boto3")
    def test_update_with_image_only(self, mock_boto3, capsys):
        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client

        mock_client.describe_inference_component.side_effect = [
            {
                "InferenceComponentName": "proj-default-111",
                "InferenceComponentStatus": "InService",
                "Specification": {"Container": {"Image": "img:old"}}
            },
            {"InferenceComponentStatus": "InService"},
        ]
        mock_client.update_inference_component.return_value = {"InferenceComponentArn": "arn:..."}

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "proj-default-111",
            "--region", "us-west-2",
            "--image", "123456.dkr.ecr.us-west-2.amazonaws.com/repo:new-tag",
        ]):
            ic_update.main()

        captured = capsys.readouterr()
        output = json.loads(captured.out.strip())
        assert output["status"] == "InService"
        assert "Image" in output["updated_fields"]

        # Verify the API was called with correct spec
        call_kwargs = mock_client.update_inference_component.call_args[1]
        assert call_kwargs["Specification"]["Container"]["Image"] == "123456.dkr.ecr.us-west-2.amazonaws.com/repo:new-tag"

    @patch("ic_update.boto3")
    def test_update_api_failure_exits_1(self, mock_boto3, capsys):
        from botocore.exceptions import ClientError

        mock_client = MagicMock()
        mock_boto3.client.return_value = mock_client

        mock_client.describe_inference_component.return_value = {
            "InferenceComponentName": "proj-default-111",
            "InferenceComponentStatus": "InService",
            "Specification": {},
        }
        mock_client.update_inference_component.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "Invalid spec"}},
            "UpdateInferenceComponent"
        )

        with patch("sys.argv", [
            "ic_update.py",
            "--ic-name", "proj-default-111",
            "--region", "us-east-1",
            "--model-data", "s3://bucket/model.tar.gz",
        ]):
            with pytest.raises(SystemExit) as exc_info:
                ic_update.main()
            assert exc_info.value.code == 1
