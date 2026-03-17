// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 16: Test Script Content by Deployment Target
 *
 * For any valid configuration, when deploymentTarget equals managed-inference,
 * the generated do/test script must support local and SageMaker endpoint test
 * modes using aws sagemaker-runtime invoke-endpoint. When deploymentTarget
 * equals hyperpod-eks, the generated do/test script must support local and
 * hyperpod test modes, where the hyperpod mode uses kubectl port-forward to
 * test the deployed service via curl.
 *
 * Validates: Requirements 16.2, 16.3, 16.4
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

const templatePath = path.join(__dirname, '../../generators/app/templates/do/test');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/test template with the given variables.
 */
function renderTest(vars) {
    return ejs.render(templateContent, vars);
}

/** Arbitrary for a base config shared by both deployment targets */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1')
});

describe('Property 16: Test Script Content by Deployment Target', () => {
    before(() => {
        console.log('\n🧪 Starting Test Script Content by Deployment Target Property Tests');
        console.log('📋 Testing: Requirements 16.2, 16.3, 16.4');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should support local and SageMaker endpoint test modes for managed-inference (Req 16.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 16.2: local + SageMaker endpoint test modes for managed-inference');

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

                const output = renderTest(vars);

                // Must support local test mode
                assert.ok(
                    output.includes('localhost:8080'),
                    'managed-inference must support local testing at localhost:8080'
                );
                assert.ok(
                    output.includes('Testing local container'),
                    'managed-inference must have local container test message'
                );

                // Must support SageMaker endpoint test mode
                assert.ok(
                    output.includes('sagemaker-runtime invoke-endpoint'),
                    'managed-inference must use aws sagemaker-runtime invoke-endpoint'
                );
                assert.ok(
                    output.includes('Testing SageMaker endpoint'),
                    'managed-inference must have SageMaker endpoint test message'
                );
                assert.ok(
                    output.includes('describe-endpoint'),
                    'managed-inference must check endpoint status via describe-endpoint'
                );

                // Must NOT contain kubectl commands
                assert.ok(
                    !output.includes('kubectl port-forward'),
                    'managed-inference must NOT contain kubectl port-forward'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'managed-inference must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ local + SageMaker endpoint test modes present for managed-inference');
    });

    it('should support local and hyperpod test modes for hyperpod-eks (Req 16.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 16.3: local + hyperpod test modes for hyperpod-eks');

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

                const output = renderTest(vars);

                // Must support local test mode
                assert.ok(
                    output.includes('localhost:8080'),
                    'hyperpod-eks must support local testing at localhost:8080'
                );
                assert.ok(
                    output.includes('Testing local container'),
                    'hyperpod-eks must have local container test message'
                );

                // Must support hyperpod test mode with kubectl port-forward
                assert.ok(
                    output.includes('kubectl port-forward'),
                    'hyperpod-eks must use kubectl port-forward'
                );
                assert.ok(
                    output.includes('svc/${PROJECT_NAME}'),
                    'hyperpod-eks must port-forward to svc/${PROJECT_NAME}'
                );
                assert.ok(
                    output.includes('${LOCAL_PORT}:8080') || output.includes('8080:8080'),
                    'hyperpod-eks must forward port 8080:8080'
                );
                assert.ok(
                    output.includes('Testing HyperPod EKS deployment'),
                    'hyperpod-eks must have HyperPod test message'
                );

                // Must NOT contain SageMaker endpoint commands
                assert.ok(
                    !output.includes('sagemaker-runtime invoke-endpoint'),
                    'hyperpod-eks must NOT contain sagemaker-runtime invoke-endpoint'
                );
                assert.ok(
                    !output.includes('describe-endpoint'),
                    'hyperpod-eks must NOT contain describe-endpoint'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ local + hyperpod test modes present for hyperpod-eks');
    });

    it('should use kubectl port-forward and curl for hyperpod test mode (Req 16.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 16.4: kubectl port-forward + curl for hyperpod test mode');

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

                const output = renderTest(vars);

                // Must retrieve kubeconfig before port-forward
                assert.ok(
                    output.includes('describe-cluster'),
                    'hyperpod-eks must retrieve cluster info via describe-cluster'
                );
                assert.ok(
                    output.includes('eks update-kubeconfig'),
                    'hyperpod-eks must configure kubectl via eks update-kubeconfig'
                );

                // kubeconfig retrieval must come BEFORE port-forward
                const kubeconfigIndex = output.indexOf('eks update-kubeconfig');
                const portForwardIndex = output.indexOf('kubectl port-forward');
                assert.ok(
                    kubeconfigIndex < portForwardIndex,
                    'eks update-kubeconfig must appear before kubectl port-forward'
                );

                // Must test /ping endpoint via curl
                assert.ok(
                    output.includes('/ping'),
                    'hyperpod-eks must test /ping endpoint'
                );

                // Must test /invocations endpoint via curl
                assert.ok(
                    output.includes('/invocations'),
                    'hyperpod-eks must test /invocations endpoint'
                );

                // Must use curl for testing
                assert.ok(
                    output.includes('curl'),
                    'hyperpod-eks must use curl for testing'
                );

                // Must include cleanup trap for port-forward
                assert.ok(
                    output.includes('trap'),
                    'hyperpod-eks must include trap for cleanup'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubectl port-forward + curl verified for hyperpod test mode');
    });

    it('should use framework-specific test payloads for both deployment targets', function () {
        this.timeout(30000);

        console.log('  🧪 Framework-specific test payloads for both targets');

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

                const output = renderTest(vars);

                // Must have framework-specific payload logic
                assert.ok(
                    output.includes('case "${FRAMEWORK}"'),
                    'Output must contain framework case statement'
                );

                // Must handle sklearn/xgboost with instances array
                assert.ok(
                    output.includes('sklearn|xgboost)'),
                    'Output must handle sklearn and xgboost frameworks'
                );
                assert.ok(
                    output.includes('"instances"'),
                    'Output must use instances array for traditional ML'
                );

                // Must handle tensorflow
                assert.ok(
                    output.includes('tensorflow)'),
                    'Output must handle tensorflow framework'
                );

                // Must handle transformers with model server variants
                assert.ok(
                    output.includes('transformers)'),
                    'Output must handle transformers framework'
                );
                assert.ok(
                    output.includes('vllm|sglang)'),
                    'Output must handle vllm and sglang model servers'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Framework-specific test payloads verified');
    });

    it('should show deployment-target-specific usage info', function () {
        this.timeout(30000);

        console.log('  🧪 Usage info shows target-specific test options');

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

                const output = renderTest(vars);

                if (deploymentTarget === 'managed-inference') {
                    // managed-inference uses endpoint name as argument
                    assert.ok(
                        output.includes('ENDPOINT_NAME="${1:-'),
                        'managed-inference must parse endpoint name from argument'
                    );
                    assert.ok(
                        output.includes('Deploy to SageMaker'),
                        'managed-inference next steps must mention SageMaker'
                    );
                } else {
                    // hyperpod-eks uses local|hyperpod as argument
                    assert.ok(
                        output.includes('TEST_TARGET="${1:-'),
                        'hyperpod-eks must parse test target from argument'
                    );
                    assert.ok(
                        output.includes('local|hyperpod'),
                        'hyperpod-eks usage must show local|hyperpod options'
                    );
                    assert.ok(
                        output.includes('Deploy to HyperPod'),
                        'hyperpod-eks next steps must mention HyperPod'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Deployment-target-specific usage info correct');
    });

    it('should produce mutually exclusive content for each deployment target', function () {
        this.timeout(30000);

        console.log('  🧪 Mutual exclusivity: each target produces only its own content');

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

                const output = renderTest(vars);

                if (deploymentTarget === 'managed-inference') {
                    assert.ok(
                        output.includes('sagemaker-runtime invoke-endpoint'),
                        'managed-inference must have invoke-endpoint'
                    );
                    assert.ok(
                        !output.includes('kubectl port-forward'),
                        'managed-inference must NOT have kubectl port-forward'
                    );
                } else {
                    assert.ok(
                        output.includes('kubectl port-forward'),
                        'hyperpod-eks must have kubectl port-forward'
                    );
                    assert.ok(
                        !output.includes('sagemaker-runtime invoke-endpoint'),
                        'hyperpod-eks must NOT have invoke-endpoint'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Mutual exclusivity verified');
    });
});
