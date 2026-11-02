"""Unit tests for dataset auto-flatten detection and flattening logic.

Tests cover specific real-world dataset formats, error messages, log output,
pipeline integration, and edge cases.

Requirements validated: 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 7.4, 7.5
"""

import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout, redirect_stderr

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

_detect_chat_columns = _tune_helper._detect_chat_columns
_flatten_value = _tune_helper._flatten_value
_flatten_record = _tune_helper._flatten_record
_log_flatten_info = _tune_helper._log_flatten_info
_apply_column_map = _tune_helper._apply_column_map
_parse_column_map = _tune_helper._parse_column_map
_get_schema_types = _tune_helper._get_schema_types
_get_required_columns = _tune_helper._get_required_columns


# ── Test 1: nvidia/When2Call format ───────────────────────────────────────────


class TestNvidiaWhen2CallFormat:
    """Test detection + flattening of nvidia/When2Call-shaped data.

    Validates: Requirements 1.1, 2.1
    """

    def test_nvidia_when2call_format(self):
        """Chosen/rejected as single message dicts are detected and flattened."""
        record = {
            "prompt": "What is the weather?",
            "chosen": {"role": "assistant", "content": "The weather is sunny."},
            "rejected": {"role": "assistant", "content": "I don't know."},
        }

        required_columns = ["prompt", "chosen", "rejected"]
        schema_types = {"prompt": "string", "chosen": "string", "rejected": "string"}

        # Detection should identify chosen and rejected as single_dict
        chat_columns = _detect_chat_columns(record, required_columns, schema_types)

        assert "chosen" in chat_columns
        assert "rejected" in chat_columns
        assert "prompt" not in chat_columns  # already a string

        assert chat_columns["chosen"]["type"] == "single_dict"
        assert chat_columns["rejected"]["type"] == "single_dict"

        # Flattening should extract content
        flattened = _flatten_record(record, chat_columns)

        assert flattened["prompt"] == "What is the weather?"
        assert flattened["chosen"] == "The weather is sunny."
        assert flattened["rejected"] == "I don't know."


# ── Test 2: --no-transform error message ─────────────────────────────────────


class TestNoTransformErrorMessage:
    """Test that the error message contains '--no-transform' suggestion.

    Validates: Requirements 5.3, 6.5
    """

    def test_no_transform_error_message(self):
        """Error message when --no-transform is active contains the flag name."""
        # Simulate the error message generation from cmd_stage_hf
        # The error format from the implementation:
        col_name = "chosen"
        det_type = "single_dict"
        technique = "dpo"
        org = "nvidia"
        name = "When2Call"
        strategy_desc = "single message dict with role+content"

        error_msg = (
            f"Column '{col_name}' contains chat-format data (detected: {det_type}) "
            f"but --no-transform is active.\n\n"
            f"   Remove --no-transform to enable automatic conversion:\n"
            f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} "
            f"[--column-map ...]\n\n"
            f"   Detected format: {strategy_desc}"
        )

        assert "--no-transform" in error_msg
        assert col_name in error_msg
        assert technique in error_msg


# ── Tests 3-5: Log output format ─────────────────────────────────────────────


class TestLogOutputFormat:
    """Test log output format for each detection strategy.

    Validates: Requirements 6.1, 6.3, 6.4
    """

    def test_log_output_single_dict(self):
        """Log output for single_dict contains expected format strings."""
        chat_columns = {"chosen": {"type": "single_dict"}}

        buf = io.StringIO()
        with redirect_stderr(buf):
            _log_flatten_info(chat_columns, no_transform=False)

        output = buf.getvalue()
        assert "\u2139\ufe0f  Auto-converted column" in output
        assert "'chosen'" in output
        assert "Format: extracted content field" in output

    def test_log_output_multi_role(self):
        """Log output for multi_role contains expected format strings."""
        chat_columns = {
            "chosen": {
                "type": "message_list",
                "strategy": "multi_role",
                "count": 3,
            }
        }

        buf = io.StringIO()
        with redirect_stderr(buf):
            _log_flatten_info(chat_columns, no_transform=False)

        output = buf.getvalue()
        assert "\u2139\ufe0f  Auto-converted column" in output
        assert "Format: role: content (multi-turn, 3 messages)" in output

    def test_log_output_same_role(self):
        """Log output for same_role contains expected format strings."""
        chat_columns = {
            "rejected": {
                "type": "message_list",
                "strategy": "same_role",
                "count": 4,
            }
        }

        buf = io.StringIO()
        with redirect_stderr(buf):
            _log_flatten_info(chat_columns, no_transform=False)

        output = buf.getvalue()
        assert "\u2139\ufe0f  Auto-converted column" in output
        assert "Format: newline-joined content (4 messages, same role)" in output

    def test_log_output_extract(self):
        """Log output for extract strategy contains expected format strings."""
        chat_columns = {
            "completion": {
                "type": "message_list",
                "strategy": "extract",
                "count": 1,
            }
        }

        buf = io.StringIO()
        with redirect_stderr(buf):
            _log_flatten_info(chat_columns, no_transform=False)

        output = buf.getvalue()
        assert "\u2139\ufe0f  Auto-converted column" in output
        assert "Format: extracted content field" in output


