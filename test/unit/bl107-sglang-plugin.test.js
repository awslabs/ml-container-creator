// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL107 SGLang Serve-Layer Plugin — Example / Integration Tests
 *
 * Feature: v18-w3-01-bl107
 *
 * Covers:
 *   Requirement 1 — SGLang Plugin_Directory + manifest field values
 *   Requirement 2 — manifest-driven serve wrapper (env prefix injection)
 *   Requirement 3 — hardcoded sglang case statements retired in do/draft & do/deploy
 *   Requirement 5 — CI schema validation covers the SGLang manifest
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvVarPrefix } from '../../src/lib/serve-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const SCHEMA_PATH = resolve(SERVE_D, 'manifest.schema.json');
const SGLANG_DIR = resolve(SERVE_D, 'sglang');
const SGLANG_MANIFEST = resolve(SGLANG_DIR, 'manifest.json');
const SGLANG_WRAPPER = resolve(SGLANG_DIR, 'sglang.ejs');
const SERVE_TEMPLATE_PATH = resolve(ROOT, 'templates', 'code', 'serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');
const DRAFT = readFileSync(resolve(ROOT, 'templates', 'do', 'draft'), 'utf8');
const DEPLOY_HYPERPOD = readFileSync(resolve(ROOT, 'templates', 'do', 'deploy.d', 'hyperpod-eks'), 'utf8');

function loadSglangManifest() {
    return JSON.parse(readFileSync(SGLANG_MANIFEST, 'utf8'));
}

function renderSglangServe(overrides = {}) {
    return ejs.render(SERVE_TEMPLATE, {
        modelSource: 'huggingface',
        modelServer: 'sglang',
        modelName: 'test-model',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        ...overrides
    }, { filename: SERVE_TEMPLATE_PATH });
}

