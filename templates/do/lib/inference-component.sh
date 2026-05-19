# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: create SageMaker inference components.
# Sourced by do/deploy — expects the following to be set by the caller:
#   PROJECT_NAME, ENDPOINT_NAME, ECR_REPOSITORY, AWS_REGION, CONTAINER_ENV_JSON
# Also expects _update_config_var() to be available (from wait.sh).

# create_inference_component <ic_config_file>
#   Creates an inference component from a per-IC config file.
#
#   The config file is sourced and should export:
#     IC_IMAGE_TAG       — container image tag (default: ${PROJECT_NAME}-latest)
#     IC_GPU_COUNT       — number of accelerator devices (default: 1)
#     IC_COPY_COUNT      — number of IC copies (default: 1)
#     IC_MIN_MEMORY_MB   — minimum memory in MB (default: 1024)
#     IC_STARTUP_TIMEOUT — container startup health check timeout in seconds (default: 900)
#     IC_CONTAINER_ENV_EXTRA — optional extra env vars in "KEY":"value" format
#
#   Multi-spec support (for heterogeneous instance pools):
#     IC_MULTI_SPEC      — set to "true" to use Specifications (plural) array
#     IC_SPEC_COUNT      — number of spec entries (e.g., 2)
#     IC_SPEC_N_INSTANCE_TYPE — instance type for spec entry N
#     IC_SPEC_N_GPU_COUNT     — GPU count for spec entry N
#     IC_SPEC_N_MIN_MEMORY_MB — minimum memory for spec entry N
#
#   Sets IC_DEPLOYED_NAME in the caller's scope (for use by wait_ic).
#   Persists IC_DEPLOYED_NAME and IC_DEPLOYED_AT back to the IC config file.
#   Echoes the IC name as return value.
create_inference_component() {
    local ic_conf="$1"

    if [ ! -f "${ic_conf}" ]; then
        echo "❌ IC config file not found: ${ic_conf}"
        exit 4
    fi

    # Source the IC config to get per-IC settings
    source "${ic_conf}"

    local ic_timestamp
    ic_timestamp=$(date +%s)
    local ic_basename
    ic_basename=$(basename "${ic_conf}" .conf)
    local ic_name="${PROJECT_NAME}-${ic_basename}-${ic_timestamp}"

    # Build container spec JSON
    local container_spec="{\"Image\":\"${ECR_REPOSITORY}:${IC_IMAGE_TAG:-${PROJECT_NAME}-latest}\""
    # Always inject IC name for CW log forwarder
    local ic_env="\"INFERENCE_COMPONENT_NAME\":\"${ic_name}\""
    if [ -n "${CONTAINER_ENV_JSON}${IC_CONTAINER_ENV_EXTRA:-}" ]; then
        local env_json="${CONTAINER_ENV_JSON}"
        [ -n "${IC_CONTAINER_ENV_EXTRA:-}" ] && env_json="${env_json:+${env_json},}${IC_CONTAINER_ENV_EXTRA}"
        container_spec="${container_spec},\"Environment\":{${ic_env},${env_json}}"
    else
        container_spec="${container_spec},\"Environment\":{${ic_env}}"
    fi
    container_spec="${container_spec}}"

    # Build specification JSON — multi-spec (Specifications array) or single (Specification object)
    local spec_json
    if [ "${IC_MULTI_SPEC:-false}" = "true" ] && [ "${IC_SPEC_COUNT:-0}" -gt 0 ]; then
        # Multi-spec: build Specifications array with per-instance-type compute resources
        spec_json="{\"Specifications\":["
        local i=1
        while [ "${i}" -le "${IC_SPEC_COUNT}" ]; do
            local spec_instance_type_var="IC_SPEC_${i}_INSTANCE_TYPE"
            local spec_gpu_count_var="IC_SPEC_${i}_GPU_COUNT"
            local spec_min_memory_var="IC_SPEC_${i}_MIN_MEMORY_MB"

            local spec_instance_type="${!spec_instance_type_var}"
            local spec_gpu_count="${!spec_gpu_count_var:-1}"
            local spec_min_memory="${!spec_min_memory_var:-1024}"

            if [ "${i}" -gt 1 ]; then
                spec_json="${spec_json},"
            fi
            spec_json="${spec_json}{\"Container\":${container_spec},\"StartupParameters\":{\"ContainerStartupHealthCheckTimeoutInSeconds\":${IC_STARTUP_TIMEOUT:-900}},\"ComputeResourceRequirements\":{\"NumberOfAcceleratorDevicesRequired\":${spec_gpu_count},\"MinMemoryRequiredInMb\":${spec_min_memory}}}"

            i=$((i + 1))
        done
        spec_json="${spec_json}]}"
    else
        # Single spec: standard Specification object (existing behavior)
        spec_json="{\"Container\":${container_spec},\"StartupParameters\":{\"ContainerStartupHealthCheckTimeoutInSeconds\":${IC_STARTUP_TIMEOUT:-900}},\"ComputeResourceRequirements\":{\"NumberOfAcceleratorDevicesRequired\":${IC_GPU_COUNT:-1},\"MinMemoryRequiredInMb\":${IC_MIN_MEMORY_MB:-1024}}}"
    fi

    echo "📦 Creating inference component: ${ic_name}"
    if ! aws sagemaker create-inference-component \
        --inference-component-name "${ic_name}" \
        --endpoint-name "${ENDPOINT_NAME}" \
        --variant-name "AllTraffic" \
        --specification "${spec_json}" \
        --runtime-config "{\"CopyCount\": ${IC_COPY_COUNT:-1}}" \
        --region "${AWS_REGION}"; then

        echo "❌ Failed to create inference component: ${ic_name}"
        echo "   Check that:"
        echo "   • The endpoint is InService: ${ENDPOINT_NAME}"
        echo "   • The container image exists: ${ECR_REPOSITORY}:${IC_IMAGE_TAG:-${PROJECT_NAME}-latest}"
        echo "   • GPU count (${IC_GPU_COUNT:-1}) does not exceed instance capacity"
        echo "   • You have sufficient permissions for sagemaker:CreateInferenceComponent"
        exit 4
    fi

    # Persist deployed name and timestamp back to IC config
    IC_DEPLOYED_NAME="${ic_name}"
    IC_DEPLOYED_AT="${ic_timestamp}"
    _update_config_var "IC_DEPLOYED_NAME" "${ic_name}" "${ic_conf}"
    _update_config_var "IC_DEPLOYED_AT" "${ic_timestamp}" "${ic_conf}"

    echo "✅ Inference component created: ${ic_name}"
    echo "${ic_name}"
}

