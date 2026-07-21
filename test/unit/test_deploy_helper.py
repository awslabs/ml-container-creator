"""Unit tests for .deploy_helper.py — cmd_prompt subcommand.

Validates: Requirements FR-2.1, FR-3.1, FR-3.2, NFR-3.1
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# The module is named .deploy_helper.py (starts with a dot), so we import
# it by adding templates/do to sys.path and using importlib.
_DEPLOY_HELPER_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'templates', 'do')
)
if _DEPLOY_HELPER_DIR not in sys.path:
    sys.path.insert(0, _DEPLOY_HELPER_DIR)

# Import via importlib since the filename starts with a dot
_spec = importlib.util.spec_from_file_location(
    "deploy_helper",
    os.path.join(_DEPLOY_HELPER_DIR, ".deploy_helper.py"),
)
deploy_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deploy_helper)

cmd_prompt = deploy_helper.cmd_prompt
build_parser = deploy_helper.build_parser


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_prompt_args(
    config_file: str = "/tmp/config",
    target: str = "",
    instance_type: str = "",
    answers_file: str = "",
    endpoint_name: str = "",
    endpoint_strategy: str = "",
    instance_types: str = "",
    gpu_count: str = "",
    cluster_name: str = "",
    namespace: str = "",
    replicas: str = "",
    queue: str = "",
    async_output_path: str = "",
    async_sns_topic: str = "",
    async_max_concurrent: str = "",
    batch_input_path: str = "",
    batch_output_path: str = "",
    batch_split_type: str = "",
    batch_strategy: str = "",
    batch_max_concurrent: str = "",
) -> argparse.Namespace:
    """Build a Namespace mimicking parsed prompt subcommand args."""
    return argparse.Namespace(
        config_file=config_file,
        target=target,
        instance_type=instance_type,
        answers_file=answers_file,
        endpoint_name=endpoint_name,
        endpoint_strategy=endpoint_strategy,
        instance_types=instance_types,
        gpu_count=gpu_count,
        cluster_name=cluster_name,
        namespace=namespace,
        replicas=replicas,
        queue=queue,
        async_output_path=async_output_path,
        async_sns_topic=async_sns_topic,
        async_max_concurrent=async_max_concurrent,
        batch_input_path=batch_input_path,
        batch_output_path=batch_output_path,
        batch_split_type=batch_split_type,
        batch_strategy=batch_strategy,
        batch_max_concurrent=batch_max_concurrent,
    )


# ---------------------------------------------------------------------------
# Tests: cmd_prompt calls run_prompt_flow with correct arguments
# ---------------------------------------------------------------------------


class TestCmdPromptDelegation:
    """Verify cmd_prompt delegates to run_prompt_flow correctly."""

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_calls_run_prompt_flow_with_config_path(self, mock_flow, monkeypatch) -> None:
        """cmd_prompt passes --config-file to run_prompt_flow."""
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)
        args = _make_prompt_args(config_file="/my/config")
        cmd_prompt(args)
        mock_flow.assert_called_once_with(
            config_path="/my/config",
            pre_target=None,
            pre_instance_type=None,
        )

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_passes_target_when_provided(self, mock_flow) -> None:
        """Non-empty --target is passed through to run_prompt_flow."""
        args = _make_prompt_args(target="managed-inference")
        cmd_prompt(args)
        mock_flow.assert_called_once_with(
            config_path="/tmp/config",
            pre_target="managed-inference",
            pre_instance_type=None,
        )

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_passes_instance_type_when_provided(self, mock_flow) -> None:
        """Non-empty --instance-type is passed through to run_prompt_flow."""
        args = _make_prompt_args(instance_type="ml.g5.xlarge")
        cmd_prompt(args)
        mock_flow.assert_called_once_with(
            config_path="/tmp/config",
            pre_target=None,
            pre_instance_type="ml.g5.xlarge",
        )

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_empty_target_passes_none(self, mock_flow, monkeypatch) -> None:
        """Empty --target (default) passes None to run_prompt_flow.

        Validates: Requirements FR-3.2
        """
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)
        args = _make_prompt_args(target="")
        cmd_prompt(args)
        mock_flow.assert_called_once_with(
            config_path="/tmp/config",
            pre_target=None,
            pre_instance_type=None,
        )

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_empty_instance_type_passes_none(self, mock_flow, monkeypatch) -> None:
        """Empty --instance-type (default) passes None to run_prompt_flow.

        Validates: Requirements FR-3.2
        """
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)
        args = _make_prompt_args(instance_type="")
        cmd_prompt(args)
        mock_flow.assert_called_once_with(
            config_path="/tmp/config",
            pre_target=None,
            pre_instance_type=None,
        )


# ---------------------------------------------------------------------------
# Tests: --answers-file loads JSON into DEPLOY_ANSWERS env var
# ---------------------------------------------------------------------------


class TestAnswersFileLoading:
    """Verify --answers-file is loaded into DEPLOY_ANSWERS env var.

    Validates: Requirements NFR-3.1
    """

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_loads_valid_json_into_env(self, mock_flow, tmp_path, monkeypatch) -> None:
        """Valid JSON answers file is loaded into DEPLOY_ANSWERS env var."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        answers = {"target": "managed-inference", "instance_type": "ml.g5.xlarge"}
        answers_file = tmp_path / "answers.json"
        answers_file.write_text(json.dumps(answers))

        args = _make_prompt_args(answers_file=str(answers_file))
        cmd_prompt(args)

        assert os.environ.get("DEPLOY_ANSWERS") == json.dumps(answers)
        mock_flow.assert_called_once()

        # Cleanup
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_strips_whitespace_from_answers_file(self, mock_flow, tmp_path, monkeypatch) -> None:
        """Whitespace around JSON content is stripped before setting env var."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        answers_file = tmp_path / "answers.json"
        answers_file.write_text('  {"target": "batch-transform"}  \n')

        args = _make_prompt_args(answers_file=str(answers_file))
        cmd_prompt(args)

        assert os.environ.get("DEPLOY_ANSWERS") == '{"target": "batch-transform"}'
        mock_flow.assert_called_once()

        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_no_answers_file_does_not_set_env(self, mock_flow, monkeypatch) -> None:
        """When --answers-file is empty (default), DEPLOY_ANSWERS is not set."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)
        args = _make_prompt_args(answers_file="")
        cmd_prompt(args)
        assert os.environ.get("DEPLOY_ANSWERS") is None
        mock_flow.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: Invalid answers file prints JSON error
