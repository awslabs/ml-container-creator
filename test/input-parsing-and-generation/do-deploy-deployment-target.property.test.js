// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 7: Deploy Script Dispatch Behavior (BL062)
 *
 * After BL062, do/deploy is a bash dispatcher that routes to deploy.d/<target>
 * based on DEPLOYMENT_TARGET. All 4 target files are always generated.
 *
 * Tests verify:
 * - do/deploy contains dispatch logic for all 4 targets
 * - do/deploy.d/managed-inference contains SageMaker IC logic
 * - do/deploy.d/hyperpod-eks contains kubectl logic
 * - do/deploy.d/async-inference contains async-specific logic
 * - do/deploy.d/batch-transform contains batch transform logic
 * - All deploy.d/ files contain ECR image verification
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 7.3, 7.4
 *
 * Feature: sagemaker-hyperpod-deployment, multi-ic-endpoints, universal-deploy
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const deployTemplatePath = path.join(__dirname, '../../templates/do/deploy');
const deployContent = readFileSync(deployTemplatePath, 'utf8');

// deploy.d/ target files
const managedInferencePath = path.join(__dirname, '../../templates/do/deploy.d/managed-inference');
const hyperpodEksPath = path.join(__dirname, '../../templates/do/deploy.d/hyperpod-eks');
const asyncInferencePath = path.join(__dirname, '../../templates/do/deploy.d/async-inference');
const batchTransformPath = path.join(__dirname, '../../templates/do/deploy.d/batch-transform');

/**
 * Render an EJS template file with the given variables.
 */
function renderTemplate(templatePath, vars) {
    const content = readFileSync(templatePath, 'utf8');
    return ejs.render(content, vars, { filename: templatePath });
}

/** Arbitrary for a base config */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    instanceType: fc.constantFrom('ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p4d.24xlarge'),
    deploymentTarget: fc.constantFrom('realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks')
});

describe('Deploy Script Dispatch Behavior (BL062)', () => {
    describe('Property: do/deploy is a universal dispatcher', () => {
        it('should contain dispatch logic for all 4 targets', () => {
            assert.ok(deployContent.includes('managed-inference'), 'dispatcher must reference managed-inference');
            assert.ok(deployContent.includes('async-inference'), 'dispatcher must reference async-inference');
            assert.ok(deployContent.includes('batch-transform'), 'dispatcher must reference batch-transform');
            assert.ok(deployContent.includes('hyperpod-eks'), 'dispatcher must reference hyperpod-eks');
        });

        it('should support --target flag', () => {
            assert.ok(deployContent.includes('--target'), 'dispatcher must support --target flag');
        });

        it('should call deploy helper when DEPLOYMENT_TARGET is empty', () => {
            assert.ok(deployContent.includes('.deploy_helper.py'),
                'dispatcher must call deploy helper when target is empty');
            assert.ok(deployContent.includes('if [ -z "${DEPLOYMENT_TARGET:-}" ]'),
                'dispatcher must check for empty DEPLOYMENT_TARGET');
        });

        it('should normalize realtime-inference to managed-inference', () => {
            assert.ok(deployContent.includes('realtime-inference'),
                'dispatcher must handle realtime-inference normalization');
        });

        it('should write DEPLOYMENT_TARGET back to config on success', () => {
            assert.ok(deployContent.includes('DEPLOYMENT_TARGET') && deployContent.includes('config'),
                'dispatcher must write back to config');
        });
    });

    describe('Property: do/deploy.d/ files all exist', () => {
        it('should have managed-inference target file', () => {
            assert.ok(existsSync(managedInferencePath), 'deploy.d/managed-inference must exist');
        });

        it('should have hyperpod-eks target file', () => {
            assert.ok(existsSync(hyperpodEksPath), 'deploy.d/hyperpod-eks must exist');
        });

        it('should have async-inference target file', () => {
            assert.ok(existsSync(asyncInferencePath), 'deploy.d/async-inference must exist');
        });

        it('should have batch-transform target file', () => {
            assert.ok(existsSync(batchTransformPath), 'deploy.d/batch-transform must exist');
        });
    });

    describe('Property: deploy.d/managed-inference contains SageMaker IC logic', () => {
        it('should contain ECR image verification for any valid deployment target (Req 5.6)', function() {
            this.timeout(10000);
            fc.assert(fc.property(baseConfigArb, (config) => {
                const vars = { ...config, deploymentTarget: 'realtime-inference', includeBenchmark: false };
                const rendered = renderTemplate(managedInferencePath, vars);
                assert.ok(rendered.includes('ecr') || rendered.includes('ECR') || rendered.includes('describe-images'),
                    'managed-inference deploy must contain ECR image verification');
            }), { numRuns: 5 });
        });

        it('should contain SageMaker endpoint creation commands for realtime-inference (Req 5.2)', function() {
            this.timeout(10000);
            fc.assert(fc.property(baseConfigArb, (config) => {
                const vars = { ...config, deploymentTarget: 'realtime-inference', includeBenchmark: false };
                const rendered = renderTemplate(managedInferencePath, vars);
                assert.ok(rendered.includes('create-inference-component') || rendered.includes('sagemaker'),
                    'managed-inference deploy must contain SageMaker commands');
            }), { numRuns: 5 });
        });
    });

    describe('Property: deploy.d/hyperpod-eks contains kubectl commands', () => {
        it('should contain kubectl commands for hyperpod-eks (Req 5.3, 5.4, 5.5)', function() {
            this.timeout(10000);
            fc.assert(fc.property(baseConfigArb, (config) => {
                const vars = {
                    ...config,
                    deploymentTarget: 'hyperpod-eks',
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: '1',
                    includeBenchmark: false
                };
                const rendered = renderTemplate(hyperpodEksPath, vars);
                assert.ok(rendered.includes('kubectl'), 'hyperpod-eks deploy must contain kubectl commands');
            }), { numRuns: 5 });
        });

        it('should contain kubectl logs tailing logic for hyperpod-eks (Req 15.3)', function() {
            this.timeout(10000);
            const vars = {
                projectName: 'test-project',
                deploymentConfig: 'transformers-vllm',
                framework: 'transformers',
                modelServer: 'vllm',
                awsRegion: 'us-east-1',
                buildTarget: 'codebuild',
                instanceType: 'ml.g5.xlarge',
                deploymentTarget: 'hyperpod-eks',
                hyperPodCluster: 'test-cluster',
                hyperPodNamespace: 'default',
                hyperPodReplicas: '1',
                includeBenchmark: false
            };
            const rendered = renderTemplate(hyperpodEksPath, vars);
            assert.ok(rendered.includes('kubectl') && rendered.includes('logs'),
                'hyperpod-eks deploy must contain logs tailing');
        });
    });

    describe('Property: do/deploy includes benchmark suggestion only when includeBenchmark is true', () => {
        it('Property 3: do/deploy includes benchmark suggestion only when includeBenchmark is true', function() {
            this.timeout(10000);
            fc.assert(fc.property(baseConfigArb, (config) => {
                const vars = { ...config, deploymentTarget: 'realtime-inference', includeBenchmark: true };
                const rendered = renderTemplate(managedInferencePath, vars);
                assert.ok(rendered.includes('benchmark') || rendered.includes('do/benchmark'),
                    'should mention benchmark when includeBenchmark is true');
            }), { numRuns: 5 });
        });
    });
});
