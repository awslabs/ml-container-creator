// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 6: Backward compatibility for hyperpod-eks
 *
 * For any valid hyperpod-eks configuration, the generated do/ scripts
 * are NOT affected by the async-inference feature addition. Specifically,
 * do/config, do/deploy, do/test, do/clean, and do/logs must not contain
 * any async-specific content when deploymentTarget is hyperpod-eks.
 *
 * Validates: Requirements 10.2, 10.4
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
const templatesDir = path.join(__dirname, '../../templates/do');

const configTemplate = readFileSync(path.join(templatesDir, 'config'), 'utf8');
const deployTemplate = readFileSync(path.join(templatesDir, 'deploy.d/hyperpod-eks'), 'utf8');
const testTemplate = readFileSync(path.join(templatesDir, 'test'), 'utf8');
const cleanTemplate = readFileSync(path.join(templatesDir, 'clean.d/hyperpod-eks'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, { orderedEnvVars: [], baseImage: '', ...vars }, { filename: path.join(templatesDir, 'deploy') });
}

/** Arbitrary for a hyperpod-eks configuration with async vars set to undefined */
const hyperpodEksConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
    deploymentConfig: fc.constantFrom(
        'http-flask', 'http-fastapi',
        'transformers-vllm', 'transformers-sglang'
    ),
    framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
    modelServer: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
    deploymentTarget: fc.constant('hyperpod-eks'),
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
    hyperPodNamespace: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
    hyperPodReplicas: fc.constantFrom(1, 2, 3, 4),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'openai/gpt-oss-20b'),
    hfToken: fc.constantFrom('hf_test123', undefined),
    ngcApiKey: fc.constantFrom(undefined),
    modelFormat: fc.constantFrom('pkl', 'json', 'keras', undefined)
});

