#!/usr/bin/env bash
# resolve-serving-config.sh — Canonical Serving_Config_Key resolver (BL101).
#
# Source this file (do NOT execute it) after do/config in any do/ script that
# needs the serving config dimensions used for benchmark write/query matching.
# It exports a single, target-aware set of SERVING_* variables so the write
# path (deploy/benchmark persistence) and the query path (--compare-baseline,
# --peak, --list) resolve the IDENTICAL Serving_Config_Key.
#
# Exports (all always set after sourcing — never unset, never exits):
#   SERVING_MODEL_NAME        HF model ID (prefers HF_MODEL_ID; de-S3s MODEL_NAME)
#   SERVING_INSTANCE_TYPE     Real inference GPU instance (never the ml.m5.large placeholder)
#   SERVING_QUANTIZATION      Quantization scheme, or the literal token `none`
#   SERVING_TENSOR_PARALLEL   Tensor-parallel degree as an integer (default 1)
#   SERVING_MAX_MODEL_LEN     Max context length, or empty when genuinely unset
#   SERVING_KV_CACHE_DTYPE    KV cache dtype, or the literal token `auto`
#   SERVING_DEPLOYMENT_TARGET Active deployment target
#
# Normalization is the crux: empty quantization → `none`, empty TP → `1`,
# empty kv dtype → `auto`. The SAME normalized tokens are persisted by the
# HyperPod deploy step (R2) and filtered by the query path, so equality-based
# baseline matching succeeds.
#
# Idempotent: re-sourcing with identical inputs produces identical values.
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# ── Helper: strip an s3:// URI down to a bare model id ────────────────────────
# MODEL_NAME may be an S3 path (e.g. s3://bucket/models/Qwen/Qwen3-4B/). The
# Serving_Config_Key wants the HF-style model id, so drop the scheme + bucket
# and any trailing slash. Non-S3 values pass through unchanged.
_serving_de_s3() {
    local _v="${1:-}"
    case "${_v}" in
        s3://*)
            _v="${_v#s3://}"        # drop scheme
            _v="${_v#*/}"           # drop bucket segment
            _v="${_v%/}"            # drop trailing slash
            # If a conventional models/ prefix is present, drop it too.
            _v="${_v#models/}"
            ;;
    esac
    printf '%s' "${_v}"
}

# ── Model name ────────────────────────────────────────────────────────────────
# Prefer HF_MODEL_ID (the canonical HF id); fall back to a de-S3'd MODEL_NAME.
if [ -n "${HF_MODEL_ID:-}" ]; then
    SERVING_MODEL_NAME="${HF_MODEL_ID}"
else
    SERVING_MODEL_NAME="$(_serving_de_s3 "${MODEL_NAME:-}")"
fi

# ── Deployment target ─────────────────────────────────────────────────────────
SERVING_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET:-realtime-inference}"

# ── Per-target resolution chains (first non-empty wins) ───────────────────────
case "${SERVING_DEPLOYMENT_TARGET}" in
    hyperpod-eks)
        # Instance: persisted BENCHMARK_INSTANCE_TYPE (most reliable for the
        # query path) → deploy-time GPU worker node.
        SERVING_INSTANCE_TYPE="${BENCHMARK_INSTANCE_TYPE:-${HP_INSTANCE_TYPE:-}}"
        # Quantization: VLLM_QUANTIZATION persisted by the R2 deploy step.
        SERVING_QUANTIZATION="${VLLM_QUANTIZATION:-}"
        # Tensor parallel: explicit VLLM_TENSOR_PARALLEL_SIZE, else HP_GPU_COUNT.
        SERVING_TENSOR_PARALLEL="${VLLM_TENSOR_PARALLEL_SIZE:-${HP_GPU_COUNT:-}}"
        # Context / kv dtype: prefer IC_ENV_* (rendered), else direct vars.
        SERVING_MAX_MODEL_LEN="${IC_ENV_VLLM_MAX_MODEL_LEN:-${VLLM_MAX_MODEL_LEN:-}}"
        SERVING_KV_CACHE_DTYPE="${IC_ENV_VLLM_KV_CACHE_DTYPE:-${VLLM_KV_CACHE_DTYPE:-}}"
        ;;
    *)
        # realtime-inference / async-inference / batch-transform:
        # IC_ENV_VLLM_* (from do/ic/*.conf) → DEPLOYED/INSTANCE_TYPE → direct vars.
        SERVING_INSTANCE_TYPE="${DEPLOYED_INSTANCE_TYPE:-${INSTANCE_TYPE:-}}"
        SERVING_QUANTIZATION="${IC_ENV_VLLM_QUANTIZATION:-${VLLM_QUANTIZATION:-}}"
        SERVING_TENSOR_PARALLEL="${IC_ENV_VLLM_TENSOR_PARALLEL_SIZE:-${VLLM_TENSOR_PARALLEL_SIZE:-}}"
        SERVING_MAX_MODEL_LEN="${IC_ENV_VLLM_MAX_MODEL_LEN:-${VLLM_MAX_MODEL_LEN:-}}"
        SERVING_KV_CACHE_DTYPE="${IC_ENV_VLLM_KV_CACHE_DTYPE:-${VLLM_KV_CACHE_DTYPE:-}}"
        ;;
esac

# ── Normalization (write==query invariant) ────────────────────────────────────
# Empty quantization MUST become the literal `none` so `quantization = 'none'`
# equality matches in Athena (never empty).
[ -z "${SERVING_QUANTIZATION}" ] && SERVING_QUANTIZATION="none"
# Tensor parallel is an integer; default 1 when unset or non-numeric.
case "${SERVING_TENSOR_PARALLEL}" in
    ''|*[!0-9]*) SERVING_TENSOR_PARALLEL="1" ;;
esac
# KV cache dtype defaults to `auto` (matches IC_ENV_VLLM_KV_CACHE_DTYPE:-auto).
[ -z "${SERVING_KV_CACHE_DTYPE}" ] && SERVING_KV_CACHE_DTYPE="auto"
# max_model_len: keep empty when genuinely unset; normalize non-positive/invalid
# to empty so the query-path conditional WHERE clause is skipped (migration-safe).
case "${SERVING_MAX_MODEL_LEN}" in
    ''|*[!0-9]*) SERVING_MAX_MODEL_LEN="" ;;
    0)           SERVING_MAX_MODEL_LEN="" ;;
esac
# instance type left as-is (may be empty when unresolved); model name as-is.
SERVING_INSTANCE_TYPE="${SERVING_INSTANCE_TYPE:-}"
SERVING_MODEL_NAME="${SERVING_MODEL_NAME:-}"

export SERVING_MODEL_NAME SERVING_INSTANCE_TYPE SERVING_QUANTIZATION \
    SERVING_TENSOR_PARALLEL SERVING_MAX_MODEL_LEN SERVING_KV_CACHE_DTYPE \
    SERVING_DEPLOYMENT_TARGET

unset -f _serving_de_s3
