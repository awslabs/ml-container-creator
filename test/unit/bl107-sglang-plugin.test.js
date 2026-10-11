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
import {
    readEnvVarPrefix,
    effectiveSupportedAlgorithms,
    minVersion,
    isVersionSupported,
    engineVersionFromBaseImage,
    engineFeature,
    engineFeatures
} from '../../src/lib/serve-manifest-reader.js';

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

    // ── Model path is unconditional, never whitelist-gated (A + C) ───────────
    // The model path is the one flag SGLang cannot start without. It must be
    // assembled explicitly, outside the best-effort `--help` whitelist that
    // governs optional knobs, and startup must fail loud if it is empty — the
    // field failure mode was a model-less `[--host --port]` arg list produced
    // with no warning when `--help` introspection failed.
    describe('model path is load-bearing (A: unconditional, C: fail-loud)', () => {
        it('assembles --model-path from <PREFIX>MODEL_PATH outside the whitelist loop', () => {
            const rendered = renderSglangServe({ envVarPrefix: 'SGLANG_' });
            assert.ok(
                /SERVER_ARGS\+=\(--model-path "\$\{_sglang_model_path\}"\)/.test(rendered),
                '--model-path must be appended unconditionally, not via the SGLANG_* whitelist loop'
            );
            assert.ok(
                /_sglang_model_path="\$\{SGLANG_MODEL_PATH:-\}"/.test(rendered),
                'the model path must come from <PREFIX>MODEL_PATH'
            );
        });

        it('skips <PREFIX>MODEL_PATH in the generic loop so it is not double-added', () => {
            const rendered = renderSglangServe({ envVarPrefix: 'SGLANG_' });
            // The skip case must list the MODEL_PATH key alongside the speculative keys.
            assert.ok(
                /SGLANG_MODEL_PATH\|SGLANG_SPECULATIVE_ALGORITHM/.test(rendered),
                'SGLANG_MODEL_PATH must be in the loop skip-case so the generic loop does not also emit it'
            );
        });

        it('refuses to start when the model path is empty (fail-loud guard)', () => {
            const rendered = renderSglangServe({ envVarPrefix: 'SGLANG_' });
            assert.ok(
                /if \[ -z "\$\{_sglang_model_path\}" \]; then/.test(rendered),
                'must guard an empty model path'
            );
            assert.ok(
                /FATAL: no model path resolved/.test(rendered) && /exit 1/.test(rendered),
                'the empty-model-path guard must print a FATAL message and exit non-zero'
            );
        });

        it('the model path is prefix-derived (a different injected prefix flows through)', () => {
            const rendered = renderSglangServe({ envVarPrefix: 'ZZZ_' });
            assert.ok(
                /_sglang_model_path="\$\{ZZZ_MODEL_PATH:-\}"/.test(rendered),
                'the model path read must track the injected prefix, not a hardcoded SGLANG_'
            );
            assert.ok(
                /ZZZ_MODEL_PATH\|ZZZ_SPECULATIVE_ALGORITHM/.test(rendered),
                'the loop skip-case must track the injected prefix'
            );
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

    // ── BL129: version-gated capabilities ────────────────────────────────────
    // These assert BEHAVIOR derived from the manifest, not frozen version
    // literals. They read the gate boundaries out of the manifest itself so a
    // legitimate version bump (new min_version / new since) can't silently break
    // them — a change only fails if the effective-set derivation stops honoring
    // the declared gates.
    //
    // The version-gating MECHANISM (below/at/above a gate) is exercised against a
    // reference engine that currently declares LIVE gates ABOVE its floor. SGLang
    // no longer qualifies: its `sglang serve` entrypoint set min_version to 0.5.0,
    // which is ABOVE the only historical gate (mtp @ 0.4.0), so that gate became
    // dead and was removed from the manifest (mtp stays in the flat
    // supported_algorithms). vLLM still declares gates above its floor (mtp @ 0.8.0,
    // dspark @ 0.10.2), so it is the mechanism reference. SGLang keeps its own
    // assertions below for the no-gates case.
    describe('BL129: engine version-gating (min_version + version_features)', () => {
        const REF_ENGINE = 'vllm';
        function loadRefManifest() {
            return JSON.parse(readFileSync(
                resolve(SERVE_D, REF_ENGINE, 'manifest.json'), 'utf8'));
        }

        it(`${REF_ENGINE} (gating reference) declares a semver min_version and ≥1 gate`, () => {
            const m = loadRefManifest();
            assert.match(m.min_version, /^\d+\.\d+\.\d+$/,
                `${REF_ENGINE} declares a semver min_version`);
            assert.ok(Array.isArray(m.version_features) && m.version_features.length > 0,
                `${REF_ENGINE} declares at least one version_features gate`);
            for (const f of m.version_features) {
                assert.match(f.since, /^\d+\.\d+\.\d+$/, `since "${f.since}" is semver`);
                assert.ok(f.adds && Array.isArray(f.adds.supported_algorithms),
                    'each gate adds supported_algorithms');
            }
        });

        it('the gate reader returns the manifest min_version for sglang', () => {
            assert.strictEqual(minVersion('sglang'), loadSglangManifest().min_version);
        });

        it(`every gated algorithm is a subset of ${REF_ENGINE}'s flat supported_algorithms`, () => {
            const m = loadRefManifest();
            const flat = new Set(m.supported_algorithms);
            for (const f of m.version_features) {
                for (const alg of f.adds.supported_algorithms) {
                    assert.ok(flat.has(alg),
                        `gated algorithm "${alg}" must appear in the flat supported_algorithms`);
                }
            }
        });

        it('below a gate, that gate\'s algorithms are removed; at/above, present (data-driven)', () => {
            const m = loadRefManifest();
            // Pick the highest gate as the boundary under test, derived from the manifest.
            const gate = m.version_features
                .slice()
                .sort((a, b) => a.since.localeCompare(b.since, undefined, { numeric: true }))
                .at(-1);
            const [maj, min, patch] = gate.since.split('.').map(Number);
            const below = patch > 0
                ? `${maj}.${min}.${patch - 1}`
                : (min > 0 ? `${maj}.${min - 1}.0` : `${Math.max(0, maj - 1)}.0.0`);

            const atGate = effectiveSupportedAlgorithms(REF_ENGINE, gate.since);
            const belowGate = effectiveSupportedAlgorithms(REF_ENGINE, below);

            for (const alg of gate.adds.supported_algorithms) {
                assert.ok(atGate.includes(alg),
                    `${alg} must be present at the gate version ${gate.since}`);
                assert.ok(!belowGate.includes(alg),
                    `${alg} must be gated out below ${gate.since} (checked ${below})`);
            }
            // The effective set below the gate is a strict subset of the flat set.
            assert.ok(belowGate.length < m.supported_algorithms.length,
                'a below-gate version must yield fewer algorithms than the flat set');
        });

        it('SGLang declares no version_features → effective set equals flat at any version', () => {
            // SGLang's floor (0.5.0) is above its only historical gate (0.4.0), so it
            // declares no gates: every supported version has the full algorithm set.
            const m = loadSglangManifest();
            assert.ok(!m.version_features || m.version_features.length === 0,
                'SGLang declares no version_features (its historical gate is below the floor)');
            for (const v of ['0.5.0', '0.5.21', '9.9.9', null]) {
                assert.deepStrictEqual(
                    [...effectiveSupportedAlgorithms('sglang', v)].sort(),
                    [...m.supported_algorithms].sort(),
                    `sglang effective set must equal flat at version ${v}`);
            }
        });

        it('fails open: an unresolvable/null version yields the full flat set', () => {
            const m = loadRefManifest();
            const eff = effectiveSupportedAlgorithms(REF_ENGINE, null);
            assert.deepStrictEqual([...eff].sort(), [...m.supported_algorithms].sort(),
                'null version must not gate anything (fail-open)');
        });

        it('isVersionSupported honors min_version (fail-open on null)', () => {
            const mv = loadSglangManifest().min_version;
            const [maj, min] = mv.split('.').map(Number);
            const below = min > 0 ? `${maj}.${min - 1}.0` : `${Math.max(0, maj - 1)}.0.0`;
            assert.strictEqual(isVersionSupported('sglang', mv), true, 'at min_version → supported');
            assert.strictEqual(isVersionSupported('sglang', below), false, 'below min_version → not supported');
            assert.strictEqual(isVersionSupported('sglang', null), true, 'null → fail-open supported');
        });

        it('resolves the engine version from a real catalog base image and gates accordingly', () => {
            // Derive the base image from the catalog rather than hardcoding a tag,
            // so catalog version bumps (sync-serving-versions) don't break this.
            const catalog = JSON.parse(readFileSync(
                resolve(ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json'), 'utf8'));
            const newest = (catalog.sglang || [])[0];
            assert.ok(newest && newest.image, 'catalog has at least one sglang image');

            const resolved = engineVersionFromBaseImage('sglang', newest.image);
            assert.match(resolved, /^\d+\.\d+\.\d+$/, 'resolves a semver version from the image');

            // The newest shipped image must get the FULL flat set (all gates satisfied).
            const eff = effectiveSupportedAlgorithms('sglang', resolved);
            assert.deepStrictEqual([...eff].sort(), [...loadSglangManifest().supported_algorithms].sort(),
                'the newest shipped image reaches every gated capability');
        });
    });

    // ── dimension_map: benchmark-dimension → engine key mapping ──────────────
    describe('SGLang dimension_map (benchmark dimension → engine config key)', () => {
        it('maps the core benchmark dimensions to SGLang-specific keys', () => {
            const dm = loadSglangManifest().dimension_map;
            // Behavioral: the map is non-empty and covers the dimensions the
            // benchmark layer varies. Values are SGLang's own key names.
            assert.ok(dm && typeof dm === 'object', 'dimension_map is an object');
            for (const dim of ['quantization', 'tensor_parallel_degree', 'max_model_len', 'kv_cache_dtype']) {
                assert.ok(typeof dm[dim] === 'string' && dm[dim].length > 0,
                    `dimension "${dim}" maps to a non-empty engine key`);
            }
            // SGLang uses TP_SIZE / CONTEXT_LENGTH where vLLM uses different names —
            // prove the map is engine-specific, not copied from vLLM.
            assert.strictEqual(dm.tensor_parallel_degree, 'TP_SIZE');
            assert.strictEqual(dm.max_model_len, 'CONTEXT_LENGTH');
        });

        it('combined with env_var_prefix yields a full SGLANG_ config key', () => {
            const m = loadSglangManifest();
            const full = `${m.env_var_prefix}${m.dimension_map.tensor_parallel_degree}`;
            assert.strictEqual(full, 'SGLANG_TP_SIZE',
                'prefix + dimension key composes the engine env var');
        });
    });

    // ── engine_features: RadixAttention is SGLang's showcase deviation ───────
    // The reader is generic (no engine-name branch); these assert SGLang's
    // declared feature and that the reader returns it as data.
    describe('SGLang engine_features (RadixAttention — a vLLM-differs feature)', () => {
        it('declares radix_attention via the generic engine_features reader', () => {
            const f = engineFeature('sglang', 'radix_attention');
            assert.ok(f, 'sglang must declare radix_attention');
            assert.strictEqual(f.type, 'boolean');
            assert.strictEqual(f.env_var, 'SGLANG_ENABLE_RADIX_CACHE',
                'the controlling env var is the real SGLang RadixAttention toggle');
            assert.ok(f.description && f.description.length > 0, 'feature carries a description');
        });

        it('the feature env var composes from the engine prefix (manifest-sourced)', () => {
            const m = loadSglangManifest();
            const f = engineFeature('sglang', 'radix_attention');
            assert.ok(f.env_var.startsWith(m.env_var_prefix),
                'the feature env var is a SGLANG_ var, consistent with env_var_prefix');
        });

        it('reads back as an empty map default for an engine with no features (generic reader)', () => {
            // The reader never throws / never branches on engine name: a
            // feature-less engine yields {} and a missing feature yields null.
            assert.deepStrictEqual(engineFeatures('tensorrt-llm'), {});
            assert.strictEqual(engineFeature('sglang', 'does-not-exist'), null);
        });
    });
});
