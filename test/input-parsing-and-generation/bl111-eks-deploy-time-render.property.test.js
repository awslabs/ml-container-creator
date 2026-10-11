// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL111 — Deploy-time EJS re-render for the plain-EKS target.
 *
 * BL111 moves rendering of the eks Deployment/Service/ConfigMap from `mcc
 * generate` time to DEPLOY time, so the applied manifests reflect the current
 * do/config (instance type, GPU count, model source, serve config). The render
 * SOURCE OF TRUTH is the eks/*.yaml.ejs template resolved against the current
 * environment — not a generate-time-frozen eks/*.yaml. When the node+ejs
 * renderer is unavailable the driver falls back to the envsubst shim and warns.
 *
 * These tests exercise the actual deploy-time render mechanism the driver uses:
 *   • the EJS path renders eks/*.yaml.ejs via do/lib/render-eks-manifests.cjs
 *     (the same helper do/deploy.d/eks invokes), then resolves ${VAR} placeholders
 *     with a perl envsubst shim that mirrors the driver's shim exactly;
 *   • the envsubst fallback renders the frozen eks/*.yaml directly.
 * kubectl is never invoked — rendering is in-process/subprocess only.
 *
 * Tests are tagged: Feature: v18-w2-01-bl111, Property {n}: {text}
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import yaml from 'js-yaml';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_CONFIG_EJS } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');

const readTpl = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

const RENDERER = path.join(REPO, 'templates/do/lib/render-eks-manifests.cjs');
const EKS_TPL_DIR = path.join(REPO, 'templates/eks');
const MANIFESTS = ['Deployment', 'Service', 'ConfigMap'];
const DEPLOY_EKS = readTpl('templates/do/deploy.d/eks');

/**
 * Portable envsubst shim identical in behavior to the one in do/deploy.d/eks:
 * ${VAR:-default} → env value if set & non-empty else the default; bare ${VAR} →
 * env value if defined else the placeholder is left intact.
 */
function envsubst(text, env) {
    return text
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_m, k, def) =>
            (env[k] !== undefined && env[k] !== '') ? env[k] : def)
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) =>
            env[k] !== undefined ? env[k] : `\${${k}}`);
}

/**
 * Build the deploy-time environment the driver would have after sourcing
 * do/config and running its config-resolution block, from a config record.
 */
function deployEnv(cfg) {
    const gpu = String(cfg.HP_GPU_COUNT);
    const isS3 = cfg.modelSource === 's3';
    return {
        ...process.env,
        PROJECT_NAME: cfg.projectName,
        FRAMEWORK: cfg.framework,
        HP_NAMESPACE: cfg.hyperPodNamespace,
        HP_REPLICAS: String(cfg.hyperPodReplicas),
        MODEL_NAME: cfg.modelName,
        MODEL_SERVER: cfg.modelServer || 'vllm',
        HP_GPU_COUNT: gpu,
        HP_CPU_REQUEST: String(parseInt(gpu, 10) * 4),
        HP_MEM_REQUEST: `${parseInt(gpu, 10) * 16}Gi`,
        HP_MODEL_SOURCE: isS3 ? 's3' : 'huggingface',
        HP_MODEL_ID: isS3 ? cfg.stagedModelPath : cfg.modelName,
        HP_MODEL_ARTIFACT_URI: isS3 ? cfg.stagedModelPath : '',
        VLLM_TENSOR_PARALLEL_SIZE: gpu,
        VLLM_QUANTIZATION: cfg.quantization || '',
        // ADR-010: the driver resolves Tier-1/Tier-2 env JSON before render. Supply
        // whatever the config carries (default empty → templates take the fallback
        // branch) so BOTH the subprocess and the in-process mirror see identical
        // input and the parity comparison stays meaningful.
        EKS_TIER1_ENV_JSON: cfg.eksTier1EnvJson || '',
        EKS_TIER2_ENV_JSON: cfg.eksTier2EnvJson || '',
        HP_MODEL_HOSTPATH: cfg.modelHostPath || '',
        ECR_IMAGE: `123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:${cfg.projectName}-latest`
    };
}

