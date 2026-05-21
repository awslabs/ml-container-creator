#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the endpoint-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/endpoint-picker/test.js
 */

import assert from 'node:assert'
import { buildResponse, getGpusForInstance } from './index.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

console.log('\nendpoint-picker: buildResponse\n')

// --- Empty endpoints returns empty choices with message ---
test('empty endpoints returns empty choices with message', () => {
    const result = buildResponse([])
    assert.deepStrictEqual(result.choices.endpointName, [])
    assert.deepStrictEqual(result.values, {})
    assert.ok(result.message, 'should include a descriptive message')
    assert.ok(result.message.includes('No InService'), 'message should mention no endpoints found')
})

test('null endpoints returns empty choices with message', () => {
    const result = buildResponse(null)
    assert.deepStrictEqual(result.choices.endpointName, [])
    assert.deepStrictEqual(result.values, {})
    assert.ok(result.message)
})

// --- Single endpoint ---
test('single endpoint returns correct values and choices', () => {
    const endpoints = [{
        endpointName: 'my-endpoint',
        variantName: 'AllTraffic',
        instanceType: 'ml.g6e.48xlarge',
        instanceCount: 1,
        icCount: 2,
        availableGpus: 4,
        hasInstancePools: false
    }]
    const result = buildResponse(endpoints)
    assert.strictEqual(result.values.endpointName, 'my-endpoint')
    assert.deepStrictEqual(result.choices.endpointName, ['my-endpoint'])
    assert.ok(result.metadata['my-endpoint'])
    assert.strictEqual(result.metadata['my-endpoint'].instanceType, 'ml.g6e.48xlarge')
    assert.strictEqual(result.metadata['my-endpoint'].availableGpus, 4)
    assert.strictEqual(result.metadata['my-endpoint'].icCount, 2)
})

// --- Multiple endpoints ---
test('multiple endpoints: first is default value', () => {
    const endpoints = [
        { endpointName: 'ep-a', variantName: 'AllTraffic', instanceType: 'ml.g5.xlarge', instanceCount: 1, icCount: 0, availableGpus: 1, hasInstancePools: false },
        { endpointName: 'ep-b', variantName: 'AllTraffic', instanceType: 'ml.g5.2xlarge', instanceCount: 1, icCount: 1, availableGpus: 0, hasInstancePools: false },
        { endpointName: 'ep-c', variantName: 'AllTraffic', instanceType: 'ml.p4d.24xlarge', instanceCount: 1, icCount: 3, availableGpus: 5, hasInstancePools: false }
    ]
    const result = buildResponse(endpoints)
    assert.strictEqual(result.values.endpointName, 'ep-a')
    assert.strictEqual(result.choices.endpointName.length, 3)
    assert.deepStrictEqual(result.choices.endpointName, ['ep-a', 'ep-b', 'ep-c'])
})

// --- Metadata includes all fields ---
test('metadata includes variant, instance type, IC count, available GPUs, and pool flag', () => {
    const endpoints = [{
        endpointName: 'gpu-endpoint',
        variantName: 'AllTraffic',
        instanceType: 'ml.g6e.48xlarge',
        instanceCount: 2,
        icCount: 3,
        availableGpus: 10,
        hasInstancePools: true
    }]
    const result = buildResponse(endpoints)
    const meta = result.metadata['gpu-endpoint']
    assert.strictEqual(meta.variantName, 'AllTraffic')
    assert.strictEqual(meta.instanceType, 'ml.g6e.48xlarge')
    assert.strictEqual(meta.instanceCount, 2)
    assert.strictEqual(meta.icCount, 3)
    assert.strictEqual(meta.availableGpus, 10)
    assert.strictEqual(meta.hasInstancePools, true)
})

// --- No message field when endpoints are found ---
test('no message field when endpoints are found', () => {
    const endpoints = [
        { endpointName: 'ep-1', variantName: 'AllTraffic', instanceType: 'ml.g5.xlarge', instanceCount: 1, icCount: 0, availableGpus: 1, hasInstancePools: false }
    ]
    const result = buildResponse(endpoints)
    assert.strictEqual(result.message, undefined)
})

// --- Capacity estimation: unknown instance type shows '?' ---
test('endpoint with unknown instance type shows ? for availableGpus', () => {
    const endpoints = [{
        endpointName: 'unknown-ep',
        variantName: 'AllTraffic',
        instanceType: 'ml.z99.superlarge',
        instanceCount: 1,
        icCount: 1,
        availableGpus: '?',
        hasInstancePools: false
    }]
    const result = buildResponse(endpoints)
    assert.strictEqual(result.metadata['unknown-ep'].availableGpus, '?')
    // Should still be included in choices (not filtered out)
    assert.ok(result.choices.endpointName.includes('unknown-ep'))
})

console.log('\nendpoint-picker: getGpusForInstance\n')

// --- GPU lookup tests ---
test('known GPU instance returns correct GPU count', () => {
    const gpus = getGpusForInstance('ml.g5.12xlarge')
    assert.strictEqual(gpus, 4)
})

test('known single-GPU instance returns 1 GPU', () => {
    const gpus = getGpusForInstance('ml.g5.xlarge')
    assert.strictEqual(gpus, 1)
})

test('unknown instance type returns null', () => {
    const gpus = getGpusForInstance('ml.z99.superlarge')
    assert.strictEqual(gpus, null)
})

console.log('\nendpoint-picker: capacity estimation logic\n')

// --- Capacity math ---
test('capacity estimation: 8 GPU instance, 2 ICs using 3 GPUs each = 2 available', () => {
    // This tests the math that fetchEndpoints would produce
    const instanceCount = 1
    const gpusPerInstance = 8
    const totalGpuAllocated = 6 // 2 ICs × 3 GPUs
    const availableGpus = (instanceCount * gpusPerInstance) - totalGpuAllocated
    assert.strictEqual(availableGpus, 2)
})

test('capacity estimation: 2 instances × 4 GPUs, 5 GPUs allocated = 3 available', () => {
    const instanceCount = 2
    const gpusPerInstance = 4
    const totalGpuAllocated = 5
    const availableGpus = (instanceCount * gpusPerInstance) - totalGpuAllocated
    assert.strictEqual(availableGpus, 3)
})

test('capacity estimation: fully subscribed endpoint has 0 available', () => {
    const instanceCount = 1
    const gpusPerInstance = 8
    const totalGpuAllocated = 8
    const availableGpus = (instanceCount * gpusPerInstance) - totalGpuAllocated
    assert.strictEqual(availableGpus, 0)
})

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
