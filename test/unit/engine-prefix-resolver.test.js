// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine Prefix Resolver Unit Tests
 *
 * Tests engine prefix mapping, no-prefix pass-through, and batch resolution.
 * Requirements: 4.6
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ENGINE_PREFIX_ALIASES,
    resolveEnginePrefix,
    resolvePrefix,
    resolvePrefixedEnvVars
} from '../../src/lib/engine-prefix-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Engine Prefix Resolver', () => {

    // ADR-004: prefixes for the four real engines come from their serve.d
    // manifest (single source of truth); only aliases without a serve.d dir
    // (vllm-omni, djl) live in the explicit alias table.
    describe('prefix resolution (manifest + alias table)', () => {
        it('resolves manifest-backed engines from their manifest env_var_prefix', () => {
            assert.strictEqual(resolveEnginePrefix('vllm'), 'VLLM_');
            assert.strictEqual(resolveEnginePrefix('sglang'), 'SGLANG_');
            assert.strictEqual(resolveEnginePrefix('tensorrt-llm'), 'TRTLLM_');
            assert.strictEqual(resolveEnginePrefix('lmi'), 'OPTION_');
        });

        it('resolves serve.d-less aliases from the alias table', () => {
            assert.strictEqual(ENGINE_PREFIX_ALIASES['vllm-omni'], 'VLLM_OMNI_');
            // djl reuses the DJL Serving container, which reads OPTION_* vars
            // (same as the lmi plugin) — NOT a DJL_ prefix the container ignores.
            assert.strictEqual(ENGINE_PREFIX_ALIASES['djl'], 'OPTION_');
            assert.strictEqual(resolveEnginePrefix('vllm-omni'), 'VLLM_OMNI_');
            assert.strictEqual(resolveEnginePrefix('djl'), 'OPTION_');
        });

        it('the alias table does NOT duplicate the four real-engine prefixes', () => {
            for (const e of ['vllm', 'sglang', 'tensorrt-llm', 'lmi']) {
                assert.strictEqual(ENGINE_PREFIX_ALIASES[e], undefined,
                    `${e} prefix must come from its manifest, not the alias table`);
            }
        });

        it('returns empty prefix for flask, fastapi, unknown', () => {
            assert.strictEqual(resolveEnginePrefix('flask'), '');
            assert.strictEqual(resolveEnginePrefix('fastapi'), '');
            assert.strictEqual(resolveEnginePrefix('unknown-engine'), '');
            assert.strictEqual(resolveEnginePrefix(''), '');
        });
    });

    // ADR-004 T3: the resolver's vllm prefix agrees with the vllm manifest, and
    // there is no second hardcoded prefix map competing with the manifest.
    describe('single source of truth (manifest agreement)', () => {
        it('resolvePrefix("vllm", key) agrees with the vllm manifest env_var_prefix', () => {
            const manifest = JSON.parse(readFileSync(
                resolve(__dirname, '../../templates/code/serve.d/vllm/manifest.json'), 'utf8'));
            assert.strictEqual(
                resolvePrefix('vllm', 'TENSOR_PARALLEL_SIZE'),
                `${manifest.env_var_prefix}TENSOR_PARALLEL_SIZE`);
            assert.strictEqual(resolveEnginePrefix('vllm'), manifest.env_var_prefix);
        });

        it('every manifest-backed engine resolves to its manifest env_var_prefix', () => {
            for (const engine of ['vllm', 'sglang', 'tensorrt-llm', 'lmi']) {
                const manifest = JSON.parse(readFileSync(
                    resolve(__dirname, `../../templates/code/serve.d/${engine}/manifest.json`), 'utf8'));
                assert.strictEqual(resolveEnginePrefix(engine), manifest.env_var_prefix,
                    `${engine} resolver prefix must equal its manifest env_var_prefix`);
            }
        });

        it('the module exports no hardcoded ENGINE_PREFIX_MAP (retired by ADR-004)', async () => {
            const mod = await import('../../src/lib/engine-prefix-resolver.js');
            assert.strictEqual(mod.ENGINE_PREFIX_MAP, undefined,
                'ENGINE_PREFIX_MAP must be retired; prefixes come from manifests + the alias table');
        });
    });

    describe('resolvePrefix', () => {

        describe('engines with defined prefixes', () => {
            it('should prepend VLLM_ for vllm engine', () => {
                assert.strictEqual(resolvePrefix('vllm', 'TENSOR_PARALLEL_SIZE'), 'VLLM_TENSOR_PARALLEL_SIZE');
            });

            it('should prepend VLLM_OMNI_ for vllm-omni engine', () => {
                assert.strictEqual(resolvePrefix('vllm-omni', 'TENSOR_PARALLEL_SIZE'), 'VLLM_OMNI_TENSOR_PARALLEL_SIZE');
            });

            it('should prepend SGLANG_ for sglang engine', () => {
                assert.strictEqual(resolvePrefix('sglang', 'TENSOR_PARALLEL_SIZE'), 'SGLANG_TENSOR_PARALLEL_SIZE');
            });

            it('should prepend TRTLLM_ for tensorrt-llm engine', () => {
                assert.strictEqual(resolvePrefix('tensorrt-llm', 'MAX_BATCH_SIZE'), 'TRTLLM_MAX_BATCH_SIZE');
            });

            it('should prepend OPTION_ for lmi engine (DJL reads OPTION_* env vars)', () => {
                assert.strictEqual(resolvePrefix('lmi', 'TENSOR_PARALLEL_DEGREE'), 'OPTION_TENSOR_PARALLEL_DEGREE');
            });

            it('should prepend OPTION_ for djl engine (DJL Serving reads OPTION_* vars)', () => {
                // Regression: djl previously prefixed DJL_, which the DJL Serving
                // container ignores, silently dropping the user's --server-env value.
                // It reuses the lmi wrapper and must share lmi's OPTION_ contract.
                assert.strictEqual(resolvePrefix('djl', 'BATCH_SIZE'), 'OPTION_BATCH_SIZE');
            });

            it('djl and lmi resolve to the SAME prefix (both are DJL Serving)', () => {
                assert.strictEqual(resolveEnginePrefix('djl'), resolveEnginePrefix('lmi'),
                    'djl (alias) and lmi (manifest) must agree — both run DJL Serving reading OPTION_*');
            });
        });

        describe('engines without prefixes (pass-through)', () => {
            it('should return key unchanged for flask', () => {
                assert.strictEqual(resolvePrefix('flask', 'WORKERS'), 'WORKERS');
            });

            it('should return key unchanged for fastapi', () => {
                assert.strictEqual(resolvePrefix('fastapi', 'WORKERS'), 'WORKERS');
            });

            it('should return key unchanged for unknown engines', () => {
                assert.strictEqual(resolvePrefix('unknown-engine', 'MY_VAR'), 'MY_VAR');
            });
        });
    });

    describe('resolvePrefixedEnvVars', () => {

        it('should resolve all keys in a batch for a prefixed engine', () => {
            const serverEnvVars = {
                'TENSOR_PARALLEL_SIZE': '4',
                'MAX_MODEL_LEN': '4096',
                'GPU_MEMORY_UTILIZATION': '0.9'
            };

            const result = resolvePrefixedEnvVars('vllm', serverEnvVars);

            assert.deepStrictEqual(result, {
                'VLLM_TENSOR_PARALLEL_SIZE': '4',
                'VLLM_MAX_MODEL_LEN': '4096',
                'VLLM_GPU_MEMORY_UTILIZATION': '0.9'
            });
        });

        it('should pass through all keys for a no-prefix engine', () => {
            const serverEnvVars = {
                'WORKERS': '4',
                'PORT': '8080'
            };

            const result = resolvePrefixedEnvVars('flask', serverEnvVars);

            assert.deepStrictEqual(result, {
                'WORKERS': '4',
                'PORT': '8080'
            });
        });

        it('should handle empty env vars object', () => {
            const result = resolvePrefixedEnvVars('vllm', {});
            assert.deepStrictEqual(result, {});
        });

        it('should preserve values unchanged', () => {
            const serverEnvVars = {
                'MAX_BATCH_SIZE': '64'
            };

            const result = resolvePrefixedEnvVars('tensorrt-llm', serverEnvVars);

            assert.strictEqual(result['TRTLLM_MAX_BATCH_SIZE'], '64');
        });

        it('should handle single entry', () => {
            const result = resolvePrefixedEnvVars('sglang', { 'TP_SIZE': '2' });
            assert.deepStrictEqual(result, { 'SGLANG_TP_SIZE': '2' });
        });
    });
});
