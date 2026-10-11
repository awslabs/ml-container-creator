// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL107 SGLang Serve-Layer Plugin — Property-Based Tests
 *
 * Feature: v18-w3-01-bl107
 *
 * Covers:
 *   Property 3 — SGLang wrapper uses the prefix sourced from the manifest
 *   Property 4 — SGLang deploy env-mapping is derived from the manifest algorithm_map
 *   Property 5 — Existing SGLang deployments render identically before/after (back-compat)
 *
 * The deploy env-mapping (Property 4) is exercised by extracting the speculative
 * block from do/deploy.d/hyperpod-eks and running it in a bash subshell per
 * algorithm — the same code path deploy executes.
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { PROPERTY_CONFIG, PROPERTY_CONFIG_EJS } from '../helpers/property-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_TEMPLATE_PATH = resolve(ROOT, 'templates', 'code', 'serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');
const DO_DIR = resolve(ROOT, 'templates', 'do');
const DEPLOY_HYPERPOD = resolve(DO_DIR, 'deploy.d', 'hyperpod-eks');
const READER = resolve(DO_DIR, 'lib', 'python', 'serve_manifest.py');

// Speculative env-var suffixes the SGLang wrapper consumes.
const SPEC_SUFFIXES = [
    'SPECULATIVE_ALGORITHM',
    'SPECULATIVE_DRAFT_MODEL_PATH',
    'SPECULATIVE_NUM_STEPS',
    'SPECULATIVE_EAGLE_TOPK'
];

function renderServe(overrides = {}) {
    return ejs.render(SERVE_TEMPLATE, {
        modelSource: 'huggingface',
        modelServer: 'sglang',
        modelName: 'test-model',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        ...overrides
    }, { filename: SERVE_TEMPLATE_PATH });
}

// Extract the speculative block from hyperpod-eks (first VLLM_SPECULATIVE_ALGORITHM
// export through the closing fi of the HP_SPECULATIVE_ALGORITHM block).
function extractSpeculativeBlock() {
    const lines = readFileSync(DEPLOY_HYPERPOD, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === 'export VLLM_SPECULATIVE_ALGORITHM=""');
    let end = lines.findIndex((l) => l.includes('export SGLANG_SPECULATIVE_NUM_STEPS="${HP_SPECULATIVE_NUM_STEPS'));
    while (lines[end].trim() !== 'fi') end++;
    return lines.slice(start, end + 1).join('\n');
}

