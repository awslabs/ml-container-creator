// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI-Over-Registry Merge Precedence Property-Based Tests
 *
 * Property 6: CLI-over-registry merge precedence
 *
 * For any key that appears in both CLI-provided env vars (--model-env or
 * --server-env) and registry-sourced env vars, the final configuration
 * SHALL contain the CLI-provided value for that key.
 *
 * Feature: cli-config-parameters, Property 6
 *
 * **Validates: Requirements 3.3, 4.3, 9.3, 9.4, 9.6**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../src/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid env var key.
 */
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,20}$/);

/**
 * Generate a valid env var value.
 */
const arbEnvValue = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Generate overlapping keys with distinct CLI and registry values.
 * Returns { overlappingKeys: [{key, cliValue, registryValue}], registryOnlyKeys: [{key, value}] }
 */
const arbOverlappingEnvVars = fc.record({
    overlapping: fc.uniqueArray(
        fc.tuple(arbEnvKey, arbEnvValue, arbEnvValue),
        { minLength: 1, maxLength: 10, selector: ([key]) => key }
    ),
    registryOnly: fc.uniqueArray(
        fc.tuple(arbEnvKey, arbEnvValue),
        { minLength: 0, maxLength: 5, selector: ([key]) => key }
    )
}).filter(({ overlapping, registryOnly }) => {
    // Ensure registry-only keys don't overlap with the overlapping keys
    const overlappingKeys = new Set(overlapping.map(([k]) => k));
    return registryOnly.every(([k]) => !overlappingKeys.has(k));
});

// ── Helper to create a mock generator ────────────────────────────────────────

function createMockGenerator(cliOptions = {}) {
    return {
        options: { ...cliOptions },
        args: [],
        destDir: process.cwd()
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('CLI-Over-Registry Merge Precedence Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 6: CLI-over-registry merge precedence
    describe('Property 6: CLI-over-registry merge precedence', () => {

        /**
         * Validates: Requirements 3.3, 4.3, 9.3, 9.4, 9.6
         */

        it('--model-env CLI values override registry values for overlapping keys', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbOverlappingEnvVars,
                async ({ overlapping, registryOnly }) => {
                    // Build CLI flags from overlapping keys (using CLI values)
                    const modelEnvFlags = overlapping.map(([key, cliValue]) => `${key}=${cliValue}`);

                    const mockGenerator = createMockGenerator({
                        'model-env': modelEnvFlags
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // Build registry env vars (using registry values for overlapping + registry-only)
                    const registryModelEnvVars = {};
                    for (const [key, , registryValue] of overlapping) {
                        registryModelEnvVars[key] = registryValue;
                    }
                    for (const [key, value] of registryOnly) {
                        registryModelEnvVars[key] = value;
                    }

                    // Merge registry env vars
                    configManager.mergeRegistryEnvVars(registryModelEnvVars, {});

                    const modelEnvVars = configManager.config.modelEnvVars;

                    // CLI values win for overlapping keys
                    for (const [key, cliValue] of overlapping) {
                        assert.strictEqual(modelEnvVars[key], cliValue,
                            `modelEnvVars["${key}"] should be CLI value "${cliValue}", ` +
                            `got "${modelEnvVars[key]}"`);
                    }

                    // Registry-only keys are still present
                    for (const [key, value] of registryOnly) {
                        assert.strictEqual(modelEnvVars[key], value,
                            `modelEnvVars["${key}"] should be registry value "${value}", ` +
                            `got "${modelEnvVars[key]}"`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('--server-env CLI values override registry values for overlapping keys', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbOverlappingEnvVars,
                async ({ overlapping, registryOnly }) => {
                    // Build CLI flags from overlapping keys (using CLI values)
                    const serverEnvFlags = overlapping.map(([key, cliValue]) => `${key}=${cliValue}`);

                    const mockGenerator = createMockGenerator({
                        'server-env': serverEnvFlags
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // Build registry env vars (using registry values for overlapping + registry-only)
                    const registryServerEnvVars = {};
                    for (const [key, , registryValue] of overlapping) {
                        registryServerEnvVars[key] = registryValue;
                    }
                    for (const [key, value] of registryOnly) {
                        registryServerEnvVars[key] = value;
                    }

                    // Merge registry env vars
                    configManager.mergeRegistryEnvVars({}, registryServerEnvVars);

                    const serverEnvVars = configManager.config.serverEnvVars;

                    // CLI values win for overlapping keys
                    for (const [key, cliValue] of overlapping) {
                        assert.strictEqual(serverEnvVars[key], cliValue,
                            `serverEnvVars["${key}"] should be CLI value "${cliValue}", ` +
                            `got "${serverEnvVars[key]}"`);
                    }

                    // Registry-only keys are still present
                    for (const [key, value] of registryOnly) {
                        assert.strictEqual(serverEnvVars[key], value,
                            `serverEnvVars["${key}"] should be registry value "${value}", ` +
                            `got "${serverEnvVars[key]}"`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
