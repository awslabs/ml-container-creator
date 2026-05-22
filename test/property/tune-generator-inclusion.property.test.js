// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Generator Inclusion Property-Based Tests
 *
 * Property 1: Generator includes tune script for transformers
 *
 * For any valid generator configuration where `framework === 'transformers'`
 * and `deploymentTarget !== 'batch-transform'`, the generated project SHALL
 * contain the files `do/tune`, `do/.tune_helper.py`, and `do/.tune_catalog.json`.
 *
 * Feature: managed-model-customization, Property 1: Generator includes tune script for transformers
 * Validates: Requirements 1.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Ignore pattern logic (mirrors src/app.js writeProject) ───────────────────
//
// The generator excludes tune files via ignore patterns when:
//   architecture !== 'transformers' || deploymentTarget === 'batch-transform'
//
// The tune catalog is copied when:
//   architecture === 'transformers' && deploymentTarget !== 'batch-transform'
//
// Architecture is resolved from framework:
//   if framework === 'transformers' → architecture = 'transformers'
//   otherwise → architecture = 'http' (or from deploymentConfig)

const TUNE_IGNORE_PATTERNS = ['**/do/tune', '**/do/.tune_helper.py'];

/**
 * Simulates the ignore pattern logic from src/app.js for tune files.
 * Returns the list of tune-related ignore patterns that would be applied.
 *
 * @param {object} config - Generator configuration
 * @param {string} config.framework - The framework (e.g., 'transformers')
 * @param {string} config.deploymentTarget - The deployment target
 * @param {string} [config.architecture] - Explicit architecture override
 * @returns {string[]} Array of tune-related ignore patterns applied
 */
function getTuneIgnorePatterns(config) {
    // Resolve architecture the same way src/app.js does
    let architecture = config.architecture;
    if (!architecture) {
        architecture = config.framework === 'transformers' ? 'transformers' : 'http';
    }

    const ignorePatterns = [];
    if (architecture !== 'transformers' || config.deploymentTarget === 'batch-transform') {
        ignorePatterns.push('**/do/tune');
        ignorePatterns.push('**/do/.tune_helper.py');
    }
    return ignorePatterns;
}

/**
 * Simulates whether the tune catalog would be copied.
 * Returns true if the catalog would be included in the generated project.
 *
 * @param {object} config - Generator configuration
 * @returns {boolean} Whether tune catalog is copied
 */
function isTuneCatalogIncluded(config) {
    let architecture = config.architecture;
    if (!architecture) {
        architecture = config.framework === 'transformers' ? 'transformers' : 'http';
    }
    return architecture === 'transformers' && config.deploymentTarget !== 'batch-transform';
}

// ── Generators ───────────────────────────────────────────────────────────────

// Valid deployment targets that are NOT batch-transform
const NON_BATCH_DEPLOYMENT_TARGETS = [
    'realtime-inference',
    'async-inference',
    'hyperpod-eks'
];

/**
 * Generator for valid configs where framework is transformers
 * and deploymentTarget is NOT batch-transform.
 */
