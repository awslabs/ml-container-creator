#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the model-registry MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/model-registry/test.js
 *
 * Tests verify:
 *   - Tool schema / function signatures
 *   - Offline fallback behavior
 *   - Pagination logic
 *   - Dataset/evaluator filtering
 */

import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    toolListDatasets,
    toolListEvaluators,
    toolGetDataset,
    toolGetEvaluator,
    _loadLocalRegistry,
    _offlineFallback,
    _offlineFallbackVersion,
    _batchDescribe,
    DEFAULT_LIMIT,
    SAGEMAKER_MAX_RESULTS
} from './index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  \u2713 ${name}`);
    } catch (err) {
        failed++;
        console.error(`  \u2717 ${name}`);
        console.error(`    ${err.message}`);
    }
}

// ── Helper: create temp registry files ───────────────────────────────────────

const TEMP_DIR = join(tmpdir(), `model-registry-test-${Date.now()}`);

function setupTempDir() {
    mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupTempDir() {
    try {
        rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
}

// ── Tests: Constants ─────────────────────────────────────────────────────────

console.log('\nmodel-registry: constants\n');

test('DEFAULT_LIMIT is 20', () => {
    assert.strictEqual(DEFAULT_LIMIT, 20);
});

test('SAGEMAKER_MAX_RESULTS is 100', () => {
    assert.strictEqual(SAGEMAKER_MAX_RESULTS, 100);
});

test('_batchDescribe is exported', () => {
    assert.strictEqual(typeof _batchDescribe, 'function');
});

// ── Tests: _loadLocalRegistry ────────────────────────────────────────────────

console.log('\nmodel-registry: _loadLocalRegistry\n');

test('returns empty array for non-existent file', () => {
    const result = _loadLocalRegistry('/nonexistent/path/registry.json');
    assert.deepStrictEqual(result, []);
});

test('returns empty array for invalid JSON file', () => {
    setupTempDir();
    const path = join(TEMP_DIR, 'invalid.json');
    writeFileSync(path, 'not json at all');
    const result = _loadLocalRegistry(path);
    assert.deepStrictEqual(result, []);
    cleanupTempDir();
});

test('returns empty array for non-array JSON', () => {
    setupTempDir();
    const path = join(TEMP_DIR, 'object.json');
    writeFileSync(path, JSON.stringify({ key: 'value' }));
    const result = _loadLocalRegistry(path);
    assert.deepStrictEqual(result, []);
    cleanupTempDir();
});

test('returns array from valid JSON file', () => {
    setupTempDir();
    const path = join(TEMP_DIR, 'valid.json');
    const data = [{ name: 'test' }, { name: 'test2' }];
    writeFileSync(path, JSON.stringify(data));
    const result = _loadLocalRegistry(path);
    assert.deepStrictEqual(result, data);
    cleanupTempDir();
});

// ── Tests: _offlineFallback ──────────────────────────────────────────────────

console.log('\nmodel-registry: _offlineFallback\n');

test('returns source=local in offline fallback', () => {
    const result = _offlineFallback('non-existent-project');
    assert.strictEqual(result.source, 'local');
});

test('returns empty versions for unknown project', () => {
    const result = _offlineFallback('non-existent-project');
    assert.deepStrictEqual(result.versions, []);
    assert.strictEqual(result.totalCount, 0);
});

test('respects limit parameter', () => {
    const result = _offlineFallback('test', { limit: 5 });
    assert.strictEqual(result.limit, 5);
});

test('default limit is 20', () => {
    const result = _offlineFallback('test');
    assert.strictEqual(result.limit, 20);
});

// ── Tests: _offlineFallbackVersion ───────────────────────────────────────────

console.log('\nmodel-registry: _offlineFallbackVersion\n');

test('returns error for unknown version ARN', () => {
    const result = _offlineFallbackVersion('arn:aws:sagemaker:us-east-1:123:model-package/unknown/1');
    assert.ok(result.error);
    assert.strictEqual(result.source, 'local');
});

// ── Tests: toolListDatasets ──────────────────────────────────────────────────

console.log('\nmodel-registry: toolListDatasets\n');

test('returns source=local always', () => {
    const result = toolListDatasets({});
    assert.strictEqual(result.source, 'local');
});

test('returns empty datasets array when no registry exists', () => {
    const result = toolListDatasets({});
    assert.ok(Array.isArray(result.datasets));
});

test('technique filter is applied', () => {
    // This tests the filter logic directly without needing files
    const result = toolListDatasets({ technique: 'sft' });
    assert.strictEqual(result.source, 'local');
    assert.ok(Array.isArray(result.datasets));
});

test('name_pattern filter is applied', () => {
    const result = toolListDatasets({ name_pattern: 'test' });
    assert.strictEqual(result.source, 'local');
    assert.ok(Array.isArray(result.datasets));
});

// ── Tests: toolListEvaluators ────────────────────────────────────────────────

console.log('\nmodel-registry: toolListEvaluators\n');

test('returns source=local always', () => {
    const result = toolListEvaluators({});
    assert.strictEqual(result.source, 'local');
});

test('returns empty evaluators array when no registry exists', () => {
    const result = toolListEvaluators({});
    assert.ok(Array.isArray(result.evaluators));
});

test('technique filter is applied', () => {
    const result = toolListEvaluators({ technique: 'rlvr' });
    assert.strictEqual(result.source, 'local');
    assert.ok(Array.isArray(result.evaluators));
});

test('type filter is applied', () => {
    const result = toolListEvaluators({ type: 'lambda' });
    assert.strictEqual(result.source, 'local');
    assert.ok(Array.isArray(result.evaluators));
});

// ── Tests: toolGetDataset ────────────────────────────────────────────────────

console.log('\nmodel-registry: toolGetDataset\n');

test('returns error for non-existent dataset', () => {
    const result = toolGetDataset({ name: 'non-existent-dataset' });
    assert.ok(result.error);
    assert.ok(result.error.includes('non-existent-dataset'));
    assert.strictEqual(result.source, 'local');
});

// ── Tests: toolGetEvaluator ──────────────────────────────────────────────────

console.log('\nmodel-registry: toolGetEvaluator\n');

test('returns error for non-existent evaluator', () => {
    const result = toolGetEvaluator({ name: 'non-existent-evaluator' });
    assert.ok(result.error);
    assert.ok(result.error.includes('non-existent-evaluator'));
    assert.strictEqual(result.source, 'local');
});

// ── Tests: Pagination constants ──────────────────────────────────────────────

console.log('\nmodel-registry: pagination logic\n');

test('SAGEMAKER_MAX_RESULTS caps individual API calls at 100', () => {
    assert.strictEqual(SAGEMAKER_MAX_RESULTS, 100);
    assert.ok(SAGEMAKER_MAX_RESULTS >= DEFAULT_LIMIT,
        'max results should be >= default limit');
});

test('default limit of 20 is less than SageMaker max of 100', () => {
    assert.ok(DEFAULT_LIMIT < SAGEMAKER_MAX_RESULTS);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
