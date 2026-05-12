#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Instance Filter & Ranker.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/instance-ranker.test.js
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import assert from 'node:assert'
import {
    filterAndRankInstances,
    getPerGpuMemoryGb,
    getCostTier,
    effectiveVram,
    GPU_MEMORY_MAP,
    COST_TIER_MAP,
    COST_TIER_WEIGHT,
    TP_OVERHEAD_PER_GPU
} from '../lib/instance-ranker.js'

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

// ── Test Catalog ─────────────────────────────────────────────────────────────

const TEST_CATALOG = {
    'ml.g4dn.xlarge': {
        category: 'gpu',
        gpus: 1,
        vcpus: 4,
        memGb: 16,
        accelerator: 'T4 16GB',
        family: 'g4dn',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA T4',
        gpuArchitecture: 'Turing'
    },
    'ml.g6.xlarge': {
        category: 'gpu',
        gpus: 1,
        vcpus: 4,
        memGb: 32,
        accelerator: 'L4 24GB',
        family: 'g6',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA L4',
        gpuArchitecture: 'Ada Lovelace'
    },
    'ml.g5.xlarge': {
        category: 'gpu',
        gpus: 1,
        vcpus: 4,
        memGb: 16,
        accelerator: 'A10G 24GB',
        family: 'g5',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA A10G',
        gpuArchitecture: 'Ampere'
    },
    'ml.g5.2xlarge': {
        category: 'gpu',
        gpus: 1,
        vcpus: 8,
        memGb: 32,
        accelerator: 'A10G 24GB',
        family: 'g5',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA A10G',
        gpuArchitecture: 'Ampere'
    },
    'ml.g5.12xlarge': {
        category: 'gpu',
        gpus: 4,
        vcpus: 48,
        memGb: 192,
        accelerator: '4x A10G 96GB',
        family: 'g5',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA A10G',
        gpuArchitecture: 'Ampere'
    },
    'ml.g5.48xlarge': {
        category: 'gpu',
        gpus: 8,
        vcpus: 192,
        memGb: 768,
        accelerator: '8x A10G 192GB',
        family: 'g5',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA A10G',
        gpuArchitecture: 'Ampere'
    },
    'ml.p3.2xlarge': {
        category: 'gpu',
        gpus: 1,
        vcpus: 8,
        memGb: 61,
        accelerator: 'V100 16GB',
        family: 'p3',
        acceleratorType: 'cuda',
        hardware: 'NVIDIA V100',
        gpuArchitecture: 'Volta'
    },
    'ml.m5.large': {
        category: 'cpu',
        gpus: 0,
        vcpus: 2,
        memGb: 8,
        accelerator: '',
        family: 'm5',
        acceleratorType: 'cpu',
        hardware: 'None',
        gpuArchitecture: 'None'
    }
}

// ── getPerGpuMemoryGb Helper Tests ───────────────────────────────────────────

console.log('\ninstance-ranker: getPerGpuMemoryGb\n')

test('returns per-GPU memory from accelerator string (single GPU)', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.g5.xlarge'])
    assert.strictEqual(result, 24)
})

test('returns per-GPU memory from accelerator string (multi-GPU)', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.g5.12xlarge'])
    assert.strictEqual(result, 24)
})

test('returns per-GPU memory for T4 instance', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.g4dn.xlarge'])
    assert.strictEqual(result, 16)
})

test('returns per-GPU memory for V100 instance', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.p3.2xlarge'])
    assert.strictEqual(result, 16)
})

test('returns per-GPU memory for 8-GPU instance', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.g5.48xlarge'])
    assert.strictEqual(result, 24)
})

test('returns null for CPU-only instance', () => {
    const result = getPerGpuMemoryGb(TEST_CATALOG['ml.m5.large'])
    assert.strictEqual(result, null)
})

test('uses direct gpuMemoryGb field when available', () => {
    const instance = { gpuMemoryGb: 80, gpus: 1, hardware: 'NVIDIA A100' }
    const result = getPerGpuMemoryGb(instance)
    assert.strictEqual(result, 80)
})

