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
    # _PROFILE_provisionedModules is a comma-separated list emitted by profile.sh
    [[ ",${_PROFILE_provisionedModules:-}," == *",training,"* ]] && return 0
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

# ---------------------------------------------------------------------------
# _require_python_env — ensure Python runs inside a virtual environment.
#
# Resolution order:
#   1. Already in a venv ($VIRTUAL_ENV is set and python3 is inside it)
#   2. Project-local .mlcc/hey-venv (created by `mcc hey init`)
#   3. Exit 1 with a clear setup message
#
# Usage: call once near the top of any do/ script that invokes python3.
#   source "${SCRIPT_DIR}/lib/script-contract.sh"
#   _require_python_env
# ---------------------------------------------------------------------------
_require_python_env() {
    local _script_dir
    _script_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd)"
    local _project_root="${_script_dir%/do}"
    local _venv_path="${_project_root}/.mlcc/hey-venv"

    # 1. Already inside a venv
    if [ -n "${VIRTUAL_ENV:-}" ] && python3 -c "import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)" 2>/dev/null; then
        return 0
    fi

    # 2. Project-local venv exists — activate it
    if [ -f "${_venv_path}/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "${_venv_path}/bin/activate"
        echo "   🐍 Using project venv: ${_venv_path}" >&2
        return 0
    fi

    # 3. No venv — exit with guidance
    echo "" >&2
    echo "❌ Python virtual environment required" >&2
    echo "" >&2
    echo "   This command uses Python packages (questionary, boto3, etc.)" >&2
    echo "   that must be installed in a virtual environment." >&2
    echo "" >&2
    echo "   Quick setup:" >&2
    echo "     mcc hey init           # creates .mlcc/hey-venv with all deps" >&2
    echo "" >&2
    echo "   Or activate your own venv first:" >&2
    echo "     source /path/to/venv/bin/activate" >&2
    echo "     ./do/$(basename "${BASH_SOURCE[1]:-$0}")" >&2
    echo "" >&2
    exit 1
}

# Source config and profile to load guard-relevant variables (DEPLOYMENT_TARGET,
# status vars, _PROFILE_provisionedModules, etc.) before enforcement.
# Temporarily disable nounset (-u) since older generated configs may reference
# unset variables without :- guards (e.g., pre-v1.5 HyperPod vars).
_MLCC_SCRIPT_DIR="$(cd "$(dirname "$_MLCC_SCRIPT_PATH")" && pwd)"
if [ -f "${_MLCC_SCRIPT_DIR}/config" ]; then
    set +u 2>/dev/null || true
    source "${_MLCC_SCRIPT_DIR}/config" 2>/dev/null || true
    if [ -f "${_MLCC_SCRIPT_DIR}/lib/profile.sh" ]; then
        source "${_MLCC_SCRIPT_DIR}/lib/profile.sh" 2>/dev/null || true
    fi
    set -u 2>/dev/null || true
fi

# Auto-enforce declared guard
if [ -n "$_MLCC_GUARD" ] && [ "$_MLCC_GUARD" != "none" ]; then
    _require_guard "$_MLCC_GUARD"
fi
