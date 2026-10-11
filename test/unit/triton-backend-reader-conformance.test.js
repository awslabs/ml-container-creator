// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ADR-008 Triton-backend-reader CONFORMANCE / DRIFT net (BL119).
 *
 * servers/lib/catalogs/triton-backends.json is the intended single source of
 * truth for Triton per-backend knowledge; src/lib/triton-backend-reader.js is the
 * one reader every consumer derives from. Before BL119 that knowledge was
 * re-encoded as hardcoded name lists (`backend === 'vllm' || backend ===
 * 'tensorrtllm'`), per-backend model-format arrays, and a `triton-*` GPU list,
 * scattered across the generator, prompts, templates, and validators. Each copy
 * was a place the contract could silently drift.
 *
 * This test asserts, for EVERY backend in the catalog:
 *   1. the reader's derived facts are internally consistent with the catalog;
 *   2. every importable consumer agrees with the reader (behavioral checks);
 *   3. no consumer SOURCE re-encodes a hardcoded Triton name/format list.
 *
 * The coverage guard at the end fails if a NEW catalog backend is added without
 * a corresponding behavioral assertion here, so the drift net can't rot into a
 * stale allow-list as the catalog grows.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    listTritonBackends,
    backendFacts,
    modelFormats,
    requiresModelName,
    requiresGpu,
    supportsSampleModel,
    isLlm,
    gpuRequiringBackends
} from '../../src/lib/triton-backend-reader.js';

import PromptRunner from '../../src/lib/prompt-runner.js';
import TemplateManager from '../../src/lib/template-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CATALOG = JSON.parse(read('servers/lib/catalogs/triton-backends.json'));
const BACKENDS = listTritonBackends();