test('falls back to GPU_MEMORY_MAP when accelerator string has no GB', () => {
    const instance = { gpus: 1, accelerator: 'Inferentia2', hardware: 'AWS Inferentia2' }
    const result = getPerGpuMemoryGb(instance)
    assert.strictEqual(result, 32)
})

// ── getCostTier Helper Tests ─────────────────────────────────────────────────

console.log('\ninstance-ranker: getCostTier\n')

test('g4dn family is low cost tier', () => {
    assert.strictEqual(getCostTier(TEST_CATALOG['ml.g4dn.xlarge']), 'low')
})

test('g5 family is medium cost tier', () => {
    assert.strictEqual(getCostTier(TEST_CATALOG['ml.g5.xlarge']), 'medium')
})

test('p3 family is high cost tier', () => {
    assert.strictEqual(getCostTier(TEST_CATALOG['ml.p3.2xlarge']), 'high')
})

test('uses direct costTier field when available', () => {
    const instance = { costTier: 'low', family: 'p3' }
    assert.strictEqual(getCostTier(instance), 'low')
})

test('defaults to medium for unknown family', () => {
    const instance = { family: 'unknown_family' }
    assert.strictEqual(getCostTier(instance), 'medium')
})

// ── effectiveVram Helper Tests ───────────────────────────────────────────────

console.log('\ninstance-ranker: effectiveVram\n')

test('single GPU returns full VRAM (no overhead)', () => {
    const result = effectiveVram(24, 1)
    assert.strictEqual(result, 24)
})

test('2 GPUs apply 10% overhead on second GPU', () => {
    // 48GB total, 24GB per GPU
    // overhead = 24 * 0.10 * (2-1) = 2.4
    // effective = 48 - 2.4 = 45.6
    const result = effectiveVram(48, 2)
    assert.ok(Math.abs(result - 45.6) < 0.001, `Expected 45.6, got ${result}`)
})

test('4 GPUs apply 10% overhead per additional GPU', () => {
    // 96GB total, 24GB per GPU
    // overhead = 24 * 0.10 * (4-1) = 7.2
    // effective = 96 - 7.2 = 88.8
    const result = effectiveVram(96, 4)
    assert.ok(Math.abs(result - 88.8) < 0.001, `Expected 88.8, got ${result}`)
})

test('8 GPUs apply 10% overhead per additional GPU', () => {
    // 192GB total, 24GB per GPU
    // overhead = 24 * 0.10 * (8-1) = 16.8
    // effective = 192 - 16.8 = 175.2
    const result = effectiveVram(192, 8)
    assert.ok(Math.abs(result - 175.2) < 0.001, `Expected 175.2, got ${result}`)
})

test('effective VRAM is always less than total for multi-GPU', () => {
    const total = 96
    const gpuCount = 4
    const result = effectiveVram(total, gpuCount)
    assert.ok(result < total, `Effective (${result}) should be < total (${total})`)
    assert.ok(result > 0, `Effective (${result}) should be > 0`)
})

// ── Filtering Tests ──────────────────────────────────────────────────────────

console.log('\ninstance-ranker: filtering\n')

test('14GB model includes T4 (16GB) and A10G (24GB) instances', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG)
    const types = results.map(r => r.instanceType)
    assert.ok(types.includes('ml.g4dn.xlarge'), 'Should include T4 16GB (16 >= 14)')
    assert.ok(types.includes('ml.g5.xlarge'), 'Should include A10G 24GB')
    assert.ok(types.includes('ml.g5.2xlarge'), 'Should include A10G 24GB (2xlarge)')
    assert.ok(types.includes('ml.p3.2xlarge'), 'Should include V100 16GB (16 >= 14)')
})

test('17GB model excludes T4 (16GB) and V100 (16GB) but includes A10G (24GB)', () => {
    const results = filterAndRankInstances(17, TEST_CATALOG)
    const types = results.map(r => r.instanceType)
    assert.ok(!types.includes('ml.g4dn.xlarge'), 'Should exclude T4 16GB (16 < 17)')
    assert.ok(!types.includes('ml.p3.2xlarge'), 'Should exclude V100 16GB (16 < 17)')
    assert.ok(types.includes('ml.g5.xlarge'), 'Should include A10G 24GB')
    assert.ok(types.includes('ml.g5.2xlarge'), 'Should include A10G 24GB (2xlarge)')
})

