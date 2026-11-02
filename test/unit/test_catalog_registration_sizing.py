"""catalog_registration: size derivation for the project-local model-sizes cache.

Regression for neat-transformer-classifier: do/stage registered
Qwen/Qwen3.5-4B (a multimodal config nesting the LM under ``text_config``)
with no parameterCount and a defaulted maxPositionEmbeddings of 4096, which
made the instance-sizer return an empty recommendation list.

Uses the published Qwen3.5-4B config.json / Hub API fixture checked in under
servers/instance-sizer/test/fixtures/hf (no invented numbers). Offline: all
network fetchers are monkeypatched.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import catalog_registration as cr

FIXTURES = Path(__file__).resolve().parents[2] / "servers" / "instance-sizer" / "test" / "fixtures" / "hf"
QWEN35_CONFIG = json.loads((FIXTURES / "Qwen__Qwen3.5-4B.config.json").read_text())
QWEN35_HUB = json.loads((FIXTURES / "Qwen__Qwen3.5-4B.hub.json").read_text())


def test_multimodal_config_reads_text_config_not_4096_default() -> None:
    entry = cr._extract_from_hf_config(QWEN35_CONFIG, QWEN35_HUB)
    tc = QWEN35_CONFIG["text_config"]
    assert entry["maxPositionEmbeddings"] == tc["max_position_embeddings"]
    assert entry["maxPositionEmbeddings"] > 4096
    assert entry["defaultDtype"] == "bfloat16"
    assert entry["numLayers"] == tc["num_hidden_layers"]
    assert entry["numKvHeads"] == tc["num_key_value_heads"]
    assert entry["headDim"] == tc["head_dim"]


def test_parameter_count_from_hub_safetensors_with_source_recorded() -> None:
    entry = cr._extract_from_hf_config(QWEN35_CONFIG, QWEN35_HUB)
    assert entry["parameterCount"] == QWEN35_HUB["safetensors"]["total"]
    assert entry["parameterCountSource"] == "huggingface-safetensors-metadata"


def test_unknown_context_is_omitted_not_fabricated() -> None:
    entry = cr._extract_from_hf_config({"num_parameters": 7_000_000_000})
    assert "maxPositionEmbeddings" not in entry


def test_moe_config_is_not_estimated() -> None:
    entry = cr._extract_from_hf_config({"hidden_size": 4096, "num_hidden_layers": 32, "num_local_experts": 8})
    assert "parameterCount" not in entry


def test_incomplete_existing_entry_is_not_considered_registered() -> None:
    catalog = {"models": {"Qwen/Qwen3.5-4B*": {"architecture": "Qwen3_5ForConditionalGeneration",
                                               "defaultDtype": "float16", "maxPositionEmbeddings": 4096}}}
    assert cr._is_already_registered(catalog, "Qwen/Qwen3.5-4B") is False
    catalog["models"]["Qwen/Qwen3.5-4B*"]["parameterCount"] = 1
    assert cr._is_already_registered(catalog, "Qwen/Qwen3.5-4B") is True


def test_register_model_repairs_incomplete_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mlcc = tmp_path / ".mlcc"
    mlcc.mkdir()
    (mlcc / "model-sizes.json").write_text(json.dumps({
        "catalogVersion": "local",
        "models": {"Qwen/Qwen3.5-4B*": {"architecture": "Qwen3_5ForConditionalGeneration",
                                        "defaultDtype": "float16", "maxPositionEmbeddings": 4096}},
    }))
    monkeypatch.setattr(cr, "_fetch_config_from_hf", lambda *a, **k: QWEN35_CONFIG)
    monkeypatch.setattr(cr, "_fetch_hub_info", lambda *a, **k: QWEN35_HUB)

    assert cr.register_model("Qwen/Qwen3.5-4B", str(tmp_path), verbose=False) is True
    saved = json.loads((mlcc / "model-sizes.json").read_text())["models"]["Qwen/Qwen3.5-4B*"]
    assert saved["parameterCount"] == QWEN35_HUB["safetensors"]["total"]
    assert saved["parameterCountSource"] == "huggingface-safetensors-metadata"
    assert saved["maxPositionEmbeddings"] == QWEN35_CONFIG["text_config"]["max_position_embeddings"]


def test_register_model_skips_when_size_cannot_be_determined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cr, "_fetch_config_from_hf", lambda *a, **k: {"architectures": ["X"]})
    monkeypatch.setattr(cr, "_fetch_hub_info", lambda *a, **k: None)

    assert cr.register_model("some-org/opaque", str(tmp_path), verbose=True) is False
    assert not (tmp_path / ".mlcc" / "model-sizes.json").exists()
    assert "--instance-type" in capsys.readouterr().out
