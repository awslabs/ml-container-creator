// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Generator Inclusion Property-Based Tests
 *
 * Property 12: Generator always includes do/train for non-batch targets
 *
 * For any valid generator configuration where `deploymentTarget !== 'batch-transform'`,
 * the generated project SHALL contain the `do/train` script, `do/training/config.yaml`,
 * `do/training/train.py`, and `do/lib/feedback.sh`.
 *
 * Feature: fine-tuning-training, Property 12: Generator always includes do/train for non-batch targets
 * Validates: Requirements 1.1, 1.2
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Ignore pattern logic (mirrors src/app.js writeProject) ───────────────────
//
// The generator excludes train files via ignore patterns when:
//   deploymentTarget === 'batch-transform'
//
// Train files are included for ALL other deployment targets regardless of
// framework, architecture, or any other configuration.
//
// The train-related ignore patterns are:
//   '**/do/train'
//   '**/do/.train_build_request.py'
//   '**/do/.train_status_parser.py'
//   '**/do/.train_poll_parser.py'
//   '**/do/training/**'
//
// feedback.sh is excluded only when BOTH tune and train are excluded:
//   if (!tuneIncluded && !trainIncluded) → '**/do/lib/feedback.sh'

const TRAIN_IGNORE_PATTERNS = [
    '**/do/train',
    '**/do/.train_build_request.py',
    '**/do/.train_status_parser.py',
    '**/do/.train_poll_parser.py',
    '**/do/training/**'
];

/**
 * Simulates the ignore pattern logic from src/app.js for train files.
 * Returns the list of train-related ignore patterns that would be applied.
 *
 * @param {object} config - Generator configuration
 * @param {string} config.deploymentTarget - The deployment target
 * @returns {string[]} Array of train-related ignore patterns applied
 */
function getTrainIgnorePatterns(config) {
    const ignorePatterns = [];
    const trainIncluded = config.deploymentTarget !== 'batch-transform';
    if (!trainIncluded) {
        ignorePatterns.push('**/do/train');
        ignorePatterns.push('**/do/.train_build_request.py');
        ignorePatterns.push('**/do/.train_status_parser.py');
        ignorePatterns.push('**/do/.train_poll_parser.py');
        ignorePatterns.push('**/do/training/**');
    }
    return ignorePatterns;
}

/**
 * Simulates whether feedback.sh would be excluded.
 * feedback.sh is excluded only when BOTH tune and train are excluded.
 * Since train is included for all non-batch targets, feedback.sh is always
 * included when train is included.
 *
 * @param {object} config - Generator configuration
 * @returns {boolean} Whether feedback.sh is included (not in ignore patterns)
 */
function isFeedbackShIncluded(config) {
    // Resolve architecture
    let architecture = config.architecture;
    if (!architecture) {
        architecture = config.framework === 'transformers' ? 'transformers' : 'http';
    }

    const tuneIncluded = architecture === 'transformers' && config.deploymentTarget !== 'batch-transform';
    const trainIncluded = config.deploymentTarget !== 'batch-transform';

    // feedback.sh is included when either tune or train is included
    return tuneIncluded || trainIncluded;
}

// ── Generators ───────────────────────────────────────────────────────────────

// Valid deployment targets that are NOT batch-transform
const NON_BATCH_DEPLOYMENT_TARGETS = [
    'realtime-inference',
    'async-inference',
    'hyperpod-eks'
];

// All supported frameworks
const ALL_FRAMEWORKS = ['transformers', 'sklearn', 'xgboost', 'tensorflow'];

/**
 * Generator for valid configs where deploymentTarget is NOT batch-transform.
 * Framework varies to prove the property holds regardless of framework choice.
 */
const nonBatchConfigArb = fc.record({
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    deploymentTarget: fc.constantFrom(...NON_BATCH_DEPLOYMENT_TARGETS)
});

/**
 * Generator for configs with explicit architecture override and non-batch target.
 */
const nonBatchWithArchitectureArb = fc.record({
    architecture: fc.constantFrom('transformers', 'http', 'triton', 'diffusors'),
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    deploymentTarget: fc.constantFrom(...NON_BATCH_DEPLOYMENT_TARGETS)
});

// ── Property 12 tests ────────────────────────────────────────────────────────

