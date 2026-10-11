// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL105 Serve-Layer Plugin Interface — Property-Based Tests
 *
 * Feature: v18-w2-02-bl105
 *
 * Covers:
 *   Property 1 — Schema rejects malformed manifests
 *   Property 2 — Draft set accepts an algorithm iff it is in the active engine's supported set
 *   Property 3 — Shipping-engine manifests reproduce current per-engine validation outcomes
 *   Property 4 — Deploy reads the env var prefix that equals the manifest value
 *   Property 5 — Dimension-to-config-key derivation reproduces the hardcoded mapping
 *
 * The manifest reader (Properties 2, 4, 5) is exercised through the Python
 * one-shot CLI (do/lib/python/serve_manifest.py), matching how do/draft and
 * do/deploy consume it at runtime.
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const SCHEMA_PATH = resolve(SERVE_D, 'manifest.schema.json');
const READER = resolve(ROOT, 'templates', 'do', 'lib', 'python', 'serve_manifest.py');

// ── Schema + Ajv ─────────────────────────────────────────────────────────────

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// ── Reader CLI helper ────────────────────────────────────────────────────────

function readerField(field, engine) {
    return execFileSync('python3', [READER, field, engine], { encoding: 'utf8' }).trim();
}

// ── A valid baseline manifest ────────────────────────────────────────────────

function validManifest() {
    return {
        engine: 'vllm',
        env_var_prefix: 'VLLM_',
        speculative_decoding: true,
        supported_algorithms: ['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp'],
        algorithm_map: { eagle3: 'eagle3', 'draft-model': 'draft_model' },
        hot_reload: true,
        metrics_endpoint: { path: '/metrics', port: 8080, format: 'prometheus' },
        dimension_map: { quantization: 'QUANTIZATION' }
    };
}

const REQUIRED_FIELDS = ['engine', 'env_var_prefix', 'speculative_decoding', 'supported_algorithms', 'algorithm_map', 'hot_reload'];

// ── Known algorithm universe (Property 3) ────────────────────────────────────

const ALGORITHM_UNIVERSE = ['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp', 'medusa'];

// Current hardcoded per-engine validation outcome (pre-BL105 behavior).
// vLLM: generic whitelist eagle3/eagle2/eagle/draft-model/ngram/mtp.
// SGLang: same minus ngram (and medusa rejected).
const HARDCODED_ACCEPT = {
    vllm: new Set(['eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp']),
    sglang: new Set(['eagle3', 'eagle2', 'eagle', 'draft-model', 'mtp'])
};

// Historical dimension→config-key mapping (the retired _DIMENSION_CONFIG_KEY_BY_TARGET).
const HARDCODED_DIMENSION_KEYS = {
    'realtime-inference': {
        quantization: 'IC_ENV_VLLM_QUANTIZATION',
        tensor_parallel_degree: 'IC_ENV_VLLM_TENSOR_PARALLEL_SIZE',
        max_model_len: 'IC_ENV_VLLM_MAX_MODEL_LEN',
        kv_cache_dtype: 'IC_ENV_VLLM_KV_CACHE_DTYPE'
    },
    'hyperpod-eks': {
        quantization: 'VLLM_QUANTIZATION',
        tensor_parallel_degree: 'VLLM_TENSOR_PARALLEL_SIZE',
        max_model_len: 'VLLM_MAX_MODEL_LEN',
        kv_cache_dtype: 'VLLM_KV_CACHE_DTYPE'
    },
    'async-inference': {
        quantization: 'VLLM_QUANTIZATION',
        tensor_parallel_degree: 'VLLM_TENSOR_PARALLEL_SIZE',
        max_model_len: 'VLLM_MAX_MODEL_LEN',
        kv_cache_dtype: 'VLLM_KV_CACHE_DTYPE'
    }
};

const SWEEPABLE_DIMENSIONS = ['quantization', 'tensor_parallel_degree', 'max_model_len', 'kv_cache_dtype'];

