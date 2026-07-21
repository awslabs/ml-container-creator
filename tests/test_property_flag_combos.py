"""Property-based test: flag combos produce valid config.

**Validates: Requirements CP-1**

For any generated project, running do/deploy with all required flags for a
target MUST produce a valid do/config that satisfies the target's schema.
No var in the required list may be empty after deployment.

Uses hypothesis to generate random valid flag combinations for each target
and validates the deploy helper always produces a schema-conformant output.
"""
import json
import os
import subprocess

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path constants (same pattern as test_integration_deploy.py)
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DO = os.path.join(REPO_ROOT, "templates", "do")
DEPLOY_HELPER = os.path.join(TEMPLATES_DO, ".deploy_helper.py")
LIB_PYTHON = os.path.join(TEMPLATES_DO, "lib", "python")
VENV_PYTHON = os.path.join(REPO_ROOT, ".venv", "bin", "python3")
PYTHON = VENV_PYTHON if os.path.isfile(VENV_PYTHON) else "python3"

# Import the schema for validation
import sys
sys.path.insert(0, LIB_PYTHON)
from deploy_schema import SCHEMAS, validate_config  # noqa: E402

# ---------------------------------------------------------------------------
# Mock MCP responses (same as integration tests)
# ---------------------------------------------------------------------------

MOCK_MCP_RESPONSES = {
    "instance-sizer/recommend": {
        "instance_type": "ml.g6.xlarge",
        "gpu_count": 1,
        "instances": [
            {"type": "ml.g6.xlarge", "vram_gb": 24},
            {"type": "ml.g6e.xlarge", "vram_gb": 48},
        ],
    },
    "endpoint-picker/list": {
        "endpoints": [
            {"name": "existing-ep-1", "status": "InService"},
            {"name": "existing-ep-2", "status": "InService"},
        ],
    },
    "cluster-picker/list": {
        "clusters": [
            {"name": "hp-cluster-1", "gpu_capacity": 8, "queues": ["default", "gpu-queue"]},
            {"name": "hp-cluster-2", "gpu_capacity": 16, "queues": ["priority"]},
        ],
    },
}

# ---------------------------------------------------------------------------
# Hypothesis strategies for generating realistic values
# ---------------------------------------------------------------------------

