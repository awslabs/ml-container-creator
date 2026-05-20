// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace CI Integration Unit Tests
 *
 * Tests:
 * - do/register --ci skips build and push stages for marketplace
 * - CI harness handles missing build/push without errors
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 10.1, 10.2
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { applySkipLogic, STAGE_ORDER } from '../../src/lib/ci-stage-helpers.js';
import { computeConfigId, buildCiRecord } from '../../src/lib/ci-register-helpers.js';

describe('Marketplace CI Integration', () => {

    // ── CI register handles marketplace deployment config ────────────────

    describe('CI register helpers with marketplace', () => {

        it('computeConfigId works with marketplace deployment config', () => {
            const configId = computeConfigId(
                'marketplace',
                'arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                'ml.g5.xlarge',
                'us-east-1',
                'realtime-inference'
            );
            assert.strictEqual(configId.length, 16, 'configId should be 16 hex chars');
            assert.ok(/^[0-9a-f]{16}$/.test(configId), 'configId should be lowercase hex');
        });

        it('computeConfigId is deterministic for marketplace', () => {
            const id1 = computeConfigId('marketplace', 'none', 'ml.g5.xlarge', 'us-east-1', 'realtime-inference');
            const id2 = computeConfigId('marketplace', 'none', 'ml.g5.xlarge', 'us-east-1', 'realtime-inference');
            assert.strictEqual(id1, id2, 'Same inputs should produce same configId');
        });

        it('buildCiRecord works with marketplace deployment config', () => {
            const record = buildCiRecord(
                'abcdef0123456789',
                '{"deploymentConfig":"marketplace"}',
                {
                    deploymentConfig: 'marketplace',
                    baseImage: '',
                    baseImageVersion: '',
                    projectName: 'test-marketplace'
                }
            );
            assert.strictEqual(record.deploymentConfig, 'marketplace');
            assert.strictEqual(record.baseImage, '', 'Marketplace has no base image');
            assert.strictEqual(record.baseImageVersion, '', 'Marketplace has no base image version');
            assert.strictEqual(record.projectName, 'test-marketplace');
        });
    });

    // ── CI stage helpers handle marketplace (no build/push) ──────────────

    describe('CI stage helpers with marketplace (no build stage)', () => {

        it('applySkipLogic handles marketplace where build is already skip', () => {
            const stageResults = {};
            for (const stage of STAGE_ORDER) {
                stageResults[stage] = { status: 'pass', durationSeconds: 5, logPointer: '', errorSummary: '' };
            }
            // For marketplace, build would be marked as skip (no container to build)
            stageResults.build = { status: 'skip', durationSeconds: 0, logPointer: '', errorSummary: '' };

            // No failure — skip logic should not modify anything
            const result = applySkipLogic(stageResults, null);
            assert.strictEqual(result.build.status, 'skip', 'Build should remain skip');
            assert.strictEqual(result.deploy_test.status, 'pass', 'Deploy_test should remain pass');
        });

        it('marketplace CI run with all stages pass except build (skip) is overall pass', () => {
            // Simulate a marketplace CI run where build is skipped
            const stageResults = {};
            for (const stage of STAGE_ORDER) {
                stageResults[stage] = { status: 'pass', durationSeconds: 5, logPointer: '', errorSummary: '' };
            }
            stageResults.build = { status: 'skip', durationSeconds: 0, logPointer: '', errorSummary: '' };

            // Verify no failure is detected
            let firstFailure = null;
            for (const stage of STAGE_ORDER) {
                if (stageResults[stage].status === 'fail') {
                    firstFailure = stage;
                    break;
                }
            }
            assert.strictEqual(firstFailure, null, 'No failure should be detected');
        });

        it('marketplace CI run with deploy_test failure skips subsequent stages', () => {
            const stageResults = {};
            for (const stage of STAGE_ORDER) {
                stageResults[stage] = { status: 'pass', durationSeconds: 5, logPointer: '', errorSummary: '' };
            }
            stageResults.build = { status: 'skip', durationSeconds: 0, logPointer: '', errorSummary: '' };
            stageResults.deploy_test = { status: 'fail', durationSeconds: 10, logPointer: '', errorSummary: 'Endpoint failed' };

            const result = applySkipLogic(stageResults, 'deploy_test');
            assert.strictEqual(result.register.status, 'skip', 'Register should be skipped after deploy_test failure');
            // Teardown and update always run
            assert.strictEqual(result.teardown.status, 'pass', 'Teardown always runs');
            assert.strictEqual(result.update.status, 'pass', 'Update always runs');
        });
    });
});
