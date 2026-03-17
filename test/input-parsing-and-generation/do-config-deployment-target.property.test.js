// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 11: do/config Deployment-Target-Specific Variables
 *
 * For any valid configuration, the generated do/config must contain
 * BUILD_TARGET and DEPLOYMENT_TARGET variables. When deploymentTarget
 * equals managed-inference, do/config must contain INSTANCE_TYPE.
 * When deploymentTarget equals hyperpod-eks, do/config must contain
 * HYPERPOD_CLUSTER_NAME, HYPERPOD_NAMESPACE, and HYPERPOD_REPLICAS.
 * When fsxVolumeHandle is provided with hyperpod-eks, do/config must
 * also contain FSX_VOLUME_HANDLE.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
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

const templatePath = path.join(__dirname, '../../generators/app/templates/do/config');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/config template with the given variables.
 */
function renderConfig(vars) {
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
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
    roleArn: fc.option(fc.constant('arn:aws:iam::123456789012:role/SageMakerRole'), { nil: undefined }),
    modelFormat: fc.option(fc.constantFrom('pkl', 'joblib', 'json'), { nil: undefined }),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b', 'gpt2', 'bert-base-uncased'),
    hfToken: fc.option(fc.constant('hf_testtoken123'), { nil: undefined }),
    ngcApiKey: fc.option(fc.constant('ngc_testkey456'), { nil: undefined })
});

