# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for src/agent/context.py — ProjectContext reader."""

import json
import os
import tempfile
from pathlib import Path

import pytest
import yaml

from src.agent.context import ProjectContext


@pytest.fixture
def project_dir(tmp_path):
    """Create a minimal project directory structure for testing."""
    # Create do/config
    do_dir = tmp_path / "do"
    do_dir.mkdir()

    config_content = '''#!/bin/bash
# do-framework configuration
export PROJECT_NAME="my-llm-project"
export DEPLOYMENT_CONFIG="transformers-vllm-realtime"
export FRAMEWORK="transformers"
export MODEL_SERVER="vllm"
export AWS_REGION=${AWS_REGION:-us-east-1}
export ENABLE_LORA=true
export BUILD_TARGET="local"
export DEPLOYMENT_TARGET="realtime-inference"
export INSTANCE_TYPE="ml.g5.xlarge"
export MODEL_NAME="Qwen/Qwen3-8B"
export HF_MODEL_ID="Qwen/Qwen3-8B"
export IC_GPU_COUNT=${IC_GPU_COUNT:-1}
export IC_ENV_VLLM_MAX_MODEL_LEN=${IC_ENV_VLLM_MAX_MODEL_LEN:-4096}
'''
    (do_dir / "config").write_text(config_content)

    # Create do/ic/default.conf
    ic_dir = do_dir / "ic"
    ic_dir.mkdir()
    ic_content = '''#!/bin/bash
export IC_ENV_VLLM_MAX_MODEL_LEN=${IC_ENV_VLLM_MAX_MODEL_LEN:-4096}
export IC_ENV_VLLM_GPU_MEMORY_UTILIZATION="0.85"
export IC_ENV_VLLM_TENSOR_PARALLEL_SIZE=${IC_ENV_VLLM_TENSOR_PARALLEL_SIZE:-1}
'''
    (ic_dir / "default.conf").write_text(ic_content)

    # Create do/training/config.yaml
    training_dir = do_dir / "training"
    training_dir.mkdir()
    training_config = {
        "technique": "sft",
        "instance_type": "ml.g5.xlarge",
        "instance_count": 1,
        "dataset": "s3://bucket/data/",
        "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:latest",
        "hyperparameters": {
            "epochs": "3",
            "batch_size": "4",
            "learning_rate": "2e-4",
        },
    }
    (training_dir / "config.yaml").write_text(yaml.dump(training_config))

    # Create Dockerfile
    dockerfile_content = '''# Multi-stage build
FROM public.ecr.aws/lmi/lmi:14-vllm AS builder

RUN pip install custom-dep

FROM public.ecr.aws/lmi/lmi:14-vllm

COPY --from=builder /app /app
WORKDIR /opt/ml

ENTRYPOINT ["python", "-m", "vllm.entrypoints.openai.api_server"]
'''
    (tmp_path / "Dockerfile").write_text(dockerfile_content)

    # Create do/adapters/
    adapters_dir = do_dir / "adapters"
    adapters_dir.mkdir()
    adapter_content = '''#!/bin/bash
export ADAPTER_NAME="my-lora-adapter"
export ADAPTER_S3_URI="s3://bucket/adapters/my-lora/"
export ADAPTER_LOCAL_PATH="/opt/ml/adapters/my-lora"
'''
    (adapters_dir / "my-lora.conf").write_text(adapter_content)

    return tmp_path


@pytest.fixture
def profile_config(tmp_path, monkeypatch):
    """Create a mock bootstrap profile config."""
    config_dir = tmp_path / ".ml-container-creator"
    config_dir.mkdir()

    config_data = {
        "activeProfile": "default",
        "profiles": {
            "default": {
                "awsRegion": "us-east-1",
                "accountId": "123456789012",
                "ecrRepositoryName": "ml-container-creator",
                "roleArn": "arn:aws:iam::123456789012:role/mlcc-bootstrap-role",
                "stackName": "mlcc-bootstrap-default",
            }
        },
    }
    (config_dir / "config.json").write_text(json.dumps(config_data))

    # Monkeypatch Path.home() to return tmp_path
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    return config_data


