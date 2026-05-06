// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine Prefix Resolver Unit Tests
 *
 * Tests engine prefix mapping, no-prefix pass-through, and batch resolution.
 * Requirements: 4.6
 */

import { describe, it } from 'mocha'
import assert from 'assert'
import {
    ENGINE_PREFIX_MAP,
    resolvePrefix,
    resolvePrefixedEnvVars
} from '../../generators/app/lib/engine-prefix-resolver.js'

describe('Engine Prefix Resolver', () => {

    describe('ENGINE_PREFIX_MAP', () => {
        it('should contain entries for all prefixed engines', () => {
            assert.strictEqual(ENGINE_PREFIX_MAP['vllm'], 'VLLM_')
            assert.strictEqual(ENGINE_PREFIX_MAP['vllm-omni'], 'VLLM_OMNI_')
            assert.strictEqual(ENGINE_PREFIX_MAP['sglang'], 'SGLANG_')
            assert.strictEqual(ENGINE_PREFIX_MAP['tensorrt-llm'], 'TRTLLM_')
            assert.strictEqual(ENGINE_PREFIX_MAP['lmi'], 'LMI_')
            assert.strictEqual(ENGINE_PREFIX_MAP['djl'], 'DJL_')
        })

        it('should not contain entries for flask or fastapi', () => {
            assert.strictEqual(ENGINE_PREFIX_MAP['flask'], undefined)
            assert.strictEqual(ENGINE_PREFIX_MAP['fastapi'], undefined)
        })
    })

    describe('resolvePrefix', () => {

        describe('engines with defined prefixes', () => {
            it('should prepend VLLM_ for vllm engine', () => {
                assert.strictEqual(resolvePrefix('vllm', 'TENSOR_PARALLEL_SIZE'), 'VLLM_TENSOR_PARALLEL_SIZE')
            })

            it('should prepend VLLM_OMNI_ for vllm-omni engine', () => {
                assert.strictEqual(resolvePrefix('vllm-omni', 'TENSOR_PARALLEL_SIZE'), 'VLLM_OMNI_TENSOR_PARALLEL_SIZE')
            })

            it('should prepend SGLANG_ for sglang engine', () => {
                assert.strictEqual(resolvePrefix('sglang', 'TENSOR_PARALLEL_SIZE'), 'SGLANG_TENSOR_PARALLEL_SIZE')
            })

            it('should prepend TRTLLM_ for tensorrt-llm engine', () => {
                assert.strictEqual(resolvePrefix('tensorrt-llm', 'MAX_BATCH_SIZE'), 'TRTLLM_MAX_BATCH_SIZE')
            })

            it('should prepend LMI_ for lmi engine', () => {
                assert.strictEqual(resolvePrefix('lmi', 'TENSOR_PARALLEL_DEGREE'), 'LMI_TENSOR_PARALLEL_DEGREE')
            })

            it('should prepend DJL_ for djl engine', () => {
                assert.strictEqual(resolvePrefix('djl', 'BATCH_SIZE'), 'DJL_BATCH_SIZE')
            })
        })

        describe('engines without prefixes (pass-through)', () => {
            it('should return key unchanged for flask', () => {
                assert.strictEqual(resolvePrefix('flask', 'WORKERS'), 'WORKERS')
            })

            it('should return key unchanged for fastapi', () => {
                assert.strictEqual(resolvePrefix('fastapi', 'WORKERS'), 'WORKERS')
            })

            it('should return key unchanged for unknown engines', () => {
                assert.strictEqual(resolvePrefix('unknown-engine', 'MY_VAR'), 'MY_VAR')
            })
        })
    })

    describe('resolvePrefixedEnvVars', () => {

        it('should resolve all keys in a batch for a prefixed engine', () => {
            const serverEnvVars = {
                'TENSOR_PARALLEL_SIZE': '4',
                'MAX_MODEL_LEN': '4096',
                'GPU_MEMORY_UTILIZATION': '0.9'
            }

            const result = resolvePrefixedEnvVars('vllm', serverEnvVars)

            assert.deepStrictEqual(result, {
                'VLLM_TENSOR_PARALLEL_SIZE': '4',
                'VLLM_MAX_MODEL_LEN': '4096',
                'VLLM_GPU_MEMORY_UTILIZATION': '0.9'
            })
        })

        it('should pass through all keys for a no-prefix engine', () => {
            const serverEnvVars = {
                'WORKERS': '4',
                'PORT': '8080'
            }

            const result = resolvePrefixedEnvVars('flask', serverEnvVars)

            assert.deepStrictEqual(result, {
                'WORKERS': '4',
                'PORT': '8080'
            })
        })

        it('should handle empty env vars object', () => {
            const result = resolvePrefixedEnvVars('vllm', {})
            assert.deepStrictEqual(result, {})
        })

        it('should preserve values unchanged', () => {
            const serverEnvVars = {
                'MAX_BATCH_SIZE': '64'
            }

            const result = resolvePrefixedEnvVars('tensorrt-llm', serverEnvVars)

            assert.strictEqual(result['TRTLLM_MAX_BATCH_SIZE'], '64')
        })

        it('should handle single entry', () => {
            const result = resolvePrefixedEnvVars('sglang', { 'TP_SIZE': '2' })
            assert.deepStrictEqual(result, { 'SGLANG_TP_SIZE': '2' })
        })
    })
})
