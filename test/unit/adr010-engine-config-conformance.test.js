// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ADR-010 — plugin-first K8s engine-config injection conformance.
 *
 * Guards the invariants the ADR and the bl-engine-aware-k8s-config spec promise,
 * at generation/render level (no cluster):
 *
 *   1. Companion correctness (Req 6 / Task 10): resolveCapabilityVars is the ONE
 *      home of the companion rule — a companion-gated capability is omitted (never
 *      emitted bare) when its companions are unset, for EVERY engine. SGLang LoRA
 *      is omitted without rank + target-modules; emitted with them. vLLM LoRA is
 *      bare (requires []).
 *   2. No cross-engine leak: a resolved set carries ONLY the active engine's
 *      prefix — a vLLM resolve never yields an SGLANG_* key and vice versa.
 *   3. Value shape (ADR-010): boolean caps emit KEY=true; valued caps are omitted
 *      when unset (no empty/sentinel value that breaks engine startup).
 *   4. vLLM byte-identical: vLLM's capability suffixes equal the historical
 *      hardcoded VLLM_* names, so the vLLM render is unchanged.
 *   5. Render derivation: the EKS ConfigMap and HyperPod CRD render surfaces carry
 *      exactly the resolver-derived Tier-1 keys and the Tier-2 pass-through, with
 *      no hardcoded engine env var and no render-surface branch on engine name.
 *   6. Plugin-first (Req 7, the acceptance bar): a synthetic serve.d/<engine>/ with
 *      its own prefix + capability_map (including a companion contract) resolves
 *      and renders correctly with ZERO edits to any MLCC-owned file.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import {
    capabilityMap,
    capabilityDefaults,
    resolveCapabilityVars,
    serveEngineRuntimeVarsUnion,
    minVersion
} from '../../src/lib/serve-manifest-reader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');
const readTpl = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Extract the emitted ConfigMap `data:` env-var keys (lines like `  KEY: "..."`),
// ignoring comment lines — so assertions test real output, not doc prose that
// legitimately mentions VLLM_*/SGLANG_* as examples.
function dataKeys(rendered) {
    return rendered
        .split('\n')
        .map((l) => l.match(/^ {2}([A-Z][A-Z0-9_]*):\s*"/))
        .filter(Boolean)
        .map((m) => m[1]);
}

// ── 1. Companion correctness — the single-home rule (Req 6 / Task 10) ──────────
describe('ADR-010 companion correctness (resolveCapabilityVars is the single home)', () => {
    it('vLLM LoRA is emitted bare — requires []', () => {
        const { resolved, skipped } = resolveCapabilityVars('vllm', {
            model: 'm', tensor_parallel_degree: '4', lora_enable: 'true'
        });
        const keys = resolved.map((e) => e.key);
        assert.ok(keys.includes('VLLM_ENABLE_LORA'), 'vLLM --enable-lora is valid bare');
        assert.strictEqual(skipped.length, 0);
        const lora = resolved.find((e) => e.key === 'VLLM_ENABLE_LORA');
        assert.strictEqual(lora.value, 'true', 'boolean cap emits KEY=true (wrapper drops the value)');
    });

    it('SGLang LoRA is OMITTED without its companions (never bare)', () => {
        const { resolved, skipped } = resolveCapabilityVars('sglang', {
            model: 'm', tensor_parallel_degree: '4', lora_enable: 'true'
        });
        const keys = resolved.map((e) => e.key);
        assert.ok(!keys.includes('SGLANG_ENABLE_LORA'),
            'a bare SGLANG_ENABLE_LORA would crash the server — must be omitted');
        assert.strictEqual(skipped.length, 1);
        assert.strictEqual(skipped[0].capability, 'lora_enable');
        assert.match(skipped[0].reason, /lora_max_rank/);
        assert.match(skipped[0].reason, /lora_target_modules/);
    });

    it('SGLang LoRA is emitted WITH its companions, together', () => {
        const { resolved, skipped } = resolveCapabilityVars('sglang', {
            model: 'm', tensor_parallel_degree: '4', lora_enable: 'true',
            lora_max_rank: '16', lora_target_modules: 'q_proj,v_proj'
        });
        const keys = resolved.map((e) => e.key);
        assert.ok(keys.includes('SGLANG_ENABLE_LORA'));
        assert.ok(keys.includes('SGLANG_MAX_LORA_RANK'));
        assert.ok(keys.includes('SGLANG_LORA_TARGET_MODULES'));
        assert.strictEqual(skipped.length, 0);
    });
});

// ── 2 + 3. No cross-engine leak + value shape ──────────────────────────────────
describe('ADR-010 no cross-engine leak + value shape', () => {
    it('a vLLM resolve yields only VLLM_ keys; an SGLang resolve only SGLANG_ keys', () => {
        const v = resolveCapabilityVars('vllm', { model: 'm', tensor_parallel_degree: '4' });
        for (const e of v.resolved) {
            assert.ok(e.key.startsWith('VLLM_'), `vLLM resolve leaked a non-VLLM_ key: ${e.key}`);
        }
        const s = resolveCapabilityVars('sglang', { model: 'm', tensor_parallel_degree: '4' });
        for (const e of s.resolved) {
            assert.ok(e.key.startsWith('SGLANG_'), `SGLang resolve leaked a non-SGLANG_ key: ${e.key}`);
        }
    });

    it('an unset valued capability is omitted, not emitted empty', () => {
        // quantization unset → no VLLM_QUANTIZATION line (fixes QUANTIZATION=none startup crash).
        const { resolved } = resolveCapabilityVars('vllm', { model: 'm', tensor_parallel_degree: '4' });
        assert.ok(!resolved.some((e) => e.key === 'VLLM_QUANTIZATION'),
            'unset quantization must be omitted, never emitted as an empty value');
    });

    it('a set valued capability is emitted with its value', () => {
        const { resolved } = resolveCapabilityVars('vllm', {
            model: 'm', tensor_parallel_degree: '4', quantization: 'fp8'
        });
        const q = resolved.find((e) => e.key === 'VLLM_QUANTIZATION');
        assert.ok(q && q.value === 'fp8');
    });
});

// ── 4. vLLM byte-identical ─────────────────────────────────────────────────────
describe('ADR-010 vLLM byte-identical (suffixes == historical hardcoded names)', () => {
    it('vLLM capability_map produces exactly the previously hardcoded VLLM_* names', () => {
        const caps = capabilityMap('vllm');
        assert.strictEqual(caps.model.envVar, 'VLLM_MODEL');
        assert.strictEqual(caps.tensor_parallel_degree.envVar, 'VLLM_TENSOR_PARALLEL_SIZE');
        assert.strictEqual(caps.quantization.envVar, 'VLLM_QUANTIZATION');
        assert.strictEqual(caps.lora_enable.envVar, 'VLLM_ENABLE_LORA');
        assert.strictEqual(caps.lora_enable.valueType, 'boolean');
    });

    it('a full vLLM resolve matches the historical ConfigMap env set', () => {
        const { resolved } = resolveCapabilityVars('vllm', {
            model: 'meta/model', tensor_parallel_degree: '4', lora_enable: 'true'
        });
        assert.deepStrictEqual(resolved, [
            { key: 'VLLM_MODEL', value: 'meta/model' },
            { key: 'VLLM_TENSOR_PARALLEL_SIZE', value: '4' },
            { key: 'VLLM_ENABLE_LORA', value: 'true' }
        ]);
    });
});

// ── 5. Render derivation: EKS ConfigMap + HyperPod CRD ─────────────────────────
describe('ADR-010 render surfaces carry only derived keys (no hardcoded engine env var)', () => {
    it('EKS ConfigMap preferred path emits exactly the resolved tier1Env + tier2Env', () => {
        const tpl = readTpl('templates/eks/ConfigMap.yaml.ejs');
        const { resolved } = resolveCapabilityVars('sglang', {
            model: 'Qwen/Qwen3-32B', tensor_parallel_degree: '4', lora_enable: 'true'
        });
        const out = ejs.render(tpl, {
            projectName: 'p', hyperPodNamespace: 'default', framework: 'transformers',
            modelName: 'Qwen/Qwen3-32B', HP_GPU_COUNT: '4', modelServer: 'sglang',
            tier1Env: resolved,
            tier2Env: [{ key: 'SGLANG_BATCH_SIZE', value: '8' }]
        });
        // Derived SGLang keys present …
        assert.match(out, /SGLANG_MODEL_PATH:\s*"Qwen\/Qwen3-32B"/);
        assert.match(out, /SGLANG_TP_SIZE:\s*"4"/);
        // Companion-gated LoRA omitted …
        assert.ok(!dataKeys(out).includes('SGLANG_ENABLE_LORA'));
        // No cross-engine VLLM_* leak (inspect emitted data keys, not comments) …
        assert.ok(!dataKeys(out).some((k) => k.startsWith('VLLM_')),
            `leaked a VLLM_ key: ${dataKeys(out).join(', ')}`);
        // Tier-2 pass-through present.
        assert.match(out, /SGLANG_BATCH_SIZE:\s*"8"/);
    });

    it('EKS ConfigMap source has no hardcoded engine env var outside the fallback branch', () => {
        // The only VLLM_/SGLANG_ literals left are inside the else (fallback) branch.
        const tpl = readTpl('templates/eks/ConfigMap.yaml.ejs');
        const preferred = tpl.split('} else {')[0];
        assert.doesNotMatch(preferred, /VLLM_MODEL|SGLANG_MODEL_PATH|VLLM_ENABLE_LORA/,
            'the preferred render path must not hardcode any engine env var');
    });

    it('HyperPod CRD source carries the __TIER1_ENVVARS__ marker and no hardcoded Tier-1 line', () => {
        const crd = readTpl('templates/hyperpod/InferenceEndpointConfig.yaml.ejs');
        assert.match(crd, /__TIER1_ENVVARS__/);
        // The hardcoded model/TP/LoRA worker-env lines are gone (speculative stays).
        assert.doesNotMatch(crd, /- name: VLLM_MODEL\b/);
        assert.doesNotMatch(crd, /- name: SGLANG_MODEL_PATH\b/);
        assert.doesNotMatch(crd, /- name: VLLM_ENABLE_LORA\b/);
        // Speculative sets are retained (explicitly managed, not Tier-1).
        assert.match(crd, /- name: VLLM_SPECULATIVE_ALGORITHM/);
        assert.match(crd, /- name: SGLANG_SPECULATIVE_ALGORITHM/);
    });

    it('no render surface branches on an engine name', () => {
        // Guard the derive-dont-hardcode intent: neither the ConfigMap nor the CRD
        // may special-case a specific engine (e.g. `=== 'sglang'`).
        for (const rel of [
            'templates/eks/ConfigMap.yaml.ejs',
            'templates/hyperpod/InferenceEndpointConfig.yaml.ejs'
        ]) {
            const src = readTpl(rel);
            assert.doesNotMatch(src, /===\s*['"](vllm|sglang|tensorrt-llm|lmi|llama-cpp)['"]/,
                `${rel} must not branch on a specific engine name`);
        }
    });
});

// ── 6. Plugin-first acceptance bar (Req 7) ─────────────────────────────────────
describe('ADR-010 plugin-first: a synthetic engine participates with zero MLCC edits', () => {
    let tmpServeDir;
    const ENGINE = 'myengine';

    before(() => {
        tmpServeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-serve-'));
        fs.mkdirSync(path.join(tmpServeDir, ENGINE), { recursive: true });
        // A bespoke engine with its OWN prefix and its OWN companion contract —
        // declared ONLY in its manifest, touching no MLCC-owned file.
        const manifest = {
            engine: ENGINE,
            env_var_prefix: 'MYENG_',
            supported_algorithms: [],
            capability_map: {
                model: { suffix: 'MODEL_ID', value_type: 'valued' },
                tensor_parallel_degree: { suffix: 'NUM_GPUS', value_type: 'valued' },
                lora_enable: { suffix: 'LORA', value_type: 'boolean', requires: ['lora_max_rank'] },
                lora_max_rank: { suffix: 'LORA_RANK', value_type: 'valued' }
            }
        };
        fs.writeFileSync(
            path.join(tmpServeDir, ENGINE, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
    });

    after(() => {
        if (tmpServeDir) fs.rmSync(tmpServeDir, { recursive: true, force: true });
    });

    it('capabilityMap reads the custom prefix + suffixes with no code change', () => {
        const caps = capabilityMap(ENGINE, tmpServeDir);
        assert.strictEqual(caps.model.envVar, 'MYENG_MODEL_ID');
        assert.strictEqual(caps.tensor_parallel_degree.envVar, 'MYENG_NUM_GPUS');
        assert.strictEqual(caps.lora_enable.envVar, 'MYENG_LORA');
        assert.deepStrictEqual(caps.lora_enable.requires, ['lora_max_rank']);
    });

    it('its OWN companion contract is honored (LoRA omitted without MYENG rank)', () => {
        const noComp = resolveCapabilityVars(ENGINE, {
            model: 'm', tensor_parallel_degree: '2', lora_enable: 'true'
        }, tmpServeDir);
        assert.ok(!noComp.resolved.some((e) => e.key === 'MYENG_LORA'));
        assert.strictEqual(noComp.skipped.length, 1);

        const withComp = resolveCapabilityVars(ENGINE, {
            model: 'm', tensor_parallel_degree: '2', lora_enable: 'true', lora_max_rank: '8'
        }, tmpServeDir);
        const keys = withComp.resolved.map((e) => e.key);
        assert.ok(keys.includes('MYENG_LORA') && keys.includes('MYENG_LORA_RANK'));
    });

    it('its vars render into the EKS ConfigMap via the generic tier1Env loop', () => {
        const tpl = readTpl('templates/eks/ConfigMap.yaml.ejs');
        const { resolved } = resolveCapabilityVars(ENGINE, {
            model: 'acme/model', tensor_parallel_degree: '2'
        }, tmpServeDir);
        const out = ejs.render(tpl, {
            projectName: 'p', hyperPodNamespace: 'default', framework: 'transformers',
            modelName: 'acme/model', HP_GPU_COUNT: '2', modelServer: ENGINE,
            tier1Env: resolved, tier2Env: []
        });
        assert.match(out, /MYENG_MODEL_ID:\s*"acme\/model"/);
        assert.match(out, /MYENG_NUM_GPUS:\s*"2"/);
        // No built-in engine's keys leak into a custom engine's render.
        assert.ok(!dataKeys(out).some((k) => k.startsWith('VLLM_') || k.startsWith('SGLANG_')),
            `leaked a built-in engine key: ${dataKeys(out).join(', ')}`);
    });

    it('its Tier-1 vars join the regenerate-preserved runtime union (no literal added)', () => {
        const union = serveEngineRuntimeVarsUnion(tmpServeDir);
        assert.ok(union.includes('MYENG_MODEL_ID'));
        assert.ok(union.includes('MYENG_LORA'));
        assert.ok(union.includes('MYENG_LORA_RANK'));
    });
});

// ── 7. OR-of-AND-groups companion contract (requires_any_of) ───────────────────
describe('ADR-010 companion contract: OR-of-AND-groups (requires_any_of)', () => {
    let tmpServeDir;
    const ENGINE = 'orengine';

    before(() => {
        tmpServeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-serve-or-'));
        fs.mkdirSync(path.join(tmpServeDir, ENGINE), { recursive: true });
        // lora_enable is valid if EITHER (rank AND modules) OR (paths) resolves —
        // the real SGLang-style rule, declared entirely in the manifest.
        const manifest = {
            engine: ENGINE,
            env_var_prefix: 'ORE_',
            supported_algorithms: [],
            capability_map: {
                model: { suffix: 'MODEL', value_type: 'valued' },
                lora_enable: {
                    suffix: 'ENABLE_LORA', value_type: 'boolean',
                    requires_any_of: [['lora_max_rank', 'lora_target_modules'], ['lora_paths']]
                },
                lora_max_rank: { suffix: 'MAX_LORA_RANK', value_type: 'valued' },
                lora_target_modules: { suffix: 'LORA_TARGET_MODULES', value_type: 'valued' },
                lora_paths: { suffix: 'LORA_PATHS', value_type: 'valued' }
            }
        };
        fs.writeFileSync(
            path.join(tmpServeDir, ENGINE, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
    });

    after(() => {
        if (tmpServeDir) fs.rmSync(tmpServeDir, { recursive: true, force: true });
    });

    it('emits when the FIRST group resolves (rank + modules)', () => {
        const { resolved, skipped } = resolveCapabilityVars(ENGINE, {
            model: 'm', lora_enable: 'true', lora_max_rank: '16', lora_target_modules: 'all'
        }, tmpServeDir);
        const keys = resolved.map((e) => e.key);
        assert.ok(keys.includes('ORE_ENABLE_LORA'));
        assert.strictEqual(skipped.length, 0);
    });

    it('emits when the SECOND group resolves (paths alone)', () => {
        const { resolved, skipped } = resolveCapabilityVars(ENGINE, {
            model: 'm', lora_enable: 'true', lora_paths: 's3://bucket/adapter'
        }, tmpServeDir);
        const keys = resolved.map((e) => e.key);
        assert.ok(keys.includes('ORE_ENABLE_LORA'));
        assert.ok(keys.includes('ORE_LORA_PATHS'));
        assert.strictEqual(skipped.length, 0);
    });

    it('OMITS when NEITHER group fully resolves (only rank set, no modules, no paths)', () => {
        const { resolved, skipped } = resolveCapabilityVars(ENGINE, {
            model: 'm', lora_enable: 'true', lora_max_rank: '16'
        }, tmpServeDir);
        const keys = resolved.map((e) => e.key);
        assert.ok(!keys.includes('ORE_ENABLE_LORA'), 'never bare when no group is satisfied');
        assert.strictEqual(skipped.length, 1);
        // Reports the closest-to-satisfied group's missing member(s).
        assert.match(skipped[0].reason, /lora_target_modules/);
        assert.match(skipped[0].reason, /another supported companion group/);
    });

    it('capabilityMap exposes requiresAnyOf groups and a flat intersection for requires', () => {
        const caps = capabilityMap(ENGINE, tmpServeDir);
        assert.deepStrictEqual(caps.lora_enable.requiresAnyOf,
            [['lora_max_rank', 'lora_target_modules'], ['lora_paths']]);
        // Flat `requires` = intersection across groups → empty here (groups disjoint).
        assert.deepStrictEqual(caps.lora_enable.requires, []);
    });
});

// ── 8. SGLang pure-dynamic contract + min_version (post-spike) ─────────────────
describe('ADR-010 SGLang pure-dynamic LoRA (findings: .kiro/sglang-lora-dynamic-findings.md)', () => {
    it('SGLang lora_enable declares the dynamic group via requires_any_of', () => {
        const caps = capabilityMap('sglang');
        assert.deepStrictEqual(caps.lora_enable.requiresAnyOf,
            [['lora_max_rank', 'lora_target_modules']],
            'SGLang supports pure-dynamic LoRA only: one group (rank + target-modules)');
        assert.strictEqual(caps.lora_enable.valueType, 'boolean');
    });

    it('SGLang min_version is >= 0.5.0 (sglang serve CLI + enable-lora w/o paths)', () => {
        const mv = minVersion('sglang');
        assert.ok(mv, 'sglang must declare a min_version');
        const [maj, min] = mv.split('.').map(Number);
        assert.ok(maj > 0 || (maj === 0 && min >= 5),
            `sglang min_version must be >= 0.5.0, got ${mv}`);
    });

    it('the SGLang wrapper uses `sglang serve`, not the deprecated launch_server exec', () => {
        const wrapper = readTpl('templates/code/serve.d/sglang/sglang.ejs');
        assert.match(wrapper, /exec sglang serve/);
        assert.doesNotMatch(wrapper, /exec python3 -m sglang\.launch_server/);
    });
});

// ── 9. Deploy-driver companion defaults (memory-safe LoRA sizing) ─────────────
// Mirrors the exact Tier-1 value-builder logic in deploy.d/eks + deploy.d/hyperpod-eks:
// when LoRA is on, MLCC fills pure-dynamic defaults for every LoRA sizing/companion
// capability the ACTIVE engine DECLARES in its capability_map (not only ones gated
// as "required"), keyed by capability name (no engine branch). The sizing defaults
// (lora_max=4, lora_max_rank=16) replace vLLM's memory-hungry built-ins (30/64)
// that OOM large models; each engine's manifest translates the capability to its
// own env suffix.
describe('ADR-010 deploy-driver companion defaults', () => {
    // Wave 6.1 (BL188): the defaults are each capability's manifest `default`
    // (the drivers read them via serve_manifest.py capability_defaults), not a
    // literal table here or in the drivers.
    function buildTier1Values(engine, { loraOn, userRank = '', userMax = '', userModules = '', serveDir } = {}) {
        const MLCC_LORA_DEFAULTS = Object.fromEntries(
            Object.entries(capabilityDefaults(engine, serveDir)).map(([k, v]) => [k, String(v)]));
        const v = { model: 'm', tensor_parallel_degree: '4' };
        if (loraOn) {
            v.lora_enable = 'true';
            if (userRank) v.lora_max_rank = userRank;
            if (userMax) v.lora_max = userMax;
            if (userModules) v.lora_target_modules = userModules;
            const caps = capabilityMap(engine, serveDir);
            const decl = caps.lora_enable || {};
            // Declared sizing capabilities ∪ required companions — fill a default
            // for any the engine knows about and the user didn't set.
            const declared = new Set(Object.keys(caps));
            for (const g of (decl.requiresAnyOf || [decl.requires || []])) {
                for (const k of g) declared.add(k);
            }
            for (const [comp, def] of Object.entries(MLCC_LORA_DEFAULTS)) {
                if (declared.has(comp) && !v[comp]) v[comp] = def;
            }
        }
        return v;
    }

    it('SGLang + LoRA on auto-fills rank=16 and target_modules=all, resolver emits them', () => {
        const vals = buildTier1Values('sglang', { loraOn: true });
        assert.strictEqual(vals.lora_max_rank, '16');
        assert.strictEqual(vals.lora_target_modules, 'all');
        // SGLang does NOT declare lora_max → no max-loras default for it.
        assert.ok(!('lora_max' in vals), 'SGLang declares no lora_max capability');
        const { resolved, skipped } = resolveCapabilityVars('sglang', vals);
        const keys = resolved.map((e) => e.key);
        assert.ok(keys.includes('SGLANG_ENABLE_LORA'));
        assert.ok(resolved.find((e) => e.key === 'SGLANG_MAX_LORA_RANK').value === '16');
        assert.ok(resolved.find((e) => e.key === 'SGLANG_LORA_TARGET_MODULES').value === 'all');
        assert.ok(!keys.some((k) => k === 'SGLANG_MAX_LORAS'), 'no max-loras for SGLang');
        assert.strictEqual(skipped.length, 0, 'with defaults supplied, nothing is skipped');
    });

    it('user-set companion values win over MLCC defaults', () => {
        const vals = buildTier1Values('sglang', { loraOn: true, userRank: '32', userModules: 'q_proj,v_proj' });
        assert.strictEqual(vals.lora_max_rank, '32');
        assert.strictEqual(vals.lora_target_modules, 'q_proj,v_proj');
    });

    it('vLLM + LoRA on fills memory-safe sizing defaults (max_loras=4, rank=16)', () => {
        // vLLM declares lora_max + lora_max_rank, so it gets the sizing defaults —
        // this is what prevents vLLM's built-in 30/64 from OOMing large models.
        const vals = buildTier1Values('vllm', { loraOn: true });
        assert.strictEqual(vals.lora_max, '4', 'vLLM max-loras defaults to 4');
        assert.strictEqual(vals.lora_max_rank, '16', 'vLLM max-lora-rank defaults to 16');
        const { resolved } = resolveCapabilityVars('vllm', vals);
        assert.ok(resolved.some((e) => e.key === 'VLLM_ENABLE_LORA'));
        assert.ok(resolved.find((e) => e.key === 'VLLM_MAX_LORAS').value === '4');
        assert.ok(resolved.find((e) => e.key === 'VLLM_MAX_LORA_RANK').value === '16');
    });

    it('user override wins over the vLLM sizing default', () => {
        const vals = buildTier1Values('vllm', { loraOn: true, userMax: '2', userRank: '32' });
        assert.strictEqual(vals.lora_max, '2');
        assert.strictEqual(vals.lora_max_rank, '32');
    });
});

// ── 10. Model-A vs Model-B engines (capability_map applicability) ──────────────
// Tier-1 injection applies ONLY to engines where MLCC owns the container
// entrypoint and translates env→flags (Model A: vllm, sglang, tensorrt-llm).
// Container-owns-entrypoint engines (Model B: lmi/djl, llama-cpp) must declare an
// EMPTY capability_map — a non-empty one would be dead, never-injected metadata.
describe('ADR-010 Model-B engines declare no Tier-1 capabilities', () => {
    const MODEL_B = ['lmi', 'llama-cpp'];
    const MODEL_A = ['vllm', 'sglang', 'tensorrt-llm'];

    for (const engine of MODEL_B) {
        it(`${engine} (container-owns-entrypoint) has an empty capability_map`, () => {
            assert.deepStrictEqual(capabilityMap(engine), {},
                `${engine} is a Model-B engine (DLC owns env→flag mapping); its capability_map must be empty`);
        });

        it(`${engine} resolve is a clean no-op (never crashes, emits nothing)`, () => {
            const { resolved, skipped } = resolveCapabilityVars(engine, {
                model: 'm', tensor_parallel_degree: '4', lora_enable: 'true'
            });
            assert.deepStrictEqual(resolved, []);
            assert.deepStrictEqual(skipped, []);
        });
    }

    for (const engine of MODEL_A) {
        it(`${engine} (MLCC-owned wrapper) declares a non-empty capability_map`, () => {
            assert.ok(Object.keys(capabilityMap(engine)).length > 0,
                `${engine} is a Model-A engine; it must declare Tier-1 capabilities`);
        });
    }

    it('emptying LMI capability_map did not drop its benchmark vars from the runtime union', () => {
        // LMI's OPTION_* vars are preserved via dimension_map (a separate
        // consumer), so removing them from capability_map is a no-op for
        // regenerate preservation.
        const union = serveEngineRuntimeVarsUnion();
        assert.ok(union.includes('OPTION_TENSOR_PARALLEL_DEGREE'));
        assert.ok(union.includes('OPTION_QUANTIZE'));
    });
});
