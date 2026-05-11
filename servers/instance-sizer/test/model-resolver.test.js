#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the model metadata resolver.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/model-resolver.test.js
 */

import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
    resolveModelMetadata,
    globMatch,
    loadCatalog,
    catalogLookup,
    estimateParamsFromConfig,
    extractFromHuggingFaceConfig,
    DEFAULT_CATALOG_PATH
} from '../lib/model-resolver.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CATALOG_PATH = join(__dirname, '..', 'catalogs', 'model-sizes.json')

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        const result = fn()
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                passed++
                console.log(`  ✓ ${name}`)
            }).catch((err) => {
                failed++
                console.error(`  ✗ ${name}`)
                console.error(`    ${err.message}`)
            })
        }
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

async function run() {
    // ── Glob Pattern Matching ────────────────────────────────────────────────

    console.log('\nmodel-resolver: glob pattern matching\n')

    test('exact match without wildcards', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-2-7b', 'meta-llama/Llama-2-7b'), true)
    })

    test('wildcard matches any suffix', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-2-7b*', 'meta-llama/Llama-2-7b-chat-hf'), true)
    })

    test('wildcard matches empty string', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-2-7b*', 'meta-llama/Llama-2-7b'), true)
    })

    test('case-insensitive matching', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-2-7b*', 'meta-llama/llama-2-7b-chat-hf'), true)
    })

    test('non-matching pattern returns false', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-2-7b*', 'meta-llama/Llama-2-13b-chat-hf'), false)
    })

    test('wildcard in middle of pattern', () => {
        assert.strictEqual(globMatch('meta-llama/*-7b*', 'meta-llama/Llama-2-7b-chat'), true)
    })

    test('special regex characters in pattern are escaped', () => {
        assert.strictEqual(globMatch('model.name+v1*', 'model.name+v1.0'), true)
        assert.strictEqual(globMatch('model.name+v1*', 'modelXname+v1.0'), false)
    })

    // ── Catalog Loading ──────────────────────────────────────────────────────

    console.log('\nmodel-resolver: catalog loading\n')

    await test('loads catalog from default path', async () => {
        const catalog = await loadCatalog(CATALOG_PATH)
        assert.ok(catalog !== null, 'catalog should not be null')
        assert.ok(catalog.models, 'catalog should have models')
        assert.strictEqual(catalog.catalogVersion, '1.0.0')
    })

    await test('returns null for non-existent catalog path', async () => {
        const catalog = await loadCatalog('/non/existent/path.json')
        assert.strictEqual(catalog, null)
    })

    // ── Catalog Lookup ───────────────────────────────────────────────────────

    console.log('\nmodel-resolver: catalog lookup\n')

    await test('finds Llama-2-7b by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH)
        const entry = catalogLookup('meta-llama/Llama-2-7b-chat-hf', catalog)
        assert.ok(entry !== null, 'should find entry')
        assert.strictEqual(entry.parameterCount, 6738415616)
        assert.strictEqual(entry.defaultDtype, 'float16')
        assert.strictEqual(entry.architecture, 'LlamaForCausalLM')
    })

    await test('finds Llama-2-70b by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH)
        const entry = catalogLookup('meta-llama/Llama-2-70b-chat-hf', catalog)
        assert.ok(entry !== null, 'should find entry')
        assert.strictEqual(entry.parameterCount, 68976648192)
    })

    await test('finds Mistral-7B by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH)
        const entry = catalogLookup('mistralai/Mistral-7B-Instruct-v0.2', catalog)
        assert.ok(entry !== null, 'should find entry')
        assert.strictEqual(entry.parameterCount, 7241732096)
    })

    await test('returns null for unknown model', async () => {
        const catalog = await loadCatalog(CATALOG_PATH)
        const entry = catalogLookup('unknown-org/unknown-model', catalog)
        assert.strictEqual(entry, null)
    })

    await test('returns null when catalog is null', () => {
        const entry = catalogLookup('meta-llama/Llama-2-7b-chat-hf', null)
        assert.strictEqual(entry, null)
    })

    await test('returns null when catalog has no models field', () => {
        const entry = catalogLookup('meta-llama/Llama-2-7b-chat-hf', {})
        assert.strictEqual(entry, null)
    })

    // ── Parameter Estimation ─────────────────────────────────────────────────

    console.log('\nmodel-resolver: parameter estimation from config\n')

    test('estimates params from hidden_size × num_hidden_layers × 12', () => {
        const config = {
            hidden_size: 4096,
            num_hidden_layers: 32
        }
        const estimated = estimateParamsFromConfig(config)
        assert.strictEqual(estimated, 4096 * 32 * 12)
    })

    test('returns null when hidden_size is missing', () => {
        const config = { num_hidden_layers: 32 }
        const estimated = estimateParamsFromConfig(config)
        assert.strictEqual(estimated, null)
    })

    test('returns null when num_hidden_layers is missing', () => {
        const config = { hidden_size: 4096 }
        const estimated = estimateParamsFromConfig(config)
        assert.strictEqual(estimated, null)
    })

    test('returns null for empty config', () => {
        const estimated = estimateParamsFromConfig({})
        assert.strictEqual(estimated, null)
    })

    // ── HuggingFace Config Extraction ────────────────────────────────────────

    console.log('\nmodel-resolver: HuggingFace config extraction\n')

    test('extracts all fields from complete config', () => {
        const config = {
            num_parameters: 7_000_000_000,
            torch_dtype: 'bfloat16',
            architectures: ['LlamaForCausalLM'],
            max_position_embeddings: 8192
        }
        const result = extractFromHuggingFaceConfig(config)
        assert.strictEqual(result.parameterCount, 7_000_000_000)
        assert.strictEqual(result.dtype, 'bfloat16')
        assert.strictEqual(result.architecture, 'LlamaForCausalLM')
        assert.strictEqual(result.maxPositionEmbeddings, 8192)
        assert.strictEqual(result.source, 'huggingface_api')
    })

    test('falls back to estimation when num_parameters missing', () => {
        const config = {
            hidden_size: 4096,
            num_hidden_layers: 32,
            torch_dtype: 'float16',
            architectures: ['LlamaForCausalLM'],
            max_position_embeddings: 4096
        }
        const result = extractFromHuggingFaceConfig(config)
        assert.strictEqual(result.parameterCount, 4096 * 32 * 12)
    })

    test('uses defaults for missing optional fields', () => {
        const config = {
            num_parameters: 7_000_000_000
        }
        const result = extractFromHuggingFaceConfig(config)
        assert.strictEqual(result.dtype, 'float16')
        assert.strictEqual(result.architecture, 'unknown')
        assert.strictEqual(result.maxPositionEmbeddings, 4096)
    })

    // ── Full Resolution (catalog path) ───────────────────────────────────────

    console.log('\nmodel-resolver: full resolution\n')

    await test('resolves Llama-2-7b from catalog', async () => {
        const result = await resolveModelMetadata('meta-llama/Llama-2-7b-chat-hf', {
            catalogPath: CATALOG_PATH
        })
        assert.ok(result !== null, 'should resolve metadata')
        assert.strictEqual(result.parameterCount, 6738415616)
        assert.strictEqual(result.dtype, 'float16')
        assert.strictEqual(result.architecture, 'LlamaForCausalLM')
        assert.strictEqual(result.maxPositionEmbeddings, 4096)
        assert.strictEqual(result.source, 'catalog')
    })

    await test('returns null for unknown model without discover mode', async () => {
        const result = await resolveModelMetadata('unknown-org/unknown-model', {
            catalogPath: CATALOG_PATH,
            discover: false
        })
        assert.strictEqual(result, null)
    })

    await test('catalog hit does not require discover mode', async () => {
        const result = await resolveModelMetadata('meta-llama/Llama-2-70b-hf', {
            catalogPath: CATALOG_PATH,
            discover: false
        })
        assert.ok(result !== null, 'should resolve from catalog')
        assert.strictEqual(result.source, 'catalog')
    })

    await test('resolves Qwen model from catalog', async () => {
        const result = await resolveModelMetadata('Qwen/Qwen2-72B-Instruct', {
            catalogPath: CATALOG_PATH
        })
        assert.ok(result !== null, 'should resolve metadata')
        assert.strictEqual(result.parameterCount, 72710410240)
        assert.strictEqual(result.source, 'catalog')
    })

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n  ${passed} passing, ${failed} failing\n`)
    process.exit(failed > 0 ? 1 : 0)
}

run()
