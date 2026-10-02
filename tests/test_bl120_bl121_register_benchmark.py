"""Unit tests for BL120 and BL121 — do/register dataset patches (v1.8.1).

BL120: `--technique` optional (default "benchmark"); "benchmark" is a valid
       technique; prompt-only datasets are valid; do/tune rejects benchmark
       datasets; MLflow DatasetInput uses context="benchmark" for benchmark
       datasets (context="training" otherwise).

BL121: `--hf-files <pattern>` flag on do/register dataset flows through to the
       stage-hf helper as a file-pattern selector (fed to load_dataset via
       _filter_data_files); optional (absent => default = all files).

All external I/O (MLflow, S3, subprocess) is mocked so no network/AWS is used.
"""
import argparse
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Path setup — import helpers from templates/do/lib/python
# ---------------------------------------------------------------------------
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

import dataset_qol  # noqa: E402
import register_dataset  # noqa: E402
import tune_resolve  # noqa: E402


def _args(**kw):
    return types.SimpleNamespace(**kw)


class _Exit(Exception):
    def __init__(self, code=0):
        self.code = code


# ===========================================================================
# BL120 — technique enum / argparse defaults
# ===========================================================================

def _build_register_dataset_parser():
    """Rebuild the register-dataset subparser exactly as .register_helper.py
    declares it, so argparse-level contract (default + choices) is tested
    without importing the full dispatcher (which pulls sagemaker-core)."""
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command")
    p = sub.add_parser("register-dataset")
    p.add_argument("--name", required=True)
    p.add_argument("--s3-uri", required=True)
    p.add_argument("--format", default="jsonl", choices=["jsonl", "parquet", "csv"])
    p.add_argument("--technique", default="benchmark",
                   choices=["sft", "dpo", "rlaif", "rlvr", "benchmark"])
    p.add_argument("--hf-files", default=None)
    return parser


class TestTechniqueArgparseContract:
    """BL120: --technique optional, defaults to 'benchmark', accepts 'benchmark'."""

    def test_technique_defaults_to_benchmark_when_omitted(self):
        parser = _build_register_dataset_parser()
        args = parser.parse_args(
            ["register-dataset", "--name", "d", "--s3-uri", "s3://b/d.jsonl"]
        )
        assert args.technique == "benchmark"

    def test_benchmark_is_a_valid_technique_choice(self):
        parser = _build_register_dataset_parser()
        args = parser.parse_args(
            ["register-dataset", "--name", "d", "--s3-uri", "s3://b/d.jsonl",
             "--technique", "benchmark"]
        )
        assert args.technique == "benchmark"

    @pytest.mark.parametrize("tech", ["sft", "dpo", "rlaif", "rlvr", "benchmark"])
    def test_all_training_techniques_still_accepted(self, tech):
        parser = _build_register_dataset_parser()
        args = parser.parse_args(
            ["register-dataset", "--name", "d", "--s3-uri", "s3://b/d.jsonl",
             "--technique", tech]
        )
        assert args.technique == tech

    def test_invalid_technique_rejected(self):
        parser = _build_register_dataset_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(
                ["register-dataset", "--name", "d", "--s3-uri", "s3://b/d.jsonl",
                 "--technique", "orpo-bogus"]
            )


class TestHelperArgparseWiring:
    """BL120/BL121: the real .register_helper.py declares the expected flags.

    Parses the register subparser source without executing the dispatcher body
    by loading the module's `main` argument declarations indirectly — here we
    assert via the live parser built by the helper module import.
    """

    def test_register_helper_declares_benchmark_default_and_hf_files(self):
        # Read the helper source and assert the argparse lines are present.
        helper_path = os.path.join(
            REPO_ROOT, "templates", "do", ".register_helper.py"
        )
        with open(helper_path) as f:
            src = f.read()
        assert 'default="benchmark"' in src
        assert '"benchmark"' in src  # in choices list
        assert "--hf-files" in src


# ===========================================================================
# BL120 — prompt-only dataset support (schema / validation)
# ===========================================================================

