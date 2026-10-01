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
        "eagle3", "eagle2", "eagle", "draft-model", "ngram", "mtp", "dspark"
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


def test_dimension_key_derivation_lmi(monkeypatch):
    monkeypatch.setenv("MODEL_SERVER", "lmi")
    optimize = _load("optimize_engine_bl105_unit_lmi", _OPTIMIZE_PATH)
    # LMI derives from its own manifest. Its env_var_prefix is OPTION_ (what the
    # DJL container actually reads), and its dimension_map carries the real DJL
    # option suffixes — so the composed keys are OPTION_TENSOR_PARALLEL_DEGREE,
    # OPTION_QUANTIZE, OPTION_MAX_MODEL_LEN (realtime wraps them with IC_ENV_).
    assert optimize._dimension_config_key("tensor_parallel_degree", "hyperpod-eks") == "OPTION_TENSOR_PARALLEL_DEGREE"
    assert optimize._dimension_config_key("quantization", "realtime-inference") == "IC_ENV_OPTION_QUANTIZE"
    assert optimize._dimension_config_key("max_model_len", "hyperpod-eks") == "OPTION_MAX_MODEL_LEN"


# -- engine_features: engine-specific capabilities (ADR-004 §c) ----------------
# These are capabilities UNIQUE to one engine or implemented differently from
# vLLM, declared as data and read generically (no engine-name branching).

def test_engine_features_sglang_radix_attention():
    # SGLang's RadixAttention — vLLM has block-level prefix caching, not this.
    f = serve_manifest.engine_feature("sglang", "radix_attention")
    assert f is not None, "sglang must declare radix_attention"
    assert f["type"] == "boolean"
    assert f["env_var"] == "SGLANG_ENABLE_RADIX_CACHE"


def test_engine_features_lmi_rolling_batch_backend():
    # LMI's pluggable backend — vLLM/SGLang are single engines, no equivalent.
    f = serve_manifest.engine_feature("lmi", "rolling_batch_backend")
    assert f is not None, "lmi must declare rolling_batch_backend"
    assert f["type"] == "enum"
    assert f["env_var"] == "OPTION_ROLLING_BATCH"
    assert f["default"] in f["values"], "default must be one of the allowed values"


def test_engine_features_vllm_declares_none():
    # The deviation: vLLM declares no engine_features — the SGLang/LMI features
    # above are genuinely engine-specific, not shared capabilities.
    assert serve_manifest.engine_features("vllm") == {}
    assert serve_manifest.engine_feature("vllm", "radix_attention") is None


# -- BL129: capability versioning ---------------------------------------------
# Data-driven: assertions derive from vLLM's own manifest version_features so
# they track the shipped gating rather than pinning algorithm/version literals.

def _vllm_manifest():
    return serve_manifest.read_manifest("vllm")


def _cmp_ver(v):
    return tuple(int(x) for x in v.split("."))


def test_effective_algorithms_failopen_on_unknown_version():
    flat = serve_manifest.supported_algorithms("vllm")
    assert serve_manifest.effective_supported_algorithms("vllm", None) == flat
    assert serve_manifest.effective_supported_algorithms("vllm", "latest") == flat


def test_effective_algorithms_below_earliest_gate_excludes_it():
    features = _vllm_manifest().get("version_features", [])
    assert features, "vLLM manifest should declare version_features for this test"
    earliest = sorted(features, key=lambda f: _cmp_ver(f["since"]))[0]
    below = f"{_cmp_ver(earliest['since'])[0]}.0.0"
    eff = serve_manifest.effective_supported_algorithms("vllm", below)
    for alg in earliest["adds"].get("supported_algorithms", []):
        assert alg not in eff, f"{alg} (gated since {earliest['since']}) must be absent at {below}"


def test_effective_algorithms_at_latest_gate_equals_flat():
    features = _vllm_manifest().get("version_features", [])
    latest_since = sorted((f["since"] for f in features), key=_cmp_ver)[-1]
    eff = serve_manifest.effective_supported_algorithms("vllm", latest_since)
    assert sorted(eff) == sorted(serve_manifest.supported_algorithms("vllm"))


