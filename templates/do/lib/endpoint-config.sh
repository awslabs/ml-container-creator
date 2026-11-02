# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: create SageMaker endpoint configuration.
# Sourced by do/deploy — expects PROJECT_NAME, AWS_REGION to be set by the caller.
# One of INSTANCE_TYPE or INSTANCE_POOLS must be set (mutually exclusive).
# Optional: ROLE_ARN, INFERENCE_AMI_VERSION, CAPACITY_RESERVATION_ARN, ASYNC_INFERENCE_CONFIG,
#           POOL_TIMEOUT (default: 1200), POOL_INSTANCE_COUNT (default: 1), MODEL_NAME_SM,
#           STZ_ACTIVE + SCALE_MAX_CAPACITY (scale-to-zero, set by do/lib/scale-to-zero.sh).

# Directory of this file (do/lib in a project, templates/do/lib in the source
# tree) — locates the python/inference_ami.py helper next to it.
_ENDPOINT_CONFIG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _check_inference_ami <comma-separated instance types> [pool]
#   Checks INFERENCE_AMI_VERSION against the AWS AMI <-> instance-family table
#   (BL209). The table is DATA, not code: fleet-drivers.json
#   ami_versions[*].default_families / override_families (copied from
#   https://docs.aws.amazon.com/sagemaker/latest/dg/inference-gpu-drivers.html),
#   read by do/lib/python/inference_ami.py (.mlcc/fleet-drivers.json in a
#   generated project).
#   - INFERENCE_AMI_VERSION set but not AWS-listed for a family: loud warning,
#     the value is kept (there is no AMI-specific override flag).
#   - pool: exits 1 when no AMI is AWS-listed for every pool family, or a GPU
#     family is mixed with a Trainium / Inferentia family. With
#     INFERENCE_AMI_VERSION empty, sets it (this run only) to the AMI resolved
#     for the pool; empty means "omit" (SageMaker family default).
#   - unknown families are skipped; python3 / catalog missing only warns.
_check_inference_ami() {
    local types="$1"
    local mode="${2:-}"
    local helper="${_ENDPOINT_CONFIG_LIB_DIR}/python/inference_ami.py"
    if ! command -v python3 >/dev/null 2>&1 || [ ! -f "${helper}" ]; then
        echo "   ⚠️  InferenceAmiVersion compatibility not checked (python3 or ${helper} not found)"
        return 0
    fi
    local -a args=(resolve --instance-types "${types}" --ami "${INFERENCE_AMI_VERSION:-}")
    if [ "${mode}" = "pool" ]; then
        args+=(--pool)
    fi
    local out=""
    local rc=0
    out=$(python3 "${helper}" "${args[@]}") || rc=$?
    printf '%s\n' "${out}" | grep -v '^__AMI__=' || true
    if [ "${rc}" -eq 1 ]; then
        exit 1
    fi
    local resolved=""
    resolved=$(printf '%s\n' "${out}" | sed -n 's/^__AMI__=//p')
    if [ "${mode}" = "pool" ] && [ -z "${INFERENCE_AMI_VERSION:-}" ] && [ -n "${resolved}" ]; then
        INFERENCE_AMI_VERSION="${resolved}"
        echo "   AMI version resolved for pool: ${resolved} (AWS-listed for every pool family)"
    fi
    return 0
}

