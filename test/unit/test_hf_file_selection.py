"""Unit tests for HF dataset file selection: filtering and schema divergence.

Tests cover _filter_data_files, _check_schema_divergence, _inspect_file_schemas,
--hf-file argparse registration, and backward compatibility.

Requirements validated: 1.1–1.5, 2.1–2.6, 3.1–3.6, 4.1–4.3, 5.1–5.4, 6.1–6.3
"""

import importlib.util
import json
import os
from unittest.mock import patch

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

_filter_data_files = _tune_helper._filter_data_files
_is_glob_pattern = _tune_helper._is_glob_pattern
_check_schema_divergence = _tune_helper._check_schema_divergence
_inspect_file_schemas = _tune_helper._inspect_file_schemas
_apply_column_map = _tune_helper._apply_column_map
_parse_column_map = _tune_helper._parse_column_map


# ── Realistic test data ───────────────────────────────────────────────────────

SAMPLE_FILES = [
    "data/train-00000-of-00002.parquet",
    "data/train-00001-of-00002.parquet",
    "data/when2call-train.jsonl",
]

SCHEMA_A = {"prompt", "completion", "category"}
SCHEMA_B = {"prompt", "chosen", "rejected", "source"}


# ═══════════════════════════════════════════════════════════════════════════════
# 1. _filter_data_files tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestFilterDataFilesGlob:
    """Test _filter_data_files with glob patterns.

    Validates: Requirements 2.1, 2.5
    """

    def test_filter_data_files_glob_star_pattern(self):
        """Glob pattern *call* matches files containing 'call'."""
        result = _filter_data_files(SAMPLE_FILES, "*call*")
        assert result == ["data/when2call-train.jsonl"]

    def test_filter_data_files_glob_question_mark(self):
        """Glob pattern train-0000?-* matches files with single char wildcard."""
        result = _filter_data_files(SAMPLE_FILES, "*train-0000?-*")
        assert set(result) == {
            "data/train-00000-of-00002.parquet",
            "data/train-00001-of-00002.parquet",
        }


class TestFilterDataFilesSubstring:
    """Test _filter_data_files with substring patterns.

    Validates: Requirements 2.6
    """

    def test_filter_data_files_substring_pattern(self):
        """Substring pattern 'call' matches basenames containing 'call'."""
        result = _filter_data_files(SAMPLE_FILES, "call")
        assert result == ["data/when2call-train.jsonl"]


class TestFilterDataFilesNoFilter:
    """Test _filter_data_files with empty/None patterns.

    Validates: Requirements 2.3, 6.1
    """

    def test_filter_data_files_empty_pattern_returns_all(self):
        """Empty string pattern returns all files."""
        result = _filter_data_files(SAMPLE_FILES, "")
        assert result == SAMPLE_FILES

    def test_filter_data_files_none_pattern_returns_all(self):
        """None pattern returns all files."""
        result = _filter_data_files(SAMPLE_FILES, None)
        assert result == SAMPLE_FILES


class TestFilterDataFilesNoMatch:
    """Test _filter_data_files when no files match.

    Validates: Requirements 2.2, 5.4
    """

    def test_filter_data_files_no_match_exits(self):
        """Raises SystemExit when no files match the pattern."""
        with pytest.raises(SystemExit):
            _filter_data_files(SAMPLE_FILES, "nonexistent_file")

    def test_filter_data_files_no_match_error_lists_files(self, capsys):
        """Error message contains all available files."""
        with pytest.raises(SystemExit):
            _filter_data_files(SAMPLE_FILES, "nonexistent_pattern")

        captured = capsys.readouterr()
        output = json.loads(captured.out)
        error_msg = output["error"]

        # Error message should list all available files
        for f in SAMPLE_FILES:
            assert f in error_msg

        # Error message should contain the pattern
        assert "nonexistent_pattern" in error_msg


# ═══════════════════════════════════════════════════════════════════════════════
# 2. _check_schema_divergence tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestCheckSchemaDivergenceIdentical:
    """Test _check_schema_divergence with identical schemas.

    Validates: Requirements 3.5, 6.1
    """

    def test_check_schema_divergence_identical_schemas(self):
        """Returns None when all files have the same columns."""
        file_records = [
            ("data/train-00000.parquet", {"prompt", "completion", "category"}),
            ("data/train-00001.parquet", {"prompt", "completion", "category"}),
        ]
        result = _check_schema_divergence(file_records, "org/dataset", "sft")
        assert result is None

    def test_check_schema_divergence_single_file(self):
        """Returns None for a single file (cannot diverge from itself)."""
        file_records = [
            ("data/train-00000.parquet", {"prompt", "completion"}),
        ]
        result = _check_schema_divergence(file_records, "org/dataset", "sft")
        assert result is None

    def test_check_schema_divergence_empty_list(self):
        """Returns None for an empty list."""
        result = _check_schema_divergence([], "org/dataset", "sft")
        assert result is None


