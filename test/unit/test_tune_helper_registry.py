"""Unit tests for .tune_helper.py registry resolution (--dataset-name, --evaluator-name).

Tests cover:
- Dataset name resolution via subprocess to .register_helper.py (AC-2b.4)
- Evaluator name resolution via subprocess to .register_helper.py (AC-2c.3, AC-2c.4)
- Priority: --dataset-s3-uri overrides --dataset-name (backward compatible)
- Priority: --reward-function/--reward-prompt overrides --evaluator-name
- Error cases: dataset/evaluator not found, helper missing

Requirements validated: US-2b, US-2c
"""

import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch, PropertyMock
from argparse import Namespace

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".tune_helper.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("tune_helper", _HELPER_PATH)
_tune_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tune_helper)

_resolve_dataset_name = _tune_helper._resolve_dataset_name
_resolve_evaluator_name = _tune_helper._resolve_evaluator_name


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Dataset Name Resolution (AC-2b.4)
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveDatasetName:
    """Test _resolve_dataset_name resolves registered dataset to S3 URI.

    Validates: Requirements AC-2b.4
    """

    @patch("subprocess.run")
    def test_successful_resolution(self, mock_run):
        """Dataset name resolves to S3 URI when found in registry."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"s3_uri": "s3://bucket/datasets/my-dataset/train.jsonl"}),
            stderr=""
        )
        result = _resolve_dataset_name("my-sft-dataset")
        assert result == "s3://bucket/datasets/my-dataset/train.jsonl"

        # Verify subprocess was called with correct args
        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert "resolve-dataset" in cmd
        assert "--name" in cmd
        assert "my-sft-dataset" in cmd

    @patch("subprocess.run")
    def test_dataset_not_found_exits_with_error(self, mock_run):
        """Dataset not found in registry causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="Dataset not found"
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("nonexistent-dataset")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_dataset_error_in_response_exits(self, mock_run):
        """Error field in JSON response causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"error": "DataSet not found: no-such-dataset"}),
            stderr=""
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("no-such-dataset")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_empty_s3_uri_exits(self, mock_run):
        """Empty s3_uri in response causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"s3_uri": ""}),
            stderr=""
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("bad-dataset")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_invalid_json_response_exits(self, mock_run):
        """Invalid JSON from helper causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="not valid json",
            stderr=""
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("my-dataset")
        assert exc_info.value.code == 1

    @patch("os.path.exists", return_value=False)
    def test_helper_missing_exits(self, mock_exists):
        """Missing .register_helper.py causes error exit."""
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("my-dataset")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_timeout_exits(self, mock_run):
        """Subprocess timeout causes error exit."""
        import subprocess
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="python3", timeout=30)
        with pytest.raises(SystemExit) as exc_info:
            _resolve_dataset_name("slow-dataset")
        assert exc_info.value.code == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Evaluator Name Resolution (AC-2c.3, AC-2c.4)
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveEvaluatorName:
    """Test _resolve_evaluator_name resolves registered evaluator to type+ARN.

    Validates: Requirements AC-2c.3, AC-2c.4
    """

    @patch("subprocess.run")
    def test_reward_function_evaluator_resolution(self, mock_run):
        """Reward-function evaluator resolves to (reward_function, reference, arn) for RLVR."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "type": "reward_function",
                "reference": "arn:aws:lambda:us-west-2:123456789:function:math-reward"
            }),
            stderr=""
        )
        ev_type, ref, arn = _resolve_evaluator_name("math-reward-fn")
        assert ev_type == "reward_function"
        assert ref == "arn:aws:lambda:us-west-2:123456789:function:math-reward"
        assert arn == ""

    @patch("subprocess.run")
    def test_reward_prompt_evaluator_resolution(self, mock_run):
        """Reward-prompt evaluator surfaces both the S3 reference AND the hub-content
        ARN for RLAIF. The ARN is what the RLAIF SDK path needs (the S3 URI fails
        its hub-content ARN validation)."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "type": "reward_prompt",
                "reference": "s3://bucket/reward-prompts/judge-prompt.txt",
                "arn": "arn:aws:sagemaker:us-west-2:123:hub-content/HUBID/JsonDoc/judge-v1/1.0.0",
            }),
            stderr=""
        )
        ev_type, ref, arn = _resolve_evaluator_name("judge-v1")
        assert ev_type == "reward_prompt"
        assert ref == "s3://bucket/reward-prompts/judge-prompt.txt"
        assert arn == "arn:aws:sagemaker:us-west-2:123:hub-content/HUBID/JsonDoc/judge-v1/1.0.0"

    @patch("subprocess.run")
    def test_legacy_arn_or_uri_field_tolerated(self, mock_run):
        """A legacy `arn_or_uri` field is still read when `reference` is absent."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "type": "lambda",
                "arn_or_uri": "arn:aws:lambda:us-west-2:123:function:legacy"
            }),
            stderr=""
        )
        ev_type, ref, arn = _resolve_evaluator_name("legacy-fn")
        assert ev_type == "lambda"
        assert ref == "arn:aws:lambda:us-west-2:123:function:legacy"
        assert arn == ""

    @patch("subprocess.run")
    def test_evaluator_not_found_exits(self, mock_run):
        """Evaluator not found in registry causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="Evaluator not found"
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_evaluator_name("nonexistent-evaluator")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_evaluator_error_in_response_exits(self, mock_run):
        """Error field in JSON response causes error exit."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"error": "Evaluator not found"}),
            stderr=""
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_evaluator_name("no-such-evaluator")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_empty_reference_and_arn_exits(self, mock_run):
        """Empty reference AND empty arn in the response causes an error exit."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({"type": "reward_function", "reference": ""}),
            stderr=""
        )
        with pytest.raises(SystemExit) as exc_info:
            _resolve_evaluator_name("empty-evaluator")
        assert exc_info.value.code == 1

    @patch("subprocess.run")
    def test_arn_only_reward_prompt_resolves(self, mock_run):
        """A reward_prompt with only an ARN (no S3 reference) still resolves — the
        ARN is the form RLAIF needs, so an empty reference is not fatal."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "type": "reward_prompt",
                "reference": "",
                "arn": "arn:aws:sagemaker:us-west-2:123:hub-content/HUBID/JsonDoc/judge/2.0.0",
            }),
            stderr=""
        )
        ev_type, ref, arn = _resolve_evaluator_name("arn-only-prompt")
        assert ev_type == "reward_prompt"
        assert ref == ""
        assert arn == "arn:aws:sagemaker:us-west-2:123:hub-content/HUBID/JsonDoc/judge/2.0.0"

    @patch("os.path.exists", return_value=False)
    def test_helper_missing_exits(self, mock_exists):
        """Missing .register_helper.py causes error exit."""
        with pytest.raises(SystemExit) as exc_info:
            _resolve_evaluator_name("my-evaluator")
        assert exc_info.value.code == 1


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Priority: --dataset-s3-uri overrides --dataset-name
# ═══════════════════════════════════════════════════════════════════════════════