test('CPU instances are always excluded', () => {
    const results = filterAndRankInstances(1, TEST_CATALOG)
    const types = results.map(r => r.instanceType)
    assert.ok(!types.includes('ml.m5.large'), 'CPU instance should be excluded')
})

test('140GB model includes ml.g5.48xlarge with TP=8', () => {
    const results = filterAndRankInstances(140, TEST_CATALOG)
    const g5_48 = results.find(r => r.instanceType === 'ml.g5.48xlarge')
    assert.ok(g5_48, 'ml.g5.48xlarge should be included (8×24GB=192GB effective ~175.2GB)')
    assert.strictEqual(g5_48.tensorParallelism, 8)
    assert.strictEqual(g5_48.gpuCount, 8)
})

test('140GB model excludes single-GPU instances', () => {
    const results = filterAndRankInstances(140, TEST_CATALOG)
    const singleGpu = results.filter(r => r.tensorParallelism === 1)
    assert.strictEqual(singleGpu.length, 0, 'No single-GPU instance has 140GB VRAM')
})

test('allowTensorParallelism=false excludes multi-GPU results', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG, { allowTensorParallelism: false })
    const multiGpu = results.filter(r => r.tensorParallelism > 1)
    assert.strictEqual(multiGpu.length, 0, 'No multi-GPU results when TP disabled')
})

test('allowTensorParallelism=false still includes single-GPU instances', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG, { allowTensorParallelism: false })
    assert.ok(results.length > 0, 'Should still have single-GPU results')
    results.forEach(r => {
        assert.strictEqual(r.tensorParallelism, 1, `${r.instanceType} should have TP=1`)
    })
})

// ── Empty Results ────────────────────────────────────────────────────────────

console.log('\ninstance-ranker: empty results\n')

test('500GB model exceeds all instances — returns empty', () => {
    const results = filterAndRankInstances(500, TEST_CATALOG)
    assert.strictEqual(results.length, 0, 'No instance can fit 500GB')
})

test('returns empty for zero vramRequired', () => {
    const results = filterAndRankInstances(0, TEST_CATALOG)
    assert.strictEqual(results.length, 0)
})

test('returns empty for negative vramRequired', () => {
    const results = filterAndRankInstances(-5, TEST_CATALOG)
    assert.strictEqual(results.length, 0)
})

test('returns empty for null catalog', () => {
    const results = filterAndRankInstances(14, null)
    assert.strictEqual(results.length, 0)
})

test('returns empty for empty catalog', () => {
    const results = filterAndRankInstances(14, {})
    assert.strictEqual(results.length, 0)
})

// ── Ranking Tests ────────────────────────────────────────────────────────────

console.log('\ninstance-ranker: ranking\n')

test('single-GPU instances appear before multi-GPU for same model', () => {
    // 14GB fits on single A10G (24GB) and also on multi-GPU configs
    const results = filterAndRankInstances(14, TEST_CATALOG)
    const firstMultiGpu = results.findIndex(r => r.tensorParallelism > 1)
    const lastSingleGpu = results.reduce((last, r, i) => r.tensorParallelism === 1 ? i : last, -1)

    if (firstMultiGpu !== -1 && lastSingleGpu !== -1) {
        assert.ok(lastSingleGpu < firstMultiGpu,
            `Last single-GPU (idx ${lastSingleGpu}) should be before first multi-GPU (idx ${firstMultiGpu})`)
    }
})

