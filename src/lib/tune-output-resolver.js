// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Output Resolver
 *
 * Detects output type from training type and generates context-aware
 * next-step commands for deploying tune job artifacts.
 *
 * Requirements: 8.3, 8.11
 */

/**
 * Detect the output type based on the training type used for the job.
 * LoRA training produces adapter weights; full-rank produces a full model.
 *
 * @param {string} trainingType - The training type ('lora' or 'full-rank')
 * @returns {string} The output type: 'adapter' for lora, 'full-model' for full-rank
 */
export function detectOutputType(trainingType) {
    if (trainingType === 'lora') {
        return 'adapter';
    }
    if (trainingType === 'full-rank') {
        return 'full-model';
    }
    return 'adapter';
}

/**
 * Generate context-aware next-step commands based on the output type.
 *
 * For adapter output:
 *   - Quick path: ./do/adapter add tuned-${technique} --from-tune
 *   - Technique-specific: ./do/adapter add tuned-${technique} --from-tune ${technique}
 *   - Explicit path: ./do/adapter add tuned-${technique} --weights ${artifactPath}
 *
 * For full-model output:
 *   - Deploy as new IC: ./do/add-ic tuned-v1 --from-tune
 *   - Explicit path: ./do/add-ic tuned-v1 --model-data ${artifactPath}
 *   - Replace current base: ./do/deploy --force-ic --model-data ${artifactPath}
 *
 * @param {string} outputType - The output type ('adapter' or 'full-model')
 * @param {string} technique - The technique used (e.g., 'sft', 'dpo')
 * @param {string} artifactPath - The S3 path to the output artifact
 * @returns {string[]} Array of suggested next-step commands
 */
export function generateNextStepCommands(outputType, technique, artifactPath) {
    if (outputType === 'adapter') {
        return [
            `./do/adapter add tuned-${technique} --from-tune`,
            `./do/adapter add tuned-${technique} --from-tune ${technique}`,
            `./do/adapter add tuned-${technique} --weights ${artifactPath}`
        ];
    }

    if (outputType === 'full-model') {
        return [
            './do/add-ic tuned-v1 --from-tune',
            `./do/add-ic tuned-v1 --model-data ${artifactPath}`,
            `./do/deploy --force-ic --model-data ${artifactPath}`
        ];
    }

    return [];
}
