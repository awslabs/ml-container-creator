// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL115 — LoRA enabled by default across all vLLM deployment targets.
 *
 * Covers the requirements and correctness properties from
 * .kiro/specs/v18-w4-04-bl115/{requirements,design}.md:
 *   - Req 1: the three LoRA params apply to every vLLM target (schema).
 *   - Req 2: do/config defaults ENABLE_LORA=true (managed) and
 *            HP_LORA_ENABLED=true (hyperpod-eks/eks) for vLLM configs.
 *   - Req 3: the InferenceEndpointConfig CRD emits VLLM_ENABLE_LORA=true when
 *            HP_LORA_ENABLED === 'true', and omits it otherwise.
 *   - Req 4: the vLLM serve wrapper forwards whitelisted VLLM_* vars as flags
 *            (--enable-lora, --max-loras N, --max-lora-rank N) — values 30/64,
 *            NOT a hardcoded --max-loras 4.
 *   - Req 5: the eks target ConfigMap emits VLLM_ENABLE_LORA=true when LoRA on.
 *   - Req 6: do/deploy warns when LoRA-on AND HP_SPECULATIVE_ALGORITHM set.
 *   - Req 7: ENABLE_LORA=false / HP_LORA_ENABLED=false opt-out preserved.
 *
 * Tests are tagged: Feature: v18-w4-04-bl115, Property {n}: {text}
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';
import { capabilityMap } from '../../src/lib/serve-manifest-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');
const readTpl = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

// The full set of vLLM deployment targets per the spec glossary.
const VLLM_TARGETS = ['managed-inference', 'hyperpod-eks', 'async-inference', 'batch-transform', 'eks'];
const LORA_PARAMS = ['enableLora', 'maxLoras', 'maxLoraRank'];

const schema = JSON.parse(readTpl('config/parameter-schema-v2.json'));

// Minimal, complete do/config render context (mirrors the shared config render
// helper used by sibling tests). Callers override via `answers`.
function renderConfig(answers = {}) {
    const tpl = readTpl('templates/do/config');
    return ejs.render(tpl, {
        orderedEnvVars: [],
        baseImage: '',
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        ngcApiKey: undefined,
        icCpuCount: undefined,
        icMemorySize: undefined,
        icGpuCount: 1,
        icCopyCount: undefined,
        icModelWeight: undefined,
        endpointInitialInstanceCount: undefined,
        endpointDataCapturePercent: undefined,
        endpointVariantName: undefined,
        endpointVolumeSize: undefined,
        modelEnvVars: {},
        serverEnvVars: {},
        icEnvVars: {},
        asyncMaxConcurrentInvocations: undefined,
        asyncSnsSuccessTopic: undefined,
        asyncSnsErrorTopic: undefined,
        batchInstanceCount: undefined,
        batchSplitType: 'Line',
        batchStrategy: 'SingleRecord',
        batchJoinSource: 'None',
        batchMaxConcurrentTransforms: undefined,
        batchMaxPayloadInMB: undefined,
        hyperPodCluster: '',
        hyperPodNamespace: 'default',
        hyperPodReplicas: 1,
        fsxVolumeHandle: undefined,
        instancePools: undefined,
        capacityReservationArn: undefined,
        deploy_mode: undefined,
        existingEndpointName: undefined,
        enableLora: undefined,
        hfToken: undefined,
        hfTokenArn: undefined,
        ngcTokenArn: undefined,
        modelName: 'meta-llama/Llama-2-7b-hf',
        tuneSupported: undefined,
        tuneModelId: undefined,
        container_image_uri: undefined,
        modelFormat: undefined,
        includeBenchmark: undefined,
        benchmarkConcurrency: undefined,
        benchmarkInputTokensMean: undefined,
        benchmarkOutputTokensMean: undefined,
        benchmarkStreaming: undefined,
        benchmarkRequestCount: undefined,
        benchmarkS3OutputPath: undefined,
        ciBenchmarkResultsBucket: undefined,
        roleArn: undefined,
        ...answers
    });
}

