# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL154 do/train adapter + `.train_helper.py build-config` — unit tests (Wave 7).

Feature: v2-w7-01-train-plugin

Covers R3 (resolution through the shared core), R4 (precedence identical to do/tune,
source labels, interactive re-offer + targeted config.yaml write-back, train<->tune
parity at the core level), R6 (descriptor-less legacy merge pinned to the former
inline do/train logic), R3.6/R3.7 (unknown-key rejection + --allow-unknown), and
string-form preservation (SageMaker hyperparameters are strings parsed by train.py).
No AWS, no TTY: the prompter is injected.
"""
import argparse
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys

import pytest
import yaml

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DO = os.path.join(_REPO_ROOT, "templates", "do")
_LIB = os.path.join(_DO, "lib", "python")
_HELPER = os.path.join(_DO, ".train_helper.py")
_CONFIG_TEMPLATE = os.path.join(_DO, "training", "config.yaml")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import tune_config_builder as tcb  # noqa: E402
import train_manifest  # noqa: E402


def _load_helper():
    spec = importlib.util.spec_from_file_location("train_helper_under_test", _HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


helper = _load_helper()

HP = {
    "learning_rate": {"type": "number", "required": False, "min": 0, "tier": "primary"},
    "epochs": {"type": "integer", "required": False, "min": 1, "default": 1, "tier": "primary"},
    "lora_alpha": {"type": "integer", "required": False, "min": 1, "tier": "advanced"},
    "model_id": {"type": "string", "required": False, "tier": "tertiary"},
    "scheduler": {"type": "string", "required": False, "enum": ["linear", "cosine"],
                  "default": "linear", "tier": "primary"},
}


@pytest.fixture
def training_dir(tmp_path):
    def make(hp=None, technique="mytech"):
        d = tmp_path / technique
        d.mkdir(parents=True, exist_ok=True)
        (d / "train.py").write_text("# train\n")
        (d / "manifest.json").write_text(json.dumps({
            "schema_version": 1, "technique": technique,
            "hyperparameters": HP if hp is None else hp,
        }))
        return str(tmp_path)
    return make


def _build(training_dir, supplied=None, **kw):
    kw.setdefault("interactive", False)
    return tcb.build_from_train_descriptor(
        "mytech", supplied or {}, training_dir=training_dir, **kw)


# ── precedence + source labels (R4.1 / R4.4) ─────────────────────────────────

def test_precedence_manifest_lt_defaults_lt_config_lt_flag(training_dir):
    root = training_dir()
    r = _build(root,
               supplied={"learning_rate": "3e-4"},
               defaults={"learning_rate": "2e-4", "epochs": 3, "lora_alpha": 32},
               config_hp={"epochs": "5", "learning_rate": "1e-4"})
    assert r["errors"] == []
    assert r["descriptor"] is True
    assert r["resolved"] == {"learning_rate": "3e-4", "epochs": "5", "lora_alpha": "32",
                             "scheduler": "linear"}
    assert r["sources"] == {"learning_rate": "flag", "epochs": "config.yaml",
                            "lora_alpha": "defaults.yaml", "scheduler": "manifest"}


def test_no_manifest_returns_none(tmp_path):
    (tmp_path / "custom").mkdir()
    assert tcb.build_from_train_descriptor(
        "custom", {}, interactive=False, training_dir=str(tmp_path)) is None


def test_optional_knob_without_value_is_omitted(training_dir):
    r = _build(training_dir())
    assert "model_id" not in r["resolved"] and "learning_rate" not in r["resolved"]


# ── validation through the core (R3.2) ───────────────────────────────────────

@pytest.mark.parametrize("supplied, needle", [
    ({"epochs": "0"}, "must be >= 1"),
    ({"epochs": "two"}, "expects type integer"),
    ({"scheduler": "step"}, "must be one of"),
])
def test_supplied_values_are_type_and_range_checked(training_dir, supplied, needle):
    r = _build(training_dir(), supplied=supplied)
    assert any(needle in e for e in r["errors"]), r["errors"]


def test_layer_values_are_validated_too(training_dir):
    r = _build(training_dir(), defaults={"epochs": -1})
    assert any("must be >= 1" in e for e in r["errors"])


# ── string-form preservation ─────────────────────────────────────────────────

def test_unchanged_values_keep_their_string_form(training_dir):
    r = _build(training_dir(), supplied={"learning_rate": "1e-4"},
               defaults={"epochs": "03"}, config_hp={"lora_alpha": "32"})
    assert r["resolved"]["learning_rate"] == "1e-4"   # not "0.0001"
    assert r["resolved"]["epochs"] == "03"            # validated as int 3, emitted verbatim
    assert r["typed"]["learning_rate"] == pytest.approx(1e-4)
    r2 = _build(training_dir(), defaults={"learning_rate": "2e-4"})
    assert r2["resolved"]["learning_rate"] == "2e-4"


# ── pass-through + unknown-key rejection (R3.4 / R3.6 / R3.7) ────────────────

def test_undeclared_layer_keys_pass_through_with_notice(training_dir):
    r = _build(training_dir(), defaults={"my_flag": True}, config_hp={"other": 7})
    assert r["errors"] == []
    assert r["resolved"]["my_flag"] == "True" and r["resolved"]["other"] == "7"
    assert r["sources"]["my_flag"] == "defaults.yaml" and r["sources"]["other"] == "config.yaml"
    assert r["passthrough"] == ["my_flag", "other"]


def test_typo_in_supplied_key_is_rejected_with_suggestion(training_dir):
    r = _build(training_dir(), supplied={"learnign_rate": "1e-4"})
    (err,) = r["errors"]
    assert "unknown knob 'learnign_rate' for technique 'mytech'" in err
    assert "did you mean 'learning_rate'?" in err
    assert "Declared: epochs, learning_rate, lora_alpha, model_id, scheduler" in err
    assert "--allow-unknown" in err


def test_legacy_flag_for_undeclared_knob_is_rejected(training_dir):
    # e.g. --beta on a technique whose manifest has no beta.
    r = _build(training_dir(), supplied={"beta": "0.1"})
    assert len(r["errors"]) == 1 and "unknown knob 'beta'" in r["errors"][0]


def test_allow_unknown_passes_supplied_key_through(training_dir):
    r = _build(training_dir(), supplied={"beta": "0.1"}, allow_unknown=True)
    assert r["errors"] == []
    assert r["resolved"]["beta"] == "0.1" and r["sources"]["beta"] == "flag"
    assert "beta" in r["passthrough"]


# ── interactive (R3.3 / R4.2) ────────────────────────────────────────────────

class _Prompter:
    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls = []

    def __call__(self, name, knob, control, default):
        self.calls.append((name, default))
        return self.answers.get(name, "")


def test_interactive_prompts_primary_only_and_reoffers_config_values(training_dir):
    p = _Prompter({"learning_rate": "5e-5"})
    r = _build(training_dir(), interactive=True, prompter=p,
               supplied={"scheduler": "cosine"},
               defaults={"epochs": 3}, config_hp={"epochs": "4"})
    asked = dict(p.calls)
    assert set(asked) == {"learning_rate", "epochs"}   # scheduler supplied; advanced/tertiary skipped
    assert asked["epochs"] == "4"                      # config.yaml re-offered as the default
    assert r["sources"]["learning_rate"] == "prompt"
    assert r["resolved"]["learning_rate"] == "5e-5"
    assert r["sources"]["epochs"] == "config.yaml"     # accepted the default (empty answer)
    assert r["prompted"] == {"learning_rate": "5e-5"}


def test_advanced_adds_advanced_tier_never_tertiary(training_dir):
    p = _Prompter()
    _build(training_dir(), interactive=True, include_advanced=True, prompter=p)
    asked = {n for n, _ in p.calls}
    assert "lora_alpha" in asked and "model_id" not in asked


# ── parity with the tune adapter at the core level (R4.3) ────────────────────

@pytest.mark.parametrize("supplied", [
    {}, {"epochs": "7"}, {"learning_rate": "1e-3", "scheduler": "cosine"}, {"epochs": "0"},
])
def test_train_and_tune_adapters_agree_non_interactively(training_dir, monkeypatch, supplied):
    import tune_manifest
    monkeypatch.setattr(tune_manifest, "read_hyperparameters",
                        lambda technique, variant=None, tune_dir=None: json.loads(json.dumps(HP)))
    tune = tcb.build_from_tune_descriptor("sft", "lora", dict(supplied), interactive=False)
    train = _build(training_dir(), supplied=dict(supplied))
    assert train["typed"] == tune["resolved"]
    assert train["errors"] == tune["errors"]


# ── descriptor-less legacy merge pinned to the former inline logic (R6.1) ────

def _former_inline_merge(defaults, config_hp, cli):
    """Verbatim semantics of do/train's former `_merge_hyperparameters` inline Python."""
    merged = {str(k): str(v) for k, v in defaults.items()}
    merged.update({str(k): str(v) for k, v in config_hp.items()})
    merged.update(cli)
    return merged


