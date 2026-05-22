// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config Persistence Property-Based Tests
 *
 * Property 2: Config persistence after job submission
 *
 * For any successful job submission (train), the config file SHALL contain
 * the job name stored in TRAIN_JOB_NAME, and after completion SHALL contain
 * TRAIN_OUTPUT_PATH matching the submitted values.
 *
 * Feature: fine-tuning-training, Property 2: Config persistence after job submission
 * Validates: Requirements 3.4, 5.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import {
    updateConfigVar,
    readConfigVar,
    persistTrainSubmission,
    persistTrainCompletion,
    generateTrainJobName
} from '../../src/lib/train-config-persistence.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid project name (lowercase letters, numbers, hyphens).
 */
const projectNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/**
 * Generate a valid timestamp for job name generation.
 */
const timestampArb = fc.date({
    min: new Date(2020, 0, 1),
    max: new Date(2035, 11, 31)
}).filter(d => !isNaN(d.getTime()));

/**
 * Generate a job name matching the pattern ${PROJECT_NAME}-train-${TIMESTAMP}.
 */
const jobNameArb = fc.tuple(projectNameArb, timestampArb)
    .map(([project, ts]) => generateTrainJobName(project, ts));

/**
 * Generate a valid S3 output path (S3 URI).
 */
const s3OutputPathArb = fc.tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9.-]{2,20}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9/_.-]{1,30}$/)
).map(([bucket, key]) => `s3://${bucket}/${key}`);

/**
 * Generate initial config file content with existing variables.
 * Simulates a do/config file that may already have some variables set.
 */
const existingConfigArb = fc.tuple(
    projectNameArb,
    fc.stringMatching(/^[a-z0-9-]{3,15}$/),
    fc.stringMatching(/^us-(east|west)-(1|2)$/)
).map(([project, role, region]) =>
    `#!/bin/bash\n# do/config\nexport PROJECT_NAME="${project}"\nexport ROLE_ARN="arn:aws:iam::123456789012:role/${role}"\nexport AWS_REGION="${region}"\n`
);

/**
 * Generate config content that already has a TRAIN_JOB_NAME set.
 */
const configWithExistingJobArb = fc.tuple(
    existingConfigArb,
    jobNameArb
).map(([config, oldJobName]) =>
    `${config  }export TRAIN_JOB_NAME="${oldJobName}"\n`
);

/**
 * Generate config content that already has both TRAIN_JOB_NAME and TRAIN_OUTPUT_PATH.
 */
const configWithExistingJobAndOutputArb = fc.tuple(
    existingConfigArb,
    jobNameArb,
    s3OutputPathArb
).map(([config, oldJobName, oldOutput]) =>
    `${config  }export TRAIN_JOB_NAME="${oldJobName}"\nexport TRAIN_OUTPUT_PATH="${oldOutput}"\n`
);

// ── Property Tests: Submission Persistence ───────────────────────────────────

