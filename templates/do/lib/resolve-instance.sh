#!/usr/bin/env bash
# Lazy instance type resolution for heterogeneous pool endpoints.
# Source this file after do/config + lib/profile.sh in any script that needs INSTANCE_TYPE.
#
# When INSTANCE_TYPE is empty (pool endpoints) and DEPLOYED_INSTANCE_TYPE hasn't been
# persisted yet (no do/deploy run), queries the live endpoint once and persists the result.
# Subsequent calls read from do/config without any AWS API calls.
#
# After sourcing, INSTANCE_TYPE is guaranteed to be set (or empty if resolution failed).
# DEPLOYED_GPU_COUNT is also resolved from a static lookup table (instances.json catalog)
# and persisted to do/config alongside the instance type.
#
# Usage:
#   source "${SCRIPT_DIR}/config"
#   source "${SCRIPT_DIR}/lib/profile.sh"
#   source "${SCRIPT_DIR}/lib/resolve-instance.sh"
#   # INSTANCE_TYPE and DEPLOYED_GPU_COUNT are now resolved

# Resolve SCRIPT_DIR if not already set (defensive — normally inherited from caller)
if [ -z "${SCRIPT_DIR:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Skip if INSTANCE_TYPE is already set (single-instance endpoints)
if [ -n "${INSTANCE_TYPE:-}" ]; then
    return 0 2>/dev/null || true
fi

# Check if DEPLOYED_INSTANCE_TYPE was previously persisted
if [ -n "${DEPLOYED_INSTANCE_TYPE:-}" ]; then
    INSTANCE_TYPE="${DEPLOYED_INSTANCE_TYPE}"
    export INSTANCE_TYPE
    # Ensure DEPLOYED_GPU_COUNT is also exported (may already be in do/config)
    if [ -n "${DEPLOYED_GPU_COUNT:-}" ]; then
        export DEPLOYED_GPU_COUNT
    fi
    return 0 2>/dev/null || true
fi

# Check if BENCHMARK_INSTANCE_TYPE was previously persisted (by do/benchmark)
if [ -n "${BENCHMARK_INSTANCE_TYPE:-}" ]; then
    INSTANCE_TYPE="${BENCHMARK_INSTANCE_TYPE}"
    export INSTANCE_TYPE
    return 0 2>/dev/null || true
fi

# ── Live resolution from endpoint (one-time, persisted) ──────────────────────
# Only attempt if ENDPOINT_NAME is configured and AWS credentials are available.
if [ -z "${ENDPOINT_NAME:-}" ]; then
    return 0 2>/dev/null || true
fi

_RESOLVED_INSTANCE=""
_EP_DESCRIBE=$(aws sagemaker describe-endpoint \
    --endpoint-name "${ENDPOINT_NAME}" \
    --region "${AWS_REGION:-us-east-1}" \
    --output json 2>/dev/null) || _EP_DESCRIBE=""

if [ -n "${_EP_DESCRIBE}" ]; then
    _RESOLVED_INSTANCE=$(echo "${_EP_DESCRIBE}" | python3 -c "
import sys, json
try:
    ep = json.load(sys.stdin)
    variant = ep.get('ProductionVariants', [{}])[0]
    print(variant.get('CurrentInstanceType') or variant.get('InstanceType') or '')
except:
    print('')
" 2>/dev/null) || _RESOLVED_INSTANCE=""

    # Fallback: query endpoint config for InstanceType or first pool entry
    if [ -z "${_RESOLVED_INSTANCE}" ]; then
        _EC_NAME=$(echo "${_EP_DESCRIBE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('EndpointConfigName',''))" 2>/dev/null) || _EC_NAME=""
        if [ -n "${_EC_NAME}" ]; then
            _RESOLVED_INSTANCE=$(aws sagemaker describe-endpoint-config \
                --endpoint-config-name "${_EC_NAME}" \
                --region "${AWS_REGION:-us-east-1}" \
                --query 'ProductionVariants[0].InstanceType' \
                --output text 2>/dev/null) || _RESOLVED_INSTANCE=""
            [ "${_RESOLVED_INSTANCE}" = "None" ] && _RESOLVED_INSTANCE=""

            # Final fallback: first entry in InstancePools
            if [ -z "${_RESOLVED_INSTANCE}" ]; then
                _RESOLVED_INSTANCE=$(aws sagemaker describe-endpoint-config \
                    --endpoint-config-name "${_EC_NAME}" \
                    --region "${AWS_REGION:-us-east-1}" \
                    --output json 2>/dev/null | python3 -c "
import sys, json
try:
    ec = json.load(sys.stdin)
    pools = ec.get('ProductionVariants', [{}])[0].get('InstancePools', [])
    if pools:
        best = min(pools, key=lambda p: p.get('Priority', 999))
        print(best.get('InstanceType', ''))
    else:
        print('')
except:
    print('')
" 2>/dev/null) || _RESOLVED_INSTANCE=""
            fi
        fi
    fi
fi

# Persist to do/config (one-time write — subsequent sources read it directly)
if [ -n "${_RESOLVED_INSTANCE}" ]; then
    _config_file="${SCRIPT_DIR}/config"
    if grep -q "^export DEPLOYED_INSTANCE_TYPE=" "${_config_file}" 2>/dev/null; then
        sed -i.bak "s|^export DEPLOYED_INSTANCE_TYPE=.*|export DEPLOYED_INSTANCE_TYPE=\"${_RESOLVED_INSTANCE}\"|" "${_config_file}"
        rm -f "${_config_file}.bak"
    else
        echo "export DEPLOYED_INSTANCE_TYPE=\"${_RESOLVED_INSTANCE}\"" >> "${_config_file}"
    fi
    INSTANCE_TYPE="${_RESOLVED_INSTANCE}"
    DEPLOYED_INSTANCE_TYPE="${_RESOLVED_INSTANCE}"
    export INSTANCE_TYPE DEPLOYED_INSTANCE_TYPE

    # ── Resolve GPU count from instance type ─────────────────────────────────
    # Static lookup table derived from servers/lib/catalogs/instances.json.
    # Maps known SageMaker instance types to their GPU count.
    _resolve_gpu_count() {
        case "$1" in
            ml.g5.xlarge|ml.g5.2xlarge|ml.g5.4xlarge|ml.g5.8xlarge|ml.g5.16xlarge) echo 1 ;;
            ml.g5.12xlarge|ml.g5.24xlarge) echo 4 ;;
            ml.g5.48xlarge) echo 8 ;;
            ml.g4dn.xlarge|ml.g4dn.2xlarge|ml.g4dn.4xlarge|ml.g4dn.8xlarge|ml.g4dn.16xlarge) echo 1 ;;
            ml.g4dn.12xlarge) echo 4 ;;
            ml.g6.xlarge|ml.g6.2xlarge|ml.g6.4xlarge|ml.g6.8xlarge|ml.g6.16xlarge) echo 1 ;;
            ml.g6.12xlarge|ml.g6.24xlarge) echo 4 ;;
            ml.g6.48xlarge) echo 8 ;;
            ml.g6e.xlarge|ml.g6e.2xlarge|ml.g6e.4xlarge|ml.g6e.8xlarge|ml.g6e.16xlarge) echo 1 ;;
            ml.g6e.12xlarge|ml.g6e.24xlarge) echo 4 ;;
            ml.g6e.48xlarge) echo 8 ;;
            ml.p4d.24xlarge|ml.p4de.24xlarge) echo 8 ;;
            ml.p5.48xlarge|ml.p5e.48xlarge) echo 8 ;;
            *) echo "" ;;
        esac
    }

    _GPU_COUNT=$(_resolve_gpu_count "${_RESOLVED_INSTANCE}")
    if [ -n "${_GPU_COUNT}" ]; then
        if grep -q "^export DEPLOYED_GPU_COUNT=" "${_config_file}" 2>/dev/null; then
            sed -i.bak "s|^export DEPLOYED_GPU_COUNT=.*|export DEPLOYED_GPU_COUNT=\"${_GPU_COUNT}\"|" "${_config_file}"
            rm -f "${_config_file}.bak"
        else
            echo "export DEPLOYED_GPU_COUNT=\"${_GPU_COUNT}\"" >> "${_config_file}"
        fi
        DEPLOYED_GPU_COUNT="${_GPU_COUNT}"
        export DEPLOYED_GPU_COUNT
    fi
    unset _GPU_COUNT
    unset -f _resolve_gpu_count
fi

# Clean up internal vars
unset _RESOLVED_INSTANCE _EP_DESCRIBE _EC_NAME
