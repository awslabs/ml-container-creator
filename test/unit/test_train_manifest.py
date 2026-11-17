# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL154 runtime train-manifest validator — unit tests (Wave 7, R2 / R10.1).

Feature: v2-w7-01-train-plugin

`templates/do/lib/python/train_manifest.py` validates a user-authored
do/training/<technique>/manifest.json in plain Python (no jsonschema). Every R2.2
failure class is exercised with a deliberately malformed manifest; all problems are
reported in one pass; a bad file never raises anything but TrainManifestError.
"""
import json
import os
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_LIB = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")
_TRAINING = os.path.join(_REPO_ROOT, "templates", "do", "training")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import train_manifest as tm  # noqa: E402


def _valid(**overrides):
    data = {
        "$schema": "../manifest.schema.json",
        "schema_version": 1,
        "technique": "mytech",
        "display_name": "My technique",
        "hyperparameters": {
            "learning_rate": {"type": "number", "required": False, "min": 0, "tier": "primary"},
            "epochs": {"type": "integer", "required": False, "min": 1, "default": 3},
            "scheduler": {"type": "string", "required": False, "enum": ["linear", "cosine"],
                          "control": "dropdown"},
        },
    }
    data.update(overrides)
    return data


def _problems(data, technique="mytech"):
    return tm.validate_train_manifest(data, technique=technique, path="x/manifest.json")


def _knob(**entry):
    base = {"type": "number", "required": False}
    base.update(entry)
    return _valid(hyperparameters={"k": base})


def test_valid_manifest_has_no_problems_and_schema_key_is_ignored():
    assert _problems(_valid()) == []


@pytest.mark.parametrize("data, needle", [
    (_valid(technique="other"), "'other' but the manifest lives in the 'mytech' directory"),
    (_valid(technique="Bad Name"), "lowercase id"),
    (_valid(schema_version=2), "'schema_version' must be 1"),
    (_valid(extra=True), "unknown top-level key 'extra'"),
    (_valid(hyperparameters=[]), "'hyperparameters' must be an object"),
    (_knob(choices=[1, 2]), "unknown key 'choices' (did you mean 'enum'?)"),
    (_knob(defualt=1), "unknown key 'defualt' (did you mean 'default'?)"),
    (_knob(type="float"), "'type' must be one of"),
    (_knob(required="no"), "'required' must be true or false"),
    (_knob(enum=[]), "'enum' must be a non-empty list"),
    (_knob(enum="a,b"), "'enum' must be a non-empty list"),
    (_knob(min="0"), "'min' must be a number"),
    (_knob(step=True), "'step' must be a number"),
    (_knob(min=1.0, max=0.1), "'min' (1.0) is greater than 'max' (0.1)"),
    (_knob(control="slider"), "'control' must be one of"),
    (_knob(tier="basic"), "'tier' must be one of"),
    (_knob(default="abc"), "'default' 'abc' is invalid"),
    (_knob(default=5, max=1), "'default' 5 is invalid"),
    (_knob(type="string", enum=["a"], default="b"), "'default' 'b' is invalid"),
    (_knob(display_name=3), "'display_name' must be a string"),
])
def test_each_failure_class_is_reported(data, needle):
    problems = _problems(data)
    assert any(needle in p for p in problems), problems


def test_missing_required_keys_reported():
    problems = _problems({"hyperparameters": {"k": {}}})
    joined = "\n".join(problems)
    assert "missing required top-level key 'schema_version'" in joined
    assert "missing required top-level key 'technique'" in joined
    assert "hyperparameters.k: missing required key 'type'" in joined
    assert "hyperparameters.k: missing required key 'required'" in joined


def test_all_problems_reported_in_one_pass():
    data = _valid(technique="other", hyperparameters={
        "a": {"type": "number", "required": False, "min": 2, "max": 1},
        "b": {"type": "string", "required": "yes", "choices": ["x"]},
    })
    problems = _problems(data)
    assert len(problems) >= 4, problems
    assert any(p.startswith("hyperparameters.a:") for p in problems)
    assert sum(p.startswith("hyperparameters.b:") for p in problems) >= 2


def _write(tmp_path, technique, text):
    d = tmp_path / technique
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(text, encoding="utf-8")
    return str(tmp_path)


def test_absent_manifest_returns_none(tmp_path):
    (tmp_path / "custom").mkdir()
    assert tm.load_train_manifest(str(tmp_path), "custom") is None


def test_bad_json_reports_line_and_col(tmp_path):
    root = _write(tmp_path, "mytech", '{\n  "schema_version": 1,\n  oops\n}\n')
    with pytest.raises(tm.TrainManifestError) as ei:
        tm.load_train_manifest(root, "mytech")
    (problem,) = ei.value.problems
    assert problem.startswith("not valid JSON (line 3, col 3)"), problem
    assert ei.value.path.endswith(os.path.join("mytech", "manifest.json"))


def test_invalid_manifest_raises_structured_error(tmp_path):
    root = _write(tmp_path, "mytech", json.dumps(_knob(min=1.0, max=0.1)))
    with pytest.raises(tm.TrainManifestError) as ei:
        tm.load_train_manifest(root, "mytech")
    msg = ei.value.format("do/training/mytech/manifest.json")
    assert msg.splitlines()[0] == "\u274c Invalid training manifest: do/training/mytech/manifest.json"
    assert "hyperparameters.k: 'min' (1.0) is greater than 'max' (0.1)" in msg
    assert "delete it to fall back to defaults.yaml + flags" in msg
    assert "Traceback" not in msg


@pytest.mark.parametrize("text", [
    "", "null", "[]", "42", '"str"', '{"hyperparameters": {"k": null}}',
    '{"hyperparameters": {"k": {"type": "integer", "required": false, "default": [1]}}}',
    '{"hyperparameters": {"": {}}}', "\ufeff{}",
])
def test_never_raises_anything_but_train_manifest_error(tmp_path, text):
    root = _write(tmp_path, "mytech", text)
    with pytest.raises(tm.TrainManifestError):
        tm.load_train_manifest(root, "mytech")


def test_valid_file_loads(tmp_path):
    root = _write(tmp_path, "mytech", json.dumps(_valid()))
    data = tm.load_train_manifest(root, "mytech")
    assert data["technique"] == "mytech"


@pytest.mark.parametrize("technique", sorted(
    d for d in os.listdir(_TRAINING)
    if os.path.isfile(os.path.join(_TRAINING, d, "manifest.json"))
))
def test_shipped_manifests_pass_the_runtime_validator(technique):
    data = tm.load_train_manifest(_TRAINING, technique)
    assert data is not None and data["hyperparameters"]
