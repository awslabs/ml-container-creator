// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for TP degree auto-resolution from instance catalog GPU count.
 * Requirements: FTP-1 (extension) — task 6.2
 *
 * When tp_degree is not explicitly set by the user, auto-resolve it from
 * the instance catalog's GPU count. Only applies when deployment_config
 * uses a parallelizable engine (vLLM, SGLang, TensorRT-LLM, LMI).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js'

describe('TP Degree Auto-Resolution from Instance Catalog (Task 6.2)', () => {
    describe('auto-resolves TP for multi-GPU parallelizable engines', () => {
        it('sets VLLM_TENSOR_PARALLEL_SIZE to GPU count for vllm backend on multi-GPU instance', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.48xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '8')
            assert.equal(answers.tensorParallelSize, 8)
            assert.equal(answers._tpAutoResolved, true)
            assert.equal(answers._tpAutoResolvedFrom, 'ml.g5.48xlarge')
        })

        it('sets SGLANG_TENSOR_PARALLEL_SIZE for sglang backend on multi-GPU instance', async () => {
            const answers = {
                backend: 'sglang',
                instanceType: 'ml.g5.12xlarge',
                envVars: { SGLANG_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.SGLANG_TENSOR_PARALLEL_SIZE, '4')
            assert.equal(answers.tensorParallelSize, 4)
        })

        it('sets TRTLLM_TENSOR_PARALLEL_SIZE for tensorrt-llm backend on multi-GPU instance', async () => {
            const answers = {
                backend: 'tensorrt-llm',
                instanceType: 'ml.g5.48xlarge',
                envVars: { TRTLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.TRTLLM_TENSOR_PARALLEL_SIZE, '8')
            assert.equal(answers.tensorParallelSize, 8)
        })

        it('sets OPTION_TENSOR_PARALLEL_DEGREE for lmi backend on multi-GPU instance', async () => {
            const answers = {
                backend: 'lmi',
                instanceType: 'ml.g5.48xlarge',
                envVars: {}
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.OPTION_TENSOR_PARALLEL_DEGREE, '8')
            assert.equal(answers.tensorParallelSize, 8)
        })

        it('auto-resolves TP for p6-b200 instance (8 GPUs)', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.p6-b200.48xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '8')
            assert.equal(answers.tensorParallelSize, 8)
        })

        it('uses gpuCount from answers when available (instance-sizer already set it)', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.48xlarge',
                gpuCount: 8,
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '8')
            assert.equal(answers.tensorParallelSize, 8)
        })

        it('uses modelServer field when backend is not set', async () => {
            const answers = {
                modelServer: 'vllm',
                instanceType: 'ml.g5.48xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '8')
        })
    })

    describe('does NOT auto-resolve for single-GPU instances', () => {
        it('keeps TP at 1 for ml.g5.xlarge (1 GPU)', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('keeps TP at 1 for ml.g5.2xlarge (1 GPU)', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.2xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })
    })

    describe('does NOT auto-resolve for non-parallelizable engines', () => {
        it('does not modify envVars for flask backend', async () => {
            const answers = {
                backend: 'flask',
                instanceType: 'ml.g5.48xlarge',
                envVars: {}
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, undefined)
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('does not modify envVars for djl backend', async () => {
            const answers = {
                backend: 'djl',
                instanceType: 'ml.g5.48xlarge',
                envVars: {}
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, undefined)
            assert.equal(answers._tpAutoResolved, undefined)
        })
    })

    describe('respects explicit user override (Task 6.4)', () => {
        it('does NOT override when user set TENSOR_PARALLEL_SIZE in serverEnvVars', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.48xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' },
                serverEnvVars: { TENSOR_PARALLEL_SIZE: '4' }
            }
            await _ensureTemplateVariables(answers, null)
            // Should NOT be overridden since user explicitly set it
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('does NOT override when user set TENSOR_PARALLEL_DEGREE in serverEnvVars', async () => {
            const answers = {
                backend: 'lmi',
                instanceType: 'ml.g5.48xlarge',
                envVars: {},
                serverEnvVars: { TENSOR_PARALLEL_DEGREE: '4' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.OPTION_TENSOR_PARALLEL_DEGREE, undefined)
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('does NOT override when user set the full prefixed key in serverEnvVars', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.48xlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' },
                serverEnvVars: { VLLM_TENSOR_PARALLEL_SIZE: '4' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })
    })

    describe('edge cases', () => {
        it('handles missing instanceType gracefully', async () => {
            const answers = {
                backend: 'vllm',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('handles unknown instance type gracefully', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.x99.superlarge',
                envVars: { VLLM_TENSOR_PARALLEL_SIZE: '1' }
            }
            await _ensureTemplateVariables(answers, null)
            // Unknown instance type — no catalog entry, should not change TP
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '1')
            assert.equal(answers._tpAutoResolved, undefined)
        })

        it('handles no envVars object gracefully', async () => {
            const answers = {
                backend: 'vllm',
                instanceType: 'ml.g5.48xlarge'
            }
            await _ensureTemplateVariables(answers, null)
            // envVars gets initialized by defaults, then TP is set
            assert.equal(answers.envVars.VLLM_TENSOR_PARALLEL_SIZE, '8')
            assert.equal(answers.tensorParallelSize, 8)
        })
    })
})
