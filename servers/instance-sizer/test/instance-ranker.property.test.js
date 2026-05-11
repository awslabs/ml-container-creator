#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-based tests for the Instance Filter & Ranker.
 * Uses fast-check for property-based testing and node:assert for assertions.
 * Run: node servers/instance-sizer/test/instance-ranker.property.test.js
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6
 */

import assert from 'node:assert'
import fc from 'fast-check'
import {
    filterAndRankInstances,
    getPerGpuMemoryGb,
    effectiveVram,
    COST_TIER_WEIGHT
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
    'ml.g4dn.xlarge': { category: 'gpu', gpus: 1, accelerator: 'T4 16GB', family: 'g4dn', hardware: 'NVIDIA T4' },
    'ml.g5.xlarge': { category: 'gpu', gpus: 1, accelerator: 'A10G 24GB', family: 'g5', hardware: 'NVIDIA A10G' },
    'ml.g5.2xlarge': { category: 'gpu', gpus: 1, accelerator: 'A10G 24GB', family: 'g5', hardware: 'NVIDIA A10G' },
    'ml.g5.12xlarge': { category: 'gpu', gpus: 4, accelerator: '4x A10G 96GB', family: 'g5', hardware: 'NVIDIA A10G' },
    'ml.g5.48xlarge': { category: 'gpu', gpus: 8, accelerator: '8x A10G 192GB', family: 'g5', hardware: 'NVIDIA A10G' },
    'ml.p3.2xlarge': { category: 'gpu', gpus: 1, accelerator: 'V100 16GB', family: 'p3', hardware: 'NVIDIA V100' },
    'ml.m5.large': { category: 'cpu', gpus: 0, accelerator: '', family: 'm5', hardware: 'None' }
}

// ── Generators ───────────────────────────────────────────────────────────────

const vramRequiredArb = fc.float({ min: 1, max: 300, noNaN: true })

// ── Property 3: All returned instances fit the model ─────────────────────────
// For any model and for any instance in the returned recommendations list,
// the instance's total GPU VRAM (considering tensor parallelism) SHALL be ≥
// the estimated VRAM requirement.
//
// **Validates: Requirements 2.1**

console.log('\ninstance-ranker property tests: All returned instances fit the model\n')

test('Property 3: every returned instance has sufficient VRAM for the model (single-GPU uses raw VRAM, multi-GPU uses effective VRAM)', () => {
    fc.assert(
        fc.property(
            vramRequiredArb,
            (vramRequired) => {
                const results = filterAndRankInstances(vramRequired, TEST_CATALOG)

                for (const result of results) {
                    if (result.tensorParallelism === 1) {
                        // Single-GPU: total VRAM must be >= vramRequired
                        assert.ok(
                            result.totalVramGb >= vramRequired,
                            `Single-GPU ${result.instanceType}: totalVramGb (${result.totalVramGb}) should be >= vramRequired (${vramRequired})`
                        )
                    } else {
                        // Multi-GPU: effective VRAM (after TP overhead) must be >= vramRequired
                        const effective = effectiveVram(result.totalVramGb, result.gpuCount)
                        assert.ok(
                            effective >= vramRequired,
                            `Multi-GPU ${result.instanceType}: effectiveVram (${effective}) should be >= vramRequired (${vramRequired})`
                        )
                    }
                }
            }
        ),
        { numRuns: 200 }
    )
})

// ── Property 4: Ranking respects cost-efficiency within TP tiers ─────────────
// For any two adjacent instances in the ranked results (position i and i+1),
// instance at position i SHALL have equal or better cost-efficiency than the
// instance at position i+1, within the same TP tier.
//
// **Validates: Requirements 2.2**

console.log('\ninstance-ranker property tests: Ranking respects cost-efficiency within TP tiers\n')

