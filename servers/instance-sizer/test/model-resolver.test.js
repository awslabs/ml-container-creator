#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the model metadata resolver.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/model-resolver.test.js
 */

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    resolveModelMetadata,
    globMatch,
    loadCatalog,
    catalogLookup,
    estimateParamsFromConfig,
    extractFromHuggingFaceConfig,
    dominantSafetensorsDtype,
    hasUsableSize
} from '../lib/model-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CATALOG_PATH = join(__dirname, '..', '..', 'lib', 'catalogs', 'model-sizes.json');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                passed++;
                console.log(`  ✓ ${name}`);
            }).catch((err) => {
                failed++;
                console.error(`  ✗ ${name}`);
                console.error(`    ${err.message}`);
            });
        }
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

async function run() {
    // ── Glob Pattern Matching ────────────────────────────────────────────────

    console.log('\nmodel-resolver: glob pattern matching\n');

    test('exact match without wildcards', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-3.1-8B', 'meta-llama/Llama-3.1-8B'), true);
    });

    test('wildcard matches any suffix', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-3.1-8B*', 'meta-llama/Llama-3.1-8B-Instruct'), true);
    });

    test('wildcard matches empty string', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-3.1-8B*', 'meta-llama/Llama-3.1-8B'), true);
    });

    test('case-insensitive matching', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-3.1-8B*', 'meta-llama/llama-3.1-8b-instruct'), true);
    });

    test('non-matching pattern returns false', () => {
        assert.strictEqual(globMatch('meta-llama/Llama-3.1-8B*', 'meta-llama/Llama-3.2-3B-Instruct'), false);
    });

    test('wildcard in middle of pattern', () => {
        assert.strictEqual(globMatch('meta-llama/*-8B*', 'meta-llama/Llama-3.1-8B-Instruct'), true);
    });

    test('special regex characters in pattern are escaped', () => {
        assert.strictEqual(globMatch('model.name+v1*', 'model.name+v1.0'), true);
        assert.strictEqual(globMatch('model.name+v1*', 'modelXname+v1.0'), false);
    });

    // ── Catalog Loading ──────────────────────────────────────────────────────

    console.log('\nmodel-resolver: catalog loading\n');

    await test('loads catalog from default path', async () => {
        const catalog = await loadCatalog(CATALOG_PATH);
        assert.ok(catalog !== null, 'catalog should not be null');
        assert.ok(catalog.models, 'catalog should have models');
        // Assert the version FIELD exists and is semver-shaped, not a frozen
        // literal — the catalog legitimately bumps its version (now 1.1.0), and a
        // hardcoded value fails on every bump without testing anything real.
        assert.ok(/^\d+\.\d+\.\d+$/.test(catalog.catalogVersion),
            `catalogVersion should be semver, got: ${catalog.catalogVersion}`);
    });

    await test('returns null for non-existent catalog path', async () => {
        const catalog = await loadCatalog('/non/existent/path.json');
        assert.strictEqual(catalog, null);
    });

    // ── Catalog Lookup ───────────────────────────────────────────────────────

    console.log('\nmodel-resolver: catalog lookup\n');

    await test('finds Llama-3.1-8B by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH);
        const entry = catalogLookup('meta-llama/Llama-3.1-8B-Instruct', catalog);
        assert.ok(entry !== null, 'should find entry');
        assert.strictEqual(entry.parameterCount, 8030261248);
        assert.strictEqual(entry.defaultDtype, 'bfloat16');
        assert.strictEqual(entry.architecture, 'LlamaForCausalLM');
    });

    await test('finds Llama-3.3-70B by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH);
        const entry = catalogLookup('meta-llama/Llama-3.3-70B-Instruct', catalog);
        assert.ok(entry !== null, 'should find entry');
        assert.strictEqual(entry.parameterCount, 70553706496);
    });

    await test('finds Qwen3-8B by pattern match', async () => {
        const catalog = await loadCatalog(CATALOG_PATH);
        const entry = catalogLookup('Qwen/Qwen3-8B', catalog);
        assert.ok(entry !== null, 'should find entry');
        assert.strictEqual(entry.parameterCount, 8000000000);
    });

    await test('returns null for unknown model', async () => {
        const catalog = await loadCatalog(CATALOG_PATH);
        const entry = catalogLookup('unknown-org/unknown-model', catalog);
        assert.strictEqual(entry, null);
    });

    await test('returns null when catalog is null', () => {
        const entry = catalogLookup('meta-llama/Llama-3.1-8B-Instruct', null);
        assert.strictEqual(entry, null);
    });

    await test('returns null when catalog has no models field', () => {
        const entry = catalogLookup('meta-llama/Llama-3.1-8B-Instruct', {});
        assert.strictEqual(entry, null);
    });

    // ── Parameter Estimation ─────────────────────────────────────────────────

    console.log('\nmodel-resolver: parameter estimation from config\n');

    // The previous formula (hidden × layers × 12) dropped a factor of hidden
    // and sized an 8B Llama at ~1.5M params. The dense-transformer estimate is
    // layers × 12 × hidden² + embeddings.
    test('estimates a Llama-3-8B-shaped dense config within 15% of its published size', () => {
        const config = {
            hidden_size: 4096,
            num_hidden_layers: 32,
            vocab_size: 128256,
            tie_word_embeddings: false
        };
        const estimated = estimateParamsFromConfig(config);
        const published = 8_030_261_248; // safetensors total of meta-llama/Llama-3.1-8B
        assert.ok(Math.abs(estimated - published) / published < 0.15,
            `estimate ${estimated} should be within 15% of ${published}`);
    });

    test('reads dimensions from a nested text_config (multimodal configs)', () => {
        const flat = estimateParamsFromConfig({ hidden_size: 2560, num_hidden_layers: 32, vocab_size: 1000 });
        const nested = estimateParamsFromConfig({ text_config: { hidden_size: 2560, num_hidden_layers: 32, vocab_size: 1000 } });
        assert.ok(flat > 0);
        assert.strictEqual(nested, flat);
    });

    test('refuses to estimate mixture-of-experts configs (dense formula does not apply)', () => {
        assert.strictEqual(estimateParamsFromConfig({ hidden_size: 4096, num_hidden_layers: 32, num_local_experts: 8 }), null);
        assert.strictEqual(estimateParamsFromConfig({ text_config: { hidden_size: 4096, num_hidden_layers: 32, num_experts: 64 } }), null);
    });

    test('returns null when hidden_size is missing', () => {
        const config = { num_hidden_layers: 32 };
        const estimated = estimateParamsFromConfig(config);
        assert.strictEqual(estimated, null);
    });

    test('returns null when num_hidden_layers is missing', () => {
        const config = { hidden_size: 4096 };
        const estimated = estimateParamsFromConfig(config);
        assert.strictEqual(estimated, null);
    });

    test('returns null for empty config', () => {
        const estimated = estimateParamsFromConfig({});
        assert.strictEqual(estimated, null);
    });

    // ── HuggingFace Config Extraction ────────────────────────────────────────

    console.log('\nmodel-resolver: HuggingFace config extraction\n');

    test('extracts all fields from complete config', () => {
        const config = {
            num_parameters: 7_000_000_000,
            torch_dtype: 'bfloat16',
            architectures: ['LlamaForCausalLM'],
            max_position_embeddings: 8192
        };
        const result = extractFromHuggingFaceConfig(config);
        assert.strictEqual(result.parameterCount, 7_000_000_000);
        assert.strictEqual(result.dtype, 'bfloat16');
        assert.strictEqual(result.architecture, 'LlamaForCausalLM');
        assert.strictEqual(result.maxPositionEmbeddings, 8192);
        assert.strictEqual(result.source, 'huggingface_api');
    });

    test('falls back to estimation when num_parameters missing', () => {
        const config = {
            hidden_size: 4096,
            num_hidden_layers: 32,
            torch_dtype: 'float16',
            architectures: ['LlamaForCausalLM'],
            max_position_embeddings: 4096
        };
        const result = extractFromHuggingFaceConfig(config);
        assert.strictEqual(result.parameterCount, estimateParamsFromConfig(config));
        assert.strictEqual(result.parameterCountSource, 'config-dimension-estimate');
    });

    test('uses defaults for missing optional fields, but never fabricates a context length', () => {
        const config = {
            num_parameters: 7_000_000_000
        };
        const result = extractFromHuggingFaceConfig(config);
        assert.strictEqual(result.dtype, 'float16');
        assert.strictEqual(result.architecture, 'unknown');
        assert.strictEqual(result.maxPositionEmbeddings, null);
    });

    test('size unknown -> parameterCount null (never 0)', () => {
        const result = extractFromHuggingFaceConfig({ architectures: ['X'] });
        assert.strictEqual(result.parameterCount, null);
        assert.strictEqual(hasUsableSize(result), false);
    });

    // ── Multimodal (nested text_config) — real published config ─────────────

    console.log('\nmodel-resolver: multimodal config (Qwen3.5-4B fixture)\n');

    const QWEN35_CONFIG = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.config.json'), 'utf8'));
    const QWEN35_HUB = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.hub.json'), 'utf8'));

    test('reads context/dtype/heads from text_config, not a 4096 default', () => {
        const result = extractFromHuggingFaceConfig(QWEN35_CONFIG, QWEN35_HUB);
        const tc = QWEN35_CONFIG.text_config;
        assert.strictEqual(result.maxPositionEmbeddings, tc.max_position_embeddings);
        assert.ok(result.maxPositionEmbeddings > 4096, 'Qwen3.5 publishes a long context');
        assert.strictEqual(result.dtype, 'bfloat16');
        assert.strictEqual(result.numLayers, tc.num_hidden_layers);
        assert.strictEqual(result.numKvHeads, tc.num_key_value_heads);
        assert.strictEqual(result.headDim, tc.head_dim);
        assert.strictEqual(result.architecture, QWEN35_CONFIG.architectures[0]);
    });

    test('parameter count comes from the Hub safetensors metadata when present', () => {
        const result = extractFromHuggingFaceConfig(QWEN35_CONFIG, QWEN35_HUB);
        assert.strictEqual(result.parameterCount, QWEN35_HUB.safetensors.total);
        assert.strictEqual(result.parameterCountSource, 'huggingface-safetensors-metadata');
    });

    test('without Hub metadata a multimodal config still yields a positive estimate', () => {
        const result = extractFromHuggingFaceConfig(QWEN35_CONFIG);
        assert.ok(hasUsableSize(result), 'nested text_config must not yield a null/zero size');
        assert.strictEqual(result.parameterCountSource, 'config-dimension-estimate');
    });

    test('dominantSafetensorsDtype picks the majority weight dtype', () => {
        assert.strictEqual(dominantSafetensorsDtype({ parameters: { BF16: 100, F32: 3 } }), 'bfloat16');
        assert.strictEqual(dominantSafetensorsDtype({ parameters: { F16: 10 } }), 'float16');
        assert.strictEqual(dominantSafetensorsDtype(null), null);
    });

    // ── Hub discovery (stubbed fetch — deterministic, offline) ──────────────

    console.log('\nmodel-resolver: HuggingFace Hub discovery (stubbed)\n');

    const stubFetch = (routes) => async (url) => {
        for (const [suffix, body] of Object.entries(routes)) {
            if (url.endsWith(suffix)) {
                if (body === 401) return { ok: false, status: 401, json: async () => ({}) };
                return { ok: true, status: 200, json: async () => body };
            }
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    const QWEN35_ROUTES = {
        '/api/models/Qwen/Qwen3.5-4B': QWEN35_HUB,
        '/Qwen/Qwen3.5-4B/resolve/main/config.json': QWEN35_CONFIG
    };

    await test('uncatalogued multimodal model resolves to a usable size via the Hub', async () => {
        const result = await resolveModelMetadata('Qwen/Qwen3.5-4B', {
            catalogPath: CATALOG_PATH,
            fetchImpl: stubFetch(QWEN35_ROUTES)
        });
        assert.ok(hasUsableSize(result));
        assert.strictEqual(result.parameterCount, QWEN35_HUB.safetensors.total);
        assert.strictEqual(result.maxPositionEmbeddings, QWEN35_CONFIG.text_config.max_position_embeddings);
    });

    await test('gated repo (config.json 401) still gets a size from the public Hub API', async () => {
        const result = await resolveModelMetadata('gated-org/gated-model', {
            catalogPath: CATALOG_PATH,
            fetchImpl: stubFetch({
                '/api/models/gated-org/gated-model': { safetensors: { parameters: { BF16: 4_000_000_000 }, total: 4_000_000_000 } },
                '/gated-org/gated-model/resolve/main/config.json': 401
            })
        });
        assert.ok(hasUsableSize(result));
        assert.strictEqual(result.dtype, 'bfloat16');
        assert.strictEqual(result.maxPositionEmbeddings, null);
    });

    await test('Hub unreachable -> null (caller reports "cannot size")', async () => {
        const result = await resolveModelMetadata('unknown-org/unknown-model', {
            catalogPath: CATALOG_PATH,
            fetchImpl: async () => { throw new Error('ENOTFOUND'); }
        });
        assert.strictEqual(result, null);
    });

    // ── Incomplete project-local entries must not shadow discovery ──────────

    console.log('\nmodel-resolver: incomplete local catalog entries\n');

    const tmp = mkdtempSync(join(tmpdir(), 'sizer-local-'));
    const localPath = join(tmp, 'model-sizes.json');
    // Shape written by older do/stage registrations for multimodal configs:
    // no parameterCount, and a defaulted 4096 context.
    writeFileSync(localPath, JSON.stringify({
        catalogVersion: 'local',
        models: { 'Qwen/Qwen3.5-4B*': { architecture: 'Qwen3_5ForConditionalGeneration', defaultDtype: 'float16', maxPositionEmbeddings: 4096 } }
    }));

    await test('local entry without parameterCount falls through to Hub discovery', async () => {
        const result = await resolveModelMetadata('Qwen/Qwen3.5-4B', {
            catalogPath: CATALOG_PATH,
            localCatalogPath: localPath,
            fetchImpl: stubFetch(QWEN35_ROUTES)
        });
        assert.ok(hasUsableSize(result));
        assert.strictEqual(result.source, 'huggingface_api');
    });

    await test('local entry without parameterCount + no Hub -> partial result without a usable size', async () => {
        const result = await resolveModelMetadata('Qwen/Qwen3.5-4B', {
            catalogPath: CATALOG_PATH,
            localCatalogPath: localPath,
            discover: false
        });
        assert.ok(result !== null);
        assert.strictEqual(result.source, 'local-catalog');
        assert.strictEqual(hasUsableSize(result), false);
    });

    await test('complete local entry still wins over discovery', async () => {
        const completePath = join(tmp, 'complete.json');
        writeFileSync(completePath, JSON.stringify({
            models: { 'Qwen/Qwen3.5-4B*': { parameterCount: 123, parameterCountSource: 'huggingface-safetensors-metadata', defaultDtype: 'bfloat16' } }
        }));
        const result = await resolveModelMetadata('Qwen/Qwen3.5-4B', {
            catalogPath: CATALOG_PATH,
            localCatalogPath: completePath,
            fetchImpl: async () => { throw new Error('must not be called'); }
        });
        assert.strictEqual(result.source, 'local-catalog');
        assert.strictEqual(result.parameterCount, 123);
        assert.strictEqual(result.parameterCountSource, 'huggingface-safetensors-metadata', 'recorded source is carried through');
        assert.strictEqual(result.maxPositionEmbeddings, null, 'unknown context stays unknown, not 4096');
    });

    rmSync(tmp, { recursive: true, force: true });

    // ── Full Resolution (catalog path) ───────────────────────────────────────

    console.log('\nmodel-resolver: full resolution\n');

    await test('resolves Llama-3.1-8B from catalog', async () => {
        const result = await resolveModelMetadata('meta-llama/Llama-3.1-8B-Instruct', {
            catalogPath: CATALOG_PATH
        });
        assert.ok(result !== null, 'should resolve metadata');
        assert.strictEqual(result.parameterCount, 8030261248);
        assert.strictEqual(result.dtype, 'bfloat16');
        assert.strictEqual(result.architecture, 'LlamaForCausalLM');
        assert.strictEqual(result.maxPositionEmbeddings, 131072);
        assert.strictEqual(result.source, 'catalog');
    });

    await test('returns null for unknown model without discover mode', async () => {
        const result = await resolveModelMetadata('unknown-org/unknown-model', {
            catalogPath: CATALOG_PATH,
            discover: false
        });
        assert.strictEqual(result, null);
    });

    await test('catalog hit does not require discover mode', async () => {
        const result = await resolveModelMetadata('meta-llama/Llama-3.3-70B-Instruct', {
            catalogPath: CATALOG_PATH,
            discover: false
        });
        assert.ok(result !== null, 'should resolve from catalog');
        assert.strictEqual(result.source, 'catalog');
    });

    await test('resolves Qwen model from catalog', async () => {
        const result = await resolveModelMetadata('Qwen/Qwen2.5-72B-Instruct', {
            catalogPath: CATALOG_PATH
        });
        assert.ok(result !== null, 'should resolve metadata');
        assert.strictEqual(result.parameterCount, 72710410240);
        assert.strictEqual(result.source, 'catalog');
    });

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n  ${passed} passing, ${failed} failing\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
