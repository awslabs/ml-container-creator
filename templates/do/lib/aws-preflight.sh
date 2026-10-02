#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# aws-preflight.sh — Shared AWS credential preflight for do/ scripts.
#
# PATTERN: Shared library helper (single source of truth). Replaces the
#   credential-validation block that was copy-pasted across ~10 do/ scripts and
#   target dispatchers (push, submit, status, stage, deploy.d/*, clean.d/*), each
#   with slightly different wording and exit codes (1 vs an undocumented 4).
# COLLABORATORS: sourced by the scripts that need an AWS identity; pairs with
#   script-contract.sh (sourced first for the guard) — this helper is a general
#   runtime precondition, not a contract guard, so a failure is exit 1, not 3.
# DATA-FLOW ROLE: validates that AWS credentials resolve and exports
#   AWS_ACCOUNT_ID for the caller to build ARNs / ECR URIs.
# See: docs/architecture/do-scripts.md, docs/adr/ADR-007-do-script-contract-enforcement.md
#
# Usage:
#   source "${SCRIPT_DIR}/lib/aws-preflight.sh"
#   _aws_preflight            # silent — exports AWS_ACCOUNT_ID
#   _aws_preflight --verbose  # prints the 🔍 validating / ✅ validated lines
#
# On failure (no resolvable credentials) it prints the standard message and
# exits 1 (general error). On success it sets and exports AWS_ACCOUNT_ID.

_aws_preflight() {
    local verbose=false
    if [ "${1:-}" = "--verbose" ]; then
        verbose=true
    fi

    if [ "$verbose" = true ]; then
        echo "🔍 Validating AWS credentials..."
    fi

    if ! aws sts get-caller-identity &> /dev/null; then
        echo "❌ AWS credentials not configured or expired."
        echo "   • Run: aws configure"
        echo "   • Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables"
        echo "   • Or use an IAM role (recommended for EC2/ECS)"
        exit 1
    fi

    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    export AWS_ACCOUNT_ID

    if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
        echo "❌ Failed to get AWS account ID"
        exit 1
    fi

    if [ "$verbose" = true ]; then
        echo "✅ AWS credentials validated (Account: ${AWS_ACCOUNT_ID})"
    fi
}
