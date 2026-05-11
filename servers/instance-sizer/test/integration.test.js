#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generator integration tests for the instance-sizer MCP server.
 * Tests end-to-end pipeline by calling handleGetInstanceRecommendation directly.
 *
 * Validates Requirements: 3.1, 3.2, 3.4, 3.5, 6.1, 6.2
 *
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/integration.test.js
 */

import assert from 'node:assert'
import { handleGetInstanceRecommendation } from '../index.js'

let passed = 0
let failed = 0

function test(name, fn) {
    return fn().then(() => {
        passed++
        console.log(`  ✓ ${name}`)
    }).catch((err) => {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    })
}

function parseResponse(result) {
    assert.ok(result, 'result should not be null')
    assert.ok(result.content, 'result should have content')
    assert.ok(Array.isArray(result.content), 'content should be an array')
    assert.ok(result.content.length > 0, 'content should not be empty')
    assert.strictEqual(result.content[0].type, 'text', 'content[0].type should be text')
    return JSON.parse(result.content[0].text)
}

// ── Test 1: transformers-vllm + Llama-2-7B → single-GPU with TP=1 ───────────

console.log('\nintegration: transformers-vllm + Llama-2-7B → single-GPU (TP=1)\n')

await test('Llama-2-7B with vllm backend recommends single-GPU instance (TP=1)', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topRec = data.metadata.recommendations[0]
    assert.strictEqual(topRec.tensorParallelism, 1,
        `top recommendation should have TP=1, got: ${topRec.tensorParallelism}`)
})

await test('Llama-2-7B top recommendation has at least 14GB VRAM', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topRec = data.metadata.recommendations[0]
    assert.ok(topRec.totalVramGb >= 14,
        `top recommendation should have >= 14GB VRAM, got: ${topRec.totalVramGb}GB`)
})

await test('Llama-2-7B top recommendation is a GPU instance with sufficient VRAM', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topInstance = data.values.instanceType
    // The ranker prefers cost-efficient instances — g4dn (T4 16GB) or g5/g6 (A10G/L4 24GB)
    const isGpuInstance = topInstance.includes('.g4dn.') || topInstance.includes('.g5.') || topInstance.includes('.g6.')
    assert.ok(isGpuInstance,
        `top recommendation should be a g4dn, g5, or g6 instance, got: ${topInstance}`)

    // Verify the recommended instance has enough VRAM for the model
    const topRec = data.metadata.recommendations[0]
    assert.ok(topRec.totalVramGb >= data.metadata.estimatedVramGb,
        `instance VRAM (${topRec.totalVramGb}GB) should be >= estimated need (${data.metadata.estimatedVramGb}GB)`)
})

// ── Test 2: transformers-vllm + Llama-2-70B → multi-GPU with TP=8 ───────────

console.log('\nintegration: transformers-vllm + Llama-2-70B → multi-GPU (TP>1)\n')

await test('Llama-2-70B with vllm backend recommends multi-GPU (TP > 1)', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topRec = data.metadata.recommendations[0]
    assert.ok(topRec.tensorParallelism > 1,
        `top recommendation should have TP > 1, got: ${topRec.tensorParallelism}`)
})

await test('Llama-2-70B top recommendation is ml.g5.48xlarge or similar multi-GPU', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topInstance = data.values.instanceType
    // 70B at fp16 needs ~144GB — only 8-GPU instances (g5.48xlarge, p3.16xlarge, etc.) can fit
    const multiGpuInstances = ['ml.g5.48xlarge', 'ml.g5.12xlarge', 'ml.g5.24xlarge',
        'ml.p3.16xlarge', 'ml.p3.8xlarge', 'ml.p4d.24xlarge',
        'ml.g4dn.12xlarge', 'ml.inf2.24xlarge', 'ml.inf2.48xlarge',
        'ml.trn1.32xlarge']
    assert.ok(multiGpuInstances.includes(topInstance),
        `top recommendation should be a multi-GPU instance, got: ${topInstance}`)
})

