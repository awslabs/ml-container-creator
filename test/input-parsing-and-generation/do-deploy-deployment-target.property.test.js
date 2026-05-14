// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 7: Deploy Script Content by Deployment Target
 *
 * For any valid configuration, when deploymentTarget equals realtime-inference,
 * the generated do/deploy script must contain SageMaker inference component
 * commands (create-endpoint, create-inference-component) and must
 * not contain kubectl commands. When deploymentTarget equals hyperpod-eks,
 * the generated do/deploy script must contain kubectl commands
 * (describe-cluster, eks update-kubeconfig, kubectl apply from hyperpod/) and must not contain
 * SageMaker endpoint creation commands. For both targets, the script must
 * contain ECR image verification logic.
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 7.3, 7.4
 *
 * Feature: sagemaker-hyperpod-deployment, multi-ic-endpoints
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

// Lib helper file paths (pure bash, no EJS — content is static)
const libInferenceComponentPath = path.join(__dirname, '../../templates/do/lib/inference-component.sh');
const libSecretsPath = path.join(__dirname, '../../templates/do/lib/secrets.sh');
const libEndpointConfigPath = path.join(__dirname, '../../templates/do/lib/endpoint-config.sh');

const libInferenceComponentContent = readFileSync(libInferenceComponentPath, 'utf8');
const libSecretsContent = readFileSync(libSecretsPath, 'utf8');
const libEndpointConfigContent = readFileSync(libEndpointConfigPath, 'utf8');

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
            fc.constantFrom('realtime-inference', 'hyperpod-eks'),
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

    it('should contain SageMaker endpoint creation commands for realtime-inference (Req 5.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.2: SageMaker endpoint creation logic for realtime-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
            fc.option(fc.constant('1.0.0'), { nil: undefined }),
            (base, instanceType, inferenceAmiVersion) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must source shared helpers for IC-based deployment
                assert.ok(
                    output.includes('source') && output.includes('lib/inference-component.sh'),
                    'realtime-inference must source lib/inference-component.sh'
                );
                assert.ok(
                    output.includes('source') && output.includes('lib/endpoint-config.sh'),
                    'realtime-inference must source lib/endpoint-config.sh'
                );
                // Must contain inline create-endpoint call
                assert.ok(
                    output.includes('sagemaker create-endpoint'),
                    'realtime-inference must contain create-endpoint command'
                );
                // Must call create_inference_component or create_inference_component_legacy
                assert.ok(
                    output.includes('create_inference_component'),
                    'realtime-inference must call create_inference_component'
                );
                // Must call wait_ic for IC waiting
                assert.ok(
                    output.includes('wait_ic'),
                    'realtime-inference must call wait_ic'
                );

                // Must NOT contain kubectl commands
                assert.ok(
                    !output.includes('kubectl'),
                    'realtime-inference must NOT contain kubectl commands'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'realtime-inference must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ SageMaker endpoint creation commands present for realtime-inference');
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
            fc.constantFrom('realtime-inference', 'hyperpod-eks'),
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

                if (deploymentTarget === 'realtime-inference') {
                    assert.ok(
                        output.includes('Instance type: ${INSTANCE_TYPE}'),
                        'realtime-inference header must show instance type'
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

/**
 * Regression tests for multi-IC refactoring (do/lib/ helpers).
 *
 * Validates: Requirements 7.3, 7.4
 *
 * Feature: multi-ic-endpoints
 */
describe('Multi-IC Refactoring: do/lib/ Helper Regression Tests', () => {
    before(() => {
        console.log('\n🚀 Starting Multi-IC Refactoring Regression Tests');
        console.log('📋 Testing: Requirements 7.3, 7.4');
        console.log('🔧 Configuration: Static lib file content + EJS template rendering\n');
    });

    it('do/lib/inference-component.sh contains create-inference-component API call (Req 7.3)', function () {
        console.log('  🧪 Req 7.3: inference-component.sh contains create-inference-component');

        assert.ok(
            libInferenceComponentContent.includes('sagemaker create-inference-component'),
            'do/lib/inference-component.sh must contain sagemaker create-inference-component API call'
        );
        assert.ok(
            libInferenceComponentContent.includes('create_inference_component()'),
            'do/lib/inference-component.sh must define create_inference_component function'
        );
        assert.ok(
            libInferenceComponentContent.includes('create_inference_component_legacy()'),
            'do/lib/inference-component.sh must define create_inference_component_legacy function'
        );

        console.log('    ✅ inference-component.sh contains expected API calls');
    });

    it('do/lib/secrets.sh contains secretsmanager get-secret-value (Req 7.3)', function () {
        console.log('  🧪 Req 7.3: secrets.sh contains secretsmanager get-secret-value');

        assert.ok(
            libSecretsContent.includes('secretsmanager get-secret-value'),
            'do/lib/secrets.sh must contain secretsmanager get-secret-value API call'
        );
        assert.ok(
            libSecretsContent.includes('resolve_secrets()'),
            'do/lib/secrets.sh must define resolve_secrets function'
        );
        assert.ok(
            libSecretsContent.includes('CONTAINER_ENV_JSON'),
            'do/lib/secrets.sh must set CONTAINER_ENV_JSON'
        );

        console.log('    ✅ secrets.sh contains expected API calls');
    });

    it('do/lib/endpoint-config.sh contains create-endpoint-config API call (Req 7.3)', function () {
        console.log('  🧪 Req 7.3: endpoint-config.sh contains create-endpoint-config');

        assert.ok(
            libEndpointConfigContent.includes('sagemaker create-endpoint-config'),
            'do/lib/endpoint-config.sh must contain sagemaker create-endpoint-config API call'
        );
        assert.ok(
            libEndpointConfigContent.includes('create_endpoint_config()'),
            'do/lib/endpoint-config.sh must define create_endpoint_config function'
        );
        assert.ok(
            libEndpointConfigContent.includes('ENDPOINT_CONFIG_NAME'),
            'do/lib/endpoint-config.sh must set ENDPOINT_CONFIG_NAME'
        );

        console.log('    ✅ endpoint-config.sh contains expected API calls');
    });

    it('async deploy sources lib/secrets.sh and contains create-model (Req 7.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.3: async deploy sources lib/secrets.sh + contains create-model');

        fc.assert(fc.property(
            baseConfigArb,
            (base) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'async-inference',
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: 's3://test-bucket/output/',
                    asyncSnsSuccessTopic: 'arn:aws:sns:us-east-1:123456789012:success',
                    asyncSnsErrorTopic: 'arn:aws:sns:us-east-1:123456789012:error',
                    asyncMaxConcurrentInvocations: undefined
                };

                const output = renderDeploy(vars);

                assert.ok(
                    output.includes('source') && output.includes('lib/secrets.sh'),
                    'async deploy must source lib/secrets.sh'
                );
                assert.ok(
                    output.includes('sagemaker create-model'),
                    'async deploy must contain create-model API call'
                );
                assert.ok(
                    output.includes('resolve_secrets'),
                    'async deploy must call resolve_secrets'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ async deploy sources lib/secrets.sh and contains create-model');
    });

    it('batch deploy sources lib/secrets.sh and contains create-transform-job (Req 7.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.3: batch deploy sources lib/secrets.sh + contains create-transform-job');

        fc.assert(fc.property(
            baseConfigArb,
            (base) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'batch-transform',
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined,
                    batchInputPath: 's3://test-bucket/input/',
                    batchOutputPath: 's3://test-bucket/output/',
                    modelName: 'test-model'
                };

                const output = renderDeploy(vars);

                assert.ok(
                    output.includes('source') && output.includes('lib/secrets.sh'),
                    'batch deploy must source lib/secrets.sh'
                );
                assert.ok(
                    output.includes('sagemaker create-transform-job'),
                    'batch deploy must contain create-transform-job API call'
                );
                assert.ok(
                    output.includes('resolve_secrets'),
                    'batch deploy must call resolve_secrets'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ batch deploy sources lib/secrets.sh and contains create-transform-job');
    });

    it('realtime deploy calls create_inference_component_legacy for single-IC projects (Req 7.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.4: realtime deploy has legacy path for single-IC projects');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must contain the legacy function call for backward compat
                assert.ok(
                    output.includes('create_inference_component_legacy'),
                    'realtime deploy must call create_inference_component_legacy for single-IC projects without do/ic/'
                );
                // Must also have the multi-IC path (iterating do/ic/*.conf)
                assert.ok(
                    output.includes('ic/*.conf'),
                    'realtime deploy must iterate do/ic/*.conf for multi-IC projects'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy has legacy path for single-IC projects');
    });

    it('HyperPod deploy does NOT contain do/lib/ or do/ic/ references (Req 7.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.3: HyperPod deploy does NOT reference do/lib/ or do/ic/');

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

                // HyperPod is kubectl-based — must NOT reference shared bash helpers
                assert.ok(
                    !output.includes('lib/inference-component.sh'),
                    'hyperpod-eks deploy must NOT reference lib/inference-component.sh'
                );
                assert.ok(
                    !output.includes('lib/endpoint-config.sh'),
                    'hyperpod-eks deploy must NOT reference lib/endpoint-config.sh'
                );
                assert.ok(
                    !output.includes('lib/secrets.sh'),
                    'hyperpod-eks deploy must NOT reference lib/secrets.sh'
                );
                assert.ok(
                    !output.includes('do/ic/'),
                    'hyperpod-eks deploy must NOT reference do/ic/ directory'
                );
                assert.ok(
                    !output.includes('create_inference_component'),
                    'hyperpod-eks deploy must NOT call create_inference_component'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ HyperPod deploy does NOT reference do/lib/ or do/ic/');
    });

    it('realtime deploy sources all required lib helpers (Req 7.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.3: realtime deploy sources all required lib helpers');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must source all four lib helpers
                assert.ok(
                    output.includes('lib/secrets.sh'),
                    'realtime deploy must source lib/secrets.sh'
                );
                assert.ok(
                    output.includes('lib/wait.sh'),
                    'realtime deploy must source lib/wait.sh'
                );
                assert.ok(
                    output.includes('lib/endpoint-config.sh'),
                    'realtime deploy must source lib/endpoint-config.sh'
                );
                assert.ok(
                    output.includes('lib/inference-component.sh'),
                    'realtime deploy must source lib/inference-component.sh'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy sources all required lib helpers');
    });
});