describe('Feature: async-inference-endpoint, Property 6: Backward compatibility for hyperpod-eks', () => {
    before(() => {
        console.log('\n🔄 Starting Backward Compatibility for HyperPod EKS (Async Feature) Property Tests');
        console.log('📋 Testing: Requirements 10.2, 10.4');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('do/config for hyperpod-eks must contain HP_CLUSTER_NAME, HP_NAMESPACE, HP_REPLICAS but NOT async-specific variables', function () {
        /**
         * **Validates: Requirements 10.2, 10.4**
         *
         * When deploymentTarget === 'hyperpod-eks', do/config must contain
         * HP_CLUSTER_NAME, HP_NAMESPACE, HP_REPLICAS and
         * must NOT contain ASYNC_S3_OUTPUT_PATH, ASYNC_SNS_SUCCESS_TOPIC,
         * ASYNC_SNS_ERROR_TOPIC, or ASYNC_MAX_CONCURRENT_INVOCATIONS.
         */
        this.timeout(30000);

        console.log('  🧪 do/config: HyperPod vars present, no async variables');

        fc.assert(fc.property(
            hyperpodEksConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    fsxVolumeHandle: undefined,
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    roleArn: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(configTemplate, vars);

                // Must contain HyperPod-specific variables
                assert.ok(
                    output.includes('HP_CLUSTER_NAME'),
                    'hyperpod-eks do/config must contain HP_CLUSTER_NAME'
                );
                assert.ok(
                    output.includes('HP_NAMESPACE'),
                    'hyperpod-eks do/config must contain HP_NAMESPACE'
                );
                assert.ok(
                    output.includes('HP_REPLICAS'),
                    'hyperpod-eks do/config must contain HP_REPLICAS'
                );

                // Must NOT actively export async-specific variables
                // (async section comments are always present under BL062 but must not export values)
                assert.ok(
                    !output.includes('export ASYNC_S3_OUTPUT_PATH='),
                    'hyperpod-eks do/config must NOT export ASYNC_S3_OUTPUT_PATH'
                );
                assert.ok(
                    !output.includes('export ASYNC_SNS_SUCCESS_TOPIC='),
                    'hyperpod-eks do/config must NOT export ASYNC_SNS_SUCCESS_TOPIC'
                );
                assert.ok(
                    !output.includes('export ASYNC_SNS_ERROR_TOPIC='),
                    'hyperpod-eks do/config must NOT export ASYNC_SNS_ERROR_TOPIC'
                );
                assert.ok(
                    !output.match(/^export ASYNC_MAX_CONCURRENT_INVOCATIONS="/m),
                    'hyperpod-eks do/config must NOT actively export ASYNC_MAX_CONCURRENT_INVOCATIONS'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/config backward compatible — no async variables leak');
    });

    it('do/deploy for hyperpod-eks must contain kubectl commands but NOT async deploy logic', function () {
        /**
         * **Validates: Requirements 10.2, 10.4**
         *
         * When deploymentTarget === 'hyperpod-eks', do/deploy must contain
         * kubectl commands (describe-cluster, eks update-kubeconfig, kubectl apply)
         * but NOT contain AsyncInferenceConfig, s3api head-bucket, or sns create-topic.
         */
        this.timeout(30000);

        console.log('  🧪 do/deploy: kubectl commands present, no async deploy logic');

        fc.assert(fc.property(
            hyperpodEksConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    fsxVolumeHandle: undefined,
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    roleArn: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(deployTemplate, vars);

                // Must contain HyperPod/kubectl commands
                assert.ok(
                    output.includes('describe-cluster'),
                    'hyperpod-eks do/deploy must contain describe-cluster'
                );
                assert.ok(
                    output.includes('eks update-kubeconfig'),
                    'hyperpod-eks do/deploy must contain eks update-kubeconfig'
                );
                assert.ok(
                    output.includes('kubectl apply'),
                    'hyperpod-eks do/deploy must contain kubectl apply'
                );

                // Must NOT contain async-specific deploy logic
                assert.ok(
                    !output.includes('AsyncInferenceConfig'),
                    'hyperpod-eks do/deploy must NOT contain AsyncInferenceConfig'
                );
                assert.ok(
                    !output.includes('s3api head-bucket'),
                    'hyperpod-eks do/deploy must NOT contain s3api head-bucket'
                );
                assert.ok(
                    !output.includes('sns create-topic'),
                    'hyperpod-eks do/deploy must NOT contain sns create-topic'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/deploy backward compatible — no async deploy logic leak');
    });

    it('do/test for hyperpod-eks must contain kubectl port-forward but NOT invoke-endpoint-async or S3 polling', function () {
        /**
         * **Validates: Requirements 10.2, 10.4**
         *
         * When deploymentTarget === 'hyperpod-eks', do/test must contain
         * kubectl port-forward but NOT contain invoke-endpoint-async
         * or S3 polling logic.
         */
        this.timeout(30000);

        console.log('  🧪 do/test: kubectl port-forward present, no async test logic');

        fc.assert(fc.property(
            hyperpodEksConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    fsxVolumeHandle: undefined,
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    roleArn: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(testTemplate, vars);

                // Must contain kubectl port-forward
                assert.ok(
                    output.includes('kubectl port-forward'),
                    'hyperpod-eks do/test must contain kubectl port-forward'
                );

                // Must NOT contain async invocation or S3 polling
                assert.ok(
                    !output.includes('invoke-endpoint-async'),
                    'hyperpod-eks do/test must NOT contain invoke-endpoint-async'
                );
                assert.ok(
                    !output.includes('Polling for async result'),
                    'hyperpod-eks do/test must NOT contain S3 polling logic'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/test backward compatible — no async test logic leak');
    });

    it('do/clean for hyperpod-eks must contain clean_hyperpod with kubectl delete but NOT async-specific cleanup', function () {
        /**
         * **Validates: Requirements 10.2, 10.4**
         *
         * When deploymentTarget === 'hyperpod-eks', do/clean must contain
         * clean_hyperpod with kubectl delete but NOT contain
         * async-specific cleanup patterns.
         */
        this.timeout(30000);

        console.log('  🧪 do/clean: clean_hyperpod present, no async cleanup logic');

        fc.assert(fc.property(
            hyperpodEksConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    fsxVolumeHandle: undefined,
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    roleArn: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(cleanTemplate, vars);

                // Must contain HyperPod cleanup
                assert.ok(
                    output.includes('clean_hyperpod'),
                    'hyperpod-eks do/clean must contain clean_hyperpod function'
                );

                // Must contain kubectl delete
                assert.ok(
                    output.includes('kubectl delete'),
                    'hyperpod-eks do/clean must contain kubectl delete'
                );

                // Must NOT contain async-specific cleanup references
                assert.ok(
                    !output.includes('async resources'),
                    'hyperpod-eks do/clean must NOT contain async resources text'
                );
                assert.ok(
                    !output.includes('SageMaker async'),
                    'hyperpod-eks do/clean must NOT contain SageMaker async text'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/clean backward compatible — no async cleanup logic leak');
    });

    it('do/logs for hyperpod-eks must contain kubectl logs but NOT async-specific log patterns', function () {
        /**
         * **Validates: Requirements 10.2, 10.4**
         *
         * When deploymentTarget === 'hyperpod-eks', do/logs must contain
         * kubectl logs but NOT contain async-specific log patterns.
         */
        this.timeout(30000);

        console.log('  🧪 do/logs: kubectl logs present, no async log patterns');

        fc.assert(fc.property(
            hyperpodEksConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    fsxVolumeHandle: undefined,
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    roleArn: undefined,
                    asyncS3OutputPath: undefined,
                    asyncSnsSuccessTopic: undefined,
                    asyncSnsErrorTopic: undefined,
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderTemplate(logsTemplate, vars);

                // Must contain kubectl logs
                assert.ok(
                    output.includes('kubectl logs'),
                    'hyperpod-eks do/logs must contain kubectl logs'
                );

                // Must NOT contain async-specific log patterns
                assert.ok(
                    !output.includes('Tailing logs for async inference endpoint'),
                    'hyperpod-eks do/logs must NOT contain async inference endpoint header'
                );
                assert.ok(
                    !output.includes('SageMaker Async Inference Logs'),
                    'hyperpod-eks do/logs must NOT contain SageMaker Async Inference Logs section header'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/logs backward compatible — no async log patterns leak');
    });
});
