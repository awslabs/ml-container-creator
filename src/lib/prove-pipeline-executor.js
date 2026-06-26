// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove Pipeline Executor
 *
 * Executes lifecycle stages for validation targets in the `mcc prove` workflow.
 * Handles stage-specific logic including idempotency checks, status tracking,
 * and fail-fast behavior.
 *
 * ## Module Status (AC-1.4)
 *
 * FUNCTIONAL stages:
 * - `executeStageStep()` — fully wired with idempotency via `.mlcc/staged-assets.json`
 * - `isAlreadyStaged()` — checks staged assets existence and validity
 * - `getStagingState()` — resolves current staging state from filesystem + step results
 * - `isValidLifecycleStage()` — validates individual stage names
 * - `validateStagesArray()` — validates arrays of stage names
 * - `formatStagingStatus()` — formats staging state for display
 * - `buildTargetStatus()` — builds status summary for a prove target
 *
 * INTENTIONALLY INCOMPLETE (post-v1 scope):
 * - Other lifecycle stage executors (build, push, deploy, test, tune, adapter,
 *   test-adapter, benchmark, register, clean) are NOT implemented.
 * - Only the `stage` step has execution logic. Other stages are recognized in
 *   validation but have no executor function.
 * - This is not "broken" — these were never finished before the laptop was bricked.
 *   They are explicitly post-v1 scope.
 *
 * Feature: s3-model-loading
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ── Valid Lifecycle Stages ────────────────────────────────────────────────────

/**
 * All recognized lifecycle stages for the prove pipeline.
 * The "stage" step pre-stages model weights from HuggingFace to S3.
 */
export const VALID_LIFECYCLE_STAGES = [
    'generate',
    'stage',
    'build',
    'push',
    'deploy',
    'test',
    'tune',
    'adapter',
    'test-adapter',
    'benchmark',
    'register',
    'clean'
];

// TODO(post-v1): Implement executor functions for lifecycle stages beyond 'stage'.
// The following stages are recognized for validation purposes but have no execution logic:
//   - generate: Should invoke `mcc generate` to produce project scaffolding
//   - build: Should run `do/build` to build the Docker container
//   - push: Should run `do/push` to push container to ECR
//   - deploy: Should run `do/deploy` to create SageMaker endpoint
//   - test: Should run `do/test` to invoke endpoint and verify correctness
//   - tune: Should run `do/tune` for fine-tuning jobs (gated by shouldExecuteTuneStages)
//   - adapter: Should run `do/adapter` for LoRA adapter serving
//   - test-adapter: Should test adapter endpoints after deployment
//   - benchmark: Should run `do/benchmark` for performance measurement
//   - register: Should register proven config in Athena/DynamoDB
//   - clean: Should tear down deployed resources
// These were never finished before the original developer's laptop was bricked.
// They are explicitly post-v1 scope, not "broken" code.

/**
 * Possible staging states for status output.
 */
export const STAGING_STATES = {
    STAGED: 'staged',
    NOT_STAGED: 'not-staged',
    STAGE_FAILED: 'stage-failed'
};

// ── Stage Lifecycle Step ─────────────────────────────────────────────────────

/**
 * Check if a model has already been staged by looking for `.mlcc/staged-assets.json`.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @returns {boolean} True if the model has already been staged
 */
export function isAlreadyStaged(projectDir) {
    const stagedAssetsPath = path.join(projectDir, '.mlcc', 'staged-assets.json');
    if (!existsSync(stagedAssetsPath)) {
        return false;
    }

    try {
        const content = readFileSync(stagedAssetsPath, 'utf8');
        const data = JSON.parse(content);
        // Check that there's a valid staged URI
        return !!(data?.models?.default?.staged_uri);
    } catch {
        return false;
    }
}

/**
 * Get the current staging state for a project.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @param {object} [stepResults] - Previous step results (to check for stage-failed)
 * @returns {string} One of: 'staged', 'not-staged', 'stage-failed'
 */
export function getStagingState(projectDir, stepResults = null) {
    // Check if stage previously failed
    if (stepResults?.stage?.status === 'fail') {
        return STAGING_STATES.STAGE_FAILED;
    }

    if (isAlreadyStaged(projectDir)) {
        return STAGING_STATES.STAGED;
    }

    return STAGING_STATES.NOT_STAGED;
}

/**
 * Execute the stage lifecycle step with idempotency support.
 *
 * If the model is already staged (`.mlcc/staged-assets.json` exists with a valid URI),
 * the step is skipped and marked as passed.
 *
 * If `do/stage` exits non-zero, the model is marked as stage-failed.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=1800] - Timeout in seconds (default: 30 minutes)
 * @param {boolean} [options.verbose=false] - Stream stdout/stderr in real time
 * @returns {Promise<object>} StepResult with name, status, duration, stagingState, and optional error
 */
