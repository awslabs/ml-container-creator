# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Plain-EKS local-AIPerf driver — Python unit tests (pytest only, no extra deps).

Deterministic checks for templates/do/lib/python/eks_aiperf.py — the derivations
that must not be hardcoded (ADR-008): served-model, the manifest-derived serving
port, the `aiperf profile` argv (SageMaker workload-spec → flag map), synthetic vs
BYOD mutual exclusion, and the artifact relocation.
"""

import importlib.util
import os

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DRIVER_PATH = os.path.join(
    _REPO_ROOT, "templates", "do", "lib", "python", "eks_aiperf.py"
)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


eks_aiperf = _load("eks_aiperf", _DRIVER_PATH)


# -- served-model derivation (mirror the stub's _EKS_MODEL) --------------------

def test_served_model_s3_source_is_opt_ml_model(monkeypatch):
    monkeypatch.setenv("MODEL_NAME", "s3://bucket/model/")
    assert eks_aiperf.derive_served_model() == "/opt/ml/model"


def test_served_model_staged_path_is_opt_ml_model(monkeypatch):
    monkeypatch.setenv("MODEL_NAME", "/opt/ml/model")
    assert eks_aiperf.derive_served_model() == "/opt/ml/model"


def test_served_model_hf_source_is_model_name(monkeypatch):
    monkeypatch.setenv("MODEL_NAME", "meta-llama/Llama-3.1-8B-Instruct")
    assert eks_aiperf.derive_served_model() == "meta-llama/Llama-3.1-8B-Instruct"


# -- serving-port is DERIVED from the engine manifest (R4) ---------------------

def test_serving_port_derived_from_vllm_manifest():
    # vllm declares metrics_endpoint.port=8080; the driver reads it, not a literal.
    assert eks_aiperf.derive_serving_port("vllm") == 8080


def test_serving_port_falls_back_when_engine_unknown():
    # An engine with no manifest/port falls back to the historical default so a
    # probe still works — but never raises.
    assert eks_aiperf.derive_serving_port("no-such-engine") == eks_aiperf.DEFAULT_SERVING_PORT


# -- aiperf profile flag map (design.md "CLI mapping") -------------------------

def _build(monkeypatch, env, local_port=18080, artifact_dir="/tmp/art"):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return eks_aiperf.build_command(local_port, artifact_dir)


def test_build_command_synthetic_maps_workload_spec(monkeypatch):
    cmd = _build(monkeypatch, {
        "MODEL_NAME": "s3://b/m/",
        "HF_MODEL_ID": "Qwen/Qwen3-0.6B",
        "BENCHMARK_CONCURRENCY": "4",
        "BENCHMARK_REQUEST_COUNT": "50",
        "BENCHMARK_STREAMING": "true",
        "BENCHMARK_INPUT_TOKENS_MEAN": "100",
        "BENCHMARK_OUTPUT_TOKENS_MEAN": "200",
        "VLLM_TRUST_REMOTE_CODE": "true",
        "BENCHMARK_DATASET_LOCAL_FILE": "",
    })
    assert cmd[:2] == ["aiperf", "profile"]
    assert "--url" in cmd and "localhost:18080" in cmd
    assert cmd[cmd.index("--endpoint-type") + 1] == "chat"
    assert cmd[cmd.index("--endpoint") + 1] == "/v1/chat/completions"
    assert cmd[cmd.index("--model") + 1] == "/opt/ml/model"
    assert cmd[cmd.index("--tokenizer") + 1] == "Qwen/Qwen3-0.6B"
    assert "--tokenizer-trust-remote-code" in cmd
    assert "--streaming" in cmd
    assert cmd[cmd.index("--synthetic-input-tokens-mean") + 1] == "100"
    assert cmd[cmd.index("--output-tokens-mean") + 1] == "200"
    assert cmd[cmd.index("--concurrency") + 1] == "4"
    assert cmd[cmd.index("--request-count") + 1] == "50"
    assert cmd[cmd.index("--artifact-directory") + 1] == "/tmp/art"


def test_build_command_byod_excludes_synthetic_means(monkeypatch):
    cmd = _build(monkeypatch, {
        "MODEL_NAME": "s3://b/m/",
        "HF_MODEL_ID": "Qwen/Qwen3-0.6B",
        "BENCHMARK_CONCURRENCY": "8",
        "BENCHMARK_STREAMING": "false",
        "BENCHMARK_DATASET_LOCAL_FILE": "/tmp/ds.jsonl",
    })
    assert "--input-file" in cmd
    assert cmd[cmd.index("--input-file") + 1] == "/tmp/ds.jsonl"
    assert cmd[cmd.index("--custom-dataset-type") + 1] == "single_turn"
    # Mutually exclusive: synthetic means + streaming off are both absent.
    assert "--synthetic-input-tokens-mean" not in cmd
    assert "--output-tokens-mean" not in cmd
    assert "--streaming" not in cmd


def test_build_command_omits_trust_remote_code_when_false(monkeypatch):
    cmd = _build(monkeypatch, {
        "MODEL_NAME": "Qwen/Qwen3-0.6B",
        "HF_MODEL_ID": "Qwen/Qwen3-0.6B",
        "VLLM_TRUST_REMOTE_CODE": "false",
        "BENCHMARK_STREAMING": "false",
        "BENCHMARK_DATASET_LOCAL_FILE": "",
    })
    assert "--tokenizer-trust-remote-code" not in cmd
    # HF source (not s3) → served under its own name.
    assert cmd[cmd.index("--model") + 1] == "Qwen/Qwen3-0.6B"


# -- artifact relocation (R2) --------------------------------------------------

def test_relocate_moves_jsonl_to_dest(tmp_path):
    art = tmp_path / "aiperf"
    run = art / "run-xyz"
    run.mkdir(parents=True)
    (run / "profile_export.jsonl").write_text('{"metadata":{},"metrics":{}}\n')
    dest = tmp_path / "output" / "profile_export.jsonl"
    out = eks_aiperf.relocate_profile_export(str(art), str(dest))
    assert out == str(dest)
    assert dest.exists()
    # No aggregate export produced -> nothing invented next to the JSONL.
    assert not (dest.parent / "profile_export_aiperf.json").exists()


def test_relocate_keeps_the_aiperf_aggregate_next_to_the_jsonl(tmp_path):
    # Wave 9 R10.3 (BL128): the writer reads the sibling profile_export_aiperf.json.
    art = tmp_path / "aiperf"
    run = art / "run-xyz"
    run.mkdir(parents=True)
    (run / "profile_export.jsonl").write_text('{"metadata":{},"metrics":{}}\n')
    (run / "profile_export_aiperf.json").write_text('{"aiperf_version": "x"}')
    dest = tmp_path / "output" / "profile_export.jsonl"
    eks_aiperf.relocate_profile_export(str(art), str(dest))
    kept = dest.parent / "profile_export_aiperf.json"
    assert kept.exists() and kept.read_text() == '{"aiperf_version": "x"}'


def test_relocate_raises_when_missing(tmp_path):
    art = tmp_path / "aiperf"
    art.mkdir()
    with pytest.raises(FileNotFoundError):
        eks_aiperf.relocate_profile_export(str(art), str(tmp_path / "o.jsonl"))
