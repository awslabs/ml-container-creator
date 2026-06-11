#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the workload-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/workload-picker/test.js
 */

import assert from 'node:assert';
import { listWorkloads, getWorkloadProfile } from './index.js';

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

console.log('\nworkload-picker: listWorkloads\n');

// --- list_workloads returns all 6 workloads ---
test('returns all 6 workloads', () => {
    const result = listWorkloads();
    assert.strictEqual(result.workloads.length, 6);
});

test('each workload has name, description, and use_case', () => {
    const result = listWorkloads();
    for (const w of result.workloads) {
        assert.ok(w.name, 'should have a name');
        assert.ok(w.description, 'should have a description');
        assert.ok(w.use_case, 'should have a use_case');
    }
});

test('workload names match expected set', () => {
    const result = listWorkloads();
    const names = new Set(result.workloads.map(w => w.name));
    const expected = [
        'multi_turn_chat',
        'rag_document_qa',
        'agent_tool_calling',
        'long_context_scaling',
        'production_traffic_mix',
        'shared_system_prompt'
    ];
    for (const name of expected) {
        assert.ok(names.has(name), `should include ${name}`);
    }
});

console.log('\nworkload-picker: getWorkloadProfile\n');

// --- get_workload_profile returns correct shape ---
test('returns multi_turn_chat profile with all fields', () => {
    const profile = getWorkloadProfile('multi_turn_chat');
    assert.ok(profile, 'should return a profile');
    assert.strictEqual(profile.name, 'multi_turn_chat');
    assert.strictEqual(profile.input_tokens_mean, 550);
    assert.strictEqual(profile.output_tokens_mean, 150);
    assert.strictEqual(profile.streaming, true);
    assert.strictEqual(profile.dataset, 'synthetic');
    assert.deepStrictEqual(profile.concurrency_levels, [1, 4, 8, 16]);
    assert.strictEqual(profile.use_case, 'Interactive chat, low latency');
});

test('returns agent_tool_calling with streaming=false', () => {
    const profile = getWorkloadProfile('agent_tool_calling');
    assert.ok(profile, 'should return a profile');
    assert.strictEqual(profile.streaming, false);
    assert.strictEqual(profile.input_tokens_mean, 200);
    assert.strictEqual(profile.output_tokens_mean, 100);
    assert.deepStrictEqual(profile.concurrency_levels, [1, 4, 8, 16, 32]);
});

test('returns long_context_scaling with high token counts', () => {
    const profile = getWorkloadProfile('long_context_scaling');
    assert.ok(profile, 'should return a profile');
    assert.strictEqual(profile.input_tokens_mean, 8000);
    assert.strictEqual(profile.output_tokens_mean, 1000);
    assert.deepStrictEqual(profile.concurrency_levels, [1, 2, 4]);
});

test('returns null for unknown workload', () => {
    const profile = getWorkloadProfile('nonexistent_workload');
    assert.strictEqual(profile, null);
});

test('returns null for empty string', () => {
    const profile = getWorkloadProfile('');
    assert.strictEqual(profile, null);
});

// --- Profile fields validation ---
test('all profiles have required numeric fields > 0', () => {
    const allWorkloads = listWorkloads();
    for (const w of allWorkloads.workloads) {
        const profile = getWorkloadProfile(w.name);
        assert.ok(profile.input_tokens_mean > 0, `${w.name}: input_tokens_mean should be > 0`);
        assert.ok(profile.output_tokens_mean > 0, `${w.name}: output_tokens_mean should be > 0`);
        assert.ok(profile.concurrency_levels.length > 0, `${w.name}: concurrency_levels should be non-empty`);
    }
});

test('all profiles have boolean streaming field', () => {
    const allWorkloads = listWorkloads();
    for (const w of allWorkloads.workloads) {
        const profile = getWorkloadProfile(w.name);
        assert.strictEqual(typeof profile.streaming, 'boolean', `${w.name}: streaming should be boolean`);
    }
});

test('concurrency_levels are sorted ascending', () => {
    const allWorkloads = listWorkloads();
    for (const w of allWorkloads.workloads) {
        const profile = getWorkloadProfile(w.name);
        const levels = profile.concurrency_levels;
        for (let i = 1; i < levels.length; i++) {
            assert.ok(levels[i] > levels[i - 1], `${w.name}: concurrency_levels should be sorted ascending`);
        }
    }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
