"""Unit tests for deploy_prompts module.

Validates: Requirements FR-2.1, FR-2.2, FR-2.3, FR-3.3, NFR-3.1
"""
from __future__ import annotations

import json
import os
import tempfile

import pytest

from deploy_prompts import (
    TARGETS,
    _ANSWER_KEY_TO_VAR,
    _VAR_TO_ANSWER_KEY,
    _MCP_FALLBACK_WARNING,
    build_answer_json,
    detect_gpu_count,
    diff_config,
    get_clusters,
    get_endpoints,
    get_instance_recommendation,
    load_answers_from_env,
    parse_config,
    prompt_async_s3_output_path,
    prompt_batch_output_path,
    prompt_cluster_name,
    prompt_endpoint_name,
    prompt_endpoint_strategy,
    prompt_for_missing,
    prompt_gpu_count,
    prompt_hp_gpu_count,
    prompt_instance_type,
    prompt_instance_types,
    prompt_target_selection,
    validate_instance_types,
)


# ---------------------------------------------------------------------------
# Config parsing tests
# ---------------------------------------------------------------------------


class TestParseConfig:
    """Test parsing of bash export VAR='value' config files."""

    def test_parse_double_quoted_values(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        )
        result = parse_config(str(config))
        assert result["DEPLOYMENT_TARGET"] == "managed-inference"
        assert result["INSTANCE_TYPE"] == "ml.g5.xlarge"

    def test_parse_single_quoted_values(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text("export ENDPOINT_NAME='my-endpoint'\n")
        result = parse_config(str(config))
        assert result["ENDPOINT_NAME"] == "my-endpoint"

    def test_parse_unquoted_values(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text("export HP_REPLICAS=3\n")
        result = parse_config(str(config))
        assert result["HP_REPLICAS"] == "3"

    def test_parse_empty_values(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text('export DEPLOYMENT_TARGET=""\n')
        result = parse_config(str(config))
        assert result["DEPLOYMENT_TARGET"] == ""

    def test_parse_with_trailing_comment(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text(
            'export DEPLOYMENT_TARGET="managed-inference" # Active target\n'
        )
        result = parse_config(str(config))
        assert result["DEPLOYMENT_TARGET"] == "managed-inference"

    def test_parse_skips_non_export_lines(self, tmp_path) -> None:
        config = tmp_path / "config"
        config.write_text(
            "# Comment line\n"
            "\n"
            "export VALID_VAR=\"value\"\n"
            "NOT_EXPORTED=ignored\n"
        )
        result = parse_config(str(config))
        assert "VALID_VAR" in result
        assert "NOT_EXPORTED" not in result

    def test_parse_nonexistent_file_returns_empty(self) -> None:
        result = parse_config("/nonexistent/path/config")
        assert result == {}

    def test_parse_complex_value_with_timestamp(self, tmp_path) -> None:
        """Real-world do/config line with sed-appended timestamp."""
        config = tmp_path / "config"
        config.write_text(
            'export DEPLOYMENT_TARGET="managed-inference" '
            '# Active target — set by: do/deploy --target managed-inference (2024-01-15T10:30:00Z)\n'
        )
        result = parse_config(str(config))
        assert result["DEPLOYMENT_TARGET"] == "managed-inference"


# ---------------------------------------------------------------------------
# Config diffing tests
# ---------------------------------------------------------------------------


class TestDiffConfig:
    """Test config diffing correctly identifies missing vars."""

    def test_all_required_present_returns_only_optional(self) -> None:
        """When all required vars are set, only unset optional vars are returned."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge", "ENDPOINT_NAME": "ep"}
        result = diff_config("managed-inference", config)
        # Required vars should NOT be in missing
        assert "INSTANCE_TYPE" not in result
        assert "ENDPOINT_NAME" not in result
        # Optional vars that are not in config should be there with defaults
        assert "ENDPOINT_STRATEGY" in result
        assert result["ENDPOINT_STRATEGY"] == "new"

    def test_missing_required_has_none_default(self) -> None:
        """Missing required vars have None as their default."""
        config = {"INSTANCE_TYPE": "ml.g5.xlarge"}
        result = diff_config("managed-inference", config)
        assert "ENDPOINT_NAME" in result
        assert result["ENDPOINT_NAME"] is None

    def test_empty_required_treated_as_missing(self) -> None:
        """Empty string required vars are treated as missing."""
        config = {"INSTANCE_TYPE": "", "ENDPOINT_NAME": "ep"}
        result = diff_config("managed-inference", config)
        assert "INSTANCE_TYPE" in result
        assert result["INSTANCE_TYPE"] is None

    def test_all_missing_for_batch(self) -> None:
        """When no vars are set, all required + optional are missing."""
        result = diff_config("batch-transform", {})
        # All 3 required vars
        assert "INSTANCE_TYPE" in result
        assert "BATCH_INPUT_PATH" in result
        assert "BATCH_OUTPUT_PATH" in result
        # Optional vars with defaults
        assert result["BATCH_SPLIT_TYPE"] == "Line"
        assert result["BATCH_STRATEGY"] == "MultiRecord"
        assert result["BATCH_MAX_CONCURRENT"] == "1"

    def test_optional_already_set_not_in_missing(self) -> None:
        """Optional vars already set in config are NOT returned as missing."""
        config = {
            "INSTANCE_TYPE": "ml.g5.xlarge",
            "ENDPOINT_NAME": "ep",
            "ENDPOINT_STRATEGY": "existing",
            "IC_GPU_COUNT": "2",
            "INSTANCE_TYPES": "ml.g5.xlarge",
        }
        result = diff_config("managed-inference", config)
        assert result == {}

    def test_unknown_target_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown target"):
            diff_config("invalid-target", {})

    def test_partial_config_fr33(self) -> None:
        """FR-3.3: Partial flags prompt only for missing values.

        Validates: Requirements FR-3.3
        """
        # User has set target and instance type via flags
        config = {"INSTANCE_TYPE": "ml.g5.xlarge", "HP_CLUSTER_NAME": "my-cluster"}
        result = diff_config("hyperpod-eks", config)
        # Required vars are all set — only optional vars should be missing
        assert "INSTANCE_TYPE" not in result
        assert "HP_CLUSTER_NAME" not in result
        # Optional unset vars
        assert "HP_GPU_COUNT" in result
        assert "HP_NAMESPACE" in result


# ---------------------------------------------------------------------------
# DEPLOY_ANSWERS env var tests
# ---------------------------------------------------------------------------


class TestDeployAnswersEnv:
    """Test DEPLOY_ANSWERS environment variable parsing.

    Validates: Requirements NFR-3.1
    """

    def test_returns_none_when_not_set(self, monkeypatch) -> None:
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        result = load_answers_from_env()
        assert result is None

    def test_returns_none_for_empty_string(self, monkeypatch) -> None:
        monkeypatch.setenv("DEPLOY_ANSWERS", "")
        result = load_answers_from_env()
        assert result is None

    def test_parses_target_answer(self, monkeypatch) -> None:
        monkeypatch.setenv(
            "DEPLOY_ANSWERS",
            '{"target":"managed-inference","instance_type":"ml.g5.xlarge"}'
        )
        result = load_answers_from_env()
        assert result is not None
        assert result["DEPLOYMENT_TARGET"] == "managed-inference"
        assert result["INSTANCE_TYPE"] == "ml.g5.xlarge"

    def test_maps_all_known_keys(self, monkeypatch) -> None:
        answers = {
            "target": "hyperpod-eks",
            "cluster_name": "my-cluster",
            "namespace": "production",
            "replicas": "2",
        }
        monkeypatch.setenv("DEPLOY_ANSWERS", json.dumps(answers))
        result = load_answers_from_env()
        assert result is not None
        assert result["DEPLOYMENT_TARGET"] == "hyperpod-eks"
        assert result["HP_CLUSTER_NAME"] == "my-cluster"
        assert result["HP_NAMESPACE"] == "production"
        assert result["HP_REPLICAS"] == "2"

    def test_invalid_json_exits(self, monkeypatch) -> None:
        monkeypatch.setenv("DEPLOY_ANSWERS", "not-valid-json{")
        with pytest.raises(SystemExit):
            load_answers_from_env()

    def test_passes_through_var_names_directly(self, monkeypatch) -> None:
        """If keys match config var names directly, they pass through."""
        monkeypatch.setenv(
            "DEPLOY_ANSWERS",
            '{"INSTANCE_TYPE":"ml.p4d.24xlarge"}'
        )
        result = load_answers_from_env()
        assert result is not None
        assert result["INSTANCE_TYPE"] == "ml.p4d.24xlarge"


# ---------------------------------------------------------------------------
# Target selection tests
# ---------------------------------------------------------------------------


class TestTargetSelection:
    """Test target selection logic.

    Validates: Requirements FR-2.2
    """

    def test_pre_set_target_returns_immediately(self) -> None:
        """When target is provided via flag, no prompt is shown."""
        result = prompt_target_selection("managed-inference")
        assert result == "managed-inference"

    def test_pre_set_target_preserves_value(self) -> None:
        result = prompt_target_selection("hyperpod-eks")
        assert result == "hyperpod-eks"

    def test_targets_list_has_all_four(self) -> None:
        """All four deployment targets are available."""
        values = [t["value"] for t in TARGETS]
        assert "managed-inference" in values
        assert "async-inference" in values
        assert "batch-transform" in values
        assert "hyperpod-eks" in values


# ---------------------------------------------------------------------------
# Answer JSON output tests
# ---------------------------------------------------------------------------


class TestBuildAnswerJson:
    """Test JSON answer output format.

    Validates: Requirements FR-2.1
    """

    def test_managed_inference_output(self) -> None:
        answers = {
            "INSTANCE_TYPE": "ml.g5.xlarge",
            "ENDPOINT_NAME": "project-ep",
        }
        config = {}
        result = build_answer_json("managed-inference", answers, config)
        assert result["target"] == "managed-inference"
        assert result["instance_type"] == "ml.g5.xlarge"
        assert result["endpoint_name"] == "project-ep"
        # Optional defaults should be included
        assert result["endpoint_strategy"] == "new"

    def test_existing_config_values_included(self) -> None:
        """Already-set config values appear in the answer JSON."""
        answers = {}
        config = {
            "INSTANCE_TYPE": "ml.g5.xlarge",
            "ENDPOINT_NAME": "existing-ep",
            "ENDPOINT_STRATEGY": "existing",
            "IC_GPU_COUNT": "2",
            "INSTANCE_TYPES": "ml.g5.xlarge,ml.g6.xlarge",
        }
        result = build_answer_json("managed-inference", answers, config)
        assert result["target"] == "managed-inference"
        assert result["instance_type"] == "ml.g5.xlarge"
        assert result["endpoint_name"] == "existing-ep"
        assert result["endpoint_strategy"] == "existing"

    def test_new_answers_override_config(self) -> None:
        """New answers take priority over existing config."""
        answers = {"INSTANCE_TYPE": "ml.g6.xlarge"}
        config = {"INSTANCE_TYPE": "ml.g5.xlarge", "ENDPOINT_NAME": "ep"}
        result = build_answer_json("managed-inference", answers, config)
        assert result["instance_type"] == "ml.g6.xlarge"

    def test_batch_transform_output(self) -> None:
        answers = {
            "INSTANCE_TYPE": "ml.m5.xlarge",
            "BATCH_INPUT_PATH": "s3://bucket/input/",
            "BATCH_OUTPUT_PATH": "s3://bucket/output/",
        }
        result = build_answer_json("batch-transform", answers, {})
        assert result["target"] == "batch-transform"
        assert result["instance_type"] == "ml.m5.xlarge"
        assert result["batch_input_path"] == "s3://bucket/input/"
        assert result["batch_output_path"] == "s3://bucket/output/"
        assert result["batch_split_type"] == "Line"
        assert result["batch_strategy"] == "MultiRecord"
        assert result["batch_max_concurrent"] == "1"

    def test_hyperpod_output(self) -> None:
        answers = {
            "INSTANCE_TYPE": "ml.p4d.24xlarge",
            "HP_CLUSTER_NAME": "prod-cluster",
        }
        result = build_answer_json("hyperpod-eks", answers, {})
        assert result["target"] == "hyperpod-eks"
        assert result["instance_type"] == "ml.p4d.24xlarge"
        assert result["cluster_name"] == "prod-cluster"
        assert result["namespace"] == "default"
        assert result["replicas"] == "1"

    def test_output_is_json_serializable(self) -> None:
        """Ensure the output can be serialized to JSON without errors."""
        answers = {"INSTANCE_TYPE": "ml.g5.xlarge", "ENDPOINT_NAME": "ep"}
        result = build_answer_json("managed-inference", answers, {})
        serialized = json.dumps(result)
        parsed = json.loads(serialized)
        assert parsed["target"] == "managed-inference"


# ---------------------------------------------------------------------------
# MCP fallback integration tests
# ---------------------------------------------------------------------------


class TestGetInstanceRecommendation:
    """Test get_instance_recommendation MCP-to-heuristic fallback.

    Validates: Requirements FR-2.4, FR-10.1, FR-10.2, FR-10.4
    """

    def test_uses_mcp_when_available(self, monkeypatch, capsys) -> None:
        """When MCP is available and returns a result, use MCP result."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.2xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        result = get_instance_recommendation("meta-llama/Llama-2-7b-hf", "float16")

        assert result == "ml.g5.2xlarge"
        # No warning should be printed to stderr when MCP works
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_falls_back_to_heuristic_when_mcp_unavailable(self, monkeypatch, capsys) -> None:
        """When MCP is unavailable (no socket, no config), use built-in heuristic."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        # Patch instance_sizer.recommend_for_model to avoid HF hub call
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g6.xlarge",
        )

        result = get_instance_recommendation("test-model/7b", "float16")

        assert result == "ml.g6.xlarge"
        # Warning should be printed to stderr
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_falls_back_when_mcp_returns_none(self, monkeypatch, capsys) -> None:
        """When MCP is available but returns None (timeout), fall back with warning."""
        # Mock with empty responses so instance-sizer/recommend returns None
        mock_responses = {}
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g6e.xlarge",
        )

        result = get_instance_recommendation("timeout-model/13b", "float16")

        assert result == "ml.g6e.xlarge"
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_warning_not_on_stdout(self, monkeypatch, capsys) -> None:
        """Warning goes to stderr, NOT stdout (protects JSON output contract)."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g6.xlarge",
        )

        get_instance_recommendation("test-model/7b", "float16")

        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.out
        assert _MCP_FALLBACK_WARNING in captured.err


class TestGetEndpoints:
    """Test get_endpoints MCP-to-empty-list fallback.

    Validates: Requirements FR-2.4, FR-10.2
    """

    def test_uses_mcp_when_available(self, monkeypatch, capsys) -> None:
        """When MCP returns endpoints, use them."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-1", "status": "InService"},
                    {"name": "ep-2", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        result = get_endpoints("us-east-1")

        assert result == ["ep-1", "ep-2"]
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_returns_empty_when_mcp_unavailable(self, monkeypatch, capsys) -> None:
        """When MCP is unavailable, return empty list with warning."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        result = get_endpoints("us-west-2")

        assert result == []
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_returns_empty_when_mcp_returns_empty(self, monkeypatch, capsys) -> None:
        """When MCP returns empty list (no endpoints), fall back with warning."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": []
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        result = get_endpoints("eu-west-1")

        assert result == []
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err


class TestGetClusters:
    """Test get_clusters MCP-to-empty-list fallback.

    Validates: Requirements FR-2.4, FR-10.2
    """

    def test_uses_mcp_when_available(self, monkeypatch, capsys) -> None:
        """When MCP returns clusters, use them."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "cluster-1", "gpu_capacity": 8, "queues": ["default"]},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        result = get_clusters("us-east-1")

        assert len(result) == 1
        assert result[0]["name"] == "cluster-1"
        assert result[0]["gpu_capacity"] == 8
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.err

    def test_returns_empty_when_mcp_unavailable(self, monkeypatch, capsys) -> None:
        """When MCP is unavailable, return empty list with warning."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        result = get_clusters("us-west-2")

        assert result == []
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_returns_empty_when_mcp_returns_empty(self, monkeypatch, capsys) -> None:
        """When MCP returns no clusters, fall back with warning."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": []
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        result = get_clusters("ap-southeast-1")

        assert result == []
        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING in captured.err

    def test_warning_not_on_stdout(self, monkeypatch, capsys) -> None:
        """Warning goes to stderr, NOT stdout (protects JSON output contract)."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        get_clusters("us-east-1")

        captured = capsys.readouterr()
        assert _MCP_FALLBACK_WARNING not in captured.out
        assert _MCP_FALLBACK_WARNING in captured.err


# ---------------------------------------------------------------------------
# Instance type prompt with MCP sizer default tests
# ---------------------------------------------------------------------------


class TestPromptInstanceType:
    """Test prompt_instance_type uses MCP sizer recommendation as default.

    Validates: Requirements FR-5.1
    """

    def test_uses_mcp_recommendation_as_default(self, monkeypatch) -> None:
        """When MCP returns a recommendation, it is used as the prompt default."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.2xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        # Mock questionary.text to capture what default is passed
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf"}
        result = prompt_instance_type(config_vars)

        assert result == "ml.g5.2xlarge"
        assert captured_kwargs["default"] == "ml.g5.2xlarge"
        assert "recommended: ml.g5.2xlarge" in captured_kwargs["message"]

    def test_falls_back_to_heuristic_when_mcp_unavailable(self, monkeypatch) -> None:
        """When MCP is unavailable, built-in heuristic provides the default."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g6.xlarge",
        )

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "test-model/7b"}
        result = prompt_instance_type(config_vars)

        assert result == "ml.g6.xlarge"
        assert captured_kwargs["default"] == "ml.g6.xlarge"
        assert "recommended: ml.g6.xlarge" in captured_kwargs["message"]

    def test_no_model_name_uses_fallback_default(self, monkeypatch) -> None:
        """When no model name is in config, uses the provided fallback default."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}  # No MODEL_NAME or HF_MODEL_ID
        result = prompt_instance_type(config_vars, default="ml.m5.xlarge")

        # No recommendation possible, uses provided default
        assert result == "ml.m5.xlarge"
        assert captured_kwargs["default"] == "ml.m5.xlarge"
        assert "recommended:" not in captured_kwargs["message"]

    def test_uses_hf_model_id_when_model_name_absent(self, monkeypatch) -> None:
        """Falls back to HF_MODEL_ID when MODEL_NAME is not set."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g6e.xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"HF_MODEL_ID": "meta-llama/Llama-2-13b-hf"}
        result = prompt_instance_type(config_vars)

        assert result == "ml.g6e.xlarge"
        assert "recommended: ml.g6e.xlarge" in captured_kwargs["message"]

    def test_recommendation_none_uses_empty_default(self, monkeypatch) -> None:
        """When recommendation returns None and no fallback, default is empty."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: None,
        )

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "unknown-model/1b"}
        result = prompt_instance_type(config_vars)

        assert result == ""
        assert captured_kwargs["default"] == ""
        assert "recommended:" not in captured_kwargs["message"]


class TestPromptForMissingWithInstanceType:
    """Test prompt_for_missing routes INSTANCE_TYPE through prompt_instance_type.

    Validates: Requirements FR-5.1
    """

    def test_instance_type_uses_mcp_prompt_when_config_provided(self, monkeypatch) -> None:
        """When config_vars is provided, INSTANCE_TYPE uses MCP-aware prompt."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def __init__(self, default):
                self._default = default

            def ask(self):
                return self._default

        def fake_text(message, **kwargs):
            return FakeQuestion(kwargs.get("default", ""))

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf", "PROJECT_NAME": "test-project"}
        missing = {"INSTANCE_TYPE": None, "ENDPOINT_NAME": None}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.g5.xlarge"
        assert result["ENDPOINT_NAME"] == "test-project-ep"

    def test_env_answers_bypass_mcp_prompt(self, monkeypatch) -> None:
        """When env answers provide INSTANCE_TYPE, MCP prompt is skipped."""
        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf"}
        missing = {"INSTANCE_TYPE": None}
        env_answers = {"INSTANCE_TYPE": "ml.p4d.24xlarge"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.p4d.24xlarge"


# ---------------------------------------------------------------------------
# Endpoint strategy prompt tests
# ---------------------------------------------------------------------------


class TestPromptEndpointStrategy:
    """Test prompt_endpoint_strategy offers 3 human-friendly options.

    Validates: Requirements FR-5.2
    """

    def test_returns_new_when_selected(self, monkeypatch) -> None:
        """Selecting 'New endpoint (single instance type)' returns 'new'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "new"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        result = prompt_endpoint_strategy()

        assert result == "new"
        assert captured_kwargs["message"] == "Endpoint strategy:"

    def test_returns_heterogeneous_when_selected(self, monkeypatch) -> None:
        """Selecting heterogeneous option returns 'heterogeneous'."""
        class FakeQuestion:
            def ask(self):
                return "heterogeneous"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        result = prompt_endpoint_strategy()

        assert result == "heterogeneous"

    def test_returns_existing_when_selected(self, monkeypatch) -> None:
        """Selecting 'Attach to existing endpoint' returns 'existing'."""
        class FakeQuestion:
            def ask(self):
                return "existing"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        result = prompt_endpoint_strategy()

        assert result == "existing"

    def test_choices_have_correct_titles_and_values(self, monkeypatch) -> None:
        """All 3 choices have human-friendly titles mapped to internal values."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "new"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        prompt_endpoint_strategy()

        choices = captured_kwargs["choices"]
        assert len(choices) == 3

        # Verify each choice title and value
        assert choices[0].title == "New endpoint (single instance type)"
        assert choices[0].value == "new"
        assert choices[1].title == "New endpoint (heterogeneous \u2014 availability-ordered fallback)"
        assert choices[1].value == "heterogeneous"
        assert choices[2].title == "Attach to existing endpoint"
        assert choices[2].value == "existing"

    def test_default_is_new_when_none_provided(self, monkeypatch) -> None:
        """When no default is provided, defaults to 'new'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "new"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        prompt_endpoint_strategy()

        assert captured_kwargs["default"] == "new"

    def test_default_passes_through_valid_value(self, monkeypatch) -> None:
        """When a valid default is provided, it is passed to questionary."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "existing"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        prompt_endpoint_strategy(default="existing")

        assert captured_kwargs["default"] == "existing"

    def test_invalid_default_falls_back_to_new(self, monkeypatch) -> None:
        """When an invalid default is provided, falls back to 'new'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "new"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        prompt_endpoint_strategy(default="invalid-value")

        assert captured_kwargs["default"] == "new"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        class FakeQuestion:
            def ask(self):
                return None

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        with pytest.raises(SystemExit):
            prompt_endpoint_strategy()


class TestPromptForMissingWithEndpointStrategy:
    """Test prompt_for_missing routes ENDPOINT_STRATEGY to prompt_endpoint_strategy.

    Validates: Requirements FR-5.2
    """

    def test_endpoint_strategy_routes_to_dedicated_prompt(self, monkeypatch) -> None:
        """ENDPOINT_STRATEGY uses prompt_endpoint_strategy, not prompt_for_var."""
        captured_calls: list = []

        class FakeQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_select(message, **kwargs):
            captured_calls.append(("select", message, kwargs))
            return FakeQuestion("new")

        monkeypatch.setattr("questionary.select", fake_select)

        missing = {"ENDPOINT_STRATEGY": "new"}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["ENDPOINT_STRATEGY"] == "new"
        # Verify it used questionary.select (from prompt_endpoint_strategy)
        assert len(captured_calls) == 1
        assert captured_calls[0][1] == "Endpoint strategy:"
        # Verify choices have Choice objects (not plain strings)
        choices = captured_calls[0][2]["choices"]
        assert len(choices) == 3
        assert choices[0].value == "new"

    def test_env_answers_bypass_endpoint_strategy_prompt(self, monkeypatch) -> None:
        """When env answers provide ENDPOINT_STRATEGY, dedicated prompt is skipped."""
        missing = {"ENDPOINT_STRATEGY": "new"}
        env_answers = {"ENDPOINT_STRATEGY": "existing"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["ENDPOINT_STRATEGY"] == "existing"


# ---------------------------------------------------------------------------
# Heterogeneous instance types multi-select tests
# ---------------------------------------------------------------------------


class TestValidateInstanceTypes:
    """Test validate_instance_types validation logic.

    Validates: Requirements FR-5.4
    """

    def test_valid_single_type(self) -> None:
        assert validate_instance_types("ml.g5.xlarge") is None

    def test_valid_multiple_types(self) -> None:
        assert validate_instance_types("ml.g5.xlarge,ml.g5.2xlarge,ml.g6.xlarge") is None

    def test_valid_max_five_types(self) -> None:
        types = "ml.g5.xlarge,ml.g5.2xlarge,ml.g6.xlarge,ml.p4d.24xlarge,ml.p5.48xlarge"
        assert validate_instance_types(types) is None

    def test_rejects_empty_string(self) -> None:
        error = validate_instance_types("")
        assert error is not None
        assert "At least one" in error

    def test_rejects_more_than_five(self) -> None:
        types = "ml.a.b,ml.b.c,ml.c.d,ml.d.e,ml.e.f,ml.f.g"
        error = validate_instance_types(types)
        assert error is not None
        assert "Maximum 5" in error

    def test_rejects_invalid_pattern(self) -> None:
        error = validate_instance_types("invalid-type")
        assert error is not None
        assert "Invalid instance type" in error

    def test_rejects_partial_invalid(self) -> None:
        error = validate_instance_types("ml.g5.xlarge,bad-type")
        assert error is not None
        assert "Invalid instance type" in error

    def test_handles_whitespace(self) -> None:
        assert validate_instance_types("ml.g5.xlarge, ml.g6.xlarge") is None


class TestPromptInstanceTypes:
    """Test prompt_instance_types iterative instance type collection.

    Validates: Requirements FR-5.4
    """

    def test_pre_adds_mcp_recommendation(self, monkeypatch, capsys) -> None:
        """MCP recommendation is pre-added as first entry."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        call_count = [0]

        class FakeConfirmQuestion:
            def ask(self):
                return False  # Don't add more

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_confirm(message, **kwargs):
            return FakeConfirmQuestion()

        def fake_text(message, **kwargs):
            call_count[0] += 1
            return FakeTextQuestion("ml.g5.2xlarge")

        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf"}
        result = prompt_instance_types(config_vars)

        # Should contain the recommended type as first entry
        assert result.startswith("ml.g5.xlarge")
        # Verify the recommendation was printed to stderr
        captured = capsys.readouterr()
        assert "ml.g5.xlarge (recommended)" in captured.err

    def test_user_adds_multiple_types(self, monkeypatch) -> None:
        """User can add multiple instance types iteratively."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g5.xlarge",
        )

        confirm_calls = [0]
        text_calls = [0]
        text_values = ["ml.g5.2xlarge", "ml.g6.xlarge"]

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_confirm(message, **kwargs):
            class _Q:
                def ask(_self):
                    idx = confirm_calls[0]
                    confirm_calls[0] += 1
                    # Say yes to first two "add more", no to third
                    return idx < 2
            return _Q()

        def fake_text(message, **kwargs):
            idx = text_calls[0]
            text_calls[0] += 1
            return FakeTextQuestion(text_values[idx])

        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "test-model/7b"}
        result = prompt_instance_types(config_vars)

        types = result.split(",")
        assert types[0] == "ml.g5.xlarge"  # recommended
        assert types[1] == "ml.g5.2xlarge"
        assert types[2] == "ml.g6.xlarge"

    def test_max_five_enforced(self, monkeypatch) -> None:
        """Cannot add more than 5 instance types."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g5.xlarge",
        )

        text_calls = [0]
        text_values = ["ml.g5.2xlarge", "ml.g6.xlarge", "ml.p4d.24xlarge", "ml.p5.48xlarge"]

        class FakeConfirmQuestion:
            def ask(self):
                return True  # Always say yes to add more

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_confirm(message, **kwargs):
            return FakeConfirmQuestion()

        def fake_text(message, **kwargs):
            nonlocal text_calls
            idx = text_calls[0]
            text_calls[0] += 1
            return FakeTextQuestion(text_values[idx])

        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "test-model/7b"}
        result = prompt_instance_types(config_vars)

        types = result.split(",")
        assert len(types) == 5  # Max 5 enforced
        assert types[0] == "ml.g5.xlarge"  # recommended first

    def test_no_recommendation_requires_manual_entry(self, monkeypatch) -> None:
        """When no MCP recommendation, user must manually enter the first type."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: None,
        )

        text_calls = [0]

        class FakeConfirmQuestion:
            def ask(self):
                return False  # Don't add more

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_confirm(message, **kwargs):
            return FakeConfirmQuestion()

        def fake_text(message, **kwargs):
            nonlocal text_calls
            text_calls[0] += 1
            return FakeTextQuestion("ml.g5.xlarge")

        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "unknown-model/1b"}
        result = prompt_instance_types(config_vars)

        assert result == "ml.g5.xlarge"
        # Text prompt should have been called (no pre-added recommendation)
        assert text_calls[0] == 1