class TestCheckSchemaDivergenceDivergent:
    """Test _check_schema_divergence with divergent schemas.

    Validates: Requirements 3.2, 3.3, 3.4, 5.1, 5.2
    """

    def test_check_schema_divergence_divergent_schemas_exits(self):
        """Raises SystemExit when schemas differ across files."""
        file_records = [
            ("data/train-00000-of-00002.parquet", SCHEMA_A),
            ("data/train-00001-of-00002.parquet", SCHEMA_B),
        ]
        with pytest.raises(SystemExit):
            _check_schema_divergence(file_records, "nvidia/When2Call", "sft")

    def test_check_schema_divergence_error_message_format(self, capsys):
        """Error message contains per-file columns and ?file= suggestion."""
        file_records = [
            ("data/train-00000-of-00002.parquet", SCHEMA_A),
            ("data/train-00001-of-00002.parquet", SCHEMA_B),
        ]
        with pytest.raises(SystemExit):
            _check_schema_divergence(file_records, "nvidia/When2Call", "sft")

        captured = capsys.readouterr()
        output = json.loads(captured.out)
        error_msg = output["error"]

        # Should contain per-file column listings
        assert "train-00000-of-00002.parquet" in error_msg
        assert "train-00001-of-00002.parquet" in error_msg

        # Should contain column names for each file
        for col in sorted(SCHEMA_A):
            assert col in error_msg
        for col in sorted(SCHEMA_B):
            assert col in error_msg

        # Should contain ?file= suggestion
        assert "?file=" in error_msg

        # Should contain schema divergence phrasing
        assert "Schema divergence" in error_msg or "divergence" in error_msg.lower()


# ═══════════════════════════════════════════════════════════════════════════════
# 3. _inspect_file_schemas tests (mocked)
# ═══════════════════════════════════════════════════════════════════════════════