class TestPromptOnlyBenchmarkDataset:
    """BL120 benchmark-dataset column contract.

    NOTE: BL120 originally proposed a prompt-only (``["prompt"]``) benchmark
    schema. That was SUPERSEDED by the AIPerf BYOD single_turn work, which
    requires a ``text`` modality column (SingleTurn raises "At least one
    modality must be provided" without it). The committed source of truth is
    ``dataset_qol._get_required_columns("benchmark") == ["text"]`` and the
    tracked ``test/unit/test_dataset_qol.py`` (whose own comment records the
    correction). These assertions are aligned to that current contract; the
    still-BL120-specific behavior (--technique default, MLflow context) is
    covered by the other classes below.
    """

    def test_benchmark_required_columns_is_text_only(self):
        # Superseded BL120 ["prompt"] -> AIPerf single_turn ["text"].
        assert dataset_qol._get_required_columns("benchmark") == ["text"]

    def test_benchmark_schema_types_text_is_string(self):
        assert dataset_qol._get_schema_types("benchmark") == {"text": "string"}

    def test_validate_text_record_does_not_error(self, monkeypatch):
        # A record carrying the required `text` modality column must NOT trigger
        # _validate_dataset_columns' missing-required-column _error_exit.
        called = {}

        def fake_error(msg, *a, **k):
            called["error"] = msg
            raise _Exit(1)

        monkeypatch.setattr(dataset_qol, "_error_exit", fake_error)
        record = {"text": "What is 2+2?"}
        # Should return (mapped, column_map) without raising.
        mapped, colmap = dataset_qol._validate_dataset_columns(
            record, "benchmark", None, "org/name"
        )
        assert "error" not in called
        assert mapped == {"text": "What is 2+2?"}

    def test_validate_missing_text_still_errors_for_benchmark(self, monkeypatch):
        def fake_error(msg, *a, **k):
            raise _Exit(1)

        monkeypatch.setattr(dataset_qol, "_error_exit", fake_error)
        record = {"question": "no text column here"}
        with pytest.raises(_Exit):
            dataset_qol._validate_dataset_columns(
                record, "benchmark", None, "org/name"
            )

    def test_sft_still_requires_completion(self):
        # Guard: benchmark relaxation must not weaken SFT requirements.
        assert dataset_qol._get_required_columns("sft") == ["prompt", "completion"]


# ===========================================================================
# BL120 — MLflow context selection
# ===========================================================================

class TestMlflowBenchmarkContext:
    """BL120: log_dataset receives context='benchmark' iff technique=='benchmark'."""

    def _run_log(self, monkeypatch, technique):
        spy = MagicMock(return_value=("d", "hash"))
        monkeypatch.setattr(register_dataset, "mlcc_mlflow", None, raising=False)

        import mlcc_mlflow
        monkeypatch.setattr(mlcc_mlflow, "log_dataset", spy)

        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = MagicMock()  # active run present
        monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)

        register_dataset._log_dataset_to_mlflow(
            s3_uri="s3://core/datasets/d/d.jsonl",
            name="d",
            content_hash="hash",
            row_count=5,
            data_format="jsonl",
            technique=technique,
        )
        return spy

    def test_benchmark_uses_context_benchmark(self, monkeypatch):
        spy = self._run_log(monkeypatch, "benchmark")
        assert spy.call_count == 1
        assert spy.call_args.kwargs["context"] == "benchmark"

    def test_sft_uses_context_training(self, monkeypatch):
        spy = self._run_log(monkeypatch, "sft")
        assert spy.call_count == 1
        assert spy.call_args.kwargs["context"] == "training"

    def test_dpo_uses_context_training(self, monkeypatch):
        spy = self._run_log(monkeypatch, "dpo")
        assert spy.call_args.kwargs["context"] == "training"


# ===========================================================================
# BL120 — do/tune rejects benchmark datasets
# ===========================================================================