class TestPromptForMissingWithInstanceTypes:
    """Test prompt_for_missing routes INSTANCE_TYPES through prompt_instance_types.

    Validates: Requirements FR-5.4
    """

    def test_heterogeneous_routes_to_multi_select(self, monkeypatch) -> None:
        """When ENDPOINT_STRATEGY is heterogeneous, INSTANCE_TYPES uses multi-select."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g5.xlarge",
        )

        class FakeConfirmQuestion:
            def ask(self):
                return False  # Don't add more

        def fake_confirm(message, **kwargs):
            return FakeConfirmQuestion()

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_text(message, **kwargs):
            return FakeTextQuestion("ml.g5.2xlarge")

        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        # Simulate: ENDPOINT_STRATEGY already collected as "heterogeneous"
        # and INSTANCE_TYPES is missing
        missing = {"INSTANCE_TYPES": ""}
        config_vars = {
            "MODEL_NAME": "meta-llama/Llama-2-7b-hf",
            "ENDPOINT_STRATEGY": "heterogeneous",
        }

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        # Should start with the MCP recommendation
        assert "ml.g5.xlarge" in result["INSTANCE_TYPES"]

    def test_non_heterogeneous_uses_single_instance_type(self, monkeypatch) -> None:
        """When ENDPOINT_STRATEGY is 'new', INSTANCE_TYPES uses single INSTANCE_TYPE."""
        missing = {"INSTANCE_TYPES": ""}
        config_vars = {
            "ENDPOINT_STRATEGY": "new",
            "INSTANCE_TYPE": "ml.g5.xlarge",
        }

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPES"] == "ml.g5.xlarge"

    def test_env_answers_bypass_instance_types_prompt(self, monkeypatch) -> None:
        """When env answers provide INSTANCE_TYPES, multi-select prompt is skipped."""
        missing = {"INSTANCE_TYPES": ""}
        env_answers = {"INSTANCE_TYPES": "ml.g5.xlarge,ml.g6.xlarge"}
        config_vars = {"ENDPOINT_STRATEGY": "heterogeneous"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars=config_vars)

        assert result["INSTANCE_TYPES"] == "ml.g5.xlarge,ml.g6.xlarge"

    def test_env_answers_validates_instance_types(self, monkeypatch) -> None:
        """Invalid INSTANCE_TYPES in env_answers causes exit."""
        missing = {"INSTANCE_TYPES": ""}
        env_answers = {"INSTANCE_TYPES": "a,b,c,d,e,f,g"}  # >5 and invalid patterns

        with pytest.raises(SystemExit):
            prompt_for_missing(missing, env_answers=env_answers, config_vars={})

    def test_heterogeneous_from_answers_collected(self, monkeypatch) -> None:
        """Strategy collected earlier in same prompt_for_missing call is used."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: "ml.g5.xlarge",
        )

        class FakeSelectQuestion:
            def ask(self):
                return "heterogeneous"

        class FakeConfirmQuestion:
            def ask(self):
                return False  # Don't add more

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_select(message, **kwargs):
            return FakeSelectQuestion()

        def fake_confirm(message, **kwargs):
            return FakeConfirmQuestion()

        def fake_text(message, **kwargs):
            return FakeTextQuestion("ml.g5.2xlarge")

        monkeypatch.setattr("questionary.select", fake_select)
        monkeypatch.setattr("questionary.confirm", fake_confirm)
        monkeypatch.setattr("questionary.text", fake_text)

        # Both ENDPOINT_STRATEGY and INSTANCE_TYPES are missing
        # ENDPOINT_STRATEGY comes first in dict order since it's iterated first
        from collections import OrderedDict
        missing = OrderedDict([
            ("ENDPOINT_STRATEGY", "new"),
            ("INSTANCE_TYPES", ""),
        ])
        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ENDPOINT_STRATEGY"] == "heterogeneous"
        # Should use multi-select since strategy was collected as heterogeneous
        assert "ml.g5.xlarge" in result["INSTANCE_TYPES"]


