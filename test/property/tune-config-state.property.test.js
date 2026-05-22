// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Config State Property-Based Tests
 *
 * Property 11: Config persistence after job submission
 *
 * For any successful job submission with technique T, training type TT,
 * and dataset path D, the config file SHALL contain:
 * TUNE_JOB_NAME_<T> matching the job name pattern,
 * TUNE_TECHNIQUE=<T>, TUNE_TRAINING_TYPE=<TT>, and TUNE_DATASET_PATH=<D>.
 *
 * Feature: managed-model-customization, Property 11: Config persistence after job submission
 * Validates: Requirements 5.6, 5.7, 5.8, 5.9
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    updateConfigVar,
    readConfigVar,
    persistSubmissionState,
    generateJobName
} from '../../src/lib/tune-config-state.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

const techniqueArb = fc.constantFrom('sft', 'dpo', 'rlaif', 'rlvr');

const trainingTypeArb = fc.constantFrom('lora', 'full-rank');

const projectNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

const s3DatasetPathArb = fc.tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9.-]{2,20}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9/_.-]{1,30}\.jsonl$/)
).map(([bucket, key]) => `s3://${bucket}/${key}`);

const hfDatasetPathArb = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{1,15}$/),
    fc.stringMatching(/^[a-z][a-z0-9_-]{1,20}$/)
).map(([org, name]) => `hf://${org}/${name}`);

const datasetPathArb = fc.oneof(s3DatasetPathArb, hfDatasetPathArb);

// ── Helpers ──────────────────────────────────────────────────────────────────

let tempDir;
let configPath;

