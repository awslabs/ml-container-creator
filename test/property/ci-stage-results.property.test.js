// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Stage Results Property-Based Tests
 *
 * Property 7: Failure-skip with teardown guarantee
 * Property 12: Stage result structure completeness
 * Property 13: testStatus reflects first failing stage
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    applySkipLogic,
    validateStageResultStructure,
    computeTestStatus,
    STAGE_ORDER,
    ALWAYS_RUN_STAGES
} from '../../src/lib/ci-stage-helpers.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Stages that can fail (not teardown or update, which always run).
 */
const FAILABLE_STAGES = STAGE_ORDER.filter(s => !ALWAYS_RUN_STAGES.includes(s));

const arbFailableStage = fc.constantFrom(...FAILABLE_STAGES);

const arbDuration = fc.integer({ min: 1, max: 3600 });

const arbErrorSummary = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 .:-_\n'.split('')),
    { minLength: 10, maxLength: 500 }
).map(arr => arr.join(''));

/**
 * Build a complete stageResults map where all stages pass,
 * then apply a failure at the specified stage.
 */
function buildStageResultsWithFailure(failedStage, durations, logPointers, errorSummary) {
    const results = {};
    const failedIndex = STAGE_ORDER.indexOf(failedStage);

    for (let i = 0; i < STAGE_ORDER.length; i++) {
        const stage = STAGE_ORDER[i];
        if (i < failedIndex) {
            results[stage] = {
                status: 'pass',
                durationSeconds: durations[i] || 10,
                logPointer: logPointers[i] || 'log/ptr',
                errorSummary: ''
            };
        } else if (i === failedIndex) {
            results[stage] = {
                status: 'fail',
                durationSeconds: durations[i] || 5,
                logPointer: logPointers[i] || 'log/ptr',
                errorSummary: errorSummary || 'Stage failed'
            };
        } else if (ALWAYS_RUN_STAGES.includes(stage)) {
            // Teardown and update always run
            results[stage] = {
                status: 'pass',
                durationSeconds: durations[i] || 3,
                logPointer: logPointers[i] || 'log/ptr',
                errorSummary: ''
            };
        } else {
            // Will be set by applySkipLogic
            results[stage] = {
                status: 'pass',
                durationSeconds: durations[i] || 10,
                logPointer: logPointers[i] || 'log/ptr',
                errorSummary: ''
            };
        }
    }

    return results;
}

/**
 * Build a complete stageResults map where all stages pass.
 */
function buildAllPassResults(durations, logPointers) {
    const results = {};
    for (let i = 0; i < STAGE_ORDER.length; i++) {
        const stage = STAGE_ORDER[i];
        results[stage] = {
            status: 'pass',
            durationSeconds: durations[i] || 10,
            logPointer: logPointers[i] || 'log/ptr',
            errorSummary: ''
        };
    }
    return results;
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 7: Failure-skip with teardown guarantee', () => {

    /**
     * Validates: Requirements 6.11, 16.3, 16.5
     *
     * For any lifecycle stage that fails, all subsequent stages (except
     * Teardown and Update) SHALL have status=skip and durationSeconds=0,
     * AND the Teardown stage SHALL always execute.
     */
    it('subsequent non-always-run stages are skipped after a failure', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            arbErrorSummary,
            (failedStage, durations, errorSummary) => {
                const stageResults = buildStageResultsWithFailure(failedStage, durations, [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                const failedIndex = STAGE_ORDER.indexOf(failedStage);

                for (let i = failedIndex + 1; i < STAGE_ORDER.length; i++) {
                    const stage = STAGE_ORDER[i];
                    if (ALWAYS_RUN_STAGES.includes(stage)) {
                        // Teardown and update should NOT be skipped
                        assert.notStrictEqual(stageResults[stage].status, 'skip',
                            `Always-run stage '${stage}' should not be skipped`);
                    } else {
                        // Other stages should be skipped
                        assert.strictEqual(stageResults[stage].status, 'skip',
                            `Stage '${stage}' after failed '${failedStage}' should be skip, got '${stageResults[stage].status}'`);
                        assert.strictEqual(stageResults[stage].durationSeconds, 0,
                            `Skipped stage '${stage}' should have durationSeconds=0, got ${stageResults[stage].durationSeconds}`);
                    }
                }
            }
        ), PROPERTY_CONFIG);
    });

    it('teardown stage always executes regardless of which stage fails', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            arbErrorSummary,
            (failedStage, durations, errorSummary) => {
                const stageResults = buildStageResultsWithFailure(failedStage, durations, [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                // Teardown should always have a non-skip status
                assert.ok(stageResults.teardown, 'Teardown stage should exist in results');
                assert.notStrictEqual(stageResults.teardown.status, 'skip',
                    `Teardown should not be skipped when '${failedStage}' fails`);
            }
        ), PROPERTY_CONFIG);
    });

    it('the failed stage itself retains its fail status', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            arbErrorSummary,
            (failedStage, durations, errorSummary) => {
                const stageResults = buildStageResultsWithFailure(failedStage, durations, [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                assert.strictEqual(stageResults[failedStage].status, 'fail',
                    `Failed stage '${failedStage}' should retain status=fail`);
            }
        ), PROPERTY_CONFIG);
    });
});