# ---------------------------------------------------------------------------
# Endpoint name prompt with MCP endpoint-picker tests
# ---------------------------------------------------------------------------


class TestPromptEndpointName:
    """Test prompt_endpoint_name uses MCP endpoint-picker for 'existing' strategy.

    Validates: Requirements FR-5.3
    """

    def test_existing_strategy_shows_select_when_endpoints_available(self, monkeypatch) -> None:
        """When strategy is 'existing' and endpoints available, shows select prompt."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-prod", "status": "InService"},
                    {"name": "ep-staging", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "ep-prod"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        config_vars = {"AWS_REGION": "us-east-1"}
        result = prompt_endpoint_name(config_vars, strategy="existing")

        assert result == "ep-prod"
        assert captured_kwargs["message"] == "Select endpoint:"
        assert captured_kwargs["choices"] == ["ep-prod", "ep-staging"]

    def test_existing_strategy_falls_back_to_text_when_no_endpoints(self, monkeypatch) -> None:
        """When strategy is 'existing' but no endpoints, falls back to text input."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "my-custom-ep"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"AWS_REGION": "us-west-2"}
        result = prompt_endpoint_name(config_vars, strategy="existing")

        assert result == "my-custom-ep"
        assert captured_kwargs["message"] == "Endpoint name:"
        assert captured_kwargs["default"] == ""

    def test_new_strategy_uses_text_with_project_name_default(self, monkeypatch) -> None:
        """When strategy is 'new', uses text input with project name default."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"PROJECT_NAME": "wise-bert-service"}
        result = prompt_endpoint_name(config_vars, strategy="new")

        assert result == "wise-bert-service-ep"
        assert captured_kwargs["default"] == "wise-bert-service-ep"
        assert captured_kwargs["message"] == "Endpoint name:"

    def test_heterogeneous_strategy_uses_text_with_project_name_default(self, monkeypatch) -> None:
        """When strategy is 'heterogeneous', uses text input like 'new'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"PROJECT_NAME": "my-model"}
        result = prompt_endpoint_name(config_vars, strategy="heterogeneous")

        assert result == "my-model-ep"
        assert captured_kwargs["default"] == "my-model-ep"

    def test_new_strategy_no_project_name_uses_empty_default(self, monkeypatch) -> None:
        """When strategy is 'new' and no project name, default is empty."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "entered-name"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        result = prompt_endpoint_name(config_vars, strategy="new")

        assert result == "entered-name"
        assert captured_kwargs["default"] == ""

    def test_existing_strategy_uses_region_from_config(self, monkeypatch) -> None:
        """Region is read from AWS_REGION in config_vars."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "eu-endpoint", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def ask(self):
                return "eu-endpoint"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        config_vars = {"AWS_REGION": "eu-west-1"}
        result = prompt_endpoint_name(config_vars, strategy="existing")

        assert result == "eu-endpoint"

    def test_existing_strategy_uses_region_fallback_order(self, monkeypatch) -> None:
        """Region falls back from AWS_REGION -> REGION -> AWS_DEFAULT_REGION."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "fallback-ep", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def ask(self):
                return "fallback-ep"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        # Only REGION is set (not AWS_REGION)
        config_vars = {"REGION": "ap-southeast-1"}
        result = prompt_endpoint_name(config_vars, strategy="existing")

        assert result == "fallback-ep"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return None

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        with pytest.raises(SystemExit):
            prompt_endpoint_name({}, strategy="new")


class TestPromptForMissingWithEndpointName:
    """Test prompt_for_missing routes ENDPOINT_NAME through prompt_endpoint_name.

    Validates: Requirements FR-5.3
    """

    def test_endpoint_name_routes_to_dedicated_prompt_with_existing_strategy(self, monkeypatch) -> None:
        """When strategy is 'existing', ENDPOINT_NAME uses endpoint-picker select."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-live", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeSelectQuestion:
            def ask(self):
                return "ep-live"

        def fake_select(message, **kwargs):
            return FakeSelectQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        missing = {"ENDPOINT_NAME": None}
        config_vars = {"AWS_REGION": "us-east-1", "ENDPOINT_STRATEGY": "existing"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ENDPOINT_NAME"] == "ep-live"

    def test_endpoint_name_routes_to_text_with_new_strategy(self, monkeypatch) -> None:
        """When strategy is 'new', ENDPOINT_NAME uses text input with default."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"ENDPOINT_NAME": None}
        config_vars = {"PROJECT_NAME": "my-project", "ENDPOINT_STRATEGY": "new"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ENDPOINT_NAME"] == "my-project-ep"

    def test_endpoint_name_uses_strategy_from_collected_answers(self, monkeypatch) -> None:
        """Strategy collected earlier in the same prompt_for_missing call is used."""
        mock_responses = {
            "endpoint-picker/list": {
                "endpoints": [
                    {"name": "ep-from-mcp", "status": "InService"},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeSelectQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_select(message, **kwargs):
            # First call is endpoint strategy, second is endpoint name picker
            if "strategy" in message.lower():
                return FakeSelectQuestion("existing")
            return FakeSelectQuestion("ep-from-mcp")

        monkeypatch.setattr("questionary.select", fake_select)

        from collections import OrderedDict
        missing = OrderedDict([
            ("ENDPOINT_STRATEGY", "new"),
            ("ENDPOINT_NAME", None),
        ])
        config_vars = {"AWS_REGION": "us-east-1"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ENDPOINT_STRATEGY"] == "existing"
        assert result["ENDPOINT_NAME"] == "ep-from-mcp"

    def test_env_answers_bypass_endpoint_name_prompt(self, monkeypatch) -> None:
        """When env answers provide ENDPOINT_NAME, dedicated prompt is skipped."""
        missing = {"ENDPOINT_NAME": None}
        env_answers = {"ENDPOINT_NAME": "pre-set-endpoint"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["ENDPOINT_NAME"] == "pre-set-endpoint"

    def test_endpoint_name_defaults_to_new_strategy_when_none(self, monkeypatch) -> None:
        """When no strategy is available anywhere, defaults to 'new' behavior."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "typed-name"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"ENDPOINT_NAME": None}
        config_vars = {"PROJECT_NAME": "test-proj"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ENDPOINT_NAME"] == "typed-name"


# ---------------------------------------------------------------------------
# GPU count auto-detection tests
# ---------------------------------------------------------------------------


class TestDetectGpuCount:
    """Test detect_gpu_count looks up GPU count from instance catalog.

    Validates: Requirements FR-5.1
    """

    def test_single_gpu_instance(self) -> None:
        """Single-GPU instance returns '1'."""
        assert detect_gpu_count("ml.g6.xlarge") == "1"

    def test_four_gpu_instance(self) -> None:
        """4-GPU instance returns '4'."""
        assert detect_gpu_count("ml.g6.12xlarge") == "4"

    def test_eight_gpu_instance(self) -> None:
        """8-GPU instance returns '8'."""
        assert detect_gpu_count("ml.g6e.48xlarge") == "8"

    def test_g6e_single_gpu(self) -> None:
        """ml.g6e.xlarge has 1 GPU."""
        assert detect_gpu_count("ml.g6e.xlarge") == "1"

    def test_g6e_four_gpu(self) -> None:
        """ml.g6e.12xlarge has 4 GPUs."""
        assert detect_gpu_count("ml.g6e.12xlarge") == "4"

    def test_p6_eight_gpu(self) -> None:
        """ml.p6-b200.48xlarge has 8 GPUs."""
        assert detect_gpu_count("ml.p6-b200.48xlarge") == "8"

    def test_unknown_instance_returns_one(self) -> None:
        """Unknown instance types default to '1'."""
        assert detect_gpu_count("ml.m5.xlarge") == "1"

    def test_empty_string_returns_one(self) -> None:
        """Empty string returns '1'."""
        assert detect_gpu_count("") == "1"


class TestPromptGpuCount:
    """Test prompt_gpu_count auto-detects GPU count from instance type.

    Validates: Requirements FR-5.1
    """

    def test_auto_detects_from_answers(self, monkeypatch) -> None:
        """Uses instance type from answers to auto-detect GPU count."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        answers = {"INSTANCE_TYPE": "ml.g6.12xlarge"}
        result = prompt_gpu_count(config_vars, answers)

        assert result == "4"
        assert captured_kwargs["default"] == "4"
        assert "auto-detected: 4" in captured_kwargs["message"]

    def test_auto_detects_from_config_vars(self, monkeypatch) -> None:
        """Uses instance type from config_vars when not in answers."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"INSTANCE_TYPE": "ml.g6e.48xlarge"}
        answers = {}
        result = prompt_gpu_count(config_vars, answers)

        assert result == "8"
        assert captured_kwargs["default"] == "8"
        assert "auto-detected: 8" in captured_kwargs["message"]

    def test_answers_take_priority_over_config_vars(self, monkeypatch) -> None:
        """Instance type from answers takes priority over config_vars."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"INSTANCE_TYPE": "ml.g6e.48xlarge"}  # 8 GPUs
        answers = {"INSTANCE_TYPE": "ml.g6.xlarge"}  # 1 GPU
        result = prompt_gpu_count(config_vars, answers)

        assert result == "1"
        assert captured_kwargs["default"] == "1"
        assert "auto-detected: 1" in captured_kwargs["message"]

    def test_unknown_instance_defaults_to_one(self, monkeypatch) -> None:
        """Unknown instance type auto-detects as '1'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        answers = {"INSTANCE_TYPE": "ml.p4d.24xlarge"}
        result = prompt_gpu_count(config_vars, answers)

        assert result == "1"
        assert captured_kwargs["default"] == "1"
        assert "auto-detected: 1" in captured_kwargs["message"]

    def test_no_instance_type_shows_plain_prompt(self, monkeypatch) -> None:
        """When no instance type is available, shows plain prompt with default '1'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        answers = {}
        result = prompt_gpu_count(config_vars, answers)

        assert result == "1"
        assert captured_kwargs["default"] == "1"
        assert "auto-detected" not in captured_kwargs["message"]
        assert captured_kwargs["message"] == "GPU count:"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        class FakeQuestion:
            def ask(self):
                return None

        def fake_text(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        with pytest.raises(SystemExit):
            prompt_gpu_count({}, {"INSTANCE_TYPE": "ml.g6.xlarge"})


class TestPromptForMissingWithGpuCount:
    """Test prompt_for_missing routes IC_GPU_COUNT through auto-detection.

    Validates: Requirements FR-5.1
    """

    def test_gpu_count_auto_detected_from_instance_type(self, monkeypatch) -> None:
        """IC_GPU_COUNT with default 'auto' routes to auto-detection prompt."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"IC_GPU_COUNT": "auto"}
        config_vars = {"INSTANCE_TYPE": "ml.g6.12xlarge"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["IC_GPU_COUNT"] == "4"
        assert "auto-detected: 4" in captured_kwargs["message"]

    def test_gpu_count_uses_instance_type_from_answers(self, monkeypatch) -> None:
        """IC_GPU_COUNT uses INSTANCE_TYPE collected earlier in the same call."""
        call_count = [0]

        class FakeQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_text(message, **kwargs):
            nonlocal call_count
            call_count[0] += 1
            if call_count[0] == 1:
                # First call is for INSTANCE_TYPE
                return FakeQuestion("ml.g6e.48xlarge")
            else:
                # Second call is for IC_GPU_COUNT — accept the default
                return FakeQuestion(kwargs.get("default", "1"))

        monkeypatch.setattr("questionary.text", fake_text)
        # Suppress MCP fallback warning
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: None,
        )

        from collections import OrderedDict
        missing = OrderedDict([
            ("INSTANCE_TYPE", None),
            ("IC_GPU_COUNT", "auto"),
        ])
        config_vars = {"MODEL_NAME": "some-model"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.g6e.48xlarge"
        assert result["IC_GPU_COUNT"] == "8"

    def test_env_answers_bypass_gpu_count_prompt(self, monkeypatch) -> None:
        """When env answers provide IC_GPU_COUNT, auto-detection is skipped."""
        missing = {"IC_GPU_COUNT": "auto"}
        env_answers = {"IC_GPU_COUNT": "2"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["IC_GPU_COUNT"] == "2"

    def test_gpu_count_non_auto_default_uses_generic_prompt(self, monkeypatch) -> None:
        """When IC_GPU_COUNT default is not 'auto', uses generic prompt_for_var."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        # If someone manually passes IC_GPU_COUNT with a non-auto default
        missing = {"IC_GPU_COUNT": "2"}
        config_vars = {"INSTANCE_TYPE": "ml.g6.12xlarge"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        # Should use the generic prompt_for_var, not auto-detection
        assert result["IC_GPU_COUNT"] == "2"
        assert "GPU count:" in captured_kwargs["message"]
        assert "auto-detected" not in captured_kwargs["message"]


# ---------------------------------------------------------------------------
# Cluster prompt via cluster-picker tests
# ---------------------------------------------------------------------------


class TestPromptClusterName:
    """Test prompt_cluster_name uses MCP cluster-picker for cluster selection.

    Validates: Requirements FR-6.1
    """

    def test_shows_select_when_clusters_available(self, monkeypatch) -> None:
        """When MCP returns clusters, shows select prompt with GPU capacity info."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "cluster-1", "gpu_capacity": 8, "queues": ["default"]},
                    {"name": "cluster-2", "gpu_capacity": 16, "queues": ["training"]},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "cluster-1"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        config_vars = {"AWS_REGION": "us-east-1"}
        result = prompt_cluster_name(config_vars)

        assert result == "cluster-1"
        assert captured_kwargs["message"] == "Select cluster:"
        # Verify choices include GPU capacity info
        choices = captured_kwargs["choices"]
        assert len(choices) == 2
        assert choices[0].title == "cluster-1 (8 GPUs)"
        assert choices[0].value == "cluster-1"
        assert choices[1].title == "cluster-2 (16 GPUs)"
        assert choices[1].value == "cluster-2"

    def test_falls_back_to_text_when_mcp_unavailable(self, monkeypatch) -> None:
        """When MCP is unavailable (no socket, no config), falls back to text input."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "my-manual-cluster"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"AWS_REGION": "us-west-2"}
        result = prompt_cluster_name(config_vars)

        assert result == "my-manual-cluster"
        assert captured_kwargs["message"] == "HyperPod cluster name:"
        assert captured_kwargs["default"] == ""

    def test_errors_when_mcp_available_but_no_clusters(self, monkeypatch, capsys) -> None:
        """When MCP is available but returns 0 clusters, exits with FR-6.5 error.

        Validates: Requirements FR-6.5
        """
        # MCP is available (mock transport) but returns empty cluster list
        mock_responses = {
            "cluster-picker/list": {
                "clusters": []
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        config_vars = {"AWS_REGION": "us-east-1"}

        with pytest.raises(SystemExit) as exc_info:
            prompt_cluster_name(config_vars)

        assert exc_info.value.code == 1

        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert output["error"] == "No HyperPod cluster found. Run: mcc bootstrap add-module hyperpod"

    def test_reads_region_from_config_vars(self, monkeypatch) -> None:
        """Region is read from config_vars with proper fallback order."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "eu-cluster", "gpu_capacity": 4, "queues": ["default"]},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def ask(self):
                return "eu-cluster"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        # Uses REGION fallback (not AWS_REGION)
        config_vars = {"REGION": "eu-west-1"}
        result = prompt_cluster_name(config_vars)

        assert result == "eu-cluster"

    def test_region_fallback_to_aws_default_region(self, monkeypatch) -> None:
        """Region falls back to AWS_DEFAULT_REGION when others not set."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "ap-cluster", "gpu_capacity": 8, "queues": ["q1"]},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def ask(self):
                return "ap-cluster"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        config_vars = {"AWS_DEFAULT_REGION": "ap-southeast-1"}
        result = prompt_cluster_name(config_vars)

        assert result == "ap-cluster"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)

        class FakeQuestion:
            def ask(self):
                return None

        def fake_text(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        with pytest.raises(SystemExit):
            prompt_cluster_name({})


class TestPromptForMissingWithClusterName:
    """Test prompt_for_missing routes HP_CLUSTER_NAME through prompt_cluster_name.

    Validates: Requirements FR-6.1
    """

    def test_cluster_name_routes_to_dedicated_prompt(self, monkeypatch) -> None:
        """When HP_CLUSTER_NAME is missing, routes through prompt_cluster_name."""
        mock_responses = {
            "cluster-picker/list": {
                "clusters": [
                    {"name": "prod-cluster", "gpu_capacity": 8, "queues": ["default"]},
                ]
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def ask(self):
                return "prod-cluster"

        def fake_select(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        missing = {"HP_CLUSTER_NAME": None}
        config_vars = {"AWS_REGION": "us-east-1"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["HP_CLUSTER_NAME"] == "prod-cluster"

    def test_env_answers_bypass_cluster_prompt(self, monkeypatch) -> None:
        """When env answers provide HP_CLUSTER_NAME, dedicated prompt is skipped."""
        missing = {"HP_CLUSTER_NAME": None}
        env_answers = {"HP_CLUSTER_NAME": "pre-set-cluster"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["HP_CLUSTER_NAME"] == "pre-set-cluster"


# ---------------------------------------------------------------------------
# HP_GPU_COUNT auto-detection tests (FR-6.2)
# ---------------------------------------------------------------------------


class TestPromptHpGpuCount:
    """Test prompt_hp_gpu_count auto-detects GPU count from instance type.

    Validates: Requirements FR-6.2
    """

    def test_auto_detects_from_answers(self, monkeypatch) -> None:
        """Uses instance type from answers to auto-detect GPU count."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        answers = {"INSTANCE_TYPE": "ml.g6.12xlarge"}
        result = prompt_hp_gpu_count(config_vars, answers)

        assert result == "4"
        assert captured_kwargs["default"] == "4"
        assert "auto-detected: 4" in captured_kwargs["message"]

    def test_auto_detects_from_config_vars(self, monkeypatch) -> None:
        """Uses instance type from config_vars when not in answers."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"INSTANCE_TYPE": "ml.g6e.48xlarge"}
        answers = {}
        result = prompt_hp_gpu_count(config_vars, answers)

        assert result == "8"
        assert captured_kwargs["default"] == "8"
        assert "auto-detected: 8" in captured_kwargs["message"]

    def test_answers_take_priority_over_config_vars(self, monkeypatch) -> None:
        """Instance type from answers takes priority over config_vars."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"INSTANCE_TYPE": "ml.g6e.48xlarge"}  # 8 GPUs
        answers = {"INSTANCE_TYPE": "ml.g6.xlarge"}  # 1 GPU
        result = prompt_hp_gpu_count(config_vars, answers)

        assert result == "1"
        assert captured_kwargs["default"] == "1"
        assert "auto-detected: 1" in captured_kwargs["message"]

    def test_no_instance_type_shows_plain_prompt(self, monkeypatch) -> None:
        """When no instance type is available, shows plain prompt with default '1'."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {}
        answers = {}
        result = prompt_hp_gpu_count(config_vars, answers)

        assert result == "1"
        assert captured_kwargs["default"] == "1"
        assert "auto-detected" not in captured_kwargs["message"]
        assert captured_kwargs["message"] == "GPU count:"


class TestPromptForMissingWithHpGpuCount:
    """Test prompt_for_missing routes HP_GPU_COUNT through auto-detection.

    Validates: Requirements FR-6.2
    """

    def test_hp_gpu_count_auto_detected_from_instance_type(self, monkeypatch) -> None:
        """HP_GPU_COUNT with default 'auto' routes to auto-detection prompt."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"HP_GPU_COUNT": "auto"}
        config_vars = {"INSTANCE_TYPE": "ml.g6.12xlarge"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["HP_GPU_COUNT"] == "4"
        assert "auto-detected: 4" in captured_kwargs["message"]

    def test_hp_gpu_count_uses_instance_type_from_answers(self, monkeypatch) -> None:
        """HP_GPU_COUNT uses INSTANCE_TYPE collected earlier in same prompt_for_missing call."""
        call_count = [0]

        class FakeQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        def fake_text(message, **kwargs):
            nonlocal call_count
            call_count[0] += 1
            if call_count[0] == 1:
                # First call is for INSTANCE_TYPE
                return FakeQuestion("ml.g6e.48xlarge")
            else:
                # Second call is for HP_GPU_COUNT — accept the default
                return FakeQuestion(kwargs.get("default", "1"))

        monkeypatch.setattr("questionary.text", fake_text)
        # Suppress MCP fallback warning
        monkeypatch.delenv("MCP_MOCK_RESPONSES", raising=False)
        monkeypatch.delenv("MCP_SOCKET", raising=False)
        monkeypatch.setattr(
            "deploy_prompts.instance_sizer.recommend_for_model",
            lambda model, prec: None,
        )

        from collections import OrderedDict
        missing = OrderedDict([
            ("INSTANCE_TYPE", None),
            ("HP_GPU_COUNT", "auto"),
        ])
        config_vars = {"MODEL_NAME": "some-model"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.g6e.48xlarge"
        assert result["HP_GPU_COUNT"] == "8"

    def test_env_answers_bypass_hp_gpu_count_prompt(self, monkeypatch) -> None:
        """When env answers provide HP_GPU_COUNT, auto-detection is skipped."""
        missing = {"HP_GPU_COUNT": "auto"}
        env_answers = {"HP_GPU_COUNT": "4"}

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["HP_GPU_COUNT"] == "4"

    def test_hp_gpu_count_non_auto_default_uses_generic_prompt(self, monkeypatch) -> None:
        """When HP_GPU_COUNT default is not 'auto', uses generic prompt_for_var."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        # If someone manually passes HP_GPU_COUNT with a non-auto default
        missing = {"HP_GPU_COUNT": "2"}
        config_vars = {"INSTANCE_TYPE": "ml.g6.12xlarge"}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        # Should use the generic prompt_for_var, not auto-detection
        assert result["HP_GPU_COUNT"] == "2"
        assert "GPU count:" in captured_kwargs["message"]
        assert "auto-detected" not in captured_kwargs["message"]


# ---------------------------------------------------------------------------
# Async S3 output path prompt tests (FR-7.1)
# ---------------------------------------------------------------------------


class TestPromptAsyncS3OutputPath:
    """Test prompt_async_s3_output_path constructs default from profile bucket.

    Validates: Requirements FR-7.1
    """

    def test_default_from_models_bucket_and_project(self, monkeypatch) -> None:
        """Default constructed from MODELS_BUCKET + PROJECT_NAME."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "my-models-bucket",
            "PROJECT_NAME": "wise-bert",
        }
        result = prompt_async_s3_output_path(config_vars)

        assert result == "s3://my-models-bucket/async-output/wise-bert/"
        assert captured_kwargs["default"] == "s3://my-models-bucket/async-output/wise-bert/"
        assert "default: s3://my-models-bucket/async-output/wise-bert/" in captured_kwargs["message"]

    def test_fallback_to_s3_bucket_when_models_bucket_not_set(self, monkeypatch) -> None:
        """Falls back to S3_BUCKET when MODELS_BUCKET is not set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "S3_BUCKET": "fallback-bucket",
            "PROJECT_NAME": "my-llm",
        }
        result = prompt_async_s3_output_path(config_vars)

        assert result == "s3://fallback-bucket/async-output/my-llm/"
        assert captured_kwargs["default"] == "s3://fallback-bucket/async-output/my-llm/"

    def test_no_default_when_no_bucket_var_set(self, monkeypatch) -> None:
        """No default when neither MODELS_BUCKET nor S3_BUCKET is set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "s3://user-typed-path/output/"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"PROJECT_NAME": "my-project"}
        result = prompt_async_s3_output_path(config_vars)

        assert result == "s3://user-typed-path/output/"
        assert captured_kwargs["default"] == ""
        assert captured_kwargs["message"] == "S3 output path:"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        class FakeQuestion:
            def ask(self):
                return None

        def fake_text(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        with pytest.raises(SystemExit):
            prompt_async_s3_output_path({})

    def test_models_bucket_takes_priority_over_s3_bucket(self, monkeypatch) -> None:
        """MODELS_BUCKET is preferred over S3_BUCKET when both are set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "primary-bucket",
            "S3_BUCKET": "secondary-bucket",
            "PROJECT_NAME": "test-proj",
        }
        result = prompt_async_s3_output_path(config_vars)

        assert result == "s3://primary-bucket/async-output/test-proj/"

    def test_bucket_without_project_name(self, monkeypatch) -> None:
        """When bucket is set but PROJECT_NAME is not, path omits project segment."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODELS_BUCKET": "my-bucket"}
        result = prompt_async_s3_output_path(config_vars)

        assert result == "s3://my-bucket/async-output/"
        assert captured_kwargs["default"] == "s3://my-bucket/async-output/"


# ---------------------------------------------------------------------------
# Async-inference prompt_for_missing integration tests (FR-7.1, FR-7.2, FR-7.3)
# ---------------------------------------------------------------------------


class TestPromptForMissingWithAsyncFlow:
    """Test prompt_for_missing handles async-inference target variables.

    Validates: Requirements FR-7.1, FR-7.2, FR-7.3
    """

    def test_instance_type_routes_to_mcp_prompt_for_async_target(self, monkeypatch) -> None:
        """INSTANCE_TYPE routes to MCP-aware prompt for async-inference target."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.g5.xlarge",
                "gpu_count": 1,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        class FakeQuestion:
            def __init__(self, default):
                self._default = default

            def ask(self):
                return self._default

        def fake_text(message, **kwargs):
            return FakeQuestion(kwargs.get("default", ""))

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODEL_NAME": "meta-llama/Llama-2-7b-hf"}
        missing = {"INSTANCE_TYPE": None}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.g5.xlarge"

    def test_async_s3_output_path_routes_to_dedicated_prompt(self, monkeypatch) -> None:
        """ASYNC_S3_OUTPUT_PATH routes to prompt_async_s3_output_path."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "async-bucket",
            "PROJECT_NAME": "async-proj",
        }
        missing = {"ASYNC_S3_OUTPUT_PATH": None}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["ASYNC_S3_OUTPUT_PATH"] == "s3://async-bucket/async-output/async-proj/"

    def test_async_sns_topic_works_with_generic_prompt_empty_skip(self, monkeypatch) -> None:
        """ASYNC_SNS_TOPIC works with generic prompt — empty input = skip."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                # Simulate user pressing Enter (empty = skip)
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"ASYNC_SNS_TOPIC": ""}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["ASYNC_SNS_TOPIC"] == ""
        assert "SNS topic ARN (optional, press Enter to skip):" in captured_kwargs["message"]

    def test_async_max_concurrent_works_with_generic_prompt_default_1(self, monkeypatch) -> None:
        """ASYNC_MAX_CONCURRENT works with generic prompt — default is 1."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"ASYNC_MAX_CONCURRENT": "1"}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["ASYNC_MAX_CONCURRENT"] == "1"
        assert "Max concurrent invocations:" in captured_kwargs["message"]

    def test_env_answers_bypass_all_async_prompts(self, monkeypatch) -> None:
        """env_answers bypass all prompts for async-inference variables."""
        missing = {
            "INSTANCE_TYPE": None,
            "ASYNC_S3_OUTPUT_PATH": None,
            "ASYNC_SNS_TOPIC": "",
            "ASYNC_MAX_CONCURRENT": "1",
        }
        env_answers = {
            "INSTANCE_TYPE": "ml.g5.xlarge",
            "ASYNC_S3_OUTPUT_PATH": "s3://my-bucket/output/",
            "ASYNC_SNS_TOPIC": "arn:aws:sns:us-east-1:123456:my-topic",
            "ASYNC_MAX_CONCURRENT": "5",
        }

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["INSTANCE_TYPE"] == "ml.g5.xlarge"
        assert result["ASYNC_S3_OUTPUT_PATH"] == "s3://my-bucket/output/"
        assert result["ASYNC_SNS_TOPIC"] == "arn:aws:sns:us-east-1:123456:my-topic"
        assert result["ASYNC_MAX_CONCURRENT"] == "5"


# ---------------------------------------------------------------------------
# Batch output path prompt tests (FR-8.2)
# ---------------------------------------------------------------------------


class TestPromptBatchOutputPath:
    """Test prompt_batch_output_path constructs default from profile bucket.

    Validates: Requirements FR-8.2
    """

    def test_default_from_models_bucket_and_project(self, monkeypatch) -> None:
        """Default constructed from MODELS_BUCKET + PROJECT_NAME."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "my-models-bucket",
            "PROJECT_NAME": "wise-bert",
        }
        result = prompt_batch_output_path(config_vars)

        assert result == "s3://my-models-bucket/batch-output/wise-bert/"
        assert captured_kwargs["default"] == "s3://my-models-bucket/batch-output/wise-bert/"
        assert "default: s3://my-models-bucket/batch-output/wise-bert/" in captured_kwargs["message"]

    def test_fallback_to_s3_bucket_when_models_bucket_not_set(self, monkeypatch) -> None:
        """Falls back to S3_BUCKET when MODELS_BUCKET is not set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "S3_BUCKET": "fallback-bucket",
            "PROJECT_NAME": "my-llm",
        }
        result = prompt_batch_output_path(config_vars)

        assert result == "s3://fallback-bucket/batch-output/my-llm/"
        assert captured_kwargs["default"] == "s3://fallback-bucket/batch-output/my-llm/"

    def test_no_default_when_no_bucket_var_set(self, monkeypatch) -> None:
        """No default when neither MODELS_BUCKET nor S3_BUCKET is set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "s3://user-typed-path/output/"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"PROJECT_NAME": "my-project"}
        result = prompt_batch_output_path(config_vars)

        assert result == "s3://user-typed-path/output/"
        assert captured_kwargs["default"] == ""
        assert captured_kwargs["message"] == "S3 output path:"

    def test_cancel_exits(self, monkeypatch) -> None:
        """When user cancels (Ctrl+C), exits with error."""
        class FakeQuestion:
            def ask(self):
                return None

        def fake_text(message, **kwargs):
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        with pytest.raises(SystemExit):
            prompt_batch_output_path({})

    def test_models_bucket_takes_priority_over_s3_bucket(self, monkeypatch) -> None:
        """MODELS_BUCKET is preferred over S3_BUCKET when both are set."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "primary-bucket",
            "S3_BUCKET": "secondary-bucket",
            "PROJECT_NAME": "test-proj",
        }
        result = prompt_batch_output_path(config_vars)

        assert result == "s3://primary-bucket/batch-output/test-proj/"

    def test_bucket_without_project_name(self, monkeypatch) -> None:
        """When bucket is set but PROJECT_NAME is not, path omits project segment."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {"MODELS_BUCKET": "my-bucket"}
        result = prompt_batch_output_path(config_vars)

        assert result == "s3://my-bucket/batch-output/"
        assert captured_kwargs["default"] == "s3://my-bucket/batch-output/"


# ---------------------------------------------------------------------------
# Batch-transform prompt_for_missing integration tests (FR-8.1, FR-8.2, FR-8.3, FR-8.4)
# ---------------------------------------------------------------------------


class TestPromptForMissingWithBatchFlow:
    """Test prompt_for_missing handles batch-transform target variables.

    Validates: Requirements FR-8.1, FR-8.2, FR-8.3, FR-8.4
    """

    def test_batch_output_path_routes_to_dedicated_prompt(self, monkeypatch) -> None:
        """BATCH_OUTPUT_PATH routes to prompt_batch_output_path."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        config_vars = {
            "MODELS_BUCKET": "batch-bucket",
            "PROJECT_NAME": "batch-proj",
        }
        missing = {"BATCH_OUTPUT_PATH": None}

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["BATCH_OUTPUT_PATH"] == "s3://batch-bucket/batch-output/batch-proj/"

    def test_batch_input_path_has_no_default(self, monkeypatch) -> None:
        """BATCH_INPUT_PATH uses generic prompt with no default (FR-8.1)."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "s3://my-data/input/"

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"BATCH_INPUT_PATH": None}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["BATCH_INPUT_PATH"] == "s3://my-data/input/"
        # Default should be empty (no default for input path per FR-8.1)
        assert captured_kwargs.get("default", "") == ""
        assert "S3 input path:" in captured_kwargs["message"]

    def test_batch_split_type_uses_select_with_line_default(self, monkeypatch) -> None:
        """BATCH_SPLIT_TYPE uses select prompt with default Line (FR-8.3)."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "Line"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        missing = {"BATCH_SPLIT_TYPE": "Line"}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["BATCH_SPLIT_TYPE"] == "Line"
        assert "Split type:" in captured_kwargs["message"]
        assert captured_kwargs["choices"] == ["Line", "RecordIO", "None"]
        assert captured_kwargs["default"] == "Line"

    def test_batch_strategy_uses_select_with_multirecord_default(self, monkeypatch) -> None:
        """BATCH_STRATEGY uses select prompt with default MultiRecord (FR-8.4)."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return "MultiRecord"

        def fake_select(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.select", fake_select)

        missing = {"BATCH_STRATEGY": "MultiRecord"}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["BATCH_STRATEGY"] == "MultiRecord"
        assert "Batch strategy:" in captured_kwargs["message"]
        assert captured_kwargs["choices"] == ["MultiRecord", "SingleRecord"]
        assert captured_kwargs["default"] == "MultiRecord"

    def test_batch_max_concurrent_default_1(self, monkeypatch) -> None:
        """BATCH_MAX_CONCURRENT uses text prompt with default 1."""
        captured_kwargs: dict = {}

        class FakeQuestion:
            def ask(self):
                return captured_kwargs.get("default", "")

        def fake_text(message, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs["message"] = message
            return FakeQuestion()

        monkeypatch.setattr("questionary.text", fake_text)

        missing = {"BATCH_MAX_CONCURRENT": "1"}
        result = prompt_for_missing(missing, env_answers=None, config_vars={})

        assert result["BATCH_MAX_CONCURRENT"] == "1"
        assert "Max concurrent transforms:" in captured_kwargs["message"]

    def test_env_answers_bypass_all_batch_prompts(self, monkeypatch) -> None:
        """env_answers bypass all prompts for batch-transform variables."""
        missing = {
            "INSTANCE_TYPE": None,
            "BATCH_INPUT_PATH": None,
            "BATCH_OUTPUT_PATH": None,
            "BATCH_SPLIT_TYPE": "Line",
            "BATCH_STRATEGY": "MultiRecord",
            "BATCH_MAX_CONCURRENT": "1",
        }
        env_answers = {
            "INSTANCE_TYPE": "ml.m5.xlarge",
            "BATCH_INPUT_PATH": "s3://input-bucket/data/",
            "BATCH_OUTPUT_PATH": "s3://output-bucket/results/",
            "BATCH_SPLIT_TYPE": "RecordIO",
            "BATCH_STRATEGY": "SingleRecord",
            "BATCH_MAX_CONCURRENT": "4",
        }

        result = prompt_for_missing(missing, env_answers=env_answers, config_vars={})

        assert result["INSTANCE_TYPE"] == "ml.m5.xlarge"
        assert result["BATCH_INPUT_PATH"] == "s3://input-bucket/data/"
        assert result["BATCH_OUTPUT_PATH"] == "s3://output-bucket/results/"
        assert result["BATCH_SPLIT_TYPE"] == "RecordIO"
        assert result["BATCH_STRATEGY"] == "SingleRecord"
        assert result["BATCH_MAX_CONCURRENT"] == "4"

    def test_full_batch_flow_with_mcp_sizer(self, monkeypatch) -> None:
        """Full batch-transform flow: instance type from MCP, all vars prompted."""
        mock_responses = {
            "instance-sizer/recommend": {
                "instance_type": "ml.m5.xlarge",
                "gpu_count": 0,
            }
        }
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(mock_responses))

        call_count = [0]

        class FakeTextQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        class FakeSelectQuestion:
            def __init__(self, value):
                self._value = value

            def ask(self):
                return self._value

        text_responses = [
            "ml.m5.xlarge",  # INSTANCE_TYPE (MCP default accepted)
            "s3://my-data/input/",  # BATCH_INPUT_PATH
            "s3://my-bucket/batch-output/proj/",  # BATCH_OUTPUT_PATH (default accepted)
            "1",  # BATCH_MAX_CONCURRENT
        ]

        select_responses = [
            "Line",  # BATCH_SPLIT_TYPE
            "MultiRecord",  # BATCH_STRATEGY
        ]

        text_idx = [0]
        select_idx = [0]

        def fake_text(message, **kwargs):
            idx = text_idx[0]
            text_idx[0] += 1
            if idx < len(text_responses):
                return FakeTextQuestion(text_responses[idx])
            return FakeTextQuestion(kwargs.get("default", ""))

        def fake_select(message, **kwargs):
            idx = select_idx[0]
            select_idx[0] += 1
            if idx < len(select_responses):
                return FakeSelectQuestion(select_responses[idx])
            return FakeSelectQuestion(kwargs.get("default", ""))

        monkeypatch.setattr("questionary.text", fake_text)
        monkeypatch.setattr("questionary.select", fake_select)

        config_vars = {
            "MODEL_NAME": "bert-base-uncased",
            "MODELS_BUCKET": "my-bucket",
            "PROJECT_NAME": "proj",
        }

        from collections import OrderedDict
        missing = OrderedDict([
            ("INSTANCE_TYPE", None),
            ("BATCH_INPUT_PATH", None),
            ("BATCH_OUTPUT_PATH", None),
            ("BATCH_SPLIT_TYPE", "Line"),
            ("BATCH_STRATEGY", "MultiRecord"),
            ("BATCH_MAX_CONCURRENT", "1"),
        ])

        result = prompt_for_missing(missing, env_answers=None, config_vars=config_vars)

        assert result["INSTANCE_TYPE"] == "ml.m5.xlarge"
        assert result["BATCH_INPUT_PATH"] == "s3://my-data/input/"
        assert result["BATCH_OUTPUT_PATH"] == "s3://my-bucket/batch-output/proj/"
        assert result["BATCH_SPLIT_TYPE"] == "Line"
        assert result["BATCH_STRATEGY"] == "MultiRecord"
        assert result["BATCH_MAX_CONCURRENT"] == "1"
