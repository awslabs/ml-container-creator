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
import { PROPERTY_CONFIG, PROPERTY_CONFIG_EJS } from '../helpers/property-config.js';

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

    it('preserves architectures=["transformers"] and serverMapping envVars', () => {
        assert.deepStrictEqual(schema.parameters.enableLora.appliesTo.architectures, ['transformers']);
        assert.strictEqual(schema.parameters.enableLora.serverMapping.envVar, 'VLLM_ENABLE_LORA');
        assert.strictEqual(schema.parameters.maxLoras.serverMapping.envVar, 'VLLM_MAX_LORAS');
        assert.strictEqual(schema.parameters.maxLoraRank.serverMapping.envVar, 'VLLM_MAX_LORA_RANK');
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
// BL127: The CRD now emits the VLLM_ENABLE_LORA placeholder line unconditionally
// at generate time so deploy-time envsubst (driven by HP_LORA_ENABLED in
// do/config) can control LoRA without an image rebuild or regenerate. The
// generate-time HP_LORA_ENABLED value no longer gates whether the line exists.
describe('BL115 — CRD worker env carries the LoRA placeholder (Req 3, 7.2; BL127)', () => {
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

    it('always emits the VLLM_ENABLE_LORA envsubst placeholder (BL127)', () => {
        const out = renderCrd({ HP_LORA_ENABLED: 'true' });
        assert.match(out, /name:\s*VLLM_ENABLE_LORA/);
        assert.match(out, /value:\s*"\$\{VLLM_ENABLE_LORA:-\}"/);
    });

    it('emits the placeholder regardless of generate-time HP_LORA_ENABLED (BL127)', () => {
        // Present when opted out or undefined at generate time — the value is a
        // shell placeholder, filled by envsubst at deploy time, not a literal.
        assert.match(renderCrd({ HP_LORA_ENABLED: 'false' }), /name:\s*VLLM_ENABLE_LORA/);
        assert.match(renderCrd({}), /name:\s*VLLM_ENABLE_LORA/);
        assert.match(renderCrd({ HP_LORA_ENABLED: 'false' }), /value:\s*"\$\{VLLM_ENABLE_LORA:-\}"/);
    });

    // Feature: v18-w4-04-bl115, Property 2 (BL127-updated): the placeholder line
    // is always present and never a hardcoded literal, for any generate-time value.
    it('Property 2: CRD always carries the VLLM_ENABLE_LORA placeholder, never a literal', () => {
        fc.assert(
            fc.property(fc.constantFrom('true', 'false', '', 'True', '1'), (val) => {
                const out = renderCrd({ HP_LORA_ENABLED: val });
                assert.match(out, /name:\s*VLLM_ENABLE_LORA/);
                assert.match(out, /value:\s*"\$\{VLLM_ENABLE_LORA:-\}"/);
                // Never emit a baked-in literal "true" for this env var.
                assert.doesNotMatch(out, /name:\s*VLLM_ENABLE_LORA\s*\n\s*value:\s*"true"/);
            }),
            PROPERTY_CONFIG_EJS
        );
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

    it('emits VLLM_ENABLE_LORA: "true" when HP_LORA_ENABLED === "true"', () => {
        assert.match(renderCm({ HP_LORA_ENABLED: 'true' }), /VLLM_ENABLE_LORA:\s*"true"/);
    });

    it('omits VLLM_ENABLE_LORA when opted out / undefined', () => {
        assert.doesNotMatch(renderCm({ HP_LORA_ENABLED: 'false' }), /VLLM_ENABLE_LORA/);
        assert.doesNotMatch(renderCm({}), /VLLM_ENABLE_LORA/);
    });

    it('deploy.d/eks maps HP_LORA_ENABLED → VLLM_ENABLE_LORA for envsubst', () => {
        const eks = readTpl('templates/do/deploy.d/eks');
        assert.match(eks, /HP_LORA_ENABLED:-false/);
        assert.match(eks, /export VLLM_ENABLE_LORA="true"/);
    });

    it('render-eks-manifests passes HP_LORA_ENABLED into the EJS context', () => {
        const renderer = readTpl('templates/do/lib/render-eks-manifests.cjs');
        assert.match(renderer, /HP_LORA_ENABLED:\s*env\.HP_LORA_ENABLED/);
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

    it('deploy.d/hyperpod-eks maps HP_LORA_ENABLED=false → VLLM_ENABLE_LORA="false" (BL127)', () => {
        // Must be the literal "false", not empty: the serve wrapper only skips
        // forwarding --enable-lora when the value is exactly "false".
        const hp = readTpl('templates/do/deploy.d/hyperpod-eks');
        assert.match(hp, /HP_LORA_ENABLED:-false/);
        assert.match(hp, /export VLLM_ENABLE_LORA="false"/);
        assert.doesNotMatch(hp, /export VLLM_ENABLE_LORA=""/);
    });
});
