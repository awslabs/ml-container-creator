// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for post-deploy "What's next?" guidance blocks.
 *
 * Renders do/deploy and do/test templates with different feature combinations
 * and verifies that the correct suggestions appear (or don't appear) based on
 * the feature flags and deployment target.
 *
 * Validates: Post-Deploy Guidance Requirements (Task 4)
 *
 * Feature: post-deploy-guidance
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load templates
const deployTemplate = readFileSync(path.join(__dirname, '../../templates/do/deploy'), 'utf8');
const testTemplate = readFileSync(path.join(__dirname, '../../templates/do/test'), 'utf8');

/** Base template variables for realtime-inference rendering */
function realtimeVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        includeBenchmark: false,
        enableLora: false,
        existingEndpointName: undefined,
        orderedEnvVars: [],
        baseImage: '',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: 'hf_test_token',
        hfTokenArn: undefined,
        ngcApiKey: undefined,
        ngcTokenArn: undefined,
        modelFormat: undefined,
        codebuildComputeType: undefined,
        benchmarkConcurrency: 10,
        benchmarkInputTokensMean: 550,
        benchmarkOutputTokensMean: 150,
        benchmarkStreaming: true,
        benchmarkRequestCount: null,
        benchmarkS3OutputPath: '',
        ...overrides
    };
}

/** Base template variables for async-inference rendering */
function asyncVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'async-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        includeBenchmark: false,
        enableLora: false,
        existingEndpointName: undefined,
        orderedEnvVars: [],
        baseImage: '',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: undefined,
        hfTokenArn: undefined,
        ngcApiKey: undefined,
        ngcTokenArn: undefined,
        modelFormat: undefined,
        codebuildComputeType: undefined,
        asyncS3OutputPath: 's3://my-bucket/async-output/',
        asyncSnsSuccessTopic: 'arn:aws:sns:us-east-1:123456789012:success',
        asyncSnsErrorTopic: 'arn:aws:sns:us-east-1:123456789012:error',
        asyncMaxConcurrentInvocations: 1,
        ...overrides
    };
}

/** Base template variables for hyperpod-eks rendering */
function hyperpodVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'hyperpod-eks',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: 'my-cluster',
        hyperPodNamespace: 'ml-workloads',
        hyperPodReplicas: 1,
        fsxVolumeHandle: undefined,
        includeBenchmark: false,
        enableLora: false,
        existingEndpointName: undefined,
        orderedEnvVars: [],
        baseImage: '',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: 'hf_test_token',
        hfTokenArn: undefined,
        ngcApiKey: undefined,
        ngcTokenArn: undefined,
        modelFormat: undefined,
        codebuildComputeType: undefined,
        ...overrides
    };
}

