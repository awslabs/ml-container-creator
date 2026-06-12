#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verification tests for p6-b200 instance recommendation.
 * Validates that the instance-ranker recommends ml.p6-b200.48xlarge for
 * models requiring >96GB VRAM (>8B params at FP16, needing multi-GPU).
 *
 * Validates: Requirements FTP-1 (1.1, 1.3)
 *
 * Run: node servers/instance-sizer/test/p6-b200-recommendation.test.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    filterAndRankInstances,
    GENERATION_WEIGHT,
    COST_TIER_MAP
} from '../lib/instance-ranker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load real instance catalog
const catalogPath = resolve(__dirname, '../../lib/catalogs/instances.json');
const raw = readFileSync(catalogPath, 'utf8');
const { catalog: INSTANCE_CATALOG } = JSON.parse(raw);

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

// ── GENERATION_WEIGHT includes p6 ───────────────────────────────────────────

console.log('\np6-b200 recommendation: GENERATION_WEIGHT map\n');

test('GENERATION_WEIGHT includes p6 family with weight 1 (newest generation)', () => {
    assert.ok('p6' in GENERATION_WEIGHT, 'GENERATION_WEIGHT should include p6 family');
    assert.strictEqual(GENERATION_WEIGHT['p6'], 1,
        `GENERATION_WEIGHT['p6'] should be 1 (newest), got: ${GENERATION_WEIGHT['p6']}`);
});

test('COST_TIER_MAP classifies p6 as high cost tier', () => {
    assert.ok('p6' in COST_TIER_MAP, 'COST_TIER_MAP should include p6 family');
    assert.strictEqual(COST_TIER_MAP['p6'], 'high',
        `COST_TIER_MAP['p6'] should be 'high', got: ${COST_TIER_MAP['p6']}`);
});

// ── Instance catalog has p6-b200 entry ──────────────────────────────────────

console.log('\np6-b200 recommendation: catalog entry\n');

test('instance catalog contains ml.p6-b200.48xlarge', () => {
    assert.ok('ml.p6-b200.48xlarge' in INSTANCE_CATALOG,
        'Instance catalog should contain ml.p6-b200.48xlarge');
});

test('ml.p6-b200.48xlarge has correct GPU metadata', () => {
    const entry = INSTANCE_CATALOG['ml.p6-b200.48xlarge'];
    assert.strictEqual(entry.gpus, 8, `gpus should be 8, got: ${entry.gpus}`);
    assert.strictEqual(entry.gpuMemoryGb, 192, `gpuMemoryGb should be 192, got: ${entry.gpuMemoryGb}`);
    assert.strictEqual(entry.family, 'p6', `family should be 'p6', got: ${entry.family}`);
    assert.strictEqual(entry.category, 'gpu', `category should be 'gpu', got: ${entry.category}`);
});

// ── Recommendation for >96GB VRAM models ────────────────────────────────────

console.log('\np6-b200 recommendation: models requiring >96GB VRAM\n');

test('100GB VRAM model includes ml.p6-b200.48xlarge in recommendations', () => {
    // 100GB exceeds any single-GPU option (max 24GB in g5 family) and
    // exceeds g5.12xlarge effective (4×24GB - overhead ≈ 88.8GB)
    // p6-b200 has 8×192GB = 1536GB total, effective ≈ 1401.6GB — easily fits
    const results = filterAndRankInstances(100, INSTANCE_CATALOG);
    const types = results.map(r => r.instanceType);
    assert.ok(types.includes('ml.p6-b200.48xlarge'),
        `ml.p6-b200.48xlarge should be in recommendations for 100GB model, got: ${types.join(', ')}`);
});

test('200GB VRAM model includes ml.p6-b200.48xlarge in recommendations', () => {
    // 200GB exceeds g5.48xlarge effective (8×24GB - overhead ≈ 175.2GB)
    // Only p6-b200 can fit this (effective ≈ 1401.6GB)
    const results = filterAndRankInstances(200, INSTANCE_CATALOG);
    const types = results.map(r => r.instanceType);
    assert.ok(types.includes('ml.p6-b200.48xlarge'),
        `ml.p6-b200.48xlarge should be in recommendations for 200GB model, got: ${types.join(', ')}`);
});

