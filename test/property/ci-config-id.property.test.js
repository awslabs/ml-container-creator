// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Config ID Property-Based Tests
 *
 * Property 8: configId determinism
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { computeConfigId } from '../../generators/app/lib/ci-register-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(
    'transformers-vllm', 'transformers-sglang', 'transformers-lmi',
    'transformers-djl', 'transformers-tensorrt-llm',
    'http-flask', 'http-fastapi', 'http-nginx',
    'triton-fil', 'triton-python', 'triton-onnx', 'triton-tensorrt',
    'diffusors-vllm', 'diffusors-sglang', 'diffusors-comfyui'
);

const arbModelName = fc.oneof(
    fc.constant(''),
    fc.constant('none'),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-/_.'.split('')), { minLength: 1, maxLength: 80 }).map(arr => arr.join(''))
);

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.m5.xlarge', 'ml.m5.2xlarge',
    'ml.p3.2xlarge', 'ml.p4d.24xlarge', 'ml.c5.xlarge', 'ml.g4dn.xlarge'
);

const arbRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1',
    'ap-southeast-1', 'ap-northeast-1', 'ap-south-1'
);

const arbDeploymentTarget = fc.constantFrom(
    'managed-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'
);

const arbConfigInput = fc.record({
    deploymentConfig: arbDeploymentConfig,
    modelName: arbModelName,
    instanceType: arbInstanceType,
    region: arbRegion,
    deploymentTarget: arbDeploymentTarget
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 8: configId determinism', () => {

    /**
     * Validates: Requirements 9.5
     *
     * For any deployment configuration, computing the configId hash multiple
     * times with the same input fields SHALL always produce the same
     * 16-character hex string.
     */
    it('same inputs always produce the same configId', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbConfigInput,
            (config) => {
                const id1 = computeConfigId(
                    config.deploymentConfig, config.modelName,
                    config.instanceType, config.region, config.deploymentTarget
                );
                const id2 = computeConfigId(
                    config.deploymentConfig, config.modelName,
                    config.instanceType, config.region, config.deploymentTarget
                );

                assert.strictEqual(id1, id2,
                    `Same inputs should produce same configId: '${id1}' vs '${id2}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('configId is always a 16-character lowercase hex string', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbConfigInput,
            (config) => {
                const id = computeConfigId(
                    config.deploymentConfig, config.modelName,
                    config.instanceType, config.region, config.deploymentTarget
                );

                assert.strictEqual(id.length, 16,
                    `configId should be 16 chars, got ${id.length}: '${id}'`);
                assert.ok(/^[0-9a-f]+$/.test(id),
                    `configId should be lowercase hex, got '${id}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('different inputs produce different configIds (with cryptographic probability)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbConfigInput,
            arbConfigInput,
            (config1, config2) => {
                // Only test when inputs actually differ
                const sameInputs =
                    config1.deploymentConfig === config2.deploymentConfig &&
                    config1.modelName === config2.modelName &&
                    config1.instanceType === config2.instanceType &&
                    config1.region === config2.region &&
                    config1.deploymentTarget === config2.deploymentTarget;

                if (sameInputs) {
                    // Same inputs should produce same ID (covered by other test)
                    return;
                }

                const id1 = computeConfigId(
                    config1.deploymentConfig, config1.modelName,
                    config1.instanceType, config1.region, config1.deploymentTarget
                );
                const id2 = computeConfigId(
                    config2.deploymentConfig, config2.modelName,
                    config2.instanceType, config2.region, config2.deploymentTarget
                );

                assert.notStrictEqual(id1, id2,
                    'Different inputs should produce different configIds.\n' +
                    `Input 1: ${JSON.stringify(config1)}\n` +
                    `Input 2: ${JSON.stringify(config2)}\n` +
                    `Both produced: '${id1}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('configId is computed from all five input fields', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbConfigInput,
            (config) => {
                const baseId = computeConfigId(
                    config.deploymentConfig, config.modelName,
                    config.instanceType, config.region, config.deploymentTarget
                );

                // Changing any single field should change the configId
                const variations = [
                    computeConfigId('CHANGED-config', config.modelName, config.instanceType, config.region, config.deploymentTarget),
                    computeConfigId(config.deploymentConfig, `${config.modelName  }-changed`, config.instanceType, config.region, config.deploymentTarget),
                    computeConfigId(config.deploymentConfig, config.modelName, 'ml.changed.type', config.region, config.deploymentTarget),
                    computeConfigId(config.deploymentConfig, config.modelName, config.instanceType, 'xx-changed-1', config.deploymentTarget),
                    computeConfigId(config.deploymentConfig, config.modelName, config.instanceType, config.region, 'changed-target')
                ];

                for (let i = 0; i < variations.length; i++) {
                    assert.notStrictEqual(variations[i], baseId,
                        `Changing field ${i} should produce a different configId`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
