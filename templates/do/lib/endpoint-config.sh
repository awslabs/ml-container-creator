# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: create SageMaker endpoint configuration.
# Sourced by do/deploy — expects PROJECT_NAME, AWS_REGION to be set by the caller.
# One of INSTANCE_TYPE or INSTANCE_POOLS must be set (mutually exclusive).
# Optional: ROLE_ARN, INFERENCE_AMI_VERSION, CAPACITY_RESERVATION_ARN, ASYNC_INFERENCE_CONFIG,
#           POOL_TIMEOUT (default: 1200), POOL_INSTANCE_COUNT (default: 1), MODEL_NAME_SM.

# _validate_instance_pools()
#   Validates that all instance types in INSTANCE_POOLS are compatible:
#   - All types must share the same accelerator generation (same CUDA/AMI requirements)
#   - Cannot mix CUDA and Neuron accelerator types
#   - Unknown instance types produce a warning but do not block deployment
#
#   Uses a hardcoded map of instance type prefixes to their generation/AMI compatibility:
#     cuda-11 (AMI 2-x): g4dn, g5, g5g, p3, p4d, p4de
#     cuda-12 (AMI 3-x): g6, g6e, p5
#     cuda-next (AMI 4-x): p6, g7e
#     neuron: inf1, inf2, trn1
#
#   Exits with error if incompatible types are detected.
_validate_instance_pools() {
    # Map instance family prefixes to their generation
    # Format: "family_prefix=generation"
    local -a GENERATION_MAP=(
        "ml.g4dn.=cuda-11"
        "ml.g5.=cuda-11"
        "ml.g5g.=cuda-11"
        "ml.p3.=cuda-11"
        "ml.p4d.=cuda-11"
        "ml.p4de.=cuda-11"
        "ml.g6.=cuda-12"
        "ml.g6e.=cuda-12"
        "ml.p5.=cuda-12"
        "ml.p5e.=cuda-12"
        "ml.p5en.=cuda-12"
        "ml.p6.=cuda-next"
        "ml.g7e.=cuda-next"
        "ml.inf1.=neuron"
        "ml.inf2.=neuron"
        "ml.trn1.=neuron"
    )

    # Extract instance types from INSTANCE_POOLS JSON
    # INSTANCE_POOLS format: [{"InstanceType":"ml.g6e.48xlarge","Priority":1},...]
    # Use simple string parsing to extract InstanceType values
    local pool_types=""
    pool_types=$(echo "${INSTANCE_POOLS}" | grep -oE '"InstanceType"\s*:\s*"[^"]+"' | sed 's/"InstanceType"\s*:\s*"//;s/"$//' || true)

    if [ -z "${pool_types}" ]; then
        return 0
    fi

    local first_generation=""
    local first_type=""
    local has_unknown=false

    while IFS= read -r instance_type; do
        [ -z "${instance_type}" ] && continue

        local generation=""
        for entry in "${GENERATION_MAP[@]}"; do
            local prefix="${entry%%=*}"
            local gen="${entry##*=}"
            if [[ "${instance_type}" == ${prefix}* ]]; then
                generation="${gen}"
                break
            fi
        done

        if [ -z "${generation}" ]; then
            echo "   ⚠️  Unknown instance type in pool: ${instance_type} — skipping validation for this type"
            has_unknown=true
            continue
        fi

        if [ -z "${first_generation}" ]; then
            first_generation="${generation}"
            first_type="${instance_type}"
        elif [ "${generation}" != "${first_generation}" ]; then
            echo "❌ Cannot mix ${first_type} (${first_generation}) and ${instance_type} (${generation}) in same pool — different CUDA/AMI requirements"
            echo "   All instance types in a pool must share the same InferenceAmiVersion."
            echo ""
            echo "   Generation groupings:"
            echo "     cuda-11 (AMI 2-x): ml.g4dn.*, ml.g5.*, ml.p3.*, ml.p4d.*"
            echo "     cuda-12 (AMI 3-x): ml.g6.*, ml.g6e.*, ml.p5.*"
            echo "     neuron:            ml.inf1.*, ml.inf2.*, ml.trn1.*"
            echo ""
            echo "   Fix: use instance types from the same generation in your pool."
            exit 1
        fi
    done <<< "${pool_types}"
}

