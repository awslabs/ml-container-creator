// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 7: Container image reuse across deployment targets
 *
 * For any valid generator configuration, if only the deploymentTarget is changed
 * between managed-inference and async-inference while all other parameters remain
 * the same, the generated Dockerfile, serving code files, and container build
 * scripts (do/build, do/push, do/submit) SHALL be identical.
 *
 * Validates: Requirements 11.1, 11.2, 11.3
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

// Load container build templates from do/ directory
const templatesDir = path.join(__dirname, '../../templates/do');

const buildTemplate = readFileSync(path.join(templatesDir, 'build'), 'utf8');
const pushTemplate = readFileSync(path.join(templatesDir, 'push'), 'utf8');
const submitTemplate = readFileSync(path.join(templatesDir, 'submit'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, vars);
}

/** Arbitrary for a base config shared between managed-inference and async-inference */
const baseConfigArb = fc.record({
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
    instanceType: fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'openai/gpt-oss-20b'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole', undefined),
    hfToken: fc.constantFrom('hf_test123', undefined),
    ngcApiKey: fc.constantFrom(undefined),
    inferenceAmiVersion: fc.constantFrom('1.0.0', undefined),
    modelFormat: fc.constantFrom('pkl', 'json', 'keras', undefined)
});

/**
 * Build full template variables from a base config and a specific deploymentTarget.
 */
function buildVars(baseConfig, deploymentTarget) {
    return {
        ...baseConfig,
        deploymentTarget,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        asyncS3OutputPath: undefined,
        asyncSnsSuccessTopic: undefined,
        asyncSnsErrorTopic: undefined,
        asyncMaxConcurrentInvocations: undefined
    };
}

describe('Feature: async-inference-endpoint, Property 7: Container image reuse across deployment targets', () => {
    before(() => {
        console.log('\n🔄 Starting Container Image Reuse Property Tests');
        console.log('📋 Testing: Requirements 11.1, 11.2, 11.3');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('do/build output is identical for managed-inference and async-inference with same base config', function () {
        /**
         * **Validates: Requirements 11.1, 11.2**
         *
         * The do/build template has no deployment-target-specific branching.
         * Rendering with managed-inference vs async-inference (same base config)
         * must produce character-for-character identical output.
         */
        this.timeout(30000);

        console.log('  🧪 do/build: identical output for managed-inference and async-inference');

        fc.assert(fc.property(
            baseConfigArb,
            (baseConfig) => {
                const managedVars = buildVars(baseConfig, 'managed-inference');
                const asyncVars = buildVars(baseConfig, 'async-inference');

                const managedOutput = renderTemplate(buildTemplate, managedVars);
                const asyncOutput = renderTemplate(buildTemplate, asyncVars);

                assert.strictEqual(
                    managedOutput,
                    asyncOutput,
                    'do/build output must be identical for managed-inference and async-inference'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/build is deployment-target-agnostic — container build is reused');
    });

    it('do/push output is identical for managed-inference and async-inference with same base config', function () {
        /**
         * **Validates: Requirements 11.1, 11.3**
         *
         * The do/push template has no deployment-target-specific branching.
         * Rendering with managed-inference vs async-inference (same base config)
         * must produce character-for-character identical output.
         */
        this.timeout(30000);

        console.log('  🧪 do/push: identical output for managed-inference and async-inference');

        fc.assert(fc.property(
            baseConfigArb,
            (baseConfig) => {
                const managedVars = buildVars(baseConfig, 'managed-inference');
                const asyncVars = buildVars(baseConfig, 'async-inference');

                const managedOutput = renderTemplate(pushTemplate, managedVars);
                const asyncOutput = renderTemplate(pushTemplate, asyncVars);

                assert.strictEqual(
                    managedOutput,
                    asyncOutput,
                    'do/push output must be identical for managed-inference and async-inference'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/push is deployment-target-agnostic — container push is reused');
    });

    it('do/submit output is identical for managed-inference and async-inference with same base config', function () {
        /**
         * **Validates: Requirements 11.1, 11.3**
         *
         * The do/submit template has no deployment-target-specific branching.
         * Rendering with managed-inference vs async-inference (same base config)
         * must produce character-for-character identical output.
         */
        this.timeout(30000);

        console.log('  🧪 do/submit: identical output for managed-inference and async-inference');

        fc.assert(fc.property(
            baseConfigArb,
            (baseConfig) => {
                const managedVars = buildVars(baseConfig, 'managed-inference');
                const asyncVars = buildVars(baseConfig, 'async-inference');

                const managedOutput = renderTemplate(submitTemplate, managedVars);
                const asyncOutput = renderTemplate(submitTemplate, asyncVars);

                assert.strictEqual(
                    managedOutput,
                    asyncOutput,
                    'do/submit output must be identical for managed-inference and async-inference'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/submit is deployment-target-agnostic — CodeBuild submit is reused');
    });
});
