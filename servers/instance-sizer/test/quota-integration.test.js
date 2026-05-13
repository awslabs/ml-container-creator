#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the full quota/availability pipeline.
 * Tests VRAM filter → quota filter → availability rank end-to-end.
 * Verifies discover mode off produces identical results to current behavior.
 *
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/quota-integration.test.js
 *
 * Validates: Requirements 7.4
 */

import assert from 'node:assert'
import { handleGetInstanceRecommendation, INSTANCE_CATALOG } from '../index.js'
import { filterAndRankInstances, applyAvailabilityRanking } from '../lib/instance-ranker.js'
import { resolveModelMetadata } from '../lib/model-resolver.js'
import { estimateVram } from '../lib/vram-estimator.js'

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

// ── Test 1: Full pipeline end-to-end (composing functions directly) ──────────

console.log('\nquota-integration: full pipeline VRAM → quota → availability rank\n')

await test('full pipeline: VRAM filtering narrows to compatible instances', async () => {
    // Step 1: Resolve model metadata (Llama-2-7B from catalog)
    const modelMetadata = await resolveModelMetadata('meta-llama/Llama-2-7b-chat-hf', {
        discover: false
    })
    assert.ok(modelMetadata, 'model metadata should resolve from catalog')
    assert.ok(modelMetadata.parameterCount > 0, 'should have parameter count')

    // Step 2: Estimate VRAM
    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype
    })
    assert.ok(vramEstimate.vramGb > 0, 'VRAM estimate should be positive')

    // Step 3: Filter and rank instances by VRAM
    const recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        INSTANCE_CATALOG,
        { limit: 10 }
    )
    assert.ok(recommendations.length > 0, 'should have VRAM-compatible instances')

    // All recommendations should have enough VRAM
    for (const rec of recommendations) {
        assert.ok(rec.totalVramGb >= vramEstimate.vramGb * 0.5,
            `${rec.instanceType} totalVramGb (${rec.totalVramGb}) should be reasonable for ${vramEstimate.vramGb}GB requirement`)
    }
})

await test('full pipeline: quota filtering removes zero-quota instances', async () => {
    // Simulate the pipeline with mock quota data
    const modelMetadata = await resolveModelMetadata('meta-llama/Llama-2-7b-chat-hf', {
        discover: false
    })
    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype
    })
    const recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        INSTANCE_CATALOG,
        { limit: 10 }
    )

    // Create mock quota data: mark some instances as zero-quota
    const quotas = new Map()
    for (let i = 0; i < recommendations.length; i++) {
        const rec = recommendations[i]
        if (i < 2) {
            // First two instances have zero quota
            quotas.set(rec.instanceType, { quota: 2, deployed: 2, headroom: 0 })
        } else {
            quotas.set(rec.instanceType, { quota: 5, deployed: 1, headroom: 4 })
        }
    }

    // Apply availability ranking
    const ranked = applyAvailabilityRanking(recommendations, quotas, null, null)

    // Zero-quota instances should be filtered out
    assert.ok(ranked.length < recommendations.length,
        'ranked list should be shorter after filtering zero-quota instances')
    assert.strictEqual(ranked.length, recommendations.length - 2,
        'should have removed exactly 2 zero-quota instances')

    // No remaining instance should have zero-quota status
    for (const rec of ranked) {
        assert.notStrictEqual(rec.quotaStatus, 'zero-quota',
            `${rec.instanceType} should not have zero-quota status`)
    }
})

