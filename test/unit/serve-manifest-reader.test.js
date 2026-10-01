// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the serve-layer manifest reader (src/lib/serve-manifest-reader.js).
 *
 * Covers the ADR-008 / BL105 derivation that feeds `RUNTIME_OWNED_VARS`:
 * serveEngineRuntimeVarsUnion() must yield each engine's env_var_prefix +
 * dimension_map suffixes, unioned across every serve.d engine — so `mcc
 * regenerate` preserves the benchmark-tunable engine vars regardless of which
 * engine a generated project uses (previously only vLLM's were hardcoded).
 */

import assert from 'node:assert';
import { describe, it } from 'mocha';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    readEnvVarPrefix,
    listServeEngines,
    serveEngineRuntimeVarsUnion,
    effectiveSupportedAlgorithms,
    minVersion,
    isVersionSupported,
    engineVersionFromBaseImage
} from '../../src/lib/serve-manifest-reader.js';

describe('serve-manifest-reader', () => {
    describe('readEnvVarPrefix', () => {
        it('reads the vLLM prefix from its manifest', () => {
            assert.strictEqual(readEnvVarPrefix('vllm'), 'VLLM_');
        });
        it('reads the SGLang prefix from its manifest', () => {
            assert.strictEqual(readEnvVarPrefix('sglang'), 'SGLANG_');
        });
        it('returns empty string for an unknown / non-plugin engine', () => {
            assert.strictEqual(readEnvVarPrefix('flask'), '');
            assert.strictEqual(readEnvVarPrefix(''), '');
        });
    });

    describe('listServeEngines', () => {
        it('lists the plugin engines with a manifest, sorted', () => {
            const engines = listServeEngines();
            assert.ok(engines.includes('vllm'), 'vllm must be listed');
            assert.ok(engines.includes('sglang'), 'sglang must be listed');
            assert.deepStrictEqual(engines, [...engines].sort(), 'must be sorted');
        });
    });

    describe('serveEngineRuntimeVarsUnion (ADR-008 / BL105)', () => {
        const union = serveEngineRuntimeVarsUnion();

        it('includes every vLLM benchmark-tunable var (prefix + dimension_map)', () => {
            for (const v of [
                'VLLM_QUANTIZATION',
                'VLLM_TENSOR_PARALLEL_SIZE',
                'VLLM_MAX_MODEL_LEN',
                'VLLM_KV_CACHE_DTYPE'
            ]) {
                assert.ok(union.includes(v), `union must include ${v}`);
            }
        });

        it('includes SGLang vars too — the slice the old hardcoded list missed', () => {
            for (const v of [
                'SGLANG_QUANTIZATION',
                'SGLANG_TP_SIZE',
                'SGLANG_CONTEXT_LENGTH',
                'SGLANG_KV_CACHE_DTYPE'
            ]) {
                assert.ok(union.includes(v), `union must include ${v}`);
            }
        });

        it('is sorted and de-duplicated', () => {
            assert.deepStrictEqual(union, [...new Set(union)].sort());
        });

        it('never emits a bare prefix (skips engines with no dimension_map)', () => {
            // lmi / tensorrt-llm have empty dimension_map → contribute nothing.
            assert.ok(!union.includes('LMI_'), 'must not emit a bare prefix');
            assert.ok(!union.includes('TRTLLM_'), 'must not emit a bare prefix');
        });
    });

    describe('RUNTIME_OWNED_VARS integration', () => {
        it('carries the derived engine slice for both vLLM and SGLang', async () => {
            const { RUNTIME_OWNED_VARS } = await import('../../src/lib/regenerate-command-handler.js');
            // vLLM (previously hardcoded) still present …
            assert.ok(RUNTIME_OWNED_VARS.has('VLLM_TENSOR_PARALLEL_SIZE'));
            // … and SGLang now preserved too (the fix).
            assert.ok(RUNTIME_OWNED_VARS.has('SGLANG_TP_SIZE'),
                'regenerate must preserve SGLang engine vars, not only vLLM');
        });
    });

    // ── BL129: capability versioning ──────────────────────────────────────────
    // Data-driven: assertions derive from vLLM's own manifest version_features so
    // they stay valid as the catalog/gates evolve — no frozen algorithm/version
    // literals beyond what the manifest itself declares.
    describe('effectiveSupportedAlgorithms (BL129)', () => {
        // Read the shipped manifest so the test tracks its declared gating.
        const vllmManifest = JSON.parse(readFileSync(
            resolve('templates/code/serve.d/vllm/manifest.json'), 'utf8'));
        const flat = vllmManifest.supported_algorithms;
        const features = vllmManifest.version_features || [];
        // Numeric semver compare (lexical string compare mis-orders 0.8 vs 0.10).
        const cmpVer = (a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
            }
            return 0;
        };
        // The earliest gated feature and its algorithms (there is at least one).
        const earliest = [...features].sort((a, b) => cmpVer(a.since, b.since))[0];

        it('a null/unparseable version returns the full flat set (fail-open)', () => {
            assert.deepStrictEqual(effectiveSupportedAlgorithms('vllm', null), flat);
            assert.deepStrictEqual(effectiveSupportedAlgorithms('vllm', 'latest'), flat);
        });

        it('a version below the earliest gate excludes that gate’s algorithms', () => {
            // Use a version strictly below the earliest `since` (drop the minor).
            const [maj] = earliest.since.split('.').map(Number);
            const below = `${maj}.0.0`;
            const eff = effectiveSupportedAlgorithms('vllm', below);
            for (const alg of earliest.adds.supported_algorithms) {
                assert.ok(!eff.includes(alg),
                    `${alg} is gated since ${earliest.since} and must be absent at ${below}`);
            }
        });

        it('at the latest gate’s version the effective set equals the flat set', () => {
            const latestSince = features
                .map(f => f.since)
                .sort(cmpVer)
                .pop();
            assert.deepStrictEqual(
                [...effectiveSupportedAlgorithms('vllm', latestSince)].sort(),
                [...flat].sort(),
                'every gated algorithm is available at/after the newest since');
        });

        it('gating is manifest-data-driven (an engine with no version_features returns flat at any version)', () => {
            // Derive an ungated engine from the catalog rather than pinning one:
            // any engine whose manifest declares no version_features must return
            // its flat supported_algorithms at every version. (Pinning a specific
            // engine here rots the moment that engine gains a gate — which is
            // exactly what happened when sglang adopted version_features.)
            const ungated = listServeEngines()
                .map(e => ({
                    e,
                    m: JSON.parse(readFileSync(
                        resolve(`templates/code/serve.d/${e}/manifest.json`), 'utf8'))
                }))
                .find(({ m }) => !Array.isArray(m.version_features) || m.version_features.length === 0);

            if (!ungated) {
                // Every engine is version-gated — the invariant is still exercised
                // by the vLLM/sglang cases above; nothing ungated to assert here.
                return;
            }
            assert.deepStrictEqual(
                effectiveSupportedAlgorithms(ungated.e, '0.0.1'),
                ungated.m.supported_algorithms,
                `${ungated.e} declares no version_features → effective must equal flat at any version`);
        });
    });

    describe('minVersion / isVersionSupported (BL129)', () => {
        it('minVersion reads the manifest field (semver-shaped when present)', () => {
            const mv = minVersion('vllm');
            assert.ok(mv === null || /^\d+\.\d+\.\d+$/.test(mv), `min_version should be semver or null, got ${mv}`);
        });
        it('isVersionSupported is false below min_version, true at/above', () => {
            const mv = minVersion('vllm');
            if (!mv) return; // engine declares no minimum → nothing to assert
            const [maj, min] = mv.split('.').map(Number);
            assert.strictEqual(isVersionSupported('vllm', `${maj}.${Math.max(0, min - 1)}.0`), min === 0 ? true : false);
            assert.strictEqual(isVersionSupported('vllm', mv), true);
        });
        it('fail-open: true when the version is unknown', () => {
            assert.strictEqual(isVersionSupported('vllm', null), true);
            assert.strictEqual(isVersionSupported('vllm', 'latest'), true);
        });
    });

    describe('engineVersionFromBaseImage (BL129 version source)', () => {
        it('parses a semver-shaped version out of a vLLM image tag', () => {
            const v = engineVersionFromBaseImage('vllm', 'vllm/vllm-openai:v0.29.0');
            assert.match(v, /^\d+\.\d+\.\d+$/, `expected semver, got ${v}`);
        });
        it('falls back to tag-parse for images not in the catalog', () => {
            assert.strictEqual(
                engineVersionFromBaseImage('vllm', 'my-registry/custom-vllm:v0.8.5-cu128'),
                '0.8.5');
        });
        it('returns null for an unparseable tag (fail-open at the caller)', () => {
            assert.strictEqual(engineVersionFromBaseImage('vllm', 'vllm/vllm-openai:latest'), null);
            assert.strictEqual(engineVersionFromBaseImage('vllm', ''), null);
        });
    });
});
