// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL103 — Plain EKS deployment target.
 *
 * Covers the properties and example/edge criteria from the spec's Testing
 * Strategy for the `eks` deployment target: dispatch routing, rendered-resource
 * invariants, conditional kubeconfig, clean scope, engine guards, optimize N/A,
 * and generate-time file emission.
 *
 * Tests are tagged: Feature: v18-w1-01-bl103, Property {n}: {text}
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPERTY_CONFIG_EJS } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');

const readTpl = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

/**
 * True if any non-comment shell line matches `re`. Comment lines (first
 * non-whitespace char is '#') are excluded so explanatory prose about what the
 * script does NOT do cannot trip the assertion — only real command usage does.
 */
function hasCommand(src, re) {
    return src.split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .some((line) => re.test(line));
}

const deployContent = readTpl('templates/do/deploy');
const cleanContent = readTpl('templates/do/clean');
const optimizeContent = readTpl('templates/do/optimize');
const draftContent = readTpl('templates/do/draft');
const testContent = readTpl('templates/do/test');
const benchmarkContent = readTpl('templates/do/benchmark');

const deployEksPath = path.join(REPO, 'templates/do/deploy.d/eks');
const cleanEksPath = path.join(REPO, 'templates/do/clean.d/eks');
const eksDir = path.join(REPO, 'templates/eks');

/** Render an eks manifest .ejs and resolve shell placeholders to defaults. */
function renderManifest(name, vars) {
    let out = ejs.render(readTpl(`templates/eks/${name}.yaml.ejs`), vars);
    // Resolve ${VAR:-default} → default, and bare ${VAR} → stub.
    out = out
        .replace(/\$\{[A-Za-z0-9_]+:-([^}]*)\}/g, '$1')
        .replace(/\$\{[A-Za-z0-9_]+\}/g, 'stub-value');
    return out;
}

const manifestVarsArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    framework: fc.constantFrom('transformers', 'diffusors'),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    modelName: fc.constantFrom('meta-llama/Llama-3.1-8B-Instruct', 'mistralai/Mistral-7B-v0.1'),
    HP_GPU_COUNT: fc.constantFrom('1', '2', '4', '8')
});

