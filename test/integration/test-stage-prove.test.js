// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: Prove Pipeline — "stage" lifecycle stage recognition
 *
 * Verifies that "stage" is recognized as a valid lifecycle stage in the
 * prove pipeline and that the validation-targets configuration includes it
 * in the default stages array.
 *
 * Feature: s3-model-loading
 * Task: 9.3 Test prove pipeline integration
 * Requirements: 5.1, 5.2
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
    VALID_LIFECYCLE_STAGES,
    isValidLifecycleStage,
    validateStagesArray,
    isAlreadyStaged,
    getStagingState,
    STAGING_STATES,
    buildTargetStatus
} from '../../src/lib/prove-pipeline-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Prove Pipeline Integration — "stage" lifecycle stage', function () {
    this.timeout(30000);

    // ── Requirement 5.1: "stage" is a recognized lifecycle stage ──

    describe('Requirement 5.1: "stage" is recognized as a valid lifecycle stage', () => {

        it('"stage" exists in VALID_LIFECYCLE_STAGES', () => {
            assert.ok(
                VALID_LIFECYCLE_STAGES.includes('stage'),
                'VALID_LIFECYCLE_STAGES must include "stage"'
            );
        });

        it('isValidLifecycleStage("stage") returns true', () => {
            assert.strictEqual(isValidLifecycleStage('stage'), true);
        });

        it('validateStagesArray accepts arrays containing "stage"', () => {
            const stages = ['generate', 'stage', 'build', 'deploy', 'test', 'clean'];
            const result = validateStagesArray(stages);
            assert.strictEqual(result.valid, true, `Expected valid but got errors: ${result.errors.join(', ')}`);
        });

        it('validation-targets.example.json includes "stage" in default stages', () => {
            const configPath = path.join(PROJECT_ROOT, 'config', 'validation-targets.example.json');
            const content = readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);

            assert.ok(config.defaults, 'validation-targets.example.json should have a defaults section');
            assert.ok(Array.isArray(config.defaults.stages), 'defaults.stages should be an array');
            assert.ok(
                config.defaults.stages.includes('stage'),
                `defaults.stages must include "stage", got: [${config.defaults.stages.join(', ')}]`
            );
        });

        it('"stage" appears after "generate" and before "build" in the default stages order', () => {
            const configPath = path.join(PROJECT_ROOT, 'config', 'validation-targets.example.json');
            const content = readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);
            const stages = config.defaults.stages;

            const genIdx = stages.indexOf('generate');
            const stageIdx = stages.indexOf('stage');
            const buildIdx = stages.indexOf('build');

            assert.ok(genIdx >= 0, '"generate" must be in defaults.stages');
            assert.ok(stageIdx >= 0, '"stage" must be in defaults.stages');
            assert.ok(buildIdx >= 0, '"build" must be in defaults.stages');
            assert.ok(stageIdx > genIdx, '"stage" must come after "generate"');
            assert.ok(stageIdx < buildIdx, '"stage" must come before "build"');
        });

        it('the full default stages array from validation-targets passes validation', () => {
            const configPath = path.join(PROJECT_ROOT, 'config', 'validation-targets.example.json');
            const content = readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);

            const result = validateStagesArray(config.defaults.stages);
            assert.strictEqual(result.valid, true,
                `Full defaults.stages should be valid but got errors: ${result.errors.join(', ')}`);
        });
    });

    // ── Requirement 5.2: Prove pipeline executes do/stage and verifies exit ──

    describe('Requirement 5.2: Stage execution and state tracking', () => {

        let testDir;

        beforeEach(() => {
            testDir = path.join(tmpdir(), `mlcc-prove-integration-${Date.now()}`);
            mkdirSync(testDir, { recursive: true });
        });

        afterEach(() => {
            if (testDir) {
                try {
                    rmSync(testDir, { recursive: true, force: true });
                } catch { /* ignore cleanup errors */ }
            }
        });

        it('isAlreadyStaged returns false for a fresh project directory', () => {
            assert.strictEqual(isAlreadyStaged(testDir), false);
        });

        it('getStagingState returns "not-staged" for a fresh project', () => {
            assert.strictEqual(getStagingState(testDir), STAGING_STATES.NOT_STAGED);
        });

        it('getStagingState returns "staged" when staged-assets.json exists with valid URI', () => {
            const mlccDir = path.join(testDir, '.mlcc');
            mkdirSync(mlccDir, { recursive: true });
            writeFileSync(path.join(mlccDir, 'staged-assets.json'), JSON.stringify({
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/qwen3-06b/',
                        staged_at: '2025-01-15T10:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            }));

            assert.strictEqual(getStagingState(testDir), STAGING_STATES.STAGED);
        });

        it('getStagingState returns "stage-failed" when step results indicate failure', () => {
            const stepResults = { stage: { status: 'fail', error: 'do/stage exited with code 1' } };
            assert.strictEqual(getStagingState(testDir, stepResults), STAGING_STATES.STAGE_FAILED);
        });

        it('buildTargetStatus correctly reports staging state for a target with "stage" step', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build', 'deploy', 'test', 'clean']
            };

            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.model_name, 'Qwen/Qwen3-0.6B');
            assert.strictEqual(status.includesStageStep, true);
            assert.strictEqual(status.stagingState, 'not-staged');
            assert.strictEqual(status.stagingStatus, '○ not-staged');
        });

        it('buildTargetStatus reports includesStageStep=false when stages omit "stage"', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'build', 'deploy', 'test', 'clean']
            };

            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.includesStageStep, false);
        });

        it('buildTargetStatus shows "staged" when model is pre-staged', () => {
            const mlccDir = path.join(testDir, '.mlcc');
            mkdirSync(mlccDir, { recursive: true });
            writeFileSync(path.join(mlccDir, 'staged-assets.json'), JSON.stringify({
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-0.6B',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/qwen3-06b/',
                        staged_at: '2025-01-15T10:00:00Z',
                        region: 'us-west-2',
                        size_gb: 1.2
                    }
                },
                adapters: {}
            }));

            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build', 'deploy', 'test', 'clean']
            };

            const status = buildTargetStatus(target, testDir);
            assert.strictEqual(status.stagingState, 'staged');
            assert.strictEqual(status.stagingStatus, '✓ staged');
        });

        it('buildTargetStatus shows "stage-failed" from step results', () => {
            const target = {
                model_name: 'Qwen/Qwen3-0.6B',
                stages: ['generate', 'stage', 'build']
            };
            const stepResults = { stage: { status: 'fail', error: 'timeout' } };

            const status = buildTargetStatus(target, testDir, stepResults);
            assert.strictEqual(status.stagingState, 'stage-failed');
            assert.strictEqual(status.stagingStatus, '✗ stage-failed');
        });
    });
});