def test_effective_algorithms_datadriven_no_version_features():
    # Derive an ungated engine rather than pinning one: any engine whose manifest
    # declares no version_features must return its flat supported_algorithms at
    # every version. Pinning a specific engine here rots the moment that engine
    # gains a gate — which is exactly what happened when sglang adopted
    # version_features, so we discover an ungated engine from serve.d instead.
    import glob
    import json

    serve_d = os.path.join(_REPO_ROOT, "templates", "code", "serve.d")
    ungated = None
    for manifest_path in sorted(glob.glob(os.path.join(serve_d, "*", "manifest.json"))):
        with open(manifest_path, encoding="utf-8") as fh:
            m = json.load(fh)
        if not m.get("version_features"):
            ungated = m
            break

    if ungated is None:
        pytest.skip("every serve engine is version-gated; no ungated engine to assert")

    engine = ungated["engine"]
    assert serve_manifest.effective_supported_algorithms(engine, "0.0.1") == \
        serve_manifest.supported_algorithms(engine), \
        f"{engine} declares no version_features → effective must equal flat at any version"


def test_is_version_supported_failopen():
    assert serve_manifest.is_version_supported("vllm", None) is True
    assert serve_manifest.is_version_supported("vllm", "latest") is True


def test_is_version_supported_respects_min_version():
    mv = serve_manifest.min_version("vllm")
    if not mv:
        pytest.skip("vLLM declares no min_version")
    maj, minor, _ = _cmp_ver(mv)
    if minor > 0:
        assert serve_manifest.is_version_supported("vllm", f"{maj}.{minor - 1}.0") is False
    assert serve_manifest.is_version_supported("vllm", mv) is True


def test_engine_version_from_base_image_tag_parse():
    # Not-in-catalog image → tag parse.
    assert serve_manifest.engine_version_from_base_image(
        "vllm", "my-registry/custom-vllm:v0.8.5-cu128") == "0.8.5"


def test_engine_version_from_base_image_unparseable_returns_none():
    assert serve_manifest.engine_version_from_base_image(
        "vllm", "vllm/vllm-openai:latest") is None
    assert serve_manifest.engine_version_from_base_image("vllm", "") is None



# -- BL129: CLI contract (what do/draft + hyperpod-eks invoke verbatim) --------
# do/draft and do/deploy.d/hyperpod-eks shell out to these exact CLI operations,
# so pin the CLI I/O contract (stdout shape + exit codes), not just the library.

import json as _json
import subprocess as _subprocess
import sys as _sys


def _run_cli(*args):
    return _subprocess.run(
        [_sys.executable, _READER_PATH, *args],
        capture_output=True, text=True,
    )


def test_cli_engine_version_tag_parse():
    r = _run_cli("engine_version", "vllm", "my-registry/custom-vllm:v0.8.5-cu128")
    assert r.returncode == 0
    assert r.stdout.strip() == "0.8.5"


def test_cli_engine_version_unresolvable_prints_empty():
    r = _run_cli("engine_version", "vllm", "vllm/vllm-openai:latest")
    assert r.returncode == 0
    assert r.stdout.strip() == ""


def test_cli_effective_supported_algorithms_gates_by_version():
    features = _vllm_manifest().get("version_features", [])
    earliest = sorted(features, key=lambda f: _cmp_ver(f["since"]))[0]
    below = f"{_cmp_ver(earliest['since'])[0]}.0.0"
    r = _run_cli("effective_supported_algorithms", "vllm", below)
    assert r.returncode == 0
    eff = _json.loads(r.stdout)
    for alg in earliest["adds"].get("supported_algorithms", []):
        assert alg not in eff


def test_cli_effective_supported_algorithms_failopen_no_version():
    # No version arg → full flat list (the fail-open path do/draft relies on).
    r = _run_cli("effective_supported_algorithms", "vllm")
    assert r.returncode == 0
    assert _json.loads(r.stdout) == serve_manifest.supported_algorithms("vllm")