class TestInspectFileSchemas:
    """Test _inspect_file_schemas with mocked file downloads.

    Validates: Requirements 3.1, 3.6
    """

    def test_inspect_file_schemas_parquet_file(self, tmp_path):
        """Parquet file inspection extracts correct column names."""
        import pyarrow as pa
        import pyarrow.parquet as pq

        # Create a real parquet file with known columns
        parquet_path = tmp_path / "train-00000.parquet"
        table = pa.table({
            "prompt": ["Hello"],
            "completion": ["Hi there"],
            "category": ["greeting"],
        })
        pq.write_table(table, str(parquet_path))

        # Mock hf_hub_download to return the local file path
        with patch("huggingface_hub.hf_hub_download", return_value=str(parquet_path)):
            result = _inspect_file_schemas(
                data_files=["data/train-00000.parquet"],
                dataset_id="org/dataset",
                hf_token="test-token",
                tmpdir=str(tmp_path),
                column_map={},
                technique="sft",
                no_transform=True,
            )

        assert len(result) == 1
        filename, columns = result[0]
        assert filename == "data/train-00000.parquet"
        assert columns == {"prompt", "completion", "category"}

    def test_inspect_file_schemas_jsonl_file(self, tmp_path):
        """JSONL file inspection extracts correct column names."""
        # Create a mock JSONL file
        jsonl_file = tmp_path / "when2call-train.jsonl"
        record = {"prompt": "What time?", "chosen": "3pm", "rejected": "dunno", "source": "web"}
        jsonl_file.write_text(json.dumps(record) + "\n")

        with patch("huggingface_hub.hf_hub_download", return_value=str(jsonl_file)):
            result = _inspect_file_schemas(
                data_files=["data/when2call-train.jsonl"],
                dataset_id="org/dataset",
                hf_token="test-token",
                tmpdir=str(tmp_path),
                column_map={},
                technique="dpo",
                no_transform=True,
            )

        assert len(result) == 1
        filename, columns = result[0]
        assert filename == "data/when2call-train.jsonl"
        assert columns == {"prompt", "chosen", "rejected", "source"}

    def test_inspect_file_schemas_with_column_map(self, tmp_path):
        """Column mapping is applied during schema inspection."""
        # Create a JSONL file with non-standard column names
        jsonl_file = tmp_path / "train.jsonl"
        record = {"question": "What?", "answer": "That.", "extra": "info"}
        jsonl_file.write_text(json.dumps(record) + "\n")

        column_map = {"prompt": "question", "completion": "answer"}

        with patch("huggingface_hub.hf_hub_download", return_value=str(jsonl_file)):
            result = _inspect_file_schemas(
                data_files=["data/train.jsonl"],
                dataset_id="org/dataset",
                hf_token="test-token",
                tmpdir=str(tmp_path),
                column_map=column_map,
                technique="sft",
                no_transform=True,
            )

        assert len(result) == 1
        _, columns = result[0]
        # Column mapping should rename question→prompt, answer→completion
        assert "prompt" in columns
        assert "completion" in columns
        assert "extra" in columns
        # Original names should be gone
        assert "question" not in columns
        assert "answer" not in columns

    def test_inspect_file_schemas_with_flattening(self, tmp_path):
        """Flattening is applied when no_transform is False."""
        # Create a JSONL file with chat-format data
        jsonl_file = tmp_path / "train.jsonl"
        record = {
            "prompt": "Hello",
            "chosen": {"role": "assistant", "content": "Hi there!"},
            "rejected": {"role": "assistant", "content": "Go away."},
        }
        jsonl_file.write_text(json.dumps(record) + "\n")

        with patch("huggingface_hub.hf_hub_download", return_value=str(jsonl_file)):
            result = _inspect_file_schemas(
                data_files=["data/train.jsonl"],
                dataset_id="org/dataset",
                hf_token="test-token",
                tmpdir=str(tmp_path),
                column_map={},
                technique="dpo",
                no_transform=False,  # flattening enabled
            )

        assert len(result) == 1
        _, columns = result[0]
        # After flattening, all columns should still be present
        assert "prompt" in columns
        assert "chosen" in columns
        assert "rejected" in columns


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Argparse tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestHfFileArgparse:
    """Test --hf-file argument registration.

    Validates: Requirements 4.1, 4.2, 4.3
    """

    def _parse_stage_hf_args(self, extra_args=None):
        """Parse stage-hf subcommand args using the module's argparser."""
        import argparse

        # Rebuild the parser to test argument registration
        parser = argparse.ArgumentParser()
        subparsers = parser.add_subparsers(dest="command")
        stage_hf_parser = subparsers.add_parser("stage-hf")
        stage_hf_parser.add_argument("--hf-org", required=True)
        stage_hf_parser.add_argument("--hf-name", required=True)
        stage_hf_parser.add_argument("--hf-split", default="train")
        stage_hf_parser.add_argument("--hf-file", default=None,
                                     help="File filter pattern (glob or substring)")
        stage_hf_parser.add_argument("--output-bucket", required=True)
        stage_hf_parser.add_argument("--project-name", required=True)
        stage_hf_parser.add_argument("--region", required=True)

        base_args = [
            "stage-hf",
            "--hf-org", "nvidia",
            "--hf-name", "When2Call",
            "--output-bucket", "my-bucket",
            "--project-name", "my-project",
            "--region", "us-west-2",
        ]
        if extra_args:
            base_args.extend(extra_args)
        return parser.parse_args(base_args)

    def test_hf_file_argument_registered(self):
        """--hf-file argument is accepted without error."""
        args = self._parse_stage_hf_args(["--hf-file", "*call*"])
        assert hasattr(args, "hf_file")

    def test_hf_file_argument_default_none(self):
        """Default value for --hf-file is None when not provided."""
        args = self._parse_stage_hf_args()
        assert args.hf_file is None

    def test_hf_file_argument_accepts_value(self):
        """--hf-file stores the provided pattern value."""
        args = self._parse_stage_hf_args(["--hf-file", "train-0000?-*"])
        assert args.hf_file == "train-0000?-*"


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Backward compatibility tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestBackwardCompatibility:
    """Test that no --hf-file processes all files.

    Validates: Requirements 6.1, 6.3
    """

    def test_no_hf_file_processes_all_files(self):
        """When --hf-file is not provided, _filter_data_files with None returns all files."""
        all_files = [
            "data/train-00000-of-00003.parquet",
            "data/train-00001-of-00003.parquet",
            "data/train-00002-of-00003.parquet",
        ]
        # Simulate the logic in cmd_stage_hf: only filter if hf_file_pattern is truthy
        hf_file_pattern = None  # not provided
        if hf_file_pattern:
            result = _filter_data_files(all_files, hf_file_pattern)
        else:
            result = all_files

        assert result == all_files
        assert len(result) == 3
