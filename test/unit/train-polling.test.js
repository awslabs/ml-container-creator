// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for training job idempotency decision logic.
 *
 * Tests the JavaScript idempotency decision module (src/lib/train-idempotency.js).
 *
 * Note: The previous poll parser and status parser Python scripts
 * (.train_poll_parser.py, .train_status_parser.py) have been removed and their
 * functionality absorbed into .train_helper.py (SDK v3). The new helper's
 * behavior is validated via integration/e2e tests rather than unit tests
 * (since it requires SDK calls).
 *
 * Feature: fine-tuning-training
 * Validates: Requirements 4.1–4.5
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { determineAction, ACTIONS, JOB_STATUSES } from '../../src/lib/train-idempotency.js';

describe('Train Polling — Idempotency Decision Logic (train-idempotency.js)', () => {

    describe('Status transitions', () => {
        it('InProgress → poll existing job', () => {
            const result = determineAction('InProgress', false);
            assert.equal(result.action, ACTIONS.POLL_EXISTING);
            assert.ok(result.reason.includes('InProgress'));
        });

        it('Completed → display results', () => {
            const result = determineAction('Completed', false);
            assert.equal(result.action, ACTIONS.DISPLAY_RESULTS);
            assert.ok(result.reason.includes('Completed'));
        });

        it('Failed → suggest force', () => {
            const result = determineAction('Failed', false);
            assert.equal(result.action, ACTIONS.DISPLAY_FAILURE);
            assert.ok(result.reason.includes('Failed'));
            assert.ok(result.reason.includes('--force'));
        });

        it('Stopped → suggest force', () => {
            const result = determineAction('Stopped', false);
            assert.equal(result.action, ACTIONS.DISPLAY_FAILURE);
            assert.ok(result.reason.includes('Stopped'));
        });

        it('No existing job → create new job', () => {
            const result = determineAction(null, false);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('Empty string status → create new job', () => {
            const result = determineAction('', false);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('undefined status → create new job', () => {
            const result = determineAction(undefined, false);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('Unknown status → display failure', () => {
            const result = determineAction('SomeUnknownStatus', false);
            assert.equal(result.action, ACTIONS.DISPLAY_FAILURE);
            assert.ok(result.reason.includes('Unexpected'));
        });
    });

    describe('Force flag always creates new job', () => {
        it('force overrides InProgress', () => {
            const result = determineAction('InProgress', true);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
            assert.ok(result.reason.includes('--force'));
        });

        it('force overrides Completed', () => {
            const result = determineAction('Completed', true);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('force overrides Failed', () => {
            const result = determineAction('Failed', true);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('force overrides Stopped', () => {
            const result = determineAction('Stopped', true);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        it('force with no existing job still creates new job', () => {
            const result = determineAction(null, true);
            assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
        });

        for (const status of JOB_STATUSES) {
            it(`force overrides ${status} status`, () => {
                const result = determineAction(status, true);
                assert.equal(result.action, ACTIONS.CREATE_NEW_JOB);
            });
        }
    });

    describe('JOB_STATUSES constant', () => {
        it('should contain all expected statuses', () => {
            assert.ok(JOB_STATUSES.includes('InProgress'));
            assert.ok(JOB_STATUSES.includes('Completed'));
            assert.ok(JOB_STATUSES.includes('Failed'));
            assert.ok(JOB_STATUSES.includes('Stopped'));
        });
    });

    describe('ACTIONS constant', () => {
        it('should contain all expected actions', () => {
            assert.equal(ACTIONS.CREATE_NEW_JOB, 'create_new_job');
            assert.equal(ACTIONS.POLL_EXISTING, 'poll_existing');
            assert.equal(ACTIONS.DISPLAY_RESULTS, 'display_results');
            assert.equal(ACTIONS.DISPLAY_FAILURE, 'display_failure');
        });
    });
});