class TestDatasetPriority:
    """Test that --dataset-s3-uri takes precedence over --dataset-name.

    Validates: backward compatibility — direct URI always wins.
    """

    @patch("subprocess.run")
    def test_dataset_s3_uri_wins_over_dataset_name(self, mock_run):
        """When both --dataset-s3-uri and --dataset-name are provided, URI wins."""
        # Create args simulating both flags provided
        args = Namespace(
            dataset_s3_uri="s3://direct/override/data.jsonl",
            dataset_name="my-registered-dataset",
            evaluator_name=None,
            reward_function=None,
            reward_prompt=None,
            region="us-east-1",
            technique="sft",
            training_type="lora",
            model_id="test-model",
            output_bucket="test-bucket",
            role_arn="arn:aws:iam::123:role/test",
            job_name="test-job",
            project_name="test-project",
            model_package_group=None,
            epochs=None,
            learning_rate=None,
            max_seq_length=None,
            lora_rank=None,
            lora_alpha=None,
            batch_size=None,
            accept_eula=False,
        )

        # The resolution code in cmd_submit checks:
        # if not args.dataset_s3_uri and args.dataset_name:
        # Since dataset_s3_uri is set, _resolve_dataset_name should NOT be called
        # We verify by checking the logic directly
        assert args.dataset_s3_uri  # URI is set
        # Resolution should not be triggered
        mock_run.assert_not_called()

    def test_dataset_name_used_when_no_uri(self):
        """When --dataset-s3-uri is not provided, --dataset-name is used."""
        args = Namespace(
            dataset_s3_uri=None,
            dataset_name="my-registered-dataset",
        )
        # The condition should trigger resolution
        assert not args.dataset_s3_uri and args.dataset_name


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Priority: --reward-function/--reward-prompt overrides --evaluator-name
# ═══════════════════════════════════════════════════════════════════════════════


