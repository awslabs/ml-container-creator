// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace deployment-config refusal (hard-deprecation).
 *
 * The `marketplace` deployment config deploys a pre-built vendor model-package
 * ARN directly, so it never builds a container. That directly violates this
 * project's core promise — bring your own container — because you cannot build
 * an image for a marketplace deployment. The generation surface was removed in
 * BL120; this module remains as the hard-refusal so an old wrapper passing a
 * marketplace config/model gets a clear deprecation message, not an obscure error.
 *
 * This module is the SINGLE source of the refusal message and detection logic so
 * every enforcement point (generator skip-prompts path, interactive prompt
 * runner) stays in agreement instead of drifting (derive-don't-hardcode).
 */

const MARKETPLACE_MODEL_PREFIX = 'marketplace://';
const MARKETPLACE_CONFIG = 'marketplace';

/**
 * True if the given deployment-config / architecture value selects marketplace.
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isMarketplaceConfig(value) {
    if (!value) {
        return false;
    }
    return value === MARKETPLACE_CONFIG || value.split('-')[0] === MARKETPLACE_CONFIG;
}

/**
 * True if the given model name selects marketplace via the `marketplace://` prefix.
 * @param {string|undefined} modelName
 * @returns {boolean}
 */
function isMarketplaceModelName(modelName) {
    return typeof modelName === 'string' && modelName.startsWith(MARKETPLACE_MODEL_PREFIX);
}

/**
 * The lines of the refusal message, in order. Kept as an array so callers can
 * render them however they emit output (stderr lines, MCP text payload, tests).
 * @returns {string[]}
 */
function marketplaceRefusalLines() {
    return [
        '',
        '   ⚠️  Marketplace deployments are no longer supported.',
        '   Marketplace deploys a pre-built vendor model package and never builds a',
        '   container, which violates the core promise of this tool: bring your own',
        '   container. Build and deploy your own image instead. Use one of:',
        '     • HuggingFace model ID (e.g., meta-llama/Llama-2-7b-hf)',
        '     • s3://bucket/path/model.tar.gz',
        '     • registry://model-package-name',
        ''
    ];
}

/**
 * The refusal message as a single string (for MCP text payloads / tests).
 * @returns {string}
 */
function marketplaceRefusalMessage() {
    return marketplaceRefusalLines().join('\n');
}

/**
 * Emit the refusal to stderr and exit the process with code 1.
 * Mirrors the JumpStart hard-refusal precedent in the generator paths.
 * @param {{ error?: Function, exit?: Function }} [io] - injectable console/process for tests
 * @returns {never}
 */
function refuseMarketplaceAndExit(io = {}) {
    const error = io.error || console.error;
    const exit = io.exit || process.exit;
    for (const line of marketplaceRefusalLines()) {
        error(line);
    }
    exit(1);
    // Unreachable in production; a test-injected exit may return, so guard callers.
    throw new Error('marketplace deployment config is no longer supported');
}

export {
    MARKETPLACE_MODEL_PREFIX,
    MARKETPLACE_CONFIG,
    isMarketplaceConfig,
    isMarketplaceModelName,
    marketplaceRefusalLines,
    marketplaceRefusalMessage,
    refuseMarketplaceAndExit
};
