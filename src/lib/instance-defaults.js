// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * instance-defaults — the ONE architecture → default instance-type heuristic.
 *
 * PATTERN: single source of truth (ADR-002 principle 4 / derive-don't-hardcode).
 * COLLABORATORS: src/app.js (skip-prompts defaulting), src/lib/prompt-runner.js
 *   (fallback when the instance sizer has no recommendation), src/lib/config-manager.js
 *   (missing required instanceType).
 * DATA FLOW: architecture → instanceType, used only when the user gave no
 *   --instance-type and no sizing recommendation exists. This is a coarse
 *   architecture heuristic, NOT a VRAM sizing of the model.
 * See: docs/dev/improvement-plan.md (CLI-1). Before this module, three copies
 *   disagreed (diffusors → ml.g5.2xlarge in two places, ml.g5.xlarge in the third;
 *   predictor → ml.g5.xlarge in the third).
 */

const GPU_DEFAULT = 'ml.g5.xlarge';

const HEURISTIC_DEFAULTS = Object.freeze({
    transformers: GPU_DEFAULT,
    transformer: GPU_DEFAULT,
    triton: GPU_DEFAULT,
    diffusors: 'ml.g5.2xlarge',
    diffusor: 'ml.g5.2xlarge',
    predictor: 'ml.m5.large',
    http: 'ml.m5.large'
});

/**
 * Default instance type for an architecture (or deployment-config family).
 *
 * @param {string} [architecture] - e.g. 'transformers', 'diffusors', 'http'
 * @returns {string} an ml.* instance type; GPU default for unknown architectures
 */
export function defaultInstanceTypeFor(architecture) {
    return Object.hasOwn(HEURISTIC_DEFAULTS, architecture) ? HEURISTIC_DEFAULTS[architecture] : GPU_DEFAULT;
}

export { HEURISTIC_DEFAULTS };
