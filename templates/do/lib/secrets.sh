# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: build the container secret environment for SageMaker deploys.
# Sourced by do/deploy.d/{realtime-inference,async-inference,batch-transform}.
# Expects AWS_REGION to be set by the caller.
#
# BL212: secrets are passed BY REFERENCE. The deploy writes HF_TOKEN_ARN /
# NGC_API_KEY_ARN into the container Environment, never the secret value. The
# container entrypoint (code/serve) resolves the ARN at startup with the
# SageMaker execution role. A plaintext value in the container Environment is
# returned by DescribeModel / DescribeInferenceComponent / DescribeEndpointConfig
# and recorded in CloudTrail request parameters, so it is refused unless the
# user explicitly opts in with `do/deploy --allow-plaintext-secret`
# (exported as MLCC_ALLOW_PLAINTEXT_SECRET=true by the dispatcher).

# Secret-name prefixes the bootstrap execution role may read
# (SecretsManagerRead in infra/bootstrap-modules/core/stack.ts). Used only for a
# warning. test/unit/test_container_secrets_guard.py asserts the two lists agree.
_MLCC_SECRET_READ_PREFIXES="mlcc/ ml-container-creator/ mlcc-hf-token-"

# _mlcc_append_container_env <key> <value>
#   Appends one "KEY":"value" pair to CONTAINER_ENV_JSON.
_mlcc_append_container_env() {
    if [ -n "${CONTAINER_ENV_JSON}" ]; then
        CONTAINER_ENV_JSON="${CONTAINER_ENV_JSON},\"$1\":\"$2\""
    else
        CONTAINER_ENV_JSON="\"$1\":\"$2\""
    fi
}

# _mlcc_plaintext_secrets_allowed
#   True when the user passed --allow-plaintext-secret to do/deploy.
_mlcc_plaintext_secrets_allowed() {
    [ "${MLCC_ALLOW_PLAINTEXT_SECRET:-false}" = "true" ]
}

# _mlcc_refuse_plaintext_secret <VAR> <profile-secret-type> <secrets-create-type>
#   Prints why a plaintext secret is refused and how to pass it by reference.
_mlcc_refuse_plaintext_secret() {
    local var="$1" profile_type="$2" create_type="$3"
    echo "❌ ${var} is set as a plaintext value and no ${var}_ARN is configured."
    echo "   MLCC does not write plaintext secrets into the SageMaker container Environment:"
    echo "   that value is returned by SageMaker Describe* APIs and recorded in CloudTrail."
    echo ""
    echo "   Store it in Secrets Manager and pass the ARN instead:"
    echo "     ml-container-creator secrets create --type ${create_type} --name <label> --secret-value <value>"
    echo "     mcc bootstrap add-secret ${profile_type} <secret-arn>"
    echo "   or set  export ${var}_ARN=<secret-arn>  in do/config."
    echo "   The container resolves the ARN at startup with the execution role."
    echo ""
    echo "   If this model does not need ${var}, unset it:  unset ${var}"
    echo "   To deploy with the plaintext value anyway:  ./do/deploy --allow-plaintext-secret"
}

# _mlcc_warn_plaintext_secret <VAR>
_mlcc_warn_plaintext_secret() {
    echo "⚠️  --allow-plaintext-secret: writing ${1} into the container Environment as plaintext."
    echo "   Anyone with SageMaker Describe* permissions, and CloudTrail readers, can read it."
    echo "   Prefer ${1}_ARN (Secrets Manager); rotate the value if this endpoint is shared."
}

# _mlcc_secret_ref <VAR> <arn-or-name>
#   Prints the secret reference to put in the container Environment. Resolves a
#   secret name or partial ARN to its full ARN with DescribeSecret (metadata
#   only, never the value) so the container can derive the region from it.
#   Warns, without failing, when the secret cannot be described or its name is
#   outside the prefixes the bootstrap execution role can read.
_mlcc_secret_ref() {
    local var="$1" ref="$2"
    local full_arn=""
    full_arn=$(aws secretsmanager describe-secret --secret-id "${ref}" --query ARN --output text --region "${AWS_REGION}" 2>/dev/null) || full_arn=""
    if [ -n "${full_arn}" ] && [ "${full_arn}" != "None" ]; then
        ref="${full_arn}"
    else
        echo "⚠️  Could not describe ${var}_ARN secret (${ref}). Continuing; the container" >&2
        echo "   fails at startup if the execution role cannot read it." >&2
    fi
    local name="${ref}"
    case "${ref}" in
        arn:*:secret:*) name="${ref#*:secret:}" ;;
    esac
    local prefix readable=false
    for prefix in ${_MLCC_SECRET_READ_PREFIXES}; do
        case "${name}" in
            "${prefix}"*) readable=true ;;
        esac
    done
    if [ "${readable}" != "true" ]; then
        echo "⚠️  ${var}_ARN secret '${name}' is outside the names the MLCC bootstrap execution" >&2
        echo "   role can read (${_MLCC_SECRET_READ_PREFIXES}). Grant secretsmanager:GetSecretValue" >&2
        echo "   on it to ROLE_ARN, or the container fails at startup." >&2
    fi
    echo "${ref}"
}

# resolve_secrets()
#   Sets the global CONTAINER_ENV_JSON variable with comma-separated "KEY":"value"
#   pairs for HF_TOKEN and NGC_API_KEY:
#     - *_ARN set (do/config, else the active bootstrap profile secret, BL076):
#       "HF_TOKEN_ARN":"<arn>" — the reference, never the value.
#     - only the plaintext variable set: refused (exit 3) unless
#       --allow-plaintext-secret, which writes it with a warning.
resolve_secrets() {
    CONTAINER_ENV_JSON=""
    local _hf_arn="${HF_TOKEN_ARN:-${_PROFILE_secrets_hfToken:-}}"
    local _ngc_arn="${NGC_API_KEY_ARN:-${_PROFILE_secrets_ngcApiKey:-}}"
    local _ref
    if [ -n "${_hf_arn}" ]; then
        echo "🔐 Passing HuggingFace token by reference (HF_TOKEN_ARN); the container resolves it at startup"
        _ref=$(_mlcc_secret_ref HF_TOKEN "${_hf_arn}")
        _mlcc_append_container_env "HF_TOKEN_ARN" "${_ref}"
    elif [ -n "${HF_TOKEN:-}" ]; then
        if ! _mlcc_plaintext_secrets_allowed; then
            _mlcc_refuse_plaintext_secret HF_TOKEN hfToken hf-token
            exit 3
        fi
        _mlcc_warn_plaintext_secret HF_TOKEN
        _mlcc_append_container_env "HF_TOKEN" "${HF_TOKEN}"
    fi
    if [ -n "${_ngc_arn}" ]; then
        echo "🔐 Passing NGC API key by reference (NGC_API_KEY_ARN); the container resolves it at startup"
        _ref=$(_mlcc_secret_ref NGC_API_KEY "${_ngc_arn}")
        _mlcc_append_container_env "NGC_API_KEY_ARN" "${_ref}"
    elif [ -n "${NGC_API_KEY:-}" ]; then
        if ! _mlcc_plaintext_secrets_allowed; then
            _mlcc_refuse_plaintext_secret NGC_API_KEY ngcApiKey ngc-token
            exit 3
        fi
        _mlcc_warn_plaintext_secret NGC_API_KEY
        _mlcc_append_container_env "NGC_API_KEY" "${NGC_API_KEY}"
    fi
}
