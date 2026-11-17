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
#   _restrict_targets       — enforce a target allow-list (exit 3 on mismatch)
#   _guard_artifact_kind    — reusable additive-deploy artifact-kind gate (ADR-013)
#   _additive_accepts_kind  — the kinds an additive verb accepts (from the contract table)
#   _additive_mechanism_for — the load mechanism(s) a verb uses on a target (derived)
#   _additive_verb_supported_on — derived verb×target gate (exit 3 + honest guidance)
#   _resolve_additive_source — the shared --from-* source resolver (ADR-013 axis 1)
#   _additive_sniff_kind    — best-effort content sniff for unknown-kind artifacts
#   _deprecated_flag_alias  — the standard deprecated-flag notice
#
# Exit codes:
#   3 = contract violation (guard not met)
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Suppress Python 3.12+ SyntaxWarnings from inline -c strings (invalid escape sequences)
export PYTHONWARNINGS="${PYTHONWARNINGS:-ignore::SyntaxWarning}"

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
    # >>> GENERATED: target->status_var (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT
    case "$target" in
        realtime-inference|managed-inference|realtime) status_var="DEPLOYMENT_TARGET_SMAI_STATUS" ;;
        async-inference|async) status_var="DEPLOYMENT_TARGET_ASYNC_STATUS" ;;
        batch-transform|batch) status_var="DEPLOYMENT_TARGET_BATCH_STATUS" ;;
        hyperpod-eks|hyperpod) status_var="DEPLOYMENT_TARGET_HP_STATUS" ;;
        eks) status_var="DEPLOYMENT_TARGET_EKS_STATUS" ;;
        *) status_var="" ;;
    esac
    # <<< END GENERATED
    if [ -n "$status_var" ]; then
        local _status="${!status_var:-}"
        # Each target writes a different success status:
        #   realtime-inference/async-inference → InService
        #   hyperpod-eks / eks → Running
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

# Restrict a script to a set of deployment targets. Call near the top of any
# target-restricted script instead of hand-rolling an `if/case … exit 1` block,
# so every restriction speaks the one contract-violation format and exit code 3.
#
# Usage:
#   _restrict_targets "realtime-inference,hyperpod-eks" \
#       "Speculative decoding requires a real-time or HyperPod EKS deployment."
#
# Args:
#   $1 — comma-separated allow-list of supported DEPLOYMENT_TARGET values
#   $2 — (optional) extra guidance line appended to the violation message
_restrict_targets() {
    local allowed="$1" guidance="${2:-}"
    local target="${DEPLOYMENT_TARGET:-}"
    # Match the current target against the allow-list (comma-delimited, exact).
    case ",${allowed}," in
        *",${target},"*) return 0 ;;
    esac
    local script_name
    script_name="$(basename "${BASH_SOURCE[1]:-do/script}")"
    local reason="do/${script_name} is not supported on ${target:-<unset>}."
    if [ -n "$guidance" ]; then
        reason="${reason} ${guidance}"
    fi
    _contract_violation "target" \
        "$reason" \
        "Supported targets: ${allowed}. Switch with: do/deploy --target <target>"
}

# >>> ADDITIVE-DEPLOY CONTRACT (ADR-013) — the single source of truth.
#
# Additive deploy = putting an artifact onto an ALREADY-deployed endpoint/cluster
# (do/adapter, do/add-ic, do/add-pod). Three axes (ADR-013):
#   1. SOURCE   (--from-*)      → resolved uniformly by _resolve_additive_source
#   2. KIND     (artifact_kind) → selects which VERB is legal   (_additive_verb_kinds)
#   3. TARGET                   → selects only the load MECHANISM
#                                 (_additive_verb_mechanisms ∩ _additive_target_mechanisms)
#
# The legal verb×target matrix is NOT listed anywhere: it is DERIVED from the
# mechanism intersection (_additive_verb_supported_on). Adding a verb, kind,
# target, or mechanism is an arm in THIS block — never a per-script case arm.
#
# Representation: bash-3.2-safe lookup functions (case statements), NOT
# `declare -A`. script-contract.sh is sourced by every do/ script and those must
# run under macOS's default /bin/bash 3.2, which has no associative arrays (same
# constraint as do/tune's SET_KNOBS). do/add-pod (BL149, Wave 11) landed by
# uncommenting its arms: pod-apply on hyperpod-eks; eks stays deferred (F6).

