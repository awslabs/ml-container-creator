# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: scale-to-zero (Wave 10, ADR-014). Sourced by do/deploy,
# deploy.d/realtime-inference, clean.d/realtime-inference, do/status, do/add-ic.
#
# Nothing here branches on a target NAME. Flag acceptance, the refusal reason,
# the warning wording and the mechanism come from the target's descriptor
# (targets.d/<target>/manifest.json "scale_to_zero", read through
# lib/python/scale_to_zero.py). The mechanism arms below are keyed on the
# descriptor's "mechanism" value (one arm in v2: sagemaker-ic-step), so enabling
# another target is a descriptor change plus one arm (ADR-014 Consequences).
#
# Config vars (do/config, runtime-owned, preserved by regenerate):
#   SCALE_TO_ZERO          true | false (default false; off = no behavior change)
#   SCALE_MAX_CAPACITY     1..20 (default 1): max IC copies and MaxInstanceCount
#   SCALE_TO_ZERO_STATUS   ok | failed | "" (written after the scaling setup)
#
# bash 3.2: no associative arrays, no ${v^^}, no mapfile.

_STZ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_STZ_PY="${_STZ_LIB_DIR}/python/scale_to_zero.py"
_STZ_TM="${_STZ_LIB_DIR}/python/target_manifest.py"
STZ_MAX_CAPACITY_LIMIT=20

# _stz_refuse <reason> <remedy> — contract violation (exit 3), uniform format.
_stz_refuse() {
    if type _contract_violation >/dev/null 2>&1; then
        _contract_violation "scale-to-zero" "$1" "$2"
    fi
    echo "❌ Contract violation: scale-to-zero"
    echo "   $1"
    echo "   → $2"
    exit 3
}

# stz_load <target> — sets STZ_SUPPORT, STZ_MECHANISM, STZ_WAKE_SIGNAL,
#   STZ_REQUESTS_AT_ZERO, STZ_IDLE_BILLING, STZ_ENABLED, STZ_REASON from the
#   descriptor. Returns 1 (and STZ_ENABLED=false) for an unknown target.
stz_load() {
    local _target="$1" _out=""
    STZ_ENABLED=false
    STZ_SUPPORT="" STZ_MECHANISM="" STZ_WAKE_SIGNAL="" STZ_REQUESTS_AT_ZERO="" STZ_IDLE_BILLING="" STZ_REASON=""
    [ -n "${_target}" ] || return 1
    _out=$(python3 "${_STZ_PY}" shell "${_target}" 2>/dev/null) || return 1
    eval "${_out}"
    return 0
}

# stz_parse_flags <--scale-to-zero value> <--scale-max value>
#   R2.4: validates the raw flag values before any AWS call; a bad value exits 1
#   (the do/deploy bad-flag convention). Sets:
#     STZ_FLAGS_GIVEN  1 when either flag was passed
#     STZ_FLAG_ON      true | false | "" (not passed)
#     STZ_FLAG_MAX     1..20 | "" (not passed)
stz_parse_flags() {
    local _on="$1" _max="$2"
    STZ_FLAGS_GIVEN="" STZ_FLAG_ON="" STZ_FLAG_MAX=""
    if [ -n "${_on}" ]; then
        case "${_on}" in
            on) STZ_FLAG_ON=true ;;
            off) STZ_FLAG_ON=false ;;
            *)
                echo "❌ --scale-to-zero must be 'on' or 'off' (got '${_on}')" >&2
                exit 1
                ;;
        esac
        STZ_FLAGS_GIVEN=1
    fi
    if [ -n "${_max}" ]; then
        case "${_max}" in
            *[!0-9]*)
                echo "❌ --scale-max must be an integer from 1 to ${STZ_MAX_CAPACITY_LIMIT} (got '${_max}')" >&2
                exit 1
                ;;
        esac
        _max=$((10#${_max}))
        if [ "${_max}" -lt 1 ] || [ "${_max}" -gt "${STZ_MAX_CAPACITY_LIMIT}" ]; then
            echo "❌ --scale-max must be an integer from 1 to ${STZ_MAX_CAPACITY_LIMIT} (got '$2')" >&2
            exit 1
        fi
        STZ_FLAG_MAX="${_max}"
        STZ_FLAGS_GIVEN=1
    fi
    return 0
}

# stz_refuse_disabled <target>
#   R2.2: a target whose descriptor says enabled=false refuses the flags with
#   the descriptor's reason (exit 3).
stz_refuse_disabled() {
    local _target="$1"
    if ! stz_load "${_target}"; then
        _stz_refuse "unknown deployment target '${_target}'" "pick a target with ./do/deploy --target <target>"
    fi
    if [ "${STZ_ENABLED}" != "true" ]; then
        _stz_refuse "${_target} does not support --scale-to-zero in this release: ${STZ_REASON}" \
            "remove --scale-to-zero / --scale-max (see docs/scale-to-zero.md for the per-target matrix)"
    fi
}

# stz_refuse_unsupported_config <target>
#   R2.3: mechanism-specific refusals (exit 3), checked against the current
#   config before anything is created. Requires stz_load to have run.
stz_refuse_unsupported_config() {
    local _target="$1"
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step)
            if [ -n "${CAPACITY_RESERVATION_ARN:-}" ]; then
                _stz_refuse "${_target}: CAPACITY_RESERVATION_ARN is set; reserved capacity is billed whether or not the endpoint is at zero, so scale-to-zero saves nothing" \
                    "unset CAPACITY_RESERVATION_ARN in do/config, or use --scale-to-zero off"
            fi
            if [ -n "${INSTANCE_POOLS:-}" ]; then
                _stz_refuse "${_target}: INSTANCE_POOLS is set; scale-to-zero with heterogeneous instance pools is unverified" \
                    "unset INSTANCE_POOLS in do/config (single instance type), or use --scale-to-zero off"
            fi
            if [ "${ENDPOINT_EXTERNAL:-false}" = "true" ] || { [ -n "${ENDPOINT_STRATEGY:-}" ] && [ "${ENDPOINT_STRATEGY}" != "new" ]; }; then
                _stz_refuse "${_target}: ENDPOINT_STRATEGY is '${ENDPOINT_STRATEGY:-existing}'; scale-to-zero changes the endpoint config, which this project only owns for a new endpoint" \
                    "use --endpoint-strategy new, or use --scale-to-zero off"
            fi
            ;;
        *)
            _stz_refuse "${_target}: scale-to-zero mechanism '${STZ_MECHANISM}' is not implemented" \
                "set enabled=false in targets.d/${_target}/manifest.json or add the mechanism arm to do/lib/scale-to-zero.sh"
            ;;
    esac
}

