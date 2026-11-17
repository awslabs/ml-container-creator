#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL240: the KV-cache estimate budgets the SERVED context
 * (min(model max_position_embeddings, engine default max_model_len)), not the
 * model's native maximum. Offline and deterministic (DISCOVER_MODE=false).
 *
 * Asserts behavior, not SKUs or frozen catalog values:
 *   - the engine default is whatever serve.d + model-servers.json declare
 *   - a long native context no longer inflates the estimate of a small model
 *   - an explicitly requested long context still gets the bigger instance
 *   - the native maximum is still reported in metadata
 *
 * Run: node servers/instance-sizer/test/served-context.test.js
 */

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.DISCOVER_MODE = 'false';
const { handleGetInstanceRecommendation, INSTANCE_CATALOG } = await import('../index.js');
const { getPerGpuMemoryGb } = await import('../lib/instance-ranker.js');
const { extractFromHuggingFaceConfig } = await import('../lib/model-resolver.js');
const { DEFAULT_MAX_SEQUENCE_LENGTH } = await import('../lib/vram-estimator.js');
const {
    resolveServedContext,
    engineDefaultServedContext,
    SERVE_D,
    MODEL_SERVERS_CATALOG
} = await import('../lib/served-context.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const QWEN35_CONFIG = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.config.json'), 'utf8'));
const QWEN35_HUB = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.hub.json'), 'utf8'));
const MODEL_SERVERS = JSON.parse(readFileSync(MODEL_SERVERS_CATALOG, 'utf8'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'sizer-served-'));
function projectWith(models) {
    const dir = mkdtempSync(join(tmpRoot, 'proj-'));
    mkdirSync(join(dir, '.mlcc'), { recursive: true });
    writeFileSync(join(dir, '.mlcc', 'model-sizes.json'), JSON.stringify({ catalogVersion: 'local', models }));
    return dir;
}
async function call(args) {
    const res = await handleGetInstanceRecommendation({ limit: 100, ...args });
    return JSON.parse(res.content[0].text);
}
function manifestFor(engine) {
    return JSON.parse(readFileSync(join(SERVE_D, engine, 'manifest.json'), 'utf8'));
}

// Qwen3.5-4B entry derived from the published Hub metadata fixture (never invented).
const derived = extractFromHuggingFaceConfig(QWEN35_CONFIG, QWEN35_HUB);
const qwenDir = projectWith({
    'Qwen/Qwen3.5-4B*': {
        parameterCount: derived.parameterCount,
        defaultDtype: derived.dtype,
        architecture: derived.architecture,
        maxPositionEmbeddings: derived.maxPositionEmbeddings,
        numLayers: derived.numLayers,
        numKvHeads: derived.numKvHeads,
        headDim: derived.headDim
    }
});

console.log('\ninstance-sizer: served context (BL240)\n');

await test('vllm engine default is derived from serve.d + model-servers.json', async () => {
    const m = manifestFor('vllm');
    const envVar = `${m.env_var_prefix}${m.dimension_map.max_model_len}`;
    const expected = parseInt(MODEL_SERVERS.vllm[0].defaults.envVars[envVar], 10);
    const info = engineDefaultServedContext('vllm');
    assert.ok(info, 'vllm declares a default served context');
    assert.strictEqual(info.envVar, envVar);
    assert.strictEqual(info.value, expected);
});

await test('every engine default comes from its own manifest env var (or none)', async () => {
    for (const engine of Object.keys(MODEL_SERVERS)) {
        const info = engineDefaultServedContext(engine);
        if (!info) continue;
        const m = manifestFor(engine);
        assert.strictEqual(info.envVar, `${m.env_var_prefix}${m.dimension_map.max_model_len}`, engine);
        assert.ok(info.value > 0, engine);
    }
});

await test('unknown engine falls back to DEFAULT_MAX_SEQUENCE_LENGTH', async () => {
    assert.strictEqual(engineDefaultServedContext('no-such-engine'), null);
    const r = resolveServedContext({ maxPositionEmbeddings: 262144, engine: 'no-such-engine' });
    assert.strictEqual(r.servedContext, DEFAULT_MAX_SEQUENCE_LENGTH);
    assert.strictEqual(r.source, 'sizer-default');
});

