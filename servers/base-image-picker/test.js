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
import {
    parseCudaVersionFromTag,
    deriveDriverFromCuda,
    deriveMinDriverVersion,
    filterImages
} from '../lib/image-filter.js';
import {
    resolveModelArchitecture,
    clearModelArchitectureCache
} from '../lib/model-id-resolver.js';

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

await asyncTest('expanded catalog (≥8 vLLM entries): filtering returns ≥3 compatible for p5', async () => {
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge'
    }, 5);
    // p5 has driver 580.95 — compatible with ALL images in the catalog
    // With ≥8 vLLM entries and no exclusions, we should get the full limit of 5
    assert.ok(result.metadata.baseImage.length >= 3,
        `expected ≥3 compatible images for p5, got ${result.metadata.baseImage.length}`);
    assert.strictEqual(result.metadata.driverFilter.excludedCount, 0,
        'p5 (driver 580.95) should not exclude any images');
    assert.strictEqual(result.choices.baseImage.length, 5,
        'should return full limit of 5 since p5 is compatible with everything');
});

// ── modelId → architecture resolution integration tests ──────────────────────

console.log('\nbase-image-picker: modelId resolution integration\n');

await asyncTest('modelId resolves to architecture and excludes incompatible images', async () => {
    // Pre-populate the cache with Qwen3 architecture for a known model
    clearModelArchitectureCache();
    const mockFetch = async (_url) => ({
        ok: true,
        status: 200,
        json: async () => ({ architectures: ['Qwen3ForCausalLM'], model_type: 'qwen3' })
    });
    await resolveModelArchitecture('Qwen/Qwen3-8B', { fetchFn: mockFetch });

    // Now call resolveBaseImage with modelId — should use cached architecture
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelId: 'Qwen/Qwen3-8B'
    }, 10);

    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    assert.strictEqual(result.metadata.driverFilter.modelArchitecture, 'Qwen3ForCausalLM',
        'should resolve modelId to Qwen3ForCausalLM');
    assert.strictEqual(result.metadata.driverFilter.minFrameworkVersion, 'v0.20.0',
        'Qwen3 requires vLLM >= v0.20.0');
    assert.ok(result.metadata.driverFilter.exclusionReasons.model_support > 0,
        'should exclude vLLM versions older than v0.20.0');
    // Verify no returned image is below v0.20
    for (const img of result.metadata.baseImage) {
        assert.ok(img.tag >= 'v0.20', `${img.tag} should be >= v0.20 for Qwen3`);
    }
    clearModelArchitectureCache();
});

await asyncTest('unknown/unreachable modelId → graceful fallback (no model filtering)', async () => {
    // Pre-populate cache with null for a failing model (simulates network failure / 404)
    clearModelArchitectureCache();
    const mockFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    await resolveModelArchitecture('nonexistent/unknown-model-xyz', { fetchFn: mockFetch });

    // Call resolveBaseImage with the same modelId — should get null from cache, skip model filtering
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelId: 'nonexistent/unknown-model-xyz'
    }, 10);

    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    // No model architecture should be resolved
    assert.strictEqual(result.metadata.driverFilter.modelArchitecture, null,
        'unresolvable modelId should result in null architecture');
    // No model_support exclusions
    assert.strictEqual(result.metadata.driverFilter.exclusionReasons.model_support, 0,
        'should not exclude any images when model is unknown');
    clearModelArchitectureCache();
});

await asyncTest('modelArchitecture provided directly → skips HF lookup', async () => {
    // Pre-populate cache with a WRONG architecture to prove HF is not consulted
    clearModelArchitectureCache();
    const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ architectures: ['WRONG_ShouldNotBeUsed'] })
    });
    await resolveModelArchitecture('Qwen/Qwen3-8B', { fetchFn: mockFetch });

    // Pass both modelId AND modelArchitecture — the explicit modelArchitecture should win
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelId: 'Qwen/Qwen3-8B',
        modelArchitecture: 'LlamaForCausalLM'
    }, 10);

    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    // Should use the directly provided architecture, NOT the cached/fetched one
    assert.strictEqual(result.metadata.driverFilter.modelArchitecture, 'LlamaForCausalLM',
        'should use directly provided modelArchitecture, not HF-resolved one');
    // Llama is supported since v0.4 — no model exclusions
    assert.strictEqual(result.metadata.driverFilter.exclusionReasons.model_support, 0,
        'LlamaForCausalLM supported since v0.4 — no model exclusions');
    clearModelArchitectureCache();
});

// ── CUDA→Driver Derivation Tests ─────────────────────────────────────────────

console.log('\nbase-image-picker: CUDA→driver derivation for dynamic entries\n');

