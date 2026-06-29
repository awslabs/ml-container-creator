#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the base-image-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/base-image-picker/test.js
 */

import assert from 'node:assert';
import {
    TRANSFORMER_IMAGE_CATALOG,
    TRITON_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    resolveBaseImage,
    mergeStaticAndDynamic,
    staticResolver,
    loadCatalog
} from './index.js';

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

async function asyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

console.log('\nbase-image-picker: catalog loading\n');

test('TRANSFORMER_IMAGE_CATALOG is a non-empty object', () => {
    assert.ok(typeof TRANSFORMER_IMAGE_CATALOG === 'object');
    assert.ok(Object.keys(TRANSFORMER_IMAGE_CATALOG).length > 0);
});

test('TRITON_IMAGE_CATALOG is a non-empty object', () => {
    assert.ok(typeof TRITON_IMAGE_CATALOG === 'object');
    assert.ok(Object.keys(TRITON_IMAGE_CATALOG).length > 0);
});

test('PYTHON_SLIM_CATALOG is a non-empty object', () => {
    assert.ok(typeof PYTHON_SLIM_CATALOG === 'object');
    assert.ok(Object.keys(PYTHON_SLIM_CATALOG).length > 0);
});

test('loadCatalog returns object for valid path', () => {
    const catalog = loadCatalog(new URL('../lib/catalogs/model-servers.json', import.meta.url).pathname);
    assert.ok(typeof catalog === 'object');
    assert.ok(Object.keys(catalog).length > 0);
});

test('loadCatalog throws for invalid path', () => {
    assert.throws(() => loadCatalog('/nonexistent/path.json'), /Catalog file not found/);
});

console.log('\nbase-image-picker: StaticCatalogResolver\n');

test('staticResolver supports known frameworks', () => {
    const keys = staticResolver.supportedFrameworks();
    assert.ok(keys.includes('vllm'), 'should support vllm');
    assert.ok(keys.includes('python-slim'), 'should support python-slim');
});

test('staticResolver.fetchImages returns images for vllm', async () => {
    const result = await staticResolver.fetchImages('vllm', { limit: 5 });
    assert.ok(result.images.length > 0, 'should return at least one image');
    assert.ok(result.images[0].image, 'image entry should have image field');
});

test('staticResolver.fetchImages returns images for python-slim', async () => {
    const result = await staticResolver.fetchImages('python-slim', { limit: 5 });
    assert.ok(result.images.length > 0, 'should return at least one image');
});

console.log('\nbase-image-picker: mergeStaticAndDynamic\n');

test('static entries come first in merged result', () => {
    const staticImages = [{ image: 'static:1', created: '2024-01-01' }];
    const dynamicImages = [{ image: 'dynamic:1', created: '2024-06-01' }];
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);
    assert.strictEqual(merged[0].image, 'static:1');
});

test('duplicates are removed (static wins)', () => {
    const staticImages = [{ image: 'shared:1', created: '2024-01-01' }];
    const dynamicImages = [{ image: 'shared:1', created: '2024-06-01' }];
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].created, '2024-01-01');
});

test('limit caps total results', () => {
    const staticImages = [{ image: 'a', created: '2024-01-01' }, { image: 'b', created: '2024-01-02' }];
    const dynamicImages = [{ image: 'c', created: '2024-06-01' }, { image: 'd', created: '2024-06-02' }];
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages, 3);
    assert.strictEqual(merged.length, 3);
});

console.log('\nbase-image-picker: resolveBaseImage\n');

await asyncTest('resolveBaseImage returns images for transformers+vllm', async () => {
    const result = await resolveBaseImage({ framework: 'transformers', modelServer: 'vllm' }, 3);
    assert.ok(result.metadata?.baseImage?.length > 0, 'should return base images');
});

await asyncTest('resolveBaseImage returns images for python-slim (sklearn)', async () => {
    const result = await resolveBaseImage({ framework: 'sklearn' }, 3);
    assert.ok(result.metadata?.baseImage?.length > 0, 'should return base images');
});