describe('BL103: Plain EKS deployment target', () => {
    // ── Property 1 / edge 1.2 ────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 1: Target token routes to its deploy implementation', () => {
        it('do/deploy dispatches eks → deploy.d/eks', () => {
            assert.ok(
                deployContent.includes('deploy.d/eks'),
                'dispatcher must source deploy.d/eks'
            );
            assert.ok(
                /eks\)\s*\n\s*source "\$\{SCRIPT_DIR\}\/deploy\.d\/eks"/.test(deployContent),
                'dispatcher must have an eks) case arm sourcing deploy.d/eks'
            );
        });

        it('deploy.d/eks exists', () => {
            assert.ok(existsSync(deployEksPath), 'templates/do/deploy.d/eks must exist');
        });

        it('(edge 1.2) dispatcher recognizes eks as a valid target (no unknown-target error)', () => {
            // eks appears in the valid-targets error string and the --target help.
            assert.ok(
                deployContent.includes('hyperpod-eks, eks'),
                'valid-targets error must include eks'
            );
        });
    });

    // ── Property 2 & 3 ───────────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 2: eks deploy renders exactly Deployment, Service, and ConfigMap', () => {
        it('renders exactly {Deployment, Service, ConfigMap}, each valid YAML', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(manifestVarsArb, (vars) => {
                const kinds = ['Deployment', 'Service', 'ConfigMap'].map((n) => {
                    const doc = yaml.load(renderManifest(n, vars));
                    assert.ok(doc && doc.kind, `${n} must render valid YAML with a kind`);
                    return doc.kind;
                }).sort();
                assert.deepStrictEqual(kinds, ['ConfigMap', 'Deployment', 'Service']);
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });
    });

    describe('Feature: v18-w1-01-bl103, Property 3: eks deploy never renders an InferenceEndpointConfig CRD', () => {
        it('no eks manifest is an InferenceEndpointConfig, and deploy.d/eks issues no CRD kubectl', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(manifestVarsArb, (vars) => {
                for (const n of ['Deployment', 'Service', 'ConfigMap']) {
                    const doc = yaml.load(renderManifest(n, vars));
                    assert.notStrictEqual(doc.kind, 'InferenceEndpointConfig');
                }
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });

            const deployEks = readFileSync(deployEksPath, 'utf8');
            assert.ok(!hasCommand(deployEks, /inferenceendpointconfig/i),
                'deploy.d/eks must not issue an inferenceendpointconfig command');
            assert.ok(!existsSync(path.join(eksDir, 'InferenceEndpointConfig.yaml.ejs')),
                'templates/eks must not contain an InferenceEndpointConfig template');
        });
    });

    // ── Property 4 ───────────────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 4: Kubeconfig update runs iff HP_CLUSTER_NAME is set', () => {
        it('deploy.d/eks guards update-kubeconfig on a non-empty HP_CLUSTER_NAME', () => {
            const src = readFileSync(deployEksPath, 'utf8');
            assert.ok(src.includes('aws eks update-kubeconfig'),
                'must call aws eks update-kubeconfig');
            assert.ok(/if \[ -n "\$\{HP_CLUSTER_NAME:-\}" \]; then/.test(src),
                'update-kubeconfig must be gated on HP_CLUSTER_NAME being set');
            assert.ok(src.includes('ambient kubectl context'),
                'must fall back to the ambient kubectl context when HP_CLUSTER_NAME is unset');
        });
    });

    // ── Property 5 & 6 ───────────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 5: Clean deletes exactly the three Kubernetes objects', () => {
        it('clean.d/eks deletes deployment,service,configmap and nothing else K8s', () => {
            assert.ok(existsSync(cleanEksPath), 'clean.d/eks must exist');
            const src = readFileSync(cleanEksPath, 'utf8');
            assert.ok(/kubectl delete deployment,service,configmap/.test(src),
                'must delete deployment,service,configmap');
            // Must NOT issue an InferenceEndpointConfig or SageMakerEndpointRegistration command.
            assert.ok(!hasCommand(src, /inferenceendpointconfig/i),
                'clean.d/eks must not issue an InferenceEndpointConfig command');
            assert.ok(!hasCommand(src, /sagemakerendpointregistration/i),
                'clean.d/eks must not touch SageMakerEndpointRegistration');
        });
    });

    describe('Feature: v18-w1-01-bl103, Property 6: Clean performs no SageMaker cleanup', () => {
        it('clean.d/eks issues no aws sagemaker delete/describe-endpoint calls', () => {
            const src = readFileSync(cleanEksPath, 'utf8');
            assert.ok(!hasCommand(src, /aws sagemaker delete/i),
                'clean.d/eks must not call aws sagemaker delete-*');
            assert.ok(!hasCommand(src, /aws sagemaker describe-endpoint|\bdescribe-endpoint\b/i),
                'clean.d/eks must not describe SageMaker endpoints');
            // do/clean dispatcher routes eks → clean.d/eks
            assert.ok(cleanContent.includes('clean.d/eks'),
                'do/clean must route eks to clean.d/eks');
        });
    });

    // ── Property 7 & 8 ───────────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 7: Draft engine guard passes vllm and sglang on eks', () => {
        it('do/draft target guard allows eks and engine guard passes vllm/sglang', () => {
            assert.ok(
                /DEPLOYMENT_TARGET:-\}" != "hyperpod-eks" \] && \[ "\$\{DEPLOYMENT_TARGET:-\}" != "eks" \]/.test(draftContent),
                'do/draft target guard must allow both hyperpod-eks and eks'
            );
            // vllm|sglang remains an accepted engine arm.
            assert.ok(/vllm\|sglang\)/.test(draftContent),
                'engine guard must accept vllm|sglang');
        });
    });

    describe('Feature: v18-w1-01-bl103, Property 8: Draft engine guard does not hard-error on tgi/triton on eks', () => {
        it('tgi/triton are handled as a soft warning, not a hard error', () => {
            assert.ok(/tgi\|triton\)/.test(draftContent),
                'engine guard must have a tgi|triton arm (soft, no hard error)');
            // Extract the tgi|triton arm body and assert it does not exit non-zero.
            const idx = draftContent.indexOf('tgi|triton)');
            const armBody = draftContent.slice(idx, idx + 400);
            assert.ok(!/exit 1/.test(armBody),
                'tgi|triton arm must not hard-error (exit 1)');
        });
    });

    // ── Property 9 / edge 9.1 ────────────────────────────────────────────────
    describe('Feature: v18-w1-01-bl103, Property 9: Generating with eks selected emits the eks target files', () => {
        it('the eks target files exist and render cleanly (non-empty, no EJS errors)', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            assert.ok(existsSync(deployEksPath), 'do/deploy.d/eks must exist');
            assert.ok(existsSync(cleanEksPath), 'do/clean.d/eks must exist');
            for (const n of ['Deployment', 'Service', 'ConfigMap']) {
                assert.ok(existsSync(path.join(eksDir, `${n}.yaml.ejs`)),
                    `templates/eks/${n}.yaml.ejs must exist`);
            }
            fc.assert(fc.property(manifestVarsArb, (vars) => {
                for (const n of ['Deployment', 'Service', 'ConfigMap']) {
                    const out = renderManifest(n, vars);
                    assert.ok(out.trim().length > 0, `${n} must render non-empty`);
                }
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });

        it('(edge 9.1) parameter-schema-v2.json deploymentTarget enum includes eks', () => {
            const schema = JSON.parse(readTpl('config/parameter-schema-v2.json'));
            const enumVals = schema.parameters.deploymentTarget.validation.enum;
            assert.ok(enumVals.includes('eks'), 'deploymentTarget enum must include eks');
        });
    });

    // ── Edge/example tests for single-token deterministic criteria ───────────
    describe('BL103 example/edge criteria', () => {
        it('(edge 5.1) do/test routes eks to a pod port-forward, not invoke-endpoint', () => {
            assert.ok(/eks\)\s*\n\s*_test_eks "\$@"/.test(testContent),
                'do/test must dispatch eks → _test_eks');
            const idx = testContent.indexOf('_test_eks()');
            const fnBody = testContent.slice(idx, idx + 4000);
            assert.ok(fnBody.includes('kubectl port-forward'),
                '_test_eks must use kubectl port-forward');
            assert.ok(!fnBody.includes('sagemaker-runtime invoke-endpoint'),
                '_test_eks must not call sagemaker-runtime invoke-endpoint');
        });

        it('(edge 6.1/6.2) do/benchmark reaches the pod via port-forward and fails fast', () => {
            const idx = benchmarkContent.indexOf('DEPLOYMENT_TARGET:-}" = "eks"');
            assert.ok(idx >= 0, 'benchmark must have an eks branch');
            const branch = benchmarkContent.slice(idx, idx + 4000);
            assert.ok(branch.includes('kubectl port-forward'),
                'eks benchmark must port-forward to the pod');
            assert.ok(/port-forward .* failed/i.test(branch),
                'eks benchmark must fail fast with a clear port-forward error');
        });

        it('(edge 7.1) do/optimize is N/A for eks and exits non-zero', () => {
            assert.ok(/DEPLOYMENT_TARGET:-\}" = "eks"/.test(optimizeContent),
                'optimize must guard on eks');
            const idx = optimizeContent.indexOf('= "eks"');
            const branch = optimizeContent.slice(idx, idx + 300);
            assert.ok(/N\/A for eks target/.test(branch),
                'optimize must print an "N/A for eks target" message');
            assert.ok(/exit 1/.test(branch), 'optimize eks guard must exit non-zero');
        });
    });
});