/**
 * Tests for --ic <name> argument parsing in deploy script.
 *
 * Validates: Requirements 2.2, 2.3
 *
 * Feature: multi-ic-endpoints
 */
describe('Multi-IC: --ic <name> Argument Parsing (Req 2.2, 2.3)', () => {
    before(() => {
        console.log('\n🚀 Starting --ic <name> Argument Parsing Tests');
        console.log('📋 Testing: Requirements 2.2, 2.3');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('realtime deploy contains --ic argument parsing (Req 2.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.3: realtime deploy contains --ic argument parsing');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.g6e.48xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must contain --ic argument parsing
                assert.ok(
                    output.includes('--ic)'),
                    'realtime deploy must contain --ic case in argument parsing'
                );
                assert.ok(
                    output.includes('IC_TARGET'),
                    'realtime deploy must set IC_TARGET variable'
                );
                // Must validate that --ic requires a name
                assert.ok(
                    output.includes('--ic requires a name argument'),
                    'realtime deploy must validate --ic has a name argument'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy contains --ic argument parsing');
    });

    it('realtime deploy validates IC config file exists when --ic specified (Req 2.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.3: realtime deploy validates IC config file existence');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // Must validate IC config file exists
                assert.ok(
                    output.includes('IC config not found'),
                    'realtime deploy must show error when IC config not found'
                );
                // Must list available ICs on error
                assert.ok(
                    output.includes('Available ICs'),
                    'realtime deploy must list available ICs when config not found'
                );
                // Must check for do/ic/ directory existence
                assert.ok(
                    output.includes('no do/ic/ directory found'),
                    'realtime deploy must check for do/ic/ directory when --ic specified'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy validates IC config file existence');
    });

    it('realtime deploy deploys only named IC when IC_TARGET is set (Req 2.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.3: realtime deploy deploys only named IC when --ic specified');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // When IC_TARGET is set, deploy only that IC via _deploy_single_ic
                assert.ok(
                    output.includes('_deploy_single_ic "${SCRIPT_DIR}/ic/${IC_TARGET}.conf"'),
                    'realtime deploy must call _deploy_single_ic with specific IC config when IC_TARGET is set'
                );
                // Must have the conditional check for IC_TARGET
                assert.ok(
                    output.includes('if [ -n "${IC_TARGET}" ]'),
                    'realtime deploy must check if IC_TARGET is set to decide single vs all IC deployment'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy deploys only named IC when --ic specified');
    });

    it('realtime deploy deploys all ICs in alphabetical order when --ic omitted (Req 2.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.2: realtime deploy deploys all ICs when --ic omitted');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType,
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderDeploy(vars);

                // When IC_TARGET is empty, iterate all IC configs (glob gives alphabetical order)
                assert.ok(
                    output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                    'realtime deploy must iterate all IC configs with glob when --ic omitted'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ realtime deploy deploys all ICs when --ic omitted');
    });

    it('--ic help text shown only for realtime-inference (Req 2.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.3: --ic help text only in realtime-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('async-inference', 'hyperpod-eks', 'batch-transform'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    inferenceAmiVersion: undefined,
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined,
                    asyncS3OutputPath: 's3://test-bucket/output/',
                    asyncSnsSuccessTopic: 'arn:aws:sns:us-east-1:123456789012:success',
                    asyncSnsErrorTopic: 'arn:aws:sns:us-east-1:123456789012:error',
                    asyncMaxConcurrentInvocations: undefined,
                    batchInputPath: 's3://test-bucket/input/',
                    batchOutputPath: 's3://test-bucket/output/',
                    modelName: 'test-model'
                };

                const output = renderDeploy(vars);

                // Non-realtime targets must NOT contain --ic argument parsing case
                assert.ok(
                    !output.includes('--ic)'),
                    `${deploymentTarget} deploy must NOT contain --ic case in argument parsing`
                );
                // Non-realtime targets must NOT contain --ic in help text
                assert.ok(
                    !output.includes('--ic <name>'),
                    `${deploymentTarget} deploy must NOT show --ic in help text`
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ --ic help text only in realtime-inference');
    });
});