# Instance types: ml.<family>.<size>
_INSTANCE_FAMILIES = ["g5", "g6", "g6e", "p4d", "p5", "inf2", "trn1"]
_INSTANCE_SIZES = ["xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "48xlarge"]

st_instance_type = st.builds(
    lambda fam, size: f"ml.{fam}.{size}",
    st.sampled_from(_INSTANCE_FAMILIES),
    st.sampled_from(_INSTANCE_SIZES),
)

# Endpoint names: alphanumeric with hyphens, 1-63 chars
st_endpoint_name = st.from_regex(r"[a-z][a-z0-9\-]{2,30}", fullmatch=True)

# Endpoint strategies
st_endpoint_strategy = st.sampled_from(["new", "existing", "heterogeneous"])

# GPU counts: 1, 2, 4, 8
st_gpu_count = st.sampled_from(["1", "2", "4", "8"])

# Instance types list (comma-separated, 1-5 entries)
st_instance_types_list = st.lists(
    st_instance_type,
    min_size=1,
    max_size=5,
).map(lambda types: ",".join(types))

# S3 paths
st_s3_path = st.builds(
    lambda bucket, prefix: f"s3://{bucket}/{prefix}/",
    st.from_regex(r"[a-z][a-z0-9\-]{3,20}", fullmatch=True),
    st.from_regex(r"[a-z0-9\-/]{1,30}", fullmatch=True),
)

# Cluster names
st_cluster_name = st.from_regex(r"[a-z][a-z0-9\-]{2,20}", fullmatch=True)

# Namespace names
st_namespace = st.sampled_from(["default", "ml-inference", "gpu-workloads", "production"])

# Replicas: 1-8
st_replicas = st.integers(min_value=1, max_value=8).map(str)

# Queue names
st_queue = st.sampled_from(["default", "gpu-queue", "priority", "batch"])

# SNS topic ARN (or empty)
st_sns_topic = st.one_of(
    st.just(""),
    st.builds(
        lambda region, acct, name: f"arn:aws:sns:{region}:{acct}:{name}",
        st.sampled_from(["us-east-1", "us-west-2", "eu-west-1"]),
        st.from_regex(r"[0-9]{12}", fullmatch=True),
        st.from_regex(r"[a-z][a-z0-9\-]{3,20}", fullmatch=True),
    ),
)

# Max concurrent: 1-10
st_max_concurrent = st.integers(min_value=1, max_value=10).map(str)

# Batch split type
st_batch_split_type = st.sampled_from(["Line", "RecordIO", "None"])

# Batch strategy
st_batch_strategy = st.sampled_from(["MultiRecord", "SingleRecord"])


# ---------------------------------------------------------------------------
# Composite strategies per target
# ---------------------------------------------------------------------------

@st.composite
def st_managed_inference_answers(draw):
    """Generate a valid answer dict for managed-inference target."""
    return {
        "target": "managed-inference",
        "instance_type": draw(st_instance_type),
        "endpoint_name": draw(st_endpoint_name),
        "endpoint_strategy": draw(st_endpoint_strategy),
        "gpu_count": draw(st_gpu_count),
        "instance_types": draw(st_instance_types_list),
    }


@st.composite
def st_hyperpod_eks_answers(draw):
    """Generate a valid answer dict for hyperpod-eks target."""
    return {
        "target": "hyperpod-eks",
        "instance_type": draw(st_instance_type),
        "cluster_name": draw(st_cluster_name),
        "hp_gpu_count": draw(st_gpu_count),
        "namespace": draw(st_namespace),
        "replicas": draw(st_replicas),
        "queue": draw(st_queue),
    }


@st.composite
def st_async_inference_answers(draw):
    """Generate a valid answer dict for async-inference target."""
    return {
        "target": "async-inference",
        "instance_type": draw(st_instance_type),
        "async_output_path": draw(st_s3_path),
        "async_sns_topic": draw(st_sns_topic),
        "async_max_concurrent": draw(st_max_concurrent),
    }


@st.composite
def st_batch_transform_answers(draw):
    """Generate a valid answer dict for batch-transform target."""
    return {
        "target": "batch-transform",
        "instance_type": draw(st_instance_type),
        "batch_input_path": draw(st_s3_path),
        "batch_output_path": draw(st_s3_path),
        "batch_split_type": draw(st_batch_split_type),
        "batch_strategy": draw(st_batch_strategy),
        "batch_max_concurrent": draw(st_max_concurrent),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Mapping from JSON answer keys to schema variable names (for validation)
_ANSWER_KEY_TO_SCHEMA_VAR = {
    "instance_type": "INSTANCE_TYPE",
    "endpoint_name": "ENDPOINT_NAME",
    "endpoint_strategy": "ENDPOINT_STRATEGY",
    "gpu_count": "IC_GPU_COUNT",
    "instance_types": "INSTANCE_TYPES",
    "cluster_name": "HP_CLUSTER_NAME",
    "hp_gpu_count": "HP_GPU_COUNT",
    "namespace": "HP_NAMESPACE",
    "replicas": "HP_REPLICAS",
    "queue": "HP_QUEUE",
    "async_output_path": "ASYNC_S3_OUTPUT_PATH",
    "async_sns_topic": "ASYNC_SNS_TOPIC",
    "async_max_concurrent": "ASYNC_MAX_CONCURRENT",
    "batch_input_path": "BATCH_INPUT_PATH",
    "batch_output_path": "BATCH_OUTPUT_PATH",
    "batch_split_type": "BATCH_SPLIT_TYPE",
    "batch_strategy": "BATCH_STRATEGY",
    "batch_max_concurrent": "BATCH_MAX_CONCURRENT",
}


def _write_config(tmpdir: str, lines: list[str]) -> str:
    """Write a minimal do/config file and return its path."""
    config_path = os.path.join(tmpdir, "config")
    with open(config_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return config_path


def _run_deploy_helper(tmpdir: str, answers: dict) -> subprocess.CompletedProcess:
    """Run .deploy_helper.py prompt with answers provided via --answers-file."""
    config_path = _write_config(tmpdir, [
        'export DEPLOYMENT_TARGET=""',
        'export INSTANCE_TYPE=""',
        'export MODEL_NAME="meta-llama/Llama-2-7b-hf"',
        'export PROJECT_NAME="test-project"',
    ])

    env = os.environ.copy()
    env["MCP_MOCK_RESPONSES"] = json.dumps(MOCK_MCP_RESPONSES)
    env["PYTHONPATH"] = LIB_PYTHON

    # Write answers to a temp file
    answers_file = os.path.join(tmpdir, "_test_answers.json")
    with open(answers_file, "w") as f:
        json.dump(answers, f)

    cmd = [
        PYTHON,
        DEPLOY_HELPER,
        "prompt",
        "--config-file",
        config_path,
        "--answers-file",
        answers_file,
    ]

    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        timeout=30.0,
    )


def _validate_output_against_schema(output: dict, target: str) -> None:
    """Validate the JSON output satisfies the target's schema.

    Checks:
    1. All required vars for the target are present and non-empty in output
    2. Output values match what was provided (no corruption)
    """
    schema = SCHEMAS[target]

    # Map output keys to config variable names for schema validation
    config_vars: dict[str, str] = {}
    for key, value in output.items():
        var_name = _ANSWER_KEY_TO_SCHEMA_VAR.get(key)
        if var_name:
            config_vars[var_name] = value

    # Validate: all required vars must be non-empty
    missing = validate_config(target, config_vars)
    assert missing == [], (
        f"Schema validation failed for {target}: "
        f"missing/empty required vars: {missing}. "
        f"Output was: {output}"
    )


def _validate_no_corruption(output: dict, answers: dict) -> None:
    """Validate output values match provided answers (no corruption).

    For keys present in both the answers and output, the values must match.
    This ensures the prompt engine does not corrupt or mutate user-provided values.
    """
    for key, expected_value in answers.items():
        if key in output:
            assert output[key] == expected_value, (
                f"Value corruption detected for key '{key}': "
                f"expected {expected_value!r}, got {output[key]!r}"
            )


# ---------------------------------------------------------------------------
# Property-based tests
# ---------------------------------------------------------------------------


class TestFlagCombosProduceValidConfig:
    """Property: any valid flag combination produces a schema-valid config.

    **Validates: Requirements CP-1**

    For any generated project, running do/deploy with all required flags for a
    target MUST produce a valid do/config that satisfies the target's schema.
    No var in the required list may be empty after deployment.
    """

    @given(answers=st_managed_inference_answers())
    @settings(
        max_examples=20,
        deadline=30000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_managed_inference_valid_config(self, answers, tmp_path_factory):
        """Any valid managed-inference flag combo produces schema-valid output."""
        tmpdir = str(tmp_path_factory.mktemp("mi"))
        result = _run_deploy_helper(tmpdir, answers)

        assert result.returncode == 0, (
            f"Deploy helper failed: stderr={result.stderr}, stdout={result.stdout}"
        )

        output = json.loads(result.stdout)
        assert output["target"] == "managed-inference"

        _validate_output_against_schema(output, "managed-inference")
        _validate_no_corruption(output, answers)

    @given(answers=st_hyperpod_eks_answers())
    @settings(
        max_examples=20,
        deadline=30000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_hyperpod_eks_valid_config(self, answers, tmp_path_factory):
        """Any valid hyperpod-eks flag combo produces schema-valid output."""
        tmpdir = str(tmp_path_factory.mktemp("hp"))
        result = _run_deploy_helper(tmpdir, answers)

        assert result.returncode == 0, (
            f"Deploy helper failed: stderr={result.stderr}, stdout={result.stdout}"
        )

        output = json.loads(result.stdout)
        assert output["target"] == "hyperpod-eks"

        _validate_output_against_schema(output, "hyperpod-eks")
        _validate_no_corruption(output, answers)

    @given(answers=st_async_inference_answers())
    @settings(
        max_examples=20,
        deadline=30000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_async_inference_valid_config(self, answers, tmp_path_factory):
        """Any valid async-inference flag combo produces schema-valid output."""
        tmpdir = str(tmp_path_factory.mktemp("async"))
        result = _run_deploy_helper(tmpdir, answers)

        assert result.returncode == 0, (
            f"Deploy helper failed: stderr={result.stderr}, stdout={result.stdout}"
        )

        output = json.loads(result.stdout)
        assert output["target"] == "async-inference"

        _validate_output_against_schema(output, "async-inference")
        _validate_no_corruption(output, answers)

    @given(answers=st_batch_transform_answers())
    @settings(
        max_examples=20,
        deadline=30000,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_batch_transform_valid_config(self, answers, tmp_path_factory):
        """Any valid batch-transform flag combo produces schema-valid output."""
        tmpdir = str(tmp_path_factory.mktemp("batch"))
        result = _run_deploy_helper(tmpdir, answers)

        assert result.returncode == 0, (
            f"Deploy helper failed: stderr={result.stderr}, stdout={result.stdout}"
        )

        output = json.loads(result.stdout)
        assert output["target"] == "batch-transform"

        _validate_output_against_schema(output, "batch-transform")
        _validate_no_corruption(output, answers)
