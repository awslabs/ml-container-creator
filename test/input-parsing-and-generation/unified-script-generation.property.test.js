// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 6: Unified Script Generation (BL062)
 *
 * After BL062, do/deploy and do/clean are bash dispatchers.
 * Target-specific content lives in deploy.d/ and clean.d/.
 * All 4 target files are always generated.
 *
 * Validates: Requirements 5.1, 6.1, 15.1, 16.1
 *
 * Feature: sagemaker-hyperpod-deployment, universal-deploy
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.join(__dirname, '../../templates/do');

const deployTemplate = readFileSync(path.join(templatesDir, 'deploy'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');
const testTemplate = readFileSync(path.join(templatesDir, 'test'), 'utf8');

// deploy.d/ target-specific templates
const managedDeployTemplate = readFileSync(path.join(templatesDir, 'deploy.d/realtime-inference'), 'utf8');
const hyperpodDeployTemplate = readFileSync(path.join(templatesDir, 'deploy.d/hyperpod-eks'), 'utf8');

// clean.d/ target-specific templates
const managedCleanTemplate = readFileSync(path.join(templatesDir, 'clean.d/realtime-inference'), 'utf8');
const hyperpodCleanTemplate = readFileSync(path.join(templatesDir, 'clean.d/hyperpod-eks'), 'utf8');

function renderTemplate(template, vars, templateName) {
    return ejs.render(template, vars, { filename: path.join(templatesDir, templateName || 'unknown') });
}

const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole', undefined),
    inferenceAmiVersion: fc.constantFrom('1.0.0', undefined)
});

const hyperPodConfigArb = fc.record({
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    fsxVolumeHandle: fc.option(fc.stringMatching(/^fs-[a-f0-9]{17}$/), { nil: undefined })
});

describe('Property 6: Unified Script Generation (BL062)', () => {
    before(() => {
        console.log('\n📜 Starting Unified Script Generation Property Tests (BL062)');
        console.log('📋 Testing: Requirements 5.1, 6.1, 15.1, 16.1');
    });

    it('should generate exactly one do/deploy dispatcher script (Req 5.1)', function () {
        this.timeout(30000);

        // do/deploy is now a plain bash dispatcher — no EJS rendering needed
        assert.ok(deployTemplate.startsWith('#!/bin/bash'), 'do/deploy must start with bash shebang');
        assert.ok(deployTemplate.length > 100, 'do/deploy must contain substantial content');
        assert.ok(deployTemplate.includes('managed-inference'), 'do/deploy must reference managed-inference');
        assert.ok(deployTemplate.includes('hyperpod-eks'), 'do/deploy must reference hyperpod-eks');
        assert.ok(deployTemplate.includes('DEPLOYMENT_TARGET'), 'do/deploy must use DEPLOYMENT_TARGET');
    });

    it('should generate exactly one do/deploy script for realtime-inference (Req 5.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    includeBenchmark: false
                };

                const output = renderTemplate(managedDeployTemplate, vars, 'deploy.d/realtime-inference');
                assert.ok(output.startsWith('#!/bin/bash'), 'deploy.d/realtime-inference must start with shebang');
                assert.ok(output.length > 100, 'deploy.d/realtime-inference must contain substantial content');
                assert.ok(
                    output.includes('create-inference-component') || output.includes('SageMaker') || output.includes('sagemaker'),
                    'realtime-inference deploy must contain SageMaker logic'
                );
            }
        ), { numRuns: 20 });
    });

    it('should generate exactly one do/deploy script for hyperpod-eks (Req 5.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    includeBenchmark: false,
                    ...hpVars
                };

                const output = renderTemplate(hyperpodDeployTemplate, vars, 'deploy.d/hyperpod-eks');
                assert.ok(output.startsWith('#!/bin/bash'), 'deploy.d/hyperpod-eks must start with shebang');
                assert.ok(output.length > 100, 'deploy.d/hyperpod-eks must contain substantial content');
                assert.ok(output.includes('kubectl'), 'hyperpod-eks deploy must contain kubectl logic');
            }
        ), { numRuns: 20 });
    });

    it('should generate exactly one do/clean script for realtime-inference (Req 6.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    includeBenchmark: false
                };

                const output = renderTemplate(managedCleanTemplate, vars, 'clean.d/realtime-inference');
                assert.ok(output.startsWith('#!/bin/bash'), 'clean.d/realtime-inference must start with shebang');
                assert.ok(output.length > 100, 'clean.d/realtime-inference must contain substantial content');
                assert.ok(
                    output.includes('endpoint') || output.includes('sagemaker') || output.includes('delete'),
                    'realtime-inference clean must contain endpoint cleanup'
                );
            }
        ), { numRuns: 20 });
    });

    it('should generate exactly one do/clean script for hyperpod-eks (Req 6.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    includeBenchmark: false,
                    ...hpVars
                };

                const output = renderTemplate(hyperpodCleanTemplate, vars, 'clean.d/hyperpod-eks');
                assert.ok(output.startsWith('#!/bin/bash'), 'clean.d/hyperpod-eks must start with shebang');
                assert.ok(output.length > 100, 'clean.d/hyperpod-eks must contain substantial content');
                assert.ok(output.includes('kubectl'), 'hyperpod-eks clean must contain kubectl logic');
            }
        ), { numRuns: 20 });
    });

    it('should generate do/logs for any target (Req 15.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('realtime-inference', 'hyperpod-eks'),
            (base, target) => {
                const vars = {
                    ...base,
                    deploymentTarget: target,
                    instanceType: 'ml.g5.xlarge',
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: '1',
                    fsxVolumeHandle: undefined,
                    includeBenchmark: false
                };

                const output = renderTemplate(logsTemplate, vars, 'logs');
                assert.ok(output.startsWith('#!/bin/bash'), 'do/logs must start with shebang');
                assert.ok(output.length > 100, 'do/logs must contain substantial content');
            }
        ), { numRuns: 10 });
    });

    it('should generate do/test for any target (Req 16.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            (base) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType: 'ml.g5.xlarge',
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    includeBenchmark: false
                };

                const output = renderTemplate(testTemplate, vars, 'test');
                assert.ok(output.startsWith('#!/bin/bash'), 'do/test must start with shebang');
                assert.ok(output.length > 100, 'do/test must contain substantial content');
            }
        ), { numRuns: 10 });
    });

    it('should have all 4 deploy.d/ target files', () => {
        assert.ok(existsSync(path.join(templatesDir, 'deploy.d/realtime-inference')));
        assert.ok(existsSync(path.join(templatesDir, 'deploy.d/async-inference')));
        assert.ok(existsSync(path.join(templatesDir, 'deploy.d/batch-transform')));
        assert.ok(existsSync(path.join(templatesDir, 'deploy.d/hyperpod-eks')));
    });

    it('should have all 4 clean.d/ target files', () => {
        assert.ok(existsSync(path.join(templatesDir, 'clean.d/realtime-inference')));
        assert.ok(existsSync(path.join(templatesDir, 'clean.d/async-inference')));
        assert.ok(existsSync(path.join(templatesDir, 'clean.d/batch-transform')));
        assert.ok(existsSync(path.join(templatesDir, 'clean.d/hyperpod-eks')));
    });
});
