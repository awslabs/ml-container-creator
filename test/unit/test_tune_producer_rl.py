# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL129 managed-RL Producer — unit tests (tasks 6.4, 6.5).

Feature: v2-w3-01-bl129

Exercises templates/do/lib/python/tune_producer_rl.py — the register-side Producer that
turns a source dataset into verl's 5-field PARQUET for rlvr/rlaif. Behavior asserted:
  - flat top-level ground_truth is LIFTED into the nested reward_model struct (6.4)
  - reward_model.style is DERIVED from the descriptor (rlvr→rule, rlaif→model), not
    hardcoded (6.4)
  - the prompt is kept as a message LIST, never flattened (6.5 behavior pin)
  - a well-formed nested reward_model is preserved
  - the post-write parquet re-read conforms
  - a row that cannot satisfy the contract fails loud

Offline: reads the committed tune.d descriptors; writes parquet to a tmp path.
"""

import importlib.util
import os

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_LIB = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")


def _load(name):
    path = os.path.join(_LIB, f"{name}.py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # The producer imports `tune_manifest` and `common` from its own dir.
    import sys
    if _LIB not in sys.path:
        sys.path.insert(0, _LIB)
    spec.loader.exec_module(module)
    return module


producer = _load("tune_producer_rl")

# The pure-transform tests (to_verl_row / assert_verl_row) need no pyarrow and always
# run. The tests that actually WRITE/READ parquet are skipped when pyarrow is absent —
# in a generated project `do/register`'s venv carries it, but a bare CI interpreter may
# not. (Mirrors test_tune_gate_field_schema.py's importorskip.)
try:
    import pyarrow  # noqa: F401
    _HAS_PYARROW = True
except ImportError:
    _HAS_PYARROW = False

_needs_pyarrow = pytest.mark.skipif(
    not _HAS_PYARROW,
    reason="pyarrow not installed; parquet production is covered where pyarrow is available",
)


# -- is_managed_rl_verl --------------------------------------------------------

def test_rlvr_and_rlaif_are_managed_rl_verl():
    assert producer.is_managed_rl_verl("rlvr") is True
    assert producer.is_managed_rl_verl("rlaif") is True


def test_sft_dpo_mtrl_are_not_verl():
    # sft/dpo are jsonl; mtrl is mtrl-rollout — none take the verl producer path.
    assert producer.is_managed_rl_verl("sft") is False
    assert producer.is_managed_rl_verl("dpo") is False
    assert producer.is_managed_rl_verl("mtrl") is False


# -- to_verl_row: the core transform -------------------------------------------

def test_flat_ground_truth_is_lifted_into_nested_reward_model():
    # A GSM8k-style flat row: prompt + a top-level ground_truth, no nested struct.
    row = producer.to_verl_row(
        {"prompt": "What is 2+2?", "ground_truth": "4"},
        technique="rlvr", style="rule",
    )
    assert row["reward_model"] == {"style": "rule", "ground_truth": "4"}


def test_rlvr_style_is_rule_rlaif_style_is_model_from_descriptor():
    # The style passed to to_verl_row comes from the descriptor; assert the producer
    # reads the right value end-to-end via produce_verl_parquet (below). Here assert
    # the descriptor-derived style is wired by reading it the same way the producer does.
    import tune_manifest
    assert tune_manifest.reward_model_style("rlvr") == "rule"
    assert tune_manifest.reward_model_style("rlaif") == "model"


def test_prompt_is_kept_as_message_list_not_flattened():
    # 6.5 behavior pin: a message-list prompt stays a list (verl wants the list).
    msgs = [{"role": "user", "content": "hi"}]
    row = producer.to_verl_row(
        {"prompt": msgs, "ground_truth": "x"}, technique="rlvr", style="rule",
    )
    assert row["prompt"] == msgs
    assert isinstance(row["prompt"], list)


def test_plain_string_prompt_is_wrapped_into_a_single_user_turn():
    row = producer.to_verl_row(
        {"prompt": "solve it", "ground_truth": "x"}, technique="rlvr", style="rule",
    )
    assert row["prompt"] == [{"role": "user", "content": "solve it"}]


def test_messages_column_is_recognized_as_the_prompt():
    # Regression: the common RLVR/RLAIF source shape (e.g. allenai/RLVR-MATH) puts the
    # problem in a `messages` chat list, which was NOT a prompt alias — so every row
    # got a BLANK prompt (training on empty problems). `messages` must be recognized,
    # and a message-list passes through unflattened.
    msgs = [{"role": "user", "content": "What is the domain of sqrt(x-2)?"}]
    row = producer.to_verl_row(
        {"messages": msgs, "ground_truth": "8"}, technique="rlvr", style="rule",
    )
    assert row["prompt"] == msgs
    assert row["prompt"][0]["content"].strip()           # NON-empty
    assert row["reward_model"]["ground_truth"] == "8"


def test_conversations_column_is_recognized_as_the_prompt():
    msgs = [{"role": "user", "content": "solve"}]
    row = producer.to_verl_row(
        {"conversations": msgs, "ground_truth": "x"}, technique="rlvr", style="rule",
    )
    assert row["prompt"] == msgs


def test_missing_prompt_still_falls_back_to_empty_user_turn():
    # Behavior pin: a source with NO recognizable prompt column still yields the
    # documented single empty user turn from to_verl_row (so the row is structurally
    # valid) — we did not change that fallback, only widened the aliases that avoid
    # reaching it. The EMPTY-content guard lives in assert_verl_row (tested below), so
    # the blank row is caught at the conformance gate, not silently shipped.
    row = producer.to_verl_row(
        {"ground_truth": "x"}, technique="rlvr", style="rule",
    )
    assert row["prompt"] == [{"role": "user", "content": ""}]


def test_assert_rejects_empty_prompt_content(monkeypatch):
    # The robustness fix: a structurally-valid prompt whose content is ALL EMPTY must
    # fail the conformance gate (it means training on blank problems). This is what
    # makes the prompt-alias list a convenience, not a correctness dependency — any
    # dataset whose prompt column we don't recognize fails LOUD at stage time with a
    # --column-map remedy, instead of silently producing blank prompts.
    import common
    calls = {}

    def _fake_error_exit(msg, **kw):
        calls["msg"] = msg
        raise SystemExit(1)

    monkeypatch.setattr(common, "_error_exit", _fake_error_exit, raising=False)
    monkeypatch.setattr(producer, "_error_exit", _fake_error_exit, raising=False)

    blank = {
        "data_source": "d",
        "prompt": [{"role": "user", "content": "   "}],  # whitespace-only = empty
        "ability": "general",
        "reward_model": {"style": "rule", "ground_truth": "8"},
        "extra_info": {"index": 0},
    }
    with pytest.raises(SystemExit):
        producer.assert_verl_row(blank, style="rule")
    assert "no message content" in calls["msg"].lower()
    assert "--column-map" in calls["msg"]


def test_assert_accepts_real_prompt_content(monkeypatch):
    import common

    def _boom(msg, **kw):
        raise AssertionError(f"should not have failed: {msg}")

    monkeypatch.setattr(common, "_error_exit", _boom, raising=False)
    monkeypatch.setattr(producer, "_error_exit", _boom, raising=False)
    ok = {
        "data_source": "d",
        "prompt": [{"role": "user", "content": "What is 2+2?"}],
        "ability": "general",
        "reward_model": {"style": "rule", "ground_truth": "4"},
        "extra_info": {"index": 0},
    }
    producer.assert_verl_row(ok, style="rule")  # must not raise


def test_wellformed_nested_reward_model_is_preserved():
    row = producer.to_verl_row(
        {"prompt": "q", "reward_model": {"style": "model", "ground_truth": {"k": 1}}},
        technique="rlaif", style="model",
    )
    assert row["reward_model"] == {"style": "model", "ground_truth": {"k": 1}}


def test_column_map_renames_before_alias_detection():
    row = producer.to_verl_row(
        {"q": "prompt text", "sol": "42"},
        technique="rlvr", style="rule",
        column_map={"prompt": "q", "ground_truth": "sol"},
    )
    assert row["prompt"] == [{"role": "user", "content": "prompt text"}]
    assert row["reward_model"]["ground_truth"] == "42"


# -- assert_verl_row: fail-loud contract -----------------------------------------

def test_assert_rejects_non_list_prompt():
    bad = {"data_source": "d", "prompt": "flat", "ability": "a",
           "reward_model": {"style": "rule", "ground_truth": "x"}, "extra_info": {}}
    with pytest.raises(SystemExit):
        producer.assert_verl_row(bad, style="rule")


def test_assert_rejects_missing_reward_model_struct():
    bad = {"data_source": "d", "prompt": [{"role": "user", "content": "q"}],
           "ability": "a", "reward_model": "oops", "extra_info": {}}
    with pytest.raises(SystemExit):
        producer.assert_verl_row(bad, style="rule")


# -- produce_verl_parquet + post-write assert (6.4 end-to-end) -------------------

@_needs_pyarrow
def test_produce_parquet_end_to_end_and_post_write_conforms(tmp_path):
    out = str(tmp_path / "train.verl.parquet")
    records = [
        {"prompt": "2+2?", "ground_truth": "4"},
        {"prompt": [{"role": "user", "content": "3+3?"}], "ground_truth": "6"},
    ]
    n = producer.produce_verl_parquet(records, technique="rlvr", out_path=out)
    assert n == 2
    # Post-write re-read conforms.
    producer.assert_parquet_conforms(out, technique="rlvr")

    import pyarrow.parquet as pq
    table = pq.read_table(out)
    assert sorted(table.column_names) == sorted(producer.VERL_FIELDS)
    rows = table.to_pylist()
    # rlvr → style rule, derived from the descriptor (not passed in by the test).
    assert all(r["reward_model"]["style"] == "rule" for r in rows)
    # prompts are message LISTS.
    assert all(isinstance(r["prompt"], list) and r["prompt"] for r in rows)


@_needs_pyarrow
def test_produce_parquet_respects_take(tmp_path):
    out = str(tmp_path / "train.verl.parquet")
    records = [{"prompt": f"q{i}", "ground_truth": str(i)} for i in range(10)]
    n = producer.produce_verl_parquet(records, technique="rlaif", out_path=out, take=3)
    assert n == 3


@_needs_pyarrow
def test_rlaif_parquet_uses_model_style_from_descriptor(tmp_path):
    out = str(tmp_path / "train.verl.parquet")
    producer.produce_verl_parquet(
        [{"prompt": "summarize", "ground_truth": "ref"}],
        technique="rlaif", out_path=out,
    )
    import pyarrow.parquet as pq
    row = pq.read_table(out).to_pylist()[0]
    assert row["reward_model"]["style"] == "model"
