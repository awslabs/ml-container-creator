#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone integration tests for the instance-sizer MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test.js
 */

import assert from 'node:assert'
import { handleGetInstanceRecommendation, INSTANCE_CATALOG, SERVER_CONFIG, server } from './index.js'

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

// ── Helper ───────────────────────────────────────────────────────────────────

function parseResponse(result) {
    assert.ok(result, 'result should not be null')
    assert.ok(result.content, 'result should have content')
    assert.ok(Array.isArray(result.content), 'content should be an array')
    assert.ok(result.content.length > 0, 'content should not be empty')
    assert.strictEqual(result.content[0].type, 'text', 'content[0].type should be text')
    return JSON.parse(result.content[0].text)
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\ninstance-sizer: known model (Llama-3.1-8B)\n')

await test('Llama-3.1-8B returns valid response shape', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const data = parseResponse(result)

    // values.instanceType is a string starting with 'ml.'
    assert.ok(typeof data.values.instanceType === 'string', 'values.instanceType should be a string')
    assert.ok(data.values.instanceType.startsWith('ml.'), `values.instanceType should start with ml., got: ${data.values.instanceType}`)

    // choices.instanceType is an array of strings
    assert.ok(Array.isArray(data.choices.instanceType), 'choices.instanceType should be an array')
    assert.ok(data.choices.instanceType.length > 0, 'choices.instanceType should not be empty')
    for (const choice of data.choices.instanceType) {
        assert.ok(typeof choice === 'string', 'each choice should be a string')
        assert.ok(choice.startsWith('ml.'), `each choice should start with ml., got: ${choice}`)
    }
})

await test('Llama-3.1-8B metadata has required fields', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const data = parseResponse(result)

    assert.ok(data.metadata.modelName, 'metadata.modelName should be present')
    assert.ok(data.metadata.parameterCount, 'metadata.parameterCount should be present')
    assert.ok(data.metadata.estimatedVramGb, 'metadata.estimatedVramGb should be present')
    assert.strictEqual(data.metadata.source, 'catalog', 'metadata.source should be catalog')
})

await test('Llama-3.1-8B VRAM estimate is between 26 and 32 GB', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const data = parseResponse(result)

    assert.ok(data.metadata.estimatedVramGb >= 26,
        `estimatedVramGb should be >= 26, got: ${data.metadata.estimatedVramGb}`)
    assert.ok(data.metadata.estimatedVramGb <= 32,
        `estimatedVramGb should be <= 32, got: ${data.metadata.estimatedVramGb}`)
})

await test('Llama-3.1-8B recommendations are non-empty with required fields', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const data = parseResponse(result)

    assert.ok(Array.isArray(data.metadata.recommendations), 'recommendations should be an array')
    assert.ok(data.metadata.recommendations.length > 0, 'recommendations should not be empty')

    for (const rec of data.metadata.recommendations) {
        assert.ok(rec.instanceType, 'recommendation should have instanceType')
        assert.ok(typeof rec.gpuCount === 'number', 'recommendation should have numeric gpuCount')
        assert.ok(typeof rec.totalVramGb === 'number', 'recommendation should have numeric totalVramGb')
        assert.ok(typeof rec.utilizationPercent === 'number', 'recommendation should have numeric utilizationPercent')
        assert.ok(typeof rec.tensorParallelism === 'number', 'recommendation should have numeric tensorParallelism')
        assert.ok(typeof rec.costTier === 'string', 'recommendation should have string costTier')
    }
})

// ── Known model (Llama-3.3-70B) ──────────────────────────────────────────────

console.log('\ninstance-sizer: known model (Llama-3.3-70B)\n')

await test('Llama-3.3-70B VRAM estimate is between 240 and 260 GB', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.3-70B-Instruct'
    })
    const data = parseResponse(result)

    assert.ok(data.metadata.estimatedVramGb >= 240,
        `estimatedVramGb should be >= 240, got: ${data.metadata.estimatedVramGb}`)
    assert.ok(data.metadata.estimatedVramGb <= 260,
        `estimatedVramGb should be <= 260, got: ${data.metadata.estimatedVramGb}`)
})

await test('Llama-3.3-70B includes multi-GPU instances (TP > 1)', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.3-70B-Instruct'
    })
    const data = parseResponse(result)

    const multiGpu = data.metadata.recommendations.filter(r => r.tensorParallelism > 1)
    assert.ok(multiGpu.length > 0, 'should include at least one multi-GPU recommendation')
})

await test('Llama-3.3-70B top recommendation is a multi-GPU instance', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.3-70B-Instruct'
    })
    const data = parseResponse(result)

    // 70B model at bfloat16 needs ~146GB — no single 24GB GPU can fit it
    // The top recommendation must use tensor parallelism
    const topRec = data.metadata.recommendations[0]
    assert.ok(topRec.tensorParallelism > 1,
        `top recommendation should have TP > 1, got: ${topRec.tensorParallelism}`)
})

// ── Quantization ─────────────────────────────────────────────────────────────

console.log('\ninstance-sizer: quantization\n')