test('newer generation ranks before older generation within same TP', () => {
    // 14GB model fits g4dn (16GB), g6 (24GB), g5 (24GB), p3 (16GB)
    // Expected order: g6 (gen 1) → g5 (gen 3) → p3 (gen 5) → g4dn (gen 6)
    const results = filterAndRankInstances(14, TEST_CATALOG)
    const singleGpu = results.filter(r => r.tensorParallelism === 1)
    const families = singleGpu.map(r => r.family)

    const firstG6 = families.indexOf('g6')
    const firstG5 = families.indexOf('g5')
    const firstP3 = families.indexOf('p3')
    const firstG4dn = families.indexOf('g4dn')

    assert.ok(firstG6 !== -1, 'g6 should be in results')
    assert.ok(firstG5 !== -1, 'g5 should be in results')
    assert.ok(firstP3 !== -1, 'p3 should be in results')
    assert.ok(firstG4dn !== -1, 'g4dn should be in results')

    assert.ok(firstG6 < firstG5, `g6 (idx ${firstG6}) should rank before g5 (idx ${firstG5})`)
    assert.ok(firstG5 < firstP3, `g5 (idx ${firstG5}) should rank before p3 (idx ${firstP3})`)
    assert.ok(firstP3 < firstG4dn, `p3 (idx ${firstP3}) should rank before g4dn (idx ${firstG4dn})`)
})

test('all returned instances have required fields', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG)
    assert.ok(results.length > 0, 'Should have results')
    for (const r of results) {
        assert.ok('instanceType' in r, `Missing instanceType in ${JSON.stringify(r)}`)
        assert.ok('gpuCount' in r, `Missing gpuCount in ${JSON.stringify(r)}`)
        assert.ok('totalVramGb' in r, `Missing totalVramGb in ${JSON.stringify(r)}`)
        assert.ok('utilizationPercent' in r, `Missing utilizationPercent in ${JSON.stringify(r)}`)
        assert.ok('tensorParallelism' in r, `Missing tensorParallelism in ${JSON.stringify(r)}`)
        assert.ok('costTier' in r, `Missing costTier in ${JSON.stringify(r)}`)
    }
})

test('utilization percent is between 1 and 100 for all results', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG)
    for (const r of results) {
        assert.ok(r.utilizationPercent >= 1 && r.utilizationPercent <= 100,
            `${r.instanceType} utilization ${r.utilizationPercent}% should be 1-100`)
    }
})

// ── Limit Parameter ──────────────────────────────────────────────────────────

console.log('\ninstance-ranker: limit parameter\n')

test('limit=2 caps results to 2', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG, { limit: 2 })
    assert.ok(results.length <= 2, `Expected <= 2 results, got ${results.length}`)
})

test('limit=1 returns only top recommendation', () => {
    const results = filterAndRankInstances(14, TEST_CATALOG, { limit: 1 })
    assert.strictEqual(results.length, 1)
})

test('default limit is 10', () => {
    // With our small test catalog we won't hit 10, but verify it doesn't crash
    const results = filterAndRankInstances(14, TEST_CATALOG)
    assert.ok(results.length <= 10, `Default limit should cap at 10, got ${results.length}`)
})

// ── Constants Validation ─────────────────────────────────────────────────────

console.log('\ninstance-ranker: constants\n')

test('TP_OVERHEAD_PER_GPU is 0.10', () => {
    assert.strictEqual(TP_OVERHEAD_PER_GPU, 0.10)
})

test('GPU_MEMORY_MAP has expected entries', () => {
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA T4'], 16)
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA A10G'], 24)
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA V100'], 16)
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA L4'], 24)
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA A100'], 40)
    assert.strictEqual(GPU_MEMORY_MAP['NVIDIA H100'], 80)
})

test('COST_TIER_MAP classifies families correctly', () => {
    assert.strictEqual(COST_TIER_MAP['g4dn'], 'low')
    assert.strictEqual(COST_TIER_MAP['g5'], 'medium')
    assert.strictEqual(COST_TIER_MAP['g6'], 'medium')
    assert.strictEqual(COST_TIER_MAP['p3'], 'high')
    assert.strictEqual(COST_TIER_MAP['p4d'], 'high')
    assert.strictEqual(COST_TIER_MAP['p5'], 'high')
})

test('COST_TIER_WEIGHT orders low < medium < high', () => {
    assert.ok(COST_TIER_WEIGHT['low'] < COST_TIER_WEIGHT['medium'])
    assert.ok(COST_TIER_WEIGHT['medium'] < COST_TIER_WEIGHT['high'])
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