# Every verb / target the contract knows (iteration order for the derivations).
_additive_verbs() {
    echo "adapter add-ic add-pod"
}
_additive_targets() {
    echo "realtime-inference hyperpod-eks eks"
}

# Per verb: which artifact kinds it accepts.
_additive_verb_kinds() {
    case "${1:-}" in
        adapter) echo "lora_adapter" ;;
        add-ic)  echo "full_model" ;;
        add-pod) echo "full_model" ;;   # BL149: a full model as its own IEC on the cluster
        *) echo "" ;;
    esac
}

# Per verb: which load mechanism(s) it drives.
_additive_verb_mechanisms() {
    case "${1:-}" in
        adapter) echo "vllm-hotload smai-ic" ;;   # vLLM hot-load (k8s) OR an SMAI adapter IC
        add-ic)  echo "smai-ic" ;;
        add-pod) echo "pod-apply" ;;
        *) echo "" ;;
    esac
}

# Per target: which load mechanisms the target exposes.
_additive_target_mechanisms() {
    case "${1:-}" in
        realtime-inference) echo "smai-ic" ;;
        hyperpod-eks)       echo "vllm-hotload pod-apply" ;;   # pod-apply: a second IEC (BL149)
        eks)                echo "vllm-hotload" ;;   # + pod-apply when plain-eks add-pod lands (F6, post-2.0)
        *) echo "" ;;
    esac
}

# Per verb: the canonical invocation shown in refusal guidance.
_additive_verb_usage() {
    case "${1:-}" in
        adapter) echo "do/adapter add <name> --from-tune (or --from-weights s3://...)" ;;
        add-ic)  echo "do/add-ic <name> --from-tune (or --from-weights s3://...)" ;;
        add-pod) echo "do/add-pod <name> --from-tune (or --from-weights s3://...)" ;;
        *) echo "do/${1:-}" ;;
    esac
}

# Per kind: the planned verb for a kind some target cannot serve yet. Drop the
# arm when that verb lands (its arms above get uncommented instead).
_additive_deferred_note() {
    case "${1:-}" in
        full_model) echo "do/add-pod on eks (post-2.0)" ;;
        *) echo "" ;;
    esac
}
# <<< END ADDITIVE-DEPLOY CONTRACT

# _additive_kind_guidance <kind> <target> — the refusal guidance for an artifact
# kind, DERIVED from the contract above (R8.2): the usage of every verb that
# serves the kind on the target, else the planned verb (_additive_deferred_note)
# plus where the kind IS servable today. Replaces the hand-written literals in the
# verb scripts so the text follows the tuple (ADR-013 R7 drift risk).
_additive_kind_guidance() {
    local _kind="$1" _target="${2:-}" _v _here="" _elsewhere="" _t _note
    for _v in $(_additive_verbs); do
        case " $(_additive_accepts_kind "${_v}") " in
            *" ${_kind} "*) ;;
            *) continue ;;
        esac
        if [ -n "$(_additive_mechanism_for "${_v}" "${_target}")" ]; then
            _here="${_here:+${_here}; or }$(_additive_verb_usage "${_v}")"
        else
            for _t in $(_additive_targets); do
                if [ -n "$(_additive_mechanism_for "${_v}" "${_t}")" ]; then
                    _elsewhere="${_elsewhere:+${_elsewhere}; }$(_additive_verb_usage "${_v}") on ${_t}"
                fi
            done
        fi
    done
    if [ -n "${_here}" ]; then
        echo "On ${_target}, a ${_kind} goes through ${_here}."
        return 0
    fi
    _note="$(_additive_deferred_note "${_kind}")"
    echo "A ${_kind} is not servable on ${_target:-<unset>} yet${_note:+ (planned: ${_note})}${_elsewhere:+; today: ${_elsewhere}}."
}

# _additive_accepts_kind <verb> — echo the artifact kind(s) the verb accepts.
# Feeds _guard_artifact_kind so no script passes a literal accepted kind.
_additive_accepts_kind() {
    _additive_verb_kinds "$1"
}