describe('Feature: fine-tuning-training, Property 2: Config persistence after job submission', () => {

    describe('TRAIN_JOB_NAME persistence after submission', () => {

        it('TRAIN_JOB_NAME is correctly stored after submission on fresh config', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                (configContent, jobName) => {
                    const updated = persistTrainSubmission(configContent, { jobName });
                    const stored = readConfigVar(updated, 'TRAIN_JOB_NAME');

                    assert.strictEqual(stored, jobName,
                        `TRAIN_JOB_NAME must equal "${jobName}", got "${stored}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('TRAIN_JOB_NAME is correctly updated when it already exists', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                configWithExistingJobArb,
                jobNameArb,
                (configContent, newJobName) => {
                    const updated = persistTrainSubmission(configContent, { jobName: newJobName });
                    const stored = readConfigVar(updated, 'TRAIN_JOB_NAME');

                    assert.strictEqual(stored, newJobName,
                        `TRAIN_JOB_NAME must be updated to "${newJobName}", got "${stored}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('TRAIN_JOB_NAME uses export VAR_NAME="value" format', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                (configContent, jobName) => {
                    const updated = persistTrainSubmission(configContent, { jobName });
                    const expectedLine = `export TRAIN_JOB_NAME="${jobName}"`;

                    assert.ok(updated.includes(expectedLine),
                        `Config must contain line '${expectedLine}', got:\n${updated}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('existing variables are preserved after submission', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                (configContent, jobName) => {
                    const updated = persistTrainSubmission(configContent, { jobName });

                    // All existing variables should still be present
                    const originalProjectName = readConfigVar(configContent, 'PROJECT_NAME');
                    const originalRoleArn = readConfigVar(configContent, 'ROLE_ARN');
                    const originalRegion = readConfigVar(configContent, 'AWS_REGION');

                    const updatedProjectName = readConfigVar(updated, 'PROJECT_NAME');
                    const updatedRoleArn = readConfigVar(updated, 'ROLE_ARN');
                    const updatedRegion = readConfigVar(updated, 'AWS_REGION');

                    assert.strictEqual(updatedProjectName, originalProjectName,
                        `PROJECT_NAME must be preserved: expected "${originalProjectName}", got "${updatedProjectName}"`);
                    assert.strictEqual(updatedRoleArn, originalRoleArn,
                        `ROLE_ARN must be preserved: expected "${originalRoleArn}", got "${updatedRoleArn}"`);
                    assert.strictEqual(updatedRegion, originalRegion,
                        `AWS_REGION must be preserved: expected "${originalRegion}", got "${updatedRegion}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

    });

    describe('TRAIN_OUTPUT_PATH persistence after completion', () => {

        it('TRAIN_OUTPUT_PATH is correctly stored after completion', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                configWithExistingJobArb,
                s3OutputPathArb,
                (configContent, outputPath) => {
                    const updated = persistTrainCompletion(configContent, { outputPath });
                    const stored = readConfigVar(updated, 'TRAIN_OUTPUT_PATH');

                    assert.strictEqual(stored, outputPath,
                        `TRAIN_OUTPUT_PATH must equal "${outputPath}", got "${stored}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('TRAIN_OUTPUT_PATH is correctly updated when it already exists', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                configWithExistingJobAndOutputArb,
                s3OutputPathArb,
                (configContent, newOutputPath) => {
                    const updated = persistTrainCompletion(configContent, { outputPath: newOutputPath });
                    const stored = readConfigVar(updated, 'TRAIN_OUTPUT_PATH');

                    assert.strictEqual(stored, newOutputPath,
                        `TRAIN_OUTPUT_PATH must be updated to "${newOutputPath}", got "${stored}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('TRAIN_JOB_NAME is preserved after completion writes TRAIN_OUTPUT_PATH', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                configWithExistingJobArb,
                s3OutputPathArb,
                (configContent, outputPath) => {
                    const originalJobName = readConfigVar(configContent, 'TRAIN_JOB_NAME');
                    const updated = persistTrainCompletion(configContent, { outputPath });
                    const storedJobName = readConfigVar(updated, 'TRAIN_JOB_NAME');

                    assert.strictEqual(storedJobName, originalJobName,
                        `TRAIN_JOB_NAME must be preserved: expected "${originalJobName}", got "${storedJobName}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

    });

    describe('Full submission + completion lifecycle', () => {

        it('config contains both TRAIN_JOB_NAME and TRAIN_OUTPUT_PATH after full lifecycle', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                s3OutputPathArb,
                (configContent, jobName, outputPath) => {
                    // Simulate submission
                    let config = persistTrainSubmission(configContent, { jobName });
                    // Simulate completion
                    config = persistTrainCompletion(config, { outputPath });

                    const storedJobName = readConfigVar(config, 'TRAIN_JOB_NAME');
                    const storedOutputPath = readConfigVar(config, 'TRAIN_OUTPUT_PATH');

                    assert.strictEqual(storedJobName, jobName,
                        `TRAIN_JOB_NAME must be "${jobName}" after full lifecycle, got "${storedJobName}"`);
                    assert.strictEqual(storedOutputPath, outputPath,
                        `TRAIN_OUTPUT_PATH must be "${outputPath}" after full lifecycle, got "${storedOutputPath}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('re-submission with --force correctly updates TRAIN_JOB_NAME', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                s3OutputPathArb,
                jobNameArb,
                (configContent, jobName1, outputPath1, jobName2) => {
                    // First lifecycle: submission + completion
                    let config = persistTrainSubmission(configContent, { jobName: jobName1 });
                    config = persistTrainCompletion(config, { outputPath: outputPath1 });

                    // Second submission (simulates --force)
                    config = persistTrainSubmission(config, { jobName: jobName2 });

                    const storedJobName = readConfigVar(config, 'TRAIN_JOB_NAME');

                    assert.strictEqual(storedJobName, jobName2,
                        `TRAIN_JOB_NAME must be updated to "${jobName2}" after re-submission, got "${storedJobName}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('existing config variables survive full submission + completion lifecycle', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                jobNameArb,
                s3OutputPathArb,
                (configContent, jobName, outputPath) => {
                    // Record original variables
                    const originalProjectName = readConfigVar(configContent, 'PROJECT_NAME');
                    const originalRoleArn = readConfigVar(configContent, 'ROLE_ARN');
                    const originalRegion = readConfigVar(configContent, 'AWS_REGION');

                    // Full lifecycle
                    let config = persistTrainSubmission(configContent, { jobName });
                    config = persistTrainCompletion(config, { outputPath });

                    // Verify originals are preserved
                    assert.strictEqual(readConfigVar(config, 'PROJECT_NAME'), originalProjectName,
                        'PROJECT_NAME must be preserved through full lifecycle');
                    assert.strictEqual(readConfigVar(config, 'ROLE_ARN'), originalRoleArn,
                        'ROLE_ARN must be preserved through full lifecycle');
                    assert.strictEqual(readConfigVar(config, 'AWS_REGION'), originalRegion,
                        'AWS_REGION must be preserved through full lifecycle');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

    });

    describe('updateConfigVar core behavior', () => {

        it('appending a new variable does not modify existing lines', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                fc.stringMatching(/^[A-Z][A-Z_]{2,15}$/),
                fc.stringMatching(/^[a-z0-9/_.-]{3,30}$/),
                (configContent, varName, varValue) => {
                    // Ensure the variable doesn't already exist
                    fc.pre(!configContent.includes(`export ${varName}=`));

                    const updated = updateConfigVar(configContent, varName, varValue);

                    // All original lines should still be present
                    const originalLines = configContent.split('\n').filter(l => l.trim().length > 0);
                    for (const line of originalLines) {
                        assert.ok(updated.includes(line),
                            `Original line "${line}" must be preserved after appending ${varName}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('updating an existing variable only changes that one line', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                existingConfigArb,
                s3OutputPathArb,
                (configContent, newValue) => {
                    // Use PROJECT_NAME as the variable to update (it exists in all generated configs)
                    const originalProjectName = readConfigVar(configContent, 'PROJECT_NAME');
                    fc.pre(originalProjectName !== null);

                    const updated = updateConfigVar(configContent, 'PROJECT_NAME', newValue);

                    // The updated variable should have the new value
                    assert.strictEqual(readConfigVar(updated, 'PROJECT_NAME'), newValue,
                        `PROJECT_NAME must be updated to "${newValue}"`);

                    // Other variables should be unchanged
                    const originalRoleArn = readConfigVar(configContent, 'ROLE_ARN');
                    const updatedRoleArn = readConfigVar(updated, 'ROLE_ARN');
                    assert.strictEqual(updatedRoleArn, originalRoleArn,
                        `ROLE_ARN must be unchanged: expected "${originalRoleArn}", got "${updatedRoleArn}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

    });

    describe('Job name generation', () => {

        it('generated job name matches pattern ${PROJECT_NAME}-train-YYYYMMDD-HHMMSS', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                projectNameArb,
                timestampArb,
                (projectName, timestamp) => {
                    const jobName = generateTrainJobName(projectName, timestamp);
                    const pattern = new RegExp(`^${projectName}-train-\\d{8}-\\d{6}$`);

                    assert.ok(pattern.test(jobName),
                        `Job name "${jobName}" must match pattern "^${projectName}-train-\\d{8}-\\d{6}$"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('generated job name contains correct timestamp components', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                projectNameArb,
                timestampArb,
                (projectName, timestamp) => {
                    const jobName = generateTrainJobName(projectName, timestamp);

                    // Extract the timestamp portion
                    const prefix = `${projectName}-train-`;
                    const suffix = jobName.slice(prefix.length);
                    const datePart = suffix.slice(0, 8);
                    const timePart = suffix.slice(9, 15);

                    const expectedDate = `${timestamp.getFullYear()}${String(timestamp.getMonth() + 1).padStart(2, '0')}${String(timestamp.getDate()).padStart(2, '0')}`;
                    const expectedTime = `${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}${String(timestamp.getSeconds()).padStart(2, '0')}`;

                    assert.strictEqual(datePart, expectedDate,
                        `Date part "${datePart}" must equal "${expectedDate}"`);
                    assert.strictEqual(timePart, expectedTime,
                        `Time part "${timePart}" must equal "${expectedTime}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

    });

});
