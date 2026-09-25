#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the draft-model-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/draft-model-picker/test.js
 */

import assert from 'node:assert';
import { listDraftModels, getDraftModel, recommendDraft } from './index.js';

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

// ── listDraftModels ──────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: listDraftModels\n');

test('returns all 5 catalog entries with no filter', () => {
    const result = listDraftModels();
    assert.strictEqual(result.count, 5);
    assert.strictEqual(result.models.length, 5);
});

test('each entry has hf_id, algorithm, target_model, engine_support', () => {
    const result = listDraftModels();
    for (const m of result.models) {
        assert.ok(m.hf_id, 'should have hf_id');
        assert.ok(m.algorithm, 'should have algorithm');
        assert.ok(m.target_model, 'should have target_model');
        assert.ok(Array.isArray(m.engine_support), 'engine_support should be array');
    }
});

test('filter by target_model returns subset', () => {
    const result = listDraftModels({ targetModel: 'Llama-3.1-8B' });
    assert.ok(result.count >= 1, 'should find at least one 8B draft');
    for (const m of result.models) {
        assert.ok(m.target_model.includes('Llama-3.1-8B'), 'all results should match filter');
    }
});

test('filter by algorithm=eagle3 returns only eagle3 entries', () => {
    const result = listDraftModels({ algorithm: 'eagle3' });
    assert.ok(result.count >= 1, 'should find eagle3 entries');
    for (const m of result.models) {
        assert.strictEqual(m.algorithm, 'eagle3');
    }
});

test('filter that matches nothing returns count=0', () => {
    const result = listDraftModels({ targetModel: 'nonexistent-model-xyz' });
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.models.length, 0);
});

// ── getDraftModel ────────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: getDraftModel\n');

test('returns thoughtworks Eagle3 entry', () => {
    const model = getDraftModel('thoughtworks/Llama-3.1-8B-Instruct-Eagle3');
    assert.ok(model, 'should return a model');
    assert.strictEqual(model.hf_id, 'thoughtworks/Llama-3.1-8B-Instruct-Eagle3');
    assert.strictEqual(model.algorithm, 'eagle3');
    assert.strictEqual(model.target_model, 'meta-llama/Llama-3.1-8B-Instruct');
    assert.ok(model.engine_support.includes('vllm'), 'should support vllm');
    assert.ok(model.engine_support.includes('sglang'), 'should support sglang');
});

test('returns null for unknown hf_id', () => {
    const model = getDraftModel('does-not-exist/fake-draft');
    assert.strictEqual(model, null);
});

// ── recommendDraft ───────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: recommendDraft\n');

test('recommends eagle3 model for Llama-3.1-8B-Instruct', () => {
    const result = recommendDraft('meta-llama/Llama-3.1-8B-Instruct');
    assert.ok(result, 'should return a recommendation');
    assert.strictEqual(result.algorithm, 'eagle3', 'top pick should be eagle3');
    assert.ok(result.hf_id, 'should have hf_id');
    assert.ok(Array.isArray(result.all_options), 'should have all_options');
});

test('all_options includes at least 2 entries for Llama-3.1-8B', () => {
    const result = recommendDraft('Llama-3.1-8B');
    assert.ok(result, 'should return a recommendation');
    assert.ok(result.all_options.length >= 2, 'should list multiple options');
});

test('returns null for unknown target', () => {
    const result = recommendDraft('some-unknown-model-xyz-404');
    assert.strictEqual(result, null);
});

test('partial name match works (Llama-3.3-70B)', () => {
    const result = recommendDraft('Llama-3.3-70B');
    assert.ok(result, 'should match on partial name');
    assert.ok(result.target_model.includes('Llama-3.3-70B'));
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
