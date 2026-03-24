// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 5: Backward compatibility for managed-inference
 *
 * For any valid managed-inference configuration, the generated do/ scripts
 * are NOT affected by the async-inference feature addition. Specifically,
 * do/config, do/deploy, do/test, do/clean, and do/logs must not contain
 * any async-specific content when deploymentTarget is managed-inference.
 *
 * Validates: Requirements 10.1, 10.4
 *
 * Feature: async-inference-endpoint
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all do-framework templates
const templatesDir = path.join(__dirname, '../../generators/app/templates/do');

const configTemplate = readFileSync(path.join(templatesDir, 'config'), 'utf8');
const deployTemplate = readFileSync(path.join(templatesDir, 'deploy'), 'utf8');
const testTemplate = readFileSync(path.join(templatesDir, 'test'), 'utf8');
const cleanTemplate = readFileSync(path.join(templatesDir, 'clean'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, vars);
}

/** Arbitrary for a managed-inference configuration with async vars set to undefined */
const managedInferenceConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom(
        'http-flask', 'http-fastapi',
        'transformers-vllm', 'transformers-sglang'
    ),
    framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
    modelServer: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
    deploymentTarget: fc.constant('managed-inference'),
    instanceType: fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'openai/gpt-oss-20b'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole', undefined),
    hfToken: fc.constantFrom('hf_test123', undefined),
    ngcApiKey: fc.constantFrom(undefined),
    inferenceAmiVersion: fc.constantFrom('1.0.0', undefined),
    modelFormat: fc.constantFrom('pkl', 'json', 'keras', undefined)
});

