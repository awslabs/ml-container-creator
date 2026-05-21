// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Idempotency Decision Logic
 *
 * Models the idempotency check logic from the bash `_check_idempotency` function
 * in `templates/do/train` as a pure JavaScript function for property-based testing.
 *
 * The idempotency pattern:
 * - If --force is set, always create a new job regardless of existing status
 * - If no existing job, create a new job
 * - If existing job is InProgress, poll it
 * - If existing job is Completed, display results
 * - If existing job is Failed or Stopped, display failure and suggest --force
 *
 * Requirements: 5.1–5.5
 */

/**
 * Valid existing job statuses that SageMaker can report.
 */
export const JOB_STATUSES = ['InProgress', 'Completed', 'Failed', 'Stopped'];

/**
 * Possible actions the train script can take after the idempotency check.
 */
export const ACTIONS = {
    CREATE_NEW_JOB: 'create_new_job',
    POLL_EXISTING: 'poll_existing',
    DISPLAY_RESULTS: 'display_results',
    DISPLAY_FAILURE: 'display_failure'
};

/**
 * Determine the action to take based on existing job status and force flag.
 *
 * This mirrors the bash `_check_idempotency` logic in a testable form:
 * - force=true → always create_new_job
 * - no existing status (null/empty) → create_new_job
 * - InProgress → poll_existing
 * - Completed → display_results
 * - Failed → display_failure
 * - Stopped → display_failure
 *
 * @param {string|null|undefined} existingStatus - The current job status from DescribeTrainingJob
 * @param {boolean} forceFlag - Whether --force was specified
 * @returns {{ action: string, reason: string }}
 *   - action: one of ACTIONS values
 *   - reason: human-readable explanation of why this action was chosen
 */
export function determineAction(existingStatus, forceFlag) {
    // Force flag always overrides — create a new job regardless of existing status
    if (forceFlag === true) {
        return {
            action: ACTIONS.CREATE_NEW_JOB,
            reason: '--force specified, creating new job regardless of existing status'
        };
    }

    // No existing job — create a new one
    if (!existingStatus || existingStatus === '') {
        return {
            action: ACTIONS.CREATE_NEW_JOB,
            reason: 'No existing job found, creating new job'
        };
    }

    // Existing job found — action depends on status
    switch (existingStatus) {
    case 'InProgress':
        return {
            action: ACTIONS.POLL_EXISTING,
            reason: `Existing job is ${existingStatus}, resuming polling`
        };

    case 'Completed':
        return {
            action: ACTIONS.DISPLAY_RESULTS,
            reason: `Existing job is ${existingStatus}, displaying results`
        };

    case 'Failed':
    case 'Stopped':
        return {
            action: ACTIONS.DISPLAY_FAILURE,
            reason: `Existing job is ${existingStatus}, suggest --force to create new job`
        };

    default:
        // Unknown status — treat as failure, suggest --force
        return {
            action: ACTIONS.DISPLAY_FAILURE,
            reason: `Unexpected job status: ${existingStatus}, suggest --force`
        };
    }
}
