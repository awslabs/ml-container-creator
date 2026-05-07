// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 8: Clean Script Content by Deployment Target
 *
 * For any valid configuration, when deploymentTarget equals managed-inference,
 * the generated do/clean script must contain the `endpoint` cleanup target
 * with SageMaker deletion commands (delete-inference-component, delete-endpoint)
 * and must not contain kubectl commands. When deploymentTarget
 * equals hyperpod-eks, the generated do/clean script must contain the `hyperpod`
 * cleanup target with kubectl delete commands and must not contain SageMaker
 * endpoint deletion commands. For both targets, the script must support
 * `local`, `ecr`, `codebuild`, and `all` cleanup targets.
 *
 * Validates: Requirements 6.2, 6.3, 6.4, 6.5
 *
 * Feature: sagemaker-hyperpod-deployment
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

const templatePath = path.join(__dirname, '../../templates/do/clean');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/clean template with the given variables.
 */
function renderClean(vars) {
    return ejs.render(templateContent, vars);
}

/** Arbitrary for a base config shared by both deployment targets */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild')
});

describe('Property 8: Clean Script Content by Deployment Target', () => {
    before(() => {
        console.log('\n🧹 Starting Clean Script Content by Deployment Target Property Tests');
        console.log('📋 Testing: Requirements 6.2, 6.3, 6.4, 6.5');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should support local, ecr, codebuild cleanup targets for any deployment target (Req 6.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.4: local, ecr, codebuild targets present for both deployment targets');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1
                };

                const output = renderClean(vars);

                // Must contain local cleanup target
                assert.ok(
                    output.includes('clean_local'),
                    'Output must contain clean_local function'
                );
                assert.ok(
                    output.includes('local)'),
                    'Output must contain local case in switch'
                );

                // Must contain ecr cleanup target
                assert.ok(
                    output.includes('clean_ecr'),
                    'Output must contain clean_ecr function'
                );
                assert.ok(
                    output.includes('ecr)'),
                    'Output must contain ecr case in switch'
                );

                // Must contain codebuild cleanup target
                assert.ok(
                    output.includes('clean_codebuild'),
                    'Output must contain clean_codebuild function'
                );
                assert.ok(
                    output.includes('codebuild)'),
                    'Output must contain codebuild case in switch'
                );

                // Must contain all cleanup target
                assert.ok(
                    output.includes('all)'),
                    'Output must contain all case in switch'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ local, ecr, codebuild targets present for both deployment targets');
    });

    it('should contain SageMaker endpoint cleanup for managed-inference (Req 6.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.2: SageMaker endpoint cleanup logic for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined
                };

                const output = renderClean(vars);

                // Must contain endpoint cleanup target
                assert.ok(
                    output.includes('endpoint)'),
                    'managed-inference must contain endpoint case in switch'
                );
                assert.ok(
                    output.includes('clean_endpoint'),
                    'managed-inference must contain clean_endpoint function'
                );

                // Must contain SageMaker deletion commands
                assert.ok(
                    output.includes('sagemaker delete-endpoint'),
                    'managed-inference must contain delete-endpoint command'
                );
                assert.ok(
                    output.includes('sagemaker delete-endpoint-config'),
                    'managed-inference must contain delete-endpoint-config command'
                );
                assert.ok(
                    output.includes('sagemaker delete-inference-component'),
                    'managed-inference must contain delete-inference-component command'
                );

                // Must NOT contain kubectl commands
                assert.ok(
                    !output.includes('kubectl delete'),
                    'managed-inference must NOT contain kubectl delete commands'
                );
                assert.ok(
                    !output.includes('clean_hyperpod'),
                    'managed-inference must NOT contain clean_hyperpod function'
                );
                assert.ok(
                    !output.includes('hyperpod)'),
                    'managed-inference must NOT contain hyperpod case in switch'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ SageMaker endpoint cleanup present for managed-inference');
    });

    it('should contain kubectl cleanup for hyperpod-eks (Req 6.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.3: kubectl cleanup logic for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
                hyperPodReplicas: fc.integer({ min: 1, max: 10 })
            }),
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                const output = renderClean(vars);

                // Must contain hyperpod cleanup target
                assert.ok(
                    output.includes('hyperpod)'),
                    'hyperpod-eks must contain hyperpod case in switch'
                );
                assert.ok(
                    output.includes('clean_hyperpod'),
                    'hyperpod-eks must contain clean_hyperpod function'
                );

                // Must contain kubectl delete command
                assert.ok(
                    output.includes('kubectl delete') && output.includes('hyperpod/'),
                    'hyperpod-eks must contain kubectl delete from hyperpod/ directory'
                );

                // Must contain kubeconfig retrieval
                assert.ok(
                    output.includes('describe-cluster'),
                    'hyperpod-eks must contain describe-cluster command'
                );

                // Must NOT contain SageMaker endpoint deletion commands
                assert.ok(
                    !output.includes('sagemaker delete-endpoint'),
                    'hyperpod-eks must NOT contain delete-endpoint command'
                );
                assert.ok(
                    !output.includes('clean_endpoint'),
                    'hyperpod-eks must NOT contain clean_endpoint function'
                );
                assert.ok(
                    !output.includes('endpoint)'),
                    'hyperpod-eks must NOT contain endpoint case in switch'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubectl cleanup present for hyperpod-eks');
    });

    it('should include appropriate cleanup in all target for managed-inference (Req 6.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.5: all target includes endpoint cleanup for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            (base) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType: 'ml.m5.xlarge',
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined
                };

                const output = renderClean(vars);

                // The all target should call clean_endpoint
                // Look for the pattern in the all case block
                const allCaseMatch = output.match(/all\)([\s\S]*?);;/);
                assert.ok(allCaseMatch, 'Output must contain all case block');

                const allCaseContent = allCaseMatch[1];
                assert.ok(
                    allCaseContent.includes('clean_endpoint'),
                    'all target must call clean_endpoint for managed-inference'
                );
                assert.ok(
                    allCaseContent.includes('SageMaker resources'),
                    'all target must reference SageMaker resources for managed-inference'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ all target includes endpoint cleanup for managed-inference');
    });

    it('should include appropriate cleanup in all target for hyperpod-eks (Req 6.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.5: all target includes hyperpod cleanup for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constantFrom('default', 'ml-inference'),
                hyperPodReplicas: fc.integer({ min: 1, max: 4 })
            }),
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                const output = renderClean(vars);

                // The all target should call clean_hyperpod
                const allCaseMatch = output.match(/all\)([\s\S]*?);;/);
                assert.ok(allCaseMatch, 'Output must contain all case block');

                const allCaseContent = allCaseMatch[1];
                assert.ok(
                    allCaseContent.includes('clean_hyperpod'),
                    'all target must call clean_hyperpod for hyperpod-eks'
                );
                assert.ok(
                    allCaseContent.includes('HyperPod EKS resources'),
                    'all target must reference HyperPod EKS resources for hyperpod-eks'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ all target includes hyperpod cleanup for hyperpod-eks');
    });

    it('should show deployment-target-specific usage info', function () {
        this.timeout(30000);

        console.log('  🧪 Usage info shows target-specific cleanup options');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1
                };

                const output = renderClean(vars);

                if (deploymentTarget === 'managed-inference') {
                    assert.ok(
                        output.includes('endpoint  - Delete SageMaker endpoint'),
                        'managed-inference usage must show endpoint cleanup option'
                    );
                    assert.ok(
                        output.includes('./do/clean endpoint'),
                        'managed-inference examples must show endpoint cleanup'
                    );
                } else {
                    assert.ok(
                        output.includes('hyperpod  - Delete HyperPod EKS deployment'),
                        'hyperpod-eks usage must show hyperpod cleanup option'
                    );
                    assert.ok(
                        output.includes('./do/clean hyperpod'),
                        'hyperpod-eks examples must show hyperpod cleanup'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Deployment-target-specific usage info correct');
    });
});
