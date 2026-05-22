// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine Prefix Transparency Property-Based Tests
 *
 * Property 7: Engine prefix transparency
 *
 * For any server environment variable key and for any model server with a
 * defined engine prefix, the ConfigManager SHALL produce an output key equal
 * to {ENGINE_PREFIX}{USER_KEY} in the Dockerfile and do/config templates,
 * without requiring the user to include the prefix in their --server-env input.
 *
 * Feature: cli-config-parameters, Property 7
 *
 * **Validates: Requirements 4.6**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    ENGINE_PREFIX_MAP,
    resolvePrefix,
    resolvePrefixedEnvVars
} from '../../src/lib/engine-prefix-resolver.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate valid environment variable key names.
 * Keys are uppercase letters, digits, and underscores, starting with a letter.
 */
const arbEnvVarKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/);

/**
 * Select from engines that have a defined prefix.
 */
const arbPrefixedEngine = fc.constantFrom(...Object.keys(ENGINE_PREFIX_MAP));

/**
 * Select from engines that do NOT have a defined prefix.
 */
const arbNoPrefixEngine = fc.constantFrom('flask', 'fastapi');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Engine Prefix Transparency Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 7: Engine prefix transparency
    describe('Property 7: Engine prefix transparency', () => {

        /**
         * Validates: Requirements 4.6
         */

        it('prefixed engines produce output key equal to {ENGINE_PREFIX}{USER_KEY}', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbPrefixedEngine,
                arbEnvVarKey,
                (engine, key) => {
                    const expectedPrefix = ENGINE_PREFIX_MAP[engine];
                    const result = resolvePrefix(engine, key);

                    assert.strictEqual(result, `${expectedPrefix}${key}`,
                        `For engine "${engine}" and key "${key}", expected "${expectedPrefix}${key}" but got "${result}"`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('no-prefix engines return key unchanged', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbNoPrefixEngine,
                arbEnvVarKey,
                (engine, key) => {
                    const result = resolvePrefix(engine, key);

                    assert.strictEqual(result, key,
                        `For no-prefix engine "${engine}" and key "${key}", expected key unchanged but got "${result}"`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('batch resolution applies prefix to every key in the collection', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbPrefixedEngine,
                fc.dictionary(arbEnvVarKey, fc.string({ minLength: 0, maxLength: 50 }), { minKeys: 1, maxKeys: 10 }),
                (engine, serverEnvVars) => {
                    const expectedPrefix = ENGINE_PREFIX_MAP[engine];
                    const result = resolvePrefixedEnvVars(engine, serverEnvVars);

                    // Every key in the result should be prefixed
                    for (const [originalKey, originalValue] of Object.entries(serverEnvVars)) {
                        const expectedKey = `${expectedPrefix}${originalKey}`;
                        assert.ok(expectedKey in result,
                            `Expected prefixed key "${expectedKey}" in result for engine "${engine}"`);
                        assert.strictEqual(result[expectedKey], originalValue,
                            `Value for "${expectedKey}" should be "${originalValue}" but got "${result[expectedKey]}"`);
                    }

                    // Result should have same number of entries as input
                    assert.strictEqual(Object.keys(result).length, Object.keys(serverEnvVars).length,
                        'Result should have same number of entries as input');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('batch resolution for no-prefix engines preserves all keys unchanged', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbNoPrefixEngine,
                fc.dictionary(arbEnvVarKey, fc.string({ minLength: 0, maxLength: 50 }), { minKeys: 1, maxKeys: 10 }),
                (engine, serverEnvVars) => {
                    const result = resolvePrefixedEnvVars(engine, serverEnvVars);

                    // Every key and value should be preserved unchanged
                    for (const [key, value] of Object.entries(serverEnvVars)) {
                        assert.ok(key in result,
                            `Key "${key}" should be present in result for no-prefix engine "${engine}"`);
                        assert.strictEqual(result[key], value,
                            `Value for "${key}" should be "${value}" but got "${result[key]}"`);
                    }

                    // Result should have same number of entries as input
                    assert.strictEqual(Object.keys(result).length, Object.keys(serverEnvVars).length,
                        'Result should have same number of entries as input');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