// ── Requirement 1 / Property 1 ────────────────────────────────────────────────
// For any LoRA param p and any vLLM target t, t ∈ p.appliesTo.deploymentTargets.
describe('BL115 — LoRA params apply to every vLLM target (Req 1)', () => {
    it('retains enableLora default true, maxLoras 30, maxLoraRank 64', () => {
        assert.strictEqual(schema.parameters.enableLora.default, true);
        assert.strictEqual(schema.parameters.maxLoras.default, 30);
        assert.strictEqual(schema.parameters.maxLoraRank.default, 64);
    });

    // Feature: v18-w4-04-bl115, Property 1: LoRA parameters apply to every vLLM target
    it('Property 1: every LoRA param lists every vLLM target', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...LORA_PARAMS),
                fc.constantFrom(...VLLM_TARGETS),
                (param, target) => {
                    const targets = schema.parameters[param].appliesTo.deploymentTargets;
                    assert.ok(
                        targets.includes(target),
                        `${param}.appliesTo.deploymentTargets missing ${target}: ${JSON.stringify(targets)}`
                    );
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('preserves architectures=["transformers"] and maps LoRA params to capabilities (ADR-010)', () => {
        assert.deepStrictEqual(schema.parameters.enableLora.appliesTo.architectures, ['transformers']);
        // ADR-010: serverMapping no longer PINS a VLLM_ env var — the concrete env
        // var is DERIVED per-engine from serve.d/<engine>/manifest.json
        // capability_map. The schema names the capability; the engine owns the name.
        assert.strictEqual(schema.parameters.enableLora.serverMapping.capability, 'lora_enable');
        assert.strictEqual(schema.parameters.enableLora.serverMapping.booleanFlag, true);
        assert.strictEqual(schema.parameters.maxLoras.serverMapping.capability, 'lora_max');
        assert.strictEqual(schema.parameters.maxLoraRank.serverMapping.capability, 'lora_max_rank');
        // No stale hardcoded engine env var remains on these entries.
        for (const p of ['enableLora', 'maxLoras', 'maxLoraRank']) {
            assert.ok(
                !('envVar' in schema.parameters[p].serverMapping),
                `${p}.serverMapping must not pin a hardcoded engine envVar (derive from manifest)`
            );
        }
    });

    it('the named capabilities resolve to vLLM\'s historical env-var names (byte-identical)', () => {
        // Behavioral guard: the capability names the schema references must still
        // produce the exact VLLM_* env vars that were previously hardcoded, so the
        // vLLM render is byte-identical. Reads the capability_map through the Node
        // reader rather than asserting a schema literal.
        const vllmCaps = capabilityMap('vllm');
        assert.strictEqual(vllmCaps.lora_enable.envVar, 'VLLM_ENABLE_LORA');
        assert.strictEqual(vllmCaps.lora_enable.valueType, 'boolean');
        assert.strictEqual(vllmCaps.lora_max.envVar, 'VLLM_MAX_LORAS');
        assert.strictEqual(vllmCaps.lora_max_rank.envVar, 'VLLM_MAX_LORA_RANK');
    });
});

// ── Requirement 2 ─────────────────────────────────────────────────────────────
describe('BL115 — do/config enables LoRA by default (Req 2)', () => {
    it('managed vLLM config emits export ENABLE_LORA=true (Req 2.1)', () => {
        const out = renderConfig({ deploymentTarget: 'realtime-inference', enableLora: true });
        assert.match(out, /^\s*export ENABLE_LORA=true\s*$/m);
    });

    it('hyperpod-eks vLLM config emits an uncommented export HP_LORA_ENABLED default true (Req 2.2)', () => {
        const out = renderConfig({ deploymentTarget: 'hyperpod-eks', modelServer: 'vllm' });
        assert.match(out, /^\s*export HP_LORA_ENABLED="\$\{HP_LORA_ENABLED:-true\}"\s*$/m);
        // The old commented opt-in default must not be the active line for vLLM.
        const active = out.split('\n').filter((l) => /HP_LORA_ENABLED/.test(l) && !/^\s*#/.test(l));
        assert.ok(active.length >= 1, 'expected an uncommented HP_LORA_ENABLED line');
    });

    it('eks vLLM config also defaults HP_LORA_ENABLED on (Req 3.2/5)', () => {
        const out = renderConfig({ deploymentTarget: 'eks', modelServer: 'vllm' });
        assert.match(out, /^\s*export HP_LORA_ENABLED="\$\{HP_LORA_ENABLED:-true\}"\s*$/m);
    });

    it('non-vLLM transformers config leaves HP_LORA_ENABLED commented (opt-in)', () => {
        const out = renderConfig({ deploymentTarget: 'hyperpod-eks', framework: 'transformers', modelServer: 'flask' });
        // No uncommented HP_LORA_ENABLED line for a non-LoRA server.
        const active = out.split('\n').filter((l) => /export HP_LORA_ENABLED=/.test(l) && !/^\s*#/.test(l));
        assert.strictEqual(active.length, 0);
        assert.match(out, /#\s*export HP_LORA_ENABLED=false/);
    });
});

// ── Requirement 3 / Property 2 (CRD) ──────────────────────────────────────────
// ADR-010: the CRD no longer hardcodes a VLLM_ENABLE_LORA line. LoRA is a Tier-1
// capability DERIVED per-engine by the deploy driver (serve_manifest.py
// resolve_capability_vars) and spliced at the __TIER1_ENVVARS__ marker, so vLLM
// gets a bare --enable-lora while SGLang's companion-gated toggle is omitted
// unless its rank/target-modules are set. The generate-time template therefore
// carries the MARKER, not an engine-specific env-var line.
describe('BL115 — CRD worker env derives LoRA via the Tier-1 marker (Req 3, 7.2; ADR-010)', () => {
    const crdTpl = readTpl('templates/hyperpod/InferenceEndpointConfig.yaml.ejs');
    const renderCrd = (extra = {}) => ejs.render(crdTpl, {
        projectName: 'test-project',
        hyperPodNamespace: 'default',
        framework: 'transformers',
        modelName: 'meta-llama/Llama-2-7b-hf',
        hyperPodReplicas: 1,
        instanceType: 'ml.g6.2xlarge',
        ...extra
    });

    it('carries the __TIER1_ENVVARS__ marker (deploy-time derived engine config)', () => {
        const out = renderCrd({ HP_LORA_ENABLED: 'true' });
        assert.match(out, /__TIER1_ENVVARS__/);
    });

    it('does NOT hardcode a VLLM_ENABLE_LORA line in the generated CRD (no engine leak)', () => {
        // The old hardcoded `- name: VLLM_ENABLE_LORA` line is gone; a non-vLLM
        // engine must never carry a stray VLLM_ key. The concrete LoRA env var is
        // injected at deploy time only for the active engine.
        for (const val of ['true', 'false', '', '1']) {
            const out = renderCrd({ HP_LORA_ENABLED: val });
            assert.doesNotMatch(out, /name:\s*VLLM_ENABLE_LORA/);
            assert.doesNotMatch(out, /name:\s*SGLANG_ENABLE_LORA/);
        }
    });

    it('does NOT hardcode the stray cross-engine model keys (no SGLANG_MODEL_PATH on a vLLM CRD)', () => {
        // Previously both VLLM_MODEL and SGLANG_MODEL_PATH were emitted
        // unconditionally; now the model key is Tier-1-derived for the active
        // engine only, via the marker.
        const out = renderCrd({});
        assert.doesNotMatch(out, /name:\s*SGLANG_MODEL_PATH/);
        assert.doesNotMatch(out, /name:\s*VLLM_MODEL\b/);
    });
});

// ── Requirement 4 / Property 3 (serve wrapper) ────────────────────────────────
// The wrapper forwards VLLM_* → --flag via a --help whitelist. We model that
// transform here (as the design's Property 3 prescribes) and also assert the
// wrapper does NOT hardcode --enable-lora / --max-loras 4.
describe('BL115 — serve wrapper forwards LoRA flags, no hardcoding (Req 4)', () => {
    const wrapper = readTpl('templates/code/serve.d/vllm/vllm.ejs');

    it('does not hardcode --enable-lora or --max-loras 4 in the wrapper', () => {
        assert.doesNotMatch(wrapper, /--enable-lora/, 'wrapper must not hardcode --enable-lora');
        assert.doesNotMatch(wrapper, /--max-loras\s+4\b/, 'wrapper must not hardcode --max-loras 4');
    });

    it('relies on the VLLM_* → --flag whitelist forwarding mechanism', () => {
        assert.match(wrapper, /VALID_ARGS_CACHE/);
        assert.match(wrapper, /grep\s+"\^\$\{PREFIX\}"/);
    });

    // Reference model of the wrapper's transform (bash semantics):
    //   value === 'false'            → emit nothing
    //   var not in whitelist         → emit nothing
    //   value === 'true'             → emit bare --flag
    //   otherwise                    → emit --flag value
    function forward(envMap, whitelist) {
        const args = [];
        for (const [key, value] of Object.entries(envMap)) {
            const flag = `--${  key.replace(/^VLLM_/, '').toLowerCase().replace(/_/g, '-')}`;
            if (!whitelist.includes(flag)) continue;
            if (value === 'false') continue;
            args.push(flag);
            if (value !== '' && value !== 'true') args.push(value);
        }
        return args;
    }

    it('example: LoRA env → --enable-lora --max-loras 30 --max-lora-rank 64', () => {
        const whitelist = ['--enable-lora', '--max-loras', '--max-lora-rank'];
        const args = forward(
            { VLLM_ENABLE_LORA: 'true', VLLM_MAX_LORAS: '30', VLLM_MAX_LORA_RANK: '64' },
            whitelist
        );
        assert.deepStrictEqual(args, ['--enable-lora', '--max-loras', '30', '--max-lora-rank', '64']);
    });

    // Feature: v18-w4-04-bl115, Property 3: Serve wrapper forwards whitelisted VLLM_* vars as flags
    it('Property 3: whitelisted true→flag, false→nothing, other→flag value; non-whitelisted→nothing', () => {
        const flagArb = fc.constantFrom('--enable-lora', '--max-loras', '--max-lora-rank', '--quantization', '--dtype');
        fc.assert(
            fc.property(
                fc.array(flagArb, { maxLength: 5 }),
                fc.dictionary(
                    fc.constantFrom('VLLM_ENABLE_LORA', 'VLLM_MAX_LORAS', 'VLLM_MAX_LORA_RANK', 'VLLM_QUANTIZATION', 'VLLM_DTYPE'),
                    fc.constantFrom('true', 'false', '30', '64', 'fp8', 'auto', '')
                ),
                (whitelist, envMap) => {
                    const args = forward(envMap, whitelist);
                    for (const [key, value] of Object.entries(envMap)) {
                        const flag = `--${  key.replace(/^VLLM_/, '').toLowerCase().replace(/_/g, '-')}`;
                        const idx = args.indexOf(flag);
                        if (!whitelist.includes(flag) || value === 'false') {
                            // May still be present if another key mapped to the same flag,
                            // but for this disjoint key set flags are unique.
                            assert.strictEqual(idx, -1, `${flag} should be absent`);
                        } else {
                            assert.notStrictEqual(idx, -1, `${flag} should be present`);
                            if (value !== '' && value !== 'true') {
                                assert.strictEqual(args[idx + 1], value);
                            }
                        }
                    }
                }
            ),
            PROPERTY_CONFIG
        );
    });
});

// ── Requirement 5 (eks target ConfigMap) ──────────────────────────────────────
describe('BL115 — eks target ConfigMap includes LoRA when enabled (Req 5)', () => {
    const cmTpl = readTpl('templates/eks/ConfigMap.yaml.ejs');
    const renderCm = (extra = {}) => ejs.render(cmTpl, {
        projectName: 'test-project',
        hyperPodNamespace: 'default',
        framework: 'transformers',
        modelName: 'meta-llama/Llama-2-7b-hf',
        HP_GPU_COUNT: '1',
        HP_LORA_ENABLED: '',
        ...extra
    });

    // The ConfigMap template has two paths (ADR-010): the PREFERRED path loops the
    // driver-resolved `tier1Env` list; the FALLBACK path (no tier1Env, e.g. a
    // raw-template render) keeps the old ${VAR:-default} shape gated on
    // HP_LORA_ENABLED. These raw renders exercise the fallback path.
    it('fallback path emits VLLM_ENABLE_LORA: "true" when HP_LORA_ENABLED === "true"', () => {
        assert.match(renderCm({ HP_LORA_ENABLED: 'true' }), /VLLM_ENABLE_LORA:\s*"true"/);
    });

    it('fallback path omits VLLM_ENABLE_LORA when opted out / undefined', () => {
        assert.doesNotMatch(renderCm({ HP_LORA_ENABLED: 'false' }), /VLLM_ENABLE_LORA/);
        assert.doesNotMatch(renderCm({}), /VLLM_ENABLE_LORA/);
    });

    it('preferred path loops the driver-resolved tier1Env and emits only those keys', () => {
        // When the driver supplies resolved Tier-1 pairs, the template loops them
        // verbatim and does NOT fall through to the hardcoded ${VAR:-default} block.
        const out = renderCm({
            tier1Env: [
                { key: 'VLLM_MODEL', value: 'meta/model' },
                { key: 'VLLM_ENABLE_LORA', value: 'true' }
            ]
        });
        assert.match(out, /VLLM_MODEL:\s*"meta\/model"/);
        assert.match(out, /VLLM_ENABLE_LORA:\s*"true"/);
        // The fallback stray SGLANG_MODEL_PATH line must NOT appear on this path.
        assert.doesNotMatch(out, /SGLANG_MODEL_PATH/);
    });

    it('deploy.d/eks resolves LoRA via the capability resolver, not a hardcoded VLLM_ENABLE_LORA export', () => {
        const eks = readTpl('templates/do/deploy.d/eks');
        // Derives Tier-1 through the Python resolver …
        assert.match(eks, /resolve_capability_vars/);
        assert.match(eks, /EKS_TIER1_ENV_JSON/);
        // … and no longer hardcodes an engine-specific LoRA export.
        assert.doesNotMatch(eks, /export VLLM_ENABLE_LORA=/);
    });

    it('render-eks-manifests passes the active engine + resolved Tier-1/Tier-2 into the EJS context', () => {
        const renderer = readTpl('templates/do/lib/render-eks-manifests.cjs');
        assert.match(renderer, /modelServer:\s*env\.MODEL_SERVER/);
        assert.match(renderer, /tier1Env:\s*parseTier1\(env\.EKS_TIER1_ENV_JSON\)/);
        assert.match(renderer, /tier2Env:\s*parseTier1\(env\.EKS_TIER2_ENV_JSON\)/);
    });
});

// ── Requirement 6 / Property 4 (warning) ──────────────────────────────────────
describe('BL115 — LoRA + speculative-decoding warning (Req 6)', () => {
    const deploy = readTpl('templates/do/deploy');
    const WARNING = '⚠️ LoRA + speculative decoding may conflict — verify vLLM version supports both simultaneously';

    it('do/deploy contains the exact advisory string and the gate wiring', () => {
        assert.ok(deploy.includes(WARNING), 'exact warning string must be present');
        assert.match(deploy, /_lora_on_for_target/);
        assert.match(deploy, /HP_SPECULATIVE_ALGORITHM/);
    });

    // Reference predicate matching the do/deploy shell logic.
    function warns(target, enableLora, hpLoraEnabled, specAlgorithm) {
        let loraOn;
        if (target === 'hyperpod-eks' || target === 'eks') {
            loraOn = hpLoraEnabled === 'true';
        } else {
            loraOn = enableLora === 'true';
        }
        return loraOn && (specAlgorithm !== undefined && specAlgorithm !== '');
    }

    // Feature: v18-w4-04-bl115, Property 4: LoRA + speculative warning fires exactly when both hold
    it('Property 4: warns iff LoRA-on-for-target AND spec algorithm non-empty', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...VLLM_TARGETS, 'realtime-inference'),
                fc.constantFrom('true', 'false', ''),
                fc.constantFrom('true', 'false', ''),
                fc.constantFrom('', 'eagle', 'ngram', 'draft-model'),
                (target, enableLora, hpLoraEnabled, specAlgorithm) => {
                    const loraOn = (target === 'hyperpod-eks' || target === 'eks')
                        ? hpLoraEnabled === 'true'
                        : enableLora === 'true';
                    const expected = loraOn && specAlgorithm !== '';
                    assert.strictEqual(warns(target, enableLora, hpLoraEnabled, specAlgorithm), expected);
                }
            ),
            PROPERTY_CONFIG
        );
    });
});