test('200GB VRAM model — p6-b200 is the ONLY recommendation (nothing else fits)', () => {
    // g5.48xlarge effective = 175.2GB < 200GB, so only p6-b200 fits
    const results = filterAndRankInstances(200, INSTANCE_CATALOG);
    assert.strictEqual(results.length, 1,
        `Only p6-b200 should fit 200GB model, got ${results.length} results: ${results.map(r => r.instanceType).join(', ')}`);
    assert.strictEqual(results[0].instanceType, 'ml.p6-b200.48xlarge');
});

test('p6-b200 recommendation has TP=8 for multi-GPU model', () => {
    const results = filterAndRankInstances(200, INSTANCE_CATALOG);
    const p6 = results.find(r => r.instanceType === 'ml.p6-b200.48xlarge');
    assert.ok(p6, 'p6-b200 should be in results');
    assert.strictEqual(p6.tensorParallelism, 8,
        `TP should be 8 for p6-b200, got: ${p6.tensorParallelism}`);
    assert.strictEqual(p6.gpuCount, 8,
        `gpuCount should be 8, got: ${p6.gpuCount}`);
});

test('p6-b200 total VRAM is 1536GB (8 × 192GB)', () => {
    const results = filterAndRankInstances(200, INSTANCE_CATALOG);
    const p6 = results.find(r => r.instanceType === 'ml.p6-b200.48xlarge');
    assert.ok(p6, 'p6-b200 should be in results');
    assert.strictEqual(p6.totalVramGb, 1536,
        `totalVramGb should be 1536 (8×192), got: ${p6.totalVramGb}`);
});

test('p6-b200 costTier is high', () => {
    const results = filterAndRankInstances(200, INSTANCE_CATALOG);
    const p6 = results.find(r => r.instanceType === 'ml.p6-b200.48xlarge');
    assert.ok(p6, 'p6-b200 should be in results');
    assert.strictEqual(p6.costTier, 'high',
        `costTier should be 'high', got: ${p6.costTier}`);
});

// ── Ranking: p6 as newest generation ────────────────────────────────────────

console.log('\np6-b200 recommendation: ranking priority\n');

test('for 100GB model, p6-b200 ranks before g5.48xlarge (newer generation)', () => {
    // Both p6-b200 and g5.48xlarge can fit 100GB
    // p6 has GENERATION_WEIGHT 1, g5 has GENERATION_WEIGHT 4
    // However, g5.48xlarge has lower total VRAM (192GB vs 1536GB) — but generation wins first
    // Actually: both have TP=8, so TP is tied. Then generation: p6 (1) < g5 (4), so p6 ranks first
    const results = filterAndRankInstances(100, INSTANCE_CATALOG);
    const p6Idx = results.findIndex(r => r.instanceType === 'ml.p6-b200.48xlarge');
    const g5_48Idx = results.findIndex(r => r.instanceType === 'ml.g5.48xlarge');
    assert.ok(p6Idx !== -1, 'p6-b200 should be in results');
    assert.ok(g5_48Idx !== -1, 'g5.48xlarge should be in results');
    assert.ok(p6Idx < g5_48Idx,
        `p6-b200 (idx ${p6Idx}) should rank before g5.48xlarge (idx ${g5_48Idx}) due to newer generation`);
});

// ── Customer scenario: 31B model at FP16 ───────────────────────────────────

console.log('\np6-b200 recommendation: customer scenario (Gemma 4 31B)\n');

test('62GB VRAM (31B params at FP16) includes p6-b200 in recommendations', () => {
    // 31B params × 2 bytes/param = 62GB model weights
    // With overhead (KV cache, activations), needs multi-GPU
    // Both g5.12xlarge (effective 88.8GB) and p6-b200 (effective 1401.6GB) can fit
    const results = filterAndRankInstances(62, INSTANCE_CATALOG);
    const types = results.map(r => r.instanceType);
    assert.ok(types.includes('ml.p6-b200.48xlarge'),
        `p6-b200 should be in recommendations for 62GB (31B FP16) model, got: ${types.join(', ')}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