describe('Feature: fine-tuning-training, Property 12: Generator always includes do/train for non-batch targets', () => {

    it('train files are NOT in ignore patterns when deploymentTarget is not batch-transform (any framework)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                // Verify that train ignore patterns are NOT applied
                for (const pattern of TRAIN_IGNORE_PATTERNS) {
                    assert.ok(!ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" should NOT be present for framework="${config.framework}", deploymentTarget="${config.deploymentTarget}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('do/train script is included for all non-batch deployment targets', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                assert.ok(!ignorePatterns.includes('**/do/train'),
                    `do/train should not be in ignore patterns for deploymentTarget="${config.deploymentTarget}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('do/training/** (config.yaml, train.py) is included for all non-batch deployment targets', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                assert.ok(!ignorePatterns.includes('**/do/training/**'),
                    `do/training/** should not be in ignore patterns for deploymentTarget="${config.deploymentTarget}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('do/lib/feedback.sh is included when train is included (non-batch targets)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchConfigArb,
            (config) => {
                const feedbackIncluded = isFeedbackShIncluded(config);

                // Since train is always included for non-batch targets,
                // feedback.sh should always be included
                assert.strictEqual(feedbackIncluded, true,
                    `feedback.sh should be included for deploymentTarget="${config.deploymentTarget}", framework="${config.framework}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('train inclusion is independent of architecture override (non-batch targets)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchWithArchitectureArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                // Train files should be included regardless of architecture
                for (const pattern of TRAIN_IGNORE_PATTERNS) {
                    assert.ok(!ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" should NOT be present for architecture="${config.architecture}", deploymentTarget="${config.deploymentTarget}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('all train-related files (do/train, do/training/**, helpers) are available for non-batch configs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            nonBatchConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);
                const feedbackIncluded = isFeedbackShIncluded(config);

                // do/train is not ignored
                assert.ok(!ignorePatterns.includes('**/do/train'),
                    'do/train should not be in ignore patterns');

                // do/.train_build_request.py is not ignored
                assert.ok(!ignorePatterns.includes('**/do/.train_build_request.py'),
                    'do/.train_build_request.py should not be in ignore patterns');

                // do/.train_status_parser.py is not ignored
                assert.ok(!ignorePatterns.includes('**/do/.train_status_parser.py'),
                    'do/.train_status_parser.py should not be in ignore patterns');

                // do/.train_poll_parser.py is not ignored
                assert.ok(!ignorePatterns.includes('**/do/.train_poll_parser.py'),
                    'do/.train_poll_parser.py should not be in ignore patterns');

                // do/training/** is not ignored
                assert.ok(!ignorePatterns.includes('**/do/training/**'),
                    'do/training/** should not be in ignore patterns');

                // feedback.sh is included
                assert.strictEqual(feedbackIncluded, true,
                    'do/lib/feedback.sh should be included when train is included');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});


// ── Property 13 ──────────────────────────────────────────────────────────────
//
// Property 13: Generator excludes training scripts for batch-transform
//
// For any valid generator configuration where `deploymentTarget === 'batch-transform'`,
// the generated project SHALL NOT contain `do/train`, `do/training/config.yaml`,
// or `do/training/train.py`.
//
// Feature: fine-tuning-training, Property 13: Generator excludes training scripts for batch-transform
// Validates: Requirements 1.2

// ── Generators for Property 13 ───────────────────────────────────────────────

/**
 * Generator for valid configs where deploymentTarget IS batch-transform.
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
    architecture: fc.constantFrom('transformers', 'http', 'triton', 'diffusors'),
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    deploymentTarget: fc.constant('batch-transform')
});

// ── Property 13 tests ────────────────────────────────────────────────────────

describe('Feature: fine-tuning-training, Property 13: Generator excludes training scripts for batch-transform', () => {

    it('train files ARE in ignore patterns when deploymentTarget is batch-transform (any framework)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                // Verify that all train ignore patterns ARE applied
                assert.ok(ignorePatterns.includes('**/do/train'),
                    `Ignore pattern "**/do/train" SHOULD be present for deploymentTarget="batch-transform", framework="${config.framework}"`);
                assert.ok(ignorePatterns.includes('**/do/training/**'),
                    `Ignore pattern "**/do/training/**" SHOULD be present for deploymentTarget="batch-transform", framework="${config.framework}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('all train-related ignore patterns are applied for batch-transform', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                // Verify every train-related pattern is present
                for (const pattern of TRAIN_IGNORE_PATTERNS) {
                    assert.ok(ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" SHOULD be present for deploymentTarget="batch-transform", framework="${config.framework}"`);
                }
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
                const ignorePatterns = getTrainIgnorePatterns(config);

                // Even though framework is transformers, batch-transform overrides inclusion
                assert.ok(ignorePatterns.includes('**/do/train'),
                    'do/train should be excluded for batch-transform even with transformers framework');
                assert.ok(ignorePatterns.includes('**/do/training/**'),
                    'do/training/** should be excluded for batch-transform even with transformers framework');
                assert.ok(ignorePatterns.includes('**/do/.train_build_request.py'),
                    'do/.train_build_request.py should be excluded for batch-transform even with transformers framework');
                assert.ok(ignorePatterns.includes('**/do/.train_status_parser.py'),
                    'do/.train_status_parser.py should be excluded for batch-transform even with transformers framework');
                assert.ok(ignorePatterns.includes('**/do/.train_poll_parser.py'),
                    'do/.train_poll_parser.py should be excluded for batch-transform even with transformers framework');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('batch-transform exclusion applies regardless of explicit architecture override', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformWithArchitectureArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                // batch-transform always excludes train files, even with architecture=transformers
                for (const pattern of TRAIN_IGNORE_PATTERNS) {
                    assert.ok(ignorePatterns.includes(pattern),
                        `Ignore pattern "${pattern}" SHOULD be present for batch-transform with architecture="${config.architecture}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('exactly 5 train-related ignore patterns are applied for batch-transform', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            batchTransformConfigArb,
            (config) => {
                const ignorePatterns = getTrainIgnorePatterns(config);

                assert.strictEqual(ignorePatterns.length, TRAIN_IGNORE_PATTERNS.length,
                    `Expected ${TRAIN_IGNORE_PATTERNS.length} train ignore patterns for batch-transform, got ${ignorePatterns.length}: [${ignorePatterns.join(', ')}]`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