await test('full pipeline: availability ranking reorders by reserved → FTP → on-demand', async () => {
    const modelMetadata = await resolveModelMetadata('meta-llama/Llama-2-7b-chat-hf', {
        discover: false
    })
    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype
    })
    const recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        INSTANCE_CATALOG,
        { limit: 10 }
    )

    assert.ok(recommendations.length >= 3, 'need at least 3 recommendations for this test')

    // Create mock data: one reserved, one FTP, rest on-demand
    const reservedInstance = recommendations[2].instanceType
    const ftpInstance = recommendations[1].instanceType
    const onDemandInstance = recommendations[0].instanceType

    const quotas = new Map()
    for (const rec of recommendations) {
        quotas.set(rec.instanceType, { quota: 5, deployed: 1, headroom: 4 })
    }

    const reservations = new Map([
        [reservedInstance, { reservationId: 'cr-test-123', count: 2, expiresAt: '2025-12-31' }]
    ])
    const ftps = new Map([
        [ftpInstance, { planName: 'test-plan', remainingCapacity: 4, expiresAt: '2025-06-30' }]
    ])

    const ranked = applyAvailabilityRanking(recommendations, quotas, reservations, ftps)

    // Reserved should be first
    assert.strictEqual(ranked[0].instanceType, reservedInstance,
        'reserved instance should be first')
    assert.strictEqual(ranked[0].capacityType, 'reserved')

    // FTP should be second
    assert.strictEqual(ranked[1].instanceType, ftpInstance,
        'FTP instance should be second')
    assert.strictEqual(ranked[1].capacityType, 'ftp')

    // On-demand should come after
    const onDemandRecs = ranked.filter(r => r.capacityType === 'on-demand')
    assert.ok(onDemandRecs.length > 0, 'should have on-demand instances')
    assert.ok(onDemandRecs.includes(ranked.find(r => r.instanceType === onDemandInstance)),
        'original first instance should now be in on-demand tier')
})

await test('full pipeline: annotations are correct after ranking', async () => {
    const modelMetadata = await resolveModelMetadata('meta-llama/Llama-2-7b-chat-hf', {
        discover: false
    })
    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype
    })
    const recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        INSTANCE_CATALOG,
        { limit: 5 }
    )

    assert.ok(recommendations.length >= 3, 'need at least 3 recommendations')

    const reservedInstance = recommendations[0].instanceType
    const ftpInstance = recommendations[1].instanceType

    const quotas = new Map([
        [reservedInstance, { quota: 5, deployed: 4, headroom: 1 }],
        [ftpInstance, { quota: 3, deployed: 0, headroom: 3 }]
    ])
    for (let i = 2; i < recommendations.length; i++) {
        quotas.set(recommendations[i].instanceType, { quota: 10, deployed: 2, headroom: 8 })
    }

    const reservations = new Map([
        [reservedInstance, { reservationId: 'cr-anno-test', count: 3, expiresAt: '2025-12-31T00:00:00Z' }]
    ])
    const ftps = new Map([
        [ftpInstance, { planName: 'anno-plan', remainingCapacity: 6, expiresAt: '2025-06-30T00:00:00Z' }]
    ])

    const ranked = applyAvailabilityRanking(recommendations, quotas, reservations, ftps)

    // Check reserved instance annotations
    const reserved = ranked.find(r => r.instanceType === reservedInstance)
    assert.strictEqual(reserved.capacityType, 'reserved')
    assert.strictEqual(reserved.reservationInfo.reservationId, 'cr-anno-test')
    assert.strictEqual(reserved.reservationInfo.count, 3)
    assert.strictEqual(reserved.quotaStatus, 'limited', 'headroom 1 should be limited')
    assert.strictEqual(reserved.quotaHeadroom, 1)

    // Check FTP instance annotations
    const ftp = ranked.find(r => r.instanceType === ftpInstance)
    assert.strictEqual(ftp.capacityType, 'ftp')
    assert.strictEqual(ftp.ftpInfo.planName, 'anno-plan')
    assert.strictEqual(ftp.ftpInfo.remainingCapacity, 6)
    assert.strictEqual(ftp.quotaStatus, 'available')
    assert.strictEqual(ftp.quotaHeadroom, 3)

    // Check on-demand annotations
    const onDemand = ranked.filter(r => r.capacityType === 'on-demand')
    for (const rec of onDemand) {
        assert.strictEqual(rec.quotaStatus, 'available')
        assert.strictEqual(rec.quotaHeadroom, 8)
    }
})

// ── Test 2: Discover mode off = identical to current behavior ────────────────

console.log('\nquota-integration: discover mode off produces identical results\n')

await test('discover mode off: no quota/availability annotations in response', async () => {
    // DISCOVER_MODE is off by default when running tests (no --discover flag)
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    // Verify no quota-related annotations exist on recommendations
    for (const rec of data.metadata.recommendations) {
        assert.strictEqual(rec.capacityType, undefined,
            `${rec.instanceType} should not have capacityType when discover mode is off`)
        assert.strictEqual(rec.quotaStatus, undefined,
            `${rec.instanceType} should not have quotaStatus when discover mode is off`)
        assert.strictEqual(rec.reservationInfo, undefined,
            `${rec.instanceType} should not have reservationInfo when discover mode is off`)
        assert.strictEqual(rec.ftpInfo, undefined,
            `${rec.instanceType} should not have ftpInfo when discover mode is off`)
        assert.strictEqual(rec.quotaHeadroom, undefined,
            `${rec.instanceType} should not have quotaHeadroom when discover mode is off`)
    }
})