// ── Requirement 7 / Property 5 (opt-out) ──────────────────────────────────────
describe('BL115 — opt-out preserved (Req 7)', () => {
    it('managed ENABLE_LORA=false: config leaves it disabled (no export ENABLE_LORA=true)', () => {
        const out = renderConfig({ deploymentTarget: 'realtime-inference', enableLora: false });
        assert.doesNotMatch(out, /^\s*export ENABLE_LORA=true\s*$/m);
    });

    it('hyperpod-eks HP_LORA_ENABLED default uses ${VAR:-true}, preserving an explicit opt-out', () => {
        // The ${HP_LORA_ENABLED:-true} shape means an env-set HP_LORA_ENABLED=false wins.
        const out = renderConfig({ deploymentTarget: 'hyperpod-eks', modelServer: 'vllm' });
        assert.match(out, /HP_LORA_ENABLED="\$\{HP_LORA_ENABLED:-true\}"/);
    });

    it('deploy.d/hyperpod-eks resolves the LoRA toggle via the capability resolver (ADR-010)', () => {
        // The LoRA toggle is normalized to _HP_LORA_ON and fed to
        // resolve_capability_vars, which omits a companion-gated flag rather than
        // emitting a bare one. There is no longer a hardcoded VLLM_ENABLE_LORA
        // export that would leak the wrong prefix onto non-vLLM engines.
        const hp = readTpl('templates/do/deploy.d/hyperpod-eks');
        assert.match(hp, /HP_LORA_ENABLED:-false/);
        assert.match(hp, /_HP_LORA_ON/);
        assert.match(hp, /resolve_capability_vars/);
        assert.doesNotMatch(hp, /export VLLM_ENABLE_LORA=/);
    });
});