test('parseCudaVersionFromTag: -cu124 → 12.4', () => {
    assert.strictEqual(parseCudaVersionFromTag('v0.6.6.post8-cu124'), 12.4);
});

test('parseCudaVersionFromTag: -cu121 → 12.1', () => {
    assert.strictEqual(parseCudaVersionFromTag('v0.5.0-cu121'), 12.1);
});

test('parseCudaVersionFromTag: -cu128 → 12.8', () => {
    assert.strictEqual(parseCudaVersionFromTag('v0.8.0-cu128'), 12.8);
});

test('parseCudaVersionFromTag: -cuda12.4 → 12.4', () => {
    assert.strictEqual(parseCudaVersionFromTag('0.36.0-cuda12.4-pytorch'), 12.4);
});

test('parseCudaVersionFromTag: no CUDA suffix → null', () => {
    assert.strictEqual(parseCudaVersionFromTag('v0.23.0'), null);
});

test('parseCudaVersionFromTag: null/empty → null', () => {
    assert.strictEqual(parseCudaVersionFromTag(null), null);
    assert.strictEqual(parseCudaVersionFromTag(''), null);
});

test('deriveDriverFromCuda: 12.9 → 580.0', () => {
    assert.strictEqual(deriveDriverFromCuda(12.9), '580.0');
});

test('deriveDriverFromCuda: 12.8 → 570.86', () => {
    assert.strictEqual(deriveDriverFromCuda(12.8), '570.86');
});

test('deriveDriverFromCuda: 12.7 → 570.86', () => {
    assert.strictEqual(deriveDriverFromCuda(12.7), '570.86');
});

test('deriveDriverFromCuda: 12.5 → 555.42', () => {
    assert.strictEqual(deriveDriverFromCuda(12.5), '555.42');
});

test('deriveDriverFromCuda: 12.4 → 550.54', () => {
    assert.strictEqual(deriveDriverFromCuda(12.4), '550.54');
});

test('deriveDriverFromCuda: 12.2 → 535.54', () => {
    assert.strictEqual(deriveDriverFromCuda(12.2), '535.54');
});

test('deriveDriverFromCuda: 12.0 → 525.60', () => {
    assert.strictEqual(deriveDriverFromCuda(12.0), '525.60');
});

test('deriveDriverFromCuda: 11.8 → null (below supported range)', () => {
    assert.strictEqual(deriveDriverFromCuda(11.8), null);
});

test('deriveMinDriverVersion: entry with labels.cuda_version', () => {
    const entry = { tag: 'v0.23.0', labels: { cuda_version: '12.9' } };
    assert.strictEqual(deriveMinDriverVersion(entry), '580.0');
});

test('deriveMinDriverVersion: entry with -cu124 tag', () => {
    const entry = { tag: 'v0.6.6.post8-cu124', labels: {} };
    assert.strictEqual(deriveMinDriverVersion(entry), '550.54');
});

test('deriveMinDriverVersion: entry with no CUDA info → null (conservative)', () => {
    const entry = { tag: 'v0.23.0', labels: {} };
    assert.strictEqual(deriveMinDriverVersion(entry), null);
});

test('deriveMinDriverVersion: null entry → null', () => {
    assert.strictEqual(deriveMinDriverVersion(null), null);
});

// ── DynamicResolver Merge Path + Filtering ───────────────────────────────────

console.log('\nbase-image-picker: DynamicResolver merge path applies filtering\n');

