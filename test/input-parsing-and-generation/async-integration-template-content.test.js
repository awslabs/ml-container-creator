// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for async-inference template content.
 *
 * Renders each do/ template with deploymentTarget === 'async-inference'
 * and verifies that async-specific content is present.
 *
 * Validates: Requirements 4.1, 5.1, 6.1, 7.1, 13.1
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all five do/ templates
const configTemplate = readFileSync(path.join(__dirname, '../../templates/do/config'), 'utf8');
const deployTemplatePath = path.join(__dirname, '../../templates/do/deploy');
const deployTemplate = readFileSync(deployTemplatePath, 'utf8');
const testTemplate = readFileSync(path.join(__dirname, '../../templates/do/test'), 'utf8');
const cleanTemplatePath = path.join(__dirname, '../../templates/do/clean');
const cleanTemplate = readFileSync(cleanTemplatePath, 'utf8');
const logsTemplate = readFileSync(path.join(__dirname, '../../templates/do/logs'), 'utf8');

/** Base template variables for async-inference rendering */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'local',
        deploymentTarget: 'async-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: undefined,
        ngcApiKey: undefined,
        modelFormat: undefined,
        asyncS3OutputPath: '',
        asyncSnsSuccessTopic: '',
        asyncSnsErrorTopic: '',
        asyncMaxConcurrentInvocations: 1,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        codebuildComputeType: undefined,
        orderedEnvVars: [],
        baseImage: '',
        ...overrides
    };
}

describe('Async Integration: Generated template content', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🚀 Starting async-inference integration template content tests');
        console.log('📋 Validates: Requirements 4.1, 5.1, 6.1, 7.1, 13.1\n');
    });

    // ================================================================
    // Test 1: do/config contains async variables
    // ================================================================
    describe('do/config with async-inference', () => {
        it('should contain async-specific variables with defaults', () => {
            const output = ejs.render(configTemplate, baseVars());

            assert.ok(output.includes('ASYNC_S3_OUTPUT_PATH'), 'must contain ASYNC_S3_OUTPUT_PATH');
            assert.ok(output.includes('ASYNC_SNS_SUCCESS_TOPIC'), 'must contain ASYNC_SNS_SUCCESS_TOPIC');
            assert.ok(output.includes('ASYNC_SNS_ERROR_TOPIC'), 'must contain ASYNC_SNS_ERROR_TOPIC');
            assert.ok(output.includes('ASYNC_MAX_CONCURRENT_INVOCATIONS'), 'must contain ASYNC_MAX_CONCURRENT_INVOCATIONS');
            assert.ok(output.includes('INSTANCE_TYPE'), 'must contain INSTANCE_TYPE');
            assert.ok(!output.includes('HYPERPOD_CLUSTER_NAME'), 'must NOT contain HYPERPOD_CLUSTER_NAME');
        });

        it('should contain user-provided S3 output path when specified', () => {
            const output = ejs.render(configTemplate, baseVars({
                asyncS3OutputPath: 's3://my-bucket/output/'
            }));

            assert.ok(output.includes('s3://my-bucket/output/'), 'must contain the user-provided S3 path literally');
            assert.ok(output.includes('ASYNC_S3_OUTPUT_PATH'), 'must still export ASYNC_S3_OUTPUT_PATH');
        });
    });

    // ================================================================
    // Test 2: do/deploy contains AsyncInferenceConfig block
    // ================================================================
    describe('do/deploy with async-inference', () => {
        it('should contain async inference config elements (default bootstrap)', () => {
            const output = ejs.render(deployTemplate, baseVars(), { filename: deployTemplatePath });

            assert.ok(output.includes('async-inference-config'), 'must contain --async-inference-config CLI flag');
            assert.ok(
                output.includes('AsyncInferenceConfig') || output.includes('OutputConfig'),
                'must contain AsyncInferenceConfig or OutputConfig JSON structure'
            );
            assert.ok(output.includes('S3OutputPath'), 'must contain S3OutputPath');
            assert.ok(output.includes('NotificationConfig'), 'must contain NotificationConfig');
            assert.ok(output.includes('SuccessTopic'), 'must contain SuccessTopic');
            assert.ok(output.includes('ErrorTopic'), 'must contain ErrorTopic');
            assert.ok(output.includes('MaxConcurrentInvocationsPerInstance'), 'must contain MaxConcurrentInvocationsPerInstance');
        });

        it('should include bootstrap blocks when using defaults (empty paths)', () => {
            const output = ejs.render(deployTemplate, baseVars(), { filename: deployTemplatePath });

            // Default = empty string → bootstrap (check-and-create) blocks appear
            assert.ok(output.includes('create-bucket'), 'must contain S3 bucket bootstrap (create-bucket)');
            assert.ok(output.includes('create-topic'), 'must contain SNS topic bootstrap (create-topic)');
        });

        it('should skip bootstrap when custom values are provided', () => {
            const output = ejs.render(deployTemplate, baseVars({
                asyncS3OutputPath: 's3://custom-bucket/output/',
                asyncSnsSuccessTopic: 'arn:aws:sns:us-east-1:123456789012:custom-success',
                asyncSnsErrorTopic: 'arn:aws:sns:us-east-1:123456789012:custom-error'
            }), { filename: deployTemplatePath });

            assert.ok(output.includes('Using custom S3 output path'), 'must skip S3 bucket creation');
            assert.ok(output.includes('Using custom SNS success topic'), 'must skip SNS success topic creation');
            assert.ok(output.includes('Using custom SNS error topic'), 'must skip SNS error topic creation');
        });
    });

    // ================================================================
    // Test 3: do/test contains invoke-endpoint-async
    // ================================================================
    describe('do/test with async-inference', () => {
        it('should contain async invocation commands', () => {
            const output = ejs.render(testTemplate, baseVars());

            assert.ok(output.includes('invoke-endpoint-async'), 'must contain invoke-endpoint-async');
            assert.ok(output.includes('--input-location'), 'must contain --input-location for S3 input');
            assert.ok(
                output.includes('ASYNC_S3_OUTPUT_PATH') || output.includes('S3_INPUT_LOCATION'),
                'must reference async S3 paths'
            );
            assert.ok(
                output.includes('POLL_TIMEOUT') || output.includes('Polling') || output.includes('polling'),
                'must contain polling logic'
            );
        });
    });

    // ================================================================
    // Test 4: do/clean contains endpoint cleanup target
    // ================================================================
    describe('do/clean with async-inference', () => {
        it('should contain endpoint cleanup functions and case target', () => {
            const output = ejs.render(cleanTemplate, baseVars(), { filename: cleanTemplatePath });

            assert.ok(output.includes('endpoint)'), 'must contain endpoint) case statement target');
            assert.ok(output.includes('clean_endpoint'), 'must contain clean_endpoint function');
            assert.ok(output.includes('delete-model'), 'must contain delete-model');
            assert.ok(output.includes('delete-endpoint'), 'must contain delete-endpoint');
            assert.ok(output.includes('delete-endpoint-config'), 'must contain delete-endpoint-config');
        });
    });

    // ================================================================
    // Test 5: do/logs contains CloudWatch Logs tailing
    // ================================================================
    describe('do/logs with async-inference', () => {
        it('should contain CloudWatch Logs tailing commands', () => {
            const output = ejs.render(logsTemplate, baseVars());

            assert.ok(output.includes('aws logs tail'), 'must contain aws logs tail');
            assert.ok(output.includes('/aws/sagemaker/Endpoints/'), 'must contain /aws/sagemaker/Endpoints/ log group');
            assert.ok(output.includes('--follow'), 'must contain --follow flag');
        });
    });
});