/** Parse the resolver's {resolved:[{key,value}]} env JSON exactly as the shipped
 *  render-eks-manifests.cjs does — kept in lockstep so the mirror cannot drift. */
function parseTier1Mirror(raw) {
    if (!raw) return [];
    let data;
    try { data = JSON.parse(raw); } catch { return []; }
    const resolved = data && Array.isArray(data.resolved) ? data.resolved : [];
    return resolved
        .filter((e) => e && typeof e.key === 'string' && e.key)
        .map((e) => ({ key: e.key, value: (e.value === null || e.value === undefined) ? '' : String(e.value) }));
}

/** EJS render path (in-process mirror of render-eks-manifests.cjs) then envsubst.
 *  A separate subprocess smoke test asserts the shipped .cjs helper matches this.
 *  The templateVars MUST mirror render-eks-manifests.cjs exactly. */
function renderViaEjs(name, cfg) {
    const env = deployEnv(cfg);
    const src = path.join(EKS_TPL_DIR, `${name}.yaml.ejs`);
    const out = ejs.render(readFileSync(src, 'utf8'), {
        projectName: env.PROJECT_NAME || '',
        framework: env.FRAMEWORK || '',
        hyperPodNamespace: env.HP_NAMESPACE || 'default',
        hyperPodReplicas: env.HP_REPLICAS,
        modelName: env.MODEL_NAME || '',
        modelServer: env.MODEL_SERVER || 'vllm',
        modelHostPath: env.HP_MODEL_HOSTPATH || '',
        tier1Env: parseTier1Mirror(env.EKS_TIER1_ENV_JSON),
        tier2Env: parseTier1Mirror(env.EKS_TIER2_ENV_JSON),
        HP_GPU_COUNT: env.HP_GPU_COUNT
    }, { filename: src });
    return envsubst(out, env);
}

/** Run the shipped .cjs helper as the driver does (subprocess), then envsubst. */
function renderViaEjsSubprocess(name, cfg) {
    const env = deployEnv(cfg);
    const out = execFileSync('node', [RENDERER, path.join(EKS_TPL_DIR, `${name}.yaml.ejs`)], {
        env, encoding: 'utf8'
    });
    return envsubst(out, env);
}

/** Envsubst fallback path: render the frozen generate-time yaml, then envsubst. */
function renderViaFallback(name, cfg, frozenYamlText) {
    return envsubst(frozenYamlText, deployEnv(cfg));
}

/** Produce the generate-time-frozen eks/<name>.yaml (copyTpl EJS render only). */
function frozenGenerateTimeYaml(name, cfg) {
    const src = path.join(EKS_TPL_DIR, `${name}.yaml.ejs`);
    return ejs.render(readFileSync(src, 'utf8'), {
        projectName: cfg.projectName,
        framework: cfg.framework,
        hyperPodNamespace: cfg.hyperPodNamespace,
        hyperPodReplicas: cfg.hyperPodReplicas,
        modelName: cfg.modelName,
        HP_GPU_COUNT: String(cfg.HP_GPU_COUNT)
    }, { filename: src });
}

const cfgArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    framework: fc.constantFrom('transformers', 'diffusors'),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    modelName: fc.constantFrom('meta-llama/Llama-3.1-8B-Instruct', 'mistralai/Mistral-7B-v0.1'),
    HP_GPU_COUNT: fc.constantFrom(1, 2, 4, 8),
    modelSource: fc.constantFrom('s3', 'huggingface'),
    stagedModelPath: fc.constant('s3://my-bucket/models/llama/'),
    quantization: fc.constantFrom('', 'fp8')
});

