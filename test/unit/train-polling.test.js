// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for polling and status display logic.
 *
 * Tests the Python parsers (.train_poll_parser.py, .train_status_parser.py)
 * by piping test JSON to them via child_process, and tests the JavaScript
 * idempotency decision module (src/lib/train-idempotency.js) directly.
 *
 * Feature: fine-tuning-training
 * Validates: Requirements 4.1–4.5
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { determineAction, ACTIONS, JOB_STATUSES } from '../../src/lib/train-idempotency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLL_PARSER = path.join(__dirname, '../../templates/do/.train_poll_parser.py');
const STATUS_PARSER = path.join(__dirname, '../../templates/do/.train_status_parser.py');

/**
 * Helper: run a Python parser with JSON input and return stdout.
 */
function runParser(parserPath, jsonInput) {
    const input = typeof jsonInput === 'string' ? jsonInput : JSON.stringify(jsonInput);
    const result = execSync(`python3 "${parserPath}"`, {
        input,
        encoding: 'utf8',
        timeout: 10000
    });
    return result;
}

/**
 * Helper: parse poll parser output into key-value object.
 */
function parsePollOutput(output) {
    const result = {};
    for (const line of output.trim().split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
            const key = line.substring(0, eqIdx);
            const value = line.substring(eqIdx + 1);
            result[key] = value;
        }
    }
    return result;
}

describe('Train Polling — Poll Parser (.train_poll_parser.py)', () => {

    describe('InProgress status with metrics', () => {
        it('should output correct STATUS, SECONDARY, and DISPLAY for InProgress job', () => {
            const jobData = {
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Training',
                TrainingStartTime: new Date(Date.now() - 3600000).toISOString(),
                FinalMetricDataList: [
                    { MetricName: 'train:loss', Value: 0.0234 },
                    { MetricName: 'train:epoch', Value: 3.0 }
                ]
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'InProgress');
            assert.equal(parsed.SECONDARY, 'Training');
            assert.equal(parsed.FAILURE_REASON, '');
            assert.ok(parsed.DISPLAY.includes('InProgress'), 'DISPLAY should contain status');
            assert.ok(parsed.DISPLAY.includes('Training'), 'DISPLAY should contain secondary status');
            assert.ok(parsed.DISPLAY.includes('train:loss'), 'DISPLAY should contain metric name');
            assert.ok(parsed.DISPLAY.includes('0.0234'), 'DISPLAY should contain metric value');
        });
    });

    describe('Completed status', () => {
        it('should output STATUS=Completed', () => {
            const jobData = {
                TrainingJobStatus: 'Completed',
                SecondaryStatus: 'Completed',
                TrainingStartTime: '2024-01-01T00:00:00Z',
                TrainingEndTime: '2024-01-01T01:00:00Z',
                FinalMetricDataList: [
                    { MetricName: 'train:loss', Value: 0.001 }
                ]
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'Completed');
            assert.ok(parsed.DISPLAY.includes('✅'), 'DISPLAY should contain completed emoji');
        });
    });

    describe('Failed status with failure reason', () => {
        it('should output STATUS=Failed and FAILURE_REASON', () => {
            const jobData = {
                TrainingJobStatus: 'Failed',
                SecondaryStatus: 'Failed',
                FailureReason: 'ClientError: CUDA out of memory',
                TrainingStartTime: '2024-01-01T00:00:00Z'
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'Failed');
            assert.equal(parsed.FAILURE_REASON, 'ClientError: CUDA out of memory');
            assert.ok(parsed.DISPLAY.includes('❌'), 'DISPLAY should contain failed emoji');
        });
    });

    describe('Stopped status', () => {
        it('should output STATUS=Stopped', () => {
            const jobData = {
                TrainingJobStatus: 'Stopped',
                SecondaryStatus: 'Stopped',
                TrainingStartTime: '2024-01-01T00:00:00Z'
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'Stopped');
            assert.ok(parsed.DISPLAY.includes('⏹️'), 'DISPLAY should contain stopped emoji');
        });
    });

    describe('Spot interrupted (secondary status)', () => {
        it('should output SECONDARY containing Interrupted', () => {
            const jobData = {
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Interrupted',
                TrainingStartTime: new Date(Date.now() - 1800000).toISOString()
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'InProgress');
            assert.equal(parsed.SECONDARY, 'Interrupted');
            assert.ok(parsed.DISPLAY.includes('Interrupted'), 'DISPLAY should contain Interrupted');
        });
    });

    describe('Edge cases', () => {
        it('should handle missing FinalMetricDataList gracefully', () => {
            const jobData = {
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Downloading',
                TrainingStartTime: new Date().toISOString()
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.STATUS, 'InProgress');
            assert.equal(parsed.SECONDARY, 'Downloading');
        });

        it('should handle empty FailureReason for non-failed jobs', () => {
            const jobData = {
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Training'
            };

            const output = runParser(POLL_PARSER, jobData);
            const parsed = parsePollOutput(output);

            assert.equal(parsed.FAILURE_REASON, '');
        });
    });
});