test('DynamicResolver merge path: filterImages excludes incompatible dynamic entries', () => {
    // Simulate static catalog entries (compatible with g5 driver 550)
    const staticImages = [
        { image: 'vllm/vllm-openai:v0.22.1', tag: 'v0.22.1', min_driver_version: '550.54', created: '2024-06-01' },
        { image: 'vllm/vllm-openai:v0.21.0', tag: 'v0.21.0', min_driver_version: '550.54', created: '2024-05-01' }
    ];

    // Simulate dynamic entries from Docker Hub with CUDA tags
    // -cu128 → CUDA 12.8 → min_driver 570.86 (INCOMPATIBLE with g5 driver 550)
    // -cu124 → CUDA 12.4 → min_driver 550.54 (COMPATIBLE with g5 driver 550)
    const dynamicImages = [
        {
            image: 'vllm/vllm-openai:v0.24.0-cu128',
            tag: 'v0.24.0-cu128',
            min_driver_version: deriveMinDriverVersion({ tag: 'v0.24.0-cu128', labels: {} }),
            created: '2024-07-01',
            labels: {},
            registry: 'dockerhub'
        },
        {
            image: 'vllm/vllm-openai:v0.24.0-cu124',
            tag: 'v0.24.0-cu124',
            min_driver_version: deriveMinDriverVersion({ tag: 'v0.24.0-cu124', labels: {} }),
            created: '2024-07-01',
            labels: {},
            registry: 'dockerhub'
        }
    ];

    // Verify derived min_driver_version values
    assert.strictEqual(dynamicImages[0].min_driver_version, '570.86', 'cu128 should derive to 570.86');
    assert.strictEqual(dynamicImages[1].min_driver_version, '550.54', 'cu124 should derive to 550.54');

    // Merge static + dynamic (simulating the discover mode path)
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);
    assert.strictEqual(merged.length, 4, 'merged should have 4 entries (2 static + 2 dynamic)');

    // Apply filterImages (g5 instance, TP=4 → strict filtering)
    const filterResult = filterImages(merged, {
        framework: 'vllm',
        instanceType: 'ml.g5.24xlarge',
        tensorParallelSize: 4
    });

    // The cu128 entry (min_driver 570.86) should be excluded for g5 (driver 550.163)
    const remainingImages = filterResult.images.map(img => img.image);
    assert.ok(!remainingImages.includes('vllm/vllm-openai:v0.24.0-cu128'),
        'cu128 dynamic entry should be excluded for g5 (driver 550 < 570.86)');

    // The cu124 entry (min_driver 550.54) should pass for g5 (driver 550.163 >= 550.54)
    assert.ok(remainingImages.includes('vllm/vllm-openai:v0.24.0-cu124'),
        'cu124 dynamic entry should pass for g5 (driver 550.163 >= 550.54)');

    // Static entries with min_driver 550.54 should also pass
    assert.ok(remainingImages.includes('vllm/vllm-openai:v0.22.1'),
        'static entry v0.22.1 should pass (min_driver 550.54 <= fleet 550.163)');
    assert.ok(remainingImages.includes('vllm/vllm-openai:v0.21.0'),
        'static entry v0.21.0 should pass (min_driver 550.54 <= fleet 550.163)');

    // Metadata should reflect the exclusion
    assert.strictEqual(filterResult.metadata.filtered, true);
    assert.strictEqual(filterResult.metadata.excludedCount, 1, 'should exclude exactly 1 entry (cu128)');
    assert.strictEqual(filterResult.metadata.exclusionReasons.driver_compat, 1);
});

test('DynamicResolver merge path: TP=1 warns but does not exclude incompatible dynamic entries', () => {
    const staticImages = [
        { image: 'vllm/vllm-openai:v0.22.1', tag: 'v0.22.1', min_driver_version: '550.54', created: '2024-06-01' }
    ];
    const dynamicImages = [
        {
            image: 'vllm/vllm-openai:v0.24.0-cu128',
            tag: 'v0.24.0-cu128',
            min_driver_version: '570.86',
            created: '2024-07-01',
            labels: {},
            registry: 'dockerhub'
        }
    ];

    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);
    const filterResult = filterImages(merged, {
        framework: 'vllm',
        instanceType: 'ml.g5.24xlarge',
        tensorParallelSize: 1
    });

    // With TP=1, incompatible entries should pass with a warning (not excluded)
    assert.strictEqual(filterResult.metadata.excludedCount, 0,
        'TP=1 should not exclude any entries');
    const cu128Entry = filterResult.images.find(img => img.image === 'vllm/vllm-openai:v0.24.0-cu128');
    assert.ok(cu128Entry, 'cu128 entry should be included with TP=1');
    assert.ok(cu128Entry._warning, 'cu128 entry should have a warning annotation');
});

// ── modelId Resolution Integration Tests ─────────────────────────────────────

console.log('\nbase-image-picker: modelId resolution → exclusion\n');

await asyncTest('modelId resolution: resolves architecture and excludes incompatible versions', async () => {
    // Pre-populate the cache with a mock resolution (avoids network call to HuggingFace)
    clearModelArchitectureCache();
    const mockFetch = async () => ({
        ok: true,
        json: async () => ({ architectures: ['Qwen3ForCausalLM'] })
    });
    // Seed the cache via the resolver with our mock fetch
    const arch = await resolveModelArchitecture('Qwen/Qwen3-8B', { fetchFn: mockFetch });
    assert.strictEqual(arch, 'Qwen3ForCausalLM', 'should resolve to Qwen3ForCausalLM');

    // Now call resolveBaseImage with modelId — it will hit the cache
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelId: 'Qwen/Qwen3-8B'
    }, 10);

    // Verify filtering was applied based on the resolved architecture
    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    assert.strictEqual(result.metadata.driverFilter.minFrameworkVersion, 'v0.20.0',
        'Qwen3ForCausalLM requires vLLM >= v0.20.0');
    assert.ok(result.metadata.driverFilter.exclusionReasons.model_support > 0,
        'should exclude vLLM versions below v0.20 for Qwen3');
    // Verify no returned image has a tag below v0.20
    for (const img of result.metadata.baseImage) {
        assert.ok(img.tag >= 'v0.20', `${img.tag} should be >= v0.20 for Qwen3`);
    }
});