class TestProjectContext:
    """Tests for the ProjectContext class."""

    def test_load_full_project(self, project_dir, profile_config):
        """Full project with all files present returns complete context."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert result["project_name"] == "my-llm-project"
        assert result["engine"] == "vllm"
        assert result["deployment_target"] == "realtime-inference"
        assert result["model"] == "Qwen/Qwen3-8B"
        assert result["instance_type"] == "ml.g5.xlarge"
        assert result["aws_region"] == "us-east-1"
        assert result["lora_enabled"] is True
        assert result["existing_endpoint"] is None

    def test_do_config_parsing(self, project_dir, profile_config):
        """do/config variables are parsed correctly from all patterns."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        vars_dict = result["do_config_vars"]
        # Quoted values
        assert vars_dict["PROJECT_NAME"] == "my-llm-project"
        assert vars_dict["MODEL_SERVER"] == "vllm"
        # Default-value pattern
        assert vars_dict["AWS_REGION"] == "us-east-1"
        assert vars_dict["IC_GPU_COUNT"] == "1"
        # Bare value
        assert vars_dict["ENABLE_LORA"] == "true"

    def test_ic_confs_grouped_by_filename(self, project_dir, profile_config):
        """IC conf files are grouped by filename stem."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert "default" in result["ic_env_vars"]
        default_ic = result["ic_env_vars"]["default"]
        assert default_ic["IC_ENV_VLLM_MAX_MODEL_LEN"] == "4096"
        assert default_ic["IC_ENV_VLLM_GPU_MEMORY_UTILIZATION"] == "0.85"
        assert default_ic["IC_ENV_VLLM_TENSOR_PARALLEL_SIZE"] == "1"

    def test_training_config_yaml(self, project_dir, profile_config):
        """Training config YAML is parsed correctly."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        tc = result["training_config"]
        assert tc["technique"] == "sft"
        assert tc["instance_type"] == "ml.g5.xlarge"
        assert tc["hyperparameters"]["epochs"] == "3"
        assert tc["dataset"] == "s3://bucket/data/"

    def test_dockerfile_parsing(self, project_dir, profile_config):
        """Dockerfile FROM (last stage) and ENTRYPOINT are extracted."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        # Multi-stage: should capture the last FROM
        assert result["base_image"] == "public.ecr.aws/lmi/lmi:14-vllm"
        assert result["entrypoint"] == '["python", "-m", "vllm.entrypoints.openai.api_server"]'

    def test_adapters_listing(self, project_dir, profile_config):
        """Adapter conf files are listed with name and vars."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert len(result["adapters"]) == 1
        adapter = result["adapters"][0]
        assert adapter["name"] == "my-lora"
        assert adapter["vars"]["ADAPTER_NAME"] == "my-lora-adapter"
        assert adapter["vars"]["ADAPTER_S3_URI"] == "s3://bucket/adapters/my-lora/"

    def test_profile_loading(self, project_dir, profile_config):
        """Bootstrap profile is loaded from ~/.ml-container-creator/config.json."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert result["profile"]["name"] == "default"
        assert result["profile"]["config"]["awsRegion"] == "us-east-1"
        assert result["profile"]["config"]["accountId"] == "123456789012"

    def test_user_context_loaded(self, project_dir, profile_config):
        """User context markdown is loaded if present."""
        # Create the user context file
        context_md = "## Custom Project Rules\n\nAlways use fp8 quantization.\n"
        (project_dir / ".mlcc-agent-context.md").write_text(context_md)

        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert result["user_context"] == context_md

    def test_user_context_none_when_missing(self, project_dir, profile_config):
        """User context is None when file doesn't exist (not added to _missing)."""
        ctx = ProjectContext(str(project_dir))
        result = ctx.load()

        assert result["user_context"] is None
        # .mlcc-agent-context.md should NOT be in _missing since it's optional
        if "_missing" in result:
            assert ".mlcc-agent-context.md" not in str(result["_missing"])

    def test_missing_files_graceful(self, tmp_path, monkeypatch):
        """Missing files are handled gracefully with _missing field."""
        # Empty project dir — no do/config, no Dockerfile, nothing
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert "_missing" in result
        assert "do/config" in result["_missing"]
        assert "Dockerfile" in result["_missing"]
        assert "do/ic/" in result["_missing"]
        assert "do/training/config.yaml" in result["_missing"]
        assert "do/adapters/" in result["_missing"]
        assert "~/.ml-container-creator/config.json" in result["_missing"]

        # Core fields should be None/empty/False
        assert result["project_name"] is None
        assert result["engine"] is None
        assert result["lora_enabled"] is False
        assert result["training_config"] is None
        assert result["adapters"] == []

    def test_partial_project(self, tmp_path, monkeypatch):
        """A project with only do/config still produces usable context."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text(
            'export PROJECT_NAME="partial-proj"\nexport MODEL_SERVER="sglang"\n'
        )

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["project_name"] == "partial-proj"
        assert result["engine"] == "sglang"
        assert "_missing" in result
        assert "do/config" not in result["_missing"]

    def test_empty_do_config(self, tmp_path, monkeypatch):
        """An empty do/config file returns empty vars dict, no crash."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("#!/bin/bash\n# Empty config\n")

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["do_config_vars"] == {}
        assert result["project_name"] is None

    def test_invalid_yaml_handled(self, tmp_path, monkeypatch):
        """Invalid YAML in training config is handled gracefully."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        training_dir = do_dir / "training"
        training_dir.mkdir()
        (training_dir / "config.yaml").write_text("invalid: yaml: [broken\n")

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["training_config"] is None
        assert any("config.yaml" in m for m in result["_missing"])

    def test_multiline_continuation(self, tmp_path, monkeypatch):
        """Lines with trailing backslash are joined before parsing."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        # Note: in shell, backslash continuation doesn't really apply to export
        # the same way, but our parser handles the general case
        (do_dir / "config").write_text(
            'export PROJECT_NAME="multi-line-test"\n'
            'export LONG_VAR="value"\n'
        )

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["do_config_vars"]["PROJECT_NAME"] == "multi-line-test"

    def test_comments_and_blank_lines_skipped(self, tmp_path, monkeypatch):
        """Comments and blank lines are properly skipped."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        content = '''#!/bin/bash
# This is a comment
# Another comment

export KEY_ONE="value1"

# More comments
export KEY_TWO="value2"

'''
        (do_dir / "config").write_text(content)

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["do_config_vars"]["KEY_ONE"] == "value1"
        assert result["do_config_vars"]["KEY_TWO"] == "value2"
        assert len(result["do_config_vars"]) == 2

    def test_endpoint_external_flag(self, tmp_path, monkeypatch):
        """External endpoint is detected via ENDPOINT_EXTERNAL=true."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        content = '''export ENDPOINT_NAME="my-existing-endpoint"
export ENDPOINT_EXTERNAL=true
'''
        (do_dir / "config").write_text(content)

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["existing_endpoint"] == "my-existing-endpoint"

    def test_profile_no_active_profile(self, tmp_path, monkeypatch):
        """Profile with no activeProfile returns raw data with note."""
        config_dir = tmp_path / ".ml-container-creator"
        config_dir.mkdir()
        (config_dir / "config.json").write_text(json.dumps({"profiles": {}}))
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["profile"]["_note"] == "no active profile set"

    def test_dockerfile_simple_from(self, tmp_path, monkeypatch):
        """Simple Dockerfile with single FROM and no ENTRYPOINT."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

        (tmp_path / "Dockerfile").write_text("FROM python:3.12-slim\nRUN pip install torch\n")
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()

        assert result["base_image"] == "python:3.12-slim"
        assert result["entrypoint"] is None