describe('Train Polling — Status Parser (.train_status_parser.py)', () => {

    describe('InProgress with elapsed time', () => {
        it('should display elapsed time for InProgress jobs', () => {
            const jobData = {
                TrainingJobName: 'my-project-train-20240101-120000',
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Training',
                TrainingStartTime: new Date(Date.now() - 7200000).toISOString(),
                ResourceConfig: {
                    InstanceType: 'ml.g5.xlarge',
                    InstanceCount: 1,
                    VolumeSizeInGB: 50
                }
            };

            const output = runParser(STATUS_PARSER, jobData);

            assert.ok(output.includes('InProgress'), 'should display InProgress status');
            assert.ok(output.includes('Elapsed') || output.includes('elapsed'), 'should display elapsed time');
            assert.ok(output.includes('ml.g5.xlarge'), 'should display instance type');
        });
    });

    describe('Completed with metrics', () => {
        it('should display metrics for completed jobs', () => {
            const jobData = {
                TrainingJobName: 'my-project-train-20240101-120000',
                TrainingJobStatus: 'Completed',
                SecondaryStatus: 'Completed',
                TrainingStartTime: '2024-01-01T12:00:00Z',
                TrainingEndTime: '2024-01-01T14:00:00Z',
                TrainingTimeInSeconds: 7200,
                FinalMetricDataList: [
                    { MetricName: 'train:loss', Value: 0.0015 },
                    { MetricName: 'eval:accuracy', Value: 0.95 }
                ],
                ModelArtifacts: {
                    S3ModelArtifacts: 's3://my-bucket/output/my-project-train-20240101-120000/output/model.tar.gz'
                },
                ResourceConfig: {
                    InstanceType: 'ml.g5.2xlarge',
                    InstanceCount: 1,
                    VolumeSizeInGB: 100
                }
            };

            const output = runParser(STATUS_PARSER, jobData);

            assert.ok(output.includes('Completed'), 'should display Completed status');
            assert.ok(output.includes('train:loss'), 'should display loss metric');
            assert.ok(output.includes('eval:accuracy'), 'should display accuracy metric');
            assert.ok(output.includes('s3://'), 'should display artifacts path');
        });
    });

    describe('Failed with failure reason', () => {
        it('should display failure reason and --force suggestion', () => {
            const jobData = {
                TrainingJobName: 'my-project-train-20240101-120000',
                TrainingJobStatus: 'Failed',
                SecondaryStatus: 'Failed',
                FailureReason: 'ClientError: No training data found at s3://bucket/data/',
                TrainingStartTime: '2024-01-01T12:00:00Z',
                ResourceConfig: {
                    InstanceType: 'ml.g5.xlarge',
                    InstanceCount: 1,
                    VolumeSizeInGB: 50
                }
            };

            const output = runParser(STATUS_PARSER, jobData);

            assert.ok(output.includes('Failed'), 'should display Failed status');
            assert.ok(output.includes('No training data found'), 'should display failure reason');
            assert.ok(output.includes('--force'), 'should suggest --force flag');
        });
    });

    describe('Spot completed with billable time', () => {
        it('should display cost savings for spot training', () => {
            const jobData = {
                TrainingJobName: 'my-project-train-20240101-120000',
                TrainingJobStatus: 'Completed',
                SecondaryStatus: 'Completed',
                TrainingStartTime: '2024-01-01T12:00:00Z',
                TrainingEndTime: '2024-01-01T14:00:00Z',
                TrainingTimeInSeconds: 7200,
                BillableTimeInSeconds: 4800,
                EnableManagedSpotTraining: true,
                ModelArtifacts: {
                    S3ModelArtifacts: 's3://my-bucket/output/model.tar.gz'
                },
                ResourceConfig: {
                    InstanceType: 'ml.g5.xlarge',
                    InstanceCount: 1,
                    VolumeSizeInGB: 50
                }
            };

            const output = runParser(STATUS_PARSER, jobData);

            assert.ok(output.includes('Completed'), 'should display Completed status');
            assert.ok(output.includes('spot') || output.includes('Spot'), 'should indicate spot training');
            assert.ok(output.includes('savings') || output.includes('Savings') || output.includes('saved'), 'should display cost savings');
            assert.ok(output.includes('Billable') || output.includes('billable'), 'should display billable time');
        });
    });

    describe('Spot interrupted secondary status', () => {
        it('should display spot interruption guidance', () => {
            const jobData = {
                TrainingJobName: 'my-project-train-20240101-120000',
                TrainingJobStatus: 'InProgress',
                SecondaryStatus: 'Interrupted',
                TrainingStartTime: new Date(Date.now() - 3600000).toISOString(),
                EnableManagedSpotTraining: true,
                ResourceConfig: {
                    InstanceType: 'ml.g5.xlarge',
                    InstanceCount: 1,
                    VolumeSizeInGB: 50
                }
            };

            const output = runParser(STATUS_PARSER, jobData);

            assert.ok(output.includes('Interrupted'), 'should display Interrupted status');
            assert.ok(output.includes('checkpoint') || output.includes('resume'), 'should mention checkpoint/resume');
        });
    });
});

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
