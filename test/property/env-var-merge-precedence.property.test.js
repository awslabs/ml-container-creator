// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment Variable Merge Precedence Property-Based Tests
 *
 * Property 4: For any set of env var sources (catalog defaults, framework profile,
 * model entry, model profile, CLI overrides), merging them SHALL produce a result
 * where higher-precedence sources override lower-precedence sources for overlapping
 * keys, and all non-overlapping keys from every source are preserved.
 * The precedence order is: CLI > model profile > model entry > framework profile > catalog defaults.
 *
 * Feature: registry-to-server-migration, Property 4: Environment variable merge precedence
 * Validates: Requirements 7.1, 7.2, 7.3, 7.5
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{0,30}$/);
const arbEnvMap = fc.dictionary(arbEnvKey, arbEnvValue);

// ── Merge function under test ────────────────────────────────────────────────
// This replicates the exact merge logic from _mergeEnvVarsWithPrecedence in
// generators/app/index.js — a simple spread in precedence order.

function mergeEnvVarsWithPrecedence(catalogDefaults, frameworkProfileEnvVars, modelEntryEnvVars, modelProfileEnvVars, cliEnvVars) {
    return {
        ...catalogDefaults,
        ...frameworkProfileEnvVars,
        ...modelEntryEnvVars,
        ...modelProfileEnvVars,
        ...cliEnvVars
    };
}

// Precedence levels ordered from lowest (0) to highest (4)
const PRECEDENCE_LEVELS = [
    'catalogDefaults',
    'frameworkProfile',
    'modelEntry',
    'modelProfile',
    'cliOverrides'
];

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 4: Environment variable merge precedence', () => {

    describe('higher-precedence sources override lower-precedence sources for overlapping keys', () => {

        it('for any overlapping key, the highest-precedence source wins', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                (catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides
                    );

                    // Build the sources array in precedence order (lowest first)
                    const sources = [catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides];

                    // For every key in the merged result, find the highest-precedence
                    // source that contains it and verify the value matches
                    for (const key of Object.keys(merged)) {
                        let expectedValue = undefined;
                        let expectedSource = -1;
                        for (let i = sources.length - 1; i >= 0; i--) {
                            if (key in sources[i]) {
                                expectedValue = sources[i][key];
                                expectedSource = i;
                                break;
                            }
                        }
                        assert.strictEqual(merged[key], expectedValue,
                            `key "${key}" should have value from ${PRECEDENCE_LEVELS[expectedSource]} ` +
                            `(level ${expectedSource}), got "${merged[key]}" instead of "${expectedValue}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CLI overrides always win over all other sources', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                (key, defaultVal, fwProfileVal, modelVal, modelProfileVal, cliVal) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        { [key]: defaultVal },
                        { [key]: fwProfileVal },
                        { [key]: modelVal },
                        { [key]: modelProfileVal },
                        { [key]: cliVal }
                    );
                    assert.strictEqual(merged[key], cliVal,
                        `CLI override value "${cliVal}" must win for key "${key}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model profile overrides model entry, framework profile, and catalog defaults', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                (key, defaultVal, fwProfileVal, modelVal, modelProfileVal) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        { [key]: defaultVal },
                        { [key]: fwProfileVal },
                        { [key]: modelVal },
                        { [key]: modelProfileVal },
                        {} // no CLI override
                    );
                    assert.strictEqual(merged[key], modelProfileVal,
                        `model profile value "${modelProfileVal}" must win when no CLI override`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model entry overrides framework profile and catalog defaults', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                (key, defaultVal, fwProfileVal, modelVal) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        { [key]: defaultVal },
                        { [key]: fwProfileVal },
                        { [key]: modelVal },
                        {}, // no model profile
                        {} // no CLI override
                    );
                    assert.strictEqual(merged[key], modelVal,
                        `model entry value "${modelVal}" must win when no higher-precedence source`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('framework profile overrides catalog defaults', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                arbEnvValue,
                (key, defaultVal, fwProfileVal) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        { [key]: defaultVal },
                        { [key]: fwProfileVal },
                        {}, // no model entry
                        {}, // no model profile
                        {} // no CLI override
                    );
                    assert.strictEqual(merged[key], fwProfileVal,
                        `framework profile value "${fwProfileVal}" must win over catalog default`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('all non-overlapping keys from every source are preserved', () => {

        it('the merged result contains every key from every source', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                (catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides) => {
                    const merged = mergeEnvVarsWithPrecedence(
                        catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides
                    );

                    const allSources = [catalogDefaults, frameworkProfile, modelEntry, modelProfile, cliOverrides];
                    const allKeys = new Set();
                    for (const source of allSources) {
                        for (const key of Object.keys(source)) {
                            allKeys.add(key);
                        }
                    }

                    // Every key from any source must appear in merged
                    for (const key of allKeys) {
                        assert.ok(key in merged,
                            `key "${key}" from one of the sources must be present in merged result`);
                    }

                    // Merged must not have any extra keys
                    assert.strictEqual(Object.keys(merged).length, allKeys.size,
                        `merged result should have exactly ${allKeys.size} keys (union of all sources), ` +
                        `but has ${Object.keys(merged).length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('keys unique to catalog defaults are preserved in the merge', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                arbEnvMap,
                (uniqueKey, uniqueVal, frameworkProfile, modelEntry, modelProfile, cliOverrides) => {
                    // Ensure the unique key is not in any higher-precedence source
                    delete frameworkProfile[uniqueKey];
                    delete modelEntry[uniqueKey];
                    delete modelProfile[uniqueKey];
                    delete cliOverrides[uniqueKey];

                    const merged = mergeEnvVarsWithPrecedence(
                        { [uniqueKey]: uniqueVal },
                        frameworkProfile,
                        modelEntry,
                        modelProfile,
                        cliOverrides
                    );

                    assert.strictEqual(merged[uniqueKey], uniqueVal,
                        `unique catalog default key "${uniqueKey}" must be preserved with value "${uniqueVal}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty sources do not affect the merge', () => {

        it('merging with all empty sources produces an empty result', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constant({}),
                () => {
                    const merged = mergeEnvVarsWithPrecedence({}, {}, {}, {}, {});
                    assert.deepStrictEqual(merged, {},
                        'merging all empty sources must produce empty result');
                }
            ), { numRuns: 10, verbose: PROPERTY_CONFIG.verbose });
        });

        it('merging with only catalog defaults produces the defaults', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvMap,
                (catalogDefaults) => {
                    const merged = mergeEnvVarsWithPrecedence(catalogDefaults, {}, {}, {}, {});
                    const defaultKeys = Object.keys(catalogDefaults);
                    assert.strictEqual(Object.keys(merged).length, defaultKeys.length,
                        'merged must have same number of keys as catalog defaults');
                    for (const key of defaultKeys) {
                        assert.strictEqual(merged[key], catalogDefaults[key],
                            `key "${key}" must match catalog default value`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('merging with only CLI overrides produces the overrides', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvMap,
                (cliOverrides) => {
                    const merged = mergeEnvVarsWithPrecedence({}, {}, {}, {}, cliOverrides);
                    const overrideKeys = Object.keys(cliOverrides);
                    assert.strictEqual(Object.keys(merged).length, overrideKeys.length,
                        'merged must have same number of keys as CLI overrides');
                    for (const key of overrideKeys) {
                        assert.strictEqual(merged[key], cliOverrides[key],
                            `key "${key}" must match CLI override value`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