// A backend-name literal is only a drift hazard inside a predicate that re-encodes
// the LLM set or a format list. We detect the specific anti-pattern BL119 removed:
// `=== 'vllm'` adjacent to `=== 'tensorrtllm'` (the hardcoded isLlm name list).
const HARDCODED_LLM_NAMELIST = /['"]vllm['"]\s*(\|\||,)[\s\S]{0,40}?['"]tensorrtllm['"]|['"]tensorrtllm['"]\s*(\|\||,)[\s\S]{0,40}?['"]vllm['"]/;

describe('triton-backend-reader conformance (ADR-008 drift net — BL119)', () => {

    // ── 1. Reader facts are internally consistent with the catalog ──────────
    describe('reader facts match the catalog for every backend', () => {
        for (const b of BACKENDS) {
            it(`${b}: backendFacts mirrors the raw catalog record`, () => {
                const raw = CATALOG[b];
                const facts = backendFacts(b);
                assert.strictEqual(facts.requiresGpu, raw.requiresGpu === true);
                assert.deepStrictEqual(facts.modelFormats, raw.modelFormats);
                assert.strictEqual(facts.modelArtifactName, raw.modelArtifactName);
                assert.strictEqual(facts.requiresModelName, raw.requiresModelName === true);
                assert.strictEqual(facts.supportsSampleModel, raw.supportsSampleModel === true);
            });

            it(`${b}: isLlm is derived (requiresModelName && modelFormats===null), not a name list`, () => {
                const expected = requiresModelName(b) && modelFormats(b) === null;
                assert.strictEqual(isLlm(b), expected);
            });
        }

        it('gpuRequiringBackends equals the set of requiresGpu:true backends (sorted)', () => {
            const expected = BACKENDS.filter(b => requiresGpu(b)).sort();
            assert.deepStrictEqual(gpuRequiringBackends(), expected);
        });
    });

    // ── 2. Importable consumers agree with the reader (behavioral) ──────────

    describe('prompt-runner._getTritonAutoModelFormat derives from the reader', () => {
        const runner = new PromptRunner({});
        for (const b of BACKENDS) {
            it(`${b}: auto-format is the sole format for single-format backends, else null`, () => {
                const formats = modelFormats(b);
                const expected = Array.isArray(formats) && formats.length === 1 ? formats[0] : null;
                assert.strictEqual(runner._getTritonAutoModelFormat('triton', b), expected);
            });
        }
        it('returns null for a non-triton architecture regardless of backend', () => {
            assert.strictEqual(runner._getTritonAutoModelFormat('transformers', 'vllm'), null);
        });
    });

    describe('template-manager GPU enforcement derives from the reader', () => {
        // A GPU-requiring backend on a CPU-only instance must be rejected; a
        // non-GPU backend on the same instance must be accepted. This exercises
        // GPU_REQUIRING_BACKENDS (now derived from gpuRequiringBackends()).
        for (const b of BACKENDS) {
            it(`${b}: CPU instance ${requiresGpu(b) ? 'rejected' : 'accepted'}`, () => {
                const tm = new TemplateManager({
                    architecture: 'triton',
                    backend: b,
                    instanceType: 'ml.m5.large'
                });
                if (requiresGpu(b)) {
                    assert.throws(() => tm.validate(),
                        `GPU-requiring backend '${b}' must be rejected on a CPU-only instance`);
                } else {
                    assert.doesNotThrow(() => tm.validate(),
                        `non-GPU backend '${b}' must be accepted on a CPU-only instance`);
                }
            });
        }
    });

    // ── 3. No consumer SOURCE re-encodes a hardcoded name/format list ───────
    describe('no JS consumer re-encodes the hardcoded LLM name list', () => {
        // The templates (Dockerfile, config.pbtxt) are intentionally excluded:
        // route B keeps their per-engine BODIES bespoke (an `else if (backend ===
        // 'tensorrtllm')` arm that emits engine-specific parameters is legitimate).
        // What BL119 removed from them was the OUTER predicate — now `isLlmBackend`
        // — which is asserted separately below.
        const CONSUMERS = [
            'src/app.js',
            'src/lib/prompt-runner.js',
            'src/lib/secrets-prompt-runner.js',
            'src/lib/template-manager.js',
            'src/lib/config-validator.js',
            'src/lib/config-manager.js',
            'src/lib/prompts/feature-prompts.js',
            'src/lib/prompts/model-prompts.js'
        ];
        for (const rel of CONSUMERS) {
            it(`${rel} has no hardcoded 'vllm'/'tensorrtllm' predicate`, () => {
                assert.ok(!HARDCODED_LLM_NAMELIST.test(read(rel)),
                    `${rel} re-encodes the LLM backend name list — derive it from triton-backend-reader (isLlm) instead`);
            });
        }

        it('both Triton templates branch on the derived isLlmBackend predicate', () => {
            for (const rel of ['templates/triton/Dockerfile', 'templates/triton/config.pbtxt']) {
                assert.ok(read(rel).includes('isLlmBackend'),
                    `${rel} must branch on the catalog-derived isLlmBackend, not a hardcoded name list`);
            }
        });

        const READER_IMPORTERS = [
            'src/app.js',
            'src/lib/prompt-runner.js',
            'src/lib/secrets-prompt-runner.js',
            'src/lib/template-manager.js',
            'src/lib/config-validator.js',
            'src/lib/config-manager.js',
            'src/lib/prompts/feature-prompts.js',
            'src/lib/prompts/model-prompts.js'
        ];
        for (const rel of READER_IMPORTERS) {
            it(`${rel} imports the single Triton backend reader`, () => {
                assert.ok(read(rel).includes('triton-backend-reader.js'),
                    `${rel} must derive Triton knowledge from triton-backend-reader.js`);
            });
        }

        it('the orphaned parallel reader triton-backends-catalog.js is gone', () => {
            assert.throws(() => read('src/lib/triton-backends-catalog.js'),
                'triton-backends-catalog.js must not be reintroduced — it is a parallel catalog reader (ADR-008)');
        });
    });

    describe('no consumer hardcodes a per-backend model-format list', () => {
        // The format arrays live only in the catalog. Assert no consumer source
        // re-encodes a recognizable one (e.g. the FIL or Python arrays).
        const q = String.fromCharCode(39);  // single-quote char, built without a quote literal
        // FIL's model formats are the one UNAMBIGUOUS Triton-only vocabulary: a
        // consumer that contains these string literals is re-encoding the catalog
        // format list. (The python-backend formats 'pkl'/'joblib'/'custom' are
        // deliberately NOT checked — they are generic words that also appear as a
        // predictor default-format and a base-image sentinel, so they would false-
        // positive. The reader-import + no-name-list checks still cover those files.)
        const FORMAT_NAMES = ['xgboost_json', 'xgboost_ubj', 'lightgbm_txt'];
        const CONSUMERS = [
            'src/lib/prompts/model-prompts.js',
            'src/lib/prompts/feature-prompts.js',
            'src/lib/prompt-runner.js',
            'src/lib/config-validator.js'
        ];
        for (const rel of CONSUMERS) {
            it(`${rel} contains no hardcoded Triton model-format literals`, () => {
                const src = read(rel);
                for (const name of FORMAT_NAMES) {
                    const lit = q + name + q;
                    assert.ok(!src.includes(lit),
                        `${rel} hardcodes model format ${lit} — derive it from triton-backend-reader (modelFormats) instead`);
                }
            });
        }
    });

    // ── Coverage guard: every catalog backend is exercised above ────────────
    describe('coverage guard — no backend escapes the drift net', () => {
        // Every backend asserted behaviorally in sections 1-2. If a new backend
        // is added to the catalog, the per-backend `it`s above generate for it
        // automatically; this guard additionally fails loudly if the catalog ever
        // shrinks to empty or the reader stops seeing the catalog.
        it('the catalog is non-empty and the reader sees every entry', () => {
            assert.ok(BACKENDS.length > 0, 'catalog must declare at least one backend');
            assert.deepStrictEqual(
                [...BACKENDS].sort(),
                Object.keys(CATALOG).sort(),
                'reader listTritonBackends() must equal the catalog keys'
            );
        });

        it('every backend has a defined isLlm, requiresGpu, and supportsSampleModel fact', () => {
            for (const b of BACKENDS) {
                assert.strictEqual(typeof isLlm(b), 'boolean', `${b}: isLlm must be boolean`);
                assert.strictEqual(typeof requiresGpu(b), 'boolean', `${b}: requiresGpu must be boolean`);
                assert.strictEqual(typeof supportsSampleModel(b), 'boolean', `${b}: supportsSampleModel must be boolean`);
            }
        });
    });
});
