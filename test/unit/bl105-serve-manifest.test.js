// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL105 Serve-Layer Plugin Interface — Example / Integration Tests
 *
 * Feature: v18-w2-02-bl105
 *
 * Covers:
 *   - Requirement 1: Plugin_Directory structure (manifest + wrapper colocated)
 *   - Requirements 2, 7, 8: shipped vLLM and SGLang manifest field values
 *   - Requirement 3: CI schema validation (script passes for valid, fails on broken fixture)
 *   - Migration / back-compat: flat wrappers relocated; nested EJS include renders;
 *     serve.d exclusion glob still applies.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const SCHEMA_PATH = resolve(SERVE_D, 'manifest.schema.json');
const VALIDATOR = resolve(ROOT, 'scripts', 'validate-serve-manifests.js');
const SERVE_TEMPLATE_PATH = resolve(ROOT, 'templates', 'code', 'serve');

function loadManifest(engine) {
    return JSON.parse(readFileSync(resolve(SERVE_D, engine, 'manifest.json'), 'utf8'));
}

// Discover every shipped serve.d engine dir dynamically so parity coverage
// tracks the catalog as engines are added (e.g. vllm-omni), rather than a
// hardcoded list that silently skips new plugins (derive-dont-hardcode).
const ALL_ENGINES = readdirSync(SERVE_D, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

describe('Feature: v18-w2-02-bl105 — structure & shipped manifests', () => {

    // ── Requirement 1: Plugin_Directory ─────────────────────────────────────
    describe('Requirement 1: per-engine Plugin_Directory', () => {
        // Every DISCOVERED engine dir must ship BOTH a wrapper and a manifest —
        // data-driven so a new plugin (e.g. vllm-omni) is covered automatically.
        for (const engine of ALL_ENGINES) {
            it(`serve.d/${engine}/ contains the relocated wrapper ${engine}.ejs`, () => {
                assert.ok(existsSync(resolve(SERVE_D, engine, `${engine}.ejs`)),
                    `serve.d/${engine}/${engine}.ejs must exist`);
            });
        }

        // ADR-004 parity: EVERY serve.d engine dir must ship a manifest.json —
        // no engine may rely on manifest absence.
        for (const engine of ALL_ENGINES) {
            it(`serve.d/${engine}/ contains manifest.json`, () => {
                assert.ok(existsSync(resolve(SERVE_D, engine, 'manifest.json')),
                    `serve.d/${engine}/manifest.json must exist`);
            });
        }

        it('the known engines (incl. the vllm-omni diffusion plugin) are all present', () => {
            for (const e of ['vllm', 'sglang', 'lmi', 'tensorrt-llm', 'vllm-omni']) {
                assert.ok(ALL_ENGINES.includes(e), `expected serve.d/${e}/ to exist`);
            }
        });

        it('the old flat wrappers no longer exist', () => {
            for (const engine of ['vllm', 'sglang', 'lmi', 'tensorrt-llm']) {
                assert.ok(!existsSync(resolve(SERVE_D, `${engine}.ejs`)),
                    `flat serve.d/${engine}.ejs must not exist after migration`);
            }
        });

        it('the manifest schema exists at serve.d/manifest.schema.json', () => {
            assert.ok(existsSync(SCHEMA_PATH));
        });
    });

    // ── Requirements 2, 7: vLLM manifest ─────────────────────────────────────
    describe('Requirement 7: vLLM manifest', () => {
        const m = loadManifest('vllm');
        it('engine=vllm, env_var_prefix=VLLM_', () => {
            assert.strictEqual(m.engine, 'vllm');
            assert.strictEqual(m.env_var_prefix, 'VLLM_');
        });
        it('supported_algorithms is the vLLM set', () => {
            assert.deepStrictEqual(m.supported_algorithms,
                ['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp', 'dspark']);
        });
        it('hot_reload is a boolean', () => {
            assert.strictEqual(typeof m.hot_reload, 'boolean');
        });
        it('metrics_endpoint = {path:/metrics, port:8080, format:prometheus}', () => {
            assert.deepStrictEqual(m.metrics_endpoint, { path: '/metrics', port: 8080, format: 'prometheus' });
        });
        it('algorithm_map maps draft-model → draft_model', () => {
            assert.strictEqual(m.algorithm_map['draft-model'], 'draft_model');
        });
        it('algorithm_map maps dspark → dspark (passthrough, Kimi-K3)', () => {
            assert.ok(m.supported_algorithms.includes('dspark'));
            assert.strictEqual(m.algorithm_map.dspark, 'dspark');
        });
    });

    // ── Requirements 2, 8: SGLang manifest ───────────────────────────────────
    describe('Requirement 8: SGLang manifest', () => {
        const m = loadManifest('sglang');
        it('engine=sglang, env_var_prefix=SGLANG_', () => {
            assert.strictEqual(m.engine, 'sglang');
            assert.strictEqual(m.env_var_prefix, 'SGLANG_');
        });
        it('supported_algorithms excludes ngram', () => {
            assert.deepStrictEqual(m.supported_algorithms,
                ['eagle3', 'eagle2', 'eagle', 'draft-model', 'mtp']);
            assert.ok(!m.supported_algorithms.includes('ngram'));
        });
        it('hot_reload is a boolean', () => {
            assert.strictEqual(typeof m.hot_reload, 'boolean');
        });
        it('metrics_endpoint = {path:/metrics, port:8080, format:prometheus}', () => {
            assert.deepStrictEqual(m.metrics_endpoint, { path: '/metrics', port: 8080, format: 'prometheus' });
        });
        it('algorithm_map maps to SGLang uppercase enums (eagle2→EAGLE, draft-model→STANDALONE)', () => {
            assert.strictEqual(m.algorithm_map.eagle2, 'EAGLE');
            assert.strictEqual(m.algorithm_map['draft-model'], 'STANDALONE');
            assert.strictEqual(m.algorithm_map.eagle3, 'EAGLE3');
        });
    });

    // ── ADR-004: plugin parity — every engine has a schema-valid manifest ────
    describe('ADR-004: serve-engine plugin parity', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
        // Discover engine dirs dynamically so a future manifest-less engine fails.
        const engineDirs = ALL_ENGINES;

        it('discovers the shipped engines', () => {
            for (const e of ['vllm', 'sglang', 'lmi', 'tensorrt-llm', 'vllm-omni']) {
                assert.ok(engineDirs.includes(e), `expected serve.d/${e}/ to exist`);
            }
        });

        for (const engine of ALL_ENGINES) {
            it(`serve.d/${engine}/manifest.json is schema-valid and declares speculative_decoding`, () => {
                const m = loadManifest(engine);
                assert.strictEqual(validate(m), true,
                    `${engine} manifest invalid: ${JSON.stringify(validate.errors)}`);
                assert.strictEqual(typeof m.speculative_decoding, 'boolean',
                    `${engine} must declare speculative_decoding as a boolean`);
            });
        }

        it('every non-speculative engine declares it explicitly (empty algorithms, not omission)', () => {
            // Derive the non-speculative set from the manifests rather than
            // pinning it — vllm-omni (diffusion) joins lmi/tensorrt-llm here.
            const nonSpeculative = ALL_ENGINES.filter((e) => loadManifest(e).speculative_decoding === false);
            assert.ok(nonSpeculative.length > 0, 'expected at least one non-speculative engine');
            for (const engine of nonSpeculative) {
                const m = loadManifest(engine);
                assert.deepStrictEqual(m.supported_algorithms, [],
                    `${engine} must declare an empty supported_algorithms`);
                assert.deepStrictEqual(m.algorithm_map, {},
                    `${engine} must declare an empty algorithm_map`);
            }
        });

        it('the known speculative engines declare speculative_decoding:true', () => {
            for (const engine of ['vllm', 'sglang']) {
                assert.strictEqual(loadManifest(engine).speculative_decoding, true);
            }
        });
    });

    // ── ADR-004 T4: speculative-decoding acceptance is manifest-driven ───────
    // The manifest's supported_algorithms is the SOLE authority on which
    // algorithms an engine accepts, and algorithm_map is the SOLE source of the
    // engine-specific emitted names. This holds uniformly for every engine —
    // including the non-speculative ones, which reject ALL algorithms because
    // their supported_algorithms is [].
    describe('ADR-004 T4: manifest-driven speculative acceptance', () => {
        // The universe of MLCC algorithm names a user could request.
        const ALGO_UNIVERSE = ['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp', 'medusa', 'lookahead'];

        // accept(engine, alg) mirrors do/draft's decision: alg ∈ supported_algorithms.
        const accepts = (engine, alg) => loadManifest(engine).supported_algorithms.includes(alg);

        it('each engine accepts EXACTLY the algorithms in its supported_algorithms', () => {
            for (const engine of ALL_ENGINES) {
                const supported = new Set(loadManifest(engine).supported_algorithms);
                for (const alg of ALGO_UNIVERSE) {
                    assert.strictEqual(accepts(engine, alg), supported.has(alg),
                        `${engine} accept(${alg}) must equal membership in supported_algorithms`);
                }
            }
        });

        it('every non-speculative engine rejects every algorithm', () => {
            const nonSpeculative = ALL_ENGINES.filter((e) => loadManifest(e).speculative_decoding === false);
            for (const engine of nonSpeculative) {
                for (const alg of ALGO_UNIVERSE) {
                    assert.strictEqual(accepts(engine, alg), false,
                        `${engine} must reject ${alg} (no speculative decoding)`);
                }
            }
        });

        it('every supported algorithm has an algorithm_map entry (emitted name comes from data)', () => {
            for (const engine of ALL_ENGINES) {
                const m = loadManifest(engine);
                for (const alg of m.supported_algorithms) {
                    assert.ok(alg in m.algorithm_map,
                        `${engine}: supported algorithm "${alg}" must have an algorithm_map entry`);
                    assert.strictEqual(typeof m.algorithm_map[alg], 'string');
                    assert.ok(m.algorithm_map[alg].length > 0,
                        `${engine}: algorithm_map["${alg}"] must be a non-empty engine name`);
                }
            }
        });

        it('algorithm_map never maps an UNsupported algorithm (no orphan mappings)', () => {
            for (const engine of ALL_ENGINES) {
                const m = loadManifest(engine);
                const supported = new Set(m.supported_algorithms);
                for (const alg of Object.keys(m.algorithm_map)) {
                    assert.ok(supported.has(alg),
                        `${engine}: algorithm_map has "${alg}" not in supported_algorithms`);
                }
            }
        });

        it('vLLM and SGLang emit DIFFERENT engine names for the same MLCC algorithm (data, not code)', () => {
            const vllm = loadManifest('vllm').algorithm_map;
            const sglang = loadManifest('sglang').algorithm_map;
            // draft-model is supported by both but maps to different engine names.
            assert.strictEqual(vllm['draft-model'], 'draft_model');
            assert.strictEqual(sglang['draft-model'], 'STANDALONE');
            assert.notStrictEqual(vllm['draft-model'], sglang['draft-model']);
        });
    });

    // ── Requirement 3: CI schema validation ──────────────────────────────────
    describe('Requirement 3: schema validated in CI', () => {
        it('the validator script passes for the shipped manifests', () => {
            const out = execFileSync('node', [VALIDATOR], { encoding: 'utf8' });
            assert.match(out, /valid against the schema/);
        });

        it('the schema rejects a deliberately-broken manifest fixture', () => {
            const ajv = new Ajv({ allErrors: true, strict: false });
            const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
            // Missing required fields + bad prefix.
            const broken = { engine: 'broken', env_var_prefix: 'lowercase' };
            assert.strictEqual(validate(broken), false);
        });

        it('the validator script exits non-zero when a broken manifest is present', function () {
            this.timeout(20000);
            // Build a throwaway serve.d tree with a broken manifest and point a
            // copy of the validator at it via a temp checkout-like layout is
            // heavy; instead we assert the schema-level rejection above and the
            // pass path here. The CI wiring runs the real script over the tree.
            const tmp = resolve(os.tmpdir(), `bl105-${Date.now()}`);
            mkdirSync(resolve(tmp, 'templates', 'code', 'serve.d', 'brokenengine'), { recursive: true });
            mkdirSync(resolve(tmp, 'scripts'), { recursive: true });
            // Copy schema + validator into the temp tree.
            writeFileSync(resolve(tmp, 'templates', 'code', 'serve.d', 'manifest.schema.json'),
                readFileSync(SCHEMA_PATH, 'utf8'));
            writeFileSync(resolve(tmp, 'scripts', 'validate-serve-manifests.js'),
                readFileSync(VALIDATOR, 'utf8'));
            // Broken: missing required fields.
            writeFileSync(
                resolve(tmp, 'templates', 'code', 'serve.d', 'brokenengine', 'manifest.json'),
                JSON.stringify({ engine: 'brokenengine' }));
            let failed = false;
            try {
                execFileSync('node', [resolve(tmp, 'scripts', 'validate-serve-manifests.js')],
                    { encoding: 'utf8', stdio: 'pipe' });
            } catch {
                failed = true;
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
            assert.ok(failed, 'validator must exit non-zero on a broken manifest');
        });
    });

    // ── BL129: capability-versioning schema fields ───────────────────────────
    describe('BL129: min_version / version_features schema', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
        const base = {
            engine: 'x', env_var_prefix: 'X_', speculative_decoding: false,
            supported_algorithms: [], algorithm_map: {}, hot_reload: false
        };

        it('accepts a manifest with neither version field (back-compat)', () => {
            assert.strictEqual(validate(base), true);
        });

        it('accepts valid min_version + version_features', () => {
            assert.strictEqual(validate({
                ...base,
                min_version: '0.6.0',
                version_features: [{ since: '0.8.0', adds: { supported_algorithms: ['mtp'] } }]
            }), true);
        });

        it('rejects a non-semver min_version', () => {
            assert.strictEqual(validate({ ...base, min_version: '1.2' }), false);
        });

        it('rejects a version_features entry missing `since`', () => {
            assert.strictEqual(validate({
                ...base, version_features: [{ adds: { supported_algorithms: ['a'] } }]
            }), false);
        });

        it('rejects an unknown key inside `adds`', () => {
            assert.strictEqual(validate({
                ...base, version_features: [{ since: '1.0.0', adds: { bogus: 1 } }]
            }), false);
        });

        it('the shipped vLLM manifest gates a subset of its flat supported_algorithms', () => {
            const m = loadManifest('vllm');
            const flat = new Set(m.supported_algorithms);
            for (const vf of m.version_features || []) {
                for (const alg of vf.adds.supported_algorithms || []) {
                    assert.ok(flat.has(alg),
                        `version_features adds '${alg}' which must be in flat supported_algorithms`);
                }
            }
        });
    });

    // ── Migration / back-compat ──────────────────────────────────────────────
    describe('Migration: nested EJS include renders for each engine', () => {
        const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');
        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm', 'lmi']) {
            it(`serve template renders with modelServer=${modelServer} via serve.d/${modelServer}/${modelServer}`, () => {
                const rendered = ejs.render(SERVE_TEMPLATE, {
                    modelSource: 'huggingface',
                    modelServer,
                    modelName: 'test-model',
                    artifactUri: '',
                    modelLoadStrategy: 'runtime'
                }, { filename: SERVE_TEMPLATE_PATH });
                assert.ok(rendered.length > 0);
                assert.ok(rendered.includes('Starting'), 'rendered serve script should include startup banner');
            });
        }

        it('the serve template references the nested include path', () => {
            assert.match(SERVE_TEMPLATE, /serve\.d\/' \+ modelServer \+ '\/' \+ modelServer/);
            assert.match(SERVE_TEMPLATE, /serve\.d\/lmi\/lmi/);
        });
    });
});