describe('Property 11: do/config Deployment-Target-Specific Variables', () => {
    before(() => {
        console.log('\n🚀 Starting do/config Deployment-Target-Specific Variables Property Tests');
        console.log('📋 Testing: Requirements 9.1, 9.2, 9.3, 9.4, 9.5');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should always contain BUILD_TARGET and DEPLOYMENT_TARGET for any valid config', function () {
        this.timeout(30000);

        console.log('  🧪 Req 9.1 + 9.2: BUILD_TARGET and DEPLOYMENT_TARGET always present');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    // provide defaults so EJS doesn't blow up on missing vars
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined
                };

                const output = renderConfig(vars);

                assert.ok(
                    output.includes('export BUILD_TARGET='),
                    'Output must contain BUILD_TARGET export'
                );
                assert.ok(
                    output.includes('export DEPLOYMENT_TARGET='),
                    'Output must contain DEPLOYMENT_TARGET export'
                );
                assert.ok(
                    output.includes(`BUILD_TARGET="${base.buildTarget}"`),
                    'BUILD_TARGET must equal the configured buildTarget value'
                );
                assert.ok(
                    output.includes(`DEPLOYMENT_TARGET="${deploymentTarget}"`),
                    'DEPLOYMENT_TARGET must equal the configured deploymentTarget value'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ BUILD_TARGET and DEPLOYMENT_TARGET always present');
    });

    it('should contain INSTANCE_TYPE when deploymentTarget is managed-inference', function () {
        this.timeout(30000);

        console.log('  🧪 Req 9.3: INSTANCE_TYPE present for managed-inference');

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
                    // HyperPod vars not needed but provide defaults
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderConfig(vars);

                assert.ok(
                    output.includes(`export INSTANCE_TYPE="${instanceType}"`),
                    `Output must contain INSTANCE_TYPE="${instanceType}"`
                );

                // Should NOT contain HyperPod variables
                assert.ok(
                    !output.includes('export HYPERPOD_CLUSTER_NAME='),
                    'managed-inference output must NOT contain HYPERPOD_CLUSTER_NAME'
                );
                assert.ok(
                    !output.includes('export HYPERPOD_NAMESPACE='),
                    'managed-inference output must NOT contain HYPERPOD_NAMESPACE'
                );
                assert.ok(
                    !output.includes('export HYPERPOD_REPLICAS='),
                    'managed-inference output must NOT contain HYPERPOD_REPLICAS'
                );

                // INFERENCE_AMI_VERSION conditional
                if (inferenceAmiVersion) {
                    assert.ok(
                        output.includes(`export INFERENCE_AMI_VERSION="${inferenceAmiVersion}"`),
                        'Output must contain INFERENCE_AMI_VERSION when provided'
                    );
                } else {
                    assert.ok(
                        !output.includes('export INFERENCE_AMI_VERSION='),
                        'Output must NOT contain INFERENCE_AMI_VERSION when not provided'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ INSTANCE_TYPE present for managed-inference');
    });

    it('should contain HyperPod variables when deploymentTarget is hyperpod-eks', function () {
        this.timeout(30000);

        console.log('  🧪 Req 9.4: HYPERPOD_CLUSTER_NAME, HYPERPOD_NAMESPACE, HYPERPOD_REPLICAS for hyperpod-eks');

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
                    hyperPodCluster: hpVars.hyperPodCluster,
                    hyperPodNamespace: hpVars.hyperPodNamespace,
                    hyperPodReplicas: hpVars.hyperPodReplicas,
                    fsxVolumeHandle: undefined
                };

                const output = renderConfig(vars);

                assert.ok(
                    output.includes(`export HYPERPOD_CLUSTER_NAME="${hpVars.hyperPodCluster}"`),
                    'Output must contain HYPERPOD_CLUSTER_NAME'
                );
                assert.ok(
                    output.includes(`export HYPERPOD_NAMESPACE="${hpVars.hyperPodNamespace}"`),
                    'Output must contain HYPERPOD_NAMESPACE'
                );
                assert.ok(
                    output.includes(`export HYPERPOD_REPLICAS="${hpVars.hyperPodReplicas}"`),
                    'Output must contain HYPERPOD_REPLICAS'
                );

                // Should NOT contain managed-inference variables
                assert.ok(
                    !output.includes('export INSTANCE_TYPE='),
                    'hyperpod-eks output must NOT contain INSTANCE_TYPE'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ HyperPod variables present for hyperpod-eks');
    });

    it('should contain FSX_VOLUME_HANDLE only when fsxVolumeHandle is provided with hyperpod-eks', function () {
        this.timeout(30000);

        console.log('  🧪 Req 9.5: FSX_VOLUME_HANDLE conditional on fsxVolumeHandle');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constant('default'),
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

                const output = renderConfig(vars);

                if (fsxVolumeHandle) {
                    assert.ok(
                        output.includes(`export FSX_VOLUME_HANDLE="${fsxVolumeHandle}"`),
                        'Output must contain FSX_VOLUME_HANDLE when provided'
                    );
                } else {
                    assert.ok(
                        !output.includes('export FSX_VOLUME_HANDLE='),
                        'Output must NOT contain FSX_VOLUME_HANDLE when not provided'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ FSX_VOLUME_HANDLE conditional logic correct');
    });

    it('should show deployment-target-specific summary lines', function () {
        this.timeout(30000);

        console.log('  🧪 Configuration summary echo statements vary by deployment target');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: 'my-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined
                };

                const output = renderConfig(vars);

                // Both targets should show build target and deployment target in summary
                assert.ok(output.includes('Build target:'), 'Summary must show Build target');
                assert.ok(output.includes('Deployment target:'), 'Summary must show Deployment target');

                if (deploymentTarget === 'managed-inference') {
                    assert.ok(
                        output.includes('echo "   Instance: ${INSTANCE_TYPE}"'),
                        'managed-inference summary must show Instance'
                    );
                    assert.ok(
                        !output.includes('HyperPod cluster:'),
                        'managed-inference summary must NOT show HyperPod cluster'
                    );
                } else {
                    assert.ok(
                        output.includes('echo "   HyperPod cluster: ${HYPERPOD_CLUSTER_NAME}"'),
                        'hyperpod-eks summary must show HyperPod cluster'
                    );
                    assert.ok(
                        output.includes('echo "   Namespace: ${HYPERPOD_NAMESPACE}"'),
                        'hyperpod-eks summary must show Namespace'
                    );
                    assert.ok(
                        !output.includes('echo "   Instance: ${INSTANCE_TYPE}"'),
                        'hyperpod-eks summary must NOT show Instance'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Summary lines correct per deployment target');
    });
});