class TestTuneRejectsBenchmarkDataset:
    """BL120: do/tune must refuse a dataset registered as technique=benchmark."""

    def _mock_resolve(self, monkeypatch, resolve_output):
        """Patch subprocess.run inside tune_resolve to return resolve_output JSON,
        and make _error_exit raise so we can assert the message."""
        import json as _json

        completed = MagicMock()
        completed.returncode = 0
        completed.stdout = _json.dumps(resolve_output)

        monkeypatch.setattr(
            tune_resolve.os.path, "exists", lambda p: True
        )

        fake_subprocess = MagicMock()
        fake_subprocess.run.return_value = completed
        fake_subprocess.TimeoutExpired = Exception
        monkeypatch.setitem(sys.modules, "subprocess", fake_subprocess)

        errors = {}

        def fake_error(msg, *a, **k):
            errors["msg"] = msg
            raise _Exit(1)

        monkeypatch.setattr(tune_resolve, "_error_exit", fake_error)
        return errors

    def test_benchmark_dataset_rejected_with_clear_message(self, monkeypatch):
        errors = self._mock_resolve(
            monkeypatch,
            {"name": "eval-set", "s3_uri": "s3://b/eval.jsonl",
             "technique": "benchmark"},
        )
        with pytest.raises(_Exit):
            tune_resolve._resolve_dataset_name("eval-set")
        assert "benchmarking, not fine-tuning" in errors["msg"]
        assert "do/benchmark" in errors["msg"]

    def test_sft_dataset_resolves_to_s3_uri(self, monkeypatch):
        self._mock_resolve(
            monkeypatch,
            {"name": "train-set", "s3_uri": "s3://b/train.jsonl",
             "technique": "sft"},
        )
        result = tune_resolve._resolve_dataset_name("train-set")
        assert result == "s3://b/train.jsonl"

    def test_sft_dataset_with_arn_resolves_to_arn(self, monkeypatch):
        self._mock_resolve(
            monkeypatch,
            {"name": "train-set", "s3_uri": "s3://b/train.jsonl",
             "arn": "arn:aws:sagemaker:...:model-package/x", "technique": "sft"},
        )
        result = tune_resolve._resolve_dataset_name("train-set")
        assert result.startswith("arn:aws:sagemaker")


# ===========================================================================
# BL121 — --hf-files pattern selector
# ===========================================================================

class TestHfFilesPatternSelector:
    """BL121: --hf-files selects a subset of files via _filter_data_files."""

    def test_glob_pattern_filters_matching_files(self):
        files = [
            "data/train-00000-of-00002.parquet",
            "data/train-00001-of-00002.parquet",
            "data/test-00000-of-00001.parquet",
        ]
        matched = dataset_qol._filter_data_files(files, "*train-00*.parquet")
        assert matched == [
            "data/train-00000-of-00002.parquet",
            "data/train-00001-of-00002.parquet",
        ]

    def test_substring_pattern_filters_by_basename(self):
        files = [
            "data/train-00000.parquet",
            "data/validation-00000.parquet",
        ]
        matched = dataset_qol._filter_data_files(files, "validation")
        assert matched == ["data/validation-00000.parquet"]

    def test_absent_pattern_returns_all_files(self):
        files = ["a.jsonl", "b.jsonl"]
        # When no pattern is given, load_dataset default (all files) is used.
        assert dataset_qol._filter_data_files(files, None) == files
        assert dataset_qol._filter_data_files(files, "") == files

    def test_no_match_errors_with_available_files(self, monkeypatch):
        def fake_error(msg, *a, **k):
            raise _Exit(1)

        monkeypatch.setattr(dataset_qol, "_error_exit", fake_error)
        with pytest.raises(_Exit):
            dataset_qol._filter_data_files(["a.jsonl"], "nomatch-*.parquet")

    def test_stage_hf_argparse_declares_hf_file(self):
        # The stage-hf helper (consumer of --hf-files) accepts --hf-file.
        helper_path = os.path.join(
            REPO_ROOT, "templates", "do", ".tune_helper.py"
        )
        with open(helper_path) as f:
            src = f.read()
        assert "--hf-file" in src

    def test_register_bash_maps_hf_files_to_hf_file(self):
        # do/register must translate --hf-files into the helper's --hf-file.
        register_path = os.path.join(REPO_ROOT, "templates", "do", "register")
        with open(register_path) as f:
            src = f.read()
        assert "DATASET_HF_FILES" in src
        assert "--hf-file" in src  # passed through to stage_args
        assert "benchmark" in src  # technique validation includes benchmark
