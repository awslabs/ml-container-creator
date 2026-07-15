// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for prove-pipeline-executor.js
 *
 * Tests lifecycle stage validation, staging state detection,
 * idempotency logic, and status output formatting.
 *
 * Feature: s3-model-loading
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
    VALID_LIFECYCLE_STAGES,
    STAGING_STATES,
    isAlreadyStaged,
    getStagingState,
    executeStageStep,
    isValidLifecycleStage,
    validateStagesArray,
    formatStagingStatus,
    buildTargetStatus,
    STAGE_EXECUTORS,
    loadProveState,
    saveProveState,
    executeGenerateStep,
    executeBuildStep,
    executePushStep,
    executeDeployStep,
    executeTestStep,
    executeTuneStep,
    executeAdapterStep,
    executeTestAdapterStep,
    executeBenchmarkStep,
    executeRegisterStep,
    executeCleanStep
} from '../../src/lib/prove-pipeline-executor.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

let testDir;

function createTestProject() {
    testDir = path.join(tmpdir(), `mlcc-prove-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    return testDir;
}

function writeStagedAssets(projectDir, content) {
    const mlccDir = path.join(projectDir, '.mlcc');
    mkdirSync(mlccDir, { recursive: true });
    writeFileSync(path.join(mlccDir, 'staged-assets.json'), JSON.stringify(content));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('prove-pipeline-executor', () => {
    beforeEach(() => {
        testDir = createTestProject();
    });

    afterEach(() => {
        if (testDir) {
            try {
                rmSync(testDir, { recursive: true, force: true });
            } catch { /* ignore cleanup errors */ }
        }
    });

    describe('VALID_LIFECYCLE_STAGES', () => {
        it('includes "stage" as a valid lifecycle stage (Requirement 5.1)', () => {
            assert.ok(VALID_LIFECYCLE_STAGES.includes('stage'));
        });

        it('includes all standard prove pipeline stages', () => {
            const expectedStages = ['generate', 'stage', 'build', 'push', 'deploy', 'test',
                'tune', 'adapter', 'test-adapter', 'benchmark', 'register', 'clean'];
            for (const stage of expectedStages) {
                assert.ok(VALID_LIFECYCLE_STAGES.includes(stage), `Missing stage: ${stage}`);
            }
        });

        it('stage comes after generate and before build in the list', () => {
            const genIdx = VALID_LIFECYCLE_STAGES.indexOf('generate');
            const stageIdx = VALID_LIFECYCLE_STAGES.indexOf('stage');
            const buildIdx = VALID_LIFECYCLE_STAGES.indexOf('build');
            assert.ok(stageIdx > genIdx, 'stage should come after generate');
            assert.ok(stageIdx < buildIdx, 'stage should come before build');
        });
    });

    describe('isValidLifecycleStage', () => {
        it('returns true for "stage"', () => {
            assert.strictEqual(isValidLifecycleStage('stage'), true);
        });

        it('returns true for all valid stages', () => {
            for (const stage of VALID_LIFECYCLE_STAGES) {
                assert.strictEqual(isValidLifecycleStage(stage), true);
            }
        });

        it('returns false for unknown stage names', () => {
            assert.strictEqual(isValidLifecycleStage('unknown'), false);
            assert.strictEqual(isValidLifecycleStage('compile'), false);
            assert.strictEqual(isValidLifecycleStage(''), false);
        });
    });

    describe('validateStagesArray', () => {
        it('validates an array containing "stage" as valid', () => {
            const result = validateStagesArray(['generate', 'stage', 'build', 'deploy', 'test', 'clean']);
            assert.strictEqual(result.valid, true);
            assert.deepStrictEqual(result.errors, []);
        });

        it('rejects unrecognized stage names', () => {
            const result = validateStagesArray(['generate', 'foo', 'build']);
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('foo')));
        });

        it('rejects non-array input', () => {
            const result = validateStagesArray('stage');
            assert.strictEqual(result.valid, false);
        });

        it('rejects empty array', () => {
            const result = validateStagesArray([]);
            assert.strictEqual(result.valid, false);
        });

        it('validates the default stages from validation-targets.example.json', () => {
            const defaultStages = ['generate', 'stage', 'build', 'deploy', 'test',
                'tune', 'adapter', 'test-adapter', 'benchmark', 'clean'];
            const result = validateStagesArray(defaultStages);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('isAlreadyStaged', () => {
        it('returns false when .mlcc directory does not exist', () => {
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });

        it('returns false when staged-assets.json does not exist', () => {
            mkdirSync(path.join(testDir, '.mlcc'), { recursive: true });
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });

        it('returns true when staged-assets.json has a valid staged_uri', () => {
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/qwen3-06b/',
                        staged_at: '2025-01-01T00:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            });
            assert.strictEqual(isAlreadyStaged(testDir), true);
        });

        it('returns false when staged_uri is empty', () => {
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: '',
                        staged_at: '2025-01-01T00:00:00Z',
                        region: 'us-west-2'
                    }
                },
                adapters: {}
            });
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });

        it('returns false when JSON is malformed', () => {
            const mlccDir = path.join(testDir, '.mlcc');
            mkdirSync(mlccDir, { recursive: true });
            writeFileSync(path.join(mlccDir, 'staged-assets.json'), 'not json');
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });

        it('returns false when models.default is missing', () => {
            writeStagedAssets(testDir, {
                version: '1',
                models: {},
                adapters: {}
            });
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });
    });

    describe('getStagingState', () => {
        it('returns "not-staged" when no staged assets exist', () => {
            assert.strictEqual(getStagingState(testDir), STAGING_STATES.NOT_STAGED);
        });

        it('returns "staged" when model is staged', () => {
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://bucket/models/project/',
                        staged_at: '2025-01-01T00:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            });
            assert.strictEqual(getStagingState(testDir), STAGING_STATES.STAGED);
        });

        it('returns "stage-failed" when step results show stage failure', () => {
            const stepResults = { stage: { status: 'fail', error: 'do/stage exited with code 1' } };
            assert.strictEqual(getStagingState(testDir, stepResults), STAGING_STATES.STAGE_FAILED);
        });

        it('stage-failed takes precedence over file check', () => {
            // Even if there's a staged-assets file, if the step result says fail, it's failed
            writeStagedAssets(testDir, {
                version: '1',
                models: { default: { staged_uri: 's3://bucket/models/project/' } },
                adapters: {}
            });
            const stepResults = { stage: { status: 'fail', error: 'timeout' } };
            assert.strictEqual(getStagingState(testDir, stepResults), STAGING_STATES.STAGE_FAILED);
        });
    });

    describe('STAGING_STATES', () => {
        it('defines staged state (Requirement 5.5)', () => {
            assert.strictEqual(STAGING_STATES.STAGED, 'staged');
        });

        it('defines not-staged state (Requirement 5.5)', () => {
            assert.strictEqual(STAGING_STATES.NOT_STAGED, 'not-staged');
        });

        it('defines stage-failed state (Requirement 5.5)', () => {
            assert.strictEqual(STAGING_STATES.STAGE_FAILED, 'stage-failed');
        });
    });

    describe('formatStagingStatus', () => {
        it('formats staged state', () => {
            assert.strictEqual(formatStagingStatus('staged'), '✓ staged');
        });

        it('formats not-staged state', () => {
            assert.strictEqual(formatStagingStatus('not-staged'), '○ not-staged');
        });

        it('formats stage-failed state', () => {
            assert.strictEqual(formatStagingStatus('stage-failed'), '✗ stage-failed');
        });

        it('returns unknown for invalid states', () => {
            assert.strictEqual(formatStagingStatus('invalid'), '? unknown');
        });
    });

    describe('buildTargetStatus', () => {
        it('includes staging state for a target with stage step', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build', 'deploy', 'test', 'clean']
            };
            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.model_name, 'Qwen/Qwen3-0.6B');
            assert.strictEqual(status.stagingState, 'not-staged');
            assert.strictEqual(status.includesStageStep, true);
        });

        it('shows staged state when model is pre-staged', () => {
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://bucket/models/project/',
                        staged_at: '2025-01-01T00:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            });
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build', 'deploy', 'test', 'clean']
            };
            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.stagingState, 'staged');
            assert.strictEqual(status.stagingStatus, '✓ staged');
        });

        it('includesStageStep is false when stages omits "stage"', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'build', 'deploy', 'test', 'clean']
            };
            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.includesStageStep, false);
        });

        it('shows stage-failed state from step results', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build']
            };
            const stepResults = { stage: { status: 'fail', error: 'exit code 1' } };
            const status = buildTargetStatus(target, testDir, stepResults);
            assert.strictEqual(status.stagingState, 'stage-failed');
            assert.strictEqual(status.stagingStatus, '✗ stage-failed');
        });

        it('handles target with empty stages array', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: []
            };
            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.includesStageStep, false);
        });
    });

    // ── executeStageStep Idempotency Tests ───────────────────────────────────

    describe('executeStageStep', () => {
        it('skips execution when model is already staged (idempotency)', async () => {
            // **Validates: Requirements 5.4 — idempotency check**
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/qwen3-06b/',
                        staged_at: '2025-01-01T00:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            });

            const result = await executeStageStep(testDir);

            assert.strictEqual(result.name, 'stage');
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.stagingState, STAGING_STATES.STAGED);
            assert.ok(result.message.includes('already staged'));
        });

        it('returns fail when do/stage command does not exist', async () => {
            // **Validates: Requirements 5.2, 5.3 — fail on non-zero exit**
            const result = await executeStageStep(testDir, { timeout: 5 });

            assert.strictEqual(result.name, 'stage');
            assert.strictEqual(result.status, 'fail');
            assert.strictEqual(result.stagingState, STAGING_STATES.STAGE_FAILED);
            assert.ok(result.error);
        });

        it('result includes duration in milliseconds', async () => {
            // **Validates: Requirements 5.2**
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        staged_uri: 's3://bucket/models/project/'
                    }
                }
            });

            const result = await executeStageStep(testDir);

            assert.strictEqual(typeof result.duration, 'number');
            assert.ok(result.duration >= 0);
        });

        it('idempotent skip has near-zero duration', async () => {
            // **Validates: Requirements 5.4**
            writeStagedAssets(testDir, {
                version: '1',
                models: {
                    default: {
                        staged_uri: 's3://bucket/models/project/'
                    }
                }
            });

            const result = await executeStageStep(testDir);

            // Skipped execution should be very fast (< 100ms)
            assert.ok(result.duration < 100, `Expected fast skip, got ${result.duration}ms`);
        });
    });

    // ── validateStagesArray Extended Tests ───────────────────────────────────

    describe('validateStagesArray (extended)', () => {
        it('rejects non-string entries in the array', () => {
            const result = validateStagesArray(['generate', 42, 'build']);
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('expected string')));
        });

        it('validates single-stage array', () => {
            const result = validateStagesArray(['clean']);
            assert.strictEqual(result.valid, true);
            assert.deepStrictEqual(result.errors, []);
        });

        it('reports multiple errors for multiple invalid stages', () => {
            const result = validateStagesArray(['generate', 'foo', 'bar', 'build']);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 2);
        });

        it('rejects null input', () => {
            const result = validateStagesArray(null);
            assert.strictEqual(result.valid, false);
        });

        it('rejects object input', () => {
            const result = validateStagesArray({ stage: 'generate' });
            assert.strictEqual(result.valid, false);
        });
    });

    // ── STAGE_EXECUTORS Tests ────────────────────────────────────────────────

    describe('STAGE_EXECUTORS', () => {
        it('has all 12 lifecycle stages registered', () => {
            const expectedStages = [
                'generate', 'stage', 'build', 'push', 'deploy', 'test',
                'tune', 'adapter', 'test-adapter', 'benchmark', 'register', 'clean'
            ];
            for (const stage of expectedStages) {
                assert.ok(STAGE_EXECUTORS[stage], `Missing executor for stage: ${stage}`);
                assert.strictEqual(typeof STAGE_EXECUTORS[stage], 'function');
            }
        });

        it('has exactly 12 entries', () => {
            assert.strictEqual(Object.keys(STAGE_EXECUTORS).length, 12);
        });
    });

    // ── Prove State Idempotency Tests ────────────────────────────────────────

    describe('loadProveState / saveProveState', () => {
        it('returns empty object when no state file exists', () => {
            const state = loadProveState(testDir);
            assert.deepStrictEqual(state, {});
        });

        it('saves and loads state correctly', () => {
            saveProveState(testDir, 'build', { status: 'pass', duration: 1234 });
            const state = loadProveState(testDir);
            assert.strictEqual(state.build.status, 'pass');
            assert.strictEqual(state.build.duration, 1234);
            assert.strictEqual(typeof state.build.timestamp, 'number');
        });

        it('preserves existing stages when saving a new one', () => {
            saveProveState(testDir, 'build', { status: 'pass', duration: 100 });
            saveProveState(testDir, 'push', { status: 'pass', duration: 200 });
            const state = loadProveState(testDir);
            assert.strictEqual(state.build.status, 'pass');
            assert.strictEqual(state.push.status, 'pass');
        });
    });

    describe('executor idempotency via .prove-state.json', () => {
        it('executeBuildStep skips when .prove-state.json has build: pass', async () => {
            saveProveState(testDir, 'build', { status: 'pass', duration: 5000 });
            const result = await executeBuildStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
            assert.ok(result.message.includes('already passed'));
        });

        it('executePushStep skips when .prove-state.json has push: pass', async () => {
            saveProveState(testDir, 'push', { status: 'pass', duration: 3000 });
            const result = await executePushStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeDeployStep skips when .prove-state.json has deploy: pass', async () => {
            saveProveState(testDir, 'deploy', { status: 'pass', duration: 8000 });
            const result = await executeDeployStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeTestStep skips when .prove-state.json has test: pass', async () => {
            saveProveState(testDir, 'test', { status: 'pass', duration: 1000 });
            const result = await executeTestStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeTuneStep skips when tune not requested', async () => {
            const result = await executeTuneStep(testDir, { config: {} });
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
            assert.ok(result.message.includes('not requested'));
        });

        it('executeTuneStep skips when .prove-state.json has tune: pass', async () => {
            saveProveState(testDir, 'tune', { status: 'pass', duration: 60000 });
            const result = await executeTuneStep(testDir, { config: { include_tuning: true } });
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeAdapterStep skips when .prove-state.json has adapter: pass', async () => {
            saveProveState(testDir, 'adapter', { status: 'pass', duration: 4000 });
            const result = await executeAdapterStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeTestAdapterStep skips when .prove-state.json has test-adapter: pass', async () => {
            saveProveState(testDir, 'test-adapter', { status: 'pass', duration: 2000 });
            const result = await executeTestAdapterStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeBenchmarkStep skips when .prove-state.json has benchmark: pass', async () => {
            saveProveState(testDir, 'benchmark', { status: 'pass', duration: 30000 });
            const result = await executeBenchmarkStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeRegisterStep skips when .prove-state.json has register: pass', async () => {
            saveProveState(testDir, 'register', { status: 'pass', duration: 500 });
            const result = await executeRegisterStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeCleanStep skips when .prove-state.json has clean: pass', async () => {
            saveProveState(testDir, 'clean', { status: 'pass', duration: 2000 });
            const result = await executeCleanStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });

        it('executeGenerateStep skips when .prove-state.json has generate: pass', async () => {
            saveProveState(testDir, 'generate', { status: 'pass', duration: 1500 });
            const result = await executeGenerateStep(testDir);
            assert.strictEqual(result.status, 'pass');
            assert.strictEqual(result.skipped, true);
        });
    });
});