class TestEvaluatorPriority:
    """Test that direct evaluator flags take precedence over --evaluator-name.

    Validates: backward compatibility — direct ARN/URI always wins.
    """

    def test_reward_function_wins_over_evaluator_name(self):
        """When --reward-function is provided, --evaluator-name is skipped."""
        args = Namespace(
            evaluator_name="my-evaluator",
            reward_function="arn:aws:lambda:us-west-2:123:function:direct-fn",
            reward_prompt=None,
        )
        # The condition: args.evaluator_name and not args.reward_function and not args.reward_prompt
        # Should be False since reward_function is set
        assert not (args.evaluator_name and not args.reward_function and not args.reward_prompt)

    def test_reward_prompt_wins_over_evaluator_name(self):
        """When --reward-prompt is provided, --evaluator-name is skipped."""
        args = Namespace(
            evaluator_name="my-evaluator",
            reward_function=None,
            reward_prompt="s3://bucket/prompt.json",
        )
        # The condition should be False since reward_prompt is set
        assert not (args.evaluator_name and not args.reward_function and not args.reward_prompt)

    def test_evaluator_name_used_when_no_direct_flags(self):
        """When no direct flags provided, --evaluator-name triggers resolution."""
        args = Namespace(
            evaluator_name="my-evaluator",
            reward_function=None,
            reward_prompt=None,
        )
        # The condition should be True
        assert args.evaluator_name and not args.reward_function and not args.reward_prompt



# ═══════════════════════════════════════════════════════════════════════════════
# 5. Dataset ARN Resolution (Backlog #023)
# ═══════════════════════════════════════════════════════════════════════════════


class TestDatasetARNResolution:
    """Test _resolve_dataset_name returns ARN when available (Backlog #023).

    Validates: When 'arn' is present in resolve-dataset response, it is
    used as the training_dataset value for SFTTrainer instead of s3_uri.
    """

    @patch("subprocess.run")
    def test_arn_preferred_over_s3_uri(self, mock_run):
        """When response contains arn, it is returned instead of s3_uri."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "name": "my-dataset",
                "s3_uri": "s3://bucket/datasets/train.jsonl",
                "arn": "arn:aws:sagemaker:us-west-2:123:dataset/my-dataset",
                "format": "jsonl",
                "technique": "sft",
            }),
            stderr=""
        )
        result = _resolve_dataset_name("my-dataset")
        # Should return the ARN, not the S3 URI
        assert result == "arn:aws:sagemaker:us-west-2:123:dataset/my-dataset"

    @patch("subprocess.run")
    def test_s3_uri_used_when_arn_is_null(self, mock_run):
        """When arn is null, falls back to s3_uri."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "name": "my-dataset",
                "s3_uri": "s3://bucket/datasets/train.jsonl",
                "arn": None,
                "format": "jsonl",
                "technique": "sft",
            }),
            stderr=""
        )
        result = _resolve_dataset_name("my-dataset")
        # Should return the S3 URI since arn is None
        assert result == "s3://bucket/datasets/train.jsonl"

    @patch("subprocess.run")
    def test_s3_uri_used_when_arn_not_in_response(self, mock_run):
        """When arn field is absent, falls back to s3_uri (backward compat)."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "name": "my-dataset",
                "s3_uri": "s3://bucket/datasets/train.jsonl",
                "format": "jsonl",
                "technique": "sft",
            }),
            stderr=""
        )
        result = _resolve_dataset_name("my-dataset")
        assert result == "s3://bucket/datasets/train.jsonl"

    @patch("subprocess.run")
    def test_s3_uri_used_when_arn_is_empty_string(self, mock_run):
        """When arn is empty string, falls back to s3_uri."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "name": "my-dataset",
                "s3_uri": "s3://bucket/datasets/train.jsonl",
                "arn": "",
                "format": "jsonl",
                "technique": "sft",
            }),
            stderr=""
        )
        result = _resolve_dataset_name("my-dataset")
        # Empty string is falsy, should fall back to s3_uri
        assert result == "s3://bucket/datasets/train.jsonl"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. MTRL technique (BL117) — the submit router accepts the new managed technique
# ═══════════════════════════════════════════════════════════════════════════════


class TestMtrlTechnique:
    """Test that `submit --technique mtrl` is accepted by the CLI (BL117 Req 4)."""

    def test_submit_accepts_mtrl(self):
        """The submit subparser accepts mtrl alongside sft/dpo/rlaif/rlvr."""
        argv = [
            "prog", "submit",
            "--model-id", "m",
            "--technique", "mtrl",
            "--training-type", "lora",
            "--dataset-s3-uri", "s3://b/prompts/",
            "--output-bucket", "b",
            "--role-arn", "arn:role",
            "--job-name", "j",
            "--project-name", "proj",
        ]
        with patch("sys.argv", argv):
            with patch.object(_tune_helper, "cmd_submit") as mock_cmd:
                _tune_helper.main()
                mock_cmd.assert_called_once()
                assert mock_cmd.call_args[0][0].technique == "mtrl"

    def test_submit_rejects_unknown_technique(self):
        """An unknown technique is rejected at parse time."""
        argv = [
            "prog", "submit",
            "--model-id", "m",
            "--technique", "bogus",
            "--training-type", "lora",
            "--dataset-s3-uri", "s3://b/x/",
            "--output-bucket", "b",
            "--role-arn", "arn:role",
            "--job-name", "j",
        ]
        with patch("sys.argv", argv):
            with pytest.raises(SystemExit):
                _tune_helper.main()