// ── Driver-Aware Filtering Integration Tests ─────────────────────────────────

console.log('\nbase-image-picker: driver-aware filtering\n');

await asyncTest('g5 + TP=4: excludes images requiring driver > 550', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.g5.24xlarge', tensorParallelSize: 4
    }, 10);
    // g5 fleet driver = 550.163 — images needing 560+ should be excluded
    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    assert.strictEqual(result.metadata.driverFilter.filtered, true);
    assert.strictEqual(result.metadata.driverFilter.instanceFamily, 'g5');
    assert.ok(result.metadata.driverFilter.excludedCount > 0, 'should exclude some images');
    // All returned images should have min_driver <= 550.163
    for (const img of result.metadata.baseImage) {
        if (img.min_driver_version) {
            const parts = img.min_driver_version.split('.').map(Number);
            assert.ok(parts[0] <= 550 || (parts[0] === 550 && parts[1] <= 163),
                `Image ${img.tag} requires driver ${img.min_driver_version} but fleet is 550.163`);
        }
    }
});

await asyncTest('p5 + TP=4: includes all images (driver 580 supports everything)', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge', tensorParallelSize: 4
    }, 10);
    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    assert.strictEqual(result.metadata.driverFilter.excludedCount, 0,
        'p5 (driver 580) should not exclude any images');
});

await asyncTest('no instanceType: no filtering (backward compat)', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm'
    }, 3);
    assert.ok(!result.metadata.driverFilter, 'should NOT include driverFilter when no instanceType');
    assert.strictEqual(result.choices.baseImage[0], 'vllm/vllm-openai:v0.23.0',
        'should return latest without filtering');
});

await asyncTest('driverVersion override: uses override instead of instance lookup', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        driverVersion: '999.0', tensorParallelSize: 4
    }, 10);
    assert.ok(result.metadata.driverFilter);
    assert.strictEqual(result.metadata.driverFilter.driverSource, 'override');
    assert.strictEqual(result.metadata.driverFilter.excludedCount, 0,
        'driver 999 should pass all images');
});

await asyncTest('g5 + TP=1 + incompatible: warning, not exclusion', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.g5.24xlarge', tensorParallelSize: 1
    }, 10);
    // TP=1 should allow CUDA compat — no exclusions, but warnings
    assert.strictEqual(result.metadata.driverFilter.excludedCount, 0,
        'TP=1 should not hard-exclude any images');
    const warned = result.metadata.baseImage.filter(img => img._warning);
    assert.ok(warned.length > 0, 'some images should have _warning for compat layer');
});

await asyncTest('modelArchitecture=Qwen3ForCausalLM: excludes vLLM < v0.20', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelArchitecture: 'Qwen3ForCausalLM'
    }, 10);
    assert.ok(result.metadata.driverFilter);
    assert.strictEqual(result.metadata.driverFilter.minFrameworkVersion, 'v0.20.0');
    assert.ok(result.metadata.driverFilter.exclusionReasons.model_support > 0,
        'should exclude images below v0.20 for Qwen3');
    // Verify no returned image is below v0.20
    for (const img of result.metadata.baseImage) {
        assert.ok(img.tag >= 'v0.20', `${img.tag} should be >= v0.20 for Qwen3`);
    }
});

await asyncTest('modelArchitecture=LlamaForCausalLM: no model-based exclusion', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelArchitecture: 'LlamaForCausalLM'
    }, 10);
    assert.ok(result.metadata.driverFilter);
    assert.strictEqual(result.metadata.driverFilter.exclusionReasons.model_support, 0,
        'Llama supported since v0.4 — no exclusions');
});

await asyncTest('expanded catalog: returns exactly limit after filtering', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge'
    }, 3);
    assert.strictEqual(result.choices.baseImage.length, 3,
        'should return exactly 3 after filtering');
});

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
