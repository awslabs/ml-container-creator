# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the relocated dataset QoL helpers (BL092, Property 6).

Validates that column-map suggestion/apply, required-column validation,
multi-file (?file=) selection, and HF split resolution behave identically after
relocation into ``dataset_qol.py`` — and that ``tune_stage_hf`` re-exports them
(the tune staging path must remain behavior-identical).
"""

from __future__ import annotations

import os
import sys

import pytest

_LIB = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python")
)
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import dataset_qol  # noqa: E402
import tune_stage_hf  # noqa: E402


# ── Shim identity: tune_stage_hf re-exports dataset_qol helpers ───────────────


SHARED_NAMES = [
    "_get_required_columns", "_get_schema_types", "_suggest_column_map",
    "_parse_column_map", "_apply_column_map", "_detect_chat_columns",
    "_flatten_value", "_flatten_record", "_log_flatten_info",
    "_validate_dataset_columns", "_check_empty_fields", "_find_data_files",
    "_is_glob_pattern", "_filter_data_files", "_inspect_file_schemas",
    "_check_schema_divergence",
]


@pytest.mark.parametrize("name", SHARED_NAMES)
def test_tune_stage_hf_reexports_dataset_qol(name):
    assert getattr(tune_stage_hf, name) is getattr(dataset_qol, name), (
        f"{name} must be the same object in both modules (behavior-identical shim)"
    )


# ── Column-map suggestion/apply ───────────────────────────────────────────────


class TestColumnMap:
    def test_suggest_maps_common_aliases(self):
        s = dataset_qol._suggest_column_map(
            ["question", "answer"], ["prompt", "completion"]
        )
        assert "prompt=question" in s
        assert "completion=answer" in s

    def test_suggest_returns_none_when_present(self):
        assert dataset_qol._suggest_column_map(["prompt", "completion"],
                                               ["prompt", "completion"]) is None

    def test_parse_column_map(self):
        assert dataset_qol._parse_column_map("prompt=question,completion=answer") == {
            "prompt": "question", "completion": "answer",
        }

    def test_parse_empty(self):
        assert dataset_qol._parse_column_map("") == {}
        assert dataset_qol._parse_column_map(None) == {}

    def test_apply_column_map_renames(self):
        rec = {"question": "q", "answer": "a"}
        out = dataset_qol._apply_column_map(rec, {"prompt": "question", "completion": "answer"})
        assert out == {"prompt": "q", "completion": "a"}

    def test_apply_column_map_noop_without_map(self):
        rec = {"prompt": "q"}
        assert dataset_qol._apply_column_map(rec, {}) == rec


# ── Multi-file selection / glob (?file=) ──────────────────────────────────────


class TestFileSelection:
    def test_find_data_files_prefers_exact_split(self):
        files = ["data/train.jsonl", "data/test.jsonl"]
        assert dataset_qol._find_data_files(files, "train") == ["data/train.jsonl"]

    def test_find_data_files_sharded(self):
        # The sharded pattern keys on the 00000 shard marker; the jsonl+split
        # fallback then collects all matching shards.
        files = ["data/train-00000-of-00002.jsonl", "data/train-00001-of-00002.jsonl"]
        got = dataset_qol._find_data_files(files, "train")
        assert "data/train-00000-of-00002.jsonl" in got
        assert got == sorted(got)

    def test_is_glob_pattern(self):
        assert dataset_qol._is_glob_pattern("*1M*")
        assert not dataset_qol._is_glob_pattern("plain")

    def test_filter_data_files_glob(self):
        files = ["a/1M-part.jsonl", "a/500k-part.jsonl"]
        assert dataset_qol._filter_data_files(files, "*1M*") == ["a/1M-part.jsonl"]

    def test_filter_data_files_substring(self):
        files = ["a/train.jsonl", "a/valid.jsonl"]
        assert dataset_qol._filter_data_files(files, "train") == ["a/train.jsonl"]

    def test_filter_no_match_errors(self):
        with pytest.raises(SystemExit):
            dataset_qol._filter_data_files(["a/train.jsonl"], "nope")


# ── Required columns / schema-divergence ──────────────────────────────────────


class TestSchema:
    def test_required_columns(self):
        assert dataset_qol._get_required_columns("sft") == ["prompt", "completion"]
        assert dataset_qol._get_required_columns("dpo") == ["prompt", "chosen", "rejected"]

    def test_validate_columns_ok(self):
        rec = {"prompt": "p", "completion": "c"}
        mapped, cmap = dataset_qol._validate_dataset_columns(rec, "sft", None, "org/name")
        assert mapped == rec

    def test_validate_columns_missing_errors(self):
        with pytest.raises(SystemExit):
            dataset_qol._validate_dataset_columns({"foo": "bar"}, "sft", None, "org/name")

    def test_schema_divergence_none_when_identical(self):
        recs = [("a.jsonl", {"prompt", "completion"}), ("b.jsonl", {"prompt", "completion"})]
        assert dataset_qol._check_schema_divergence(recs, "org/name", "sft") is None

    def test_schema_divergence_errors_when_different(self):
        recs = [("a.jsonl", {"prompt", "completion"}), ("b.jsonl", {"prompt"})]
        with pytest.raises(SystemExit):
            dataset_qol._check_schema_divergence(recs, "org/name", "sft")


# ── take / row handling helper ────────────────────────────────────────────────


class TestTakeAndEmpty:
    def test_check_empty_fields(self):
        assert dataset_qol._check_empty_fields({"prompt": "", "completion": "c"},
                                               ["prompt", "completion"]) == ["prompt"]
        assert dataset_qol._check_empty_fields({"prompt": "p", "completion": "c"},
                                               ["prompt", "completion"]) == []