# _additive_mechanism_for <verb> <target> — echo the mechanism(s) the verb can use
# on the target (verb mechanisms ∩ target mechanisms). Empty ⇒ unsupported.
# Non-enforcing: use _additive_verb_supported_on to gate.
_additive_mechanism_for() {
    local _verb="$1" _target="${2:-}" _m _out=""
    local _target_mechs
    _target_mechs="$(_additive_target_mechanisms "${_target}")"
    for _m in $(_additive_verb_mechanisms "${_verb}"); do
        case " ${_target_mechs} " in
            *" ${_m} "*) _out="${_out:+${_out} }${_m}" ;;
        esac
    done
    echo "${_out}"
}

# _additive_verb_supported_on <verb> <target> — the DERIVED verb×target gate.
# Returns 0 when the verb's mechanisms intersect the target's. Otherwise emits an
# HONEST contract violation (exit 3) naming the targets this verb DOES run on and
# the verb(s) that serve this target instead — all computed from the contract
# block above, never a hardcoded arm. Prints nothing on success, so callers can
# invoke it directly (not in a command substitution, which would hide the message).
_additive_verb_supported_on() {
    local _verb="$1" _target="${2:-}"
    [ -n "$(_additive_mechanism_for "${_verb}" "${_target}")" ] && return 0
    local _kinds _t _v _k _ok_targets="" _alt=""
    _kinds="$(_additive_accepts_kind "${_verb}")"
    for _t in $(_additive_targets); do
        if [ -n "$(_additive_mechanism_for "${_verb}" "${_t}")" ]; then
            _ok_targets="${_ok_targets:+${_ok_targets},}${_t}"
        fi
    done
    # Is ANY verb able to serve this verb's kind(s) on this target?
    local _kind_served=""
    for _v in $(_additive_verbs); do
        [ -n "$(_additive_mechanism_for "${_v}" "${_target}")" ] || continue
        _alt="${_alt:+${_alt}; }a $(_additive_accepts_kind "${_v}") goes through $(_additive_verb_usage "${_v}")"
        for _k in ${_kinds}; do
            case " $(_additive_accepts_kind "${_v}") " in
                *" ${_k} "*) _kind_served="yes" ;;
            esac
        done
    done
    local _reason="do/${_verb} (accepts: ${_kinds:-nothing}) has no load mechanism on ${_target:-<unset>}."
    if [ -z "${_kind_served}" ] && [ -n "${_alt}" ]; then
        _reason="${_reason} '${_kinds}' artifacts are not servable on ${_target} yet (no additive verb exposes a mechanism for them there)"
        local _planned=""
        for _k in ${_kinds}; do
            [ -n "${_planned}" ] || _planned="$(_additive_deferred_note "${_k}")"
        done
        if [ -n "${_planned}" ]; then
            _reason="${_reason}; planned: ${_planned}."
        else
            _reason="${_reason}."
        fi
    fi
    if [ -n "${_alt}" ]; then
        _reason="${_reason} On ${_target}, ${_alt}."
    fi
    _contract_violation "target" \
        "${_reason}" \
        "Supported targets for do/${_verb}: ${_ok_targets:-none}. Switch with: do/deploy --target <target>"
}

# _deprecated_flag_alias <old-flag> <canonical-flag> — the ONE deprecation notice
# text for renamed additive-deploy flags (stderr, never stdout).
_deprecated_flag_alias() {
    echo "⚠️  $1 is deprecated; use $2 (will be removed in a future release)." >&2
}