describe('Feature: ci-integration-harness, Property 12: Stage result structure completeness', () => {

    /**
     * Validates: Requirements 16.1, 16.2, 12.5
     *
     * For any completed CodeBuild execution, the stageResults map SHALL
     * contain exactly 7 entries with required fields.
     */
    it('all-pass stageResults has exactly 7 valid entries', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            (durations) => {
                const stageResults = buildAllPassResults(durations, []);
                const validation = validateStageResultStructure(stageResults);

                assert.strictEqual(validation.valid, true,
                    `All-pass stageResults should be valid, errors: ${JSON.stringify(validation.errors)}`);
                assert.strictEqual(Object.keys(stageResults).length, 7,
                    `stageResults should have exactly 7 entries, got ${Object.keys(stageResults).length}`);
            }
        ), PROPERTY_CONFIG);
    });

    it('stageResults with one failure has exactly 7 valid entries', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            arbErrorSummary,
            (failedStage, durations, errorSummary) => {
                const stageResults = buildStageResultsWithFailure(failedStage, durations, [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                const validation = validateStageResultStructure(stageResults);

                assert.strictEqual(validation.valid, true,
                    `stageResults with '${failedStage}' failure should be valid, errors: ${JSON.stringify(validation.errors)}`);
                assert.strictEqual(Object.keys(stageResults).length, 7,
                    `stageResults should have exactly 7 entries, got ${Object.keys(stageResults).length}`);

                // Verify each stage has required fields
                for (const stage of STAGE_ORDER) {
                    const entry = stageResults[stage];
                    assert.ok('status' in entry, `Stage '${stage}' should have status field`);
                    assert.ok('durationSeconds' in entry, `Stage '${stage}' should have durationSeconds field`);
                    assert.ok('logPointer' in entry, `Stage '${stage}' should have logPointer field`);
                    assert.ok(['pass', 'fail', 'skip'].includes(entry.status),
                        `Stage '${stage}' status should be pass/fail/skip, got '${entry.status}'`);
                    assert.ok(typeof entry.durationSeconds === 'number' && entry.durationSeconds >= 0,
                        `Stage '${stage}' durationSeconds should be non-negative number`);
                }
            }
        ), PROPERTY_CONFIG);
    });
});

describe('Feature: ci-integration-harness, Property 13: testStatus reflects first failing stage', () => {

    /**
     * Validates: Requirements 16.4
     *
     * For any build execution where one or more stages fail, the CI_Record
     * testStatus SHALL be set to fail-{stageName} where stageName is the
     * first stage that has status=fail. If no stage fails, testStatus=pass.
     */
    it('testStatus is pass when all stages pass', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            (durations) => {
                const stageResults = buildAllPassResults(durations, []);
                const testStatus = computeTestStatus(stageResults);

                assert.strictEqual(testStatus, 'pass',
                    `testStatus should be 'pass' when all stages pass, got '${testStatus}'`);
            }
        ), PROPERTY_CONFIG);
    });

    it('testStatus reflects the first failing stage', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            fc.array(arbDuration, { minLength: 7, maxLength: 7 }),
            arbErrorSummary,
            (failedStage, durations, errorSummary) => {
                const stageResults = buildStageResultsWithFailure(failedStage, durations, [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                const testStatus = computeTestStatus(stageResults);

                assert.strictEqual(testStatus, `fail-${failedStage}`,
                    `testStatus should be 'fail-${failedStage}', got '${testStatus}'`);
            }
        ), PROPERTY_CONFIG);
    });

    it('testStatus reflects the FIRST failing stage when multiple could fail', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailableStage,
            arbErrorSummary,
            (failedStage, errorSummary) => {
                // Build results where the specified stage fails
                // and teardown also fails (teardown always runs)
                const stageResults = buildStageResultsWithFailure(failedStage, [], [], errorSummary);
                applySkipLogic(stageResults, failedStage);

                // Also make teardown fail
                stageResults.teardown = {
                    status: 'fail',
                    durationSeconds: 5,
                    logPointer: 'log/ptr',
                    errorSummary: 'Teardown also failed'
                };

                const testStatus = computeTestStatus(stageResults);

                // The first failing stage in STAGE_ORDER should determine testStatus
                // Since failedStage comes before teardown in the order, it should be the first failure
                const failedIndex = STAGE_ORDER.indexOf(failedStage);
                const teardownIndex = STAGE_ORDER.indexOf('teardown');

                if (failedIndex < teardownIndex) {
                    assert.strictEqual(testStatus, `fail-${failedStage}`,
                        `testStatus should reflect first failure '${failedStage}', not teardown`);
                } else {
                    assert.strictEqual(testStatus, 'fail-teardown',
                        'testStatus should reflect teardown as first failure');
                }
            }
        ), PROPERTY_CONFIG);
    });
});