# ---------------------------------------------------------------------------


class TestAnswersFileInvalidJson:
    """Verify invalid JSON in answers file prints JSON error and exits.

    Validates: Requirements NFR-3.1
    """

    def test_invalid_json_prints_error_and_exits(self, tmp_path, capsys) -> None:
        """Non-JSON content in answers file produces JSON error on stdout."""
        answers_file = tmp_path / "bad.json"
        answers_file.write_text("this is not valid json {{{")

        args = _make_prompt_args(answers_file=str(answers_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_prompt(args)

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert "error" in output
        assert "Invalid JSON in answers file" in output["error"]

    def test_partial_json_prints_error(self, tmp_path, capsys) -> None:
        """Truncated JSON content produces error."""
        answers_file = tmp_path / "partial.json"
        answers_file.write_text('{"target": "managed-inf')

        args = _make_prompt_args(answers_file=str(answers_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_prompt(args)

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert "error" in output


# ---------------------------------------------------------------------------
# Tests: Non-existent answers file prints JSON error
# ---------------------------------------------------------------------------


class TestAnswersFileNotFound:
    """Verify non-existent answers file (flag specified) prints JSON error.

    Validates: Requirements NFR-3.1
    """

    def test_nonexistent_file_prints_error_and_exits(self, capsys) -> None:
        """Specifying a non-existent --answers-file produces JSON error."""
        args = _make_prompt_args(answers_file="/nonexistent/path/answers.json")

        with pytest.raises(SystemExit) as exc_info:
            cmd_prompt(args)

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert "error" in output
        assert "not found" in output["error"].lower()
        assert "/nonexistent/path/answers.json" in output["error"]

    def test_nonexistent_file_does_not_call_run_prompt_flow(self, capsys) -> None:
        """When answers file doesn't exist, run_prompt_flow is never called."""
        args = _make_prompt_args(answers_file="/no/such/file.json")

        with patch.object(deploy_helper, "run_prompt_flow") as mock_flow:
            with pytest.raises(SystemExit):
                cmd_prompt(args)
            mock_flow.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: CLI parser integration
# ---------------------------------------------------------------------------


class TestParserIntegration:
    """Verify the argparse parser correctly wires prompt subcommand flags."""

    def test_prompt_subcommand_parses_all_flags(self) -> None:
        """Parser correctly handles --config-file, --target, --instance-type, --answers-file."""
        parser = build_parser()
        args = parser.parse_args([
            "prompt",
            "--config-file", "do/config",
            "--target", "hyperpod-eks",
            "--instance-type", "ml.p4d.24xlarge",
            "--answers-file", "/tmp/answers.json",
        ])
        assert args.config_file == "do/config"
        assert args.target == "hyperpod-eks"
        assert args.instance_type == "ml.p4d.24xlarge"
        assert args.answers_file == "/tmp/answers.json"

    def test_prompt_subcommand_defaults(self) -> None:
        """Parser provides empty string defaults for optional flags."""
        parser = build_parser()
        args = parser.parse_args(["prompt", "--config-file", "do/config"])
        assert args.target == ""
        assert args.instance_type == ""
        assert args.answers_file == ""

    def test_prompt_subcommand_requires_config_file(self) -> None:
        """Parser exits with error if --config-file is missing."""
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["prompt"])



# ---------------------------------------------------------------------------
# Tests: Flag passthrough sets DEPLOY_ANSWERS env var (FR-3.1)
# ---------------------------------------------------------------------------


class TestFlagPassthrough:
    """Verify per-target flags are converted to DEPLOY_ANSWERS JSON.

    Validates: Requirements FR-3.1, FR-3.2
    """

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_flags_set_deploy_answers_env(self, mock_flow, monkeypatch) -> None:
        """Non-empty flags are serialized into DEPLOY_ANSWERS env var."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="managed-inference",
            instance_type="ml.g5.xlarge",
            endpoint_name="my-ep",
        )
        cmd_prompt(args)
        raw = os.environ.get("DEPLOY_ANSWERS")
        assert raw is not None
        answers = json.loads(raw)
        assert answers["target"] == "managed-inference"
        assert answers["instance_type"] == "ml.g5.xlarge"
        assert answers["endpoint_name"] == "my-ep"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_empty_flags_not_in_deploy_answers(self, mock_flow, monkeypatch) -> None:
        """Empty (default) flag values are omitted from DEPLOY_ANSWERS."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="managed-inference",
            instance_type="ml.g5.xlarge",
        )
        cmd_prompt(args)
        raw = os.environ.get("DEPLOY_ANSWERS")
        assert raw is not None
        answers = json.loads(raw)
        # Only non-empty flags should be present
        assert "endpoint_name" not in answers
        assert "cluster_name" not in answers
        assert "batch_input_path" not in answers
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_no_flags_does_not_set_deploy_answers(self, mock_flow, monkeypatch) -> None:
        """When no flags are provided, DEPLOY_ANSWERS is not set."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)
        args = _make_prompt_args()
        cmd_prompt(args)
        assert os.environ.get("DEPLOY_ANSWERS") is None

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_all_managed_inference_flags(self, mock_flow, monkeypatch) -> None:
        """All managed-inference flags produce complete DEPLOY_ANSWERS."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="managed-inference",
            instance_type="ml.g5.xlarge",
            endpoint_name="prod-ep",
            endpoint_strategy="new",
            gpu_count="1",
            instance_types="ml.g5.xlarge,ml.g5.2xlarge",
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        assert answers["target"] == "managed-inference"
        assert answers["instance_type"] == "ml.g5.xlarge"
        assert answers["endpoint_name"] == "prod-ep"
        assert answers["endpoint_strategy"] == "new"
        assert answers["gpu_count"] == "1"
        assert answers["instance_types"] == "ml.g5.xlarge,ml.g5.2xlarge"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_all_hyperpod_eks_flags(self, mock_flow, monkeypatch) -> None:
        """All hyperpod-eks flags produce correct DEPLOY_ANSWERS."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="hyperpod-eks",
            instance_type="ml.p4d.24xlarge",
            cluster_name="prod-cluster",
            namespace="ml-serving",
            replicas="2",
            gpu_count="8",
            queue="high-priority",
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        assert answers["target"] == "hyperpod-eks"
        assert answers["instance_type"] == "ml.p4d.24xlarge"
        assert answers["cluster_name"] == "prod-cluster"
        assert answers["namespace"] == "ml-serving"
        assert answers["replicas"] == "2"
        assert answers["gpu_count"] == "8"
        assert answers["queue"] == "high-priority"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_all_batch_transform_flags(self, mock_flow, monkeypatch) -> None:
        """All batch-transform flags produce correct DEPLOY_ANSWERS."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="batch-transform",
            instance_type="ml.m5.xlarge",
            batch_input_path="s3://bucket/input",
            batch_output_path="s3://bucket/output",
            batch_split_type="Line",
            batch_strategy="MultiRecord",
            batch_max_concurrent="4",
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        assert answers["target"] == "batch-transform"
        assert answers["instance_type"] == "ml.m5.xlarge"
        assert answers["batch_input_path"] == "s3://bucket/input"
        assert answers["batch_output_path"] == "s3://bucket/output"
        assert answers["batch_split_type"] == "Line"
        assert answers["batch_strategy"] == "MultiRecord"
        assert answers["batch_max_concurrent"] == "4"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_all_async_inference_flags(self, mock_flow, monkeypatch) -> None:
        """All async-inference flags produce correct DEPLOY_ANSWERS."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        args = _make_prompt_args(
            target="async-inference",
            instance_type="ml.g5.xlarge",
            async_output_path="s3://bucket/async-out",
            async_sns_topic="arn:aws:sns:us-east-1:123:topic",
            async_max_concurrent="5",
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        assert answers["target"] == "async-inference"
        assert answers["instance_type"] == "ml.g5.xlarge"
        assert answers["async_output_path"] == "s3://bucket/async-out"
        assert answers["async_sns_topic"] == "arn:aws:sns:us-east-1:123:topic"
        assert answers["async_max_concurrent"] == "5"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)


# ---------------------------------------------------------------------------
# Tests: Flags merge with (and override) answers file values
# ---------------------------------------------------------------------------


class TestFlagAnswerFileMerge:
    """Verify CLI flags merge with answers file, flags taking priority.

    Validates: Requirements FR-3.1, FR-3.2
    """

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_flags_override_answers_file(self, mock_flow, tmp_path, monkeypatch) -> None:
        """CLI flags override values from the answers file."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        answers_file = tmp_path / "answers.json"
        answers_file.write_text(json.dumps({
            "target": "managed-inference",
            "instance_type": "ml.g5.xlarge",
            "endpoint_name": "file-ep",
        }))

        args = _make_prompt_args(
            answers_file=str(answers_file),
            endpoint_name="flag-ep",  # Override the file value
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        # Flag value wins over file value
        assert answers["endpoint_name"] == "flag-ep"
        # File values are preserved for non-overridden keys
        assert answers["target"] == "managed-inference"
        assert answers["instance_type"] == "ml.g5.xlarge"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_file_values_preserved_when_no_flag(self, mock_flow, tmp_path, monkeypatch) -> None:
        """Answers file values are preserved when no corresponding flag is set."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        answers_file = tmp_path / "answers.json"
        answers_file.write_text(json.dumps({
            "target": "batch-transform",
            "batch_input_path": "s3://from-file/input",
            "batch_output_path": "s3://from-file/output",
        }))

        args = _make_prompt_args(
            answers_file=str(answers_file),
            instance_type="ml.m5.xlarge",  # Only this flag is set
        )
        cmd_prompt(args)
        answers = json.loads(os.environ["DEPLOY_ANSWERS"])
        assert answers["batch_input_path"] == "s3://from-file/input"
        assert answers["batch_output_path"] == "s3://from-file/output"
        assert answers["instance_type"] == "ml.m5.xlarge"
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)


# ---------------------------------------------------------------------------
# Tests: Parser accepts all per-target flags
# ---------------------------------------------------------------------------


class TestParserAllFlags:
    """Verify the argparse parser accepts all per-target flags.

    Validates: Requirements FR-3.1, FR-3.5
    """

    def test_parser_accepts_all_flags(self) -> None:
        """Parser correctly parses all per-target flags."""
        parser = build_parser()
        args = parser.parse_args([
            "prompt",
            "--config-file", "do/config",
            "--target", "managed-inference",
            "--instance-type", "ml.g5.xlarge",
            "--endpoint-name", "my-endpoint",
            "--endpoint-strategy", "new",
            "--instance-types", "ml.g5.xlarge,ml.g5.2xlarge",
            "--gpu-count", "1",
            "--cluster-name", "my-cluster",
            "--namespace", "default",
            "--replicas", "2",
            "--queue", "high-priority",
            "--async-output-path", "s3://bucket/async",
            "--async-sns-topic", "arn:aws:sns:us-east-1:123:topic",
            "--async-max-concurrent", "5",
            "--batch-input-path", "s3://bucket/input",
            "--batch-output-path", "s3://bucket/output",
            "--batch-split-type", "Line",
            "--batch-strategy", "MultiRecord",
            "--batch-max-concurrent", "3",
        ])
        assert args.target == "managed-inference"
        assert args.instance_type == "ml.g5.xlarge"
        assert args.endpoint_name == "my-endpoint"
        assert args.endpoint_strategy == "new"
        assert args.instance_types == "ml.g5.xlarge,ml.g5.2xlarge"
        assert args.gpu_count == "1"
        assert args.cluster_name == "my-cluster"
        assert args.namespace == "default"
        assert args.replicas == "2"
        assert args.queue == "high-priority"
        assert args.async_output_path == "s3://bucket/async"
        assert args.async_sns_topic == "arn:aws:sns:us-east-1:123:topic"
        assert args.async_max_concurrent == "5"
        assert args.batch_input_path == "s3://bucket/input"
        assert args.batch_output_path == "s3://bucket/output"
        assert args.batch_split_type == "Line"
        assert args.batch_strategy == "MultiRecord"
        assert args.batch_max_concurrent == "3"

    def test_parser_defaults_all_flags_to_empty(self) -> None:
        """All per-target flags default to empty string."""
        parser = build_parser()
        args = parser.parse_args(["prompt", "--config-file", "do/config"])
        assert args.endpoint_name == ""
        assert args.endpoint_strategy == ""
        assert args.instance_types == ""
        assert args.gpu_count == ""
        assert args.cluster_name == ""
        assert args.namespace == ""
        assert args.replicas == ""
        assert args.queue == ""
        assert args.async_output_path == ""
        assert args.async_sns_topic == ""
        assert args.async_max_concurrent == ""
        assert args.batch_input_path == ""
        assert args.batch_output_path == ""
        assert args.batch_split_type == ""
        assert args.batch_strategy == ""
        assert args.batch_max_concurrent == ""


# ---------------------------------------------------------------------------
# Import cmd_status for status subcommand tests
# ---------------------------------------------------------------------------

cmd_status = deploy_helper.cmd_status


# ---------------------------------------------------------------------------
# Helpers for status tests
# ---------------------------------------------------------------------------


def _make_status_args(
    config_file: str = "/tmp/config",
    target: str = "",
) -> argparse.Namespace:
    """Build a Namespace mimicking parsed status subcommand args."""
    return argparse.Namespace(
        config_file=config_file,
        target=target,
    )


# ---------------------------------------------------------------------------
# Tests: cmd_status output includes all 4 targets with correct status
# ---------------------------------------------------------------------------


class TestCmdStatusAllTargets:
    """Verify cmd_status shows all 4 targets with correct status values.

    Validates: Requirements FR-2.8, FR-4.7
    """

    def test_all_targets_present_in_output(self, tmp_path, capsys) -> None:
        """Status output includes all 4 deployment targets."""
        config_file = tmp_path / "config"
        config_file.write_text('export DEPLOYMENT_TARGET="managed-inference"\n')

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert "targets" in output
        assert "managed-inference" in output["targets"]
        assert "hyperpod-eks" in output["targets"]
        assert "async-inference" in output["targets"]
        assert "batch-transform" in output["targets"]

    def test_active_status_shown_correctly(self, tmp_path, capsys) -> None:
        """Target with a populated status var shows that status value."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        )

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["targets"]["managed-inference"]["status"] == "InService"

    def test_undeployed_targets_show_not_deployed(self, tmp_path, capsys) -> None:
        """Targets without status vars show 'not deployed'."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["targets"]["hyperpod-eks"]["status"] == "not deployed"
        assert output["targets"]["async-inference"]["status"] == "not deployed"
        assert output["targets"]["batch-transform"]["status"] == "not deployed"


# ---------------------------------------------------------------------------
# Tests: Non-existent config file shows all targets as "not deployed"
# ---------------------------------------------------------------------------


class TestCmdStatusNoConfigFile:
    """Verify status when config file doesn't exist (first-time scenario).

    Validates: Requirements FR-2.8
    """

    def test_nonexistent_config_all_not_deployed(self, capsys) -> None:
        """Non-existent config file results in all targets as 'not deployed'."""
        args = _make_status_args(config_file="/nonexistent/path/config")

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["active_target"] == ""
        for target_name, target_info in output["targets"].items():
            assert target_info["status"] == "not deployed", (
                f"Expected 'not deployed' for {target_name}"
            )

    def test_nonexistent_config_empty_active_target(self, capsys) -> None:
        """Non-existent config file results in empty active_target."""
        args = _make_status_args(config_file="/nonexistent/path/config")

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["active_target"] == ""


# ---------------------------------------------------------------------------
# Tests: Config with populated status vars shows correct status
# ---------------------------------------------------------------------------


class TestCmdStatusPopulatedConfig:
    """Verify status with fully populated config file.

    Validates: Requirements FR-4.7
    """

    def test_multiple_deployed_targets(self, tmp_path, capsys) -> None:
        """Multiple targets with status vars show their respective statuses."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
            'export DEPLOYMENT_TARGET_ASYNC_STATUS=""\n'
            'export DEPLOYMENT_TARGET_BATCH_STATUS=""\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
            'export HP_CLUSTER_NAME="my-cluster"\n'
            'export HP_GPU_COUNT="4"\n'
        )

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["targets"]["managed-inference"]["status"] == "InService"
        assert output["targets"]["hyperpod-eks"]["status"] == "Running"
        assert output["targets"]["async-inference"]["status"] == "not deployed"
        assert output["targets"]["batch-transform"]["status"] == "not deployed"


# ---------------------------------------------------------------------------
# Tests: --target flag filters to single target
# ---------------------------------------------------------------------------


class TestCmdStatusTargetFilter:
    """Verify --target flag filters status output to a single target.

    Validates: Requirements FR-3.1
    """

    def test_target_flag_shows_only_specified_target(self, tmp_path, capsys) -> None:
        """Passing --target shows only that target in the output."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="wise-bert-ep"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="managed-inference",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        # Only one target in the output
        assert len(output["targets"]) == 1
        assert "managed-inference" in output["targets"]
        assert "hyperpod-eks" not in output["targets"]

    def test_target_flag_filters_to_hyperpod(self, tmp_path, capsys) -> None:
        """--target hyperpod-eks shows only hyperpod-eks."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="prod-cluster"\n'
            'export HP_GPU_COUNT="4"\n'
            'export HP_NAMESPACE="ml-inference"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="hyperpod-eks",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert len(output["targets"]) == 1
        assert "hyperpod-eks" in output["targets"]


# ---------------------------------------------------------------------------
# Tests: Per-target details (endpoint_name, cluster_name, etc.)
# ---------------------------------------------------------------------------


class TestCmdStatusPerTargetDetails:
    """Verify per-target context details are included in output.

    Validates: Requirements FR-4.7
    """

    def test_managed_inference_includes_endpoint_details(self, tmp_path, capsys) -> None:
        """managed-inference target includes endpoint_name and endpoint_strategy."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="wise-bert-service-ep"\n'
            'export ENDPOINT_STRATEGY="new"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="managed-inference",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        mi = output["targets"]["managed-inference"]
        assert mi["endpoint_name"] == "wise-bert-service-ep"
        assert mi["endpoint_strategy"] == "new"

    def test_hyperpod_eks_includes_cluster_details(self, tmp_path, capsys) -> None:
        """hyperpod-eks target includes cluster_name, gpu_count, namespace."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="prod-gpu-cluster"\n'
            'export HP_GPU_COUNT="4"\n'
            'export HP_NAMESPACE="ml-serving"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="hyperpod-eks",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        hp = output["targets"]["hyperpod-eks"]
        assert hp["cluster_name"] == "prod-gpu-cluster"
        assert hp["gpu_count"] == "4"
        assert hp["namespace"] == "ml-serving"

    def test_async_inference_includes_s3_output_path(self, tmp_path, capsys) -> None:
        """async-inference target includes s3_output_path."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/output"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="async-inference",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        async_info = output["targets"]["async-inference"]
        assert async_info["s3_output_path"] == "s3://my-bucket/output"

    def test_batch_transform_includes_paths(self, tmp_path, capsys) -> None:
        """batch-transform target includes input_path and output_path."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
            'export BATCH_INPUT_PATH="s3://bucket/input"\n'
            'export BATCH_OUTPUT_PATH="s3://bucket/output"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="batch-transform",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        batch = output["targets"]["batch-transform"]
        assert batch["input_path"] == "s3://bucket/input"
        assert batch["output_path"] == "s3://bucket/output"

    def test_empty_details_are_empty_strings(self, tmp_path, capsys) -> None:
        """Missing detail vars default to empty string in output."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )

        args = _make_status_args(
            config_file=str(config_file),
            target="managed-inference",
        )

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        mi = output["targets"]["managed-inference"]
        assert mi["endpoint_name"] == ""
        assert mi["endpoint_strategy"] == ""


# ---------------------------------------------------------------------------
# Tests: Active target field matches DEPLOYMENT_TARGET from config
# ---------------------------------------------------------------------------


class TestCmdStatusActiveTarget:
    """Verify active_target field matches DEPLOYMENT_TARGET from config.

    Validates: Requirements FR-4.7
    """

    def test_active_target_matches_config(self, tmp_path, capsys) -> None:
        """active_target field reflects DEPLOYMENT_TARGET value."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"\n'
        )

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["active_target"] == "managed-inference"

    def test_active_target_hyperpod(self, tmp_path, capsys) -> None:
        """active_target correctly reflects hyperpod-eks when set."""
        config_file = tmp_path / "config"
        config_file.write_text(
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export DEPLOYMENT_TARGET_HP_STATUS="Running"\n'
        )

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["active_target"] == "hyperpod-eks"

    def test_active_target_empty_when_not_set(self, tmp_path, capsys) -> None:
        """active_target is empty string when DEPLOYMENT_TARGET not in config."""
        config_file = tmp_path / "config"
        config_file.write_text('export INSTANCE_TYPE="ml.g5.xlarge"\n')

        args = _make_status_args(config_file=str(config_file))

        with pytest.raises(SystemExit) as exc_info:
            cmd_status(args)

        assert exc_info.value.code == 0
        captured = capsys.readouterr()
        output = json.loads(captured.out)

        assert output["active_target"] == ""


# ---------------------------------------------------------------------------
# Tests: No-TTY detection with error message (Task 5.5)
# ---------------------------------------------------------------------------


class TestNoTtyDetection:
    """Verify no-TTY detection prints error when prompts are needed.

    Validates: Requirements FR-2.1, NFR-2.2
    """

    def test_no_tty_no_flags_prints_error_and_exits(self, capsys, monkeypatch) -> None:
        """When stdin is not a TTY and no flags/answers provided, prints JSON error."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        # Make sys.stdin.isatty() return False
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))

        args = _make_prompt_args()

        with pytest.raises(SystemExit) as exc_info:
            cmd_prompt(args)

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        output = json.loads(captured.out)
        assert "error" in output
        assert "no TTY detected" in output["error"]

    def test_no_tty_error_includes_actionable_guidance(self, capsys, monkeypatch) -> None:
        """Error message includes flag names, env var, and --help reference."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))

        args = _make_prompt_args()

        with pytest.raises(SystemExit):
            cmd_prompt(args)

        captured = capsys.readouterr()
        output = json.loads(captured.out)
        error_msg = output["error"]
        assert "--target" in error_msg
        assert "--instance-type" in error_msg
        assert "DEPLOY_ANSWERS" in error_msg
        assert "do/deploy --help" in error_msg

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_no_tty_with_flags_proceeds_normally(self, mock_flow, monkeypatch) -> None:
        """When stdin is not a TTY but flags are provided, proceeds without error."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))

        args = _make_prompt_args(
            target="managed-inference",
            instance_type="ml.g5.xlarge",
        )
        cmd_prompt(args)

        mock_flow.assert_called_once()
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_no_tty_with_answers_file_proceeds_normally(
        self, mock_flow, tmp_path, monkeypatch
    ) -> None:
        """When stdin is not a TTY but answers file is provided, proceeds without error."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))

        answers_file = tmp_path / "answers.json"
        answers_file.write_text(json.dumps({"target": "batch-transform"}))

        args = _make_prompt_args(answers_file=str(answers_file))
        cmd_prompt(args)

        mock_flow.assert_called_once()
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)

    @patch.object(deploy_helper, "run_prompt_flow")
    def test_tty_no_flags_proceeds_normally(self, mock_flow, monkeypatch) -> None:
        """When stdin IS a TTY and no flags provided, proceeds normally (will prompt)."""
        monkeypatch.delenv("DEPLOY_ANSWERS", raising=False)
        # Ensure isatty returns True (default for real terminals)
        monkeypatch.setattr("sys.stdin.isatty", lambda: True)

        args = _make_prompt_args()
        cmd_prompt(args)

        mock_flow.assert_called_once()