export async function executeStageStep(projectDir, options = {}) {
    const { timeout = 1800, verbose = false } = options;
    const startTime = Date.now();

    // Idempotency check: skip if already staged (Requirement 5.4)
    if (isAlreadyStaged(projectDir)) {
        return {
            name: 'stage',
            status: 'pass',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGED,
            skipped: true,
            message: '✓ Model already staged — skipping'
        };
    }

    // Execute do/stage and verify exit code 0 (Requirement 5.2)
    const command = './do/stage';

    try {
        if (verbose) {
            // Verbose: stream output in real time
            const { spawn } = await import('node:child_process');
            const result = await new Promise((resolve) => {
                const child = spawn('bash', ['-c', command], {
                    cwd: projectDir,
                    stdio: ['pipe', 'inherit', 'inherit']
                });

                let killed = false;
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill('SIGTERM');
                }, timeout * 1000);

                child.on('close', (code) => {
                    clearTimeout(timer);
                    if (code === 0) {
                        resolve({
                            name: 'stage',
                            status: 'pass',
                            duration: Date.now() - startTime,
                            stagingState: STAGING_STATES.STAGED
                        });
                    } else {
                        const error = killed
                            ? `Timeout after ${timeout}s`
                            : `do/stage exited with code ${code}`;
                        resolve({
                            name: 'stage',
                            status: 'fail',
                            duration: Date.now() - startTime,
                            stagingState: STAGING_STATES.STAGE_FAILED,
                            error
                        });
                    }
                });

                child.on('error', (err) => {
                    clearTimeout(timer);
                    resolve({
                        name: 'stage',
                        status: 'fail',
                        duration: Date.now() - startTime,
                        stagingState: STAGING_STATES.STAGE_FAILED,
                        error: err.message.slice(-500)
                    });
                });
            });
            return result;
        }

        // Non-verbose: buffer output
        await execFileAsync('bash', ['-c', command], {
            cwd: projectDir,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        });

        return {
            name: 'stage',
            status: 'pass',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGED
        };
    } catch (err) {
        // Mark model as failed if staging fails (Requirement 5.3)
        const error = err.killed
            ? `Timeout after ${timeout}s`
            : (err.stderr || err.message).slice(-500);

        return {
            name: 'stage',
            status: 'fail',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGE_FAILED,
            error
        };
    }
}

// ── Stage Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a lifecycle stage name is recognized by the prove pipeline.
 *
 * @param {string} stageName - The stage name to validate
 * @returns {boolean} True if the stage is valid
 */
export function isValidLifecycleStage(stageName) {
    return VALID_LIFECYCLE_STAGES.includes(stageName);
}

/**
 * Validate a stages array from validation-targets configuration.
 *
 * @param {string[]} stages - Array of stage names
 * @returns {object} Validation result: { valid: boolean, errors: string[] }
 */
export function validateStagesArray(stages) {
    const errors = [];

    if (!Array.isArray(stages)) {
        return { valid: false, errors: ['stages must be an array'] };
    }

    if (stages.length === 0) {
        return { valid: false, errors: ['stages array must not be empty'] };
    }

    for (const stage of stages) {
        if (typeof stage !== 'string') {
            errors.push(`Invalid stage type: expected string, got ${typeof stage}`);
            continue;
        }
        if (!isValidLifecycleStage(stage)) {
            errors.push(`Unrecognized lifecycle stage: "${stage}"`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// ── Status Output ────────────────────────────────────────────────────────────

/**
 * Format the staging state for status output display.
 *
 * @param {string} state - One of STAGING_STATES values
 * @returns {string} Formatted status string with emoji
 */
export function formatStagingStatus(state) {
    switch (state) {
    case STAGING_STATES.STAGED:
        return '✓ staged';
    case STAGING_STATES.NOT_STAGED:
        return '○ not-staged';
    case STAGING_STATES.STAGE_FAILED:
        return '✗ stage-failed';
    default:
        return '? unknown';
    }
}

/**
 * Build a status summary for a prove target including staging state.
 *
 * @param {object} target - The validation target
 * @param {string} target.model_name - Model name
 * @param {string} projectDir - Path to the project directory
 * @param {object} [stepResults] - Results of executed steps
 * @returns {object} Status summary including stagingState
 */
export function buildTargetStatus(target, projectDir, stepResults = null) {
    const stagingState = getStagingState(projectDir, stepResults);
    const stages = target.stages || [];
    const includesStage = stages.includes('stage');

    return {
        model_name: target.model_name,
        stagingState,
        stagingStatus: formatStagingStatus(stagingState),
        includesStageStep: includesStage
    };
}
