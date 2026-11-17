# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL129 tune-descriptor manifest reader — Python unit tests (pytest only, no extra deps).

Feature: v2-w3-01-bl129

Deterministic checks for templates/do/lib/python/tune_manifest.py — the runtime
reader the do/tune dataset preflight (Gate field-schema half) and the register-side
producer use to read a technique's dataset_contract from
tune.d/<technique>/manifest.json instead of a hardcoded per-technique table.

Behavior-level (not frozen-snapshot): the required-field set is derived from the
dataset_contract `schema`, so rlvr/rlaif (both verl-5field) share one contract and
mtrl (mtrl-rollout, unverified) format-checks only.
"""

import importlib.util
import os

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_READER_PATH = os.path.join(
    _REPO_ROOT, "templates", "do", "lib", "python", "tune_manifest.py"
)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tune_manifest = _load("tune_manifest", _READER_PATH)


# -- dataset_contract ----------------------------------------------------------

def test_rlaif_contract_is_verl_parquet_model_style():
    c = tune_manifest.dataset_contract("rlaif", "lora")
    assert c["schema"] == "verl-5field"
    assert c["format"] == "parquet"
    assert c["prompt_shape"] == "message-list"
    assert c["reward_model_style"] == "model"


def test_rlvr_reward_model_style_is_rule():
    assert tune_manifest.reward_model_style("rlvr", "lora") == "rule"


def test_sft_contract_has_no_reward_model_style():
    assert tune_manifest.reward_model_style("sft", "lora") is None


def test_default_variant_resolves_for_lora_only_technique():
    # mtrl is lora-only; omitting the variant resolves to it.
    assert tune_manifest.dataset_contract("mtrl")["schema"] == "mtrl-rollout"


# -- required_dataset_fields (the Gate's field-schema contract) ----------------

def test_verl_techniques_require_the_five_verl_fields():
    expected = ["data_source", "prompt", "ability", "reward_model", "extra_info"]
    assert tune_manifest.required_dataset_fields("rlvr", "lora") == expected
    assert tune_manifest.required_dataset_fields("rlaif", "lora") == expected


def test_mtrl_has_no_required_fields_so_gate_format_checks_only():
    # mtrl-rollout is unverified → no field contract → [] → Gate never field-checks it.
    assert tune_manifest.required_dataset_fields("mtrl") == []
    assert tune_manifest.is_verified("mtrl") is False


def test_sft_dpo_required_fields_from_schema():
    assert tune_manifest.required_dataset_fields("sft", "lora") == ["prompt", "completion"]
    assert tune_manifest.required_dataset_fields("dpo", "lora") == ["prompt", "chosen", "rejected"]


# -- format / verified ---------------------------------------------------------

def test_dataset_format_parquet_for_rl_jsonl_for_sft():
    assert tune_manifest.dataset_format("rlvr", "lora") == "parquet"
    assert tune_manifest.dataset_format("sft", "lora") == "jsonl"


def test_verl_techniques_are_verified():
    assert tune_manifest.is_verified("rlvr", "lora") is True
    assert tune_manifest.is_verified("rlaif", "lora") is True


# -- missing / malformed -------------------------------------------------------

def test_missing_technique_raises_not_found():
    with pytest.raises(tune_manifest.ManifestNotFound):
        tune_manifest.read_manifest("nope")


def test_dataset_contract_propagates_not_found():
    # The contract helpers read_manifest first; a missing technique surfaces as
    # ManifestNotFound (the Gate/producer translate it into a clear error).
    with pytest.raises(tune_manifest.ManifestNotFound):
        tune_manifest.dataset_contract("nope")


# -- read_hyperparameters (BL128 accessor on the BL129 reader) -----------------

def test_read_hyperparameters_empty_presync_for_committed_descriptors():
    # The committed descriptors ship hyperparameters:{} (populated by sync-model-families).
    # The accessor returns a dict (never raises for a known technique), empty pre-sync.
    hp = tune_manifest.read_hyperparameters("rlaif", "lora")
    assert isinstance(hp, dict)


def test_read_hyperparameters_missing_technique_raises_not_found():
    with pytest.raises(tune_manifest.ManifestNotFound):
        tune_manifest.read_hyperparameters("nope")


def test_training_type_alias_full_rank_resolves_full_variant():
    # do/tune passes the --training-type CLI value verbatim as the descriptor variant.
    # The CLI speaks `full-rank` but the descriptor key is `full`; the reader MUST
    # normalize the alias, else full-rank silently resolves to {} (no hyperparameters,
    # no interactive UX, --set rejects every knob). `full-rank` and `full` must resolve
    # to the SAME variant object (the committed `full` block may be empty pre-sync —
    # the point is they are the same object, not that it has knobs).
    m = tune_manifest.read_manifest("sft")
    assert tune_manifest._resolve_variant(m, "full-rank") == tune_manifest._resolve_variant(m, "full")
    assert tune_manifest._resolve_variant(m, "full_rank") == tune_manifest._resolve_variant(m, "full")
    # the alias reaches the real `full` variant, not an empty miss:
    assert tune_manifest.dataset_contract("sft", "full-rank") == tune_manifest.dataset_contract("sft", "full")
    # a genuinely-unknown variant still misses → {} (alias map is not a catch-all):
    assert tune_manifest._resolve_variant(m, "nonsense") == {}


def test_read_hyperparameters_reads_a_populated_block(tmp_path):
    # Point the reader at a temp tune.d with a populated hyperparameters block to prove
    # the accessor returns the synced knobs (the committed descriptors are pre-sync).
    import json
    tdir = tmp_path / "tune.d" / "rlvr"
    tdir.mkdir(parents=True)
    (tmp_path / "tune.d" / "rlvr" / "manifest.json").write_text(json.dumps({
        "technique": "rlvr",
        "reward_source": "rule",
        "variants": {
            "lora": {
                "peft": "lora", "artifact_kind": "lora_adapter",
                "dataset_contract": {"format": "parquet", "schema": "verl-5field",
                                     "prompt_shape": "message-list",
                                     "reward_model_style": "rule", "verified": True},
                "hyperparameters": {
                    "learning_rate": {"type": "number", "required": False, "default": 1e-5,
                                      "min": 0, "max": 1, "control": "number_input", "tier": "primary"},
                    "global_batch_size": {"type": "integer", "required": False, "default": 256,
                                          "enum": [128, 256], "control": "dropdown", "tier": "primary"},
                },
                "_synced": {"smtj": {"from": "s3://b/x_v1.0.0.json", "version": "1.0.0"}},
            }
        }
    }))
    hp = tune_manifest.read_hyperparameters("rlvr", "lora", tune_dir=str(tmp_path / "tune.d"))
    assert set(hp.keys()) == {"learning_rate", "global_batch_size"}
    assert hp["global_batch_size"]["enum"] == [128, 256]


def test_read_hyperparameters_lora_only_default_variant(tmp_path):
    # mtrl ships lora-only; omitting the variant resolves to it (empty pre-sync is fine).
    hp = tune_manifest.read_hyperparameters("mtrl")
    assert isinstance(hp, dict)


# -- artifact_kind (BL164: recorded on the registered version; ADR-013 gate) ---

def test_artifact_kind_lora_variant_is_lora_adapter():
    assert tune_manifest.artifact_kind("sft", "lora") == "lora_adapter"
    assert tune_manifest.artifact_kind("dpo", "lora") == "lora_adapter"


def test_artifact_kind_full_variant_is_full_model():
    assert tune_manifest.artifact_kind("sft", "full") == "full_model"
    assert tune_manifest.artifact_kind("dpo", "full") == "full_model"


def test_artifact_kind_default_variant_resolves():
    # Omitting the variant prefers 'lora' (present on every technique) → lora_adapter.
    assert tune_manifest.artifact_kind("rlvr") == "lora_adapter"
    assert tune_manifest.artifact_kind("mtrl") == "lora_adapter"  # mtrl is lora-only


def test_artifact_kind_missing_technique_raises_not_found():
    with pytest.raises(tune_manifest.ManifestNotFound):
        tune_manifest.artifact_kind("nope")


# -- Drift guard: the Python accessor must agree with EVERY committed descriptor
#    for EVERY declared variant. Because the Node reader (tune-manifest-reader.js
#    artifactKind) reads the SAME manifest.json field, pinning the Python accessor
#    to the descriptor's recorded value keeps the two readers from diverging
#    (ADR-011 posture: one declared source, conformance-checked). If a new
#    technique/variant is added, this test exercises it automatically.

def _iter_committed_variants():
    import json
    tune_d = os.path.join(_REPO_ROOT, "templates", "code", "tune.d")
    for technique in sorted(os.listdir(tune_d)):
        mpath = os.path.join(tune_d, technique, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        with open(mpath, encoding="utf-8") as f:
            manifest = json.load(f)
        for variant, vobj in (manifest.get("variants") or {}).items():
            yield technique, variant, vobj.get("artifact_kind")


def test_artifact_kind_accessor_matches_every_descriptor_variant():
    seen = 0
    for technique, variant, declared in _iter_committed_variants():
        seen += 1
        # Every committed variant declares an artifact_kind (schema-enforced).
        assert declared in ("lora_adapter", "full_model"), (
            f"{technique}/{variant} has unexpected artifact_kind {declared!r}"
        )
        # The reader returns exactly what the descriptor records — no drift.
        assert tune_manifest.artifact_kind(technique, variant) == declared, (
            f"reader disagrees with descriptor for {technique}/{variant}"
        )
    assert seen > 0, "no tune.d descriptors found — the drift guard exercised nothing"