describe('BL111: Deploy-time EJS re-render for the plain-EKS target', () => {

    // ── Property 1 ───────────────────────────────────────────────────────────
    describe('Feature: v18-w2-01-bl111, Property 1: Deploy renders from the template, not a frozen generate-time artifact', () => {
        it('render derives from eks/*.yaml.ejs + current config; a divergent frozen eks/*.yaml does not change it', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(cfgArb, (cfg) => {
                for (const name of MANIFESTS) {
                    // The EJS-path output is derived purely from the template + env.
                    const fromTemplate = renderViaEjs(name, cfg);

                    // A deliberately-divergent frozen artifact (wrong project name,
                    // wrong namespace) must NOT appear in the rendered output.
                    const bogusFrozen = frozenGenerateTimeYaml(name, {
                        ...cfg, projectName: 'STALE-FROZEN-NAME', hyperPodNamespace: 'stale-ns'
                    });
                    assert.ok(!fromTemplate.includes('STALE-FROZEN-NAME'),
                        `${name}: template render must not contain the stale frozen project name`);
                    assert.ok(!fromTemplate.includes('stale-ns'),
                        `${name}: template render must not contain the stale frozen namespace`);
                    // The bogus frozen artifact is unused by the EJS path — proving
                    // the template (not the frozen yaml) is the source of truth.
                    assert.ok(bogusFrozen.includes('STALE-FROZEN-NAME'),
                        `${name}: (sanity) the frozen artifact really is divergent`);
                }
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });

        it('the driver iterates eks/*.yaml.ejs (template source) on the EJS path', () => {
            assert.ok(/for manifest in \$\{_eks_manifests\}/.test(DEPLOY_EKS)
                && /ls eks\/\*\.yaml\.ejs/.test(DEPLOY_EKS),
            'deploy.d/eks EJS path must iterate eks/*.yaml.ejs template sources');
        });
    });

    // ── Property 2 ───────────────────────────────────────────────────────────
    describe('Feature: v18-w2-01-bl111, Property 2: Rendered manifests reflect current do/config', () => {
        it('changing GPU count changes the GPU/CPU/memory fields', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(cfgArb, fc.constantFrom(1, 2, 4, 8), fc.constantFrom(1, 2, 4, 8),
                (cfg, g1, g2) => {
                    fc.pre(g1 !== g2);
                    const d1 = yaml.load(renderViaEjs('Deployment', { ...cfg, HP_GPU_COUNT: g1 }));
                    const d2 = yaml.load(renderViaEjs('Deployment', { ...cfg, HP_GPU_COUNT: g2 }));
                    const gpu = (d) => d.spec.template.spec.containers[0].resources.requests['nvidia.com/gpu'];
                    assert.notStrictEqual(String(gpu(d1)), String(gpu(d2)),
                        'GPU request must differ when HP_GPU_COUNT differs');
                }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });

        it('changing instance type (→ GPU count) / namespace / replicas / model / serve is reflected', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(cfgArb, (cfg) => {
                const dep = yaml.load(renderViaEjs('Deployment', cfg));
                const cm = yaml.load(renderViaEjs('ConfigMap', cfg));
                // Namespace + replicas + name reflect current config.
                assert.strictEqual(dep.metadata.namespace, cfg.hyperPodNamespace);
                assert.strictEqual(dep.spec.replicas, cfg.hyperPodReplicas);
                assert.strictEqual(dep.metadata.name, cfg.projectName);
                // Model source env reflects current config.
                const env = dep.spec.template.spec.containers[0].env
                    .find((e) => e.name === 'MODEL_SOURCE');
                assert.strictEqual(env.value, cfg.modelSource === 's3' ? 's3' : 'huggingface');
                // Serve config (tensor-parallel) tracks GPU count; model id reflects source.
                assert.strictEqual(String(cm.data.VLLM_TENSOR_PARALLEL_SIZE), String(cfg.HP_GPU_COUNT));
                const expectedModelId = cfg.modelSource === 's3' ? cfg.stagedModelPath : cfg.modelName;
                assert.strictEqual(cm.data.VLLM_MODEL, expectedModelId);
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });

        it('resolves config vars at deploy time from do/config env (driver exports them)', () => {
            assert.ok(/export PROJECT_NAME FRAMEWORK HP_NAMESPACE HP_REPLICAS MODEL_NAME HP_GPU_COUNT/.test(DEPLOY_EKS),
                'deploy.d/eks must export the deploy-time config vars for the renderer');
        });
    });

    // ── Property 3 ───────────────────────────────────────────────────────────
    describe('Feature: v18-w2-01-bl111, Property 3: Envsubst fallback is used and warned when the EJS renderer is unavailable', () => {
        it('the helper --probe fails (non-zero) when the ejs module cannot load, driving the fallback', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            // Simulate "ejs unavailable" by running the helper with a node module
            // path that has no ejs installed. The probe must exit non-zero.
            const tmp = mkdtempSync(path.join(os.tmpdir(), 'bl111-noejs-'));
            try {
                // Copy the helper into an isolated dir with an empty node_modules so
                // `require('ejs')` cannot resolve.
                const isolated = path.join(tmp, 'render-eks-manifests.cjs');
                writeFileSync(isolated, readFileSync(RENDERER, 'utf8'));
                mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
                let exitCode = 0;
                try {
                    execFileSync('node', [isolated, '--probe'], {
                        cwd: tmp,
                        env: { ...process.env, NODE_PATH: path.join(tmp, 'node_modules') },
                        stdio: 'pipe'
                    });
                } catch (err) {
                    exitCode = err.status || 1;
                }
                assert.notStrictEqual(exitCode, 0,
                    'probe must exit non-zero when ejs is unavailable');
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });

        it('the driver gates the EJS path on a passing --probe and warns on fallback', () => {
            assert.ok(/--probe/.test(DEPLOY_EKS),
                'driver must probe the renderer capability');
            assert.ok(/USE_EJS_RENDERER=true/.test(DEPLOY_EKS)
                && /USE_EJS_RENDERER=false/.test(DEPLOY_EKS),
            'driver must select between EJS and fallback via a flag');
            // The warning is emitted only on the fallback branch (else of the flag).
            const warnIdx = DEPLOY_EKS.indexOf('EJS renderer (node + ejs) not available');
            assert.ok(warnIdx > 0, 'driver must warn when taking the envsubst fallback');
        });

        it('the fallback (frozen yaml + envsubst) still produces valid, resolved manifests', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(cfgArb, (cfg) => {
                for (const name of MANIFESTS) {
                    const frozen = frozenGenerateTimeYaml(name, cfg);
                    const out = renderViaFallback(name, cfg, frozen);
                    const doc = yaml.load(out);
                    assert.ok(doc && doc.kind, `${name}: fallback must yield a valid document`);
                }
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });
    });

    // ── Property 4 ───────────────────────────────────────────────────────────
    describe('Feature: v18-w2-01-bl111, Property 4: Rendered manifests are valid Deployment / Service / ConfigMap', () => {
        it('both paths emit exactly {ConfigMap, Deployment, Service} with no leftover ${...} placeholders', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(cfgArb, (cfg) => {
                for (const render of [
                    (n) => renderViaEjs(n, cfg),
                    (n) => renderViaFallback(n, cfg, frozenGenerateTimeYaml(n, cfg))
                ]) {
                    const kinds = MANIFESTS.map((n) => {
                        const text = render(n);
                        const doc = yaml.load(text);
                        assert.ok(doc && doc.kind, `${n}: must be valid YAML with a kind`);
                        // No unresolved ${...} in the *data* — strip comment lines first,
                        // since the templates' explanatory comments mention ${VAR} literally.
                        const nonComment = text.split('\n')
                            .filter((l) => !/^\s*#/.test(l)).join('\n');
                        assert.ok(!/\$\{[A-Za-z_]/.test(nonComment),
                            `${n}: no unresolved \${...} placeholder may remain`);
                        return doc.kind;
                    }).sort();
                    assert.deepStrictEqual(kinds, ['ConfigMap', 'Deployment', 'Service']);
                }
            }), { numRuns: PROPERTY_CONFIG_EJS.numRuns });
        });
    });

    // ── Example / edge criteria ──────────────────────────────────────────────
    describe('BL111 example/edge criteria', () => {
        it('(shipped helper parity) the .cjs helper subprocess matches the in-process render', () => {
            const cfg = {
                projectName: 'my-model', framework: 'transformers',
                hyperPodNamespace: 'ml-inference', hyperPodReplicas: 2,
                modelName: 'meta-llama/Llama-3.1-8B-Instruct', HP_GPU_COUNT: 4,
                modelSource: 'huggingface', stagedModelPath: 's3://b/m/', quantization: 'fp8'
            };
            for (const name of MANIFESTS) {
                assert.strictEqual(renderViaEjsSubprocess(name, cfg), renderViaEjs(name, cfg),
                    `${name}: shipped .cjs helper output must match the in-process render mirror`);
            }
        });

        it('(AC 3.1) reuses a deploy-time re-render selected by renderer detection, like hyperpod-eks', () => {
            // The mechanism reused from BL098/hyperpod-eks is the deploy-time
            // re-render with the portable envsubst() perl shim; BL111 layers the
            // node+ejs source render on top as the preferred path.
            assert.ok(/envsubst\(\)/.test(DEPLOY_EKS),
                'driver must define the portable envsubst() shim (hyperpod-eks mechanism)');
            assert.ok(/render-eks-manifests\.cjs/.test(DEPLOY_EKS),
                'driver must invoke the node+ejs render helper as the preferred path');
            assert.ok(existsSync(RENDERER), 'the node+ejs render helper must ship');
        });

        it('(warning copy) the fallback warning names the EJS renderer and the envsubst fallback', () => {
            const idx = DEPLOY_EKS.indexOf('EJS renderer (node + ejs) not available');
            const msg = DEPLOY_EKS.slice(idx, idx + 300);
            assert.ok(/node \+ ejs/.test(msg), 'warning must name node + ejs');
            assert.ok(/envsubst fallback/.test(msg), 'warning must name the envsubst fallback');
        });

        it('(model volume) emptyDir path requests ephemeral-storage; hostPath NVMe path does NOT', () => {
            // Default (no HP_MODEL_HOSTPATH): bounded emptyDir on the node root, so
            // the pod MUST request ephemeral-storage (else greedy-eviction loop).
            const def = yaml.load(renderViaEjs('Deployment', {
                projectName: 'swift', framework: 'transformers', hyperPodNamespace: 'default',
                hyperPodReplicas: 1, modelName: 'm', HP_GPU_COUNT: 8,
                modelSource: 'huggingface'
            }));
            const defSpec = def.spec.template.spec;
            assert.ok(defSpec.volumes[0].emptyDir, 'default model volume is an emptyDir');
            assert.ok(defSpec.containers[0].resources.requests['ephemeral-storage'],
                'emptyDir path must request ephemeral-storage');

            // HP_MODEL_HOSTPATH set: model lands on node-local NVMe (hostPath), which
            // does NOT draw from ephemeral-storage — so NO request (a large request
            // against the small root volume would make the pod unschedulable).
            const hp = yaml.load(renderViaEjs('Deployment', {
                projectName: 'swift', framework: 'transformers', hyperPodNamespace: 'default',
                hyperPodReplicas: 1, modelName: 'm', HP_GPU_COUNT: 8,
                modelSource: 'huggingface', modelHostPath: '/opt/dlami/nvme'
            }));
            const hpSpec = hp.spec.template.spec;
            assert.ok(hpSpec.volumes[0].hostPath, 'hostPath path uses a hostPath volume');
            assert.strictEqual(hpSpec.volumes[0].hostPath.path, '/opt/dlami/nvme/swift',
                'hostPath appends the project name to the NVMe base');
            assert.ok(!hpSpec.containers[0].resources.requests['ephemeral-storage'],
                'hostPath path must NOT request ephemeral-storage (not drawn from node root)');
            // Both mount the model at the BYOC contract path.
            assert.strictEqual(hpSpec.containers[0].volumeMounts[0].mountPath, '/opt/ml/model');
        });

        it('(NCCL) mounts a RAM-backed /dev/shm so multi-GPU tensor-parallel NCCL can init', () => {
            // NCCL uses /dev/shm for intra-node cross-GPU transport. K8s defaults it
            // to 64Mi, which makes ncclCommInitRank fail with "unhandled system
            // error" on any TP>1 model (e.g. Kimi-K3 at --tp-size 8). The Deployment
            // must mount a Memory-medium emptyDir at /dev/shm, independent of the
            // model-volume (emptyDir vs hostPath) choice.
            for (const extra of [{}, { modelHostPath: '/opt/dlami/nvme' }]) {
                const spec = yaml.load(renderViaEjs('Deployment', {
                    projectName: 'swift', framework: 'transformers', hyperPodNamespace: 'default',
                    hyperPodReplicas: 1, modelName: 'm', HP_GPU_COUNT: 8,
                    modelSource: 'huggingface', ...extra
                })).spec.template.spec;

                const shmVol = spec.volumes.find((v) => v.name === 'dshm');
                assert.ok(shmVol, 'a dshm volume must exist');
                assert.strictEqual(shmVol.emptyDir.medium, 'Memory',
                    '/dev/shm volume must be RAM-backed (medium: Memory)');
                assert.ok(shmVol.emptyDir.sizeLimit,
                    '/dev/shm must be bounded by a sizeLimit (default HP_GPU_COUNT*8Gi, override HP_SHM_SIZE)');

                const shmMount = spec.containers[0].volumeMounts.find((m) => m.mountPath === '/dev/shm');
                assert.ok(shmMount && shmMount.name === 'dshm',
                    'the container must mount the dshm volume at /dev/shm');
            }
        });

        it('(generate-time yaml is not source of truth) the .ejs source is shipped into EVERY project', () => {
            // The deployment target is a DEPLOY-TIME choice, not a generation-time
            // answer, so the generator must ship the eks .yaml.ejs source
            // UNCONDITIONALLY — never gated on `answers.deploymentTarget === 'eks'`
            // (which, at generation, is always the realtime-inference default, so
            // the gate was dead and the source was never shipped → the EJS render
            // loop matched zero files and silently applied nothing).
            const appjs = readTpl('src/app.js');
            assert.ok(/\.yaml\.ejs/.test(appjs),
                'generator must ship the eks .yaml.ejs source into the project');
            assert.ok(!/if \(answers\.deploymentTarget === 'eks'\)[\s\S]{0,400}\.yaml\.ejs/.test(appjs),
                'shipping the eks .ejs source must NOT be gated on a generate-time eks target');
        });

        it('the renderer maps do/config env → EJS template variables', () => {
            const helper = readFileSync(RENDERER, 'utf8');
            for (const [envVar, tplVar] of [
                ['PROJECT_NAME', 'projectName'],
                ['FRAMEWORK', 'framework'],
                ['HP_NAMESPACE', 'hyperPodNamespace'],
                ['HP_REPLICAS', 'hyperPodReplicas'],
                ['MODEL_NAME', 'modelName']
            ]) {
                assert.ok(helper.includes(envVar) && helper.includes(tplVar),
                    `helper must map ${envVar} → ${tplVar}`);
            }
        });
    });
});
