#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the VRAM estimation engine.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/vram-estimator.test.js
 */

import assert from 'node:assert';
import {
    estimateVram,
    bytesPerParam,
    estimateKvCache,
    determineConfidence,
    DEFAULT_MAX_SEQUENCE_LENGTH,
    DEFAULT_BATCH_SIZE,
    OVERHEAD_FACTOR,
    BYTES_IN_GB
} from '../lib/vram-estimator.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

// ── Known Model Estimates ────────────────────────────────────────────────────

console.log('\nvram-estimator: known model estimates\n');

test('Llama-2-7B float16 estimates ~14-15GB VRAM', () => {
    const result = estimateVram({
        parameterCount: 6_738_415_616,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.ok(result.vramGb >= 14, `Expected >= 14GB, got ${result.vramGb.toFixed(2)}GB`);
    assert.ok(result.vramGb <= 15, `Expected <= 15GB, got ${result.vramGb.toFixed(2)}GB`);
});

test('Llama-2-70B float16 estimates ~140-145GB VRAM', () => {
    const result = estimateVram({
        parameterCount: 68_976_648_192,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.ok(result.vramGb >= 140, `Expected >= 140GB, got ${result.vramGb.toFixed(2)}GB`);
    assert.ok(result.vramGb <= 145, `Expected <= 145GB, got ${result.vramGb.toFixed(2)}GB`);
});

test('estimateVram returns expected response shape', () => {
    const result = estimateVram({
        parameterCount: 7_000_000_000,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.ok('vramGb' in result, 'should have vramGb');
    assert.ok('breakdown' in result, 'should have breakdown');
    assert.ok('confidence' in result, 'should have confidence');
    assert.ok('source' in result, 'should have source');
    assert.ok('weightsGb' in result.breakdown, 'breakdown should have weightsGb');
    assert.ok('kvCacheGb' in result.breakdown, 'breakdown should have kvCacheGb');
    assert.ok('overheadGb' in result.breakdown, 'breakdown should have overheadGb');
    assert.strictEqual(result.source, 'estimate');
});

// ── Quantization Adjustments ─────────────────────────────────────────────────

console.log('\nvram-estimator: quantization adjustments\n');

test('4-bit quantization roughly halves estimate vs 8-bit', () => {
    const params = 7_000_000_000;

    const result8bit = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        quantization: 'bnb-8bit',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    const result4bit = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        quantization: 'bnb-4bit',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    // 4-bit weights are half of 8-bit weights, but KV cache is the same
    // So total should be roughly half (weights dominate)
    const ratio = result4bit.vramGb / result8bit.vramGb;
    assert.ok(ratio >= 0.45, `Expected ratio >= 0.45, got ${ratio.toFixed(3)}`);
    assert.ok(ratio <= 0.60, `Expected ratio <= 0.60, got ${ratio.toFixed(3)}`);
});

test('AWQ (4-bit) produces lower estimate than float16', () => {
    const params = 7_000_000_000;

    const resultFp16 = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    const resultAwq = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        quantization: 'awq',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    assert.ok(resultAwq.vramGb < resultFp16.vramGb,
        `AWQ (${resultAwq.vramGb.toFixed(2)}GB) should be less than fp16 (${resultFp16.vramGb.toFixed(2)}GB)`);
});

test('GPTQ (4-bit) produces lower estimate than float16', () => {
    const params = 7_000_000_000;

    const resultFp16 = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    const resultGptq = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        quantization: 'gptq',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    assert.ok(resultGptq.vramGb < resultFp16.vramGb,
        `GPTQ (${resultGptq.vramGb.toFixed(2)}GB) should be less than fp16 (${resultFp16.vramGb.toFixed(2)}GB)`);
});

test('quantization ordering: 4-bit < 8-bit < 16-bit', () => {
    const params = 7_000_000_000;
    const opts = { maxSequenceLength: 4096, batchSize: 1 };

    const vram4bit = estimateVram({ parameterCount: params, dtype: 'float16', quantization: 'bnb-4bit', ...opts }).vramGb;
    const vram8bit = estimateVram({ parameterCount: params, dtype: 'float16', quantization: 'bnb-8bit', ...opts }).vramGb;
    const vram16bit = estimateVram({ parameterCount: params, dtype: 'float16', ...opts }).vramGb;

    assert.ok(vram4bit < vram8bit, `4-bit (${vram4bit.toFixed(2)}) should be < 8-bit (${vram8bit.toFixed(2)})`);
    assert.ok(vram8bit < vram16bit, `8-bit (${vram8bit.toFixed(2)}) should be < 16-bit (${vram16bit.toFixed(2)})`);
});

// ── KV Cache Scaling ─────────────────────────────────────────────────────────

console.log('\nvram-estimator: KV cache scaling\n');

test('KV cache scales linearly with sequence length', () => {
    const params = 7_000_000_000;

    const kvCache4k = estimateKvCache(params, 4096, 1);
    const kvCache8k = estimateKvCache(params, 8192, 1);

    const ratio = kvCache8k / kvCache4k;
    assert.ok(Math.abs(ratio - 2.0) < 0.001,
        `Double seq length should double KV cache. Ratio: ${ratio.toFixed(4)}`);
});

test('KV cache scales linearly with batch size', () => {
    const params = 7_000_000_000;

    const kvBatch1 = estimateKvCache(params, 4096, 1);
    const kvBatch4 = estimateKvCache(params, 4096, 4);

    const ratio = kvBatch4 / kvBatch1;
    assert.ok(Math.abs(ratio - 4.0) < 0.001,
        `4x batch should give 4x KV cache. Ratio: ${ratio.toFixed(4)}`);
});

test('KV cache is non-negative for valid inputs', () => {
    const kv = estimateKvCache(7_000_000_000, 4096, 1);
    assert.ok(kv >= 0, `KV cache should be non-negative, got ${kv}`);
});

test('longer sequence length increases total VRAM estimate', () => {
    const params = 7_000_000_000;

    const result4k = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });

    const result16k = estimateVram({
        parameterCount: params,
        dtype: 'float16',
        maxSequenceLength: 16384,
        batchSize: 1
    });

    assert.ok(result16k.vramGb > result4k.vramGb,
        `16k seq (${result16k.vramGb.toFixed(2)}GB) should exceed 4k seq (${result4k.vramGb.toFixed(2)}GB)`);
});

// ── bytesPerParam: all dtype/quantization combinations ───────────────────────

console.log('\nvram-estimator: bytesPerParam lookup\n');

test('float32 → 4 bytes per param', () => {
    assert.strictEqual(bytesPerParam('float32', undefined), 4.0);
});

test('float16 → 2 bytes per param', () => {
    assert.strictEqual(bytesPerParam('float16', undefined), 2.0);
});

test('bfloat16 → 2 bytes per param', () => {
    assert.strictEqual(bytesPerParam('bfloat16', undefined), 2.0);
});

test('int8 → 1 byte per param', () => {
    assert.strictEqual(bytesPerParam('int8', undefined), 1.0);
});

test('int4 → 0.5 bytes per param', () => {
    assert.strictEqual(bytesPerParam('int4', undefined), 0.5);
});

test('awq quantization → 0.5 bytes per param', () => {
    assert.strictEqual(bytesPerParam('float16', 'awq'), 0.5);
});

test('gptq quantization → 0.5 bytes per param', () => {
    assert.strictEqual(bytesPerParam('float16', 'gptq'), 0.5);
});

test('bnb-4bit quantization → 0.5 bytes per param', () => {
    assert.strictEqual(bytesPerParam('float16', 'bnb-4bit'), 0.5);
});

test('bnb-8bit quantization → 1 byte per param', () => {
    assert.strictEqual(bytesPerParam('float16', 'bnb-8bit'), 1.0);
});

test('quantization takes precedence over dtype', () => {
    // Even with float32 dtype, awq quantization should give 0.5
    assert.strictEqual(bytesPerParam('float32', 'awq'), 0.5);
});

test('unknown dtype falls back to float16 (2 bytes)', () => {
    assert.strictEqual(bytesPerParam('unknown_dtype', undefined), 2.0);
});

// ── Confidence Levels ────────────────────────────────────────────────────────

console.log('\nvram-estimator: confidence levels\n');

test('high confidence when all params provided', () => {
    const confidence = determineConfidence({
        parameterCount: 7_000_000_000,
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.strictEqual(confidence, 'high');
});

test('medium confidence when some optional params missing', () => {
    const confidence = determineConfidence({
        parameterCount: 7_000_000_000,
        dtype: 'float16'
    });
    assert.strictEqual(confidence, 'medium');
});

test('low confidence when parameterCount missing', () => {
    const confidence = determineConfidence({
        dtype: 'float16',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.strictEqual(confidence, 'low');
});

test('low confidence when dtype missing', () => {
    const confidence = determineConfidence({
        parameterCount: 7_000_000_000,
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.strictEqual(confidence, 'low');
});

test('low confidence when dtype is unknown', () => {
    const confidence = determineConfidence({
        parameterCount: 7_000_000_000,
        dtype: 'unknown_type',
        maxSequenceLength: 4096,
        batchSize: 1
    });
    assert.strictEqual(confidence, 'low');
});

// ── Constants Validation ─────────────────────────────────────────────────────

console.log('\nvram-estimator: constants\n');

test('BYTES_IN_GB is 1024^3', () => {
    assert.strictEqual(BYTES_IN_GB, 1024 ** 3);
});

test('DEFAULT_MAX_SEQUENCE_LENGTH is 4096', () => {
    assert.strictEqual(DEFAULT_MAX_SEQUENCE_LENGTH, 4096);
});

test('DEFAULT_BATCH_SIZE is 1', () => {
    assert.strictEqual(DEFAULT_BATCH_SIZE, 1);
});

test('OVERHEAD_FACTOR is 0.1', () => {
    assert.strictEqual(OVERHEAD_FACTOR, 0.1);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