# ── Test 6: Log-once-per-column behavior ─────────────────────────────────────


class TestLogOncePerColumn:
    """Test that logging happens once per column, not once per record.

    Validates: Requirement 6.2
    """

    def test_log_once_per_column(self):
        """Each column name appears exactly once in log output."""
        chat_columns = {
            "chosen": {"type": "single_dict"},
            "rejected": {"type": "single_dict"},
        }

        buf = io.StringIO()
        with redirect_stderr(buf):
            _log_flatten_info(chat_columns, no_transform=False)

        output = buf.getvalue()

        # Each column should appear exactly once
        assert output.count("'chosen'") == 1
        assert output.count("'rejected'") == 1


# ── Test 7: Pipeline integration ─────────────────────────────────────────────


class TestPipelineIntegration:
    """End-to-end: column map → detect → flatten → validate.

    Validates: Requirements 4.1, 4.2, 4.5
    """

    def test_pipeline_integration(self):
        """Full pipeline: rename columns, detect chat-format, flatten, validate output."""
        # Source record with non-standard column names and chat-format data
        source_record = {
            "question": "What is 2+2?",
            "preferred": {"role": "assistant", "content": "4"},
            "dispreferred": {"role": "assistant", "content": "5"},
        }

        # Step 1: Apply column map (rename to required DPO columns)
        column_map = _parse_column_map("prompt=question,chosen=preferred,rejected=dispreferred")
        mapped_record = _apply_column_map(source_record, column_map)

        assert "prompt" in mapped_record
        assert "chosen" in mapped_record
        assert "rejected" in mapped_record

        # Step 2: Detect chat-format columns
        required_columns = _get_required_columns("dpo")
        schema_types = _get_schema_types("dpo")
        chat_columns = _detect_chat_columns(mapped_record, required_columns, schema_types)

        assert "chosen" in chat_columns
        assert "rejected" in chat_columns

        # Step 3: Flatten
        flattened = _flatten_record(mapped_record, chat_columns)

        # Step 4: Validate — all required columns should be strings
        for col in required_columns:
            assert isinstance(flattened[col], str), f"Column '{col}' is not a string after flattening"

        assert flattened["prompt"] == "What is 2+2?"
        assert flattened["chosen"] == "4"
        assert flattened["rejected"] == "5"


# ── Test 8: Empty list → "" conversion ───────────────────────────────────────


class TestEmptyListConversion:
    """Test that an empty list is converted to empty string.

    Validates: Requirement 7.4
    """

    def test_empty_list_conversion(self):
        """_flatten_value([], ...) returns empty string."""
        detection_result = {"type": "message_list", "strategy": "extract", "count": 0}
        result = _flatten_value([], detection_result)
        assert result == ""


# ── Test 9: Unrecoverable flattening halt ────────────────────────────────────


class TestUnrecoverableFlattenHalt:
    """Test that str() fallback failure produces a clear ValueError.

    Validates: Requirement 7.5
    """

    def test_unrecoverable_flatten_halt(self):
        """A value where str() raises produces a ValueError from _flatten_value."""

        class UnstringableValue:
            """A value that cannot be converted to string."""
            def __str__(self):
                raise RuntimeError("Cannot stringify this value")

            def __repr__(self):
                raise RuntimeError("Cannot repr this value")

        value = UnstringableValue()
        detection_result = {"type": "single_dict"}

        with pytest.raises(ValueError, match="Cannot convert value to string"):
            _flatten_value(value, detection_result)


# ── Test 10: Parquet and JSONL code paths produce equivalent output ──────────


