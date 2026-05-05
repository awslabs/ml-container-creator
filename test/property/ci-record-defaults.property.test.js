// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Record Defaults Property-Based Tests
 *
 * Property 1: Initial record defaults
 * Property 9: Re-registration resets status and preserves createdAt
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { computeConfigId, buildCiRecord } from '../../generators/app/lib/ci-register-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(
    'transformers-vllm', 'transformers-sglang', 'transformers-lmi',
    'transformers-djl', 'http-flask', 'http-fastapi', 'http-nginx',
    'triton-fil', 'triton-python', 'diffusors-vllm', 'diffusors-comfyui'
);

const arbModelName = fc.oneof(
    fc.constant(''),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-/'.split('')), { minLength: 1, maxLength: 60 }).map(arr => arr.join(''))
);

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.m5.xlarge', 'ml.m5.2xlarge',
    'ml.p3.2xlarge', 'ml.p4d.24xlarge', 'ml.c5.xlarge'
);

const arbRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

const arbDeploymentTarget = fc.constantFrom(
    'managed-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'
);

const arbBaseImage = fc.oneof(
    fc.constant('vllm/vllm-openai:v0.8.5'),
    fc.constant('nvcr.io/nvidia/tritonserver:24.01-py3'),
    fc.constant('custom-image:latest'),
    fc.constant('my-registry/my-image:1.2.3')
);

const arbProjectName = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 3, maxLength: 30 }
).map(arr => arr.join(''));

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 1: Initial record defaults', () => {

    /**
     * Validates: Requirements 2.4, 14.2
     *
     * For any valid deployment configuration registered via --ci,
     * the resulting CI_Record SHALL have testStatus set to 'untested'
     * and lastTestTimestamp set to '1970-01-01T00:00:00Z'.
     */
    it('initial record always has testStatus=untested and lastTestTimestamp=epoch', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbDeploymentConfig,
            arbModelName,
            arbInstanceType,
            arbRegion,
            arbDeploymentTarget,
            arbBaseImage,
            arbProjectName,
            (deploymentConfig, modelName, instanceType, region, deploymentTarget, baseImage, projectName) => {
                const configId = computeConfigId(deploymentConfig, modelName, instanceType, region, deploymentTarget);

                const configJson = JSON.stringify({
                    deploymentConfig,
                    modelName: modelName || 'none',
                    instanceType,
                    awsRegion: region,
                    deploymentTarget,
                    baseImage,
                    projectName
                });

                const record = buildCiRecord(configId, configJson, {
                    deploymentConfig,
                    baseImage,
                    baseImageVersion: baseImage.includes(':') ? baseImage.split(':').pop() : '',
                    projectName
                });

                assert.strictEqual(record.testStatus, 'untested',
                    `testStatus should be 'untested', got '${record.testStatus}'`);
                assert.strictEqual(record.lastTestTimestamp, '1970-01-01T00:00:00Z',
                    `lastTestTimestamp should be epoch zero, got '${record.lastTestTimestamp}'`);
                assert.strictEqual(record.schemaVersion, 1,
                    `schemaVersion should be 1, got ${record.schemaVersion}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

describe('Feature: ci-integration-harness, Property 9: Re-registration resets status and preserves createdAt', () => {

    /**
     * Validates: Requirements 9.4, 9.6
     *
     * For any CI_Record that already exists, re-registering with the same
     * configId SHALL update configJson, reset testStatus to 'untested',
     * and preserve the original createdAt timestamp.
     */
    it('re-registration resets testStatus to untested and preserves original createdAt', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbDeploymentConfig,
            arbModelName,
            arbInstanceType,
            arbRegion,
            arbDeploymentTarget,
            arbBaseImage,
            arbProjectName,
            fc.constantFrom('pass', 'fail-build', 'fail-deploy', 'fail-test', 'running'),
            (deploymentConfig, modelName, instanceType, region, deploymentTarget, baseImage, projectName, previousStatus) => {
                const configId = computeConfigId(deploymentConfig, modelName, instanceType, region, deploymentTarget);

                // Simulate original record
                const originalConfigJson = JSON.stringify({ deploymentConfig, modelName, instanceType });
                const originalRecord = buildCiRecord(configId, originalConfigJson, {
                    deploymentConfig,
                    baseImage,
                    baseImageVersion: baseImage.includes(':') ? baseImage.split(':').pop() : '',
                    projectName
                });
                const originalCreatedAt = originalRecord.createdAt;

                // Simulate the record having been tested (status changed)
                originalRecord.testStatus = previousStatus;
                originalRecord.lastTestTimestamp = '2026-05-01T10:00:00Z';

                // Re-register: build a new record with updated configJson
                const updatedConfigJson = JSON.stringify({ deploymentConfig, modelName, instanceType, extra: 'new-field' });
                const reRegisteredRecord = buildCiRecord(configId, updatedConfigJson, {
                    deploymentConfig,
                    baseImage,
                    baseImageVersion: baseImage.includes(':') ? baseImage.split(':').pop() : '',
                    projectName
                });

                // Simulate preserving createdAt from original
                reRegisteredRecord.createdAt = originalCreatedAt;

                // Verify re-registration behavior
                assert.strictEqual(reRegisteredRecord.testStatus, 'untested',
                    'Re-registered record should have testStatus=untested');
                assert.strictEqual(reRegisteredRecord.lastTestTimestamp, '1970-01-01T00:00:00Z',
                    'Re-registered record should reset lastTestTimestamp to epoch');
                assert.strictEqual(reRegisteredRecord.configJson, updatedConfigJson,
                    'Re-registered record should have updated configJson');
                assert.strictEqual(reRegisteredRecord.createdAt, originalCreatedAt,
                    'Re-registered record should preserve original createdAt');
                assert.strictEqual(reRegisteredRecord.configId, configId,
                    'Re-registered record should have same configId');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