# stz_active <target> — 0 when SCALE_TO_ZERO=true and the target is enabled.
stz_active() {
    [ "${SCALE_TO_ZERO:-false}" = "true" ] || return 1
    stz_load "$1" || return 1
    [ "${STZ_ENABLED}" = "true" ]
}

# stz_target_live <target> — 0 when the target's status var holds its success
# status (both read from the descriptor).
stz_target_live() {
    local _target="$1" _var="" _ok=""
    _var=$(python3 "${_STZ_TM}" status_var "${_target}" 2>/dev/null) || return 1
    _ok=$(python3 "${_STZ_TM}" success_status "${_target}" 2>/dev/null) || return 1
    [ -n "${_var}" ] && [ "${!_var:-}" = "${_ok}" ]
}

# stz_apply_flags <target> [persist]
#   R2.1–R2.3: refuse on a disabled target or unsupported config, then export
#   SCALE_TO_ZERO / SCALE_MAX_CAPACITY for this run. With persist=1 (not a
#   dry run) they are also written to do/config through _update_config.
stz_apply_flags() {
    local _target="$1" _persist="${2:-0}"
    [ -n "${STZ_FLAGS_GIVEN:-}" ] || return 0
    stz_refuse_disabled "${_target}"
    if [ -n "${STZ_FLAG_ON}" ]; then
        SCALE_TO_ZERO="${STZ_FLAG_ON}"
    fi
    if [ -n "${STZ_FLAG_MAX}" ]; then
        SCALE_MAX_CAPACITY="${STZ_FLAG_MAX}"
    fi
    export SCALE_TO_ZERO="${SCALE_TO_ZERO:-false}"
    export SCALE_MAX_CAPACITY="${SCALE_MAX_CAPACITY:-1}"
    if [ "${SCALE_TO_ZERO}" = "true" ]; then
        stz_refuse_unsupported_config "${_target}"
    fi
    if [ "${_persist}" = "1" ] && type _update_config >/dev/null 2>&1; then
        _update_config "SCALE_TO_ZERO" "${SCALE_TO_ZERO}"
        _update_config "SCALE_MAX_CAPACITY" "${SCALE_MAX_CAPACITY}"
    fi
    return 0
}

# stz_warning <target> — the plain cold-start warning (R5.1). The wording comes
# from the descriptor (requests_at_zero) and the figures from ONE data file
# (lib/python/scale_to_zero_reference.json), both via scale_to_zero.py.
stz_warning() {
    python3 "${_STZ_PY}" warning "$1" 2>/dev/null || true
}

# ── Shared plumbing ───────────────────────────────────────────────────────────
_STZ_DO_DIR="$(cd "${_STZ_LIB_DIR}/.." && pwd)"