# ---------------------------------------------------------------------------
# _guard_artifact_kind — the REUSABLE additive-deploy artifact-kind gate (ADR-013).
#
# Each additive-deploy verb (do/adapter, do/add-ic, future do/add-pod) accepts a
# set of artifact kinds and REFUSES the rest. This is the one shared gate so the
# contract is not re-implemented per script (ADR-013 / BL164): source resolves
# uniformly, artifact_kind selects the legal verb, target selects the mechanism.
#
# Usage:
#   _guard_artifact_kind "<resolved-kind>" "<accepted-kind>" "<alt-verb guidance>"
#   e.g. _guard_artifact_kind "$kind" "lora_adapter" \
#            "A full fine-tuned model is not a LoRA adapter — use do/add-ic / do/add-pod."
#
# Args:
#   $1 — the RESOLVED artifact_kind of the source (lora_adapter|full_model|"" unknown)
#   $2 — the kind this verb ACCEPTS (lora_adapter|full_model)
#   $3 — (optional) guidance pointing at the correct verb
#
# Behavior: returns 0 when the kinds match. When $1 is a non-empty mismatch,
# emits the standard contract violation (exit 3). When $1 is EMPTY (legacy
# artifact with no recorded artifact_kind), returns 0 with a warning — the caller
# falls back to its own content check (e.g. adapter_config.json presence) rather
# than hard-blocking a legitimate legacy artifact (BL164 R4 degrade).
# ---------------------------------------------------------------------------
_guard_artifact_kind() {
    local resolved="$1" accepted="$2" guidance="${3:-}"
    if [ -z "$resolved" ]; then
        echo "ℹ️  artifact_kind unknown for this source (legacy); falling back to a content check." >&2
        return 0
    fi
    # $2 may be a space-separated SET of kinds (as emitted by _additive_accepts_kind).
    case " ${accepted} " in
        *" ${resolved} "*) return 0 ;;
    esac
    local reason="This source is a '${resolved}', but this verb accepts '${accepted}'."
    if [ -n "$guidance" ]; then
        reason="${reason} ${guidance}"
    fi
    _contract_violation "artifact-kind" \
        "$reason" \
        "Register/resolve an artifact whose kind is '${accepted}', or use the verb for '${resolved}'."
}

# The do/ directory this library belongs to (lib/..), so the resolver can reach
# the EXISTING Python helpers (.register_helper.py) regardless of the caller's cwd.
_MLCC_CONTRACT_DO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"

# _additive_kind_from_output_type <type> — normalize a recorded output type
# (do/tune writes TUNE_OUTPUT_TYPE_LATEST=adapter|model; older configs wrote
# full-model) to an ADR-013 artifact_kind. Unrecognized/empty ⇒ "" (unknown).
_additive_kind_from_output_type() {
    case "${1:-}" in
        adapter|lora|lora_adapter|lora-adapter) echo "lora_adapter" ;;
        model|full|full-model|full_model) echo "full_model" ;;
        *) echo "" ;;
    esac
}

# _additive_resolve_error <source-verb> <reason> <remedy> — structured stderr
# error for a resolution that genuinely failed (never a silent empty; BL165).
_additive_resolve_error() {
    echo "❌ Could not resolve --$1: $2" >&2
    [ -n "${3:-}" ] && echo "   → $3" >&2
    return 0
}

# _additive_upper <s> — uppercase + hyphens→underscores (config-var key form).
_additive_upper() {
    echo "$1" | tr '[:lower:]' '[:upper:]' | sed 's/-/_/g'
}

