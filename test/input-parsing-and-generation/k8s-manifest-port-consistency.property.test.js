// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 10: Kubernetes Manifest Port Consistency
 *
 * For any valid hyperpod-eks configuration, the generated deployment.yaml must
 * specify containerPort: 8080 and the generated service.yaml must specify
 * targetPort: 8080, maintaining SageMaker BYOC compatibility.
 *
 * Validates: Requirements 8.1, 8.2, 13.1, 13.2
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
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Kubernetes manifest templates
const templatesDir = path.join(__dirname, '../../generators/app/templates/hyperpod');

const deploymentTemplate = readFileSync(path.join(templatesDir, 'deployment.yaml'), 'utf8');
const serviceTemplate = readFileSync(path.join(templatesDir, 'service.yaml'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, vars);
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
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1'),
    hfToken: fc.option(fc.stringMatching(/^hf_[a-zA-Z0-9]{20,40}$/), { nil: undefined }),
    ngcApiKey: fc.option(fc.stringMatching(/^[a-zA-Z0-9]{20,40}$/), { nil: undefined }),
    modelFormat: fc.option(fc.constantFrom('safetensors', 'pytorch'), { nil: undefined })
});

/** Arbitrary for HyperPod-specific config */
const hyperPodConfigArb = fc.record({
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    fsxVolumeHandle: fc.option(fc.stringMatching(/^fs-[a-f0-9]{17}$/), { nil: undefined })
});