# _stz_aws <args...> — `aws`, or in plan mode (_STZ_PLAN=1, used by --dry-run)
# print the exact call to fd 9 and answer queries with a placeholder, so the
# dry-run plan and the real deploy run the SAME code path.
_stz_aws() {
    if [ "${_STZ_PLAN:-0}" = "1" ]; then
        # Copy-pasteable: plain words as-is, anything else single-quoted.
        local _a _line="     aws" _sq="'" _esc="'\\''"
        for _a in "$@"; do
            case "${_a}" in
                *[!A-Za-z0-9_./:=,@+-]*) _line="${_line} '${_a//${_sq}/${_esc}}'" ;;
                *) _line="${_line} ${_a}" ;;
            esac
        done
        printf '%s\n' "${_line}" >&9
        case " $* " in
            *" --query PolicyARN "*) echo "<planned-policy-arn>" ;;
        esac
        return 0
    fi
    aws "$@"
}

# _stz_record <type> <id> <meta-json> — do/manifest add (non-blocking, R4.2).
_stz_record() {
    [ "${_STZ_PLAN:-0}" = "1" ] && return 0
    "${_STZ_DO_DIR}/manifest" add --type "$1" --id "$2" --project "${PROJECT_NAME:-}" \
        --meta "$3" >/dev/null 2>&1 || true
}

# _stz_unrecord <id> — do/manifest delete (non-blocking).
_stz_unrecord() {
    "${_STZ_DO_DIR}/manifest" delete --id "$1" >/dev/null 2>&1 || true
}

# _stz_set_status <ok|failed|""> — runtime-owned SCALE_TO_ZERO_STATUS.
_stz_set_status() {
    [ "${_STZ_PLAN:-0}" = "1" ] && return 0
    SCALE_TO_ZERO_STATUS="$1"
    export SCALE_TO_ZERO_STATUS
    _stz_write_config "SCALE_TO_ZERO_STATUS" "$1"
}

# _stz_write_config <key> <value> — replace or append `export KEY="value"` in
# do/config (the same edit as do/deploy's _update_config; no dependency on it,
# so clean.d and the in-place reconfigure can call it too).
_stz_write_config() {
    local _config="${_STZ_DO_DIR}/config"
    [ -f "${_config}" ] || return 0
    if grep -q "^export $1=" "${_config}" 2>/dev/null; then
        sed -i.bak "s|^export $1=.*|export $1=\"$2\"|" "${_config}"
        rm -f "${_config}.bak"
    else
        echo "export $1=\"$2\"" >> "${_config}"
    fi
}

# _stz_not_found <stderr-file> — 0 when the AWS error says the resource is gone.
_stz_not_found() {
    grep -qiE 'ObjectNotFoundException|ResourceNotFound|not found|does not exist' "$1" 2>/dev/null
}