@pytest.mark.parametrize("defaults, config_hp, cli", [
    ({}, {}, {}),
    ({"lora_r": 16, "learning_rate": "2e-4", "reference_free": False}, {}, {}),
    ({"epochs": 3}, {"epochs": "10", "batch_size": "32"}, {"epochs": "1"}),
    ({"a": 1.5}, {"b": None}, {"learning_rate": "5e-5", "beta": "0.2"}),
])
def test_legacy_merge_matches_former_behavior(defaults, config_hp, cli):
    merged, sources = helper._legacy_merge(defaults, config_hp, cli)
    assert merged == _former_inline_merge(defaults, config_hp, cli)
    for k in cli:
        assert sources[k] == "flag"


# ── targeted config.yaml write-back (R4.5 / OQ-7) ────────────────────────────

def _top_level_except_hp(text):
    data = yaml.safe_load(text) or {}
    data.pop("hyperparameters", None)
    return data


@pytest.mark.parametrize("hp_text", [
    'hyperparameters:\n  epochs: "10"\n  # inline comment\n  batch_size: "32"\n',
    "hyperparameters: {}\n",
    "hyperparameters: {epochs: 3}\n",
    "",
])
def test_rewrite_changes_only_the_hyperparameters_block(hp_text):
    before = ("technique: \"sft\"\n# ── Section ──\nimage: \"x\"\n" + hp_text +
              "# ── Next section ──\nmax_runtime_seconds: 86400\ntags: {}\n")
    after = tcb.rewrite_hyperparameters_block(before, {"epochs": "4", "learning_rate": "2e-4"})
    assert _top_level_except_hp(after) == _top_level_except_hp(before)
    assert yaml.safe_load(after)["hyperparameters"] == {"epochs": "4", "learning_rate": "2e-4"}