# ---------------------------------------------------------------------------
# _resolve_additive_source — resolve a --from-* source to a uniform artifact
# reference (ADR-013 axis 1). TARGET-UNIFORM: it never reads DEPLOYMENT_TARGET,
# so a source verb is never refused merely because of the target.
#
# Usage (always inside a command substitution, then eval the result):
#   _out=$(_resolve_additive_source <source-verb> <arg> <name> [<preferred-kinds>]) || exit 1
#   eval "${_out}"
#   <source-verb> ∈ from-weights | from-tune | from-train | from-registry | from-hub
#   <arg>         — the flag's value (S3 URI / technique / version ARN / HF repo id)
#   <name>        — the adapter/IC name (used for staging paths, e.g. --from-hub)
#   <preferred-kinds> — optional; when a source records BOTH an adapter and a full
#                   model (do/tune per-technique paths), prefer this kind's path
#                   (callers pass "$(_additive_accepts_kind <verb>)").
#
# Emits, on stdout, shell-quoted KEY=VALUE lines:
#   RESOLVED_SOURCE=<source-verb>
#   RESOLVED_URI=s3://...                        (always)
#   RESOLVED_KIND=lora_adapter|full_model|""     ("" == unknown → gate degrade)
#   RESOLVED_META_*=...                          (optional provenance)
# Returns non-zero with a structured stderr error when resolution fails.
#
# Adding a source = one new case branch below (R1.4). AWS/HF lookups are
# delegated to the EXISTING helpers (.register_helper.py get-version and the
# caller-provided _download_from_hub) — never reimplemented here (R1.3).
# ---------------------------------------------------------------------------
_resolve_additive_source() {
    local _src="${1:-}" _arg="${2:-}" _name="${3:-}" _prefer="${4:-}"
    local _uri="" _kind="" _meta=""

    case "${_src}" in
        from-weights)
            if [ -z "${_arg}" ]; then
                _additive_resolve_error "${_src}" "an S3 URI argument is required." \
                    "Usage: --from-weights s3://bucket/path/"
                return 2
            fi
            case "${_arg}" in
                s3://?*) ;;
                *)
                    _additive_resolve_error "${_src}" "'${_arg}' is not an S3 URI." \
                        "Pass an s3:// URI, e.g. --from-weights s3://bucket/adapters/name/"
                    return 2
                    ;;
            esac
            # Raw S3 carries no recorded kind → unknown (the gate degrades).
            _uri="${_arg}"
            ;;

        from-tune)
            if [ -n "${_arg}" ]; then
                # Technique (optionally <technique>-<dataset-slug>). do/tune records
                # TUNE_ADAPTER_PATH_<T>[_<SLUG>] for adapters and TUNE_MODEL_PATH_<T>
                # for full models, so WHICH variable holds the path is the recorded kind.
                local _tech="${_arg%%-*}" _tech_u _full_u _cands=() _c _tried=""
                _tech_u="$(_additive_upper "${_tech}")"
                _full_u="$(_additive_upper "${_arg}")"
                local _adapter_cands=("TUNE_ADAPTER_PATH_${_full_u}")
                [ "${_full_u}" != "${_tech_u}" ] && _adapter_cands+=("TUNE_ADAPTER_PATH_${_tech_u}")
                local _model_cands=("TUNE_MODEL_PATH_${_full_u}")
                [ "${_full_u}" != "${_tech_u}" ] && _model_cands+=("TUNE_MODEL_PATH_${_tech_u}")
                case " ${_prefer} " in
                    *" full_model "*) _cands=("${_model_cands[@]}" "${_adapter_cands[@]}") ;;
                    *) _cands=("${_adapter_cands[@]}" "${_model_cands[@]}") ;;
                esac
                for _c in "${_cands[@]}"; do
                    _tried="${_tried:+${_tried}, }${_c}"
                    if [ -n "${!_c:-}" ]; then
                        _uri="${!_c}"
                        case "${_c}" in
                            TUNE_ADAPTER_PATH_*) _kind="lora_adapter" ;;
                            TUNE_MODEL_PATH_*) _kind="full_model" ;;
                        esac
                        break
                    fi
                done
                if [ -z "${_uri}" ]; then
                    _additive_resolve_error "${_src}" \
                        "no tune output recorded for '${_arg}' in do/config (tried: ${_tried})." \
                        "Run a tune job first: ./do/tune --technique ${_tech} --dataset <source>"
                    return 1
                fi
                _meta="RESOLVED_META_TECHNIQUE=${_arg}"
            else
                if [ -z "${TUNE_OUTPUT_PATH_LATEST:-}" ]; then
                    _additive_resolve_error "${_src}" \
                        "TUNE_OUTPUT_PATH_LATEST is not set in do/config (no tune output yet)." \
                        "Run a tune job first: ./do/tune --technique <technique> --dataset <source>"
                    return 1
                fi
                _uri="${TUNE_OUTPUT_PATH_LATEST}"
                _kind="$(_additive_kind_from_output_type "${TUNE_OUTPUT_TYPE_LATEST:-}")"
                _meta="RESOLVED_META_TECHNIQUE=latest"
            fi
            ;;

        from-train)
            if [ -n "${_arg}" ]; then
                local _var
                _var="TRAIN_ADAPTER_PATH_$(_additive_upper "${_arg}")"
                if [ -z "${!_var:-}" ]; then
                    _additive_resolve_error "${_src}" \
                        "${_var} is not set in do/config (no training output for '${_arg}')." \
                        "Run a training job first: ./do/train --technique ${_arg} --dataset <source>"
                    return 1
                fi
                _uri="${!_var}"
                _meta="RESOLVED_META_TECHNIQUE=${_arg}"
            else
                if [ -z "${TRAIN_OUTPUT_PATH_LATEST:-}" ]; then
                    _additive_resolve_error "${_src}" \
                        "TRAIN_OUTPUT_PATH_LATEST is not set in do/config (no training output yet)." \
                        "Run a training job first: ./do/train --technique <technique> --dataset <source>"
                    return 1
                fi
                _uri="${TRAIN_OUTPUT_PATH_LATEST}"
                _meta="RESOLVED_META_TECHNIQUE=${TRAIN_TECHNIQUE:-latest}"
            fi
            # do/train records no output type today → unknown unless one is recorded.
            _kind="$(_additive_kind_from_output_type "${TRAIN_OUTPUT_TYPE_LATEST:-}")"
            ;;

        from-registry)
            case "${_arg}" in
                arn:*) ;;
                *)
                    _additive_resolve_error "${_src}" \
                        "a model-package version ARN is required (got '${_arg:-<none>}')." \
                        "Usage: --from-registry arn:aws:sagemaker:<region>:<acct>:model-package/<group>/<version>"
                    return 2
                    ;;
            esac
            local _helper="${_MLCC_CONTRACT_DO_DIR}/.register_helper.py"
            local _errf _out _rc=0
            _errf="$(mktemp)"
            local _region_args=()
            [ -n "${AWS_REGION:-}" ] && _region_args=(--region "${AWS_REGION}")
            # Capture stdout (JSON) and stderr (the real error) separately; surface
            # the helper's own error text on failure instead of swallowing it.
            _out=$(python3 "${_helper}" get-version --arn "${_arg}" ${_region_args[@]+"${_region_args[@]}"} 2>"${_errf}") || _rc=$?
            local _line
            # `|| true`: no JSON line is a reported failure below, not a silent
            # pipefail/errexit abort.
            _line="$(echo "${_out}" | grep -E '^\{' | tail -1 || true)"
            if [ "${_rc}" -ne 0 ] || [ -z "${_line}" ]; then
                _additive_resolve_error "${_src}" \
                    "the registry lookup failed for ${_arg} (.register_helper.py get-version exit ${_rc})." \
                    "Check the ARN and that you have sagemaker:DescribeModelPackage permission."
                if [ -s "${_errf}" ]; then
                    echo "   ── helper error output ──" >&2
                    sed 's/^/   /' "${_errf}" >&2
                elif [ -n "${_line}" ]; then
                    echo "   ${_line}" >&2
                fi
                rm -f "${_errf}"
                return 1
            fi
            rm -f "${_errf}"
            # Parse the helper JSON into shell-quoted assignments. Only a malformed
            # payload is tolerated here (JSONDecodeError) — programming errors are
            # not swallowed (BL172 lesson).
            local _parsed
            _parsed=$(printf '%s' "${_line}" | python3 -c '
import json, shlex, sys
d = json.loads(sys.stdin.read())
if d.get("error"):
    print("ERROR=" + shlex.quote(str(d["error"])))
    sys.exit(0)
md = d.get("customer_metadata_properties") or d.get("metadata") or {}
kind = md.get("mlcc.artifact_kind") or md.get("artifact_kind") or d.get("artifact_kind") or ""
if kind not in ("lora_adapter", "full_model"):
    kind = ""
uri = d.get("model_data_url") or d.get("modelDataUrl") or ""
# Directory-style artifacts need a trailing slash so SageMaker/vLLM fetch the
# whole prefix (registry metadata may have it stripped; Bug 52).
if uri and not uri.endswith(".tar.gz"):
    uri = uri.rstrip("/") + "/"
print("URI=" + shlex.quote(uri))
print("KIND=" + shlex.quote(kind))
print("PARENT=" + shlex.quote(str(md.get("parentModelVersionArn", ""))))
print("MODEL=" + shlex.quote(str(md.get("modelName", ""))))
print("VERSION=" + shlex.quote(str(d.get("version", ""))))
') || {
                _additive_resolve_error "${_src}" "could not parse the registry response for ${_arg}." ""
                echo "   ${_line}" >&2
                return 1
            }
            local ERROR="" URI="" KIND="" PARENT="" MODEL="" VERSION=""
            eval "${_parsed}"
            if [ -n "${ERROR}" ]; then
                _additive_resolve_error "${_src}" "registry error: ${ERROR}" \
                    "Run ./do/adapter list (or ./do/register list) to see registered versions."
                return 1
            fi
            if [ -z "${URI}" ]; then
                _additive_resolve_error "${_src}" "registry version ${_arg} has no model data URL." \
                    "Use --from-weights with an explicit S3 URI instead."
                return 1
            fi
            _uri="${URI}"
            _kind="${KIND}"
            printf 'RESOLVED_META_VERSION_ARN=%q\n' "${_arg}"
            printf 'RESOLVED_META_VERSION=%q\n' "${VERSION}"
            printf 'RESOLVED_META_PARENT_ARN=%q\n' "${PARENT}"
            printf 'RESOLVED_META_MODEL_NAME=%q\n' "${MODEL}"
            ;;

        from-hub)
            if ! echo "${_arg}" | grep -qE '^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)?$'; then
                _additive_resolve_error "${_src}" "invalid HuggingFace repo ID '${_arg}'." \
                    "Use 'org/name' or 'name', e.g. predibase/llama-3.1-8b-ectsum"
                return 2
            fi
            if ! declare -F _download_from_hub >/dev/null; then
                _additive_resolve_error "${_src}" \
                    "this verb has no HuggingFace staging helper (_download_from_hub)." \
                    "Stage the artifact to S3 yourself and pass --from-weights s3://..."
                return 2
            fi
            # The existing helper downloads, validates adapter_config.json, packs and
            # uploads to S3, then sets `weights_uri`. Its progress goes to stderr so
            # our stdout stays a clean KEY=VALUE stream; it exits non-zero on failure.
            local weights_uri=""
            _download_from_hub "${_arg}" "${_name}" >&2 || return 1
            if [ -z "${weights_uri}" ]; then
                _additive_resolve_error "${_src}" "staging from ${_arg} produced no S3 URI." ""
                return 1
            fi
            _uri="${weights_uri}"
            # An arbitrary HF repo has no recorded kind → unknown (gate degrades).
            _meta="RESOLVED_META_HF_REPO=${_arg}"
            ;;

        *)
            _additive_resolve_error "${_src:-<none>}" "unknown source verb." \
                "Use one of: --from-weights --from-tune --from-train --from-registry --from-hub"
            return 2
            ;;
    esac

    printf 'RESOLVED_SOURCE=%q\n' "${_src}"
    printf 'RESOLVED_URI=%q\n' "${_uri}"
    printf 'RESOLVED_KIND=%q\n' "${_kind}"
    if [ -n "${_meta}" ]; then
        printf '%s=%q\n' "${_meta%%=*}" "${_meta#*=}"
    fi
    return 0
}

