// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL088 — HyperPod EKS CRD deployment-driver contract tests.
 *
 * These tests read the (EJS-rendered) do/deploy.d/hyperpod-eks and
 * do/clean.d/hyperpod-eks drivers and the InferenceEndpointConfig CRD template
 * and assert the migration contract without requiring a live cluster:
 *
 *  - AC-1/AC-2: applies an InferenceEndpointConfig (not raw Deployment/Service/
 *    ConfigMap) so the operator can create a SageMakerEndpointRegistration.
 *  - AC-3: polls the CRD status.state until DeploymentComplete, then polls
 *    `aws sagemaker describe-endpoint` until InService (15-minute cap).
 *  - AC-4: writes ENDPOINT_NAME == PROJECT_NAME and sets
 *    DEPLOYMENT_TARGET_HP_STATUS=Running only after InService.
 *  - Cleanup: deletes the InferenceEndpointConfig, waits for the
 *    SageMakerEndpointRegistration to disappear, and clears ENDPOINT_NAME.
 *
 * Feature: v17-w1-02-bl088
 * Validates: Requirements 1.1, 1.2, 2.1, 3.1, 4.1, 10.1, 10.2
 */

import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(__dirname, '../../templates');

const VARS = {
    projectName: 'my-model',
    framework: 'transformers',
    modelName: 'meta-llama/Llama-3.1-8B',
    modelServer: 'vllm',
    hyperPodNamespace: 'ml-inference',
    hyperPodReplicas: 2,
    instanceType: 'ml.g5.xlarge',
    awsRegion: 'us-east-1',
    includeBenchmark: true,
    fsxVolumeHandle: ''
};

function render(relPath, extra = {}) {
    const src = resolve(templatesRoot, relPath);
    return ejs.render(readFileSync(src, 'utf8'), { ...VARS, ...extra }, { filename: src });
}

describe('BL088: HyperPod EKS CRD deploy driver', () => {
    let deploy;
    let crd;

    before(() => {
        deploy = render('do/deploy.d/hyperpod-eks');
        crd = render('hyperpod/InferenceEndpointConfig.yaml.ejs');
    });

    it('applies the InferenceEndpointConfig CRD, not raw manifests (AC-1, AC-2)', () => {
        assert.ok(crd.includes('kind: InferenceEndpointConfig'),
            'CRD template must declare kind: InferenceEndpointConfig');
        assert.ok(crd.includes('apiVersion: inference.sagemaker.aws.amazon.com/v1'),
            'CRD template must use the inference operator apiVersion');
        // The driver applies the rendered hyperpod manifests to the namespace.
        assert.ok(deploy.includes('kubectl apply -n "${HP_NAMESPACE}"'),
            'deploy driver must apply the manifest to the namespace');
        // No leftover raw-manifest readiness check.
        assert.ok(!deploy.includes('kubectl rollout status deployment/'),
            'deploy driver must not wait on a raw Deployment rollout');
    });

    it('polls CRD status.state until DeploymentComplete (AC-3)', () => {
        assert.ok(deploy.includes('kubectl get inferenceendpointconfig'),
            'deploy driver must query the InferenceEndpointConfig');
        assert.ok(deploy.includes('jsonpath=\'{.status.state}\''),
            'deploy driver must read status.state via jsonpath');
        assert.ok(deploy.includes('DeploymentComplete'),
            'deploy driver must wait for DeploymentComplete');
        assert.ok(deploy.includes('DeploymentFailed'),
            'deploy driver must handle DeploymentFailed');
    });

    it('polls the SageMaker endpoint until InService (AC-3)', () => {
        assert.ok(deploy.includes('aws sagemaker describe-endpoint'),
            'deploy driver must describe the SageMaker endpoint');
        assert.ok(deploy.includes('--endpoint-name "${PROJECT_NAME}"'),
            'deploy driver must target the project endpoint name');
        assert.ok(/InService/.test(deploy),
            'deploy driver must wait for InService');
    });

    it('caps the wait at 15 minutes (AC-3)', () => {
        assert.ok(deploy.includes('DEPLOY_TIMEOUT=${DEPLOY_TIMEOUT:-900}'),
            'deploy driver must default the timeout to 900s (15 min)');
    });

    it('writes ENDPOINT_NAME and Running status only after InService (AC-4)', () => {
        const nameIdx = deploy.indexOf('_update_config "ENDPOINT_NAME" "${PROJECT_NAME}"');
        const runningIdx = deploy.indexOf('_update_config "DEPLOYMENT_TARGET_HP_STATUS" "Running"');
        const inServiceIdx = deploy.indexOf('Endpoint status: InService');
        assert.ok(nameIdx > 0, 'deploy driver must persist ENDPOINT_NAME=PROJECT_NAME');
        assert.ok(runningIdx > 0, 'deploy driver must set DEPLOYMENT_TARGET_HP_STATUS=Running');
        // Both writes must appear after the InService confirmation in the script.
        assert.ok(nameIdx > inServiceIdx && runningIdx > inServiceIdx,
            'ENDPOINT_NAME and Running status must be written after InService is confirmed');
    });

    it('marks the target Failed on timeout/failure (AC-3)', () => {
        assert.ok(deploy.includes('_update_config "DEPLOYMENT_TARGET_HP_STATUS" "Failed"'),
            'deploy driver must record a Failed status on failure paths');
    });
});