# _stz_deployed_ics — the base IC names this project deployed (do/ic/*.conf
# IC_DEPLOYED_NAME, else the legacy INFERENCE_COMPONENT_NAME), one per line.
_stz_deployed_ics() {
    local _conf _name _found=0
    if [ -d "${_STZ_DO_DIR}/ic" ]; then
        for _conf in "${_STZ_DO_DIR}"/ic/*.conf; do
            [ -f "${_conf}" ] || continue
            _name=$(grep "^export IC_DEPLOYED_NAME=" "${_conf}" 2>/dev/null | sed 's/^export IC_DEPLOYED_NAME="//; s/"$//' || true)
            if [ -n "${_name}" ]; then
                echo "${_name}"
                _found=1
            fi
        done
    fi
    if [ "${_found}" -eq 0 ] && [ -n "${INFERENCE_COMPONENT_NAME:-}" ]; then
        echo "${INFERENCE_COMPONENT_NAME}"
    fi
    return 0
}

# ── Mechanism: sagemaker-ic-step (realtime endpoints with inference components) ─
# The AWS-documented pattern (docs/scale-to-zero.md, ADR-014 §4): the variant has
# ManagedInstanceScaling MinInstanceCount 0; each IC is a scalable target with
# MinCapacity 0; target tracking on invocations per copy scales in (and out above
# one); a step policy fired by a NoCapacityInvocationFailures alarm wakes it.
# Deviation (documented, unmeasured): the step policy uses ExactCapacity 1 rather
# than the doc's ChangeInCapacity +1, so a hot alarm cannot stack copies.
_STZ_IC_NAMESPACE="sagemaker"
_STZ_IC_DIMENSION="sagemaker:inference-component:DesiredCopyCount"
# AWS doc example values (Scale an endpoint to zero instances), v2 defaults.
_STZ_IC_TT_CONFIG='{"PredefinedMetricSpecification":{"PredefinedMetricType":"SageMakerInferenceComponentInvocationsPerCopy"},"TargetValue":1,"ScaleInCooldown":300,"ScaleOutCooldown":300}'
_STZ_IC_STEP_CONFIG='{"AdjustmentType":"ExactCapacity","MetricAggregationType":"Maximum","Cooldown":60,"StepAdjustments":[{"MetricIntervalLowerBound":0,"ScalingAdjustment":1}]}'

# stz_variant_scaling_json — the ProductionVariant member (R3.1); empty unless
# STZ_ACTIVE=true. endpoint-config.sh appends it to the single-instance variant.
stz_variant_scaling_json() {
    [ "${STZ_ACTIVE:-false}" = "true" ] || return 0
    printf ',"ManagedInstanceScaling":{"Status":"ENABLED","MinInstanceCount":0,"MaxInstanceCount":%s}' "${SCALE_MAX_CAPACITY:-1}"
}

# _stz_ic_names <ic> — the resource id and the MLCC-owned resource names.
_stz_ic_names() {
    _STZ_RID="inference-component/$1"
    _STZ_TT_POLICY="$1-stz-tracking"
    _STZ_STEP_POLICY="$1-stz-wake"
    _STZ_ALARM="$1-stz-no-capacity"
    _STZ_ID_PREFIX="application-autoscaling:${AWS_REGION:-}:${_STZ_IC_NAMESPACE}/${_STZ_RID}"
}

# _stz_fail <call> <iam-action> <stderr-file> — R4.1 diagnostics.
_stz_fail() {
    echo "❌ Scale-to-zero setup failed at: aws $1" >&2
    if [ -s "$3" ]; then
        sed 's/^/   /' "$3" >&2
    fi
    echo "   IAM: the deploying principal needs $2" >&2
}

# _stz_ic_step_create <ic> — create the four resources for one IC, recording
# each in _STZ_CREATED ("kind|ic") for rollback. Returns 1 on the first failure.
_stz_ic_step_create() {
    local _ic="$1" _max="${SCALE_MAX_CAPACITY:-1}" _err _arn=""
    _stz_ic_names "${_ic}"
    _err=$(mktemp "${TMPDIR:-/tmp}/mlcc-stz-err.XXXXXX")

    if ! _stz_aws application-autoscaling register-scalable-target \
        --service-namespace "${_STZ_IC_NAMESPACE}" \
        --resource-id "${_STZ_RID}" \
        --scalable-dimension "${_STZ_IC_DIMENSION}" \
        --min-capacity 0 \
        --max-capacity "${_max}" \
        --region "${AWS_REGION}" >/dev/null 2>"${_err}"; then
        _stz_fail "application-autoscaling register-scalable-target (${_STZ_RID})" \
            "application-autoscaling:RegisterScalableTarget (and iam:CreateServiceLinkedRole for AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint on first use)" "${_err}"
        rm -f "${_err}"
        return 1
    fi
    _STZ_CREATED+=("target|${_ic}")
    _stz_record application-autoscaling-scalable-target "${_STZ_ID_PREFIX}" \
        "{\"resourceId\":\"${_STZ_RID}\",\"scalableDimension\":\"${_STZ_IC_DIMENSION}\",\"minCapacity\":0,\"maxCapacity\":${_max},\"region\":\"${AWS_REGION}\"}"

    if ! _stz_aws application-autoscaling put-scaling-policy \
        --policy-name "${_STZ_TT_POLICY}" \
        --policy-type TargetTrackingScaling \
        --service-namespace "${_STZ_IC_NAMESPACE}" \
        --resource-id "${_STZ_RID}" \
        --scalable-dimension "${_STZ_IC_DIMENSION}" \
        --target-tracking-scaling-policy-configuration "${_STZ_IC_TT_CONFIG}" \
        --region "${AWS_REGION}" >/dev/null 2>"${_err}"; then
        _stz_fail "application-autoscaling put-scaling-policy (${_STZ_TT_POLICY}, TargetTrackingScaling)" \
            "application-autoscaling:PutScalingPolicy" "${_err}"
        rm -f "${_err}"
        return 1
    fi
    _STZ_CREATED+=("tracking|${_ic}")
    _stz_record application-autoscaling-scaling-policy "${_STZ_ID_PREFIX}/policy/${_STZ_TT_POLICY}" \
        "{\"policyName\":\"${_STZ_TT_POLICY}\",\"policyType\":\"TargetTrackingScaling\",\"resourceId\":\"${_STZ_RID}\",\"region\":\"${AWS_REGION}\"}"

    if ! _arn=$(_stz_aws application-autoscaling put-scaling-policy \
        --policy-name "${_STZ_STEP_POLICY}" \
        --policy-type StepScaling \
        --service-namespace "${_STZ_IC_NAMESPACE}" \
        --resource-id "${_STZ_RID}" \
        --scalable-dimension "${_STZ_IC_DIMENSION}" \
        --step-scaling-policy-configuration "${_STZ_IC_STEP_CONFIG}" \
        --region "${AWS_REGION}" \
        --query PolicyARN \
        --output text 2>"${_err}") || [ -z "${_arn}" ] || [ "${_arn}" = "None" ]; then
        _stz_fail "application-autoscaling put-scaling-policy (${_STZ_STEP_POLICY}, StepScaling)" \
            "application-autoscaling:PutScalingPolicy" "${_err}"
        rm -f "${_err}"
        return 1
    fi
    _STZ_CREATED+=("step|${_ic}")
    _stz_record application-autoscaling-scaling-policy "${_STZ_ID_PREFIX}/policy/${_STZ_STEP_POLICY}" \
        "{\"policyName\":\"${_STZ_STEP_POLICY}\",\"policyType\":\"StepScaling\",\"policyArn\":\"${_arn}\",\"resourceId\":\"${_STZ_RID}\",\"region\":\"${AWS_REGION}\"}"

    # AWS doc alarm shape, with >= 1 so ONE failed request wakes the endpoint
    # (ADR-014 Addendum A, fact 5).
    if ! _stz_aws cloudwatch put-metric-alarm \
        --alarm-name "${_STZ_ALARM}" \
        --alarm-description "MLCC scale-to-zero: wake ${_ic} when it is invoked with no capacity" \
        --alarm-actions "${_arn}" \
        --namespace AWS/SageMaker \
        --metric-name "${STZ_WAKE_SIGNAL:-NoCapacityInvocationFailures}" \
        --dimensions "Name=InferenceComponentName,Value=${_ic}" \
        --statistic Sum \
        --period 60 \
        --evaluation-periods 1 \
        --datapoints-to-alarm 1 \
        --threshold 1 \
        --comparison-operator GreaterThanOrEqualToThreshold \
        --region "${AWS_REGION}" >/dev/null 2>"${_err}"; then
        _stz_fail "cloudwatch put-metric-alarm (${_STZ_ALARM})" "cloudwatch:PutMetricAlarm" "${_err}"
        rm -f "${_err}"
        return 1
    fi
    _STZ_CREATED+=("alarm|${_ic}")
    _stz_record cloudwatch-alarm "cloudwatch:${AWS_REGION}:alarm/${_STZ_ALARM}" \
        "{\"alarmName\":\"${_STZ_ALARM}\",\"metric\":\"${STZ_WAKE_SIGNAL:-NoCapacityInvocationFailures}\",\"inferenceComponentName\":\"${_ic}\",\"region\":\"${AWS_REGION}\"}"
    rm -f "${_err}"
    return 0
}

# _stz_ic_step_delete <kind> <ic> — delete one resource; "not found" counts as
# removed. Returns 1 only on a real failure.
_stz_ic_step_delete() {
    local _kind="$1" _ic="$2" _err _rc=0 _id=""
    _stz_ic_names "${_ic}"
    _err=$(mktemp "${TMPDIR:-/tmp}/mlcc-stz-err.XXXXXX")
    case "${_kind}" in
        alarm)
            aws cloudwatch delete-alarms --alarm-names "${_STZ_ALARM}" \
                --region "${AWS_REGION}" >/dev/null 2>"${_err}" || _rc=$?
            _id="cloudwatch:${AWS_REGION}:alarm/${_STZ_ALARM}"
            ;;
        step | tracking)
            local _policy="${_STZ_STEP_POLICY}"
            [ "${_kind}" = "tracking" ] && _policy="${_STZ_TT_POLICY}"
            aws application-autoscaling delete-scaling-policy --policy-name "${_policy}" \
                --service-namespace "${_STZ_IC_NAMESPACE}" --resource-id "${_STZ_RID}" \
                --scalable-dimension "${_STZ_IC_DIMENSION}" \
                --region "${AWS_REGION}" >/dev/null 2>"${_err}" || _rc=$?
            _id="${_STZ_ID_PREFIX}/policy/${_policy}"
            ;;
        target)
            aws application-autoscaling deregister-scalable-target \
                --service-namespace "${_STZ_IC_NAMESPACE}" --resource-id "${_STZ_RID}" \
                --scalable-dimension "${_STZ_IC_DIMENSION}" \
                --region "${AWS_REGION}" >/dev/null 2>"${_err}" || _rc=$?
            _id="${_STZ_ID_PREFIX}"
            ;;
    esac
    if [ "${_rc}" -ne 0 ] && ! _stz_not_found "${_err}"; then
        echo "   ⚠️  Could not delete scale-to-zero ${_kind} for ${_ic}:" >&2
        sed 's/^/      /' "${_err}" >&2
        rm -f "${_err}"
        return 1
    fi
    rm -f "${_err}"
    _stz_unrecord "${_id}"
    return 0
}

# _stz_ic_step_teardown <ic>... — alarm, policies, then scalable target (R4.2).
_stz_ic_step_teardown() {
    local _ic _kind _rc=0
    for _ic in "$@"; do
        echo "🗑️  Removing scale-to-zero resources for: ${_ic}"
        for _kind in alarm step tracking target; do
            _stz_ic_step_delete "${_kind}" "${_ic}" || _rc=1
        done
    done
    return "${_rc}"
}

# _stz_rollback — undo _STZ_CREATED in reverse order (alarm first, target last).
_stz_rollback() {
    local _i _entry
    _i=$(( ${#_STZ_CREATED[@]} - 1 ))
    [ "${_i}" -ge 0 ] || return 0
    echo "   ↩️  Rolling back the scale-to-zero resources created so far..." >&2
    while [ "${_i}" -ge 0 ]; do
        _entry="${_STZ_CREATED[${_i}]}"
        _stz_ic_step_delete "${_entry%%|*}" "${_entry#*|}" >&2 || true
        _i=$(( _i - 1 ))
    done
    return 0
}

# ── Public mechanism API (dispatch on the descriptor's mechanism) ─────────────

# stz_add_ic_notice — R3.3: an IC added later (do/add-ic, do/deploy --ic) is
# not registered for scale-to-zero in v2. A notice, never a failure.
stz_add_ic_notice() {
    echo "ℹ️  Scale-to-zero is on for this endpoint, but in v2 an inference component added"
    echo "   later is NOT registered for it: it keeps its fixed copy count, so the endpoint"
    echo "   cannot reach zero instances while it runs."
    echo "   To register every deployed IC: ./do/deploy --reconfigure --scale-to-zero on"
}

# stz_setup <target> <ic>... — R3.2 / R4.1. Run after the ICs are InService.
#   0: every IC registered (SCALE_TO_ZERO_STATUS=ok).
#   5: a call failed; what was created is rolled back, SCALE_TO_ZERO_STATUS=failed,
#      and the endpoint keeps serving at its fixed floor (not a deploy failure).
stz_setup() {
    local _target="$1" _ic
    shift
    stz_load "${_target}" || return 5
    _STZ_CREATED=()
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step)
            if [ "$#" -eq 0 ]; then
                echo "❌ Scale-to-zero: no inference component to register (the mechanism needs one)." >&2
                _stz_set_status failed
                return 5
            fi
            echo "⚙️  Scale-to-zero: registering $# inference component(s) (min 0, max ${SCALE_MAX_CAPACITY:-1})"
            for _ic in "$@"; do
                if ! _stz_ic_step_create "${_ic}"; then
                    _stz_rollback
                    _stz_set_status failed
                    echo "   The endpoint is up at its fixed floor (1 copy); it will not scale to zero." >&2
                    echo "   Fix the permission above, then retry: ./do/deploy --reconfigure --scale-to-zero on" >&2
                    return 5
                fi
            done
            ;;
        *)
            echo "❌ Scale-to-zero mechanism '${STZ_MECHANISM}' is not implemented." >&2
            _stz_set_status failed
            return 5
            ;;
    esac
    _stz_set_status ok
    echo "✅ Scale-to-zero: on (min 0, max ${SCALE_MAX_CAPACITY:-1}) for: $*"
    return 0
}

# stz_teardown <target> <ic>... — R4.2: remove what stz_setup created. Safe to
# run twice ("not found" counts as removed). Returns 1 if anything was left.
stz_teardown() {
    local _target="$1"
    shift
    stz_load "${_target}" || return 0
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step) _stz_ic_step_teardown "$@" ;;
        *) return 0 ;;
    esac
}

# stz_teardown_if_owned <target> <ic>... — the clean.d entry point: only touches
# AWS when this project may own scaling resources (SCALE_TO_ZERO=true or a
# recorded SCALE_TO_ZERO_STATUS), so default-off projects make no extra calls.
stz_teardown_if_owned() {
    if [ "${SCALE_TO_ZERO:-false}" != "true" ] && [ -z "${SCALE_TO_ZERO_STATUS:-}" ]; then
        return 0
    fi
    [ "$#" -gt 1 ] || return 0
    stz_teardown "$@"
}

# stz_status_line <current-copies> — R5.3: `scale-to-zero: on (min 0, max N)`
# plus the current copy count. Min/max are read from the first deployed IC's
# scalable target (read-only describe), falling back to do/config.
stz_status_line() {
    local _cur="${1:-}" _ic="" _mm="" _min="0" _max="${SCALE_MAX_CAPACITY:-1}" _note=""
    _ic=$(_stz_deployed_ics | head -1)
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step)
            if [ -n "${_ic}" ]; then
                _mm=$(aws application-autoscaling describe-scalable-targets \
                    --service-namespace "${_STZ_IC_NAMESPACE}" \
                    --resource-ids "inference-component/${_ic}" \
                    --scalable-dimension "${_STZ_IC_DIMENSION}" \
                    --region "${AWS_REGION}" \
                    --query 'ScalableTargets[0].[MinCapacity,MaxCapacity]' \
                    --output text 2>/dev/null || true)
            fi
            ;;
    esac
    if [ -n "${_mm}" ] && [ "${_mm}" != "None" ]; then
        _min=$(echo "${_mm}" | awk '{print $1}')
        _max=$(echo "${_mm}" | awk '{print $2}')
    else
        _note=" [scalable target not found: ./do/deploy --reconfigure --scale-to-zero on]"
    fi
    [ "${SCALE_TO_ZERO_STATUS:-}" = "failed" ] && _note=" [setup failed: ./do/deploy --reconfigure --scale-to-zero on]"
    echo "scale-to-zero: on (min ${_min}, max ${_max}); current copies: ${_cur:--}${_note}"
}

# stz_plan <target> — --dry-run: the warning and the exact calls a deploy would
# make, printed by the same functions that make them (no AWS call).
stz_plan() {
    local _target="$1"
    stz_load "${_target}" || return 0
    stz_warning "${_target}"
    echo ""
    echo "Scale-to-zero plan (${STZ_MECHANISM}; not executed in a dry run):"
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step)
            STZ_ACTIVE=true
            echo "   endpoint config variant adds: $(stz_variant_scaling_json | sed 's/^,//')"
            echo "   after each inference component is InService:"
            exec 9>&1
            _STZ_PLAN=1
            _STZ_CREATED=()
            _stz_ic_step_create "<inference-component>" >/dev/null || true
            _STZ_PLAN=0
            exec 9>&-
            ;;
    esac
}

# _stz_ic_step_swap_config — create a new endpoint config for the live endpoint
# (the same single-instance variant, with ManagedInstanceScaling when
# STZ_ACTIVE=true) and update-endpoint onto it. Returns 1 on failure; the
# endpoint then keeps its previous config.
_stz_ic_step_swap_config() {
    local _ep="$1" _old_epc="${ENDPOINT_CONFIG_NAME:-}" _out="" _rc=0 _new_epc="" _min=""
    # Already in the wanted shape? (MinInstanceCount 0 present iff STZ_ACTIVE)
    if [ -n "${_old_epc}" ]; then
        _min=$(aws sagemaker describe-endpoint-config --endpoint-config-name "${_old_epc}" \
            --region "${AWS_REGION}" \
            --query 'ProductionVariants[0].ManagedInstanceScaling.MinInstanceCount' \
            --output text 2>/dev/null || true)
        if { [ "${STZ_ACTIVE:-false}" = "true" ] && [ "${_min}" = "0" ]; } || \
           { [ "${STZ_ACTIVE:-false}" != "true" ] && { [ -z "${_min}" ] || [ "${_min}" = "None" ]; }; }; then
            echo "   Endpoint config ${_old_epc} already has the wanted ManagedInstanceScaling; no update needed."
            return 0
        fi
    fi
    # shellcheck source=/dev/null
    source "${_STZ_LIB_DIR}/endpoint-config.sh"
    _out=$(create_endpoint_config 2>&1; echo "__STZ_EPC__=${ENDPOINT_CONFIG_NAME:-}") || _rc=$?
    printf '%s\n' "${_out}" | grep -v '^__STZ_EPC__=' || true
    _new_epc=$(printf '%s\n' "${_out}" | sed -n 's/^__STZ_EPC__=//p')
    if [ "${_rc}" -ne 0 ] || [ -z "${_new_epc}" ]; then
        echo "❌ Could not create the new endpoint configuration (sagemaker:CreateEndpointConfig)." >&2
        return 1
    fi
    echo "🔄 Updating endpoint ${_ep} to ${_new_epc}"
    if ! aws sagemaker update-endpoint --endpoint-name "${_ep}" \
        --endpoint-config-name "${_new_epc}" --region "${AWS_REGION}" >/dev/null; then
        echo "❌ update-endpoint failed (sagemaker:UpdateEndpoint); ${_ep} keeps ${_old_epc:-its current config}." >&2
        aws sagemaker delete-endpoint-config --endpoint-config-name "${_new_epc}" \
            --region "${AWS_REGION}" >/dev/null 2>&1 || true
        return 1
    fi
    # wait_endpoint (wait.sh) exits 4 on failure: run it in a subshell.
    if ! ( wait_endpoint "${_ep}" ); then
        echo "❌ ${_ep} did not return to InService after the update." >&2
        return 1
    fi
    ENDPOINT_CONFIG_NAME="${_new_epc}"
    _stz_write_config "ENDPOINT_CONFIG_NAME" "${_new_epc}"
    _stz_record sagemaker-endpoint-config \
        "arn:aws:sagemaker:${AWS_REGION}:${AWS_ACCOUNT_ID:-}:endpoint-config/${_new_epc}" \
        "{\"endpointConfigName\":\"${_new_epc}\",\"instanceType\":\"${INSTANCE_TYPE:-}\",\"region\":\"${AWS_REGION}\"}"
    # The previous config is MLCC-owned and no longer in use.
    if [ -n "${_old_epc}" ] && [ "${_old_epc}" != "${_new_epc}" ]; then
        aws sagemaker delete-endpoint-config --endpoint-config-name "${_old_epc}" \
            --region "${AWS_REGION}" >/dev/null 2>&1 || true
        _stz_unrecord "arn:aws:sagemaker:${AWS_REGION}:${AWS_ACCOUNT_ID:-}:endpoint-config/${_old_epc}"
    fi
    return 0
}

# _stz_ic_step_restore_copies <ic>... — R2.5 off: a fixed floor of one copy.
_stz_ic_step_restore_copies() {
    local _ic _desired=""
    for _ic in "$@"; do
        _desired=$(aws sagemaker describe-inference-component --inference-component-name "${_ic}" \
            --region "${AWS_REGION}" --query 'RuntimeConfig.DesiredCopyCount' --output text 2>/dev/null || true)
        if [ "${_desired}" != "1" ]; then
            echo "🔄 Restoring ${_ic} to 1 copy (was ${_desired:-unknown})"
            if ! aws sagemaker update-inference-component-runtime-config \
                --inference-component-name "${_ic}" \
                --desired-runtime-config CopyCount=1 \
                --region "${AWS_REGION}" >/dev/null; then
                echo "❌ Could not restore ${_ic} to 1 copy (sagemaker:UpdateInferenceComponentRuntimeConfig)." >&2
                return 1
            fi
            if ! ( wait_ic "${_ic}" ); then
                echo "❌ ${_ic} did not return to InService with 1 copy." >&2
                return 1
            fi
        fi
    done
    return 0
}

# stz_reconfigure_live <target> — R2.5: `do/deploy --reconfigure --scale-to-zero
# on|off` on a live deployment changes it IN PLACE (no clean, no re-prompt).
#   0 done · 3 refused (no ICs on the live endpoint) · 5 scaling change failed
#   (the endpoint is still serving; see the message).
stz_reconfigure_live() {
    local _target="$1" _ep _ics _live
    stz_load "${_target}" || return 3
    case "${STZ_MECHANISM}" in
        sagemaker-ic-step) ;;
        *) _stz_refuse "${_target}: in-place scale-to-zero for mechanism '${STZ_MECHANISM}' is not implemented" "redeploy instead" ;;
    esac
    _ep="${SMAI_ENDPOINT_NAME:-${ENDPOINT_NAME:-}}"
    export ENDPOINT_NAME="${_ep}"
    export INSTANCE_TYPE="${SMAI_INSTANCE_TYPE:-${INSTANCE_TYPE:-}}"
    ROLE_ARN="${ROLE_ARN:-${_PROFILE_roleArn:-}}"
    export AWS_REGION="${AWS_REGION:-${_PROFILE_awsRegion:-us-east-1}}"
    _ics=$(_stz_deployed_ics | tr '\n' ' ')
    if [ "${FLAG_DRY_RUN:-0}" -eq 1 ]; then
        echo "── Dry Run: scale-to-zero ${SCALE_TO_ZERO} on ${_ep} (in place) ──"
        [ "${SCALE_TO_ZERO}" = "true" ] && stz_plan "${_target}"
        echo "── No changes made (dry run) ──"
        return 0
    fi
    source "${_STZ_LIB_DIR}/aws-preflight.sh"
    _aws_preflight
    # R2.3: the live endpoint must host inference components.
    _live=$(aws sagemaker list-inference-components --endpoint-name-equals "${_ep}" \
        --region "${AWS_REGION}" --query 'InferenceComponents[].InferenceComponentName' \
        --output text 2>/dev/null || true)
    if [ -z "${_live}" ] || [ "${_live}" = "None" ] || [ -z "${_ics// /}" ]; then
        _stz_refuse "${_target}: endpoint ${_ep:-<none>} does not use inference components this project deployed; scale-to-zero needs them" \
            "redeploy with ./do/deploy --force"
    fi
    source "${_STZ_LIB_DIR}/wait.sh"
    # ${_ics} is a space-separated list of IC names (no spaces in names): unquoted on purpose.
    if [ "${SCALE_TO_ZERO}" = "true" ]; then
        stz_warning "${_target}"
        STZ_ACTIVE=true
        if ! _stz_ic_step_swap_config "${_ep}"; then
            _stz_set_status failed
            echo "   Scale-to-zero was NOT enabled; ${_ep} is serving on its previous config." >&2
            return 5
        fi
        stz_setup "${_target}" ${_ics} || return 5
        return 0
    fi
    # off: scaling resources first, then a fixed floor, then drop the variant block.
    stz_teardown "${_target}" ${_ics} || echo "⚠️  Some scale-to-zero resources could not be removed (see above)." >&2
    if ! _stz_ic_step_restore_copies ${_ics}; then
        _stz_set_status failed
        return 5
    fi
    STZ_ACTIVE=false
    if ! _stz_ic_step_swap_config "${_ep}"; then
        echo "⚠️  ${_ep} keeps ManagedInstanceScaling (min 0) in its config, but nothing scales it: 1 copy stays up." >&2
        _stz_set_status failed
        return 5
    fi
    _stz_set_status ""
    echo "✅ Scale-to-zero: off. ${_ep} is at a fixed floor of 1 copy on 1 instance."
    return 0
}
