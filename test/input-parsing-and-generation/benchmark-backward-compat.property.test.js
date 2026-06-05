// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property tests for benchmark backward compatibility.
 *
 * Verifies that when includeBenchmark is false (or undefined), no benchmark
 * content leaks into generated templates. Also verifies that do/deploy and
 * do/logs are unchanged regardless of the includeBenchmark value.
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4
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
const configTemplate = readFileSync(path.join(templatesDir, 'config'), 'utf8');
const cleanTemplatePath = path.join(templatesDir, 'clean');
const cleanTemplate = readFileSync(cleanTemplatePath, 'utf8');
const deployTemplate = readFileSync(path.join(templatesDir, 'deploy'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');

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
 * Arbitrary for includeBenchmark values that mean "disabled" (false or undefined).
 */
const disabledBenchmarkArb = fc.constantFrom(false, undefined);

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
 * Build full template variables from base config with benchmark disabled.
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
        enableLora: false,
        existingEndpointName: null,
        includeBenchmark,
        benchmarkConcurrency: 10,
        benchmarkInputTokensMean: 550,
        benchmarkOutputTokensMean: 150,
        benchmarkStreaming: true,
        benchmarkRequestCount: null,
        benchmarkS3OutputPath: ''
    };
}

describe('Feature: sagemaker-ai-benchmarking, Property: Backward compatibility when includeBenchmark is disabled', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🔒 Starting Benchmark Backward Compatibility Property Tests');
        console.log('📋 Testing: Requirements 10.1, 10.2, 10.3, 10.4');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('Property 1: no BENCHMARK_* variables in do/config when includeBenchmark is false or undefined', () => {
        /**
         * **Validates: Requirements 10.1**
         *
         * When includeBenchmark is false or undefined, the do/config template
         * must NOT contain any BENCHMARK_* variable exports.
         */
        console.log('  🧪 do/config: no BENCHMARK_* variables when benchmark disabled');

        fc.assert(fc.property(
            baseVarsArb,
            disabledBenchmarkArb,
            (baseConfig, includeBenchmark) => {
                const vars = buildVars(baseConfig, includeBenchmark);
                const output = ejs.render(configTemplate, vars);

                // Check that no uncommented export line contains BENCHMARK_
                const hasActiveExport = output.split('\n').some(line =>
                    line.trim().startsWith('export') && line.includes('BENCHMARK_')
                );
                assert.ok(
                    !hasActiveExport,
                    `do/config must NOT actively export BENCHMARK_* variables when includeBenchmark=${includeBenchmark}`
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/config contains no benchmark variables when feature is disabled');
    });

    it('Property 2: no benchmark) case in do/clean when includeBenchmark is false or undefined', () => {
        /**
         * **Validates: Requirements 10.2**
         *
         * When includeBenchmark is false or undefined, the do/clean template
         * must NOT contain the benchmark) case branch.
         */
        console.log('  🧪 do/clean: no benchmark) case when benchmark disabled');

        fc.assert(fc.property(
            baseVarsArb,
            disabledBenchmarkArb,
            (baseConfig, includeBenchmark) => {
                const vars = buildVars(baseConfig, includeBenchmark);
                const output = ejs.render(cleanTemplate, vars, { filename: cleanTemplatePath });

                assert.ok(
                    !output.includes('benchmark)'),
                    `do/clean must NOT contain benchmark) case when includeBenchmark=${includeBenchmark}`
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/clean contains no benchmark case when feature is disabled');
    });

    it('Property 3: do/deploy includes benchmark suggestion only when includeBenchmark is true', () => {
        /**
         * **Validates: Requirements 10.2, 10.3**
         *
         * The do/deploy template must include the benchmark suggestion line
         * only when includeBenchmark is true. When false or undefined, the
         * benchmark suggestion must not appear.
         */
        console.log('  🧪 do/deploy: benchmark suggestion conditional on includeBenchmark');

        fc.assert(fc.property(
            baseVarsArb,
            (baseConfig) => {
                const varsWithBenchmark = buildVars(baseConfig, true);
                const varsWithoutBenchmark = buildVars(baseConfig, false);

                const outputWith = ejs.render(deployTemplate, varsWithBenchmark, { filename: path.join(templatesDir, 'deploy') });
                const outputWithout = ejs.render(deployTemplate, varsWithoutBenchmark, { filename: path.join(templatesDir, 'deploy') });

                assert.ok(
                    outputWith.includes('./do/benchmark'),
                    'do/deploy must include ./do/benchmark suggestion when includeBenchmark is true'
                );
                assert.ok(
                    !outputWithout.includes('./do/benchmark'),
                    'do/deploy must NOT include ./do/benchmark suggestion when includeBenchmark is false'
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/deploy conditionally shows benchmark suggestion based on includeBenchmark');
    });

    it('Property 4: do/logs output is identical regardless of includeBenchmark value', () => {
        /**
         * **Validates: Requirements 10.2, 10.3**
         *
         * The do/logs template must produce identical output whether
         * includeBenchmark is true or false. Benchmarking is entirely
         * isolated to do/benchmark.
         */
        console.log('  🧪 do/logs: unchanged regardless of includeBenchmark');

        fc.assert(fc.property(
            baseVarsArb,
            (baseConfig) => {
                const varsWithBenchmark = buildVars(baseConfig, true);
                const varsWithoutBenchmark = buildVars(baseConfig, false);

                const outputWith = ejs.render(logsTemplate, varsWithBenchmark);
                const outputWithout = ejs.render(logsTemplate, varsWithoutBenchmark);

                assert.strictEqual(
                    outputWith,
                    outputWithout,
                    'do/logs output must be identical regardless of includeBenchmark value'
                );
            }
        ), { numRuns: 25 });

        console.log('    ✅ do/logs is benchmark-agnostic — no benchmark logic leaks into logs');
    });
});