await test('served = min(native, engine default); explicit request wins as-is', async () => {
    const def = resolveServedContext({ engine: 'vllm' }).engineDefault;
    assert.strictEqual(resolveServedContext({ maxPositionEmbeddings: def * 64, engine: 'vllm' }).servedContext, def);
    assert.strictEqual(resolveServedContext({ maxPositionEmbeddings: Math.floor(def / 2), engine: 'vllm' }).servedContext, Math.floor(def / 2));
    assert.strictEqual(resolveServedContext({ maxPositionEmbeddings: null, engine: 'vllm' }).servedContext, def);
    assert.strictEqual(resolveServedContext({ requested: def * 8, maxPositionEmbeddings: def * 64, engine: 'vllm' }).servedContext, def * 8);
});

await test('Qwen3.5-4B (262144 native) is budgeted for the served context and fits a 24 GB single GPU', async () => {
    const data = await call({ modelName: 'Qwen/Qwen3.5-4B', context: { projectDir: qwenDir, backend: 'vllm' } });
    const md = data.metadata;
    assert.strictEqual(md.maxPositionEmbeddings, QWEN35_CONFIG.text_config.max_position_embeddings, 'native context still reported');
    assert.ok(md.servedContextLength < md.maxPositionEmbeddings, 'KV budget uses the served, not the native, context');
    assert.strictEqual(md.servedContextLength, engineDefaultServedContext('vllm').value);
    assert.match(md.servedContextSource, /^engine-default:vllm:/);
    assert.ok(md.estimatedVramGb < 24, `estimate ${md.estimatedVramGb.toFixed(1)}GB should fit a 24 GB GPU`);
    const small = md.recommendations.filter(r => r.gpuCount === 1 && getPerGpuMemoryGb(INSTANCE_CATALOG[r.instanceType]) <= 24);
    assert.ok(small.length > 0, 'a single-GPU instance with <=24 GB is among the sized choices');
    for (const r of small) {
        assert.ok(getPerGpuMemoryGb(INSTANCE_CATALOG[r.instanceType]) >= md.estimatedVramGb, r.instanceType);
    }
});

await test('the same model at its full native context still needs the larger estimate (control)', async () => {
    const served = await call({ modelName: 'Qwen/Qwen3.5-4B', context: { projectDir: qwenDir, backend: 'vllm' } });
    const full = await call({
        modelName: 'Qwen/Qwen3.5-4B',
        maxSequenceLength: QWEN35_CONFIG.text_config.max_position_embeddings,
        context: { projectDir: qwenDir }
    });
    assert.strictEqual(full.metadata.servedContextSource, 'requested');
    assert.ok(full.metadata.vramBreakdown.kvCacheGb > served.metadata.vramBreakdown.kvCacheGb * 10,
        'a 64x longer served context budgets far more KV cache');
    assert.ok(full.metadata.estimatedVramGb > served.metadata.estimatedVramGb);
});

await test('a model whose requested served context genuinely needs more is moved off 24 GB GPUs', async () => {
    // Synthetic 8B-class bf16 model (clearly test data); 131072 served tokens.
    const dir = projectWith({ 'test-org/long-ctx-8b*': { parameterCount: 8_000_000_000, defaultDtype: 'bfloat16', maxPositionEmbeddings: 131072 } });
    const short = await call({ modelName: 'test-org/long-ctx-8b', context: { projectDir: dir } });
    const long = await call({ modelName: 'test-org/long-ctx-8b', maxSequenceLength: 131072, context: { projectDir: dir } });
    const fitsOn24 = (d) => d.metadata.recommendations.some(r => r.gpuCount === 1 && getPerGpuMemoryGb(INSTANCE_CATALOG[r.instanceType]) <= 24);
    assert.ok(fitsOn24(short), 'served at the default context, an 8B bf16 model fits a 24 GB GPU');
    assert.ok(long.metadata.estimatedVramGb > 24, 'at 131072 served tokens the estimate exceeds 24 GB');
    assert.ok(!fitsOn24(long), 'and no <=24 GB single-GPU instance is offered');
    assert.ok(long.values.instanceType, 'a larger instance is still recommended');
});

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
