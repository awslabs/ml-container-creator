#!/usr/bin/env bash
# deployment-state.sh — Shared library for deployment existence checks.
# Source this file in do/ scripts that operate against an active deployment.
#
# Provides:
#   _check_active_deployment  — verify a deployment exists at the current DEPLOYMENT_TARGET
#
# Behavior:
#   - If no active deployment found: prints helpful message + exits 0 (graceful, not error)
#   - If deployment is active: returns silently (success)
#
# Usage:
#   source "${SCRIPT_DIR}/lib/deployment-state.sh"
#   _check_active_deployment
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

_check_active_deployment() {
    local target="${DEPLOYMENT_TARGET:-managed-inference}"

    case "$target" in
        hyperpod-eks)
            local namespace="${HP_NAMESPACE:-${PROJECT_NAME:-default}}"
            local deploy_name="${HP_DEPLOYMENT_NAME:-${PROJECT_NAME:-app}}"

            if ! command -v kubectl &>/dev/null; then
                echo "⚠️  kubectl not found. Cannot verify HyperPod deployment state."
                echo "   Install kubectl: https://kubernetes.io/docs/tasks/tools/"
                return 0
            fi

            if ! kubectl rollout status "deployment/${deploy_name}" -n "${namespace}" --timeout=5s &>/dev/null 2>&1; then
                echo "⚠️  No active HyperPod deployment found for '${deploy_name}' in namespace '${namespace}'."
                echo "   Deploy first: ./do/deploy --target hyperpod-eks"
                exit 0
            fi
            ;;

        managed-inference|realtime-inference)
            local endpoint_name="${ENDPOINT_NAME:-${PROJECT_NAME:-}}"

            if [ -z "${endpoint_name}" ]; then
                echo "⚠️  No ENDPOINT_NAME configured. Cannot verify deployment state."
                echo "   Deploy first: ./do/deploy --target managed-inference"
                exit 0
            fi

            if ! command -v aws &>/dev/null; then
                echo "⚠️  AWS CLI not found. Cannot verify endpoint state."
                return 0
            fi

            local status
            status=$(aws sagemaker describe-endpoint \
                --endpoint-name "${endpoint_name}" \
                --region "${AWS_REGION:-us-east-1}" \
                --query "EndpointStatus" \
                --output text 2>/dev/null) || status=""

            if [ "${status}" != "InService" ]; then
                echo "⚠️  Endpoint '${endpoint_name}' is not InService (status: ${status:-not found})."
                echo "   Deploy first: ./do/deploy --target managed-inference"
                exit 0
            fi
            ;;

        async-inference)
            local endpoint_name="${ENDPOINT_NAME:-${PROJECT_NAME:-}}-async"

            if [ -z "${endpoint_name}" ]; then
                echo "⚠️  No ENDPOINT_NAME configured for async inference."
                echo "   Deploy first: ./do/deploy --target async-inference"
                exit 0
            fi

            if ! command -v aws &>/dev/null; then
                echo "⚠️  AWS CLI not found. Cannot verify endpoint state."
                return 0
            fi

            local status
            status=$(aws sagemaker describe-endpoint \
                --endpoint-name "${endpoint_name}" \
                --region "${AWS_REGION:-us-east-1}" \
                --query "EndpointStatus" \
                --output text 2>/dev/null) || status=""

            if [ "${status}" != "InService" ]; then
                echo "⚠️  Async endpoint '${endpoint_name}' is not InService (status: ${status:-not found})."
                echo "   Deploy first: ./do/deploy --target async-inference"
                exit 0
            fi
            ;;

        *)
            # Unknown target — skip check, let the script fail naturally
            return 0
            ;;
    esac
}