await test('AWQ quantization reduces VRAM estimate', async () => {
    const resultBf16 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const dataBf16 = parseResponse(resultBf16)

    const resultAwq = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        quantization: 'awq'
    })
    const dataAwq = parseResponse(resultAwq)

    assert.strictEqual(dataAwq.metadata.quantization, 'awq', 'metadata.quantization should be awq')
    assert.ok(dataAwq.metadata.estimatedVramGb < dataBf16.metadata.estimatedVramGb,
        `AWQ estimate (${dataAwq.metadata.estimatedVramGb}) should be less than bf16 estimate (${dataBf16.metadata.estimatedVramGb})`)
})

// ── Unknown model fallback ───────────────────────────────────────────────────

console.log('\ninstance-sizer: unknown model fallback\n')

await test('unknown model returns valid response structure', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/nonexistent-model'
    })
    const data = parseResponse(result)

    assert.ok(data.values, 'response should have values')
    assert.ok(data.choices, 'response should have choices')
    assert.ok(data.metadata, 'response should have metadata')
})

await test('unknown model has source=unfiltered', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/nonexistent-model'
    })
    const data = parseResponse(result)

    assert.strictEqual(data.metadata.source, 'unfiltered', 'metadata.source should be unfiltered')
})

await test('unknown model has a warning message', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/nonexistent-model'
    })
    const data = parseResponse(result)

    assert.ok(data.metadata.warning, 'metadata.warning should be present')
    assert.ok(typeof data.metadata.warning === 'string', 'metadata.warning should be a string')
    assert.ok(data.metadata.warning.length > 0, 'metadata.warning should not be empty')
})

await test('unknown model still returns instance choices', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'unknown-org/nonexistent-model'
    })
    const data = parseResponse(result)

    assert.ok(Array.isArray(data.choices.instanceType), 'choices.instanceType should be an array')
    assert.ok(data.choices.instanceType.length > 0, 'choices.instanceType should not be empty')
})

// ── Limit parameter ──────────────────────────────────────────────────────────

console.log('\ninstance-sizer: limit parameter\n')

await test('limit=3 caps choices to at most 3', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        limit: 3
    })
    const data = parseResponse(result)

    assert.ok(data.choices.instanceType.length <= 3,
        `choices should have at most 3 items, got: ${data.choices.instanceType.length}`)
})

// ── Response shape validation ────────────────────────────────────────────────

console.log('\ninstance-sizer: response shape validation\n')

await test('response matches MCP tool response format', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })

    // Top-level MCP response shape
    assert.ok(result.content, 'MCP response should have content')
    assert.ok(Array.isArray(result.content), 'content should be an array')
    assert.strictEqual(result.content[0].type, 'text', 'content[0].type should be text')
    assert.ok(typeof result.content[0].text === 'string', 'content[0].text should be a string')

    // Parsed response shape
    const data = JSON.parse(result.content[0].text)
    assert.ok('values' in data, 'parsed response should have values')
    assert.ok('choices' in data, 'parsed response should have choices')
    assert.ok('metadata' in data, 'parsed response should have metadata')
    assert.ok('instanceType' in data.values, 'values should have instanceType')
    assert.ok('instanceType' in data.choices, 'choices should have instanceType')
    assert.ok('modelName' in data.metadata, 'metadata should have modelName')
    assert.ok('parameterCount' in data.metadata, 'metadata should have parameterCount')
    assert.ok('estimatedVramGb' in data.metadata, 'metadata should have estimatedVramGb')
    assert.ok('recommendations' in data.metadata, 'metadata should have recommendations')
    assert.ok('source' in data.metadata, 'metadata should have source')
})

// ── Offline mode (catalog-only) ──────────────────────────────────────────────

console.log('\ninstance-sizer: offline mode (catalog-only)\n')

await test('catalog model resolves without network calls', async () => {
    // This test verifies that a known catalog model returns results
    // from the catalog (no HuggingFace API needed for catalog models)
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
    const data = parseResponse(result)

    assert.strictEqual(data.metadata.source, 'catalog',
        'catalog model should resolve from catalog, not network')
    assert.ok(data.metadata.parameterCount > 0,
        'should have a valid parameter count from catalog')
})

// ── Server and config exports ────────────────────────────────────────────────

console.log('\ninstance-sizer: exports\n')

await test('INSTANCE_CATALOG is loaded and non-empty', async () => {
    assert.ok(INSTANCE_CATALOG, 'INSTANCE_CATALOG should be exported')
    assert.ok(typeof INSTANCE_CATALOG === 'object', 'INSTANCE_CATALOG should be an object')
    assert.ok(Object.keys(INSTANCE_CATALOG).length > 0, 'INSTANCE_CATALOG should not be empty')
})

await test('SERVER_CONFIG has required fields', async () => {
    assert.ok(SERVER_CONFIG, 'SERVER_CONFIG should be exported')
    assert.strictEqual(SERVER_CONFIG.serverName, 'instance-sizer')
    assert.ok(SERVER_CONFIG.systemPromptTemplate, 'should have systemPromptTemplate')
    assert.ok(typeof SERVER_CONFIG.temperature === 'number', 'should have numeric temperature')
    assert.ok(typeof SERVER_CONFIG.maxTokens === 'number', 'should have numeric maxTokens')
})

await test('server is an McpServer instance', async () => {
    assert.ok(server, 'server should be exported')
    assert.ok(typeof server === 'object', 'server should be an object')
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
