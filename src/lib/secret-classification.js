// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret Classification Registry
 *
 * Single source of truth for all secret type metadata. Each entry defines
 * the identifier, display name, applicable stages, purpose, CLI flags,
 * environment variable names, and prompt labels for a secret type.
 *
 * Adding a new secret type requires only adding a new entry to this array —
 * the CLI, prompt flow, and do-script templates derive behavior from this registry.
 */

export const SECRET_CLASSIFICATIONS = Object.freeze([
    {
        identifier: 'hf-token',
        displayName: 'HuggingFace Token',
        stages: ['build-time', 'runtime'],
        purpose: 'Gated model download from HuggingFace Hub',
        cliFlag: 'hf-token-arn',
        cliFlagPlaintext: 'hf-token',
        envVar: 'HF_TOKEN',
        envVarArn: 'HF_TOKEN_ARN',
        promptLabel: 'HuggingFace token'
    },
    {
        identifier: 'ngc-token',
        displayName: 'NVIDIA NGC Token',
        stages: ['build-time'],
        purpose: 'Pulling base images from NVIDIA NGC registry',
        cliFlag: 'ngc-token-arn',
        cliFlagPlaintext: 'ngc-token',
        envVar: 'NGC_API_KEY',
        envVarArn: 'NGC_API_KEY_ARN',
        promptLabel: 'NVIDIA NGC API key'
    }
]);

/**
 * Look up a classification entry by identifier.
 * @param {string} identifier - e.g. 'hf-token'
 * @returns {Object|undefined}
 */
export function getClassification(identifier) {
    return SECRET_CLASSIFICATIONS.find(c => c.identifier === identifier);
}

/**
 * Get all classifications applicable to a given stage.
 * @param {string} stage - 'build-time' or 'runtime'
 * @returns {Object[]}
 */
export function getClassificationsForStage(stage) {
    return SECRET_CLASSIFICATIONS.filter(c => c.stages.includes(stage));
}