test('Property 4: within the same TP tier, adjacent instances are ordered by cost tier (lower or equal cost weight first)', () => {
    fc.assert(
        fc.property(
            vramRequiredArb,
            (vramRequired) => {
                const results = filterAndRankInstances(vramRequired, TEST_CATALOG)

                for (let i = 0; i < results.length - 1; i++) {
                    const current = results[i]
                    const next = results[i + 1]

                    // Only check within the same TP tier
                    if (current.tensorParallelism === next.tensorParallelism) {
                        const costCurrent = COST_TIER_WEIGHT[current.costTier] || 2
                        const costNext = COST_TIER_WEIGHT[next.costTier] || 2

                        assert.ok(
                            costCurrent <= costNext,
                            `Within TP=${current.tensorParallelism}: ${current.instanceType} (cost weight ${costCurrent}) should have <= cost weight than ${next.instanceType} (cost weight ${costNext})`
                        )
                    }
                }
            }
        ),
        { numRuns: 200 }
    )
})

// ── Property 5: Tensor parallelism degree correctness ────────────────────────
// For any recommended instance with TP > 1, the model's estimated VRAM SHALL
// exceed a single GPU's capacity but fit within (gpuCount × gpuMemoryGb × 0.9)
// accounting for TP overhead.
//
// **Validates: Requirements 2.3, 2.6**

console.log('\ninstance-ranker property tests: TP degree correctness\n')

test('Property 5: TP degree equals GPU count and effective VRAM fits the model', () => {
    fc.assert(
        fc.property(
            vramRequiredArb,
            (vramRequired) => {
                const results = filterAndRankInstances(vramRequired, TEST_CATALOG)

                for (const result of results) {
                    if (result.tensorParallelism > 1) {
                        // TP degree must equal the instance's GPU count
                        assert.strictEqual(
                            result.tensorParallelism,
                            result.gpuCount,
                            `${result.instanceType}: tensorParallelism (${result.tensorParallelism}) should equal gpuCount (${result.gpuCount})`
                        )

                        // The model must fit within the effective multi-GPU capacity
                        // (gpuCount × gpuMemoryGb × 0.9 accounting for TP overhead)
                        const effectiveTotal = effectiveVram(result.totalVramGb, result.gpuCount)
                        assert.ok(
                            effectiveTotal >= vramRequired,
                            `TP=${result.tensorParallelism} for ${result.instanceType}: effectiveVram (${effectiveTotal.toFixed(2)}) should be >= vramRequired (${vramRequired.toFixed(2)})`
                        )
                    }
                }
            }
        ),
        { numRuns: 200 }
    )
})

test('Property 5: when TP is required (model exceeds single-GPU capacity), only multi-GPU instances are returned', () => {
    fc.assert(
        fc.property(
            // Generate VRAM values that exceed the largest single-GPU in our catalog (24GB)
            // but fit within the largest multi-GPU effective capacity
            fc.float({ min: 25, max: 170, noNaN: true }),
            (vramRequired) => {
                const results = filterAndRankInstances(vramRequired, TEST_CATALOG)

                // All single-GPU instances in our catalog have at most 24GB
                // So for vramRequired > 24, no single-GPU instance should appear
                const singleGpuResults = results.filter(r => r.tensorParallelism === 1)
                assert.strictEqual(
                    singleGpuResults.length,
                    0,
                    `vramRequired=${vramRequired.toFixed(2)}: no single-GPU instance should fit (max single-GPU is 24GB)`
                )

                // For any multi-GPU result, the model exceeds single-GPU capacity
                for (const result of results) {
                    if (result.tensorParallelism > 1) {
                        const perGpuMemory = result.totalVramGb / result.gpuCount
                        assert.ok(
                            vramRequired > perGpuMemory,
                            `TP=${result.tensorParallelism} for ${result.instanceType}: vramRequired (${vramRequired.toFixed(2)}) should exceed single GPU capacity (${perGpuMemory}GB)`
                        )
                    }
                }
            }
        ),
        { numRuns: 200 }
    )
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
