// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 10: InferenceEndpointConfig CRD Contract
 *
 * BL088 migrated the HyperPod EKS deployment target from raw Deployment/Service/
 * ConfigMap manifests to a single InferenceEndpointConfig custom resource. For
 * any valid hyperpod-eks configuration, the rendered CRD must:
 *   - use apiVersion inference.sagemaker.aws.amazon.com/v1 and kind
 *     InferenceEndpointConfig
 *   - name the resource (== SageMaker endpoint == PROJECT_NAME) and set
 *     spec.modelName
 *   - expose the BYOC serving contract on containerPort 8080
 *   - request/limit nvidia.com/gpu
 *   - carry the configured replicas, namespace, and invocationEndpoint
 *
 * The rendered template contains a `__MODEL_SOURCE_CONFIG__` marker (spliced at
 * deploy time by do/deploy.d/hyperpod-eks) and shell `${...}` placeholders, so
 * this test replaces those before YAML parsing.
 *
 * Validates: Requirements 1.1, 9.1
 *
 * Feature: v17-w1-02-bl088 (HyperPod EKS CRD migration)
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.join(__dirname, '../../templates/hyperpod');
const crdTemplate = readFileSync(path.join(templatesDir, 'InferenceEndpointConfig.yaml.ejs'), 'utf8');

/**
 * Render the CRD template and normalize deploy-time placeholders so the result
 * is parseable YAML:
 *   - splice a concrete modelSourceConfig block in place of the marker
 *   - collapse shell `${VAR:-default}` to the default (or a stub)
 */
function renderCrd(vars) {
    let output = ejs.render(crdTemplate, vars);

    // Splice a concrete S3 modelSourceConfig at the marker's indentation.
    const s3Block = [
        'modelSourceType: s3',
        's3Storage:',
        '  bucketName: test-bucket',
        '  region: us-east-1',
        'modelLocation: models/test',
        'prefetchEnabled: true'
    ];
    output = output.split('\n').flatMap((line) => {
        const pos = line.indexOf('__MODEL_SOURCE_CONFIG__');
        if (pos >= 0) {
            const indent = line.slice(0, pos);
            return s3Block.map((l) => indent + l);
        }
        return [line];
    }).join('\n');

    // Resolve `${VAR:-default}` → default, and bare `${VAR}` → stub value.
    output = output
        .replace(/\$\{[A-Za-z0-9_]+:-([^}]*)\}/g, '$1')
        .replace(/\$\{[A-Za-z0-9_]+\}/g, 'stub-value');

    return output;
}

/** Arbitrary for a base config for HyperPod EKS */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'transformers-sglang'),
    framework: fc.constantFrom('transformers'),
    modelServer: fc.constantFrom('vllm', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    deploymentTarget: fc.constant('hyperpod-eks'),
    instanceType: fc.constantFrom('ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p4d.24xlarge'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1')
});

/** Arbitrary for HyperPod-specific config */
const hyperPodConfigArb = fc.record({
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 })
});

describe('Property 10: InferenceEndpointConfig CRD Contract', () => {
    before(() => {
        console.log('\n📜 Starting InferenceEndpointConfig CRD Contract Property Tests');
        console.log('📋 Testing: Requirements 1.1, 9.1');
        console.log('🔧 Configuration: EJS CRD template rendering with fast-check\n');
    });

    it('renders a valid InferenceEndpointConfig CRD (Req 1.1)', function () {
        this.timeout(30000);
        fc.assert(fc.property(baseConfigArb, hyperPodConfigArb, (base, hpVars) => {
            const crd = yaml.load(renderCrd({ ...base, ...hpVars, HP_GPU_COUNT: '4' }));

            assert.strictEqual(crd.apiVersion, 'inference.sagemaker.aws.amazon.com/v1',
                'apiVersion must be inference.sagemaker.aws.amazon.com/v1');
            assert.strictEqual(crd.kind, 'InferenceEndpointConfig', 'kind must be InferenceEndpointConfig');
            assert.strictEqual(crd.metadata.name, base.projectName,
                'metadata.name must equal projectName (== SageMaker endpoint name)');
            // BL088 contract: spec.modelName identifies the model being served
            // (HF model id / S3 path prefix), NOT the projectName. The endpoint
            // name comes from metadata.name / spec.endpointName (== projectName).
            assert.strictEqual(crd.spec.modelName, base.modelName,
                'spec.modelName must equal the model id');
            assert.strictEqual(crd.spec.endpointName, base.projectName,
                'spec.endpointName must equal projectName (== SageMaker endpoint name)');
        }), { numRuns: 50 });
        console.log('    ✅ Valid InferenceEndpointConfig CRD rendered');
    });

    it('exposes the BYOC serving contract on containerPort 8080 (Req 1.1)', function () {
        this.timeout(30000);
        fc.assert(fc.property(baseConfigArb, hyperPodConfigArb, (base, hpVars) => {
            const crd = yaml.load(renderCrd({ ...base, ...hpVars, HP_GPU_COUNT: '2' }));
            assert.strictEqual(crd.spec.worker.modelInvocationPort.containerPort, 8080,
                'worker.modelInvocationPort.containerPort must be 8080 for BYOC compatibility');
        }), { numRuns: 50 });
        console.log('    ✅ containerPort is always 8080');
    });

    it('requests and limits nvidia.com/gpu (Req 1.1)', function () {
        this.timeout(30000);
        fc.assert(fc.property(baseConfigArb, hyperPodConfigArb, (base, hpVars) => {
            const crd = yaml.load(renderCrd({ ...base, ...hpVars, HP_GPU_COUNT: '4' }));
            const resources = crd.spec.worker.resources;
            assert.ok(resources.requests['nvidia.com/gpu'], 'worker must request nvidia.com/gpu');
            assert.ok(resources.limits['nvidia.com/gpu'], 'worker must limit nvidia.com/gpu');
        }), { numRuns: 50 });
        console.log('    ✅ GPU resources present');
    });

    it('carries configured replicas, namespace, and invocationEndpoint (Req 1.1)', function () {
        this.timeout(30000);
        fc.assert(fc.property(baseConfigArb, hyperPodConfigArb, (base, hpVars) => {
            const crd = yaml.load(renderCrd({ ...base, ...hpVars, HP_GPU_COUNT: '1' }));
            assert.strictEqual(crd.spec.replicas, hpVars.hyperPodReplicas,
                'spec.replicas must match configured replicas');
            assert.strictEqual(crd.metadata.namespace, hpVars.hyperPodNamespace,
                'metadata.namespace must match configured namespace');
            assert.strictEqual(crd.spec.invocationEndpoint, 'v1/chat/completions',
                'spec.invocationEndpoint must be v1/chat/completions');
        }), { numRuns: 50 });
        console.log('    ✅ replicas, namespace, and invocationEndpoint honored');
    });

    it('uses environmentVariables (not env) for worker config (Req 1.1)', function () {
        this.timeout(30000);
        fc.assert(fc.property(baseConfigArb, hyperPodConfigArb, (base, hpVars) => {
            const crd = yaml.load(renderCrd({ ...base, ...hpVars, HP_GPU_COUNT: '1' }));
            assert.ok(Array.isArray(crd.spec.worker.environmentVariables),
                'worker.environmentVariables must be an array');
            assert.strictEqual(crd.spec.worker.env, undefined,
                'worker.env must NOT be used (verified CRD uses environmentVariables)');
        }), { numRuns: 50 });
        console.log('    ✅ worker.environmentVariables used, not worker.env');
    });
});
