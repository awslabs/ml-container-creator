# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL128 config-builder CORE — unit tests (tasks 2.2, and coverage for 1/2/3/4/5/7).

Feature: v2-w3-02-bl128

The CORE (`build_config`) is descriptor-source-AGNOSTIC: every test here drives it with
IN-MEMORY fabricated `hyperparameters` blocks (NOT a real tune.d technique), proving the
core has no tune.d coupling (Requirement 7.4). Covers control/tier derivation (R2.3),
progressive disclosure (R2), validation (R1.3), precedence + non-interactive parity
(R4.1), required-no-default fail-fast (R4.3), and unknown-knob rejection (R3.3).

No pyarrow / questionary needed — the core's prompter is injectable.
"""

import importlib.util
import os
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_LIB = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_LIB, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


builder = _load("tune_config_builder")


# A fabricated descriptor fragment — NOT a real technique (proves agnosticism, R7.4).
HP = {
    "learning_rate": {"type": "number", "required": False, "default": 1e-5,
                      "min": 0, "max": 1, "control": "number_input", "tier": "primary"},
    "global_batch_size": {"type": "integer", "required": False, "default": 256,
                          "enum": [128, 256, 512], "control": "dropdown", "tier": "primary"},
    "warmup_ratio": {"type": "number", "required": False, "default": 0.1,
                     "min": 0, "max": 1, "control": "number_input", "tier": "advanced"},
    "debug_dump_path": {"type": "string", "required": False, "control": "text_input",
                        "tier": "tertiary"},
    # A leaner MTRL-shaped knob: NO control, NO tier, NO default.
    "advantage_method": {"type": "string", "required": True, "enum": ["grpo", "rloo"]},
}


# ── effective control / tier derivation (R2.3) ────────────────────────────────

def test_effective_control_uses_descriptor_when_present():
    assert builder.effective_control(HP["global_batch_size"]) == "dropdown"
    assert builder.effective_control(HP["learning_rate"]) == "number_input"


def test_effective_control_derived_when_absent():
    # enum → dropdown; numeric bounds → number_input; else text_input
    assert builder.effective_control({"type": "string", "enum": ["a", "b"]}) == "dropdown"
    assert builder.effective_control({"type": "number", "min": 0, "max": 1}) == "number_input"
    assert builder.effective_control({"type": "string"}) == "text_input"
    # the MTRL-shaped knob (enum, no control) derives dropdown
    assert builder.effective_control(HP["advantage_method"]) == "dropdown"


def test_effective_tier_defaults_to_primary_when_absent():
    assert builder.effective_tier(HP["warmup_ratio"]) == "advanced"
    assert builder.effective_tier(HP["advantage_method"]) == "primary"  # no tier → primary


# ── non-interactive: defaults applied, validated (R4.2) ───────────────────────

def test_non_interactive_applies_defaults():
    # advantage_method is required with no default → must be supplied; give it.
    out = builder.build_config(HP, {"advantage_method": "grpo"}, interactive=False)
    assert out["errors"] == []
    assert out["resolved"]["learning_rate"] == 1e-5
    assert out["resolved"]["global_batch_size"] == 256
    assert out["resolved"]["warmup_ratio"] == 0.1          # advanced default still applied
    assert "debug_dump_path" not in out["resolved"]        # tertiary, optional, no default → omitted
    assert out["resolved"]["advantage_method"] == "grpo"


def test_required_knob_with_no_value_fails_fast():
    out = builder.build_config(HP, {}, interactive=False)
    assert any("advantage_method" in e and "required" in e for e in out["errors"])


# ── precedence: default < supplied (R4.1) ─────────────────────────────────────

def test_supplied_overrides_default():
    out = builder.build_config(HP, {"global_batch_size": "512", "advantage_method": "rloo"},
                               interactive=False)
    assert out["errors"] == []
    assert out["resolved"]["global_batch_size"] == 512     # supplied wins, coerced to int


# ── Option-A transparency: sources map records each knob's provenance ──────────

def test_sources_map_records_provenance():
    # Non-interactive: supplied knobs → "supplied"; everything else with a default
    # → "default". This is what do/tune renders so a user SEES the advanced/tertiary
    # knobs the UX never prompted (e.g. landing at their SDK default in SageMaker).
    out = builder.build_config(
        HP, {"global_batch_size": "512", "advantage_method": "grpo"}, interactive=False)
    assert out["errors"] == []
    sources = out["sources"]
    # every resolved knob has a source, and no unresolved knob leaks in
    assert set(sources) == set(out["resolved"])
    assert sources["global_batch_size"] == "supplied"   # from --supplied
    assert sources["advantage_method"] == "supplied"    # required, supplied
    assert sources["learning_rate"] == "default"        # primary, not supplied
    assert sources["warmup_ratio"] == "default"         # advanced, not prompted here
    # tertiary with no default is omitted entirely (neither resolved nor sourced)
    assert "debug_dump_path" not in sources


def test_sources_map_marks_prompted_values():
    # Interactive: a prompted knob is "prompt"; an advanced knob not opted-in still
    # resolves at "default"; a supplied knob stays "supplied" (not re-prompted).
    def prompter(name, knob, control, default):
        if name == "learning_rate":
            return "2e-5"
        return default if default is not None else "grpo"

    out = builder.build_config(
        HP, {"global_batch_size": "256"}, interactive=True,
        include_advanced=False, prompter=prompter)
    assert out["errors"] == []
    assert out["sources"]["learning_rate"] == "prompt"      # entered interactively
    assert out["sources"]["global_batch_size"] == "supplied"  # supplied, not prompted
    assert out["sources"]["warmup_ratio"] == "default"      # advanced, opt-in off


# ── validation (R1.3) ─────────────────────────────────────────────────────────

def test_enum_violation_named_with_choices():
    out = builder.build_config(HP, {"global_batch_size": "99", "advantage_method": "grpo"},
                               interactive=False)
    assert any("global_batch_size" in e and "one of" in e for e in out["errors"])


def test_range_violation_named_with_bound():
    out = builder.build_config(HP, {"learning_rate": "5", "advantage_method": "grpo"},
                               interactive=False)
    assert any("learning_rate" in e and "<=" in e for e in out["errors"])


def test_type_violation_named():
    out = builder.build_config(HP, {"global_batch_size": "notanint", "advantage_method": "grpo"},
                               interactive=False)
    assert any("global_batch_size" in e for e in out["errors"])


# ── unknown supplied knob rejected (R3.3) ─────────────────────────────────────

def test_unknown_supplied_knob_rejected_naming_valid_set():
    out = builder.build_config(HP, {"not_a_knob": "x", "advantage_method": "grpo"},
                               interactive=False)
    assert any("not_a_knob" in e and "Valid knobs" in e for e in out["errors"])


# ── progressive disclosure + interactive==non-interactive parity (R2, R4.1) ───

def test_interactive_prompts_primary_and_advanced_on_optin_not_tertiary():
    prompted = []

    def prompter(name, knob, control, default):
        prompted.append(name)
        # Return the default (simulating the user accepting it); required knob gets a value.
        return default if default is not None else "grpo"

    out = builder.build_config(HP, {}, interactive=True, include_advanced=True,
                               prompter=prompter)
    assert out["errors"] == []
    # primary + advanced prompted; tertiary NEVER prompted
    assert "learning_rate" in prompted and "global_batch_size" in prompted
    assert "warmup_ratio" in prompted              # advanced, because include_advanced
    assert "debug_dump_path" not in prompted       # tertiary never prompted
    assert "advantage_method" in prompted          # no tier → primary → prompted


def test_advanced_not_prompted_without_optin():
    prompted = []

    def prompter(name, knob, control, default):
        prompted.append(name)
        return default if default is not None else "grpo"

    builder.build_config(HP, {}, interactive=True, include_advanced=False, prompter=prompter)
    assert "warmup_ratio" not in prompted          # advanced, opt-in OFF
    # advanced knob still resolves to its default (R2.4), just not prompted
    out = builder.build_config(HP, {"advantage_method": "grpo"}, interactive=False)
    assert out["resolved"]["warmup_ratio"] == 0.1


def test_interactive_and_non_interactive_resolve_identically_for_same_inputs():
    # With everything supplied, the interactive path (prompter never consulted because
    # knobs are in `supplied`) resolves identically to non-interactive.
    supplied = {"learning_rate": "2e-5", "global_batch_size": "128",
                "warmup_ratio": "0.2", "advantage_method": "grpo"}

    def prompter(*a):
        raise AssertionError("should not prompt when the knob is supplied")

    interactive = builder.build_config(HP, dict(supplied), interactive=True,
                                       include_advanced=True, prompter=prompter)
    non_interactive = builder.build_config(HP, dict(supplied), interactive=False)
    assert interactive["resolved"] == non_interactive["resolved"]
    assert interactive["errors"] == non_interactive["errors"] == []


# ── a knob with no default, prompted empty, stays unset unless required ────────

def test_optional_no_default_prompted_empty_is_omitted():
    hp = {"opt": {"type": "string", "required": False, "tier": "primary"}}

    def prompter(name, knob, control, default):
        return ""   # user accepts "no value"

    out = builder.build_config(hp, {}, interactive=True, prompter=prompter)
    assert out["errors"] == []
    assert "opt" not in out["resolved"]


# ── tune.d adapter (task 2.1) — the ONLY tune.d-aware entry ───────────────────

def test_adapter_reads_tune_d_and_runs_core(tmp_path):
    # Point the adapter at a temp tune.d with a populated block (the committed
    # descriptors are pre-sync / empty). Proves the adapter reads tune.d and feeds the
    # core — while the core itself (tested above) stays tune.d-agnostic.
    import json
    d = tmp_path / "tune.d" / "rlvr"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({
        "technique": "rlvr", "reward_source": "rule",
        "variants": {"lora": {
            "peft": "lora", "artifact_kind": "lora_adapter",
            "dataset_contract": {"format": "parquet", "schema": "verl-5field",
                                 "prompt_shape": "message-list",
                                 "reward_model_style": "rule", "verified": True},
            "hyperparameters": {
                "learning_rate": {"type": "number", "required": False, "default": 1e-5,
                                  "min": 0, "max": 1, "control": "number_input", "tier": "primary"},
            },
            "_synced": {"smtj": {"from": "s3://b/x_v1.0.0.json", "version": "1.0.0"}},
        }},
    }))
    out = builder.build_from_tune_descriptor(
        "rlvr", "lora", {}, interactive=False, tune_dir=str(tmp_path / "tune.d"))
    assert out["errors"] == []
    assert out["resolved"]["learning_rate"] == 1e-5


def test_empty_hyperparameters_block_is_valid_empty_config():
    # An EMPTY hyperparameters block (e.g. a technique whose recipe exposes no
    # override-params, or a pre-sync descriptor) → an empty resolved config, NOT a
    # crash. Driven against the descriptor-AGNOSTIC core with an in-memory empty
    # block so the test does NOT depend on any shipped descriptor being empty —
    # after BL173 the real sft/dpo descriptors carry synced knobs, so asserting
    # emptiness against a live technique would (and did) rot.
    out = builder.build_config({}, {}, interactive=False)
    assert out["errors"] == []
    assert out["resolved"] == {}


def test_numeric_prompt_shows_range_and_validates_inline(monkeypatch):
    # BL-UX: a min/max-bounded knob's prompt must (a) show the allowed range in the
    # message and (b) carry an inline validate= callback that rejects out-of-range
    # input AT the prompt (not only via the core after all prompts). Enum knobs are
    # already constrained via questionary.select (dropdown), so this covers the
    # numeric free-text path that previously offered unbounded values.
    import questionary
    captured = {}

    class _FakeText:
        def __init__(self, message, **kw):
            captured["message"] = message
            captured["validate"] = kw.get("validate")

        def ask(self):
            return None

    monkeypatch.setattr(questionary, "text", _FakeText)
    knob = {"type": "number", "min": 5e-07, "max": 1e-04, "default": 1e-04, "tier": "primary"}
    builder._questionary_prompter("learning_rate", knob, "number_input", 1e-04)

    # (a) the range is visible in the prompt message
    assert "5e-07" in captured["message"] and "0.0001" in captured["message"]
    # (b) the inline validator accepts in-range, rejects out-of-range (string = error msg)
    v = captured["validate"]
    assert v is not None
    assert v("1e-5") is True                 # in range
    assert v("") is True                     # empty → default
    err = v("5")                             # 5 >> max
    assert isinstance(err, str) and "0.0001" in err


def test_enum_prompt_uses_dropdown_not_free_text(monkeypatch):
    # An enum knob must render as a constrained select (dropdown), never free text.
    import questionary
    seen = {"select": False, "text": False}

    class _FakeSelect:
        def __init__(self, *a, **k):
            seen["select"] = True

        def ask(self):
            return "16"

    class _FakeText:
        def __init__(self, *a, **k):
            seen["text"] = True

        def ask(self):
            return None

    monkeypatch.setattr(questionary, "select", _FakeSelect)
    monkeypatch.setattr(questionary, "text", _FakeText)
    knob = {"type": "integer", "enum": [16, 32, 64], "default": 16, "tier": "primary"}
    builder._questionary_prompter("global_batch_size", knob, "dropdown", 16)
    assert seen["select"] and not seen["text"]


# ── BL180 Option 1: per-model SDK _specs source (read_sdk_specs) ──────────────

def _install_fake_trainer(monkeypatch, specs, *, raises=None, accepts_training_type=True,
                          sequence_length=None):
    """Install a fake SMTJ trainer module whose constructed instance exposes
    hyperparameters._specs = `specs` (and ._sequence_length when given). Mirrors the
    real DPOTrainer(...)._specs path offline (no SDK/AWS)."""
    import types as _types

    class _FakeHP:
        def __init__(self, s):
            self._specs = s
            self._sequence_length = sequence_length

    class _FakeTrainer:
        def __init__(self, *a, training_type=None, **k):
            if raises:
                raise raises
            if not accepts_training_type and training_type is not None:
                raise TypeError("training_type not accepted")
            self.hyperparameters = _FakeHP(specs)

    mod = _types.ModuleType("sagemaker.train.dpo_trainer")
    mod.DPOTrainer = _FakeTrainer
    monkeypatch.setitem(sys.modules, "sagemaker.train.dpo_trainer", mod)


# A fake SDK _specs with the SDK's raw shape: control_type/visibility_tier, a system
# knob to be filtered, and a hyperparameter knob to keep.
_SDK_SPECS = {
    "learning_rate": {"category": "hyperparameter", "type": "float", "default": 1e-4,
                      "min": 1e-7, "max": 1e-3, "control_type": "number_input",
                      "visibility_tier": "primary", "required": True},
    "global_batch_size": {"category": "hyperparameter", "type": "integer", "default": 64,
                          "enum": [64, 128, 256], "control_type": "dropdown",
                          "visibility_tier": "primary", "required": True},
    "model_name_or_path": {"category": "system", "type": "string", "default": "x",
                           "control_type": "text_input", "visibility_tier": "tertiary"},
}


def test_read_sdk_specs_filters_system_and_renames_keys(monkeypatch):
    _install_fake_trainer(monkeypatch, _SDK_SPECS)
    hp = builder.read_sdk_specs("dpo", "some-model")
    # system knob dropped; two hyperparameter knobs kept
    assert set(hp.keys()) == {"learning_rate", "global_batch_size"}
    # control_type → control, visibility_tier → tier
    assert hp["global_batch_size"]["control"] == "dropdown"
    assert hp["global_batch_size"]["tier"] == "primary"
    assert hp["global_batch_size"]["enum"] == [64, 128, 256]
    assert hp["learning_rate"]["min"] == 1e-7 and hp["learning_rate"]["max"] == 1e-3


def test_build_from_sdk_specs_resolves_via_core(monkeypatch):
    _install_fake_trainer(monkeypatch, _SDK_SPECS)
    out = builder.build_from_sdk_specs("dpo", "some-model", {}, interactive=False)
    assert out["errors"] == []
    # non-interactive → descriptor defaults applied, from the SDK specs. (The core
    # passes a non-supplied default through in its declared form; compare by value.)
    assert float(out["resolved"]["global_batch_size"]) == 64
    assert float(out["resolved"]["learning_rate"]) == 1e-4
    # a system knob never appears as a resolved hyperparameter
    assert "model_name_or_path" not in out["resolved"]


def test_read_sdk_specs_unknown_technique_raises():
    with pytest.raises(ValueError):
        builder.read_sdk_specs("nonsense", "m")


def test_read_sdk_specs_propagates_construct_failure(monkeypatch):
    _install_fake_trainer(monkeypatch, _SDK_SPECS, raises=RuntimeError("no creds"))
    with pytest.raises(RuntimeError):
        builder.read_sdk_specs("dpo", "m")


def test_read_sdk_specs_handles_trainer_without_training_type(monkeypatch):
    # MTRL-style trainer that rejects training_type → the builder retries without it.
    _install_fake_trainer(monkeypatch, _SDK_SPECS, accepts_training_type=False)
    hp = builder.read_sdk_specs("dpo", "m", training_type="lora")
    assert "learning_rate" in hp


def test_read_sdk_specs_normalizes_float_type_so_values_coerce(monkeypatch):
    # BL180: the SDK uses type:'float' (not 'number'); _coerce only knows
    # integer/number/boolean/string, so without normalization a float value stays a
    # STRING and the submit fails "<knob> must be a number, got str". read_sdk_specs
    # must normalize float→number (and int→integer, array→string).
    specs = {
        "beta": {"category": "hyperparameter", "type": "float", "default": 0.01,
                 "min": 0.001, "max": 1.0, "control_type": "number_input",
                 "visibility_tier": "advanced"},
        "steps": {"category": "hyperparameter", "type": "int", "default": 3,
                  "min": 1, "max": 100, "control_type": "number_input",
                  "visibility_tier": "primary"},
    }
    _install_fake_trainer(monkeypatch, specs)
    hp = builder.read_sdk_specs("dpo", "m")
    assert hp["beta"]["type"] == "number"      # float → number
    assert hp["steps"]["type"] == "integer"    # int → integer
    # and a supplied string value now coerces to the right Python type (no str left)
    out = builder.build_config(hp, {"beta": "0.5", "steps": "4"}, interactive=False)
    assert out["errors"] == []
    assert isinstance(out["resolved"]["beta"], float)
    assert isinstance(out["resolved"]["steps"], int)


def test_float_step_is_a_hint_not_a_hard_constraint():
    # BL180: a FLOAT knob's `step` is a UI increment hint — the SMTJ SDK does not
    # enforce divisibility and even ships defaults that are not an exact multiple
    # (learning_rate default 0.0001, min 1e-07, step 0.0001). The validator must NOT
    # reject such a value on step-alignment. Range (min/max) still applies.
    hp = {"lr": {"type": "number", "required": False, "default": 1e-4,
                 "min": 1e-07, "max": 1e-3, "step": 1e-4}}
    out = builder.build_config(hp, {"lr": "0.0001"}, interactive=False)
    assert out["errors"] == [], out["errors"]            # not rejected on step
    assert float(out["resolved"]["lr"]) == 1e-4
    # but range IS still enforced for floats
    bad = builder.build_config(hp, {"lr": "5"}, interactive=False)
    assert bad["errors"] and "must be <=" in bad["errors"][0]


def test_integer_step_still_enforced():
    # For INTEGER knobs, step alignment remains a real constraint.
    hp = {"n": {"type": "integer", "required": False, "default": 0, "min": 0, "max": 10, "step": 2}}
    ok = builder.build_config(hp, {"n": "4"}, interactive=False)
    assert ok["errors"] == []
    bad = builder.build_config(hp, {"n": "3"}, interactive=False)
    assert bad["errors"] and "align to step" in bad["errors"][0]


# ── RL cross-field length constraint (max_prompt_length + max_response_length) ──
#
# The SMTJ validator enforces prompt+response <= the recipe's sequence length AT
# SUBMIT (FineTuningOptions.validate_length_constraints). Per-knob min/max cannot
# express it, so the builder fails fast at RESOLVE time instead — catching the SDK's
# own over-budget defaults (e.g. 16384 + 4096) before a full interactive session +
# submit round-trip. These are behavioral: they assert the sum rule, not any pinned
# per-model ceiling.

# A fabricated RL-shaped spec: the two length knobs plus the ceiling carried by
# read_sdk_specs. Values are illustrative (NOT a pinned real model).
_RL_SPECS = {
    "max_prompt_length": {"category": "hyperparameter", "type": "integer",
                          "default": 16384, "min": 512, "max": 20480,
                          "control_type": "number_input", "visibility_tier": "advanced"},
    "max_response_length": {"category": "hyperparameter", "type": "integer",
                            "default": 4096, "min": 100, "max": 20480,
                            "control_type": "number_input", "visibility_tier": "advanced"},
}


def test_over_budget_defaults_are_auto_fitted_not_errored(monkeypatch):
    # The SDK ships a self-contradictory default pair (16384 + 4096 = 20480 > a
    # 16384 ceiling). Accepting defaults must JUST WORK: the builder shrinks the
    # pair to fit (no --set needed), emits no error, and records a note.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)
    out = builder.build_from_sdk_specs("dpo", "m", {}, interactive=False)
    assert [e for e in out["errors"] if "sequence length" in e] == []
    p = out["resolved"]["max_prompt_length"]
    r = out["resolved"]["max_response_length"]
    # Behavioral: the fitted pair sums within the ceiling and PRESERVES the SDK's
    # prompt-heavy ratio (prompt > response), not a blunt even split.
    assert p + r <= 16384
    assert p > r
    assert out.get("notes") and any("Adjusted" in n for n in out["notes"])


def test_explicit_over_budget_pair_still_fails_fast(monkeypatch):
    # When the USER explicitly sets an over-budget pair, respect the intent and fail
    # fast with an actionable message — do NOT silently reshape their choice.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)
    out = builder.build_from_sdk_specs(
        "dpo", "m",
        {"max_prompt_length": "16384", "max_response_length": "4096"},
        interactive=False,
    )
    seq_errs = [e for e in out["errors"] if "sequence length" in e]
    assert len(seq_errs) == 1
    msg = seq_errs[0]
    assert "max_prompt_length" in msg and "max_response_length" in msg
    assert "20480" in msg and "16384" in msg and "--set" in msg
    # The user's EXPLICIT values override the (fitted) defaults, so they reach the
    # resolved config unchanged and the hard check rejects them.
    assert out["resolved"]["max_prompt_length"] == 16384
    assert out["resolved"]["max_response_length"] == 4096
    # No misleading "Adjusted the default" note when the user supplied BOTH values.
    assert out.get("notes") in (None, [])


def test_partial_override_over_budget_still_fails_fast(monkeypatch):
    # User pins only ONE side over budget. The other side keeps its FITTED default
    # (auto-fit rewrote the spec default), but the user's explicit side is honored —
    # and because the explicit value still over-budgets even against the fitted
    # other side, it fails fast rather than silently reshaping the user's choice.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)
    out = builder.build_from_sdk_specs(
        "dpo", "m", {"max_prompt_length": "16000"}, interactive=False,
    )
    assert [e for e in out["errors"] if "sequence length" in e]
    assert out["resolved"]["max_prompt_length"] == 16000  # user's value untouched


def test_length_sum_within_ceiling_passes(monkeypatch):
    # A split that sums to exactly the ceiling (8192 + 8192 = 16384) is valid.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)
    out = builder.build_from_sdk_specs(
        "dpo", "m",
        {"max_prompt_length": "8192", "max_response_length": "8192"},
        interactive=False,
    )
    assert [e for e in out["errors"] if "sequence length" in e] == []
    assert out["resolved"]["max_prompt_length"] == 8192
    assert out["resolved"]["max_response_length"] == 8192


def test_sequence_length_key_never_leaks_into_resolved(monkeypatch):
    # The out-of-band ceiling key must be stripped — never resolved as a knob nor
    # sent to the job.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)
    out = builder.build_from_sdk_specs(
        "dpo", "m",
        {"max_prompt_length": "4096", "max_response_length": "4096"},
        interactive=False,
    )
    assert builder._SEQUENCE_LENGTH_KEY not in out["resolved"]
    assert builder._SEQUENCE_LENGTH_KEY not in out.get("sources", {})


def test_length_check_noop_without_ceiling(monkeypatch):
    # No sequence_length known (SFT/DPO, or an older SDK) → never a false positive,
    # even if both length knobs happen to be present and large.
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=None)
    out = builder.build_from_sdk_specs("dpo", "m", {}, interactive=False)
    assert [e for e in out["errors"] if "sequence length" in e] == []


def test_check_length_sum_pure_function():
    # Direct unit on the pure helper: no-op unless both knobs present + ceiling known.
    assert builder._check_length_sum({"max_prompt_length": 8000,
                                      "max_response_length": 8000}, 16384) is None
    assert builder._check_length_sum({"max_prompt_length": 16384,
                                      "max_response_length": 4096}, 16384) is not None
    # missing one knob → no-op
    assert builder._check_length_sum({"max_prompt_length": 99999}, 16384) is None
    # unknown ceiling → no-op
    assert builder._check_length_sum({"max_prompt_length": 99999,
                                      "max_response_length": 99999}, None) is None


def test_fit_length_defaults_pure_function():
    # Operates on the knob SPEC defaults (pre-resolution), rewriting them in place.
    def specs():
        return {
            "max_prompt_length": {"min": 512, "max": 20480, "default": 16384},
            "max_response_length": {"min": 100, "max": 20480, "default": 4096},
        }
    # Over-budget defaults → rewritten to fit, prompt-heavy ratio kept.
    s = specs()
    note = builder._fit_length_defaults(s, 16384)
    assert note is not None
    p, r = s["max_prompt_length"]["default"], s["max_response_length"]["default"]
    assert p + r <= 16384
    assert p > r                       # SDK ratio preserved, not an even split

    # Already-fitting defaults → no-op, defaults untouched.
    s2 = {"max_prompt_length": {"min": 512, "max": 20480, "default": 8000},
          "max_response_length": {"min": 100, "max": 20480, "default": 4000}}
    assert builder._fit_length_defaults(s2, 16384) is None
    assert s2["max_prompt_length"]["default"] == 8000

    # Unknown ceiling → no-op.
    assert builder._fit_length_defaults(specs(), None) is None


def test_interactive_accepting_fitted_defaults_resolves_valid(monkeypatch):
    # THE regression: in interactive mode, accepting a prompted value records source
    # "prompt" (not "default"). Because auto-fit now rewrites the SPEC default BEFORE
    # prompting, the user is shown the FITTED pair and accepting it resolves valid —
    # no error. (Previously the un-fitted 16384/4096 was shown and errored on submit.)
    _install_fake_trainer(monkeypatch, _RL_SPECS, sequence_length=16384)

    def accept_default(name, knob, control, default):
        return default  # press-Enter: echo back whatever default we were shown

    out = builder.build_from_sdk_specs(
        "dpo", "m", {}, interactive=True, include_advanced=True,
        prompter=accept_default,
    )
    assert [e for e in out["errors"] if "sequence length" in e] == []
    p = out["resolved"]["max_prompt_length"]
    r = out["resolved"]["max_response_length"]
    assert p + r <= 16384 and p > r
    assert out.get("notes") and any("Adjusted" in n for n in out["notes"])


# ── judge_model_id dropdown enrichment + skip_knobs (RLAIF UX) ──────────────────


def test_skip_knobs_drops_a_knob_from_resolution(monkeypatch):
    # When a knob is set elsewhere (e.g. judge_prompt_template via --reward-prompt),
    # skip_knobs removes it so the user is not asked/resolved for it twice.
    specs = {
        "learning_rate": {"category": "hyperparameter", "type": "float", "default": 1e-4,
                          "control_type": "number_input", "visibility_tier": "primary"},
        "judge_prompt_template": {"category": "hyperparameter", "type": "string",
                                  "default": "x.jinja", "enum": ["x.jinja", "y.jinja"],
                                  "control_type": "dropdown", "visibility_tier": "primary"},
    }
    _install_fake_trainer(monkeypatch, specs)
    out = builder.build_from_sdk_specs(
        "dpo", "m", {}, interactive=False, skip_knobs=["judge_prompt_template"],
    )
    assert "judge_prompt_template" not in out["resolved"]
    assert "learning_rate" in out["resolved"]  # other knobs unaffected


def test_judge_model_knob_enriched_to_dropdown(monkeypatch):
    # The judge-model knob ships free-text (enum=None) but the SDK enumerates allowed
    # judge models in constants._ALLOWED_REWARD_MODEL_IDS. read_sdk_specs enriches it
    # into a dropdown sourced from that constant (region-filtered) and repoints a
    # default that is not in the allowed set.
    import types as _types
    fake_const = _types.ModuleType("sagemaker.train.constants")
    fake_const._ALLOWED_REWARD_MODEL_IDS = {
        "vendor.good-a": ["us-west-2", "us-east-1"],
        "vendor.good-b": ["us-west-2"],
        "vendor.other-region": ["eu-west-1"],   # filtered OUT in us-west-2
    }
    fake_const.get_sagemaker_hub_name = lambda *a, **k: "hub"
    monkeypatch.setitem(sys.modules, "sagemaker.train.constants", fake_const)
    monkeypatch.setenv("AWS_REGION", "us-west-2")

    specs = {
        "judge_model_id": {"category": "hyperparameter", "type": "string",
                           "default": "bedrock/not-in-allowed-list",
                           "control_type": "text_input", "visibility_tier": "primary"},
    }
    _install_fake_trainer(monkeypatch, specs)
    hp = builder.read_sdk_specs("dpo", "m")
    hp.pop("__sequence_length__", None)
    k = hp["judge_model_id"]
    # Behavioral: it is now a dropdown; choices are the region-valid allowed models
    # (NOT the eu-west-1-only one), and the invalid default was repointed into the set.
    assert k["control"] == "dropdown"
    assert "bedrock/vendor.good-a" in k["choices"]
    assert "bedrock/vendor.good-b" in k["choices"]
    assert "bedrock/vendor.other-region" not in k["choices"]  # region-filtered
    assert k["default"] in ("bedrock/vendor.good-a", "bedrock/vendor.good-b")
    # No HARD enum, so a custom --set value is not rejected by the core.
    assert k.get("enum") is None
    out = builder.build_config(hp, {"judge_model_id": "bedrock/anything-custom"},
                               interactive=False)
    assert out["errors"] == []
    assert out["resolved"]["judge_model_id"] == "bedrock/anything-custom"


def test_judge_model_knob_noop_when_sdk_has_no_allowed_list(monkeypatch):
    # Older/newer SDK without the constant → leave the free-text knob untouched.
    import types as _types
    fake_const = _types.ModuleType("sagemaker.train.constants")
    fake_const.get_sagemaker_hub_name = lambda *a, **k: "hub"
    # deliberately NO _ALLOWED_REWARD_MODEL_IDS
    monkeypatch.setitem(sys.modules, "sagemaker.train.constants", fake_const)
    specs = {
        "judge_model_id": {"category": "hyperparameter", "type": "string",
                           "default": "bedrock/whatever",
                           "control_type": "text_input", "visibility_tier": "primary"},
    }
    _install_fake_trainer(monkeypatch, specs)
    hp = builder.read_sdk_specs("dpo", "m")
    k = hp["judge_model_id"]
    assert "choices" not in k                 # not enriched
    assert k["default"] == "bedrock/whatever"  # untouched