function setupTempConfig(initialContent = '') {
    tempDir = join(tmpdir(), `tune-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    configPath = join(tempDir, 'config');
    writeFileSync(configPath, initialContent, 'utf8');
}

function cleanupTempConfig() {
    try {
        unlinkSync(configPath);
    } catch (e) {
        // ignore
    }
}

// ── Property 11: Config persistence after job submission ─────────────────────

describe('Feature: managed-model-customization, Property 11: Config persistence after job submission', () => {

    beforeEach(() => {
        setupTempConfig('#!/bin/bash\n# do/config\nexport PROJECT_NAME="test-project"\n');
    });

    afterEach(() => {
        cleanupTempConfig();
    });

    it('config contains correct TUNE_JOB_NAME_<T> after submission', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            (technique, trainingType, datasetPath, projectName) => {
                // Reset config for each iteration
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const jobName = generateJobName(projectName, technique);

                persistSubmissionState(configPath, {
                    technique,
                    trainingType,
                    datasetPath,
                    jobName
                });

                const techniqueUpper = technique.toUpperCase();
                const storedJobName = readConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`);

                assert.strictEqual(storedJobName, jobName,
                    `TUNE_JOB_NAME_${techniqueUpper} must equal the job name "${jobName}", got "${storedJobName}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('config contains correct TUNE_TECHNIQUE after submission', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            (technique, trainingType, datasetPath, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const jobName = generateJobName(projectName, technique);

                persistSubmissionState(configPath, {
                    technique,
                    trainingType,
                    datasetPath,
                    jobName
                });

                const storedTechnique = readConfigVar(configPath, 'TUNE_TECHNIQUE');

                assert.strictEqual(storedTechnique, technique,
                    `TUNE_TECHNIQUE must equal "${technique}", got "${storedTechnique}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('config contains correct TUNE_TRAINING_TYPE after submission', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            (technique, trainingType, datasetPath, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const jobName = generateJobName(projectName, technique);

                persistSubmissionState(configPath, {
                    technique,
                    trainingType,
                    datasetPath,
                    jobName
                });

                const storedTrainingType = readConfigVar(configPath, 'TUNE_TRAINING_TYPE');

                assert.strictEqual(storedTrainingType, trainingType,
                    `TUNE_TRAINING_TYPE must equal "${trainingType}", got "${storedTrainingType}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('config contains correct TUNE_DATASET_PATH after submission', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            (technique, trainingType, datasetPath, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const jobName = generateJobName(projectName, technique);

                persistSubmissionState(configPath, {
                    technique,
                    trainingType,
                    datasetPath,
                    jobName
                });

                const storedDatasetPath = readConfigVar(configPath, 'TUNE_DATASET_PATH');

                assert.strictEqual(storedDatasetPath, datasetPath,
                    `TUNE_DATASET_PATH must equal "${datasetPath}", got "${storedDatasetPath}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('all four config vars are present simultaneously after submission', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            (technique, trainingType, datasetPath, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const jobName = generateJobName(projectName, technique);

                persistSubmissionState(configPath, {
                    technique,
                    trainingType,
                    datasetPath,
                    jobName
                });

                const techniqueUpper = technique.toUpperCase();

                // All four must be present
                const storedJobName = readConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`);
                const storedTechnique = readConfigVar(configPath, 'TUNE_TECHNIQUE');
                const storedTrainingType = readConfigVar(configPath, 'TUNE_TRAINING_TYPE');
                const storedDatasetPath = readConfigVar(configPath, 'TUNE_DATASET_PATH');

                assert.strictEqual(storedJobName, jobName,
                    `TUNE_JOB_NAME_${techniqueUpper} must be "${jobName}"`);
                assert.strictEqual(storedTechnique, technique,
                    `TUNE_TECHNIQUE must be "${technique}"`);
                assert.strictEqual(storedTrainingType, trainingType,
                    `TUNE_TRAINING_TYPE must be "${trainingType}"`);
                assert.strictEqual(storedDatasetPath, datasetPath,
                    `TUNE_DATASET_PATH must be "${datasetPath}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('config vars are correctly updated on re-submission (overwrite)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            trainingTypeArb,
            datasetPathArb,
            (technique, trainingType1, datasetPath1, projectName, trainingType2, datasetPath2) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                // First submission
                const jobName1 = generateJobName(projectName, technique, new Date(2025, 0, 15, 10, 30, 0));
                persistSubmissionState(configPath, {
                    technique,
                    trainingType: trainingType1,
                    datasetPath: datasetPath1,
                    jobName: jobName1
                });

                // Second submission (same technique, different params)
                const jobName2 = generateJobName(projectName, technique, new Date(2025, 0, 15, 11, 45, 0));
                persistSubmissionState(configPath, {
                    technique,
                    trainingType: trainingType2,
                    datasetPath: datasetPath2,
                    jobName: jobName2
                });

                const techniqueUpper = technique.toUpperCase();

                // Config should reflect the SECOND submission
                const storedJobName = readConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`);
                const storedTechnique = readConfigVar(configPath, 'TUNE_TECHNIQUE');
                const storedTrainingType = readConfigVar(configPath, 'TUNE_TRAINING_TYPE');
                const storedDatasetPath = readConfigVar(configPath, 'TUNE_DATASET_PATH');

                assert.strictEqual(storedJobName, jobName2,
                    `TUNE_JOB_NAME_${techniqueUpper} must be updated to "${jobName2}"`);
                assert.strictEqual(storedTechnique, technique,
                    `TUNE_TECHNIQUE must be "${technique}"`);
                assert.strictEqual(storedTrainingType, trainingType2,
                    `TUNE_TRAINING_TYPE must be updated to "${trainingType2}"`);
                assert.strictEqual(storedDatasetPath, datasetPath2,
                    `TUNE_DATASET_PATH must be updated to "${datasetPath2}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 12: Job name follows naming pattern ─────────────────────────────

/**
 * Property 12: Job name follows naming pattern
 *
 * For any project name P and technique T, the generated job name SHALL match
 * the regex pattern `^${P}-tune-${T}-\d{8}-\d{6}$` (project-tune-technique-YYYYMMDD-HHMMSS).
 *
 * Feature: managed-model-customization, Property 12: Job name follows naming pattern
 * Validates: Requirements 6.7
 */

describe('Feature: managed-model-customization, Property 12: Job name follows naming pattern', () => {

    // Generator for valid timestamps (reasonable date range, excluding invalid dates)
    const timestampArb = fc.date({
        min: new Date(2020, 0, 1),
        max: new Date(2035, 11, 31)
    }).filter(d => !isNaN(d.getTime()));

    it('generated job name matches pattern ^${P}-tune-${T}-YYYYMMDD-HHMMSS$', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            projectNameArb,
            techniqueArb,
            timestampArb,
            (projectName, technique, timestamp) => {
                const jobName = generateJobName(projectName, technique, timestamp);

                const pattern = new RegExp(`^${projectName}-tune-${technique}-\\d{8}-\\d{6}$`);

                assert.ok(pattern.test(jobName),
                    `Job name "${jobName}" must match pattern "^${projectName}-tune-${technique}-\\d{8}-\\d{6}$"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('job name date segment matches the provided timestamp', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            projectNameArb,
            techniqueArb,
            timestampArb,
            (projectName, technique, timestamp) => {
                const jobName = generateJobName(projectName, technique, timestamp);

                // Extract the date and time segments from the job name
                const parts = jobName.split('-tune-')[1];
                const afterTechnique = parts.split(`${technique}-`)[1];
                const dateStr = afterTechnique.slice(0, 8);
                const timeStr = afterTechnique.slice(9, 15);

                const expectedYear = timestamp.getFullYear().toString();
                const expectedMonth = (timestamp.getMonth() + 1).toString().padStart(2, '0');
                const expectedDay = timestamp.getDate().toString().padStart(2, '0');
                const expectedHours = timestamp.getHours().toString().padStart(2, '0');
                const expectedMinutes = timestamp.getMinutes().toString().padStart(2, '0');
                const expectedSeconds = timestamp.getSeconds().toString().padStart(2, '0');

                const expectedDate = `${expectedYear}${expectedMonth}${expectedDay}`;
                const expectedTime = `${expectedHours}${expectedMinutes}${expectedSeconds}`;

                assert.strictEqual(dateStr, expectedDate,
                    `Date segment "${dateStr}" must equal "${expectedDate}" for timestamp ${timestamp.toISOString()}`);
                assert.strictEqual(timeStr, expectedTime,
                    `Time segment "${timeStr}" must equal "${expectedTime}" for timestamp ${timestamp.toISOString()}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('job name structure is exactly: projectName-tune-technique-YYYYMMDD-HHMMSS', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            projectNameArb,
            techniqueArb,
            timestampArb,
            (projectName, technique, timestamp) => {
                const jobName = generateJobName(projectName, technique, timestamp);

                // Verify the job name can be decomposed into its expected parts
                const expectedPrefix = `${projectName}-tune-${technique}-`;
                assert.ok(jobName.startsWith(expectedPrefix),
                    `Job name "${jobName}" must start with "${expectedPrefix}"`);

                // The suffix after the prefix should be exactly 15 chars: YYYYMMDD-HHMMSS
                const suffix = jobName.slice(expectedPrefix.length);
                assert.strictEqual(suffix.length, 15,
                    `Timestamp suffix "${suffix}" must be exactly 15 characters (YYYYMMDD-HHMMSS), got ${suffix.length}`);

                // Verify the dash separator is in the right position
                assert.strictEqual(suffix[8], '-',
                    `Character at position 8 of suffix "${suffix}" must be a dash separator`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 13: Technique state isolation ───────────────────────────────────

/**
 * Property 13: Technique state isolation
 *
 * For any two different techniques T1 and T2, submitting or completing a job
 * for T2 SHALL NOT modify the values of TUNE_JOB_NAME_<T1>,
 * TUNE_ADAPTER_PATH_<T1>, or TUNE_MODEL_PATH_<T1> in the config.
 *
 * Feature: managed-model-customization, Property 13: Technique state isolation
 * Validates: Requirements 6.8, 8.13, 8.14
 */

describe('Feature: managed-model-customization, Property 13: Technique state isolation', () => {

    beforeEach(() => {
        setupTempConfig('#!/bin/bash\n# do/config\nexport PROJECT_NAME="test-project"\n');
    });

    afterEach(() => {
        cleanupTempConfig();
    });

    // Generator for two distinct techniques
    const distinctTechniquePairArb = fc.tuple(techniqueArb, techniqueArb)
        .filter(([t1, t2]) => t1 !== t2);

    // Generator for a random S3 artifact path
    const artifactPathArb = fc.tuple(
        fc.stringMatching(/^[a-z0-9][a-z0-9.-]{2,15}$/),
        fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{2,20}$/)
    ).map(([bucket, key]) => `s3://${bucket}/output/${key}/model.tar.gz`);

    it('submitting for T2 does not modify TUNE_JOB_NAME_<T1>', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            distinctTechniquePairArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            trainingTypeArb,
            datasetPathArb,
            ([t1, t2], trainingType1, datasetPath1, projectName, trainingType2, datasetPath2) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                // Submit job for T1
                const jobName1 = generateJobName(projectName, t1, new Date(2025, 0, 10, 8, 0, 0));
                persistSubmissionState(configPath, {
                    technique: t1,
                    trainingType: trainingType1,
                    datasetPath: datasetPath1,
                    jobName: jobName1
                });

                // Record T1's per-technique job name
                const t1Upper = t1.toUpperCase();
                const t1JobNameBefore = readConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`);

                // Submit job for T2
                const jobName2 = generateJobName(projectName, t2, new Date(2025, 0, 10, 9, 0, 0));
                persistSubmissionState(configPath, {
                    technique: t2,
                    trainingType: trainingType2,
                    datasetPath: datasetPath2,
                    jobName: jobName2
                });

                // Verify T1's job name is unchanged
                const t1JobNameAfter = readConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`);
                assert.strictEqual(t1JobNameAfter, t1JobNameBefore,
                    `TUNE_JOB_NAME_${t1Upper} must not change after submitting for ${t2}. ` +
                    `Was "${t1JobNameBefore}", now "${t1JobNameAfter}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('submitting for T2 does not modify TUNE_ADAPTER_PATH_<T1>', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            distinctTechniquePairArb,
            artifactPathArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            ([t1, t2], adapterPath, trainingType2, datasetPath2, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                // Simulate T1 having a completed adapter path
                const t1Upper = t1.toUpperCase();
                updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`, adapterPath);

                // Also set T1's job name (as would exist after submission)
                const jobName1 = generateJobName(projectName, t1, new Date(2025, 0, 10, 8, 0, 0));
                updateConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`, jobName1);

                // Record T1's adapter path before T2 submission
                const t1AdapterBefore = readConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`);

                // Submit job for T2
                const jobName2 = generateJobName(projectName, t2, new Date(2025, 0, 10, 9, 0, 0));
                persistSubmissionState(configPath, {
                    technique: t2,
                    trainingType: trainingType2,
                    datasetPath: datasetPath2,
                    jobName: jobName2
                });

                // Verify T1's adapter path is unchanged
                const t1AdapterAfter = readConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`);
                assert.strictEqual(t1AdapterAfter, t1AdapterBefore,
                    `TUNE_ADAPTER_PATH_${t1Upper} must not change after submitting for ${t2}. ` +
                    `Was "${t1AdapterBefore}", now "${t1AdapterAfter}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('submitting for T2 does not modify TUNE_MODEL_PATH_<T1>', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            distinctTechniquePairArb,
            artifactPathArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            ([t1, t2], modelPath, trainingType2, datasetPath2, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                // Simulate T1 having a completed model path
                const t1Upper = t1.toUpperCase();
                updateConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`, modelPath);

                // Also set T1's job name (as would exist after submission)
                const jobName1 = generateJobName(projectName, t1, new Date(2025, 0, 10, 8, 0, 0));
                updateConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`, jobName1);

                // Record T1's model path before T2 submission
                const t1ModelBefore = readConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`);

                // Submit job for T2
                const jobName2 = generateJobName(projectName, t2, new Date(2025, 0, 10, 9, 0, 0));
                persistSubmissionState(configPath, {
                    technique: t2,
                    trainingType: trainingType2,
                    datasetPath: datasetPath2,
                    jobName: jobName2
                });

                // Verify T1's model path is unchanged
                const t1ModelAfter = readConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`);
                assert.strictEqual(t1ModelAfter, t1ModelBefore,
                    `TUNE_MODEL_PATH_${t1Upper} must not change after submitting for ${t2}. ` +
                    `Was "${t1ModelBefore}", now "${t1ModelAfter}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('sequential submissions across multiple techniques preserve all per-technique state', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            projectNameArb,
            fc.array(
                fc.tuple(techniqueArb, trainingTypeArb, datasetPathArb),
                { minLength: 2, maxLength: 6 }
            ),
            (projectName, submissions) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                // Track expected per-technique job names
                const expectedJobNames = {};

                // Execute all submissions sequentially
                submissions.forEach(([technique, trainingType, datasetPath], idx) => {
                    const timestamp = new Date(2025, 0, 10, 8 + idx, 0, 0);
                    const jobName = generateJobName(projectName, technique, timestamp);

                    persistSubmissionState(configPath, {
                        technique,
                        trainingType,
                        datasetPath,
                        jobName
                    });

                    // Track the latest job name per technique
                    expectedJobNames[technique.toUpperCase()] = jobName;
                });

                // Verify each technique's job name matches its last submission
                for (const [techniqueUpper, expectedJobName] of Object.entries(expectedJobNames)) {
                    const actual = readConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`);
                    assert.strictEqual(actual, expectedJobName,
                        `TUNE_JOB_NAME_${techniqueUpper} must be "${expectedJobName}" ` +
                        `(the last submission for that technique), got "${actual}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('per-technique adapter and model paths survive submissions for other techniques', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            distinctTechniquePairArb,
            artifactPathArb,
            artifactPathArb,
            trainingTypeArb,
            datasetPathArb,
            projectNameArb,
            ([t1, t2], adapterPath, modelPath, trainingType2, datasetPath2, projectName) => {
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                const t1Upper = t1.toUpperCase();

                // Set up T1 with both adapter and model paths (simulating completed jobs)
                const jobName1 = generateJobName(projectName, t1, new Date(2025, 0, 10, 8, 0, 0));
                updateConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`, jobName1);
                updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`, adapterPath);
                updateConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`, modelPath);

                // Record all T1 per-technique state
                const t1StateBefore = {
                    jobName: readConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`),
                    adapterPath: readConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`),
                    modelPath: readConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`)
                };

                // Submit job for T2
                const jobName2 = generateJobName(projectName, t2, new Date(2025, 0, 10, 9, 0, 0));
                persistSubmissionState(configPath, {
                    technique: t2,
                    trainingType: trainingType2,
                    datasetPath: datasetPath2,
                    jobName: jobName2
                });

                // Also simulate T2 completion with its own paths
                const t2Upper = t2.toUpperCase();
                updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${t2Upper}`, 's3://other-bucket/t2/adapter.tar.gz');
                updateConfigVar(configPath, `TUNE_MODEL_PATH_${t2Upper}`, 's3://other-bucket/t2/model.tar.gz');

                // Verify ALL of T1's per-technique state is unchanged
                const t1StateAfter = {
                    jobName: readConfigVar(configPath, `TUNE_JOB_NAME_${t1Upper}`),
                    adapterPath: readConfigVar(configPath, `TUNE_ADAPTER_PATH_${t1Upper}`),
                    modelPath: readConfigVar(configPath, `TUNE_MODEL_PATH_${t1Upper}`)
                };

                assert.deepStrictEqual(t1StateAfter, t1StateBefore,
                    `All per-technique state for ${t1} must be preserved after T2 (${t2}) operations. ` +
                    `Before: ${JSON.stringify(t1StateBefore)}, After: ${JSON.stringify(t1StateAfter)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