def test_rewrite_on_the_shipped_config_template():
    before = open(_CONFIG_TEMPLATE, encoding="utf-8").read()
    after = tcb.rewrite_hyperparameters_block(before, {"lora_r": "32", "odd key": 'a"b'})
    assert _top_level_except_hp(after) == _top_level_except_hp(before)
    assert yaml.safe_load(after)["hyperparameters"] == {"lora_r": "32", "odd key": 'a"b'}


# ── the helper subcommand ────────────────────────────────────────────────────

def _args(training_dir, technique="mytech", **kw):
    ns = dict(technique=technique, training_dir=training_dir, supplied="{}", defaults="{}",
              config_hp="{}", interactive=False, advanced=False, allow_unknown=False,
              write_config=None)
    ns.update(kw)
    return argparse.Namespace(**ns)


def _run_cmd(monkeypatch, args):
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    with pytest.raises(SystemExit) as ei:
        helper.cmd_build_config(args)
    return ei.value.code, out.getvalue()


def test_helper_interactive_writes_answers_back(training_dir, tmp_path, monkeypatch):
    root = training_dir()
    cfg = tmp_path / "config.yaml"
    original = 'technique: "mytech"\nimage: "img"\nhyperparameters:\n  epochs: "4"\n  extra: "x"\ntags: {}\n'
    cfg.write_text(original)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr(tcb, "_questionary_prompter", _Prompter({"learning_rate": "7e-5"}))
    code, out = _run_cmd(monkeypatch, _args(
        root, interactive=True, write_config=str(cfg),
        config_hp=json.dumps({"epochs": "4", "extra": "x"})))
    assert code == 0
    result = json.loads(out.strip().splitlines()[-1])
    assert result["resolved"]["learning_rate"] == "7e-5"
    after = cfg.read_text()
    assert _top_level_except_hp(after) == _top_level_except_hp(original)
    assert yaml.safe_load(after)["hyperparameters"] == {
        "epochs": "4", "extra": "x", "learning_rate": "7e-5"}


def test_helper_without_tty_does_not_prompt(training_dir, monkeypatch):
    root = training_dir()
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)

    def _boom(*a, **k):
        raise AssertionError("must not prompt without a TTY")
    monkeypatch.setattr(tcb, "_questionary_prompter", _boom)
    code, out = _run_cmd(monkeypatch, _args(root, interactive=True))
    assert code == 0
    assert any("no TTY" in n for n in json.loads(out.strip())["notes"])


def test_helper_descriptorless_advanced_notice(tmp_path, monkeypatch):
    (tmp_path / "custom").mkdir()
    code, out = _run_cmd(monkeypatch, _args(str(tmp_path), technique="custom", advanced=True,
                                            supplied='{"a": "1"}'))
    result = json.loads(out.strip())
    assert code == 0 and result["descriptor"] is False
    assert result["resolved"] == {"a": "1"}
    assert any("--advanced has no effect" in n for n in result["notes"])


def _python():
    return sys.executable


def test_helper_cli_bad_manifest_exits_2_without_traceback(tmp_path):
    d = tmp_path / "do" / "training" / "mytech"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text('{"schema_version": 1, "technique": "mytech", '
                                     '"hyperparameters": {"k": {"type": "nope", "required": 1}}}')
    r = subprocess.run([_python(), _HELPER, "build-config", "--technique", "mytech",
                        "--training-dir", str(tmp_path / "do" / "training")],
                       capture_output=True, text=True)
    assert r.returncode == 2, r.stderr
    assert "Traceback" not in r.stderr + r.stdout
    assert "Invalid training manifest: do/training/mytech/manifest.json" in r.stderr
    assert "hyperparameters.k: 'type' must be one of" in r.stderr
    assert "hyperparameters.k: 'required' must be true or false" in r.stderr
    assert r.stdout.strip() == ""


def test_helper_cli_runs_from_a_copied_do_dir(tmp_path):
    """The helper finds lib/python relative to itself (sys.path insert), like .tune_helper.py."""
    do = tmp_path / "do"
    shutil.copytree(_LIB, do / "lib" / "python")
    shutil.copy2(_HELPER, do / ".train_helper.py")
    (do / "training" / "custom").mkdir(parents=True)
    r = subprocess.run([_python(), str(do / ".train_helper.py"), "build-config",
                        "--technique", "custom", "--training-dir", str(do / "training"),
                        "--config-hp", '{"epochs": "10"}'],
                       capture_output=True, text=True, cwd=str(tmp_path))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["resolved"] == {"epochs": "10"}