describe('Post-Deploy Guidance: What\'s next? suggestions', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🚀 Starting Post-Deploy Guidance tests');
        console.log('📋 Validates: Post-Deploy Guidance Requirements (Task 4)\n');
    });

    // ================================================================
    // Scenario 1: Real-time + benchmark + lora
    // ================================================================
    describe('Real-time + benchmark + lora', () => {
        let deployOutput;
        let testOutput;

        before(() => {
            const vars = realtimeVars({ includeBenchmark: true, enableLora: true });
            deployOutput = ejs.render(deployTemplate, vars);
            testOutput = ejs.render(testTemplate, vars);
        });

        it('do/deploy should show benchmark suggestion', () => {
            assert.ok(
                deployOutput.includes('./do/benchmark'),
                'deploy must show ./do/benchmark when includeBenchmark is true'
            );
        });

        it('do/deploy should show adapter suggestion', () => {
            assert.ok(
                deployOutput.includes('./do/adapter add'),
                'deploy must show ./do/adapter when enableLora is true'
            );
        });

        it('do/deploy should show status suggestion', () => {
            assert.ok(
                deployOutput.includes('./do/status'),
                'deploy must show ./do/status for realtime'
            );
        });

        it('do/test should show benchmark suggestion', () => {
            assert.ok(
                testOutput.includes('./do/benchmark'),
                'test must show ./do/benchmark when includeBenchmark is true'
            );
        });

        it('do/test should show adapter suggestion', () => {
            assert.ok(
                testOutput.includes('./do/adapter add'),
                'test must show ./do/adapter when enableLora is true'
            );
        });
    });

    // ================================================================
    // Scenario 2: Real-time without extras
    // ================================================================
    describe('Real-time without extras', () => {
        let deployOutput;
        let testOutput;

        before(() => {
            const vars = realtimeVars({ includeBenchmark: false, enableLora: false });
            deployOutput = ejs.render(deployTemplate, vars);
            testOutput = ejs.render(testTemplate, vars);
        });

        it('do/deploy should NOT show benchmark suggestion', () => {
            // Extract the "What's next?" block from deploy output
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            assert.ok(whatsNextIdx > 0, 'deploy must contain What\'s next? block');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(
                !whatsNextBlock.includes('./do/benchmark'),
                'deploy must NOT show ./do/benchmark when includeBenchmark is false'
            );
        });

        it('do/deploy should NOT show adapter suggestion', () => {
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(
                !whatsNextBlock.includes('./do/adapter'),
                'deploy must NOT show ./do/adapter when enableLora is false'
            );
        });

        it('do/deploy should show base suggestions (test, status, register, logs, clean)', () => {
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(whatsNextBlock.includes('./do/test'), 'must show ./do/test');
            assert.ok(whatsNextBlock.includes('./do/status'), 'must show ./do/status');
            assert.ok(whatsNextBlock.includes('./do/register'), 'must show ./do/register');
            assert.ok(whatsNextBlock.includes('./do/logs'), 'must show ./do/logs');
            assert.ok(whatsNextBlock.includes('./do/clean endpoint'), 'must show ./do/clean endpoint');
        });

        it('do/test should NOT show benchmark suggestion', () => {
            const whatsNextIdx = testOutput.indexOf('What\'s next?');
            assert.ok(whatsNextIdx > 0, 'test must contain What\'s next? block');
            const whatsNextBlock = testOutput.substring(whatsNextIdx);

            assert.ok(
                !whatsNextBlock.includes('./do/benchmark'),
                'test must NOT show ./do/benchmark when includeBenchmark is false'
            );
        });

        it('do/test should NOT show adapter suggestion', () => {
            const whatsNextIdx = testOutput.indexOf('What\'s next?');
            const whatsNextBlock = testOutput.substring(whatsNextIdx);

            assert.ok(
                !whatsNextBlock.includes('./do/adapter'),
                'test must NOT show ./do/adapter when enableLora is false'
            );
        });

        it('do/test should show base suggestions (register, logs)', () => {
            const whatsNextIdx = testOutput.indexOf('What\'s next?');
            const whatsNextBlock = testOutput.substring(whatsNextIdx);

            assert.ok(whatsNextBlock.includes('./do/register'), 'must show ./do/register');
            assert.ok(whatsNextBlock.includes('./do/logs'), 'must show ./do/logs');
        });
    });

    // ================================================================
    // Scenario 3: Async inference
    // ================================================================
    describe('Async inference', () => {
        let deployOutput;
        let testOutput;

        before(() => {
            const vars = asyncVars();
            deployOutput = ejs.render(deployTemplate, vars);
            testOutput = ejs.render(testTemplate, vars);
        });

        it('do/deploy should show S3 output check suggestion', () => {
            assert.ok(
                deployOutput.includes('aws s3 ls'),
                'deploy must show aws s3 ls for async output check'
            );
        });

        it('do/deploy should show async test suggestion', () => {
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(
                whatsNextBlock.includes('./do/test'),
                'deploy must show ./do/test for async'
            );
        });

        it('do/test should show S3 output check suggestion', () => {
            assert.ok(
                testOutput.includes('aws s3 ls'),
                'test must show aws s3 ls for async output check'
            );
        });
    });

    // ================================================================
    // Scenario 4: External endpoint (omits clean endpoint)
    // ================================================================
    describe('External endpoint', () => {
        let deployOutput;

        before(() => {
            const vars = realtimeVars({ existingEndpointName: 'my-external-ep' });
            deployOutput = ejs.render(deployTemplate, vars);
        });

        it('do/deploy should NOT show clean endpoint suggestion', () => {
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            assert.ok(whatsNextIdx > 0, 'deploy must contain What\'s next? block');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(
                !whatsNextBlock.includes('./do/clean endpoint'),
                'deploy must NOT show ./do/clean endpoint when existingEndpointName is set'
            );
        });

        it('do/deploy should still show other base suggestions', () => {
            const whatsNextIdx = deployOutput.indexOf('What\'s next?');
            const whatsNextBlock = deployOutput.substring(whatsNextIdx);

            assert.ok(whatsNextBlock.includes('./do/test'), 'must show ./do/test');
            assert.ok(whatsNextBlock.includes('./do/status'), 'must show ./do/status');
            assert.ok(whatsNextBlock.includes('./do/register'), 'must show ./do/register');
            assert.ok(whatsNextBlock.includes('./do/logs'), 'must show ./do/logs');
        });
    });

    // ================================================================
    // Scenario 5: HyperPod
    // ================================================================
    describe('HyperPod', () => {
        let deployOutput;
        let testOutput;

        before(() => {
            const vars = hyperpodVars();
            deployOutput = ejs.render(deployTemplate, vars);
            testOutput = ejs.render(testTemplate, vars);
        });

        it('do/deploy should show kubectl get pods suggestion', () => {
            assert.ok(
                deployOutput.includes('kubectl get pods'),
                'deploy must show kubectl get pods for HyperPod'
            );
        });

        it('do/deploy should show kubectl logs suggestion', () => {
            assert.ok(
                deployOutput.includes('kubectl logs'),
                'deploy must show kubectl logs for HyperPod'
            );
        });

        it('do/test should show kubectl get pods suggestion', () => {
            assert.ok(
                testOutput.includes('kubectl get pods'),
                'test must show kubectl get pods for HyperPod'
            );
        });

        it('do/test should show kubectl logs suggestion', () => {
            assert.ok(
                testOutput.includes('kubectl logs'),
                'test must show kubectl logs for HyperPod'
            );
        });
    });
});