describe('Feature: async-inference-endpoint, Property 5: Backward compatibility for managed-inference', () => {
    before(() => {
        console.log('\n🔄 Starting Backward Compatibility for Managed Inference (Async Feature) Property Tests');
        console.log('📋 Testing: Requirements 10.1, 10.4');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('do/config for managed-inference must contain INSTANCE_TYPE but NOT async-specific variables', function () {
        /**
         * **Validates: Requirements 10.1, 10.4**
         *
         * When deploymentTarget === 'managed-inference', do/config must contain
         * INSTANCE_TYPE and must NOT contain ASYNC_S3_OUTPUT_PATH,
         * ASYNC_SNS_SUCCESS_TOPIC, ASYNC_SNS_ERROR_TOPIC, or
         * ASYNC_MAX_CONCURRENT_INVOCATIONS.
         */
        this.timeout(30000);

        console.log('  🧪 do/config: INSTANCE_TYPE present, no async variables');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(configTemplate, vars);

                // Must contain INSTANCE_TYPE for managed-inference
                assert.ok(
                    output.includes('INSTANCE_TYPE'),
                    'managed-inference do/config must contain INSTANCE_TYPE'
                );

                // Must NOT contain async-specific variables
                assert.ok(
                    !output.includes('ASYNC_S3_OUTPUT_PATH'),
                    'managed-inference do/config must NOT contain ASYNC_S3_OUTPUT_PATH'
                );
                assert.ok(
                    !output.includes('ASYNC_SNS_SUCCESS_TOPIC'),
                    'managed-inference do/config must NOT contain ASYNC_SNS_SUCCESS_TOPIC'
                );
                assert.ok(
                    !output.includes('ASYNC_SNS_ERROR_TOPIC'),
                    'managed-inference do/config must NOT contain ASYNC_SNS_ERROR_TOPIC'
                );
                assert.ok(
                    !output.includes('ASYNC_MAX_CONCURRENT_INVOCATIONS'),
                    'managed-inference do/config must NOT contain ASYNC_MAX_CONCURRENT_INVOCATIONS'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/config backward compatible — no async variables leak');
    });

    it('do/deploy for managed-inference must contain SageMaker IC logic but NOT async deploy logic', function () {
        /**
         * **Validates: Requirements 10.1, 10.4**
         *
         * When deploymentTarget === 'managed-inference', do/deploy must contain
         * SageMaker inference component logic (create-endpoint-config,
         * create-endpoint, create-inference-component) but NOT contain
         * AsyncInferenceConfig, async-inference-config, s3api head-bucket
         * (async bootstrap), or sns create-topic.
         */
        this.timeout(30000);

        console.log('  🧪 do/deploy: SageMaker IC logic present, no async deploy logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(deployTemplate, vars);

                // Must contain SageMaker inference component commands
                assert.ok(
                    output.includes('sagemaker create-endpoint-config'),
                    'managed-inference do/deploy must contain create-endpoint-config'
                );
                assert.ok(
                    output.includes('sagemaker create-endpoint'),
                    'managed-inference do/deploy must contain create-endpoint'
                );
                assert.ok(
                    output.includes('sagemaker create-inference-component'),
                    'managed-inference do/deploy must contain create-inference-component'
                );

                // Must NOT contain async-specific deploy logic
                assert.ok(
                    !output.includes('AsyncInferenceConfig'),
                    'managed-inference do/deploy must NOT contain AsyncInferenceConfig'
                );
                assert.ok(
                    !output.includes('async-inference-config'),
                    'managed-inference do/deploy must NOT contain async-inference-config'
                );
                assert.ok(
                    !output.includes('s3api head-bucket'),
                    'managed-inference do/deploy must NOT contain s3api head-bucket (async bootstrap)'
                );
                assert.ok(
                    !output.includes('sns create-topic'),
                    'managed-inference do/deploy must NOT contain sns create-topic'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/deploy backward compatible — no async deploy logic leak');
    });

    it('do/test for managed-inference must contain invoke-endpoint but NOT invoke-endpoint-async or S3 polling', function () {
        /**
         * **Validates: Requirements 10.1, 10.4**
         *
         * When deploymentTarget === 'managed-inference', do/test must contain
         * sagemaker-runtime invoke-endpoint but NOT invoke-endpoint-async
         * or S3 polling logic.
         */
        this.timeout(30000);

        console.log('  🧪 do/test: invoke-endpoint present, no async test logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(testTemplate, vars);

                // Must contain synchronous invoke-endpoint
                assert.ok(
                    output.includes('sagemaker-runtime invoke-endpoint'),
                    'managed-inference do/test must contain sagemaker-runtime invoke-endpoint'
                );

                // Must NOT contain async invocation or S3 polling
                assert.ok(
                    !output.includes('invoke-endpoint-async'),
                    'managed-inference do/test must NOT contain invoke-endpoint-async'
                );
                assert.ok(
                    !output.includes('Polling for async result'),
                    'managed-inference do/test must NOT contain S3 polling logic'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/test backward compatible — no async test logic leak');
    });

    it('do/clean for managed-inference must contain clean_endpoint with SageMaker delete commands but NOT async-specific cleanup', function () {
        /**
         * **Validates: Requirements 10.1, 10.4**
         *
         * When deploymentTarget === 'managed-inference', do/clean must contain
         * clean_endpoint with SageMaker delete commands but NOT contain
         * async-specific cleanup patterns.
         */
        this.timeout(30000);

        console.log('  🧪 do/clean: clean_endpoint present, no async cleanup logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(cleanTemplate, vars);

                // Must contain endpoint cleanup
                assert.ok(
                    output.includes('clean_endpoint'),
                    'managed-inference do/clean must contain clean_endpoint function'
                );

                // Must contain SageMaker delete commands
                assert.ok(
                    output.includes('delete-endpoint'),
                    'managed-inference do/clean must contain delete-endpoint'
                );

                // Must NOT contain async-specific cleanup references
                assert.ok(
                    !output.includes('async resources'),
                    'managed-inference do/clean must NOT contain async resources text'
                );
                assert.ok(
                    !output.includes('SageMaker async'),
                    'managed-inference do/clean must NOT contain SageMaker async text'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/clean backward compatible — no async cleanup logic leak');
    });

    it('do/logs for managed-inference must contain CloudWatch aws logs tail but NOT async-specific log patterns', function () {
        /**
         * **Validates: Requirements 10.1, 10.4**
         *
         * When deploymentTarget === 'managed-inference', do/logs must contain
         * CloudWatch aws logs tail but NOT contain async-specific log patterns.
         */
        this.timeout(30000);

        console.log('  🧪 do/logs: CloudWatch tailing present, no async log patterns');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(logsTemplate, vars);

                // Must contain CloudWatch log tailing
                assert.ok(
                    output.includes('aws logs tail'),
                    'managed-inference do/logs must contain aws logs tail'
                );

                // Must contain --follow for tailing
                assert.ok(
                    output.includes('--follow'),
                    'managed-inference do/logs must use --follow for tailing'
                );

                // Must NOT contain async-specific log patterns
                assert.ok(
                    !output.includes('Tailing logs for async inference endpoint'),
                    'managed-inference do/logs must NOT contain async inference endpoint header'
                );
                assert.ok(
                    !output.includes('SageMaker Managed Inference - Async Logs'),
                    'managed-inference do/logs must NOT contain SageMaker Managed Inference - Async Logs section header'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/logs backward compatible — no async log patterns leak');
    });
});