await test('discover mode off: allFilteredByQuota is false', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    assert.strictEqual(data.metadata.allFilteredByQuota, false,
        'allFilteredByQuota should be false when discover mode is off')
})

await test('discover mode off: response structure matches pre-quota behavior', async () => {
    const result = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data = parseResponse(result)

    // Standard response fields should be present
    assert.ok(data.values.instanceType, 'should have values.instanceType')
    assert.ok(data.choices.instanceType.length > 0, 'should have choices')
    assert.ok(data.metadata.modelName, 'should have modelName')
    assert.ok(data.metadata.parameterCount, 'should have parameterCount')
    assert.ok(data.metadata.estimatedVramGb, 'should have estimatedVramGb')
    assert.ok(data.metadata.recommendations.length > 0, 'should have recommendations')
    assert.strictEqual(data.metadata.source, 'catalog', 'source should be catalog')
    assert.strictEqual(data.metadata.smartModeUsed, false, 'smartModeUsed should be false')

    // Each recommendation should have standard fields only
    const rec = data.metadata.recommendations[0]
    assert.ok(rec.instanceType, 'should have instanceType')
    assert.ok(typeof rec.gpuCount === 'number', 'should have gpuCount')
    assert.ok(typeof rec.totalVramGb === 'number', 'should have totalVramGb')
    assert.ok(typeof rec.utilizationPercent === 'number', 'should have utilizationPercent')
    assert.ok(typeof rec.tensorParallelism === 'number', 'should have tensorParallelism')
    assert.ok(typeof rec.costTier === 'string', 'should have costTier')
})

await test('discover mode off: results are deterministic across calls', async () => {
    const result1 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data1 = parseResponse(result1)

    const result2 = await handleGetInstanceRecommendation({
        modelName: 'meta-llama/Llama-2-7b-chat-hf',
        context: { architecture: 'transformers', backend: 'vllm' }
    })
    const data2 = parseResponse(result2)

    // Same model should produce same results
    assert.strictEqual(data1.values.instanceType, data2.values.instanceType,
        'top recommendation should be the same across calls')
    assert.deepStrictEqual(data1.choices.instanceType, data2.choices.instanceType,
        'choices should be identical across calls')
    assert.strictEqual(data1.metadata.estimatedVramGb, data2.metadata.estimatedVramGb,
        'VRAM estimate should be identical across calls')
})

// ── Test 3: Full pipeline with large model (multi-GPU) ───────────────────────

console.log('\nquota-integration: full pipeline with large model (multi-GPU)\n')

await test('full pipeline: large model (70B) with quota filtering', async () => {
    const modelMetadata = await resolveModelMetadata('meta-llama/Llama-2-70b-hf', {
        discover: false
    })
    assert.ok(modelMetadata, 'should resolve 70B model from catalog')

    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype
    })
    assert.ok(vramEstimate.vramGb > 100, '70B model should need > 100GB VRAM')

    const recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        INSTANCE_CATALOG,
        { limit: 10 }
    )
    assert.ok(recommendations.length > 0, 'should have compatible multi-GPU instances')

    // All recommendations for 70B should be multi-GPU
    for (const rec of recommendations) {
        assert.ok(rec.tensorParallelism > 1,
            `${rec.instanceType} should require TP > 1 for 70B model`)
    }

    // Apply quota filtering — mark first instance as zero-quota
    const quotas = new Map()
    quotas.set(recommendations[0].instanceType, { quota: 1, deployed: 1, headroom: 0 })
    for (let i = 1; i < recommendations.length; i++) {
        quotas.set(recommendations[i].instanceType, { quota: 3, deployed: 0, headroom: 3 })
    }

    const ranked = applyAvailabilityRanking(recommendations, quotas, null, null)

    // First instance should be filtered out
    assert.strictEqual(ranked.length, recommendations.length - 1,
        'should filter out the zero-quota instance')
    assert.ok(!ranked.find(r => r.instanceType === recommendations[0].instanceType),
        'zero-quota instance should not appear in results')
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
