// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property tests for benchmark container reuse.
 *
 * Verifies that do/build, do/push, and do/submit templates produce identical
 * output regardless of the includeBenchmark value. These scripts handle
 * container building and pushing — benchmarking is entirely isolated to
 * do/benchmark and must not affect container lifecycle scripts.
 *
 * Validates: Requirements 10.2
 *
 * Feature: sagemaker-ai-benchmarking
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

// Load templates
const templatesDir = path.join(__dirname, '../../templates/do');
const buildTemplate = readFileSync(path.join(templatesDir, 'build'), 'utf8');
const pushTemplate = readFileSync(path.join(templatesDir, 'push'), 'utf8');
const submitTemplate = readFileSync(path.join(templatesDir, 'submit'), 'utf8');

/**
 * Arbitrary for deployment configs that support benchmarking.
 */
const deploymentConfigArb = fc.constantFrom(
    'transformers-vllm',
    'transformers-sglang',
    'transformers-tensorrt-llm',
    'transformers-lmi',
    'transformers-djl'
);

/**
 * Arbitrary for base template variables shared across all tests.
 */
const baseVarsArb = fc.record({
    projectName: fc.constantFrom('my-project', 'test-llm', 'bench-test'),
    deploymentConfig: deploymentConfigArb,
    framework: fc.constant('transformers'),
    modelServer: fc.constantFrom('vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constantFrom('local', 'codebuild'),
    deploymentTarget: fc.constant('realtime-inference'),
    instanceType: fc.constantFrom('ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p4d.24xlarge'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b', 'mistralai/Mistral-7B-v0.1'),
    hfToken: fc.constantFrom('hf_test_token', undefined),
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_LARGE')
});

/**
 * Build full template variables from base config with a given includeBenchmark value.
 */
function buildVars(baseConfig, includeBenchmark) {
    return {
        ...baseConfig,
        inferenceAmiVersion: undefined,
        hfTokenArn: undefined,
        ngcApiKey: undefined,
        ngcTokenArn: undefined,
        modelFormat: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        orderedEnvVars: [],
        baseImage: '',
        asyncS3OutputPath: undefined,
        asyncSnsSuccessTopic: undefined,
        asyncSnsErrorTopic: undefined,
        asyncMaxConcurrentInvocations: undefined,
        includeBenchmark,
        benchmarkConcurrency: 10,
        benchmarkInputTokensMean: 550,
        benchmarkOutputTokensMean: 150,
        benchmarkStreaming: true,
        benchmarkRequestCount: null,
        benchmarkS3OutputPath: ''
    };
}

describe('Feature: sagemaker-ai-benchmarking, Property: Container reuse — do/build, do/push, do/submit unchanged by includeBenchmark', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🔒 Starting Benchmark Container Reuse Property Tests');
        console.log('📋 Testing: Requirements 10.2');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('Property 1: do/build output is identical with includeBenchmark true vs false', () => {
        /**
         * **Validates: Requirements 10.2**
         *
         * The do/build template must produce identical output whether
         * includeBenchmark is true or false. Benchmarking does not affect
         * the container build process.
         */
        console.log('  🧪 do/build: unchanged regardless of includeBenchmark');

        fc.assert(fc.property(
            baseVarsArb,
            (baseConfig) => {
                const varsWithBenchmark = buildVars(baseConfig, true);
                const varsWithoutBenchmark = buildVars(baseConfig, false);

                const outputWith = ejs.render(buildTemplate, varsWithBenchmark);
                const outputWithout = ejs.render(buildTemplate, varsWithoutBenchmark);

                assert.strictEqual(
                    outputWith,
                    outputWithout,
                    'do/build output must be identical regardless of includeBenchmark value'
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/build is benchmark-agnostic — no benchmark logic leaks into build');
    });

    it('Property 2: do/push output is identical with includeBenchmark true vs false', () => {
        /**
         * **Validates: Requirements 10.2**
         *
         * The do/push template must produce identical output whether
         * includeBenchmark is true or false. Benchmarking does not affect
         * the container push process.
         */
        console.log('  🧪 do/push: unchanged regardless of includeBenchmark');

        fc.assert(fc.property(
            baseVarsArb,
            (baseConfig) => {
                const varsWithBenchmark = buildVars(baseConfig, true);
                const varsWithoutBenchmark = buildVars(baseConfig, false);

                const outputWith = ejs.render(pushTemplate, varsWithBenchmark);
                const outputWithout = ejs.render(pushTemplate, varsWithoutBenchmark);

                assert.strictEqual(
                    outputWith,
                    outputWithout,
                    'do/push output must be identical regardless of includeBenchmark value'
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/push is benchmark-agnostic — no benchmark logic leaks into push');
    });

    it('Property 3: do/submit output is identical with includeBenchmark true vs false (codebuild only)', () => {
        /**
         * **Validates: Requirements 10.2**
         *
         * The do/submit template must produce identical output whether
         * includeBenchmark is true or false. Benchmarking does not affect
         * the CodeBuild submission process.
         */
        console.log('  🧪 do/submit: unchanged regardless of includeBenchmark (codebuild)');

        const codebuildVarsArb = baseVarsArb.map(config => ({
            ...config,
            buildTarget: 'codebuild'
        }));

        fc.assert(fc.property(
            codebuildVarsArb,
            (baseConfig) => {
                const varsWithBenchmark = buildVars(baseConfig, true);
                const varsWithoutBenchmark = buildVars(baseConfig, false);

                const outputWith = ejs.render(submitTemplate, varsWithBenchmark);
                const outputWithout = ejs.render(submitTemplate, varsWithoutBenchmark);

                assert.strictEqual(
                    outputWith,
                    outputWithout,
                    'do/submit output must be identical regardless of includeBenchmark value'
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/submit is benchmark-agnostic — no benchmark logic leaks into submit');
    });
});
