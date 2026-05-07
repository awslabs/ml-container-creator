// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 7: Deploy Script Content by Deployment Target
 *
 * For any valid configuration, when deploymentTarget equals managed-inference,
 * the generated do/deploy script must contain SageMaker inference component
 * commands (create-endpoint, create-inference-component) and must
 * not contain kubectl commands. When deploymentTarget equals hyperpod-eks,
 * the generated do/deploy script must contain kubectl commands
 * (describe-cluster, eks update-kubeconfig, kubectl apply from hyperpod/) and must not contain
 * SageMaker endpoint creation commands. For both targets, the script must
 * contain ECR image verification logic.
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6
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

const templatePath = path.join(__dirname, '../../templates/do/deploy');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/deploy template with the given variables.
 */
function renderDeploy(vars) {
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

describe('Property 7: Deploy Script Content by Deployment Target', () => {
    before(() => {
        console.log('\n🚀 Starting Deploy Script Content by Deployment Target Property Tests');
        console.log('📋 Testing: Requirements 5.2, 5.3, 5.4, 5.5, 5.6');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should contain ECR image verification for any valid deployment target (Req 5.6)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.6: ECR image verification present for both targets');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                assert.ok(
                    output.includes('ecr describe-images'),
                    'Output must contain ECR image verification (ecr describe-images)'
                );
                assert.ok(
                    output.includes('ECR image not found'),
                    'Output must contain ECR image not found error message'
                );
                assert.ok(
                    output.includes('ECR image found'),
                    'Output must contain ECR image found success message'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ ECR image verification present for both targets');
    });

    it('should contain SageMaker endpoint creation commands for managed-inference (Req 5.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.2: SageMaker endpoint creation logic for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
            fc.option(fc.constant('1.0.0'), { nil: undefined }),
            (base, instanceType, inferenceAmiVersion) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    inferenceAmiVersion,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must contain SageMaker inference component commands
                assert.ok(
                    output.includes('sagemaker create-endpoint-config'),
                    'managed-inference must contain create-endpoint-config command'
                );
                assert.ok(
                    output.includes('sagemaker create-endpoint'),
                    'managed-inference must contain create-endpoint command'
                );
                assert.ok(
                    output.includes('sagemaker create-inference-component'),
                    'managed-inference must contain create-inference-component command'
                );
                assert.ok(
                    output.includes('sagemaker wait inference-component-in-service'),
                    'managed-inference must contain wait inference-component-in-service command'
                );

                // Must NOT contain kubectl commands
                assert.ok(
                    !output.includes('kubectl'),
                    'managed-inference must NOT contain kubectl commands'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'managed-inference must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ SageMaker endpoint creation commands present for managed-inference');
    });

    it('should contain kubectl commands for hyperpod-eks (Req 5.3, 5.4, 5.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.3/5.4/5.5: kubectl deployment logic for hyperpod-eks');

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
                    inferenceAmiVersion: undefined,
                    ...hpVars,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Req 5.4: Must retrieve kubeconfig
                assert.ok(
                    output.includes('describe-cluster'),
                    'hyperpod-eks must contain describe-cluster command'
                );
                assert.ok(
                    output.includes('eks update-kubeconfig'),
                    'hyperpod-eks must contain eks update-kubeconfig command'
                );

                // Req 5.5: Must apply manifests from hyperpod/ directory
                assert.ok(
                    output.includes('kubectl apply') && output.includes('hyperpod/'),
                    'hyperpod-eks must contain kubectl apply from hyperpod/ directory'
                );

                // Must contain rollout status check
                assert.ok(
                    output.includes('kubectl rollout status'),
                    'hyperpod-eks must contain kubectl rollout status command'
                );

                // Must contain namespace creation
                assert.ok(
                    output.includes('kubectl create namespace'),
                    'hyperpod-eks must contain namespace creation'
                );

                // Must NOT contain SageMaker inference component commands
                assert.ok(
                    !output.includes('sagemaker create-endpoint-config'),
                    'hyperpod-eks must NOT contain create-endpoint-config command'
                );
                assert.ok(
                    !output.includes('sagemaker create-inference-component'),
                    'hyperpod-eks must NOT contain create-inference-component command'
                );
                assert.ok(
                    !output.includes('sagemaker wait inference-component-in-service'),
                    'hyperpod-eks must NOT contain wait inference-component-in-service command'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubectl commands present for hyperpod-eks');
    });

    it('should include IAM permission error handling for hyperpod-eks (Req 14.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 14.2: IAM permission error handling in hyperpod-eks deploy');

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
                    inferenceAmiVersion: undefined,
                    ...hpVars,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must contain IAM permission error hints
                assert.ok(
                    output.includes('IAM') || output.includes('permission'),
                    'hyperpod-eks must contain IAM permission error guidance'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ IAM permission error handling present');
    });

    it('should include kubectl failure error handling for hyperpod-eks (Req 14.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 14.3: kubectl apply failure error handling');

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
                    inferenceAmiVersion: undefined,
                    ...hpVars,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must contain kubectl failure error messages with node capacity suggestions
                assert.ok(
                    output.includes('Failed to apply Kubernetes manifests') ||
                    output.includes('node capacity'),
                    'hyperpod-eks must contain kubectl apply failure guidance'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubectl failure error handling present');
    });

    it('should include FSx PVC error hints when fsxVolumeHandle is provided (Req 14.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 14.3: FSx PVC error hints when fsxVolumeHandle provided');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constantFrom('default', 'ml-inference'),
                hyperPodReplicas: fc.integer({ min: 1, max: 4 })
            }),
            fc.option(fc.stringMatching(/^fs-[a-f0-9]{17}$/), { nil: undefined }),
            (base, hpVars, fsxVolumeHandle) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    inferenceAmiVersion: undefined,
                    ...hpVars,
                    fsxVolumeHandle
                };

                const output = renderDeploy(vars);

                if (fsxVolumeHandle) {
                    assert.ok(
                        output.includes('FSx CSI driver') || output.includes('PVC binding'),
                        'When fsxVolumeHandle is provided, deploy must include FSx/PVC error hints'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ FSx PVC error hints conditional on fsxVolumeHandle');
    });

    it('should show deployment-target-specific header info', function () {
        this.timeout(30000);

        console.log('  🧪 Deploy script header shows target-specific info');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Both targets should show deployment target
                assert.ok(
                    output.includes('Deployment target: ${DEPLOYMENT_TARGET}'),
                    'Deploy script must show deployment target'
                );

                if (deploymentTarget === 'managed-inference') {
                    assert.ok(
                        output.includes('Instance type: ${INSTANCE_TYPE}'),
                        'managed-inference header must show instance type'
                    );
                } else {
                    assert.ok(
                        output.includes('HyperPod cluster: ${HYPERPOD_CLUSTER_NAME}'),
                        'hyperpod-eks header must show cluster name'
                    );
                    assert.ok(
                        output.includes('Namespace: ${HYPERPOD_NAMESPACE}'),
                        'hyperpod-eks header must show namespace'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Deployment-target-specific header info correct');
    });
});
