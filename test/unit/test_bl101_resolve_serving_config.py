# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL101 tests: SERVING_* resolution via templates/do/lib/resolve-serving-config.sh.

Sources the library in a subshell with a controlled environment and reads back
the exported SERVING_* variables. Covers realtime + hyperpod chains, the
normalized-token invariant, idempotency, and model-name de-S3'ing.
"""

import os
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RESOLVER = PROJECT_ROOT / "templates" / "do" / "lib" / "resolve-serving-config.sh"

_SERVING_VARS = [
    "SERVING_MODEL_NAME", "SERVING_INSTANCE_TYPE", "SERVING_QUANTIZATION",
    "SERVING_TENSOR_PARALLEL", "SERVING_MAX_MODEL_LEN", "SERVING_KV_CACHE_DTYPE",
    "SERVING_DEPLOYMENT_TARGET",
]


def _resolve(env_vars: dict, source_twice: bool = False) -> dict:
    """Source the resolver with env_vars set; return the SERVING_* values."""
    src = f'source "{RESOLVER}"\n'
    if source_twice:
        src += f'source "{RESOLVER}"\n'
    emit = "\n".join(f'echo "{v}=${{{v}}}"' for v in _SERVING_VARS)
    script = "set -u\n" + src + emit + "\n"

    env = {k: "" for k in (
        "HF_MODEL_ID", "MODEL_NAME", "DEPLOYMENT_TARGET", "IC_ENV_VLLM_QUANTIZATION",
        "IC_ENV_VLLM_TENSOR_PARALLEL_SIZE", "IC_ENV_VLLM_MAX_MODEL_LEN",
        "IC_ENV_VLLM_KV_CACHE_DTYPE", "DEPLOYED_INSTANCE_TYPE", "INSTANCE_TYPE",
        "VLLM_QUANTIZATION", "VLLM_TENSOR_PARALLEL_SIZE", "VLLM_MAX_MODEL_LEN",
        "VLLM_KV_CACHE_DTYPE", "BENCHMARK_INSTANCE_TYPE", "HP_INSTANCE_TYPE",
        "HP_GPU_COUNT",
    )}
    env["PATH"] = os.environ.get("PATH", "")
    env.update(env_vars)

    result = subprocess.run(
        ["bash", "-c", script], env=env, text=True, capture_output=True, check=True,
    )
    out = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            if k in _SERVING_VARS:
                out[k] = v
    return out


class TestRealtimeResolution:
    def test_ic_env_priority(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "meta-llama/Llama-3.1-8B-Instruct",
            "IC_ENV_VLLM_QUANTIZATION": "fp8",
            "IC_ENV_VLLM_TENSOR_PARALLEL_SIZE": "2",
            "DEPLOYED_INSTANCE_TYPE": "ml.g6.24xlarge",
        })
        assert r["SERVING_MODEL_NAME"] == "meta-llama/Llama-3.1-8B-Instruct"
        assert r["SERVING_INSTANCE_TYPE"] == "ml.g6.24xlarge"
        assert r["SERVING_QUANTIZATION"] == "fp8"
        assert r["SERVING_TENSOR_PARALLEL"] == "2"
        assert r["SERVING_DEPLOYMENT_TARGET"] == "realtime-inference"

    def test_empty_quant_normalizes_none(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "m",
            "DEPLOYED_INSTANCE_TYPE": "ml.g6.24xlarge",
        })
        assert r["SERVING_QUANTIZATION"] == "none"
        assert r["SERVING_TENSOR_PARALLEL"] == "1"
        assert r["SERVING_KV_CACHE_DTYPE"] == "auto"
        assert r["SERVING_MAX_MODEL_LEN"] == ""

    def test_deployed_instance_fallback_to_instance_type(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "m",
            "INSTANCE_TYPE": "ml.g5.12xlarge",
        })
        assert r["SERVING_INSTANCE_TYPE"] == "ml.g5.12xlarge"


class TestHyperpodResolution:
    def test_benchmark_instance_type_first(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "BENCHMARK_INSTANCE_TYPE": "ml.g6.12xlarge",
            "HP_INSTANCE_TYPE": "ml.g6.48xlarge",
        })
        assert r["SERVING_INSTANCE_TYPE"] == "ml.g6.12xlarge"

    def test_hp_instance_type_fallback(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "HP_INSTANCE_TYPE": "ml.g6.48xlarge",
        })
        assert r["SERVING_INSTANCE_TYPE"] == "ml.g6.48xlarge"

    def test_tp_from_hp_gpu_count(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "HP_GPU_COUNT": "4",
        })
        assert r["SERVING_TENSOR_PARALLEL"] == "4"

    def test_explicit_tp_overrides_gpu_count(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "VLLM_TENSOR_PARALLEL_SIZE": "8",
            "HP_GPU_COUNT": "4",
        })
        assert r["SERVING_TENSOR_PARALLEL"] == "8"

    def test_persisted_quantization(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "VLLM_QUANTIZATION": "fp8",
        })
        assert r["SERVING_QUANTIZATION"] == "fp8"


class TestModelNameDeS3:
    def test_de_s3_with_models_prefix(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "MODEL_NAME": "s3://mybucket/models/Qwen/Qwen3-4B/",
            "HP_GPU_COUNT": "1",
        })
        assert r["SERVING_MODEL_NAME"] == "Qwen/Qwen3-4B"

    def test_hf_model_id_preferred_over_model_name(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "meta-llama/Llama-3.1-8B",
            "MODEL_NAME": "s3://b/models/other/model/",
            "INSTANCE_TYPE": "ml.g6.24xlarge",
        })
        assert r["SERVING_MODEL_NAME"] == "meta-llama/Llama-3.1-8B"


class TestNormalizationAndIdempotency:
    def test_idempotent(self):
        env = {
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "BENCHMARK_INSTANCE_TYPE": "ml.g6.12xlarge",
            "HP_GPU_COUNT": "4",
        }
        once = _resolve(env, source_twice=False)
        twice = _resolve(env, source_twice=True)
        assert once == twice

    def test_non_numeric_tp_normalizes_to_1(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "hyperpod-eks",
            "HF_MODEL_ID": "m",
            "VLLM_TENSOR_PARALLEL_SIZE": "abc",
        })
        assert r["SERVING_TENSOR_PARALLEL"] == "1"

    def test_max_model_len_kept_when_positive(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "m",
            "INSTANCE_TYPE": "ml.g6.24xlarge",
            "IC_ENV_VLLM_MAX_MODEL_LEN": "8192",
        })
        assert r["SERVING_MAX_MODEL_LEN"] == "8192"

    def test_max_model_len_empty_when_zero(self):
        r = _resolve({
            "DEPLOYMENT_TARGET": "realtime-inference",
            "HF_MODEL_ID": "m",
            "INSTANCE_TYPE": "ml.g6.24xlarge",
            "IC_ENV_VLLM_MAX_MODEL_LEN": "0",
        })
        assert r["SERVING_MAX_MODEL_LEN"] == ""