# _additive_sniff_kind <s3-uri> — BEST-EFFORT content sniff for an artifact whose
# kind is unknown (R4.4 degrade). Echoes "lora_adapter" when adapter_config.json
# is found at the URI (S3 prefix, or inside a .tar.gz), else "" (unknown). It
# NEVER asserts full_model and never blocks: every failure (no aws CLI, no
# permission, network) is deliberately swallowed and reported as unknown, because
# this probe is advisory — the serving layer is the final authority.
_additive_sniff_kind() {
    local _uri="${1:-}"
    [ -n "${_uri}" ] || { echo ""; return 0; }
    command -v aws >/dev/null 2>&1 || { echo ""; return 0; }
    local _region_args=()
    [ -n "${AWS_REGION:-}" ] && _region_args=(--region "${AWS_REGION}")
    case "${_uri}" in
        *.tar.gz)
            local _tmp
            _tmp="$(mktemp -d 2>/dev/null)" || { echo ""; return 0; }
            # Optional probe: a failed download just means "unknown".
            if aws s3 cp "${_uri}" "${_tmp}/a.tar.gz" --quiet ${_region_args[@]+"${_region_args[@]}"} >/dev/null 2>&1 \
                && tar -tzf "${_tmp}/a.tar.gz" 2>/dev/null | grep -q 'adapter_config\.json$'; then
                echo "lora_adapter"
            else
                echo ""
            fi
            rm -rf "${_tmp}"
            ;;
        *)
            # Optional existence probe on the prefix; absence/denial ⇒ unknown.
            if aws s3 ls "${_uri%/}/adapter_config.json" ${_region_args[@]+"${_region_args[@]}"} >/dev/null 2>&1; then
                echo "lora_adapter"
            else
                echo ""
            fi
            ;;
    esac
    return 0
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
