// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Promoted Attributes Property-Based Tests
 *
 * Property 4: Promoted attribute extraction consistency
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { extractBaseImageVersion, buildCiRecord, computeConfigId } from '../../src/lib/ci-register-helpers.js';

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

const arbVersionTag = fc.oneof(
    fc.tuple(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 })
    ).map(([a, b, c]) => `${a}.${b}.${c}`),
    fc.tuple(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 })
    ).map(([a, b, c]) => `v${a}.${b}.${c}`),
    fc.constant('latest'),
    fc.constant('nightly')
);

const arbImageName = fc.constantFrom(
    'vllm/vllm-openai',
    'nvcr.io/nvidia/tritonserver',
    'custom-registry/my-image',
    'public.ecr.aws/sagemaker/base',
    'ghcr.io/org/model-server'
);

const arbBaseImage = fc.tuple(arbImageName, arbVersionTag)
    .map(([name, tag]) => `${name}:${tag}`);

const arbBaseImageNoTag = fc.constantFrom(
    'vllm/vllm-openai',
    'custom-image',
    'registry.example.com/image'
);

const arbProjectName = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 3, maxLength: 30 }
).map(arr => arr.join(''));

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 4: Promoted attribute extraction consistency', () => {

    /**
     * Validates: Requirements 2.9
     *
     * For any configJson containing deploymentConfig, baseImage,
     * baseImageVersion, and projectName fields, the promoted top-level
     * DynamoDB attributes SHALL exactly match the corresponding values
     * extracted from the JSON payload.
     */
    it('promoted attributes in CI record match values extracted from configJson', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbDeploymentConfig,
            arbBaseImage,
            arbProjectName,
            (deploymentConfig, baseImage, projectName) => {
                const baseImageVersion = extractBaseImageVersion(baseImage);

                const configJson = JSON.stringify({
                    deploymentConfig,
                    baseImage,
                    baseImageVersion,
                    projectName,
                    modelName: 'test-model',
                    instanceType: 'ml.g5.xlarge',
                    awsRegion: 'us-east-1',
                    deploymentTarget: 'realtime-inference'
                });

                const configId = computeConfigId(deploymentConfig, 'test-model', 'ml.g5.xlarge', 'us-east-1', 'realtime-inference');

                const record = buildCiRecord(configId, configJson, {
                    deploymentConfig,
                    baseImage,
                    baseImageVersion,
                    projectName
                });

                // Parse configJson back and verify promoted attributes match
                const parsed = JSON.parse(record.configJson);

                assert.strictEqual(record.deploymentConfig, parsed.deploymentConfig,
                    `Promoted deploymentConfig '${record.deploymentConfig}' should match configJson value '${parsed.deploymentConfig}'`);
                assert.strictEqual(record.baseImage, parsed.baseImage,
                    `Promoted baseImage '${record.baseImage}' should match configJson value '${parsed.baseImage}'`);
                assert.strictEqual(record.baseImageVersion, parsed.baseImageVersion,
                    `Promoted baseImageVersion '${record.baseImageVersion}' should match configJson value '${parsed.baseImageVersion}'`);
                assert.strictEqual(record.projectName, parsed.projectName,
                    `Promoted projectName '${record.projectName}' should match configJson value '${parsed.projectName}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('extractBaseImageVersion correctly extracts version tag from image string', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbBaseImage,
            (baseImage) => {
                const version = extractBaseImageVersion(baseImage);

                // Image has a colon, so version should be the part after the last colon
                const expectedVersion = baseImage.split(':').pop();
                assert.strictEqual(version, expectedVersion,
                    `extractBaseImageVersion('${baseImage}') should return '${expectedVersion}', got '${version}'`);
                assert.ok(version.length > 0,
                    'Version should be non-empty for images with tags');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('extractBaseImageVersion returns empty string for images without tags', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbBaseImageNoTag,
            (baseImage) => {
                const version = extractBaseImageVersion(baseImage);
                assert.strictEqual(version, '',
                    `extractBaseImageVersion('${baseImage}') should return '' for tagless image, got '${version}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
