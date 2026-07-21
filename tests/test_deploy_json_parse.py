"""Test that the inline JSON parser in do/deploy produces correct export statements."""
import json
import subprocess
import os

PARSER_SCRIPT = """
import json, sys
KEY_MAP = {
    'target': 'DEPLOYMENT_TARGET',
    'instance_type': 'INSTANCE_TYPE',
    'endpoint_name': 'ENDPOINT_NAME',
    'endpoint_strategy': 'ENDPOINT_STRATEGY',
    'instance_types': 'INSTANCE_TYPES',
    'gpu_count': 'IC_GPU_COUNT',
    'cluster_name': 'HP_CLUSTER_NAME',
    'hp_gpu_count': 'HP_GPU_COUNT',
    'namespace': 'HP_NAMESPACE',
    'replicas': 'HP_REPLICAS',
    'queue': 'HP_QUEUE',
    'async_output_path': 'ASYNC_S3_OUTPUT_PATH',
    'async_sns_topic': 'ASYNC_SNS_TOPIC',
    'async_max_concurrent': 'ASYNC_MAX_CONCURRENT',
    'batch_input_path': 'BATCH_INPUT_PATH',
    'batch_output_path': 'BATCH_OUTPUT_PATH',
    'batch_split_type': 'BATCH_SPLIT_TYPE',
    'batch_strategy': 'BATCH_STRATEGY',
    'batch_max_concurrent': 'BATCH_MAX_CONCURRENT',
}
data = json.load(sys.stdin)
if 'error' in data:
    err = data['error']
    print(f'echo "\\u274c {err}" >&2; exit 1')
else:
    for key, var in KEY_MAP.items():
        if key in data and data[key]:
            val = str(data[key]).replace('"', '\\\\\\"')
            print(f'export {var}="{val}"')
"""


def run_parser(json_input: str) -> str:
    """Run the inline parser script with the given JSON input."""
    result = subprocess.run(
        ["python3", "-c", PARSER_SCRIPT],
        input=json_input,
        capture_output=True,
        text=True,
    )
    return result.stdout, result.stderr, result.returncode


def test_managed_inference_response():
    """Test parsing a managed-inference JSON response."""
    data = {
        "target": "managed-inference",
        "instance_type": "ml.g5.xlarge",
        "endpoint_name": "wise-bert-service-ep",
        "endpoint_strategy": "new",
        "instance_types": "ml.g5.xlarge",
        "gpu_count": "1",
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    lines = stdout.strip().split("\n")
    assert 'export DEPLOYMENT_TARGET="managed-inference"' in lines
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in lines
    assert 'export ENDPOINT_NAME="wise-bert-service-ep"' in lines
    assert 'export ENDPOINT_STRATEGY="new"' in lines
    assert 'export INSTANCE_TYPES="ml.g5.xlarge"' in lines
    assert 'export IC_GPU_COUNT="1"' in lines


def test_hyperpod_response():
    """Test parsing a hyperpod-eks JSON response."""
    data = {
        "target": "hyperpod-eks",
        "instance_type": "ml.g5.12xlarge",
        "cluster_name": "my-cluster",
        "hp_gpu_count": "4",
        "namespace": "default",
        "replicas": "2",
        "queue": "gpu-queue",
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    lines = stdout.strip().split("\n")
    assert 'export DEPLOYMENT_TARGET="hyperpod-eks"' in lines
    assert 'export INSTANCE_TYPE="ml.g5.12xlarge"' in lines
    assert 'export HP_CLUSTER_NAME="my-cluster"' in lines
    assert 'export HP_GPU_COUNT="4"' in lines
    assert 'export HP_NAMESPACE="default"' in lines
    assert 'export HP_REPLICAS="2"' in lines
    assert 'export HP_QUEUE="gpu-queue"' in lines


def test_async_response():
    """Test parsing an async-inference JSON response."""
    data = {
        "target": "async-inference",
        "instance_type": "ml.g5.xlarge",
        "async_output_path": "s3://my-bucket/async-output/",
        "async_sns_topic": "arn:aws:sns:us-east-1:123456:my-topic",
        "async_max_concurrent": "5",
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    lines = stdout.strip().split("\n")
    assert 'export DEPLOYMENT_TARGET="async-inference"' in lines
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in lines
    assert 'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async-output/"' in lines
    assert 'export ASYNC_SNS_TOPIC="arn:aws:sns:us-east-1:123456:my-topic"' in lines
    assert 'export ASYNC_MAX_CONCURRENT="5"' in lines


def test_batch_response():
    """Test parsing a batch-transform JSON response."""
    data = {
        "target": "batch-transform",
        "instance_type": "ml.m5.xlarge",
        "batch_input_path": "s3://my-bucket/input/",
        "batch_output_path": "s3://my-bucket/output/",
        "batch_split_type": "Line",
        "batch_strategy": "MultiRecord",
        "batch_max_concurrent": "3",
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    lines = stdout.strip().split("\n")
    assert 'export DEPLOYMENT_TARGET="batch-transform"' in lines
    assert 'export INSTANCE_TYPE="ml.m5.xlarge"' in lines
    assert 'export BATCH_INPUT_PATH="s3://my-bucket/input/"' in lines
    assert 'export BATCH_OUTPUT_PATH="s3://my-bucket/output/"' in lines
    assert 'export BATCH_SPLIT_TYPE="Line"' in lines
    assert 'export BATCH_STRATEGY="MultiRecord"' in lines
    assert 'export BATCH_MAX_CONCURRENT="3"' in lines


def test_error_response():
    """Test parsing an error JSON response."""
    data = {"error": "No TTY available"}
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    assert "exit 1" in stdout
    assert "No TTY available" in stdout


def test_empty_values_skipped():
    """Test that empty/null values are not exported."""
    data = {
        "target": "managed-inference",
        "instance_type": "ml.g5.xlarge",
        "endpoint_name": "",
        "endpoint_strategy": None,
        "gpu_count": "1",
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    lines = stdout.strip().split("\n")
    assert 'export DEPLOYMENT_TARGET="managed-inference"' in lines
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in lines
    assert 'export IC_GPU_COUNT="1"' in lines
    # Empty/None values should NOT produce export lines
    for line in lines:
        assert "ENDPOINT_NAME" not in line
        assert "ENDPOINT_STRATEGY" not in line


def test_values_with_special_characters():
    """Test that values with special characters are properly escaped."""
    data = {
        "target": "managed-inference",
        "instance_type": "ml.g5.xlarge",
        "endpoint_name": 'my "quoted" endpoint',
    }
    stdout, stderr, rc = run_parser(json.dumps(data))
    assert rc == 0, f"Parser failed: {stderr}"
    # The value should be escaped so bash can safely eval it
    assert "ENDPOINT_NAME" in stdout