describe('Feature: v18-w3-01-bl107 — SGLang plugin', () => {

    // ── Requirement 1: Plugin_Directory + manifest ──────────────────────────
    describe('Requirement 1: SGLang Plugin_Directory and manifest', () => {
        it('serve.d/sglang/ holds both manifest.json and sglang.ejs', () => {
            assert.ok(existsSync(SGLANG_MANIFEST), 'manifest.json must exist');
            assert.ok(existsSync(SGLANG_WRAPPER), 'sglang.ejs must exist');
        });

        it('the flat serve.d/sglang.ejs no longer exists', () => {
            assert.ok(!existsSync(resolve(SERVE_D, 'sglang.ejs')),
                'flat wrapper must be relocated');
        });

        it('supported_algorithms is exactly [eagle3, eagle2, eagle, draft-model, mtp]', () => {
            const m = loadSglangManifest();
            assert.deepStrictEqual(m.supported_algorithms,
                ['eagle3', 'eagle2', 'eagle', 'draft-model', 'mtp']);
            for (const excluded of ['ngram', 'standalone', 'medusa']) {
                assert.ok(!m.supported_algorithms.includes(excluded),
                    `${excluded} must not be a supported algorithm`);
            }
        });

        it('env_var_prefix is SGLANG_', () => {
            assert.strictEqual(loadSglangManifest().env_var_prefix, 'SGLANG_');
        });

        it('declares hot_reload (boolean)', () => {
            assert.strictEqual(typeof loadSglangManifest().hot_reload, 'boolean');
        });

        it('declares metrics_endpoint {path:/metrics, port:8080, format:prometheus}', () => {
            assert.deepStrictEqual(loadSglangManifest().metrics_endpoint,
                { path: '/metrics', port: 8080, format: 'prometheus' });
        });

        it('algorithm_map uses the SGLang uppercase enums', () => {
            assert.deepStrictEqual(loadSglangManifest().algorithm_map, {
                eagle3: 'EAGLE3',
                eagle2: 'EAGLE',
                eagle: 'EAGLE',
                'draft-model': 'STANDALONE',
                mtp: 'MTP'
            });
        });
    });

    // ── Requirement 2: manifest-driven serve wrapper ────────────────────────
    describe('Requirement 2: manifest-driven serve wrapper', () => {
        it('the generation-time reader returns SGLANG_ for sglang', () => {
            assert.strictEqual(readEnvVarPrefix('sglang'), 'SGLANG_');
        });

        it('the reader returns empty for a non-plugin engine', () => {
            assert.strictEqual(readEnvVarPrefix('flask'), '');
        });

        it('rendered do/serve carries PREFIX="SGLANG_" from the manifest', () => {
            const rendered = renderSglangServe({ envVarPrefix: readEnvVarPrefix('sglang') });
            assert.ok(rendered.includes('PREFIX="SGLANG_"'));
            assert.ok(rendered.includes('SGLANG_SPECULATIVE_ALGORITHM'));
            assert.ok(rendered.includes('SGLANG_SPECULATIVE_DRAFT_MODEL_PATH'));
            assert.ok(rendered.includes('SGLANG_SPECULATIVE_NUM_STEPS'));
            assert.ok(rendered.includes('SGLANG_SPECULATIVE_EAGLE_TOPK'));
        });

        it('a different injected prefix flows into every speculative read (data-driven)', () => {
            const rendered = renderSglangServe({ envVarPrefix: 'ZZZ_' });
            assert.ok(rendered.includes('PREFIX="ZZZ_"'));
            assert.ok(rendered.includes('ZZZ_SPECULATIVE_ALGORITHM'));
            assert.ok(!rendered.includes('SGLANG_SPECULATIVE_ALGORITHM'),
                'no hardcoded SGLANG_ literal should remain when a different prefix is injected');
        });

        it('the wrapper source contains no hardcoded PREFIX="SGLANG_" literal', () => {
            const wrapper = readFileSync(SGLANG_WRAPPER, 'utf8');
            assert.ok(!wrapper.includes('PREFIX="SGLANG_"'),
                'the wrapper must derive PREFIX from the manifest, not hardcode it');
            assert.ok(wrapper.includes('envVarPrefix'),
                'the wrapper must reference the injected envVarPrefix');
        });
    });

    // ── Requirement 3: retire hardcoded case statements ─────────────────────
    describe('Requirement 3: hardcoded sglang case statements retired', () => {
        it('do/draft validates algorithms via the manifest reader (no sglang reject-case)', () => {
            assert.ok(DRAFT.includes('serve_manifest.py'),
                'do/draft must read supported_algorithms from the manifest');
            assert.ok(!DRAFT.includes('SGLang supports: eagle3, eagle2, eagle, draft-model, mtp'),
                'the hardcoded SGLang reject message must be retired');
        });

        it('do/draft --help derives the per-engine algorithm lists from the manifest', () => {
            assert.ok(DRAFT.includes('_draft_help_algos'),
                'help text must build engine algorithm lists from the manifest');
        });

        it('do/deploy hyperpod-eks reads algorithm_map instead of a hardcoded enum case', () => {
            assert.ok(DEPLOY_HYPERPOD.includes('serve_manifest.py'));
            assert.ok(DEPLOY_HYPERPOD.includes('algorithm_map'));
            assert.ok(!DEPLOY_HYPERPOD.includes('export SGLANG_SPECULATIVE_ALGORITHM="STANDALONE"'),
                'the hardcoded STANDALONE enum arm must be retired');
            assert.ok(!DEPLOY_HYPERPOD.includes('export SGLANG_SPECULATIVE_ALGORITHM="EAGLE3"'),
                'the hardcoded EAGLE3 enum arm must be retired');
        });
    });

    // ── Requirement 5: CI schema validation ─────────────────────────────────
    describe('Requirement 5: SGLang manifest validates against the schema', () => {
        it('the shipped SGLang manifest passes the BL105 schema', () => {
            const ajv = new Ajv({ allErrors: true, strict: false });
            const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
            const ok = validate(loadSglangManifest());
            assert.ok(ok, `SGLang manifest must validate: ${JSON.stringify(validate.errors)}`);
        });
    });
});
