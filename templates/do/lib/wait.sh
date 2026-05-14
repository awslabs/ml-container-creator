# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: wait/polling functions and config persistence utilities.
# Sourced by do/deploy — expects AWS_REGION and SCRIPT_DIR to be set by the caller.

# _update_config_var <var_name> <var_value> [config_file]
#   Persist a variable to a config file so other scripts can use it.
#   If the variable already exists, update it in place; otherwise append.
#   Defaults to ${SCRIPT_DIR}/config if no config_file is specified.
_update_config_var() {
    local var_name="$1" var_value="$2" config_file="${3:-${SCRIPT_DIR}/config}"
    if grep -q "^export ${var_name}=" "${config_file}" 2>/dev/null; then
        sed -i.bak "s|^export ${var_name}=.*|export ${var_name}=\"${var_value}\"|" "${config_file}"
        rm -f "${config_file}.bak"
    else
        echo "" >> "${config_file}"
        echo "export ${var_name}=\"${var_value}\"" >> "${config_file}"
    fi
}

# _get_endpoint_status <endpoint_name>
#   Query a SageMaker endpoint status. Returns empty string if not found.
_get_endpoint_status() {
    aws sagemaker describe-endpoint \
        --endpoint-name "$1" \
        --region "${AWS_REGION}" \
        --query EndpointStatus \
        --output text 2>/dev/null || echo ""
}

# _get_ic_status <inference_component_name>
#   Query a SageMaker inference component status. Returns empty string if not found.
_get_ic_status() {
    aws sagemaker describe-inference-component \
        --inference-component-name "$1" \
        --region "${AWS_REGION}" \
        --query InferenceComponentStatus \
        --output text 2>/dev/null || echo ""
}

# _find_active_ic_on_endpoint <endpoint_name>
#   Find an InService inference component on an endpoint.
#   Returns the first match or empty string.
_find_active_ic_on_endpoint() {
    aws sagemaker list-inference-components \
        --endpoint-name "$1" \
        --status-equals InService \
        --region "${AWS_REGION}" \
        --query 'InferenceComponents[0].InferenceComponentName' \
        --output text 2>/dev/null || echo ""
}

# wait_endpoint <endpoint_name>
#   Wait for a SageMaker endpoint to reach InService status.
#   Detects credential expiry vs actual failure and exits with code 4 on error.
wait_endpoint() {
    local endpoint_name="$1"

    if ! aws sagemaker wait endpoint-in-service \
        --endpoint-name "${endpoint_name}" \
        --region "${AWS_REGION}"; then

        # Check if it was a credential expiration vs actual failure
        local ep_check
        ep_check=$(_get_endpoint_status "${endpoint_name}" 2>/dev/null)
        if [ "${ep_check}" = "Creating" ]; then
            echo ""
            echo "⚠️  Wait interrupted (credentials may have expired), but endpoint is still creating."
            echo "   Refresh your credentials and re-run ./do/deploy to resume."
            exit 4
        fi

        echo "❌ Endpoint failed to reach InService status"
        echo "   Check CloudWatch Logs for details:"
        echo "   https://console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:log-groups/log-group//aws/sagemaker/Endpoints/${endpoint_name}"
        exit 4
    fi
}

# wait_ic <ic_name> [timeout]
#   Poll an inference component until it reaches InService or fails.
#   Default timeout is 1800 seconds (30 minutes).
#   Reports status every 30 seconds. Detects credential expiry.
#   Exits with code 4 on failure or timeout.
wait_ic() {
    local ic_name="$1"
    local timeout="${2:-1800}"
    local wait_start
    wait_start=$(date +%s)

    while true; do
        local ic_status
        ic_status=$(_get_ic_status "${ic_name}" 2>/dev/null)

        case "${ic_status}" in
            InService)
                break
                ;;
            Failed)
                echo "❌ Inference component failed to reach InService status"
                echo "   Check CloudWatch Logs for details:"
                echo "   https://console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:log-groups/log-group//aws/sagemaker/Endpoints/${ENDPOINT_NAME:-unknown}"
                echo ""
                echo "   Debug:"
                echo "   aws sagemaker describe-inference-component --inference-component-name ${ic_name} --region ${AWS_REGION}"
                exit 4
                ;;
            Creating)
                local elapsed=$(( $(date +%s) - wait_start ))
                if [ "${elapsed}" -ge "${timeout}" ]; then
                    echo ""
                    echo "⚠️  Inference component still creating after ${timeout}s."
                    echo "   Re-run ./do/deploy to resume waiting."
                    exit 4
                fi
                echo "   $(date +%H:%M:%S) Status: Creating (${elapsed}s elapsed)..."
                sleep 30
                ;;
            "")
                echo "⚠️  Could not determine inference component status (credentials may have expired)."
                echo "   Re-run ./do/deploy to resume."
                exit 4
                ;;
            *)
                echo "   $(date +%H:%M:%S) Status: ${ic_status}..."
                sleep 30
                ;;
        esac
    done
}
