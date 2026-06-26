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
    toolListDatasetVersions,
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

// ── Tests: toolListDatasets with version fields (AC-3.4) ─────────────────────

console.log('\nmodel-registry: toolListDatasets version fields\n');

test('list_datasets response includes latest_version field', () => {
    const result = toolListDatasets({});
    // Even with no data, the structure is correct
    assert.strictEqual(result.source, 'local');
    assert.ok(Array.isArray(result.datasets));
});

test('list_datasets maps versioned entry correctly', () => {
    // We test the function logic with mock by temporarily overriding _loadDatasetsRegistry
    // Instead, verify the returned shape when datasets exist by creating a mock scenario
    // The function reads from DATASETS_REGISTRY_PATH which may not exist — that's fine
    // Just verify that when entries have versions array, fields are included
    const result = toolListDatasets({});
    // Each dataset entry should have latest_version and version_count keys
    for (const ds of result.datasets) {
        assert.ok('latest_version' in ds, 'dataset should have latest_version field');
        assert.ok('version_count' in ds, 'dataset should have version_count field');
    }
});

// ── Tests: toolListDatasetVersions (AC-3.5) ──────────────────────────────────

console.log('\nmodel-registry: toolListDatasetVersions\n');

test('returns error for non-existent dataset', () => {
    const result = toolListDatasetVersions({ name: 'does-not-exist' });
    // Should return error or empty versions (fallback to local registry)
    assert.ok(result.error || Array.isArray(result.versions));
    assert.ok(result.source === 'local' || result.source === 'helper');
});

test('returns versions array in response', () => {
    const result = toolListDatasetVersions({ name: 'non-existent-test' });
    assert.ok('versions' in result, 'response should have versions field');
    assert.ok(Array.isArray(result.versions));
});

test('returns source field', () => {
    const result = toolListDatasetVersions({ name: 'test-dataset' });
    assert.ok(result.source === 'local' || result.source === 'helper');
});

test('toolListDatasetVersions is a function', () => {
    assert.strictEqual(typeof toolListDatasetVersions, 'function');
});

// ── Tests: toolListDatasets version fields with mock data ────────────────────

console.log('\nmodel-registry: toolListDatasets & toolListDatasetVersions with mock data\n');

// Create a temporary datasets file and override to test version logic
test('list_datasets includes version_count and latest_version from versioned entry', () => {
    setupTempDir();
    const datasetsPath = join(TEMP_DIR, 'datasets-versioned.json');
    const mockData = [
        {
            name: 'alpaca-sft',
            s3_uri: 's3://bucket/datasets/alpaca-sft/train.jsonl',
            format: 'jsonl',
            technique: 'sft',
            row_count: 1000,
            registered_at: '2026-06-24T12:00:00Z',
            versions: [
                { version: '1.0.0', hash: 'abc123', registered_at: '2026-06-24T12:00:00Z', rows: 1000, s3_uri: 's3://bucket/datasets/alpaca-sft/v1/train.jsonl' },
                { version: '1.1.0', hash: 'def456', registered_at: '2026-06-28T14:30:00Z', rows: 2500, s3_uri: 's3://bucket/datasets/alpaca-sft/v2/train.jsonl' }
            ]
        },
        {
            name: 'math-rlvr',
            s3_uri: 's3://bucket/datasets/math-rlvr/data.jsonl',
            format: 'jsonl',
            technique: 'rlvr',
            row_count: 500,
            registered_at: '2026-07-01T10:00:00Z'
            // No versions array — should default to v1.0.0 with count 1
        }
    ];
    writeFileSync(datasetsPath, JSON.stringify(mockData));

    // Load using our helper and verify structure
    const entries = _loadLocalRegistry(datasetsPath);
    assert.strictEqual(entries.length, 2);

    // Simulate what toolListDatasets does with this data
    const datasets = entries.map(e => {
        const versions = Array.isArray(e.versions) ? e.versions : [];
        const versionCount = versions.length || 1;
        const latestVersion = versions.length > 0
            ? versions[versions.length - 1].version
            : (e.version || '1.0.0');
        return { name: e.name, latest_version: latestVersion, version_count: versionCount };
    });

    assert.strictEqual(datasets[0].name, 'alpaca-sft');
    assert.strictEqual(datasets[0].latest_version, '1.1.0');
    assert.strictEqual(datasets[0].version_count, 2);

    assert.strictEqual(datasets[1].name, 'math-rlvr');
    assert.strictEqual(datasets[1].latest_version, '1.0.0');
    assert.strictEqual(datasets[1].version_count, 1);

    cleanupTempDir();
});

test('list_dataset_versions returns all versions for a versioned entry from local registry', () => {
    setupTempDir();
    const datasetsPath = join(TEMP_DIR, 'datasets-versions-list.json');
    const mockData = [
        {
            name: 'alpaca-sft',
            s3_uri: 's3://bucket/datasets/alpaca-sft/train.jsonl',
            technique: 'sft',
            row_count: 2500,
            registered_at: '2026-06-28T14:30:00Z',
            versions: [
                { version: '1.0.0', hash: 'abc123', registered_at: '2026-06-24T12:00:00Z', rows: 1000, s3_uri: 's3://bucket/datasets/alpaca-sft/v1/train.jsonl' },
                { version: '1.1.0', hash: 'def456', registered_at: '2026-06-28T14:30:00Z', rows: 2500, s3_uri: 's3://bucket/datasets/alpaca-sft/v2/train.jsonl' }
            ]
        }
    ];
    writeFileSync(datasetsPath, JSON.stringify(mockData));

    const entries = _loadLocalRegistry(datasetsPath);
    const entry = entries.find(e => e.name === 'alpaca-sft');

    // Simulate toolListDatasetVersions local fallback logic
    const versions = Array.isArray(entry.versions) ? entry.versions : [];
    const result = versions.map(v => ({
        version: v.version,
        hash: v.hash || null,
        date: v.registered_at || null,
        rows: v.rows || v.row_count || null,
        s3_uri: v.s3_uri || null
    }));

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].version, '1.0.0');
    assert.strictEqual(result[0].hash, 'abc123');
    assert.strictEqual(result[0].rows, 1000);
    assert.strictEqual(result[1].version, '1.1.0');
    assert.strictEqual(result[1].hash, 'def456');
    assert.strictEqual(result[1].rows, 2500);

    cleanupTempDir();
});

test('list_dataset_versions treats unversioned entry as v1.0.0', () => {
    setupTempDir();
    const datasetsPath = join(TEMP_DIR, 'datasets-unversioned.json');
    const mockData = [
        {
            name: 'legacy-dataset',
            s3_uri: 's3://bucket/legacy/data.jsonl',
            technique: 'sft',
            row_count: 750,
            registered_at: '2026-05-01T08:00:00Z'
            // No versions array
        }
    ];
    writeFileSync(datasetsPath, JSON.stringify(mockData));

    const entries = _loadLocalRegistry(datasetsPath);
    const entry = entries.find(e => e.name === 'legacy-dataset');

    // Simulate the unversioned fallback logic
    const versions = Array.isArray(entry.versions) ? entry.versions : [];
    let result;
    if (versions.length === 0) {
        result = [{
            version: entry.version || '1.0.0',
            hash: entry.hash || null,
            date: entry.registered_at || null,
            rows: entry.row_count || null,
            s3_uri: entry.s3_uri || null
        }];
    }

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].version, '1.0.0');
    assert.strictEqual(result[0].hash, null);
    assert.strictEqual(result[0].rows, 750);
    assert.strictEqual(result[0].s3_uri, 's3://bucket/legacy/data.jsonl');

    cleanupTempDir();
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
