// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Feedback Loop — JavaScript equivalent of do/lib/feedback.sh
 *
 * Generates post-completion feedback output with artifact locations
 * and deployment suggestions based on artifact type.
 */

/**
 * Generate completion feedback output for a training/tuning job.
 *
 * Replicates the logic of print_completion_feedback() in do/lib/feedback.sh.
 *
 * @param {object} params
 * @param {string} params.outputPath - S3 URI to the output artifacts
 * @param {string} params.outputType - "adapter" or "full-model"
 * @param {string} params.jobName - Job name for reference
 * @param {string} [params.modelPackageArn] - Optional model package ARN
 * @returns {string} The formatted feedback output
 */
export function generateCompletionFeedback({ outputPath, outputType, jobName, modelPackageArn = '' }) {
    const lines = [];

    lines.push('');
    lines.push(`✅ Training complete: ${jobName}`);
    lines.push('');
    lines.push(`   Artifacts: ${outputPath}`);
    if (modelPackageArn) {
        lines.push(`   Model Package: ${modelPackageArn}`);
    }
    lines.push('');
    lines.push('   Next steps:');

    if (outputType === 'adapter') {
        lines.push(`     • Deploy as LoRA adapter:  ./do/adapter add my-adapter --weights ${outputPath}`);
        lines.push('     • (Requires running endpoint with LoRA enabled)');
    } else if (outputType === 'full-model') {
        lines.push(`     • Deploy as new IC:        ./do/add-ic my-model --model-data ${outputPath}`);
        lines.push(`     • Replace current base:    ./do/deploy --force-ic --model-data ${outputPath}`);
    }
    lines.push('');

    return lines.join('\n');
}
