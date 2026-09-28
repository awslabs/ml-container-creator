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
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

describe('Feature: v18-w2-02-bl105 — structure & shipped manifests', () => {

    // ── Requirement 1: Plugin_Directory ─────────────────────────────────────
    describe('Requirement 1: per-engine Plugin_Directory', () => {
        for (const engine of ['vllm', 'sglang', 'lmi', 'tensorrt-llm']) {
            it(`serve.d/${engine}/ contains the relocated wrapper ${engine}.ejs`, () => {
                assert.ok(existsSync(resolve(SERVE_D, engine, `${engine}.ejs`)),
                    `serve.d/${engine}/${engine}.ejs must exist`);
            });
        }

        for (const engine of ['vllm', 'sglang']) {
            it(`serve.d/${engine}/ contains manifest.json`, () => {
                assert.ok(existsSync(resolve(SERVE_D, engine, 'manifest.json')),
                    `serve.d/${engine}/manifest.json must exist`);
            });
        }

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
                ['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp']);
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