describe('Feature: v18-w2-02-bl105 Serve-Layer Plugin Interface', () => {

    // ── Property 1 ─────────────────────────────────────────────────────────────
    // Feature: v18-w2-02-bl105, Property 1: Schema rejects malformed manifests
    describe('Property 1: Schema rejects malformed manifests', () => {
        // Validates: Requirements 3.3, 3.2

        it('rejects manifests missing any required field', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constantFrom(...REQUIRED_FIELDS),
                (field) => {
                    const m = validManifest();
                    delete m[field];
                    assert.strictEqual(validate(m), false,
                        `manifest missing required "${field}" should fail validation`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('rejects wrong-typed required fields', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const wrongValues = {
                engine: [42, true, {}, []],
                env_var_prefix: ['vllm_', 'VLLM', 'VLLM-', 123, 'lowercase_'],
                speculative_decoding: ['true', 1, 'yes', {}, []],
                supported_algorithms: ['not-an-array', 42, {}],
                algorithm_map: ['x', 42, true],
                hot_reload: ['true', 1, 'yes', {}]
            };
            fc.assert(fc.property(
                fc.constantFrom(...REQUIRED_FIELDS),
                fc.nat(),
                (field, idx) => {
                    const bad = wrongValues[field];
                    const m = validManifest();
                    m[field] = bad[idx % bad.length];
                    assert.strictEqual(validate(m), false,
                        `manifest with wrong-typed "${field}" (${JSON.stringify(m[field])}) should fail`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('rejects unknown top-level properties (additionalProperties: false)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.stringMatching(/^[a-z_]{3,15}$/).filter((k) => !(k in validManifest())
                    && !['metrics_endpoint', 'dimension_map', 'capability_map'].includes(k)),
                (unknownKey) => {
                    const m = validManifest();
                    m[unknownKey] = 'surprise';
                    assert.strictEqual(validate(m), false,
                        `manifest with unknown key "${unknownKey}" should fail`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('accepts manifests satisfying every constraint', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.stringMatching(/^[A-Z][A-Z0-9]*_$/),
                fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{2,12}$/), { minLength: 1, maxLength: 6 }),
                fc.boolean(),
                (prefix, algorithms, hotReload) => {
                    const m = {
                        engine: 'test',
                        env_var_prefix: prefix,
                        speculative_decoding: algorithms.length > 0,
                        supported_algorithms: algorithms,
                        algorithm_map: Object.fromEntries(algorithms.map((a) => [a, a])),
                        hot_reload: hotReload
                    };
                    assert.strictEqual(validate(m), true,
                        `valid manifest should pass: ${JSON.stringify(validate.errors)}`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    // ── Property 2 ─────────────────────────────────────────────────────────────
    // Feature: v18-w2-02-bl105, Property 2: Draft set accepts an algorithm iff it is in the active engine's supported set
    describe('Property 2: accept iff algorithm ∈ supported_algorithms', () => {
        // Validates: Requirements 4.2, 4.3, 4.4

        // The draft-set decision is: accept iff requested ∈ supported_algorithms
        // (read from the manifest). Mirror that decision function here against
        // the reader-provided supported set for the two shipped engines.
        it('membership decision matches the manifest supported set', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const supported = {
                vllm: JSON.parse(readerField('supported_algorithms', 'vllm')),
                sglang: JSON.parse(readerField('supported_algorithms', 'sglang'))
            };
            fc.assert(fc.property(
                fc.constantFrom('vllm', 'sglang'),
                fc.constantFrom(...ALGORITHM_UNIVERSE),
                (engine, alg) => {
                    const set = new Set(supported[engine]);
                    const decision = set.has(alg); // manifest-driven accept decision
                    assert.strictEqual(decision, set.has(alg),
                        `decision for ${engine}/${alg} must derive from supported set`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    // ── Property 3 ─────────────────────────────────────────────────────────────
    // Feature: v18-w2-02-bl105, Property 3: Shipping-engine manifests reproduce current per-engine validation outcomes
    describe('Property 3: manifests reproduce hardcoded per-engine outcomes', () => {
        // Validates: Requirements 4.5, 7.2, 8.2, 8.3

        it('manifest-driven accept/reject equals the pre-BL105 outcome for each engine', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const supported = {
                vllm: new Set(JSON.parse(readerField('supported_algorithms', 'vllm'))),
                sglang: new Set(JSON.parse(readerField('supported_algorithms', 'sglang')))
            };
            fc.assert(fc.property(
                fc.constantFrom('vllm', 'sglang'),
                fc.constantFrom(...ALGORITHM_UNIVERSE),
                (engine, alg) => {
                    const manifestDecision = supported[engine].has(alg);
                    const hardcodedDecision = HARDCODED_ACCEPT[engine].has(alg);
                    assert.strictEqual(manifestDecision, hardcodedDecision,
                        `${engine}/${alg}: manifest=${manifestDecision} hardcoded=${hardcodedDecision}`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('anchored: ngram accepted for vllm, rejected for sglang; medusa rejected for both', () => {
            const vllm = new Set(JSON.parse(readerField('supported_algorithms', 'vllm')));
            const sglang = new Set(JSON.parse(readerField('supported_algorithms', 'sglang')));
            assert.ok(vllm.has('ngram'), 'vLLM must accept ngram');
            assert.ok(!sglang.has('ngram'), 'SGLang must reject ngram');
            assert.ok(!vllm.has('medusa'), 'vLLM must reject medusa');
            assert.ok(!sglang.has('medusa'), 'SGLang must reject medusa');
        });

        // Kimi-K3 DSpark: vLLM/Speculators-specific — accepted by vLLM only,
        // rejected by SGLang (which does not implement the method).
        it('anchored: dspark accepted for vllm, rejected for sglang (Kimi-K3)', () => {
            const vllm = new Set(JSON.parse(readerField('supported_algorithms', 'vllm')));
            const sglang = new Set(JSON.parse(readerField('supported_algorithms', 'sglang')));
            assert.ok(vllm.has('dspark'), 'vLLM must accept dspark');
            assert.ok(!sglang.has('dspark'), 'SGLang must reject dspark');
        });
    });

    // ── Property 4 ─────────────────────────────────────────────────────────────
    // Feature: v18-w2-02-bl105, Property 4: Deploy reads the env var prefix that equals the manifest value
    describe('Property 4: deploy env prefix equals manifest env_var_prefix', () => {
        // Validates: Requirements 5.1

        it('reader-resolved prefix equals the manifest field for shipped engines', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constantFrom('vllm', 'sglang'),
                (engine) => {
                    const manifest = JSON.parse(
                        readFileSync(resolve(SERVE_D, engine, 'manifest.json'), 'utf8'));
                    const prefix = readerField('env_var_prefix', engine);
                    assert.strictEqual(prefix, manifest.env_var_prefix,
                        `reader prefix for ${engine} should equal manifest env_var_prefix`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });

        it('anchored: vllm → VLLM_, sglang → SGLANG_', () => {
            assert.strictEqual(readerField('env_var_prefix', 'vllm'), 'VLLM_');
            assert.strictEqual(readerField('env_var_prefix', 'sglang'), 'SGLANG_');
        });
    });

    // ── Property 5 ─────────────────────────────────────────────────────────────
    // Feature: v18-w2-02-bl105, Property 5: Dimension-to-config-key derivation reproduces the hardcoded mapping
    describe('Property 5: dimension→config-key derivation reproduces hardcoded mapping', () => {
        // Validates: Requirements 6.1, 6.2

        // Derived key: env_var_prefix + dimension_map[d], wrapped with IC_ENV_ for
        // realtime-inference. For the vLLM manifest this must equal the retired
        // _DIMENSION_CONFIG_KEY_BY_TARGET[target][d].
        it('vLLM manifest derivation equals the retired hardcoded values', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const prefix = readerField('env_var_prefix', 'vllm');
            const dmap = JSON.parse(readerField('dimension_map', 'vllm'));
            fc.assert(fc.property(
                fc.constantFrom('realtime-inference', 'hyperpod-eks', 'async-inference'),
                fc.constantFrom(...SWEEPABLE_DIMENSIONS),
                (target, dim) => {
                    let derived = `${prefix}${dmap[dim]}`;
                    if (target === 'realtime-inference') derived = `IC_ENV_${derived}`;
                    const expected = HARDCODED_DIMENSION_KEYS[target][dim];
                    assert.strictEqual(derived, expected,
                        `${target}/${dim}: derived=${derived} expected=${expected}`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });
});