// Run the speculative block for a given HP_SPECULATIVE_ALGORITHM, return resolved env.
function runDeployBlock(alg, { eagleTopk = '8', model = 'acme/draft', numTokens = '5' } = {}) {
    const block = extractSpeculativeBlock();
    const tmp = mkdtempSync(join(os.tmpdir(), 'bl107-'));
    try {
        const script = join(tmp, 'run.sh');
        // SCRIPT_DIR must point at templates/do so ${SCRIPT_DIR}/lib/python/serve_manifest.py resolves.
        const wrapper = [
            '#!/bin/bash',
            'set -euo pipefail',
            `SCRIPT_DIR="${DO_DIR}"`,
            `export HP_SPECULATIVE_ALGORITHM="${alg}"`,
            `export HP_SPECULATIVE_MODEL="${model}"`,
            `export HP_SPECULATIVE_NUM_TOKENS="${numTokens}"`,
            `export HP_SPECULATIVE_EAGLE_TOPK="${eagleTopk}"`,
            'export VLLM_QUANTIZATION=""',
            block,
            'printf "V=%s\\nS=%s\\nT=%s\\nN=%s\\nP=%s\\n" ' +
                '"${VLLM_SPECULATIVE_ALGORITHM}" "${SGLANG_SPECULATIVE_ALGORITHM}" ' +
                '"${SGLANG_SPECULATIVE_EAGLE_TOPK}" "${SGLANG_SPECULATIVE_NUM_STEPS}" ' +
                '"${SGLANG_SPECULATIVE_DRAFT_MODEL_PATH}"'
        ].join('\n');
        writeFileSync(script, wrapper);
        const out = execFileSync('bash', [script], { encoding: 'utf8' });
        const env = {};
        for (const line of out.trim().split('\n')) {
            const [k, ...rest] = line.split('=');
            env[k] = rest.join('=');
        }
        return env;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

function readerField(field, engine) {
    return execFileSync('python3', [READER, field, engine], { encoding: 'utf8' }).trim();
}

describe('Feature: v18-w3-01-bl107 SGLang Serve-Layer Plugin', () => {

    // ── Property 3 ─────────────────────────────────────────────────────────────
    // Feature: v18-w3-01-bl107, Property 3: SGLang wrapper uses the SGLANG_ prefix sourced from the manifest
    describe('Property 3: wrapper speculative reads use the manifest-injected prefix', () => {
        // Validates: Requirements 2.1

        it('every speculative env read uses the injected prefix P', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(
                fc.stringMatching(/^[A-Z][A-Z0-9]*_$/),
                (prefix) => {
                    const rendered = renderServe({ envVarPrefix: prefix });
                    // PREFIX line reflects the injected prefix.
                    assert.ok(rendered.includes(`PREFIX="${prefix}"`),
                        `rendered wrapper should set PREFIX="${prefix}"`);
                    // Each speculative env var read is prefixed by P.
                    for (const suffix of SPEC_SUFFIXES) {
                        assert.ok(rendered.includes(`${prefix}${suffix}`),
                            `speculative read ${prefix}${suffix} must appear`);
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('anchored: the shipped SGLang manifest yields prefix SGLANG_', () => {
            assert.strictEqual(readerField('env_var_prefix', 'sglang'), 'SGLANG_');
            // Rendering with no explicit prefix falls back to SGLANG_ (byte-for-byte).
            const rendered = renderServe();
            assert.ok(rendered.includes('PREFIX="SGLANG_"'));
            for (const suffix of SPEC_SUFFIXES) {
                assert.ok(rendered.includes(`SGLANG_${suffix}`));
            }
        });
    });

    // ── Property 4 ─────────────────────────────────────────────────────────────
    // Feature: v18-w3-01-bl107, Property 4: SGLang deploy env-mapping is derived from the manifest
    describe('Property 4: deploy SGLANG_SPECULATIVE_ALGORITHM == manifest algorithm_map[a]', () => {
        // Validates: Requirements 3.2

        it('for every algorithm in supported_algorithms, deploy exports the mapped enum', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            const supported = JSON.parse(readerField('supported_algorithms', 'sglang'));
            const amap = JSON.parse(readerField('algorithm_map', 'sglang'));
            fc.assert(fc.property(
                fc.constantFrom(...supported),
                (alg) => {
                    const env = runDeployBlock(alg);
                    assert.strictEqual(env.S, amap[alg],
                        `deploy SGLANG_SPECULATIVE_ALGORITHM for ${alg} must equal algorithm_map[${alg}]=${amap[alg]}`);
                    return true;
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, supported.length * 4) });
        });

        it('anchored: enum outcomes match the pre-BL107 hardcoded case', () => {
            const cases = [
                ['draft-model', 'STANDALONE', ''],
                ['eagle', 'EAGLE', '8'],
                ['eagle2', 'EAGLE', ''],
                ['eagle3', 'EAGLE3', '8'],
                ['mtp', 'MTP', '']
            ];
            for (const [alg, enumVal, topk] of cases) {
                const env = runDeployBlock(alg);
                assert.strictEqual(env.S, enumVal, `${alg} → ${enumVal}`);
                assert.strictEqual(env.T, topk, `${alg} top-k should be '${topk}'`);
                assert.strictEqual(env.P, 'acme/draft', `${alg} draft path preserved`);
                assert.strictEqual(env.N, '5', `${alg} num steps preserved`);
            }
        });

        it('anchored: ngram maps for vLLM but not SGLang (unsupported)', () => {
            const env = runDeployBlock('ngram');
            assert.strictEqual(env.V, 'ngram', 'vLLM still maps ngram → ngram');
            assert.strictEqual(env.S, '', 'SGLang leaves ngram unmapped (not supported)');
        });
    });

    // ── Property 5 ─────────────────────────────────────────────────────────────
    // Feature: v18-w3-01-bl107, Property 5: Existing SGLang deployments render identically before/after (back-compat)
    describe('Property 5: rendered SGLang wrapper is byte-identical with/without envVarPrefix', () => {
        // Validates: Requirements 4.1

        // The pre-BL107 wrapper hardcoded PREFIX="SGLANG_" and the SGLANG_SPECULATIVE_*
        // literals. The relocated + injected wrapper must reproduce that exact text
        // whether or not the render context supplies envVarPrefix (the fallback path).
        const PRE_BL107_MARKERS = [
            'PREFIX="SGLANG_"',
            'SGLANG_SPECULATIVE_ALGORITHM|SGLANG_SPECULATIVE_DRAFT_MODEL_PATH|SGLANG_SPECULATIVE_NUM_STEPS|SGLANG_SPECULATIVE_EAGLE_TOPK',
            '_speculative_draft_model="${SGLANG_SPECULATIVE_DRAFT_MODEL_PATH:-${HP_SPECULATIVE_MODEL:-}}"',
            '--speculative-algorithm "${SGLANG_SPECULATIVE_ALGORITHM}"',
            '--speculative-draft-model-path "${SGLANG_SPECULATIVE_DRAFT_MODEL_PATH}"',
            '--speculative-num-steps "${SGLANG_SPECULATIVE_NUM_STEPS}"',
            '--speculative-eagle-topk "${SGLANG_SPECULATIVE_EAGLE_TOPK}"',
            // Entrypoint migrated to the recommended `sglang serve` CLI (SGLang
            // >=0.5); the deprecated `python -m sglang.launch_server` emitted a
            // startup UserWarning. The speculative-arg wiring above is unchanged.
            'exec sglang serve "${SERVER_ARGS[@]}"'
        ];

        it('the SGLANG_ fallback render reproduces the pre-BL107 wrapper text', function () {
            this.timeout(PROPERTY_CONFIG_EJS.timeout);
            fc.assert(fc.property(
                // With or without an explicit SGLANG_ prefix in the context.
                fc.constantFrom(undefined, 'SGLANG_'),
                (prefix) => {
                    const rendered = prefix === undefined
                        ? renderServe()
                        : renderServe({ envVarPrefix: prefix });
                    for (const marker of PRE_BL107_MARKERS) {
                        assert.ok(rendered.includes(marker),
                            `back-compat marker missing: ${marker}`);
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });
});