describe('BL088: HyperPod EKS CRD clean driver', () => {
    let clean;

    before(() => {
        clean = render('do/clean.d/hyperpod-eks');
    });

    it('deletes the InferenceEndpointConfig (not raw manifests)', () => {
        assert.ok(clean.includes('kubectl delete inferenceendpointconfig "${PROJECT_NAME}"'),
            'clean driver must delete the InferenceEndpointConfig by name');
    });

    it('waits for SageMakerEndpointRegistration removal', () => {
        assert.ok(clean.includes('kubectl get sagemakerendpointregistration "${PROJECT_NAME}"'),
            'clean driver must poll for SageMakerEndpointRegistration removal');
    });

    it('clears ENDPOINT_NAME from do/config', () => {
        assert.ok(/ENDPOINT_NAME=/.test(clean) && clean.includes('config'),
            'clean driver must clear ENDPOINT_NAME in do/config');
    });
});

describe('BL088: modelSourceConfig rendering (S3 vs Hugging Face)', () => {
    let deploy;

    before(() => {
        deploy = render('do/deploy.d/hyperpod-eks');
    });

    it('parses STAGED_MODEL_PATH into bucketName + region (not a full s3:// URI)', () => {
        // The driver must split the staged S3 URI into bucket + prefix and emit
        // s3Storage.bucketName / region, per the verified CRD schema.
        assert.ok(deploy.includes('STAGED_MODEL_PATH#s3://'),
            'driver must strip the s3:// scheme from STAGED_MODEL_PATH');
        assert.ok(deploy.includes('bucketName:'),
            'driver must emit s3Storage.bucketName');
        assert.ok(deploy.includes('modelSourceType: s3'),
            'driver must set modelSourceType: s3 for staged models');
    });

    it('falls back to the Hugging Face source with tokenSecretRef', () => {
        assert.ok(deploy.includes('modelSourceType: huggingface'),
            'driver must support the huggingface source');
        assert.ok(deploy.includes('name: hf-token-secret') && deploy.includes('key: token'),
            'driver must reference the hf-token-secret / token key');
    });

    it('emits a model-package source when OPTIMIZE_MODEL_PACKAGE_ARN is set', () => {
        // SageMaker Inference Optimizer override: the driver must gate on
        // OPTIMIZE_MODEL_PACKAGE_ARN and emit modelSourceType: model-package
        // with the modelPackageArn, taking precedence over the S3/HF sources.
        assert.ok(deploy.includes('OPTIMIZE_MODEL_PACKAGE_ARN'),
            'driver must check OPTIMIZE_MODEL_PACKAGE_ARN');
        assert.ok(deploy.includes('modelSourceType: model-package'),
            'driver must set modelSourceType: model-package for optimized packages');
        assert.ok(deploy.includes('modelPackageArn: "${OPTIMIZE_MODEL_PACKAGE_ARN}"'),
            'driver must emit modelSourceConfig.modelPackageArn from the ARN');
        // The optimize branch must be evaluated before the STAGED_MODEL_PATH branch.
        const optIdx = deploy.indexOf('if [ -n "${OPTIMIZE_MODEL_PACKAGE_ARN:-}" ]; then');
        const s3Idx = deploy.indexOf('elif [ -n "${STAGED_MODEL_PATH:-}" ]; then');
        assert.ok(optIdx > 0 && s3Idx > optIdx,
            'the model-package branch must take precedence over the S3 branch');
    });

    it('overrides spec.modelName with OPTIMIZE_INFERENCE_SPEC for traceability', () => {
        assert.ok(deploy.includes('HP_MODEL_NAME_OVERRIDE'),
            'driver must compute a modelName override');
        assert.ok(deploy.includes('OPTIMIZE_INFERENCE_SPEC'),
            'driver must read OPTIMIZE_INFERENCE_SPEC for the modelName override');
        // The splice must rewrite the top-level spec.modelName line.
        assert.ok(/name_re = re\.compile\(r"\^\( {2}modelName:/.test(deploy),
            'driver splice must rewrite the top-level spec.modelName');
    });
});

describe('BL088: modelSourceConfig CRD template documents the model-package branch', () => {
    let crd;

    before(() => {
        crd = render('hyperpod/InferenceEndpointConfig.yaml.ejs');
    });

    it('documents modelSourceType: model-package with modelPackageArn', () => {
        assert.ok(crd.includes('modelSourceType: model-package'),
            'CRD template must document the model-package source type');
        assert.ok(crd.includes('modelPackageArn'),
            'CRD template must document the modelPackageArn field');
    });
});
