#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for benchmark writer partition registration.

Tests the register_partition function from .benchmark_writer.py:
- Successful partition creation
- Idempotent behavior (AlreadyExistsException swallowed)
- Error handling for API failures
- Correct S3 location construction

Uses model/instance/target partitioning scheme.
"""

import importlib.util
import os
from unittest.mock import MagicMock, patch

import pytest


# ── Import the module under test ──────────────────────────────────────────────
# The file has a leading dot in the name, so we use importlib to load it.

_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".benchmark_writer.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("benchmark_writer", _HELPER_PATH)
_benchmark_writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_benchmark_writer)

register_partition = _benchmark_writer.register_partition


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_glue_client():
    """Create a mock Glue client with standard table metadata response."""
    client = MagicMock()
    client.get_table.return_value = {
        "Table": {
            "StorageDescriptor": {
                "Columns": [
                    {"Name": "project_name", "Type": "string"},
                    {"Name": "model_name", "Type": "string"},
                    {"Name": "request_throughput_rps", "Type": "double"},
                ],
                "Location": "s3://mlcc-benchmark-results-111111111111-us-east-1/results/",
                "InputFormat": "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                "OutputFormat": "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                "SerdeInfo": {
                    "SerializationLibrary": "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
                    "Parameters": {"serialization.format": "1"},
                },
                "Compressed": True,
            }
        }
    }
    return client


# ── Tests: Successful Registration ────────────────────────────────────────────


class TestRegisterPartitionSuccess:
    """Tests for successful partition registration."""

    def test_new_partition_registered(self, mock_glue_client):
        """When partition doesn't exist, it should be registered successfully."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        result = register_partition(
            bucket="mlcc-benchmark-results-111111111111-us-east-1",
            model="Qwen_Qwen3-4B",
            instance="ml.g5.xlarge",
            target="realtime-inference",
            glue_client=mock_glue_client,
        )

        assert result["registered"] is True
        assert result["already_exists"] is False
        assert result["error"] is None
        assert result["location"] == (
            "s3://mlcc-benchmark-results-111111111111-us-east-1/"
            "results/model=Qwen_Qwen3-4B/instance=ml.g5.xlarge/target=realtime-inference/"
        )

    def test_correct_partition_values(self, mock_glue_client):
        """Partition values should be [model, instance, target]."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        result = register_partition(
            bucket="bucket",
            model="meta-llama_Llama-3.1-8B",
            instance="ml.p5.48xlarge",
            target="async-inference",
            glue_client=mock_glue_client,
        )

        assert result["partition_values"] == ["meta-llama_Llama-3.1-8B", "ml.p5.48xlarge", "async-inference"]

    def test_correct_api_call_parameters(self, mock_glue_client):
        """Verify BatchCreatePartition is called with correct database/table."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="mlcc-benchmark-results-111111111111-us-west-2",
            model="Qwen_Qwen3-4B",
            instance="ml.g5.xlarge",
            target="realtime-inference",
            glue_client=mock_glue_client,
        )

        mock_glue_client.batch_create_partition.assert_called_once()
        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]

        assert call_kwargs["DatabaseName"] == "mlcc_ci"
        assert call_kwargs["TableName"] == "benchmark_results"

        partition_input = call_kwargs["PartitionInputList"][0]
        assert partition_input["Values"] == ["Qwen_Qwen3-4B", "ml.g5.xlarge", "realtime-inference"]

    def test_partition_location_format(self, mock_glue_client):
        """Partition location follows Hive-style partitioning."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        result = register_partition(
            bucket="my-bucket",
            model="Qwen_Qwen3-4B",
            instance="ml.g6e.xlarge",
            target="batch-transform",
            glue_client=mock_glue_client,
        )

        assert result["location"] == (
            "s3://my-bucket/results/model=Qwen_Qwen3-4B/instance=ml.g6e.xlarge/target=batch-transform/"
        )

    def test_custom_database_and_table(self, mock_glue_client):
        """Custom database/table names should be used if provided."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="bucket",
            model="model",
            instance="ml.g5.xlarge",
            target="realtime-inference",
            glue_database="custom_db",
            glue_table="custom_table",
            glue_client=mock_glue_client,
        )

        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]
        assert call_kwargs["DatabaseName"] == "custom_db"
        assert call_kwargs["TableName"] == "custom_table"


# ── Tests: Idempotent Behavior ────────────────────────────────────────────────


