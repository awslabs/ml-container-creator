#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler-level behavior tests for the realtime sizing path
 * (neat-transformer-classifier regression: Qwen/Qwen3.5-4B returned an empty
 * recommendation list with no message).
 *
 * Runs with HF discovery and quota lookups OFF (DISCOVER_MODE=false, set
 * before the server module is imported) so it is deterministic and offline.
 * Model sizes come from project-local .mlcc/model-sizes.json files built from
 * the published Qwen3.5-4B Hub metadata fixture — never invented numbers.
 *
 * Asserts behavior, not SKUs:
 *   - unknown size -> explicit error mentioning --instance-type, no recommendation
 *   - ~4.7B bf16 model -> a single-GPU instance with enough VRAM
 *   - nothing fits -> explicit error, not a silent empty list
 *
 * Run: node servers/instance-sizer/test/sizing-unavailable.test.js
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const QWEN35_CONFIG = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.config.json'), 'utf8'));
const QWEN35_HUB = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hf', 'Qwen__Qwen3.5-4B.hub.json'), 'utf8'));

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

const tmpRoot = mkdtempSync(join(tmpdir(), 'sizer-unavail-'));
function projectWith(models) {
    const dir = mkdtempSync(join(tmpRoot, 'proj-'));
    mkdirSync(join(dir, '.mlcc'), { recursive: true });
    writeFileSync(join(dir, '.mlcc', 'model-sizes.json'), JSON.stringify({ catalogVersion: 'local', models }));
    return dir;
}
async function call(modelName, projectDir) {
    const res = await handleGetInstanceRecommendation({
        modelName,
        limit: 10,
        context: { deploymentTarget: 'realtime-inference', ...(projectDir ? { projectDir } : {}) }
    });
    return JSON.parse(res.content[0].text);
}

console.log('\ninstance-sizer: sizing unavailable / realtime path\n');

await test('incomplete local entry (no parameterCount) -> explicit error, no recommendation', async () => {
    // Exact shape found in the owner's project .mlcc/model-sizes.json.
    const dir = projectWith({
        'Qwen/Qwen3.5-4B*': { architecture: 'Qwen3_5ForConditionalGeneration', defaultDtype: 'float16', maxPositionEmbeddings: 4096 }
    });
    const data = await call('Qwen/Qwen3.5-4B', dir);
    assert.strictEqual(data.values.instanceType, null, 'must not recommend an unsized instance');
    assert.strictEqual(data.metadata.sizingUnavailable, true);
    assert.match(data.metadata.error, /--instance-type/);
    assert.match(data.metadata.error, /Qwen\/Qwen3\.5-4B/);
    assert.ok(data.choices.instanceType.length > 0, 'unfiltered GPU list is still offered to pickers');
});

await test('model absent everywhere (discovery off) -> explicit error, not an empty silent list', async () => {
    const data = await call('unknown-org/unknown-model');
    assert.strictEqual(data.values.instanceType, null);
    assert.strictEqual(data.metadata.sizingUnavailable, true);
    assert.match(data.metadata.error, /--instance-type/);
    assert.match(data.metadata.error, /--no-discover/);
});

await test('~4.7B bf16 multimodal model (sized from Hub metadata) gets a single-GPU instance with enough VRAM', async () => {
    const derived = extractFromHuggingFaceConfig(QWEN35_CONFIG, QWEN35_HUB);
    const dir = projectWith({
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
    const data = await call('Qwen/Qwen3.5-4B', dir);
    assert.ok(data.values.instanceType, `expected a recommendation, got: ${JSON.stringify(data.metadata.error || data.metadata.warning)}`);
    assert.ok(!data.metadata.sizingUnavailable);
    assert.ok(data.metadata.estimatedVramGb > 0);
    const top = data.metadata.recommendations[0];
    assert.strictEqual(top.gpuCount, 1, 'a ~4.7B model fits on one GPU');
    const meta = INSTANCE_CATALOG[top.instanceType];
    assert.ok(meta && meta.category === 'gpu');
    assert.ok(getPerGpuMemoryGb(meta) >= data.metadata.estimatedVramGb,
        `${top.instanceType} must have >= ${data.metadata.estimatedVramGb.toFixed(1)}GB per GPU`);
    assert.strictEqual(data.metadata.maxPositionEmbeddings, QWEN35_CONFIG.text_config.max_position_embeddings);
});

await test('sized model that fits nowhere -> explicit error, not a silent empty list', async () => {
    // Synthetic, clearly-not-a-real-model size (no catalog data involved).
    const dir = projectWith({ 'test-org/too-big*': { parameterCount: 50_000_000_000_000, defaultDtype: 'bfloat16' } });
    const data = await call('test-org/too-big', dir);
    assert.strictEqual(data.choices.instanceType.length, 0);
    assert.strictEqual(data.values.instanceType, null);
    assert.match(data.metadata.error, /--instance-type/);
});

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
