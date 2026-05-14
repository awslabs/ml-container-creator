# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: resolve container secrets from Secrets Manager or direct values.
# Sourced by do/deploy — expects AWS_REGION to be set by the caller.

# resolve_secrets()
#   Resolves HF_TOKEN and NGC_API_KEY from either:
#     - AWS Secrets Manager (when *_ARN variables are set)
#     - Direct values (when the plain variables are set)
#   Sets the global CONTAINER_ENV_JSON variable with comma-separated "KEY":"value" pairs.
resolve_secrets() {
    CONTAINER_ENV_JSON=""

    if [ -n "${HF_TOKEN_ARN:-}" ]; then
        echo "🔐 Resolving HuggingFace token from Secrets Manager..."
        RESOLVED_HF_TOKEN=$(aws secretsmanager get-secret-value --secret-id "${HF_TOKEN_ARN}" --query SecretString --output text --region "${AWS_REGION}") || {
            echo "❌ Failed to resolve HuggingFace token from Secrets Manager"
            exit 3
        }
        CONTAINER_ENV_JSON="\"HF_TOKEN\":\"${RESOLVED_HF_TOKEN}\""
    elif [ -n "${HF_TOKEN:-}" ]; then
        CONTAINER_ENV_JSON="\"HF_TOKEN\":\"${HF_TOKEN}\""
    fi

    if [ -n "${NGC_API_KEY_ARN:-}" ]; then
        echo "🔐 Resolving NGC API key from Secrets Manager..."
        RESOLVED_NGC_KEY=$(aws secretsmanager get-secret-value --secret-id "${NGC_API_KEY_ARN}" --query SecretString --output text --region "${AWS_REGION}") || {
            echo "❌ Failed to resolve NGC API key from Secrets Manager"
            exit 3
        }
        if [ -n "${CONTAINER_ENV_JSON}" ]; then
            CONTAINER_ENV_JSON="${CONTAINER_ENV_JSON},\"NGC_API_KEY\":\"${RESOLVED_NGC_KEY}\""
        else
            CONTAINER_ENV_JSON="\"NGC_API_KEY\":\"${RESOLVED_NGC_KEY}\""
        fi
    elif [ -n "${NGC_API_KEY:-}" ]; then
        if [ -n "${CONTAINER_ENV_JSON}" ]; then
            CONTAINER_ENV_JSON="${CONTAINER_ENV_JSON},\"NGC_API_KEY\":\"${NGC_API_KEY}\""
        else
            CONTAINER_ENV_JSON="\"NGC_API_KEY\":\"${NGC_API_KEY}\""
        fi
    fi
}
