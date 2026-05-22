// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Force Flag Override Property-Based Tests
 *
 * Property 6: Force flag overrides idempotency
 *
 * For any existing job status (InProgress, Completed, Failed, Stopped) stored
 * in config, running the command with --force SHALL create a new job regardless
 * of the existing status, for both do/tune and do/train.
 *
 * Feature: fine-tuning-training, Property 6: Force flag overrides idempotency
 * Validates: Requirements 5.5
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import {
    determineAction,
    ACTIONS,
    JOB_STATUSES
} from '../../src/lib/train-idempotency.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid existing job status from the known SageMaker statuses.
 */
const jobStatusArb = fc.constantFrom(...JOB_STATUSES);

/**
 * Generate any non-empty string to represent an unknown/unexpected status.
 */
const unknownStatusArb = fc.stringMatching(/^[A-Z][a-zA-Z]{3,15}$/)
    .filter(s => !JOB_STATUSES.includes(s));

/**
 * Generate a "no existing job" value (null, undefined, or empty string).
 */
const noJobStatusArb = fc.constantFrom(null, undefined, '');

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: fine-tuning-training, Property 6: Force flag overrides idempotency', () => {

    it('--force always produces create_new_job regardless of existing job status', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            jobStatusArb,
            (existingStatus) => {
                const result = determineAction(existingStatus, true);

                assert.strictEqual(
                    result.action,
                    ACTIONS.CREATE_NEW_JOB,
                    `With --force and status "${existingStatus}", action must be "${ACTIONS.CREATE_NEW_JOB}", ` +
                    `got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('--force produces create_new_job even with unknown/unexpected statuses', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            unknownStatusArb,
            (unknownStatus) => {
                const result = determineAction(unknownStatus, true);

                assert.strictEqual(
                    result.action,
                    ACTIONS.CREATE_NEW_JOB,
                    `With --force and unknown status "${unknownStatus}", action must be "${ACTIONS.CREATE_NEW_JOB}", ` +
                    `got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('--force produces create_new_job when no existing job exists', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            noJobStatusArb,
            (noStatus) => {
                const result = determineAction(noStatus, true);

                assert.strictEqual(
                    result.action,
                    ACTIONS.CREATE_NEW_JOB,
                    `With --force and no existing job (${JSON.stringify(noStatus)}), ` +
                    `action must be "${ACTIONS.CREATE_NEW_JOB}", got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('without --force, InProgress status produces poll_existing', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const result = determineAction('InProgress', false);

        assert.strictEqual(
            result.action,
            ACTIONS.POLL_EXISTING,
            `Without --force and InProgress, action must be "${ACTIONS.POLL_EXISTING}", ` +
            `got "${result.action}"`
        );
    });

    it('without --force, Completed status produces display_results', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const result = determineAction('Completed', false);

        assert.strictEqual(
            result.action,
            ACTIONS.DISPLAY_RESULTS,
            `Without --force and Completed, action must be "${ACTIONS.DISPLAY_RESULTS}", ` +
            `got "${result.action}"`
        );
    });

    it('without --force, Failed status produces display_failure', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const result = determineAction('Failed', false);

        assert.strictEqual(
            result.action,
            ACTIONS.DISPLAY_FAILURE,
            `Without --force and Failed, action must be "${ACTIONS.DISPLAY_FAILURE}", ` +
            `got "${result.action}"`
        );
    });

    it('without --force, Stopped status produces display_failure', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const result = determineAction('Stopped', false);

        assert.strictEqual(
            result.action,
            ACTIONS.DISPLAY_FAILURE,
            `Without --force and Stopped, action must be "${ACTIONS.DISPLAY_FAILURE}", ` +
            `got "${result.action}"`
        );
    });

    it('without --force, no existing job produces create_new_job', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            noJobStatusArb,
            (noStatus) => {
                const result = determineAction(noStatus, false);

                assert.strictEqual(
                    result.action,
                    ACTIONS.CREATE_NEW_JOB,
                    `Without --force and no existing job (${JSON.stringify(noStatus)}), ` +
                    `action must be "${ACTIONS.CREATE_NEW_JOB}", got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('without --force, existing status never produces create_new_job', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            jobStatusArb,
            (existingStatus) => {
                const result = determineAction(existingStatus, false);

                assert.notStrictEqual(
                    result.action,
                    ACTIONS.CREATE_NEW_JOB,
                    `Without --force and status "${existingStatus}", action must NOT be ` +
                    `"${ACTIONS.CREATE_NEW_JOB}", but got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('result always includes a non-empty reason string', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.oneof(jobStatusArb, noJobStatusArb, unknownStatusArb),
            fc.boolean(),
            (status, force) => {
                const result = determineAction(status, force);

                assert.ok(
                    typeof result.reason === 'string' && result.reason.length > 0,
                    `Result must include a non-empty reason string, got: ${JSON.stringify(result.reason)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('result action is always one of the defined ACTIONS values', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        const validActions = Object.values(ACTIONS);

        fc.assert(fc.property(
            fc.oneof(jobStatusArb, noJobStatusArb, unknownStatusArb),
            fc.boolean(),
            (status, force) => {
                const result = determineAction(status, force);

                assert.ok(
                    validActions.includes(result.action),
                    `Result action must be one of ${JSON.stringify(validActions)}, ` +
                    `got "${result.action}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
