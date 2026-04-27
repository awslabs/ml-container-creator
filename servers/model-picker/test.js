#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the model-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/model-picker/test.js
 */

import assert from 'node:assert'
import {
    POPULAR_MODELS_CATALOG,
    StaticCatalogResolver,
    resolveModel,
    mergeMetadata,
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

console.log('\nmodel-picker: catalog loading\n')

test('POPULAR_MODELS_CATALOG is a non-empty object', () => {
    assert.ok(typeof POPULAR_MODELS_CATALOG === 'object')
    assert.ok(Object.keys(POPULAR_MODELS_CATALOG).length > 0)
})

test('loadCatalog returns object for valid path', () => {
    const catalog = loadCatalog(new URL('./catalogs/popular-transformers.json', import.meta.url).pathname)
    assert.ok(typeof catalog === 'object')
    assert.ok(Object.keys(catalog).length > 0)
})

test('loadCatalog throws for invalid path', () => {
    assert.throws(() => loadCatalog('/nonexistent/path.json'), /Catalog file not found/)
})

console.log('\nmodel-picker: StaticCatalogResolver\n')

test('staticResolver supports known keys', () => {
    const keys = staticResolver.supportedKeys()
    assert.ok(keys.length > 0, 'should support at least one key')
})

test('catalog contains expected model families', () => {
    const modelIds = Object.keys(POPULAR_MODELS_CATALOG)
    const hasLlama = modelIds.some(id => id.includes('Llama') || id.includes('llama'))
    const hasMistral = modelIds.some(id => id.includes('Mistral') || id.includes('mistral'))
    assert.ok(hasLlama || hasMistral, 'catalog should contain Llama or Mistral models')
})

test('catalog entries have required fields', () => {
    for (const [modelId, entry] of Object.entries(POPULAR_MODELS_CATALOG)) {
        assert.ok(entry.family !== undefined, `${modelId} should have family field`)
    }
})

console.log('\nmodel-picker: mergeMetadata\n')

test('live data takes precedence over catalog for non-null fields', () => {
    const hfData = { family: 'hf-family', tags: ['text-generation'] }
    const catalogData = { family: 'catalog-family', validation_level: 'tested' }
    const merged = mergeMetadata(hfData, catalogData)
    assert.strictEqual(merged.family, 'hf-family')
    assert.strictEqual(merged.validation_level, 'tested')
    assert.deepStrictEqual(merged.tags, ['text-generation'])
})

test('mergeMetadata handles null inputs', () => {
    const result = mergeMetadata(null, null)
    assert.ok(typeof result === 'object')
})

test('mergeMetadata with only HF data', () => {
    const hfData = { family: 'llama', tags: ['text-generation'] }
    const merged = mergeMetadata(hfData, null)
    assert.strictEqual(merged.family, 'llama')
})

test('mergeMetadata with only catalog data', () => {
    const catalogData = { family: 'llama', validation_level: 'tested' }
    const merged = mergeMetadata(null, catalogData)
    assert.strictEqual(merged.family, 'llama')
    assert.strictEqual(merged.validation_level, 'tested')
})

console.log('\nmodel-picker: resolveModel\n')

await asyncTest('resolveModel returns data for known model', async () => {
    const knownModel = Object.keys(POPULAR_MODELS_CATALOG).find(id => !id.includes('*'))
    if (!knownModel) return // skip if no non-glob models
    const result = await resolveModel({ model_id: knownModel, mode: 'static' })
    assert.ok(result.content, 'should have content')
    const parsed = JSON.parse(result.content[0].text)
    assert.ok(parsed.values, 'should have values')
    assert.ok(Object.keys(parsed.values).length > 0, 'values should not be empty for known model')
})

await asyncTest('resolveModel returns message for unknown model', async () => {
    const result = await resolveModel({ model_id: 'nonexistent/model-xyz-999', mode: 'static' })
    assert.ok(result.content, 'should have content')
    const parsed = JSON.parse(result.content[0].text)
    assert.ok(parsed.message, 'should have a message for unknown model')
})

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
