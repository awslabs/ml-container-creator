// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 11: do/config Universal Variables (BL062)
 *
 * After BL062:
 * - do/config always contains DEPLOYMENT_TARGET
 * - HP_* vars replace HYPERPOD_* vars
 * - When hyperPodCluster is provided, HP_CLUSTER_NAME is exported
 * - When hyperPodCluster is NOT provided, HP_* vars are commented out
 * - Batch and Async sections are always present (active or commented)
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, BL062 AC-2.1–2.5
 *
 * Feature: sagemaker-hyperpod-deployment, universal-deploy
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

const templatePath = path.join(__dirname, '../../templates/do/config');
const templateContent = readFileSync(templatePath, 'utf8');

function renderConfig(answers) {
    return ejs.render(templateContent, {
        orderedEnvVars: [],
        baseImage: '',
        projectName: answers.projectName ?? 'test-project',
        deploymentConfig: answers.deploymentConfig ?? 'transformers-vllm',
        framework: answers.framework ?? 'transformers',
        modelServer: answers.modelServer ?? 'vllm',
        awsRegion: answers.awsRegion ?? 'us-east-1',
        buildTarget: answers.buildTarget ?? 'codebuild',
        codebuildComputeType: answers.codebuildComputeType ?? 'BUILD_GENERAL1_MEDIUM',
        deploymentTarget: answers.deploymentTarget ?? 'realtime-inference',
        instanceType: answers.instanceType ?? 'ml.g5.xlarge',
        inferenceAmiVersion: answers.inferenceAmiVersion ?? undefined,
        ngcApiKey: answers.ngcApiKey ?? undefined,
        icCpuCount: answers.icCpuCount ?? undefined,
        icMemorySize: answers.icMemorySize ?? undefined,
        icGpuCount: answers.icGpuCount ?? 1,
        icCopyCount: answers.icCopyCount ?? undefined,
        icModelWeight: answers.icModelWeight ?? undefined,
        endpointInitialInstanceCount: answers.endpointInitialInstanceCount ?? undefined,
        endpointDataCapturePercent: answers.endpointDataCapturePercent ?? undefined,
        endpointVariantName: answers.endpointVariantName ?? undefined,
        endpointVolumeSize: answers.endpointVolumeSize ?? undefined,
        modelEnvVars: answers.modelEnvVars ?? {},
        serverEnvVars: answers.serverEnvVars ?? {},
        icEnvVars: answers.icEnvVars ?? {},
        asyncMaxConcurrentInvocations: answers.asyncMaxConcurrentInvocations ?? undefined,
        asyncSnsSuccessTopic: answers.asyncSnsSuccessTopic ?? undefined,
        asyncSnsErrorTopic: answers.asyncSnsErrorTopic ?? undefined,
        batchInstanceCount: answers.batchInstanceCount ?? undefined,
        batchSplitType: answers.batchSplitType ?? 'Line',
        batchStrategy: answers.batchStrategy ?? 'SingleRecord',
        batchJoinSource: answers.batchJoinSource ?? 'None',
        batchMaxConcurrentTransforms: answers.batchMaxConcurrentTransforms ?? undefined,
        batchMaxPayloadInMB: answers.batchMaxPayloadInMB ?? undefined,
        hyperPodCluster: answers.hyperPodCluster ?? '',
        hyperPodNamespace: answers.hyperPodNamespace ?? 'default',
        hyperPodReplicas: answers.hyperPodReplicas ?? 1,
        fsxVolumeHandle: answers.fsxVolumeHandle ?? undefined,
        instancePools: answers.instancePools ?? undefined,
        capacityReservationArn: answers.capacityReservationArn ?? undefined,
        deploy_mode: answers.deploy_mode ?? undefined,
        existingEndpointName: answers.existingEndpointName ?? undefined,
        enableLora: answers.enableLora ?? undefined,
        hfToken: answers.hfToken ?? undefined,
        hfTokenArn: answers.hfTokenArn ?? undefined,
        ngcTokenArn: answers.ngcTokenArn ?? undefined,
        modelName: answers.modelName ?? 'test-model',
        tuneSupported: answers.tuneSupported ?? undefined,
        tuneModelId: answers.tuneModelId ?? undefined,
        container_image_uri: answers.container_image_uri ?? undefined,
        modelFormat: answers.modelFormat ?? undefined,
        includeBenchmark: answers.includeBenchmark ?? undefined,
        benchmarkConcurrency: answers.benchmarkConcurrency ?? undefined,
        benchmarkInputTokensMean: answers.benchmarkInputTokensMean ?? undefined,
        benchmarkOutputTokensMean: answers.benchmarkOutputTokensMean ?? undefined,
        benchmarkStreaming: answers.benchmarkStreaming ?? undefined,
        benchmarkRequestCount: answers.benchmarkRequestCount ?? undefined,
        benchmarkS3OutputPath: answers.benchmarkS3OutputPath ?? undefined,
        ciBenchmarkResultsBucket: answers.ciBenchmarkResultsBucket ?? undefined,
        ...answers
    });
}