# create_endpoint_config()
#   Builds a ProductionVariant JSON and calls `aws sagemaker create-endpoint-config`.
#   Sets the global ENDPOINT_CONFIG_NAME variable for downstream use.
#
#   Behavior:
#     - INSTANCE_POOLS set: uses InstancePools array, RoutingConfig, VariantInstanceProvisionTimeoutInSeconds
#       Omits InstanceType entirely (mutually exclusive with pools)
#     - INSTANCE_POOLS not set: uses single INSTANCE_TYPE (standard path)
#     - INFERENCE_AMI_VERSION: appended to variant when set
#     - CAPACITY_RESERVATION_ARN: appended to variant when set (only for single instance type path)
#     - ASYNC_INFERENCE_CONFIG: passes --async-inference-config when set
#     - ROLE_ARN + no MODEL_NAME_SM: passes --execution-role-arn (IC-based real-time flow)
#     - MODEL_NAME_SM set: omits --execution-role-arn (model-based async flow)
create_endpoint_config() {
    # Mutual exclusivity: capacity reservations and instance pools cannot be used together.
    # Capacity reservations guarantee a specific instance type, while pools are for fallback
    # across multiple types. If both are set, prefer the reservation.
    if [ -n "${INSTANCE_POOLS:-}" ] && [ -n "${CAPACITY_RESERVATION_ARN:-}" ]; then
        echo "⚠️  Capacity reservations and instance pools are mutually exclusive. Using capacity reservation."
        unset INSTANCE_POOLS
    fi

    local timestamp
    timestamp=$(date +%s)
    ENDPOINT_CONFIG_NAME="${PROJECT_NAME}-epc-${timestamp}"

    local variant_json

    if [ -n "${INSTANCE_POOLS:-}" ]; then
        # Validate pool compatibility before proceeding
        _validate_instance_pools

        # Instance pools path: heterogeneous instance types with priority-based fallback
        echo "   Instance pools: enabled"

        # Transform ModelName → ModelNameOverride for the SageMaker API.
        # INSTANCE_POOLS config uses "ModelName" for readability; the API expects "ModelNameOverride"
        # as a sibling of InstanceType and Priority within each pool entry.
        local pools_json="${INSTANCE_POOLS}"
        if echo "${pools_json}" | grep -q '"ModelName"'; then
            pools_json=$(echo "${pools_json}" | sed 's/"ModelName"/"ModelNameOverride"/g')
            echo "   ModelNameOverride: per-pool model names detected"
        fi

        variant_json="[{\"VariantName\":\"AllTraffic\""
        variant_json="${variant_json},\"InstancePools\":${pools_json}"
        variant_json="${variant_json},\"InitialInstanceCount\":${POOL_INSTANCE_COUNT:-1}"
        variant_json="${variant_json},\"VariantInstanceProvisionTimeoutInSeconds\":${POOL_TIMEOUT:-1200}"
        variant_json="${variant_json},\"RoutingConfig\":{\"RoutingStrategy\":\"LEAST_OUTSTANDING_REQUESTS\"}"

        # Optional: AMI version
        if [ -n "${INFERENCE_AMI_VERSION:-}" ]; then
            variant_json="${variant_json},\"InferenceAmiVersion\":\"${INFERENCE_AMI_VERSION}\""
            echo "   AMI version: ${INFERENCE_AMI_VERSION}"
        fi

        variant_json="${variant_json}}]"
    else
        # Standard path: single instance type
        variant_json="[{\"VariantName\":\"AllTraffic\",\"InstanceType\":\"${INSTANCE_TYPE}\",\"InitialInstanceCount\":1"

        # Optional: AMI version
        if [ -n "${INFERENCE_AMI_VERSION:-}" ]; then
            variant_json="${variant_json},\"InferenceAmiVersion\":\"${INFERENCE_AMI_VERSION}\""
            echo "   AMI version: ${INFERENCE_AMI_VERSION}"
        fi

        # Optional: capacity reservation
        if [ -n "${CAPACITY_RESERVATION_ARN:-}" ]; then
            variant_json="${variant_json},\"CapacityReservationConfig\":{\"CapacityReservationPreference\":\"capacity-reservations-only\",\"MlReservationArn\":\"${CAPACITY_RESERVATION_ARN}\"}"
            echo "   ⚠️  Capacity reservation (experimental): ${CAPACITY_RESERVATION_ARN}"
        fi

        variant_json="${variant_json}}]"
    fi

    # Build the AWS CLI command arguments
    local -a cmd_args=(
        aws sagemaker create-endpoint-config
        --endpoint-config-name "${ENDPOINT_CONFIG_NAME}"
    )

    # Include --execution-role-arn for IC-based flow (real-time).
    # Omit for model-based flow (async) where MODEL_NAME_SM is set.
    if [ -n "${ROLE_ARN:-}" ] && [ -z "${MODEL_NAME_SM:-}" ]; then
        cmd_args+=(--execution-role-arn "${ROLE_ARN}")
    fi

    cmd_args+=(--production-variants "${variant_json}")

    # Optional: async inference config
    if [ -n "${ASYNC_INFERENCE_CONFIG:-}" ]; then
        cmd_args+=(--async-inference-config "${ASYNC_INFERENCE_CONFIG}")
    fi

    cmd_args+=(--region "${AWS_REGION}")

    echo "⚙️  Creating endpoint configuration: ${ENDPOINT_CONFIG_NAME}"
    if ! "${cmd_args[@]}"; then
        echo "❌ Failed to create endpoint configuration"
        echo "   Check that:"
        if [ -n "${ROLE_ARN:-}" ] && [ -z "${MODEL_NAME_SM:-}" ]; then
            echo "   • The execution role ARN is valid"
        fi
        if [ -n "${INSTANCE_POOLS:-}" ]; then
            echo "   • The instance pool types are valid and available in region: ${AWS_REGION}"
            echo "   • You have sufficient service quota for the pool instance types"
        else
            echo "   • The instance type is valid: ${INSTANCE_TYPE}"
            echo "   • The instance type is available in region: ${AWS_REGION}"
            echo "   • You have sufficient service quota for the instance type"
        fi
        if [ -n "${ASYNC_INFERENCE_CONFIG:-}" ]; then
            echo "   • The async inference config is valid JSON"
            echo "   • The S3 output path and SNS topics are accessible"
        fi
        exit 4
    fi

    echo "✅ Endpoint configuration created: ${ENDPOINT_CONFIG_NAME}"
}
