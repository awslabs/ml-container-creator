#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: post-completion feedback loop for training and tuning jobs.
# Sourced by do/tune and do/train — prints artifact locations and deployment suggestions.

# print_completion_feedback()
#   Display completion summary with artifact path and next-step deployment commands.
#   Tailors suggestions based on the detected artifact type (adapter vs full model).
#
#   Arguments:
#     $1 - output_path:       S3 URI to the output artifacts
#     $2 - output_type:       "adapter" or "full-model"
#     $3 - job_name:          Job name for reference
#     $4 - model_package_arn: (optional) Model package ARN if registered
print_completion_feedback() {
    local output_path="$1"
    local output_type="$2"
    local job_name="$3"
    local model_package_arn="${4:-}"

    echo ""
    echo "✅ Training complete: ${job_name}"
    echo ""
    echo "   Artifacts: ${output_path}"
    if [ -n "${model_package_arn}" ]; then
        echo "   Model Package: ${model_package_arn}"
    fi
    echo ""
    echo "   Next steps:"

    if [ "${output_type}" = "adapter" ]; then
        echo "     • Deploy as LoRA adapter:  ./do/adapter add my-adapter --weights ${output_path}"
        echo "     • (Requires running endpoint with LoRA enabled)"
    elif [ "${output_type}" = "full-model" ]; then
        echo "     • Deploy as new IC:        ./do/add-ic my-model --model-data ${output_path}"
        echo "     • Replace current base:    ./do/deploy --force-ic --model-data ${output_path}"
    fi
    echo ""
}