const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
    roleArn: fc.option(fc.constant('arn:aws:iam::123456789012:role/SageMakerRole'), { nil: undefined }),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1'),
    hfToken: fc.option(fc.constant('hf_test_token'), { nil: undefined }),
    hfTokenArn: fc.option(fc.constant(undefined), { nil: undefined })
});

const hyperPodConfigArb = fc.record({
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    fsxVolumeHandle: fc.option(fc.stringMatching(/^fs-[a-f0-9]{17}$/), { nil: undefined })
});

describe('Property 11: do/config Universal Variables (BL062)', () => {
    before(() => {
        console.log('\n📜 Starting do/config Deployment Target Property Tests (BL062)');
    });

    it('should always contain DEPLOYMENT_TARGET variable (Req 9.1)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('realtime-inference', 'hyperpod-eks', 'async-inference', 'batch-transform'),
            (base, target) => {
                const vars = {
                    ...base,
                    deploymentTarget: target,
                    instanceType: 'ml.g5.xlarge'
                };
                const output = renderConfig(vars);
                assert.ok(
                    output.includes('DEPLOYMENT_TARGET'),
                    'do/config must contain DEPLOYMENT_TARGET'
                );
            }
        ), { numRuns: 20 });
    });

    it('should contain HP_* vars (not HYPERPOD_*) when hyperPodCluster is provided', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: 'ml.g5.xlarge',
                    ...hpVars
                };
                const output = renderConfig(vars);
                assert.ok(
                    output.includes(`export HP_CLUSTER_NAME="${hpVars.hyperPodCluster}"`),
                    'Output must contain HP_CLUSTER_NAME'
                );
                assert.ok(
                    output.includes(`export HP_NAMESPACE="${hpVars.hyperPodNamespace}"`),
                    'Output must contain HP_NAMESPACE'
                );
                assert.ok(
                    output.includes(`export HP_REPLICAS="${hpVars.hyperPodReplicas}"`),
                    'Output must contain HP_REPLICAS'
                );
                // Must NOT contain old HYPERPOD_* names
                assert.ok(
                    !output.includes('export HYPERPOD_CLUSTER_NAME'),
                    'Output must NOT contain legacy HYPERPOD_CLUSTER_NAME'
                );
            }
        ), { numRuns: 20 });
    });

    it('should contain commented HP_* section when hyperPodCluster is NOT provided', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.g5.xlarge', 'ml.m5.large'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType
                };
                const output = renderConfig(vars);
                // HyperPod section should be present (with env-var defaults for cross-target switching)
                assert.ok(
                    output.includes('HP_CLUSTER_NAME') || output.includes('HyperPod'),
                    'realtime-inference output must have HyperPod section'
                );
                // HP_CLUSTER_NAME should be exported with an empty default (not a hardcoded cluster)
                const hasHardcodedCluster = output.split('\n').some(
                    line => line.match(/^\s*export HP_CLUSTER_NAME="[^$]/)
                );
                assert.ok(
                    !hasHardcodedCluster,
                    'realtime-inference output must NOT have hardcoded HP_CLUSTER_NAME value'
                );
            }
        ), { numRuns: 20 });
    });

    it('should contain FSX_VOLUME_HANDLE when provided with hyperPodCluster', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !(s in Object.prototype) && !(s in Function.prototype)),
                hyperPodNamespace: fc.constant('default'),
                hyperPodReplicas: fc.constant(1),
                fsxVolumeHandle: fc.stringMatching(/^fs-[a-f0-9]{17}$/)
            }),
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: 'ml.g5.xlarge',
                    ...hpVars
                };
                const output = renderConfig(vars);
                assert.ok(
                    output.includes(`export FSX_VOLUME_HANDLE="${hpVars.fsxVolumeHandle}"`),
                    'Output must contain FSX_VOLUME_HANDLE when provided'
                );
            }
        ), { numRuns: 10 });
    });

    it('do/config for realtime-inference must contain INSTANCE_TYPE but NOT async-specific variables', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.g5.xlarge', 'ml.p4d.24xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType
                };
                const output = renderConfig(vars);
                assert.ok(
                    output.includes('INSTANCE_TYPE'),
                    'realtime-inference must contain INSTANCE_TYPE'
                );
                // Async vars should be commented (not active exports)
                const hasActiveAsyncExport = output.split('\n').some(
                    line => line.match(/^\s*export ASYNC_MAX_CONCURRENT_INVOCATIONS=/)
                );
                assert.ok(
                    !hasActiveAsyncExport,
                    'realtime-inference must NOT have active ASYNC_MAX_CONCURRENT_INVOCATIONS'
                );
            }
        ), { numRuns: 10 });
    });

    it('should contain target-specific echo in config summary', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: 'ml.g5.xlarge',
                    ...hpVars
                };
                const output = renderConfig(vars);
                assert.ok(
                    output.includes('echo "   HyperPod cluster: ${HP_CLUSTER_NAME}"'),
                    'hyperpod config summary must reference HP_CLUSTER_NAME'
                );
                assert.ok(
                    output.includes('echo "   Namespace: ${HP_NAMESPACE}"'),
                    'hyperpod config summary must reference HP_NAMESPACE'
                );
            }
        ), { numRuns: 10 });
    });
});