# _validate_instance_pools()
#   Validates that all instance types in INSTANCE_POOLS can share ONE
#   InferenceAmiVersion that AWS lists for every pool family (derived from
#   fleet-drivers.json via _check_inference_ami — no hand-coded generation map).
#   - Cannot mix NVIDIA GPU and Trainium / Inferentia types
#   - Unknown instance types produce a warning but do not block deployment
#   Exits with error if incompatible types are detected.
_validate_instance_pools() {
    # Extract instance types from INSTANCE_POOLS JSON
    # INSTANCE_POOLS format: [{"InstanceType":"ml.g6e.48xlarge","Priority":1},...]
    # Use simple string parsing to extract InstanceType values
    local pool_types=""
    pool_types=$(echo "${INSTANCE_POOLS}" | grep -oE '"InstanceType"\s*:\s*"[^"]+"' | sed 's/"InstanceType"\s*:\s*"//;s/"$//' || true)

    if [ -z "${pool_types}" ]; then
        return 0
    fi

    local types_csv=""
    types_csv=$(printf '%s\n' "${pool_types}" | tr '\n' ',' | sed 's/,*$//')
    _check_inference_ami "${types_csv}" pool
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
        # RoutingConfig is required for IC-based endpoints — without it the IC scheduler
        # cannot place containers and the IC stays in Creating with no logs.
        variant_json="[{\"VariantName\":\"AllTraffic\",\"InstanceType\":\"${INSTANCE_TYPE}\",\"InitialInstanceCount\":1,\"RoutingConfig\":{\"RoutingStrategy\":\"LEAST_OUTSTANDING_REQUESTS\"}"

        # Optional: AMI version (warn when AWS does not list it for the family, BL209)
        if [ -n "${INFERENCE_AMI_VERSION:-}" ] && [ -n "${INSTANCE_TYPE:-}" ]; then
            _check_inference_ami "${INSTANCE_TYPE}"
        fi
        if [ -n "${INFERENCE_AMI_VERSION:-}" ]; then
            variant_json="${variant_json},\"InferenceAmiVersion\":\"${INFERENCE_AMI_VERSION}\""
            echo "   AMI version: ${INFERENCE_AMI_VERSION}"
        fi

        # Optional: capacity reservation
        if [ -n "${CAPACITY_RESERVATION_ARN:-}" ]; then
            variant_json="${variant_json},\"CapacityReservationConfig\":{\"CapacityReservationPreference\":\"capacity-reservations-only\",\"MlReservationArn\":\"${CAPACITY_RESERVATION_ARN}\"}"
            echo "   ✓ Capacity reservation: ${CAPACITY_RESERVATION_ARN}"
        fi

        # Wave 10 (ADR-014 R3.1): scale-to-zero needs ManagedInstanceScaling with
        # MinInstanceCount 0 on the variant. Only when do/lib/scale-to-zero.sh set
        # STZ_ACTIVE=true (opted in, target enabled); otherwise the variant is
        # byte-identical to before.
        if [ "${STZ_ACTIVE:-false}" = "true" ] && type stz_variant_scaling_json >/dev/null 2>&1; then
            variant_json="${variant_json}$(stz_variant_scaling_json)"
            echo "   ✓ Scale-to-zero: ManagedInstanceScaling min 0, max ${SCALE_MAX_CAPACITY:-1}"
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

    # BL086 / BL081: SageMaker AI detailed observability (engine + DCGM metrics
    # via the AWS-managed OTel collector) needs no extra arguments here.
    #
    # - MetricsConfig.EnableDetailedObservability defaults to true for endpoint
    #   configs created after 2026-06-17, so new configs get it without asking.
    #   https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-detailed-observability-getting-started.html
    #   https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_MetricsConfig.html
    # - For custom (BYOC) containers the collector scrapes Prometheus metrics at
    #   the default path /metrics on port 8080, which is what the MLCC vLLM,
    #   SGLang and llama.cpp images expose (serve.d manifests, metrics_endpoint).
    #
    # Non-default settings go in two different places (neither is needed today):
    # - Endpoint config: --metrics-config '{"EnableDetailedObservability":...,
    #   "MetricPublishFrequencyInSeconds":10}' (CreateEndpointConfig MetricsConfig).
    # - A non-default metrics PATH: ContainerMetricsConfig on the container spec
    #   (InferenceComponentContainerSpecification for create-inference-component,
    #   or ContainerDefinition for create-model). CreateEndpointConfig has NO
    #   container-metrics option, and MetricsEndpoint has no Port member.
    #
    # Account-level OTel enrichment (aws cloudwatch start-otel-enrichment) is NOT
    # what gates detailed-observability data (verified Wave 9: vLLM + DCGM series
    # flow with enrichment Stopped); it only mirrors classic-only metrics to OTel.

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