await asyncTest('modelId resolution: unknown modelId → no model-based filtering (graceful fallback)', async () => {
    // Pre-populate the cache with null for an unknown model (simulates HF 404)
    clearModelArchitectureCache();
    const mockFetch = async () => ({ ok: false, status: 404 });
    await resolveModelArchitecture('nonexistent/model-xyz', { fetchFn: mockFetch });

    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelId: 'nonexistent/model-xyz'
    }, 10);

    // When architecture can't be resolved, no model-based exclusion should occur
    assert.ok(result.metadata.driverFilter, 'should include driverFilter metadata');
    assert.strictEqual(result.metadata.driverFilter.exclusionReasons.model_support, 0,
        'unknown model should not trigger model-based exclusion');
});

await asyncTest('modelId resolution: modelArchitecture provided directly skips modelId lookup', async () => {
    // If both modelArchitecture and modelId are provided, modelArchitecture takes priority
    clearModelArchitectureCache();
    const result = await resolveBaseImage({
        framework: 'transformers', modelServer: 'vllm',
        instanceType: 'ml.p5.48xlarge',
        modelArchitecture: 'Qwen3ForCausalLM',
        modelId: 'some/other-model'
    }, 10);

    // modelArchitecture is used directly — Qwen3 exclusion should apply
    assert.ok(result.metadata.driverFilter);
    assert.strictEqual(result.metadata.driverFilter.minFrameworkVersion, 'v0.20.0');
    assert.ok(result.metadata.driverFilter.exclusionReasons.model_support > 0,
        'should exclude based on provided modelArchitecture');
});

// ── transformers_version field validation (NFR-5) ────────────────────────────

console.log('\nbase-image-picker: transformers_version field present in catalog entries\n');

test('all vLLM entries have transformers_version as a non-empty version string', () => {
    const versionPattern = /^\d+\.\d+\.\d+$/;
    const entries = TRANSFORMER_IMAGE_CATALOG.vllm;
    assert.ok(entries && entries.length > 0, 'vllm should have entries');
    for (const entry of entries) {
        assert.ok(entry.transformers_version,
            `vLLM entry ${entry.tag} is missing transformers_version`);
        assert.ok(typeof entry.transformers_version === 'string' && entry.transformers_version.length > 0,
            `vLLM entry ${entry.tag} transformers_version should be a non-empty string`);
        assert.ok(versionPattern.test(entry.transformers_version),
            `vLLM entry ${entry.tag} transformers_version "${entry.transformers_version}" should match pattern X.Y.Z`);
    }
});

test('all SGLang entries have transformers_version as a non-empty version string', () => {
    const versionPattern = /^\d+\.\d+\.\d+$/;
    const entries = TRANSFORMER_IMAGE_CATALOG.sglang;
    assert.ok(entries && entries.length > 0, 'sglang should have entries');
    for (const entry of entries) {
        assert.ok(entry.transformers_version,
            `SGLang entry ${entry.tag} is missing transformers_version`);
        assert.ok(typeof entry.transformers_version === 'string' && entry.transformers_version.length > 0,
            `SGLang entry ${entry.tag} transformers_version should be a non-empty string`);
        assert.ok(versionPattern.test(entry.transformers_version),
            `SGLang entry ${entry.tag} transformers_version "${entry.transformers_version}" should match pattern X.Y.Z`);
    }
});

test('all DJL entries have transformers_version as a non-empty version string', () => {
    const versionPattern = /^\d+\.\d+\.\d+$/;
    const entries = TRANSFORMER_IMAGE_CATALOG.djl;
    assert.ok(entries && entries.length > 0, 'djl should have entries');
    for (const entry of entries) {
        assert.ok(entry.transformers_version,
            `DJL entry ${entry.tag} is missing transformers_version`);
        assert.ok(typeof entry.transformers_version === 'string' && entry.transformers_version.length > 0,
            `DJL entry ${entry.tag} transformers_version should be a non-empty string`);
        assert.ok(versionPattern.test(entry.transformers_version),
            `DJL entry ${entry.tag} transformers_version "${entry.transformers_version}" should match pattern X.Y.Z`);
    }
});

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
