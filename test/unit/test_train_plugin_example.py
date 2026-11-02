# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""The sft-neftune sample plugin (examples/train-plugins/sft-neftune) stays valid.

The walkthrough in docs/train-plugin-walkthrough.md tells users to copy this directory
into do/training/. These tests keep that promise honest:
  - the manifest passes the runtime validator, named after its directory;
  - train.py reads exactly the knobs the manifest declares (no undeclared reads, no
    declared-but-ignored knobs), and defaults.yaml only sets declared knobs;
  - the resolver behaves as the walkthrough shows (defaults resolve; a typo, an
    out-of-range value and a bad enum are rejected; --allow-unknown passes a key through).
"""
import importlib.util
import os
import shutil
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_LIB = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")
_SAMPLE = os.path.join(_REPO_ROOT, "examples", "train-plugins", "sft-neftune")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import train_manifest as tm  # noqa: E402
import tune_config_builder as tcb  # noqa: E402

yaml = pytest.importorskip("yaml")


@pytest.fixture
def training_dir(tmp_path):
    """A do/training/ dir with the sample copied in, as the walkthrough does."""
    dest = tmp_path / "training"
    shutil.copytree(_SAMPLE, dest / "sft-neftune")
    return str(dest)


def _defaults():
    with open(os.path.join(_SAMPLE, "defaults.yaml")) as fh:
        return yaml.safe_load(fh)


def _train_module():
    spec = importlib.util.spec_from_file_location("sft_neftune_train", os.path.join(_SAMPLE, "train.py"))
    mod = importlib.util.module_from_spec(spec)
    # Don't leave a __pycache__ inside examples/: it would ship in the npm package.
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(mod)  # heavy imports live inside main(), so this is cheap
    finally:
        sys.dont_write_bytecode = previous
    return mod


def _resolve(training_dir, supplied=None, allow_unknown=False):
    return tcb.build_from_train_descriptor(
        "sft-neftune", supplied or {}, interactive=False, training_dir=training_dir,
        defaults=_defaults(), config_hp={}, allow_unknown=allow_unknown,
    )


def test_manifest_is_valid(training_dir):
    manifest = tm.load_train_manifest(training_dir, "sft-neftune")
    assert manifest is not None
    assert manifest["technique"] == "sft-neftune"


def test_train_py_reads_exactly_the_declared_knobs(training_dir):
    declared = set(tm.load_train_manifest(training_dir, "sft-neftune")["hyperparameters"])
    read = set(_train_module().default_hyperparameters())
    assert read == declared, f"only in train.py: {read - declared}; only in manifest: {declared - read}"


def test_defaults_only_set_declared_knobs_and_manifest_carries_no_defaults(training_dir):
    knobs = tm.load_train_manifest(training_dir, "sft-neftune")["hyperparameters"]
    assert set(_defaults()) <= set(knobs)
    assert not [k for k, v in knobs.items() if "default" in v]


def test_defaults_resolve_without_errors(training_dir):
    result = _resolve(training_dir)
    assert result["errors"] == []
    assert result["resolved"]["neftune_noise_alpha"] == "5"
    assert result["resolved"]["learning_rate"] == "2e-4"  # string form preserved
    assert result["sources"]["lr_scheduler_type"] == "defaults.yaml"


def test_flag_wins_and_is_labelled(training_dir):
    result = _resolve(training_dir, {"neftune_noise_alpha": "10"})
    assert result["errors"] == []
    assert result["resolved"]["neftune_noise_alpha"] == "10"
    assert result["sources"]["neftune_noise_alpha"] == "flag"


@pytest.mark.parametrize("supplied, needle", [
    ({"neftune_alpha": "10"}, "did you mean 'neftune_noise_alpha'"),
    ({"neftune_noise_alpha": "-1"}, "neftune_noise_alpha"),
    ({"lr_scheduler_type": "cosine_restarts"}, "lr_scheduler_type"),
    ({"lora_r": "24"}, "lora_r"),
])
def test_bad_values_are_rejected(training_dir, supplied, needle):
    errors = _resolve(training_dir, supplied)["errors"]
    assert errors and any(needle in e for e in errors), errors


def test_allow_unknown_passes_an_undeclared_key_through(training_dir):
    result = _resolve(training_dir, {"my_new_knob": "1"}, allow_unknown=True)
    assert result["errors"] == []
    assert result["resolved"]["my_new_knob"] == "1"
