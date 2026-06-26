# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: create SageMaker inference components.
# Sourced by do/deploy — expects the following to be set by the caller:
#   PROJECT_NAME, ENDPOINT_NAME, ECR_REPOSITORY, AWS_REGION, CONTAINER_ENV_JSON
# Also expects _update_config_var() to be available (from wait.sh).

# _collect_ic_env_vars()
#   Reads IC_ENV_* prefixed variables from the environment (sourced from do/config),
#   strips the IC_ENV_ prefix, validates constraints, and outputs JSON key-value pairs.
#   Constraints: max 16 entries, max 1024 chars per key/value.
#   IC_ENV_* overrides take precedence over CONTAINER_ENV_JSON.
#
#   Sets IC_ENV_OVERRIDE in the caller's scope.
_collect_ic_env_vars() {
    IC_ENV_OVERRIDE=""
    local ic_env_count=0

    while IFS='=' read -r full_key value; do
        # Skip empty lines
        [ -z "${full_key}" ] && continue

        local stripped_key="${full_key#IC_ENV_}"

        # Validate key length (AC-3.4)
        if [ ${#stripped_key} -gt 1024 ]; then
            echo "⚠️  IC_ENV_${stripped_key}: key exceeds 1024 chars, skipping" >&2
            continue
        fi

        # Validate value length (AC-3.4)
        if [ ${#value} -gt 1024 ]; then
            echo "⚠️  IC_ENV_${stripped_key}: value exceeds 1024 chars, skipping" >&2
            continue
        fi

        ic_env_count=$((ic_env_count + 1))

        # Max 16 env vars (AC-3.3)
        if [ ${ic_env_count} -gt 16 ]; then
            echo "⚠️  More than 16 IC_ENV_* variables defined. Using first 16 only." >&2
            break
        fi

        if [ -n "${IC_ENV_OVERRIDE}" ]; then
            IC_ENV_OVERRIDE="${IC_ENV_OVERRIDE},"
        fi
        IC_ENV_OVERRIDE="${IC_ENV_OVERRIDE}\"${stripped_key}\":\"${value}\""
    done < <(env | grep "^IC_ENV_" | sort)
}

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
#   IC_ENV_* prefixed vars from do/config are collected, validated, and passed
#   as the Environment field in InferenceComponent.create() via SDK v3.
#   Precedence: IC_ENV_* > IC_CONTAINER_ENV_EXTRA > CONTAINER_ENV_JSON
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

    # Collect IC_ENV_* overrides from environment (sourced from do/config)
    _collect_ic_env_vars

    local ic_timestamp
    ic_timestamp=$(date +%s)
    local ic_basename
    ic_basename=$(basename "${ic_conf}" .conf)
    local ic_name="${PROJECT_NAME}-${ic_basename}-${ic_timestamp}"

    # Build container spec JSON
    local container_spec="{\"Image\":\"${ECR_REPOSITORY}:${IC_IMAGE_TAG:-${PROJECT_NAME}-latest}\""
    # Always inject IC name for CW log forwarder
    local ic_env="\"INFERENCE_COMPONENT_NAME\":\"${ic_name}\""
    # Build environment JSON with precedence: IC_ENV_* > IC_CONTAINER_ENV_EXTRA > CONTAINER_ENV_JSON
    local env_json="${CONTAINER_ENV_JSON}"
    [ -n "${IC_CONTAINER_ENV_EXTRA:-}" ] && env_json="${env_json:+${env_json},}${IC_CONTAINER_ENV_EXTRA}"
    [ -n "${IC_ENV_OVERRIDE:-}" ] && env_json="${env_json:+${env_json},}${IC_ENV_OVERRIDE}"
    if [ -n "${env_json}" ]; then
        container_spec="${container_spec},\"Environment\":{${ic_env},${env_json}}"
    else
        container_spec="${container_spec},\"Environment\":{${ic_env}}"
    fi
    container_spec="${container_spec}}"

    # Build specification JSON — multi-spec (Specifications array) or single (Specification object)
    local spec_json
    # Always use singular Specification. For heterogeneous instance pools, the IC
    # declares its minimum resource requirements and SageMaker places it on whatever
    # instance was provisioned from the pool. Multi-spec (Specifications plural) is
    # only needed when you want different configurations per instance type (e.g.,
    # different TP, different model artifact) — a future optimization.
    spec_json="{\"Container\":${container_spec},\"StartupParameters\":{\"ContainerStartupHealthCheckTimeoutInSeconds\":${IC_STARTUP_TIMEOUT:-900}},\"ComputeResourceRequirements\":{\"NumberOfAcceleratorDevicesRequired\":${IC_GPU_COUNT:-1},\"MinMemoryRequiredInMb\":${IC_MIN_MEMORY_MB:-1024}}}"

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
