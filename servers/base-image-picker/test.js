#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the base-image-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/base-image-picker/test.js
 */

import assert from 'node:assert'
import {
    TRANSFORMER_IMAGE_CATALOG,
    TRITON_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    StaticCatalogResolver,
    resolveBaseImage,
    mergeStaticAndDynamic,
    staticResolver,
    loadCatalog
} from './index.js'

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

async function asyncTest(name, fn) {
    try {
        await fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

console.log('\nbase-image-picker: catalog loading\n')

test('TRANSFORMER_IMAGE_CATALOG is a non-empty object', () => {
    assert.ok(typeof TRANSFORMER_IMAGE_CATALOG === 'object')
    assert.ok(Object.keys(TRANSFORMER_IMAGE_CATALOG).length > 0)
})

test('TRITON_IMAGE_CATALOG is a non-empty object', () => {
    assert.ok(typeof TRITON_IMAGE_CATALOG === 'object')
    assert.ok(Object.keys(TRITON_IMAGE_CATALOG).length > 0)
})

test('PYTHON_SLIM_CATALOG is a non-empty object', () => {
    assert.ok(typeof PYTHON_SLIM_CATALOG === 'object')
    assert.ok(Object.keys(PYTHON_SLIM_CATALOG).length > 0)
})

test('loadCatalog returns object for valid path', () => {
    const catalog = loadCatalog(new URL('./catalogs/model-servers.json', import.meta.url).pathname)
    assert.ok(typeof catalog === 'object')
    assert.ok(Object.keys(catalog).length > 0)
})

test('loadCatalog throws for invalid path', () => {
    assert.throws(() => loadCatalog('/nonexistent/path.json'), /Catalog file not found/)
})

console.log('\nbase-image-picker: StaticCatalogResolver\n')

test('staticResolver supports known frameworks', () => {
    const keys = staticResolver.supportedFrameworks()
    assert.ok(keys.includes('vllm'), 'should support vllm')
    assert.ok(keys.includes('python-slim'), 'should support python-slim')
})

test('staticResolver.fetchImages returns images for vllm', async () => {
    const result = await staticResolver.fetchImages('vllm', { limit: 5 })
    assert.ok(result.images.length > 0, 'should return at least one image')
    assert.ok(result.images[0].image, 'image entry should have image field')
})

test('staticResolver.fetchImages returns images for python-slim', async () => {
    const result = await staticResolver.fetchImages('python-slim', { limit: 5 })
    assert.ok(result.images.length > 0, 'should return at least one image')
})

console.log('\nbase-image-picker: mergeStaticAndDynamic\n')

test('static entries come first in merged result', () => {
    const staticImages = [{ image: 'static:1', created: '2024-01-01' }]
    const dynamicImages = [{ image: 'dynamic:1', created: '2024-06-01' }]
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages)
    assert.strictEqual(merged[0].image, 'static:1')
})

test('duplicates are removed (static wins)', () => {
    const staticImages = [{ image: 'shared:1', created: '2024-01-01' }]
    const dynamicImages = [{ image: 'shared:1', created: '2024-06-01' }]
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages)
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].created, '2024-01-01')
})

test('limit caps total results', () => {
    const staticImages = [{ image: 'a', created: '2024-01-01' }, { image: 'b', created: '2024-01-02' }]
    const dynamicImages = [{ image: 'c', created: '2024-06-01' }, { image: 'd', created: '2024-06-02' }]
    const merged = mergeStaticAndDynamic(staticImages, dynamicImages, 3)
    assert.strictEqual(merged.length, 3)
})

console.log('\nbase-image-picker: resolveBaseImage\n')

await asyncTest('resolveBaseImage returns images for transformers+vllm', async () => {
    const result = await resolveBaseImage({ framework: 'transformers', modelServer: 'vllm' }, 3)
    assert.ok(result.metadata?.baseImage?.length > 0, 'should return base images')
})

await asyncTest('resolveBaseImage returns images for python-slim (sklearn)', async () => {
    const result = await resolveBaseImage({ framework: 'sklearn' }, 3)
    assert.ok(result.metadata?.baseImage?.length > 0, 'should return base images')
})

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
