#!/usr/bin/env bash
# script-contract.sh — Guard enforcement library for do/ scripts.
# Source this file as the first `source` statement in any do/ script.
#
# The library reads the calling script's @mlcc-script header and enforces
# the declared guard automatically. No explicit guard call needed.
#
# Provides:
#   _guard_none             — no-op (always passes)
#   _guard_artifact_ready   — checks ECR_IMAGE_URI is set
#   _guard_model_staged     — checks STAGED_MODEL_PATH is set
#   _guard_deployment_active — checks DEPLOYMENT_TARGET_*_STATUS == InService
#   _guard_training_infra   — checks _PROFILE_trainingInfraProvisioned == true
#   _contract_violation     — structured error + exit 3
#   _require_guard          — public API for inline flag escalation
#   _guard_met              — non-enforcing predicate query
#
# Exit codes:
#   3 = contract violation (guard not met)
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# ── Guard predicate functions ──────────────────────────────────────────────

_guard_none() { return 0; }

_guard_artifact_ready() {
    # Checks ECR image URI is resolvable for this project
    [ -n "${ECR_IMAGE_URI:-}" ] && return 0
    _contract_violation "artifact-ready" \
        "Container image has not been built and pushed." \
        "Run: do/build && do/push"
}

_guard_model_staged() {
    # Checks model weights are staged to S3
    [ -n "${STAGED_MODEL_PATH:-}" ] && return 0
    _contract_violation "model-staged" \
        "Model weights have not been staged to S3." \
        "Run: do/stage"
}

_guard_deployment_active() {
    # Checks DEPLOYMENT_TARGET_*_STATUS is a valid active state for the target
    local target="${DEPLOYMENT_TARGET:-realtime-inference}"
    local status_var
    case "$target" in
        realtime-inference|managed-inference) status_var="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        hyperpod-eks)   status_var="DEPLOYMENT_TARGET_HP_STATUS" ;;
        async-inference) status_var="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform) status_var="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        *) status_var="" ;;
    esac
    if [ -n "$status_var" ]; then
        local _status="${!status_var:-}"
        # Each target writes a different success status:
        #   realtime-inference/async-inference → InService
        #   hyperpod-eks → Running
        #   batch-transform → Completed
        case "$_status" in
            InService|Running|Completed) return 0 ;;
        esac
    fi
    _contract_violation "deployment-active" \
        "No active deployment found for target: ${target}" \
        "Run: do/deploy --target ${target}"
}

_guard_training_infra() {
    # Checks training bootstrap module is provisioned
    [ "${_PROFILE_trainingInfraProvisioned:-}" = "true" ] && return 0
    _contract_violation "training-infra" \
        "Training infrastructure is not provisioned." \
        "Run: mcc bootstrap add-module training"
}

# ── Contract violation output ──────────────────────────────────────────────

_contract_violation() {
    local guard="$1" reason="$2" remedy="$3"
    echo "❌ Contract violation: ${guard}"
    echo "   ${reason}"
    echo "   → ${remedy}"
    exit 3
}

# ── Public API ─────────────────────────────────────────────────────────────

# Called by flag-handling code to escalate requirements at parse time
_require_guard() {
    local guard="$1"
    "_guard_${guard//-/_}"
}

# Query without enforcement (for conditional logic)
_guard_met() {
    local guard="$1"
    ( "_guard_${guard//-/_}" ) >/dev/null 2>&1 && return 0 || return 1
}

# ── Auto-enforcement on source ─────────────────────────────────────────────

_MLCC_SCRIPT_PATH="${BASH_SOURCE[1]:-}"
_MLCC_GUARD=$(grep -m1 '^# guard:' "$_MLCC_SCRIPT_PATH" 2>/dev/null | sed 's/# guard: *//')
_MLCC_TYPE=$(grep -m1 '^# type:' "$_MLCC_SCRIPT_PATH" 2>/dev/null | sed 's/# type: *//')

# Source config to load guard-relevant variables (DEPLOYMENT_TARGET, status vars, etc.)
# before enforcement. This is safe to re-source since config only exports variables.
# Temporarily disable nounset (-u) since older generated configs may reference
# unset variables without :- guards (e.g., pre-v1.5 HyperPod vars).
_MLCC_SCRIPT_DIR="$(cd "$(dirname "$_MLCC_SCRIPT_PATH")" && pwd)"
if [ -f "${_MLCC_SCRIPT_DIR}/config" ]; then
    set +u 2>/dev/null || true
    source "${_MLCC_SCRIPT_DIR}/config" 2>/dev/null || true
    set -u 2>/dev/null || true
fi

# Auto-enforce declared guard
if [ -n "$_MLCC_GUARD" ] && [ "$_MLCC_GUARD" != "none" ]; then
    _require_guard "$_MLCC_GUARD"
fi
