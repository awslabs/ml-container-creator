# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL105 serve-layer plugin manifest — Python unit tests (pytest only, no extra deps).

Feature: v18-w2-02-bl105

Deterministic, dependency-light checks (runs in CI's test/unit pytest step) for:
  - the manifest reader (templates/do/lib/python/serve_manifest.py)
  - the .optimize_engine.py dimension->config-key derivation (Requirement 6)

The exhaustive property-based variants live in
test/property/test_bl105_serve_manifest_properties.py (Hypothesis).
"""

import importlib.util
import os

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_READER_PATH = os.path.join(
    _REPO_ROOT, "templates", "do", "lib", "python", "serve_manifest.py"
)
_OPTIMIZE_PATH = os.path.join(_REPO_ROOT, "templates", "do", ".optimize_engine.py")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


serve_manifest = _load("serve_manifest", _READER_PATH)


# -- Reader (Requirements 2, 4, 7, 8) -----------------------------------------

def test_vllm_manifest_fields():
    assert serve_manifest.env_var_prefix("vllm") == "VLLM_"
    assert serve_manifest.supported_algorithms("vllm") == [
        "eagle3", "eagle2", "eagle", "draft-model", "ngram", "mtp"
    ]
    assert serve_manifest.metrics_endpoint("vllm") == {
        "path": "/metrics", "port": 8080, "format": "prometheus"
    }
    assert serve_manifest.algorithm_map("vllm")["draft-model"] == "draft_model"


def test_sglang_manifest_fields():
    assert serve_manifest.env_var_prefix("sglang") == "SGLANG_"
    assert serve_manifest.supported_algorithms("sglang") == [
        "eagle3", "eagle2", "eagle", "draft-model", "mtp"
    ]
    assert "ngram" not in serve_manifest.supported_algorithms("sglang")
    amap = serve_manifest.algorithm_map("sglang")
    assert amap["eagle2"] == "EAGLE"
    assert amap["draft-model"] == "STANDALONE"


def test_missing_engine_raises():
    with pytest.raises(serve_manifest.ManifestNotFound):
        serve_manifest.read_manifest("no-such-engine")


# -- Optimize derivation (Requirement 6, Property 5) --------------------------

_HARDCODED_DIMENSION_KEYS = {
    "realtime-inference": {
        "quantization": "IC_ENV_VLLM_QUANTIZATION",
        "tensor_parallel_degree": "IC_ENV_VLLM_TENSOR_PARALLEL_SIZE",
        "max_model_len": "IC_ENV_VLLM_MAX_MODEL_LEN",
        "kv_cache_dtype": "IC_ENV_VLLM_KV_CACHE_DTYPE",
    },
    "hyperpod-eks": {
        "quantization": "VLLM_QUANTIZATION",
        "tensor_parallel_degree": "VLLM_TENSOR_PARALLEL_SIZE",
        "max_model_len": "VLLM_MAX_MODEL_LEN",
        "kv_cache_dtype": "VLLM_KV_CACHE_DTYPE",
    },
    "async-inference": {
        "quantization": "VLLM_QUANTIZATION",
        "tensor_parallel_degree": "VLLM_TENSOR_PARALLEL_SIZE",
        "max_model_len": "VLLM_MAX_MODEL_LEN",
        "kv_cache_dtype": "VLLM_KV_CACHE_DTYPE",
    },
}


@pytest.mark.parametrize("target", list(_HARDCODED_DIMENSION_KEYS.keys()))
@pytest.mark.parametrize(
    "dimension",
    ["quantization", "tensor_parallel_degree", "max_model_len", "kv_cache_dtype"],
)
def test_dimension_key_derivation_matches_retired_dict(target, dimension, monkeypatch):
    monkeypatch.setenv("MODEL_SERVER", "vllm")
    optimize = _load("optimize_engine_bl105_unit", _OPTIMIZE_PATH)
    derived = optimize._dimension_config_key(dimension, target)
    assert derived == _HARDCODED_DIMENSION_KEYS[target][dimension]


def test_dimension_key_derivation_sglang(monkeypatch):
    monkeypatch.setenv("MODEL_SERVER", "sglang")
    optimize = _load("optimize_engine_bl105_unit_sglang", _OPTIMIZE_PATH)
    # SGLang derives from its own manifest (SGLANG_ prefix + SGLang suffixes).
    assert optimize._dimension_config_key("tensor_parallel_degree", "hyperpod-eks") == "SGLANG_TP_SIZE"
    assert optimize._dimension_config_key("quantization", "realtime-inference") == "IC_ENV_SGLANG_QUANTIZATION"
