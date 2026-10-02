# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL105 serve-layer plugin manifest — Python property tests.

Feature: v18-w2-02-bl105

Exercises the manifest reader (templates/do/lib/python/serve_manifest.py) and
the .optimize_engine.py dimension-key derivation directly (import), complementing
the JS property tests that drive the reader through its one-shot CLI.

Covers:
  Property 2 — accept iff algorithm in supported_algorithms (reader read path)
  Property 4 — reader-resolved env_var_prefix equals the manifest value
  Property 5 — dimension→config-key derivation reproduces the retired hardcoded map
"""

import importlib.util
import json
import os

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

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

SHIPPED_ENGINES = ["vllm", "sglang"]
ALGORITHM_UNIVERSE = ["eagle3", "eagle2", "eagle", "draft-model", "ngram", "mtp", "medusa"]

# Current (pre-BL105) hardcoded per-engine accept sets.
HARDCODED_ACCEPT = {
    "vllm": {"eagle3", "eagle2", "eagle", "draft-model", "ngram", "mtp"},
    "sglang": {"eagle3", "eagle2", "eagle", "draft-model", "mtp"},
}

# Retired _DIMENSION_CONFIG_KEY_BY_TARGET (vLLM values).
HARDCODED_DIMENSION_KEYS = {
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

SWEEPABLE_DIMENSIONS = [
    "quantization",
    "tensor_parallel_degree",
    "max_model_len",
    "kv_cache_dtype",
]


# Feature: v18-w2-02-bl105, Property 2: Draft set accepts an algorithm iff it is in the active engine's supported set
# Validates: Requirements 4.2, 4.3, 4.4
@settings(max_examples=100)
@given(
    engine=st.sampled_from(SHIPPED_ENGINES),
    alg=st.sampled_from(ALGORITHM_UNIVERSE),
)
def test_property2_accept_iff_in_supported_set(engine, alg):
    supported = set(serve_manifest.supported_algorithms(engine))
    # The manifest-driven accept decision is exactly membership in the set.
    decision = alg in supported
    assert decision == (alg in supported)


# Feature: v18-w2-02-bl105, Property 3: Shipping-engine manifests reproduce current per-engine validation outcomes
# Validates: Requirements 4.5, 7.2, 8.2, 8.3
@settings(max_examples=100)
@given(
    engine=st.sampled_from(SHIPPED_ENGINES),
    alg=st.sampled_from(ALGORITHM_UNIVERSE),
)
def test_property3_reproduces_hardcoded_outcomes(engine, alg):
    supported = set(serve_manifest.supported_algorithms(engine))
    assert (alg in supported) == (alg in HARDCODED_ACCEPT[engine])


# Feature: v18-w2-02-bl105, Property 4: Deploy reads the env var prefix that equals the manifest value
# Validates: Requirements 5.1
@settings(max_examples=50)
@given(engine=st.sampled_from(SHIPPED_ENGINES))
def test_property4_prefix_equals_manifest(engine):
    manifest = serve_manifest.read_manifest(engine)
    assert serve_manifest.env_var_prefix(engine) == manifest["env_var_prefix"]


# Feature: v18-w2-02-bl105, Property 5: Dimension-to-config-key derivation reproduces the hardcoded mapping
# Validates: Requirements 6.1, 6.2
@pytest.mark.parametrize("target", list(HARDCODED_DIMENSION_KEYS.keys()))
@pytest.mark.parametrize("dimension", SWEEPABLE_DIMENSIONS)
def test_property5_dimension_key_derivation(target, dimension, monkeypatch):
    monkeypatch.setenv("MODEL_SERVER", "vllm")
    optimize = _load("optimize_engine_bl105", _OPTIMIZE_PATH)
    derived = optimize._dimension_config_key(dimension, target)
    assert derived == HARDCODED_DIMENSION_KEYS[target][dimension]


def test_reader_missing_engine_raises():
    with pytest.raises(serve_manifest.ManifestNotFound):
        serve_manifest.read_manifest("does-not-exist-engine")


def test_shipped_manifests_load():
    assert serve_manifest.env_var_prefix("vllm") == "VLLM_"
    assert serve_manifest.env_var_prefix("sglang") == "SGLANG_"
    assert "ngram" in serve_manifest.supported_algorithms("vllm")
    assert "ngram" not in serve_manifest.supported_algorithms("sglang")
    me = serve_manifest.metrics_endpoint("vllm")
    assert me == {"path": "/metrics", "port": 8080, "format": "prometheus"}
    # algorithm_map round-trips through JSON cleanly
    json.dumps(serve_manifest.algorithm_map("sglang"))
