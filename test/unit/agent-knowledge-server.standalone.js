#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the agent-knowledge MCP server.
 * Uses node:assert only — same pattern as servers/instance-sizer/test.js.
 * Run: node test/unit/agent-knowledge-server.test.js
 */

import assert from 'node:assert';
import { handleQueryKnowledge, PACKAGE_ROOT } from '../../servers/agent-knowledge/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    return fn().then(() => {
        passed++;
        console.log(`  ✓ ${name}`);
    }).catch((err) => {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    });
}

function parseResponse(result) {
    assert.ok(result, 'result should not be null');
    assert.ok(result.content, 'result should have content');
    assert.ok(Array.isArray(result.content), 'content should be an array');
    assert.ok(result.content.length > 0, 'content should not be empty');
    assert.strictEqual(result.content[0].type, 'text', 'content[0].type should be text');
    return JSON.parse(result.content[0].text);
}

// ── script_reference topic ───────────────────────────────────────────────────

console.log('\nagent-knowledge: script_reference\n');

await test('script_reference returns array of scripts', async () => {
    const result = await handleQueryKnowledge({ topic: 'script_reference' });
    const data = parseResponse(result);

    assert.ok(Array.isArray(data), 'script_reference should return an array');
    assert.ok(data.length > 0, 'script_reference should not be empty');
});

await test('script_reference entries have required fields', async () => {
    const result = await handleQueryKnowledge({ topic: 'script_reference' });
    const data = parseResponse(result);

    for (const script of data.slice(0, 3)) {
        assert.ok(script.name, 'script should have name');
        assert.ok(script.purpose, 'script should have purpose');
        assert.ok(Array.isArray(script.flags), 'script.flags should be an array');
        assert.ok(Array.isArray(script.reads), 'script.reads should be an array');
        assert.ok(Array.isArray(script.writes), 'script.writes should be an array');
        assert.ok(script.lifecycle_position, 'script should have lifecycle_position');
    }
});

await test('script_reference filter narrows results', async () => {
    const allResult = await handleQueryKnowledge({ topic: 'script_reference' });
    const allData = parseResponse(allResult);

    const filtered = await handleQueryKnowledge({ topic: 'script_reference', filter: 'deploy' });
    const filteredData = parseResponse(filtered);

    assert.ok(Array.isArray(filteredData), 'filtered result should be an array');
    // Filtered should be subset (fewer or equal entries)
    assert.ok(filteredData.length <= allData.length,
        `filtered (${filteredData.length}) should be <= total (${allData.length})`);
    // All filtered entries should match 'deploy' in name, purpose, or lifecycle_position
    for (const script of filteredData) {
        const text = `${script.name} ${script.purpose} ${script.lifecycle_position}`.toLowerCase();
        assert.ok(text.includes('deploy'),
            `filtered entry "${script.name}" should match 'deploy'`);
    }
});

// ── config_reference topic ───────────────────────────────────────────────────

console.log('\nagent-knowledge: config_reference\n');

await test('config_reference returns structured object', async () => {
    const result = await handleQueryKnowledge({ topic: 'config_reference' });
    const data = parseResponse(result);

    assert.ok(typeof data === 'object', 'config_reference should return an object');
    assert.ok('do_config_vars' in data, 'should have do_config_vars');
    assert.ok(Array.isArray(data.do_config_vars), 'do_config_vars should be an array');
});

await test('config_reference vars have name and description', async () => {
    const result = await handleQueryKnowledge({ topic: 'config_reference' });
    const data = parseResponse(result);

    assert.ok(data.do_config_vars.length > 0, 'should have at least one config var');
    for (const v of data.do_config_vars.slice(0, 3)) {
        assert.ok(v.name, 'var should have name');
        assert.ok(typeof v.name === 'string', 'var.name should be a string');
    }
});

// ── troubleshooting topic ────────────────────────────────────────────────────

console.log('\nagent-knowledge: troubleshooting\n');

await test('troubleshooting returns array of patterns', async () => {
    const result = await handleQueryKnowledge({ topic: 'troubleshooting' });
    const data = parseResponse(result);

    assert.ok(Array.isArray(data), 'troubleshooting should return an array');
    assert.ok(data.length > 0, 'troubleshooting should not be empty');
});

await test('troubleshooting entries have required fields', async () => {
    const result = await handleQueryKnowledge({ topic: 'troubleshooting' });
    const data = parseResponse(result);

    for (const entry of data.slice(0, 3)) {
        assert.ok(entry.pattern, 'entry should have pattern');
        assert.ok(entry.root_cause, 'entry should have root_cause');
        assert.ok(entry.fix, 'entry should have fix');
        assert.ok(Array.isArray(entry.diagnostic_steps), 'entry should have diagnostic_steps array');
    }
});

await test('troubleshooting filter works', async () => {
    const result = await handleQueryKnowledge({ topic: 'troubleshooting', filter: 'docker' });
    const data = parseResponse(result);

    assert.ok(Array.isArray(data), 'filtered troubleshooting should be an array');
    // Each filtered entry should contain 'docker' somewhere
    for (const entry of data) {
        const text = `${entry.pattern} ${entry.root_cause} ${entry.fix}`.toLowerCase();
        assert.ok(text.includes('docker'),
            `filtered entry "${entry.pattern}" should match 'docker'`);
    }
});

// ── capability_matrix topic ──────────────────────────────────────────────────

console.log('\nagent-knowledge: capability_matrix\n');

await test('capability_matrix returns data', async () => {
    const result = await handleQueryKnowledge({ topic: 'capability_matrix' });
    const data = parseResponse(result);

    assert.ok(data !== null && data !== undefined, 'capability_matrix should return data');
    assert.ok(typeof data === 'object', 'capability_matrix should return an object');
});

await test('capability_matrix filter narrows results', async () => {
    const result = await handleQueryKnowledge({ topic: 'capability_matrix', filter: 'vllm' });
    const data = parseResponse(result);

    assert.ok(data !== null, 'filtered capability_matrix should return data');
    // Should contain vllm-related entries
    const text = JSON.stringify(data).toLowerCase();
    assert.ok(text.includes('vllm'), 'filtered result should contain vllm');
});

// ── unknown topic ────────────────────────────────────────────────────────────

console.log('\nagent-knowledge: error handling\n');

await test('unknown topic returns error', async () => {
    const result = await handleQueryKnowledge({ topic: 'nonexistent_topic' });
    const data = parseResponse(result);

    assert.ok(data.error, 'unknown topic should return error field');
    assert.ok(data.error.includes('Unknown topic'), 'error should mention unknown topic');
});

// ── PACKAGE_ROOT resolution ──────────────────────────────────────────────────

console.log('\nagent-knowledge: path resolution\n');

await test('PACKAGE_ROOT resolves to a valid directory', async () => {
    assert.ok(PACKAGE_ROOT, 'PACKAGE_ROOT should be exported');
    assert.ok(typeof PACKAGE_ROOT === 'string', 'PACKAGE_ROOT should be a string');
    // Should end with the project directory name
    assert.ok(PACKAGE_ROOT.includes('ml-container-creator'),
        `PACKAGE_ROOT should contain project name, got: ${PACKAGE_ROOT}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