await test('Llama-2-70B metadata includes tensorParallelism field', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    const topRec = data.metadata.recommendations[0]
    assert.ok('tensorParallelism' in topRec,
        'top recommendation should include tensorParallelism field')
    assert.ok(typeof topRec.tensorParallelism === 'number',
        'tensorParallelism should be a number')
})

// ── Test 3: Auto-prompt mode uses sizer recommendation ───────────────────────

console.log('\nintegration: auto-prompt mode uses sizer recommendation\n')

await test('response values.instanceType is set for auto-prompt usage', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.ok(data.values.instanceType,
        'values.instanceType should be set for auto-prompt mode')
    assert.ok(typeof data.values.instanceType === 'string',
        'values.instanceType should be a string')
    assert.ok(data.values.instanceType.startsWith('ml.'),
        `values.instanceType should start with ml., got: ${data.values.instanceType}`)
})

await test('values.instanceType matches first item in choices.instanceType', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.strictEqual(data.values.instanceType, data.choices.instanceType[0],
        `values.instanceType (${data.values.instanceType}) should match first choice (${data.choices.instanceType[0]})`)
})

// ── Test 4: Fallback when model not in catalog ───────────────────────────────

console.log('\nintegration: fallback when model not in catalog\n')

await test('unknown model returns valid response structure', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/unknown-model',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.ok(data.values, 'response should have values')
    assert.ok(data.choices, 'response should have choices')
    assert.ok(data.metadata, 'response should have metadata')
})

await test('unknown model has source=unfiltered', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/unknown-model',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.strictEqual(data.metadata.source, 'unfiltered',
        `metadata.source should be 'unfiltered', got: '${data.metadata.source}'`)
})

await test('unknown model returns non-empty choices', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/unknown-model',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.ok(Array.isArray(data.choices.instanceType),
        'choices.instanceType should be an array')
    assert.ok(data.choices.instanceType.length > 0,
        'choices.instanceType should not be empty (returns all GPU instances)')
})

// ── Test 5: Quantization affects recommendation ──────────────────────────────

console.log('\nintegration: quantization affects recommendation\n')

await test('Llama-2-70B with AWQ has lower VRAM estimate than without', async () => {
    const resultFp16 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataFp16 = parseResponse(resultFp16)

    const resultAwq = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        quantization: 'awq',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataAwq = parseResponse(resultAwq)

    assert.ok(dataAwq.metadata.estimatedVramGb < dataFp16.metadata.estimatedVramGb,
        `AWQ estimate (${dataAwq.metadata.estimatedVramGb}GB) should be less than fp16 estimate (${dataFp16.metadata.estimatedVramGb}GB)`)
})

await test('Llama-2-70B with AWQ VRAM is significantly reduced (roughly 4x smaller weights)', async () => {
    const resultFp16 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataFp16 = parseResponse(resultFp16)

    const resultAwq = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        quantization: 'awq',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataAwq = parseResponse(resultAwq)

    // AWQ (4-bit) should reduce VRAM by roughly 60-75% compared to fp16
    const reductionRatio = dataAwq.metadata.estimatedVramGb / dataFp16.metadata.estimatedVramGb
    assert.ok(reductionRatio < 0.5,
        `AWQ should reduce VRAM by more than 50%, ratio: ${(reductionRatio * 100).toFixed(1)}%`)
})

await test('Llama-2-70B with AWQ may recommend fewer GPUs than without', async () => {
    const resultFp16 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataFp16 = parseResponse(resultFp16)

    const resultAwq = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-70b-hf',
        quantization: 'awq',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const dataAwq = parseResponse(resultAwq)

    // With AWQ, the 70B model needs ~36GB which could fit on fewer GPUs
    const topRecFp16 = dataFp16.metadata.recommendations[0]
    const topRecAwq = dataAwq.metadata.recommendations[0]

    // AWQ should allow equal or fewer GPUs (lower or equal TP)
    assert.ok(topRecAwq.tensorParallelism <= topRecFp16.tensorParallelism,
        `AWQ TP (${topRecAwq.tensorParallelism}) should be <= fp16 TP (${topRecFp16.tensorParallelism})`)
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
