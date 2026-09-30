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
import {
    readEnvVarPrefix,
    listServeEngines,
    serveEngineRuntimeVarsUnion
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
});