describe('Property 10: Kubernetes Manifest Port Consistency', () => {
    before(() => {
        console.log('\n📜 Starting Kubernetes Manifest Port Consistency Property Tests');
        console.log('📋 Testing: Requirements 8.1, 8.2, 13.1, 13.2');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should generate deployment.yaml with containerPort 8080 (Req 8.1, 13.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 8.1, 13.1: deployment.yaml containerPort: 8080');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render deployment template
                const output = renderTemplate(deploymentTemplate, vars);

                // Parse as YAML to validate structure
                const deployment = yaml.load(output);

                // Verify it's a Deployment
                assert.strictEqual(
                    deployment.kind,
                    'Deployment',
                    'Must be a Kubernetes Deployment'
                );

                // Verify apiVersion
                assert.strictEqual(
                    deployment.apiVersion,
                    'apps/v1',
                    'Must use apps/v1 apiVersion'
                );

                // Get container spec
                const containers = deployment.spec.template.spec.containers;
                assert.ok(
                    containers && containers.length > 0,
                    'Deployment must have at least one container'
                );

                const container = containers[0];

                // Verify containerPort is 8080
                assert.ok(
                    container.ports && container.ports.length > 0,
                    'Container must have ports defined'
                );

                const port = container.ports.find(p => p.containerPort === 8080);
                assert.ok(
                    port !== undefined,
                    'Container must have containerPort: 8080 for SageMaker BYOC compatibility'
                );

                assert.strictEqual(
                    port.containerPort,
                    8080,
                    'containerPort must be exactly 8080'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ deployment.yaml always has containerPort: 8080');
    });

    it('should generate service.yaml with targetPort 8080 (Req 8.2, 13.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 8.2, 13.2: service.yaml targetPort: 8080');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render service template
                const output = renderTemplate(serviceTemplate, vars);

                // Parse as YAML to validate structure
                const service = yaml.load(output);

                // Verify it's a Service
                assert.strictEqual(
                    service.kind,
                    'Service',
                    'Must be a Kubernetes Service'
                );

                // Verify apiVersion
                assert.strictEqual(
                    service.apiVersion,
                    'v1',
                    'Must use v1 apiVersion'
                );

                // Verify ports
                assert.ok(
                    service.spec.ports && service.spec.ports.length > 0,
                    'Service must have ports defined'
                );

                const port = service.spec.ports.find(p => p.targetPort === 8080);
                assert.ok(
                    port !== undefined,
                    'Service must have targetPort: 8080 for SageMaker BYOC compatibility'
                );

                assert.strictEqual(
                    port.targetPort,
                    8080,
                    'targetPort must be exactly 8080'
                );

                // Also verify the service port is 8080
                assert.strictEqual(
                    port.port,
                    8080,
                    'Service port must be 8080'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ service.yaml always has targetPort: 8080');
    });

    it('should have matching selectors between deployment and service', function () {
        this.timeout(30000);

        console.log('  🧪 Deployment and Service selectors must match');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render both templates
                const deploymentOutput = renderTemplate(deploymentTemplate, vars);
                const serviceOutput = renderTemplate(serviceTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(deploymentOutput);
                const service = yaml.load(serviceOutput);

                // Get deployment pod labels
                const podLabels = deployment.spec.template.metadata.labels;

                // Get service selector
                const serviceSelector = service.spec.selector;

                // Service selector must match deployment pod labels
                assert.ok(
                    podLabels.app === serviceSelector.app,
                    `Service selector (${serviceSelector.app}) must match deployment pod label (${podLabels.app})`
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Deployment and Service selectors match');
    });

    it('should use the configured namespace in both manifests', function () {
        this.timeout(30000);

        console.log('  🧪 Both manifests use configured hyperPodNamespace');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render both templates
                const deploymentOutput = renderTemplate(deploymentTemplate, vars);
                const serviceOutput = renderTemplate(serviceTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(deploymentOutput);
                const service = yaml.load(serviceOutput);

                // Verify namespace matches configured value
                assert.strictEqual(
                    deployment.metadata.namespace,
                    hpVars.hyperPodNamespace,
                    'Deployment namespace must match hyperPodNamespace'
                );

                assert.strictEqual(
                    service.metadata.namespace,
                    hpVars.hyperPodNamespace,
                    'Service namespace must match hyperPodNamespace'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Both manifests use configured namespace');
    });

    it('should include GPU resource requests in deployment', function () {
        this.timeout(30000);

        console.log('  🧪 Deployment includes GPU resource requests');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render deployment template
                const output = renderTemplate(deploymentTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(output);

                // Get container resources
                const container = deployment.spec.template.spec.containers[0];
                const resources = container.resources;

                assert.ok(
                    resources && resources.requests,
                    'Container must have resource requests'
                );

                assert.ok(
                    resources.requests['nvidia.com/gpu'],
                    'Container must request nvidia.com/gpu'
                );

                assert.ok(
                    resources.limits && resources.limits['nvidia.com/gpu'],
                    'Container must have nvidia.com/gpu limits'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Deployment includes GPU resource requests');
    });

    it('should include GPU tolerations in deployment', function () {
        this.timeout(30000);

        console.log('  🧪 Deployment includes GPU tolerations');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render deployment template
                const output = renderTemplate(deploymentTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(output);

                // Get tolerations
                const tolerations = deployment.spec.template.spec.tolerations;

                assert.ok(
                    tolerations && tolerations.length > 0,
                    'Deployment must have tolerations for GPU nodes'
                );

                // Check for nvidia.com/gpu toleration
                const gpuToleration = tolerations.find(t => t.key === 'nvidia.com/gpu');
                assert.ok(
                    gpuToleration,
                    'Deployment must have nvidia.com/gpu toleration'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Deployment includes GPU tolerations');
    });

    it('should use configured replicas in deployment', function () {
        this.timeout(30000);

        console.log('  🧪 Deployment uses configured hyperPodReplicas');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render deployment template
                const output = renderTemplate(deploymentTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(output);

                // Verify replicas matches configured value
                assert.strictEqual(
                    deployment.spec.replicas,
                    hpVars.hyperPodReplicas,
                    'Deployment replicas must match hyperPodReplicas'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Deployment uses configured replicas');
    });

    it('should include health check probes targeting port 8080', function () {
        this.timeout(30000);

        console.log('  🧪 Health check probes target port 8080');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    ...hpVars
                };

                // Render deployment template
                const output = renderTemplate(deploymentTemplate, vars);

                // Parse as YAML
                const deployment = yaml.load(output);

                // Get container
                const container = deployment.spec.template.spec.containers[0];

                // Check readiness probe
                assert.ok(
                    container.readinessProbe,
                    'Container must have readinessProbe'
                );
                assert.strictEqual(
                    container.readinessProbe.httpGet.port,
                    8080,
                    'readinessProbe must target port 8080'
                );
                assert.strictEqual(
                    container.readinessProbe.httpGet.path,
                    '/ping',
                    'readinessProbe must target /ping endpoint'
                );

                // Check liveness probe
                assert.ok(
                    container.livenessProbe,
                    'Container must have livenessProbe'
                );
                assert.strictEqual(
                    container.livenessProbe.httpGet.port,
                    8080,
                    'livenessProbe must target port 8080'
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ Health check probes target port 8080');
    });
});