# create_inference_component_legacy()
#   Backward-compatible IC creation for projects without do/ic/ directory.
#   Reads IC_GPU_COUNT from do/config (already sourced) and IMAGE_TAG from caller scope.
#   Uses the same endpoint and container env as the multi-IC path.
#
#   Sets IC_DEPLOYED_NAME in the caller's scope (for use by wait_ic).
#   Persists INFERENCE_COMPONENT_NAME to do/config.
create_inference_component_legacy() {
    local ic_timestamp
    ic_timestamp=$(date +%s)
    local ic_name="${PROJECT_NAME}-ic-${ic_timestamp}"

    # Build container spec JSON (uses IMAGE_TAG from caller scope)
    local container_spec="{\"Image\":\"${ECR_REPOSITORY}:${IMAGE_TAG}\""
    if [ -n "${CONTAINER_ENV_JSON}" ]; then
        container_spec="${container_spec},\"Environment\":{${CONTAINER_ENV_JSON}}"
    fi
    container_spec="${container_spec}}"

    echo "📦 Creating inference component: ${ic_name}"
    if ! aws sagemaker create-inference-component \
        --inference-component-name "${ic_name}" \
        --endpoint-name "${ENDPOINT_NAME}" \
        --variant-name "AllTraffic" \
        --specification "{
            \"Container\": ${container_spec},
            \"StartupParameters\": {
                \"ContainerStartupHealthCheckTimeoutInSeconds\": 900
            },
            \"ComputeResourceRequirements\": {
                \"NumberOfAcceleratorDevicesRequired\": ${IC_GPU_COUNT:-1},
                \"MinMemoryRequiredInMb\": 1024
            }
        }" \
        --runtime-config "{\"CopyCount\": 1}" \
        --region "${AWS_REGION}"; then

        echo "❌ Failed to create inference component: ${ic_name}"
        echo "   Check that:"
        echo "   • The endpoint is InService: ${ENDPOINT_NAME}"
        echo "   • The container image exists: ${ECR_REPOSITORY}:${IMAGE_TAG}"
        echo "   • GPU count (${IC_GPU_COUNT:-1}) does not exceed instance capacity"
        echo "   • You have sufficient permissions for sagemaker:CreateInferenceComponent"
        exit 4
    fi

    # Set in caller's scope for wait_ic
    IC_DEPLOYED_NAME="${ic_name}"
    IC_DEPLOYED_AT="${ic_timestamp}"

    # Persist to do/config for legacy compatibility
    _update_config_var "INFERENCE_COMPONENT_NAME" "${ic_name}"
    _update_config_var "IC_DEPLOYED_AT" "${ic_timestamp}"

    echo "✅ Inference component created: ${ic_name}"
}