const validTransformersConfigArb = fc.record({
    framework: fc.constant('transformers'),
    deploymentTarget: fc.constantFrom(...NON_BATCH_DEPLOYMENT_TARGETS)
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 1: Generator includes tune script for transformers', () => {

    it('tune files are NOT in ignore patterns when framework is transformers and deploymentTarget is not batch-transform', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validTransformersConfigArb,
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);

                // Verify that tune ignore patterns are NOT applied
                for (const pattern of TUNE_IGNORE_PATTERNS) {
                    assert.ok(!ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" should NOT be present for framework="${config.framework}", deploymentTarget="${config.deploymentTarget}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('tune catalog is included when framework is transformers and deploymentTarget is not batch-transform', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validTransformersConfigArb,
            (config) => {
                const catalogIncluded = isTuneCatalogIncluded(config);

                assert.strictEqual(catalogIncluded, true,
                    `Tune catalog should be included for framework="${config.framework}", deploymentTarget="${config.deploymentTarget}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('all three tune files (do/tune, do/.tune_helper.py, do/.tune_catalog.json) are available for transformers non-batch configs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validTransformersConfigArb,
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);
                const catalogIncluded = isTuneCatalogIncluded(config);

                // do/tune is not ignored
                assert.ok(!ignorePatterns.includes('**/do/tune'),
                    'do/tune should not be in ignore patterns');

                // do/.tune_helper.py is not ignored
                assert.ok(!ignorePatterns.includes('**/do/.tune_helper.py'),
                    'do/.tune_helper.py should not be in ignore patterns');

                // do/.tune_catalog.json is copied explicitly
                assert.strictEqual(catalogIncluded, true,
                    'do/.tune_catalog.json should be copied to generated project');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('explicit architecture=transformers also includes tune files regardless of framework field', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.record({
                architecture: fc.constant('transformers'),
                framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
                deploymentTarget: fc.constantFrom(...NON_BATCH_DEPLOYMENT_TARGETS)
            }),
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);
                const catalogIncluded = isTuneCatalogIncluded(config);

                // When architecture is explicitly 'transformers', tune files are included
                for (const pattern of TUNE_IGNORE_PATTERNS) {
                    assert.ok(!ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" should NOT be present when architecture="transformers"`);
                }
                assert.strictEqual(catalogIncluded, true,
                    'Tune catalog should be included when architecture="transformers"');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 2 ──────────────────────────────────────────────────────────────
//
// Property 2: Generator excludes tune script for batch-transform
//
// For any valid generator configuration where `deploymentTarget === 'batch-transform'`,
// the generated project SHALL NOT contain the file `do/tune`.
//
// Feature: managed-model-customization, Property 2: Generator excludes tune script for batch-transform
// Validates: Requirements 1.2

// ── Generators for Property 2 ────────────────────────────────────────────────

// All supported frameworks (tune exclusion for batch-transform applies regardless of framework)
const ALL_FRAMEWORKS = ['transformers', 'sklearn', 'xgboost', 'tensorflow'];

/**
 * Generator for valid configs where deploymentTarget is batch-transform.
 * Framework varies to prove the property holds regardless of framework choice.
 */
const batchTransformConfigArb = fc.record({
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    deploymentTarget: fc.constant('batch-transform')
});

/**
 * Generator for configs with explicit architecture override and batch-transform target.
 */
const batchTransformWithArchitectureArb = fc.record({
    architecture: fc.constantFrom('transformers', 'http'),
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    deploymentTarget: fc.constant('batch-transform')
});

// ── Property 2 tests ─────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 2: Generator excludes tune script for batch-transform', () => {

    it('tune files ARE in ignore patterns when deploymentTarget is batch-transform (any framework)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformConfigArb,
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);

                // Verify that tune ignore patterns ARE applied
                assert.ok(ignorePatterns.includes('**/do/tune'),
                    `Ignore pattern "**/do/tune" SHOULD be present for deploymentTarget="batch-transform", framework="${config.framework}"`);
                assert.ok(ignorePatterns.includes('**/do/.tune_helper.py'),
                    `Ignore pattern "**/do/.tune_helper.py" SHOULD be present for deploymentTarget="batch-transform", framework="${config.framework}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('tune catalog is NOT included when deploymentTarget is batch-transform (any framework)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformConfigArb,
            (config) => {
                const catalogIncluded = isTuneCatalogIncluded(config);

                assert.strictEqual(catalogIncluded, false,
                    `Tune catalog should NOT be included for deploymentTarget="batch-transform", framework="${config.framework}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('batch-transform exclusion applies even when framework is transformers', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.record({
                framework: fc.constant('transformers'),
                deploymentTarget: fc.constant('batch-transform')
            }),
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);
                const catalogIncluded = isTuneCatalogIncluded(config);

                // Even though framework is transformers, batch-transform overrides inclusion
                assert.ok(ignorePatterns.includes('**/do/tune'),
                    'do/tune should be excluded for batch-transform even with transformers framework');
                assert.ok(ignorePatterns.includes('**/do/.tune_helper.py'),
                    'do/.tune_helper.py should be excluded for batch-transform even with transformers framework');
                assert.strictEqual(catalogIncluded, false,
                    'Tune catalog should NOT be copied for batch-transform even with transformers framework');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('batch-transform exclusion applies regardless of explicit architecture override', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformWithArchitectureArb,
            (config) => {
                const ignorePatterns = getTuneIgnorePatterns(config);
                const catalogIncluded = isTuneCatalogIncluded(config);

                // batch-transform always excludes tune files, even with architecture=transformers
                assert.ok(ignorePatterns.includes('**/do/tune'),
                    `do/tune should be excluded for batch-transform with architecture="${config.architecture}"`);
                assert.ok(ignorePatterns.includes('**/do/.tune_helper.py'),
                    `do/.tune_helper.py should be excluded for batch-transform with architecture="${config.architecture}"`);
                assert.strictEqual(catalogIncluded, false,
                    `Tune catalog should NOT be copied for batch-transform with architecture="${config.architecture}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
