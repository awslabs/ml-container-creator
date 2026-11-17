// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6.1 R2.1 / R2.6 (BL188) — ONE source for the LoRA rank default + allowed
 * set: the serve-engine manifest capability_map (lora_max_rank / lora_max). Drift
 * test (steering rule 4) across every consumer:
 *
 *   manifest (vLLM)  ↔  Python reader (serve_manifest.py)
 *                    ↔  config/parameter-schema-v2.json maxLoraRank / maxLoras
 *                       (default + validation.enum = the allowed set)
 *                    ↔  generated validator (rejects 24, accepts 64)
 *                    ↔  template-variable-resolver defaults
 *                    ↔  LoRA prompt defaults
 *                    ↔  templates/Dockerfile ENV (reads the resolved answers)
 *                    ↔  both k8s deploy drivers (no MLCC_LORA_DEFAULTS literal)
 *
 * Assertions compare consumers to the manifest; no rank literal is pinned here.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    capabilityDefaults, loraRankDefault, loraRankAllowed, loraMaxDefault, loraSizingDefaults, listServeEngines
} from '../../src/lib/serve-manifest-reader.js';
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js';
import { loraPrompts } from '../../src/lib/prompts/index.js';
import { validationRules } from '../../src/lib/generated/validation-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SCHEMA = JSON.parse(read('config/parameter-schema-v2.json'));
const PY = join(ROOT, 'templates/do/lib/python/serve_manifest.py');
const python = process.env.MLCC_PYTHON || 'python3';
const py = (...args) => {
    const r = spawnSync(python, [PY, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
};

describe('Wave 6.1 BL188 — LoRA rank default + allowed set have ONE source (serve manifest)', () => {
    const def = loraRankDefault('vllm');
    const allowed = loraRankAllowed('vllm');

    it('the vLLM manifest declares a default rank inside an ascending allowed set, and a max_loras default', () => {
        assert.ok(Number.isInteger(def) && def > 0);
        assert.ok(allowed.length > 1 && allowed.includes(def));
        assert.deepStrictEqual([...allowed].sort((a, b) => a - b), allowed);
        assert.ok(Number.isInteger(loraMaxDefault('vllm')));
    });

    it('the Python reader agrees with the Node reader', () => {
        assert.strictEqual(Number(py('lora_rank_default', 'vllm')), def);
        assert.deepStrictEqual(JSON.parse(py('lora_rank_allowed', 'vllm')), allowed);
        for (const engine of listServeEngines()) {
            const node = Object.fromEntries(Object.entries(capabilityDefaults(engine)).map(([k, v]) => [k, String(v)]));
            assert.deepStrictEqual(JSON.parse(py('capability_defaults', engine)), node, engine);
        }
    });

    it('parameter-schema maxLoraRank default + validation (R2.6) = the manifest default + allowed set', () => {
        const p = SCHEMA.parameters.maxLoraRank;
        assert.strictEqual(p.default, def);
        assert.deepStrictEqual(p.validation.enum, allowed);
        assert.strictEqual(p.validation.min, undefined, 'a min/max range would admit values vLLM rejects');
        assert.strictEqual(SCHEMA.parameters.maxLoras.default, loraMaxDefault('vllm'));
    });

    it('the generated validator enforces the allowed set (numbers or CLI strings)', () => {
        const rule = validationRules.maxLoraRank;
        const notAllowed = allowed[1] - 1; // between two allowed values
        assert.ok(rule(notAllowed), `${notAllowed} must be rejected`);
        for (const v of allowed) {
            assert.strictEqual(rule(v), null, `${v} must be accepted`);
            assert.strictEqual(rule(String(v)), null, `"${v}" must be accepted`);
        }
    });

    it('the template-variable resolver defaults come from the manifest', async () => {
        const answers = { modelServer: 'vllm' };
        await _ensureTemplateVariables(answers);
        assert.strictEqual(answers.maxLoraRank, def);
        assert.strictEqual(answers.maxLoras, loraMaxDefault('vllm'));
        const sglang = { modelServer: 'sglang' };
        await _ensureTemplateVariables(sglang);
        assert.deepStrictEqual({ maxLoras: sglang.maxLoras, maxLoraRank: sglang.maxLoraRank },
            loraSizingDefaults('sglang'));
    });

    it('the LoRA prompt defaults come from the manifest', () => {
        const rank = loraPrompts.find((p) => p.name === 'maxLoraRank');
        const max = loraPrompts.find((p) => p.name === 'maxLoras');
        assert.strictEqual(rank.default({ backend: 'vllm' }), def);
        assert.strictEqual(max.default({ backend: 'vllm' }), loraMaxDefault('vllm'));
    });

    it('the Dockerfile ENV reads the resolved answers (no literal)', () => {
        const df = read('templates/Dockerfile');
        assert.match(df, /ENV VLLM_MAX_LORA_RANK=<%= maxLoraRank %>/);
        assert.match(df, /ENV VLLM_MAX_LORAS=<%= maxLoras %>/);
    });

    for (const driver of ['templates/do/deploy.d/eks', 'templates/do/deploy.d/hyperpod-eks']) {
        it(`${driver} derives the defaults + rank (no MLCC_LORA_DEFAULTS literal, no 30/64 misattribution)`, () => {
            const src = read(driver);
            assert.ok(!src.includes('MLCC_LORA_DEFAULTS'), 'the literal defaults table must be gone');
            assert.ok(!/max_loras=30/.test(src) && !/max_lora_rank=64/.test(src),
                'the comment misattributing 30/64 to vLLM must be gone');
            assert.match(src, /serve_manifest\.py" capability_defaults/);
            assert.match(src, /right_sizing\.py" effective-lora-rank/);
        });
    }
});

describe('Wave 6.1 R2.2 / R2.5 — do/tune records the produced rank and notes the EFFECTIVE limit', () => {
    const tune = read('templates/do/tune');
    const code = tune.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    it('records TUNE_LORA_RANK_<TECH> at submit from the resolved lora_rank knob', () => {
        assert.match(code, /_tune_lora_rank=\$\(printf '%s' "\$\{resolved_hp:-\}"/);
        assert.match(code, /_update_config_var "TUNE_LORA_RANK_\$\{technique_upper\}" "\$\{_tune_lora_rank\}"/);
        const submit = code.indexOf('_update_config_var "TUNE_JOB_NAME_${technique_upper}"');
        const record = code.indexOf('TUNE_LORA_RANK_${technique_upper}');
        assert.ok(submit !== -1 && record > submit, 'recorded with the submitted job');
    });
    it('the post-tune note compares against the effective limit (not only an explicit VLLM_MAX_LORA_RANK)', () => {
        assert.match(code, /right_sizing\.py" effective-lora-rank --rank-only/);
        assert.match(code, /--exclude-technique "\$\{_technique_lc\}"/);
        assert.match(tune, /The next \.\/do\/deploy raises it automatically/);
        assert.ok(!/if \[ -n "\$\{VLLM_MAX_LORA_RANK:-\}" \] && \[ "\$\{_lora_r\}" -gt/.test(code),
            'the silent "only when VLLM_MAX_LORA_RANK is set" guard must be gone');
    });
    it('never blocks or lowers the technique rank (no exit / no rewrite of lora_rank in the note)', () => {
        const start = tune.indexOf('# Rank-fit (BL164 R5, Wave 6.1 R2.5)');
        const block = tune.slice(start, tune.indexOf('adapter rank/alpha unavailable', start));
        assert.ok(start !== -1);
        assert.ok(!/\bexit\b/.test(block), 'the note must never exit');
        assert.ok(!/_update_config_var "?LORA_RANK/.test(block) && !/SET_KNOBS/.test(block), 'the note must never rewrite the rank');
    });
});