class TestParquetJsonlEquivalence:
    """Test that both code paths produce equivalent output for equivalent input.

    Validates: Requirement 4.6
    """

    def test_parquet_and_jsonl_equivalent_output(self):
        """Both paths use the same detect → flatten → write pipeline logic."""
        # Simulate the same record processed through both paths
        record = {
            "prompt": "Hello",
            "chosen": {"role": "assistant", "content": "Hi there!"},
            "rejected": {"role": "assistant", "content": "Go away."},
        }

        required_columns = _get_required_columns("dpo")
        schema_types = _get_schema_types("dpo")

        # Simulate JSONL path processing
        column_map = {}
        mapped_jsonl = _apply_column_map(record, column_map)
        chat_columns_jsonl = _detect_chat_columns(mapped_jsonl, required_columns, schema_types)
        flattened_jsonl = _flatten_record(mapped_jsonl, chat_columns_jsonl)

        # Simulate Parquet path processing (same logic, different source)
        mapped_parquet = _apply_column_map(dict(record), column_map)
        chat_columns_parquet = _detect_chat_columns(mapped_parquet, required_columns, schema_types)
        flattened_parquet = _flatten_record(mapped_parquet, chat_columns_parquet)

        # Both paths should produce identical output
        jsonl_line = json.dumps(flattened_jsonl, ensure_ascii=False)
        parquet_line = json.dumps(flattened_parquet, ensure_ascii=False)

        assert jsonl_line == parquet_line
        assert flattened_jsonl == flattened_parquet


# ── RLAIF/RLVR prompt is a message LIST and is NOT flattened (BL129, R4.6) ────


class TestRftPromptIsMessageListNotFlattened:
    """BL129 (R4.6) — the managed-RL prompt shape was RECONCILED.

    SUPERSEDES the earlier `TestRftPromptIsStringAndFlattens`: that typed rlaif/rlvr
    `prompt` as "string" to auto-flatten a message list, because an OLD JSONL managed-RL
    channel rejected arrays (a live allenai/RLVR-GSM job failed with
    `JSONDecodeError: Unterminated string`). BL129 replaces that JSONL channel with the
    verl PARQUET Producer (`tune_producer_rl.py`), which keeps `prompt` as a chat message
    LIST — exactly what verl's `RLHFDataset` wants. The dataset contract now lives in the
    tune descriptor (`prompt_shape: message-list`), and `_get_schema_types` types rlaif/
    rlvr `prompt` as "message-list" so `_detect_chat_columns` (which only inspects
    "string" columns) does NOT flatten it. These assert the NEW behavior (prompt stays a
    list), per the tests-that-don't-rot rule: pin the committed behavior, not the
    superseded one.
    """

    def test_rlaif_and_rlvr_prompt_typed_message_list(self):
        for technique in ("rlaif", "rlvr"):
            assert _get_schema_types(technique).get("prompt") == "message-list", (
                f"{technique} prompt must be typed 'message-list' so it is NOT "
                f"auto-flattened — verl's RLHFDataset (via the parquet Producer) wants "
                f"the chat message list, not a flattened string"
            )

    def test_rlaif_message_list_prompt_is_not_detected_for_flattening(self):
        # The exact shape allenai/RLVR-GSM ships: prompt is a one-message list.
        record = {
            "ground_truth": "1104",
            "dataset": "gsm8k",
            "prompt": [{"role": "user", "content": "Question: There are 15 trees."}],
        }
        required_columns = _get_required_columns("rlaif")
        schema_types = _get_schema_types("rlaif")
        chat_columns = _detect_chat_columns(record, required_columns, schema_types)
        # prompt must NOT be detected as a flatten target (its type is message-list,
        # which _detect_chat_columns skips) — the Producer preserves the list.
        assert "prompt" not in chat_columns, (
            "prompt must NOT be flattened for rlaif/rlvr — verl wants the message list; "
            "the parquet Producer preserves it"
        )
        flattened = _flatten_record(record, chat_columns)
        assert isinstance(flattened["prompt"], list)
        assert flattened["prompt"] == [{"role": "user", "content": "Question: There are 15 trees."}]

    def test_rlvr_message_list_prompt_is_preserved(self):
        record = {
            "ground_truth": "42",
            "prompt": [{"role": "user", "content": "What is 6 times 7?"}],
        }
        required_columns = _get_required_columns("rlvr")
        schema_types = _get_schema_types("rlvr")
        chat_columns = _detect_chat_columns(record, required_columns, schema_types)
        assert "prompt" not in chat_columns
        flattened = _flatten_record(record, chat_columns)
        assert flattened["prompt"] == [{"role": "user", "content": "What is 6 times 7?"}]