class TestRegisterPartitionIdempotent:
    """Tests for idempotent behavior when partition already exists."""

    def test_already_exists_in_batch_response(self, mock_glue_client):
        """AlreadyExistsException in batch response should be swallowed."""
        mock_glue_client.batch_create_partition.return_value = {
            "Errors": [
                {
                    "PartitionValues": ["Qwen_Qwen3-4B", "ml.g5.xlarge", "realtime-inference"],
                    "ErrorDetail": {
                        "ErrorCode": "AlreadyExistsException",
                        "ErrorMessage": "Partition already exists.",
                    },
                }
            ]
        }

        result = register_partition(
            bucket="mlcc-benchmark-results-111111111111-us-east-1",
            model="Qwen_Qwen3-4B",
            instance="ml.g5.xlarge",
            target="realtime-inference",
            glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is True
        assert result["error"] is None

    def test_already_exists_as_exception(self, mock_glue_client):
        """AlreadyExistsException thrown as API exception should be swallowed."""
        mock_glue_client.batch_create_partition.side_effect = Exception(
            "An error occurred (AlreadyExistsException): Partition already exists"
        )

        result = register_partition(
            bucket="bucket",
            model="Qwen_Qwen3-4B",
            instance="ml.g5.xlarge",
            target="realtime-inference",
            glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is True
        assert result["error"] is None

    def test_idempotent_repeated_calls(self, mock_glue_client):
        """Calling register_partition multiple times should not fail."""
        # First call: success
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}
        result1 = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )
        assert result1["registered"] is True

        # Second call: already exists
        mock_glue_client.batch_create_partition.return_value = {
            "Errors": [
                {
                    "PartitionValues": ["model", "ml.g5.xlarge", "realtime-inference"],
                    "ErrorDetail": {
                        "ErrorCode": "AlreadyExistsException",
                        "ErrorMessage": "Partition already exists.",
                    },
                }
            ]
        }
        result2 = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )
        assert result2["registered"] is False
        assert result2["already_exists"] is True
        assert result2["error"] is None


# ── Tests: Error Handling ─────────────────────────────────────────────────────


class TestRegisterPartitionErrors:
    """Tests for error handling in partition registration."""

    def test_table_not_found(self, mock_glue_client):
        """If table doesn't exist, return error without crashing."""
        mock_glue_client.get_table.side_effect = Exception(
            "An error occurred (EntityNotFoundException): Table not found"
        )

        result = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is False
        assert "not found" in result["error"]

    def test_get_table_generic_error(self, mock_glue_client):
        """Generic GetTable errors are captured in error field."""
        mock_glue_client.get_table.side_effect = Exception(
            "An error occurred (InternalServiceException): Service unavailable"
        )

        result = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is False
        assert "InternalServiceException" in result["error"]

    def test_batch_create_api_error(self, mock_glue_client):
        """Non-AlreadyExists exceptions from BatchCreatePartition are reported."""
        mock_glue_client.batch_create_partition.side_effect = Exception(
            "An error occurred (InternalServiceException): Service unavailable"
        )

        result = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is False
        assert "InternalServiceException" in result["error"]

    def test_partition_error_non_already_exists(self, mock_glue_client):
        """Non-AlreadyExistsException errors in batch response are reported."""
        mock_glue_client.batch_create_partition.return_value = {
            "Errors": [
                {
                    "PartitionValues": ["model", "ml.g5.xlarge", "realtime-inference"],
                    "ErrorDetail": {
                        "ErrorCode": "InvalidInputException",
                        "ErrorMessage": "Invalid partition values",
                    },
                }
            ]
        }

        result = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert result["already_exists"] is False
        assert "InvalidInputException" in result["error"]
        assert "Invalid partition values" in result["error"]

    def test_access_denied(self, mock_glue_client):
        """Access denied error is captured gracefully."""
        mock_glue_client.get_table.side_effect = Exception(
            "An error occurred (AccessDeniedException): Not authorized"
        )

        result = register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        assert result["registered"] is False
        assert "AccessDeniedException" in result["error"]


# ── Tests: Storage Descriptor ─────────────────────────────────────────────────


class TestRegisterPartitionStorageDescriptor:
    """Tests for storage descriptor construction."""

    def test_inherits_table_columns(self, mock_glue_client):
        """Partition storage descriptor should use table's column definitions."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]
        partition_sd = call_kwargs["PartitionInputList"][0]["StorageDescriptor"]

        assert partition_sd["Columns"] == [
            {"Name": "project_name", "Type": "string"},
            {"Name": "model_name", "Type": "string"},
            {"Name": "request_throughput_rps", "Type": "double"},
        ]

    def test_uses_parquet_serde(self, mock_glue_client):
        """Partition should use Parquet SerDe."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]
        partition_sd = call_kwargs["PartitionInputList"][0]["StorageDescriptor"]

        assert "ParquetHiveSerDe" in partition_sd["SerdeInfo"]["SerializationLibrary"]

    def test_parquet_parameters_included(self, mock_glue_client):
        """Partition should include parquet classification parameters."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]
        partition_input = call_kwargs["PartitionInputList"][0]

        assert partition_input["Parameters"]["classification"] == "parquet"
        assert partition_input["Parameters"]["parquet.compression"] == "SNAPPY"

    def test_inherits_input_output_format(self, mock_glue_client):
        """Partition inherits InputFormat and OutputFormat from table."""
        mock_glue_client.batch_create_partition.return_value = {"Errors": []}

        register_partition(
            bucket="bucket", model="model", instance="ml.g5.xlarge",
            target="realtime-inference", glue_client=mock_glue_client,
        )

        call_kwargs = mock_glue_client.batch_create_partition.call_args[1]
        partition_sd = call_kwargs["PartitionInputList"][0]["StorageDescriptor"]

        assert "MapredParquetInputFormat" in partition_sd["InputFormat"]
        assert "MapredParquetOutputFormat" in partition_sd["OutputFormat"]
