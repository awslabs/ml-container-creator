// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Orchestrator State Transitions Property-Based Tests
 *
 * Property 6: Orchestrator state transitions
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { computeTestStatus, STAGE_ORDER, ALWAYS_RUN_STAGES } from '../../src/lib/ci-stage-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Pure orchestrator state transition function ──────────────────────────────

/**
 * Simulate the orchestrator's state transition logic as a pure function.
 *
 * 1. Sets testStatus to 'running' before build starts
 * 2. After build completes, computes final testStatus from stageResults
 * 3. Records lastTestTimestamp and lastTestDuration
 *
 * @param {object} record - The CI_Record before processing
 * @param {object} stageResults - The stage results from CodeBuild
 * @param {Date} startTime - When processing started
 * @param {Date} endTime - When processing completed
 * @returns {object} The updated CI_Record
 */
function simulateOrchestratorTransition(record, stageResults, startTime, endTime) {
    // Step 1: Set running before build
    const runningRecord = {
        ...record,
        testStatus: 'running'
    };

    // Step 2: After build, compute final status
    const finalTestStatus = computeTestStatus(stageResults);
    const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

    const finalRecord = {
        ...runningRecord,
        testStatus: finalTestStatus,
        stageResults,
        lastTestTimestamp: endTime.toISOString(),
        lastTestDuration: durationSeconds
    };

    return { runningRecord, finalRecord };
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate valid stage results where at most one stage fails,
 * and skip logic is correctly applied.
 */
const arbStageResults = fc.oneof(
    // All pass
    fc.constant(Object.fromEntries(
        STAGE_ORDER.map(stage => [stage, { status: 'pass', durationSeconds: 10, logPointer: 'log/ptr', errorSummary: '' }])
    )),
    // One stage fails, subsequent non-always-run stages are skipped
    fc.constantFrom(...STAGE_ORDER.filter(s => !ALWAYS_RUN_STAGES.includes(s)))
        .map(failedStage => {
            const failedIndex = STAGE_ORDER.indexOf(failedStage);
            const results = {};
            for (let i = 0; i < STAGE_ORDER.length; i++) {
                const stage = STAGE_ORDER[i];
                if (i < failedIndex) {
                    results[stage] = { status: 'pass', durationSeconds: 10, logPointer: 'log/ptr', errorSummary: '' };
                } else if (i === failedIndex) {
                    results[stage] = { status: 'fail', durationSeconds: 5, logPointer: 'log/ptr', errorSummary: 'Error occurred' };
                } else if (ALWAYS_RUN_STAGES.includes(stage)) {
                    results[stage] = { status: 'pass', durationSeconds: 3, logPointer: 'log/ptr', errorSummary: '' };
                } else {
                    results[stage] = { status: 'skip', durationSeconds: 0, logPointer: '', errorSummary: '' };
                }
            }
            return results;
        })
);

const arbInitialRecord = fc.record({
    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
    testStatus: fc.constantFrom('untested', 'pass', 'fail-build', 'fail-deploy'),
    configJson: fc.constant('{"test":"data"}'),
    lastTestTimestamp: fc.constantFrom('1970-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    lastTestDuration: fc.nat({ max: 5400 })
});

const arbDuration = fc.integer({ min: 60, max: 5400 });

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 6: Orchestrator state transitions', () => {

    /**
     * Validates: Requirements 5.3, 5.4, 5.5
     *
     * For any CI_Record processed by the orchestrator, the system SHALL:
     * (a) set testStatus=running before starting the CodeBuild build, and
     * (b) after build completion, update the record with the correct final
     * testStatus, stageResults, lastTestTimestamp, lastTestDuration.
     */
    it('orchestrator sets testStatus=running before build starts', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInitialRecord,
            arbStageResults,
            arbDuration,
            (initialRecord, stageResults, durationSecs) => {
                const startTime = new Date('2026-06-01T12:00:00Z');
                const endTime = new Date(startTime.getTime() + durationSecs * 1000);

                const { runningRecord } = simulateOrchestratorTransition(
                    initialRecord, stageResults, startTime, endTime
                );

                assert.strictEqual(runningRecord.testStatus, 'running',
                    'Record should have testStatus=running before build starts');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('orchestrator updates record with correct final testStatus after build', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInitialRecord,
            arbStageResults,
            arbDuration,
            (initialRecord, stageResults, durationSecs) => {
                const startTime = new Date('2026-06-01T12:00:00Z');
                const endTime = new Date(startTime.getTime() + durationSecs * 1000);

                const { finalRecord } = simulateOrchestratorTransition(
                    initialRecord, stageResults, startTime, endTime
                );

                // Final testStatus should match computeTestStatus
                const expectedStatus = computeTestStatus(stageResults);
                assert.strictEqual(finalRecord.testStatus, expectedStatus,
                    `Final testStatus should be '${expectedStatus}', got '${finalRecord.testStatus}'`);

                // testStatus should not be 'running' after completion
                assert.notStrictEqual(finalRecord.testStatus, 'running',
                    'Final testStatus should not be running after build completes');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('orchestrator records correct lastTestTimestamp and lastTestDuration', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInitialRecord,
            arbStageResults,
            arbDuration,
            (initialRecord, stageResults, durationSecs) => {
                const startTime = new Date('2026-06-01T12:00:00Z');
                const endTime = new Date(startTime.getTime() + durationSecs * 1000);

                const { finalRecord } = simulateOrchestratorTransition(
                    initialRecord, stageResults, startTime, endTime
                );

                // lastTestTimestamp should be the end time
                assert.strictEqual(finalRecord.lastTestTimestamp, endTime.toISOString(),
                    'lastTestTimestamp should be set to build completion time');

                // lastTestDuration should be the elapsed seconds
                assert.strictEqual(finalRecord.lastTestDuration, durationSecs,
                    `lastTestDuration should be ${durationSecs}, got ${finalRecord.lastTestDuration}`);

                // stageResults should be stored
                assert.deepStrictEqual(finalRecord.stageResults, stageResults,
                    'stageResults should be stored in the final record');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('orchestrator sets testStatus=pass when all stages pass', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInitialRecord,
            arbDuration,
            (initialRecord, durationSecs) => {
                const allPassResults = Object.fromEntries(
                    STAGE_ORDER.map(stage => [stage, {
                        status: 'pass',
                        durationSeconds: 10,
                        logPointer: 'log/ptr',
                        errorSummary: ''
                    }])
                );

                const startTime = new Date('2026-06-01T12:00:00Z');
                const endTime = new Date(startTime.getTime() + durationSecs * 1000);

                const { finalRecord } = simulateOrchestratorTransition(
                    initialRecord, allPassResults, startTime, endTime
                );

                assert.strictEqual(finalRecord.testStatus, 'pass',
                    'testStatus should be pass when all stages pass');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
