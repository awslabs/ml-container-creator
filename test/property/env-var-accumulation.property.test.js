// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ENV Var Accumulation Property-Based Tests
 *
 * Property 5: ENV var accumulation preserves all entries
 *
 * For any list of valid KEY=VALUE pairs passed via multiple --model-env
 * (or --server-env) flags, the resulting environment variables collection
 * SHALL contain every key-value pair from the input list, with the
 * collection size equal to the number of unique keys provided.
 *
 * Feature: cli-config-parameters, Property 5
 *
 * **Validates: Requirements 3.2, 4.2**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../src/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid env var key (uppercase letters, digits, underscores,
 * starting with a letter or underscore).
 */
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,20}$/);

/**
 * Generate a valid env var value (arbitrary non-empty string).
 */
const arbEnvValue = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Generate a list of unique KEY=VALUE pairs.
 * Uses uniqueArray on keys to ensure no duplicates.
 */
const arbUniqueKeyValuePairs = fc.uniqueArray(
    fc.tuple(arbEnvKey, arbEnvValue),
    { minLength: 1, maxLength: 20, selector: ([key]) => key }
);

// ── Helper to create a mock generator ────────────────────────────────────────

function createMockGenerator(cliOptions = {}) {
    return {
        options: { ...cliOptions },
        args: [],
        destDir: process.cwd()
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('ENV Var Accumulation Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 5: ENV var accumulation preserves all entries
    describe('Property 5: ENV var accumulation preserves all entries', () => {

        /**
         * Validates: Requirements 3.2, 4.2
         */

        it('--model-env: all unique KEY=VALUE pairs are preserved in modelEnvVars collection', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbUniqueKeyValuePairs,
                async (pairs) => {
                    const modelEnvFlags = pairs.map(([key, value]) => `${key}=${value}`);

                    const mockGenerator = createMockGenerator({
                        'model-env': modelEnvFlags
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const modelEnvVars = configManager.config.modelEnvVars;

                    // Collection size equals number of unique keys
                    assert.strictEqual(Object.keys(modelEnvVars).length, pairs.length,
                        `modelEnvVars should have ${pairs.length} entries, got ${Object.keys(modelEnvVars).length}`);

                    // Every pair is present with correct value
                    for (const [key, value] of pairs) {
                        assert.strictEqual(modelEnvVars[key], value,
                            `modelEnvVars["${key}"] should be "${value}", got "${modelEnvVars[key]}"`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('--server-env: all unique KEY=VALUE pairs are preserved in serverEnvVars collection', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbUniqueKeyValuePairs,
                async (pairs) => {
                    const serverEnvFlags = pairs.map(([key, value]) => `${key}=${value}`);

                    const mockGenerator = createMockGenerator({
                        'server-env': serverEnvFlags
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const serverEnvVars = configManager.config.serverEnvVars;

                    // Collection size equals number of unique keys
                    assert.strictEqual(Object.keys(serverEnvVars).length, pairs.length,
                        `serverEnvVars should have ${pairs.length} entries, got ${Object.keys(serverEnvVars).length}`);

                    // Every pair is present with correct value
                    for (const [key, value] of pairs) {
                        assert.strictEqual(serverEnvVars[key], value,
                            `serverEnvVars["${key}"] should be "${value}", got "${serverEnvVars[key]}"`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
