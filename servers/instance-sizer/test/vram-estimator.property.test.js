#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-based tests for the VRAM estimation engine.
 * Uses fast-check for property-based testing and node:assert for assertions.
 * Run: node servers/instance-sizer/test/vram-estimator.property.test.js
 *
 * Validates: Requirements 1.2, 1.3, 1.4
 */

import assert from 'node:assert'
import fc from 'fast-check'
import { estimateVram } from '../lib/vram-estimator.js'

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

// ── Generators ───────────────────────────────────────────────────────────────

const parameterCountArb = fc.integer({ min: 1_000_000, max: 200_000_000_000 })
const dtypeArb = fc.constantFrom('float32', 'float16', 'bfloat16')
const maxSequenceLengthArb = fc.integer({ min: 512, max: 131072 })
const batchSizeArb = fc.integer({ min: 1, max: 64 })

// ── Property 1: VRAM estimate monotonicity ───────────────────────────────────
// For any two models where model A has more parameters than model B
// (same dtype, same quantization), the VRAM estimate for A SHALL be
// strictly greater than the estimate for B.
//
// **Validates: Requirements 1.2**

console.log('\nvram-estimator property tests: VRAM estimate monotonicity\n')

test('Property 1: more parameters → strictly higher VRAM estimate (same dtype, no quantization)', () => {
    fc.assert(
        fc.property(
            parameterCountArb,
            parameterCountArb,
            dtypeArb,
            maxSequenceLengthArb,
            batchSizeArb,
            (paramsA, paramsB, dtype, maxSequenceLength, batchSize) => {
                // Ensure paramsA > paramsB
                const larger = Math.max(paramsA, paramsB)
                const smaller = Math.min(paramsA, paramsB)

                // Skip when equal — monotonicity is strict
                fc.pre(larger > smaller)

                const resultLarger = estimateVram({
                    parameterCount: larger,
                    dtype,
                    maxSequenceLength,
                    batchSize
                })

                const resultSmaller = estimateVram({
                    parameterCount: smaller,
                    dtype,
                    maxSequenceLength,
                    batchSize
                })

                assert.ok(
                    resultLarger.vramGb > resultSmaller.vramGb,
                    `Expected ${larger} params (${resultLarger.vramGb.toFixed(4)}GB) > ${smaller} params (${resultSmaller.vramGb.toFixed(4)}GB) for dtype=${dtype}`
                )
            }
        ),
        { numRuns: 200 }
    )
})

test('Property 1: more parameters → strictly higher VRAM estimate (with quantization)', () => {
    const quantizationArb = fc.constantFrom('awq', 'gptq', 'bnb-4bit', 'bnb-8bit')

    fc.assert(
        fc.property(
            parameterCountArb,
            parameterCountArb,
            dtypeArb,
            quantizationArb,
            maxSequenceLengthArb,
            batchSizeArb,
            (paramsA, paramsB, dtype, quantization, maxSequenceLength, batchSize) => {
                const larger = Math.max(paramsA, paramsB)
                const smaller = Math.min(paramsA, paramsB)

                fc.pre(larger > smaller)

                const resultLarger = estimateVram({
                    parameterCount: larger,
                    dtype,
                    quantization,
                    maxSequenceLength,
                    batchSize
                })

                const resultSmaller = estimateVram({
                    parameterCount: smaller,
                    dtype,
                    quantization,
                    maxSequenceLength,
                    batchSize
                })

                assert.ok(
                    resultLarger.vramGb > resultSmaller.vramGb,
                    `Expected ${larger} params (${resultLarger.vramGb.toFixed(4)}GB) > ${smaller} params (${resultSmaller.vramGb.toFixed(4)}GB) for dtype=${dtype}, quant=${quantization}`
                )
            }
        ),
        { numRuns: 200 }
    )
})

// ── Property 2: Quantization reduces estimate ────────────────────────────────
// For any model, the VRAM estimate with 4-bit quantization SHALL be less than
// the estimate with 16-bit dtype, and the estimate with 8-bit SHALL be between them.
//
// **Validates: Requirements 1.3, 1.4**

console.log('\nvram-estimator property tests: Quantization reduces estimate\n')

test('Property 2: 4-bit < 8-bit < 16-bit for any model configuration', () => {
    fc.assert(
        fc.property(
            parameterCountArb,
            dtypeArb,
            maxSequenceLengthArb,
            batchSizeArb,
            (parameterCount, dtype, maxSequenceLength, batchSize) => {
                const common = { parameterCount, dtype, maxSequenceLength, batchSize }

                const vram16bit = estimateVram({ ...common }).vramGb
                const vram8bit = estimateVram({ ...common, quantization: 'bnb-8bit' }).vramGb
                const vram4bit = estimateVram({ ...common, quantization: 'bnb-4bit' }).vramGb

                assert.ok(
                    vram4bit < vram8bit,
                    `4-bit (${vram4bit.toFixed(4)}GB) should be < 8-bit (${vram8bit.toFixed(4)}GB) for params=${parameterCount}, dtype=${dtype}`
                )
                assert.ok(
                    vram8bit < vram16bit,
                    `8-bit (${vram8bit.toFixed(4)}GB) should be < 16-bit (${vram16bit.toFixed(4)}GB) for params=${parameterCount}, dtype=${dtype}`
                )
            }
        ),
        { numRuns: 200 }
    )
})

test('Property 2: AWQ (4-bit) < 16-bit for any model configuration', () => {
    fc.assert(
        fc.property(
            parameterCountArb,
            dtypeArb,
            maxSequenceLengthArb,
            batchSizeArb,
            (parameterCount, dtype, maxSequenceLength, batchSize) => {
                const common = { parameterCount, dtype, maxSequenceLength, batchSize }

                const vram16bit = estimateVram({ ...common }).vramGb
                const vramAwq = estimateVram({ ...common, quantization: 'awq' }).vramGb

                assert.ok(
                    vramAwq < vram16bit,
                    `AWQ (${vramAwq.toFixed(4)}GB) should be < 16-bit (${vram16bit.toFixed(4)}GB) for params=${parameterCount}, dtype=${dtype}`
                )
            }
        ),
        { numRuns: 200 }
    )
})

test('Property 2: GPTQ (4-bit) < 16-bit for any model configuration', () => {
    fc.assert(
        fc.property(
            parameterCountArb,
            dtypeArb,
            maxSequenceLengthArb,
            batchSizeArb,
            (parameterCount, dtype, maxSequenceLength, batchSize) => {
                const common = { parameterCount, dtype, maxSequenceLength, batchSize }

                const vram16bit = estimateVram({ ...common }).vramGb
                const vramGptq = estimateVram({ ...common, quantization: 'gptq' }).vramGb

                assert.ok(
                    vramGptq < vram16bit,
                    `GPTQ (${vramGptq.toFixed(4)}GB) should be < 16-bit (${vram16bit.toFixed(4)}GB) for params=${parameterCount}, dtype=${dtype}`
                )
            }
        ),
        { numRuns: 200 }
    )
})

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
