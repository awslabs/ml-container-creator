// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Summary Aggregator Unit Tests
 *
 * Tests the summary aggregation, formatting, and artifact saving functions:
 *   - aggregateResults: correct passed/failed counts and duration
 *   - formatJSON: valid JSON string output with 2-space indentation
 *   - formatMarkdown: markdown output with metadata, tables, and failure details
 *   - saveArtifacts: S3 upload, local fallback, and graceful degradation
 *
 * Validates: Requirements 7.1, 7.2, 7.4, 7.5, 7.6, 7.7
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
    aggregateResults,
    formatMarkdown,
    formatJSON,
    saveArtifacts
} from '../../scripts/e2e-summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStepResult(overrides = {}) {
    return {
        name: overrides.name || 'build',
        status: overrides.status || 'pass',
        duration: overrides.duration || 100,
        ...overrides
    };
}

function makeConfigResult(overrides = {}) {
    return {
        id: overrides.id || 'rt-qwen3-4b',
        status: overrides.status || 'pass',
        duration: overrides.duration || 420,
        steps: overrides.steps || [
            makeStepResult({ name: 'build', duration: 180 }),
            makeStepResult({ name: 'push', duration: 45 }),
            makeStepResult({ name: 'deploy', duration: 150 }),
            makeStepResult({ name: 'test', duration: 8 }),
            makeStepResult({ name: 'clean', duration: 35 })
        ],
        ...overrides
    };
}

function makeMeta(overrides = {}) {
    return {
        runId: overrides.runId || '2026-05-13T16:00:00Z',
        tier: overrides.tier || 'ci',
        startTime: overrides.startTime || (Date.now() - 1847),
        ...overrides
    };
}

function makeRunResult(overrides = {}) {
    const results = overrides.results || [
        makeConfigResult({ id: 'rt-qwen3-4b', status: 'pass' }),
        makeConfigResult({
            id: 'rt-llama-3.2-1b',
            status: 'fail',
            error: 'Timeout after 300s',
            steps: [
                makeStepResult({ name: 'build', status: 'pass', duration: 180 }),
                makeStepResult({ name: 'push', status: 'pass', duration: 45 }),
                makeStepResult({ name: 'deploy', status: 'fail', duration: 300000, error: 'Timeout after 300s' }),
                makeStepResult({ name: 'clean', status: 'pass', duration: 35 })
            ]
        })
    ];

    return {
        runId: overrides.runId || 'run-2026-05-13',
        tier: overrides.tier || 'ci',
        timestamp: overrides.timestamp || '2026-05-13T16:00:00.000Z',
        duration: overrides.duration || 5000,
        passed: overrides.passed ?? results.filter(r => r.status === 'pass').length,
        failed: overrides.failed ?? results.filter(r => r.status === 'fail').length,
        results
    };
}

// ---------------------------------------------------------------------------
// aggregateResults
// ---------------------------------------------------------------------------

describe('E2E Summary — aggregateResults', () => {

    it('returns correct passed/failed counts for all passing', () => {
        const results = [
            makeConfigResult({ id: 'config-1', status: 'pass' }),
            makeConfigResult({ id: 'config-2', status: 'pass' }),
            makeConfigResult({ id: 'config-3', status: 'pass' })
        ];
        const meta = makeMeta();

        const runResult = aggregateResults(results, meta);

        assert.strictEqual(runResult.passed, 3);
        assert.strictEqual(runResult.failed, 0);
    });

    it('returns correct passed/failed counts for mixed results', () => {
        const results = [
            makeConfigResult({ id: 'config-1', status: 'pass' }),
            makeConfigResult({ id: 'config-2', status: 'fail' }),
            makeConfigResult({ id: 'config-3', status: 'pass' }),
            makeConfigResult({ id: 'config-4', status: 'fail' })
        ];
        const meta = makeMeta();

        const runResult = aggregateResults(results, meta);

        assert.strictEqual(runResult.passed, 2);
        assert.strictEqual(runResult.failed, 2);
    });

    it('returns correct passed/failed counts for all failing', () => {
        const results = [
            makeConfigResult({ id: 'config-1', status: 'fail' }),
            makeConfigResult({ id: 'config-2', status: 'fail' })
        ];
        const meta = makeMeta();

        const runResult = aggregateResults(results, meta);

        assert.strictEqual(runResult.passed, 0);
        assert.strictEqual(runResult.failed, 2);
    });

    it('returns correct counts for empty results', () => {
        const meta = makeMeta();

        const runResult = aggregateResults([], meta);

        assert.strictEqual(runResult.passed, 0);
        assert.strictEqual(runResult.failed, 0);
    });

    it('preserves runId and tier from meta', () => {
        const meta = makeMeta({ runId: 'test-run-123', tier: 'nightly' });

        const runResult = aggregateResults([], meta);

        assert.strictEqual(runResult.runId, 'test-run-123');
        assert.strictEqual(runResult.tier, 'nightly');
    });

    it('computes duration from startTime to now', () => {
        const startTime = Date.now() - 5000;
        const meta = makeMeta({ startTime });

        const runResult = aggregateResults([], meta);

        // Duration should be approximately 5000ms (allow some tolerance)
        assert.ok(runResult.duration >= 4900);
        assert.ok(runResult.duration <= 6000);
    });

    it('includes all config results in output', () => {
        const results = [
            makeConfigResult({ id: 'config-a' }),
            makeConfigResult({ id: 'config-b' }),
            makeConfigResult({ id: 'config-c' })
        ];
        const meta = makeMeta();

        const runResult = aggregateResults(results, meta);

        assert.strictEqual(runResult.results.length, 3);
        assert.strictEqual(runResult.results[0].id, 'config-a');
        assert.strictEqual(runResult.results[1].id, 'config-b');
        assert.strictEqual(runResult.results[2].id, 'config-c');
    });

    it('includes a timestamp field', () => {
        const meta = makeMeta();
        const runResult = aggregateResults([], meta);

        assert.ok(runResult.timestamp);
        // Should be a valid ISO string
        assert.ok(!isNaN(Date.parse(runResult.timestamp)));
    });
});

// ---------------------------------------------------------------------------
// formatJSON
// ---------------------------------------------------------------------------

describe('E2E Summary — formatJSON', () => {

    it('returns valid JSON', () => {
        const runResult = aggregateResults([makeConfigResult()], makeMeta());

        const json = formatJSON(runResult);
        const parsed = JSON.parse(json);

        assert.ok(parsed);
        assert.strictEqual(typeof parsed, 'object');
    });

    it('preserves all fields in JSON output', () => {
        const results = [
            makeConfigResult({ id: 'test-config', status: 'pass', duration: 500 })
        ];
        const runResult = aggregateResults(results, makeMeta({ runId: 'run-1', tier: 'ci' }));

        const json = formatJSON(runResult);
        const parsed = JSON.parse(json);

        assert.strictEqual(parsed.runId, 'run-1');
        assert.strictEqual(parsed.tier, 'ci');
        assert.strictEqual(parsed.passed, 1);
        assert.strictEqual(parsed.failed, 0);
        assert.strictEqual(parsed.results.length, 1);
        assert.strictEqual(parsed.results[0].id, 'test-config');
    });

    it('uses 2-space indentation', () => {
        const runResult = aggregateResults([makeConfigResult()], makeMeta());

        const json = formatJSON(runResult);

        // Check that the JSON uses 2-space indentation (not 4)
        assert.ok(json.includes('  "runId"'));
        assert.ok(!json.includes('    "runId"'));
    });

    it('includes per-step results in JSON', () => {
        const results = [
            makeConfigResult({
                steps: [
                    makeStepResult({ name: 'build', status: 'pass', duration: 100 }),
                    makeStepResult({ name: 'test', status: 'fail', duration: 50 })
                ]
            })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const json = formatJSON(runResult);
        const parsed = JSON.parse(json);

        assert.strictEqual(parsed.results[0].steps.length, 2);
        assert.strictEqual(parsed.results[0].steps[0].name, 'build');
        assert.strictEqual(parsed.results[0].steps[1].name, 'test');
        assert.strictEqual(parsed.results[0].steps[1].status, 'fail');
    });

    it('handles empty results array', () => {
        const runResult = aggregateResults([], makeMeta());

        const json = formatJSON(runResult);
        const parsed = JSON.parse(json);

        assert.strictEqual(parsed.results.length, 0);
        assert.strictEqual(parsed.passed, 0);
        assert.strictEqual(parsed.failed, 0);
    });

    it('includes timestamp in JSON output', () => {
        const runResult = aggregateResults([], makeMeta());

        const json = formatJSON(runResult);
        const parsed = JSON.parse(json);

        assert.ok(parsed.timestamp);
    });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe('E2E Summary — formatMarkdown', () => {

    it('contains the run metadata header with tier', () => {
        const runResult = makeRunResult({ tier: 'nightly' });

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('**Tier:** nightly'));
    });

    it('contains a timestamp in metadata', () => {
        const runResult = makeRunResult({ timestamp: '2026-05-13T16:00:00.000Z' });

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('**Timestamp:**'));
        assert.ok(md.includes('2026-05-13T16:00:00.000Z'));
    });

    it('contains duration in metadata', () => {
        const runResult = makeRunResult({ duration: 65000 });

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('**Duration:**'));
        assert.ok(md.includes('1m 5s'));
    });

    it('contains passed and failed counts in results table', () => {
        const runResult = makeRunResult({ passed: 2, failed: 1 });

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('| Passed | 2 |'));
        assert.ok(md.includes('| Failed | 1 |'));
    });

    it('contains per-config results table with ID, status, and duration', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        // Table headers
        assert.ok(md.includes('| ID | Status | Duration |'));
        assert.ok(md.includes('|----|--------|----------|'));
        // Config entries
        assert.ok(md.includes('rt-qwen3-4b'));
        assert.ok(md.includes('rt-llama-3.2-1b'));
    });

    it('contains failure details section with stage name and error', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        // Failure details section
        assert.ok(md.includes('## Failure Details'));
        assert.ok(md.includes('### rt-llama-3.2-1b'));
        assert.ok(md.includes('deploy'));
        assert.ok(md.includes('Timeout after 300s'));
    });

    it('omits failure details section when all configs pass', () => {
        const runResult = makeRunResult({
            results: [
                makeConfigResult({ id: 'c1', status: 'pass' }),
                makeConfigResult({ id: 'c2', status: 'pass' })
            ],
            passed: 2,
            failed: 0
        });

        const md = formatMarkdown(runResult);

        assert.ok(!md.includes('## Failure Details'));
    });

    it('contains markdown table separators', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('|'));
        assert.ok(md.includes('---'));
    });

    it('contains step details section with per-step info', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('## Step Details'));
        assert.ok(md.includes('| Step | Status | Duration |'));
        assert.ok(md.includes('build'));
        assert.ok(md.includes('push'));
    });

    it('includes status icons for pass and fail', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('✅'));
        assert.ok(md.includes('❌'));
    });

    it('includes error information for failed configs in step details', () => {
        const runResult = makeRunResult();

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('**Error:** Timeout after 300s'));
    });
});

// ---------------------------------------------------------------------------
// saveArtifacts — local fallback
// ---------------------------------------------------------------------------

describe('E2E Summary — saveArtifacts local fallback', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = path.join(os.tmpdir(), `mlcc-test-artifacts-${Date.now()}`);
    });

    afterEach(async () => {
        try {
            await rm(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    it('saves results.json and summary.md to local directory when saveLocal is specified', async () => {
        const runResult = makeRunResult({ runId: 'test-run-1', tier: 'ci' });

        const result = await saveArtifacts(runResult, {
            saveLocal: tmpDir
        });

        assert.ok(result.local);
        const expectedDir = path.resolve('.', tmpDir, 'ci', 'test-run-1');
        assert.strictEqual(result.local, expectedDir);

        // Verify files exist and have content
        const jsonContent = await readFile(path.join(expectedDir, 'results.json'), 'utf-8');
        const parsed = JSON.parse(jsonContent);
        assert.strictEqual(parsed.runId, 'test-run-1');
        assert.strictEqual(parsed.tier, 'ci');

        const mdContent = await readFile(path.join(expectedDir, 'summary.md'), 'utf-8');
        assert.ok(mdContent.includes('# E2E Run Summary'));
        assert.ok(mdContent.includes('test-run-1'));
    });

    it('uses default .mlcc/e2e-results path when no S3 bucket and no saveLocal', async () => {
        const runResult = makeRunResult({ runId: 'fallback-run', tier: 'nightly' });

        const result = await saveArtifacts(runResult, {
            workspaceRoot: tmpDir
        });

        assert.ok(result.local);
        assert.ok(result.local.includes('.mlcc/e2e-results'));
        assert.ok(result.local.includes('nightly'));
        assert.ok(result.local.includes('fallback-run'));

        // Verify files were written
        const jsonContent = await readFile(path.join(result.local, 'results.json'), 'utf-8');
        const parsed = JSON.parse(jsonContent);
        assert.strictEqual(parsed.runId, 'fallback-run');

        const mdContent = await readFile(path.join(result.local, 'summary.md'), 'utf-8');
        assert.ok(mdContent.includes('# E2E Run Summary'));
    });

    it('saves locally even when S3 bucket is configured and saveLocal is also specified', async () => {
        const runResult = makeRunResult({ runId: 'dual-save', tier: 'ci' });

        // S3 will fail (no real bucket), but local should still work
        const result = await saveArtifacts(runResult, {
            s3Bucket: 'nonexistent-bucket-xyz',
            saveLocal: tmpDir
        });

        // Local save should succeed regardless of S3 status
        assert.ok(result.local);
        const jsonContent = await readFile(path.join(result.local, 'results.json'), 'utf-8');
        assert.ok(jsonContent.length > 0);
    });

    it('writes both results.json and summary.md with correct content', async () => {
        const runResult = makeRunResult({ runId: 'content-check', tier: 'weekly' });

        const result = await saveArtifacts(runResult, {
            saveLocal: tmpDir
        });

        const jsonContent = await readFile(path.join(result.local, 'results.json'), 'utf-8');
        const mdContent = await readFile(path.join(result.local, 'summary.md'), 'utf-8');

        // JSON should be parseable and match formatJSON output
        const parsed = JSON.parse(jsonContent);
        assert.strictEqual(parsed.tier, 'weekly');
        assert.strictEqual(parsed.results.length, runResult.results.length);

        // Markdown should contain key sections
        assert.ok(mdContent.includes('## Results'));
        assert.ok(mdContent.includes('## Per-Config Results'));
        assert.ok(mdContent.includes('## Step Details'));
    });
});

// ---------------------------------------------------------------------------
// saveArtifacts — S3 failure graceful degradation
// ---------------------------------------------------------------------------

describe('E2E Summary — saveArtifacts S3 failure graceful degradation', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = path.join(os.tmpdir(), `mlcc-test-s3fail-${Date.now()}`);
    });

    afterEach(async () => {
        try {
            await rm(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    it('does not throw when S3 upload fails', async () => {
        const runResult = makeRunResult({ runId: 's3-fail-test', tier: 'ci' });

        // This should not throw — S3 failure is handled gracefully
        const result = await saveArtifacts(runResult, {
            s3Bucket: 'nonexistent-bucket-that-will-fail-xyz-12345',
            saveLocal: tmpDir
        });

        // S3 should have failed
        assert.strictEqual(result.s3, false);
        // Local save should still succeed
        assert.ok(result.local);
    });

    it('logs warning on S3 failure but continues to local save', async () => {
        const runResult = makeRunResult({ runId: 'graceful-degrade', tier: 'nightly' });

        // Capture console.warn output
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);

        try {
            const result = await saveArtifacts(runResult, {
                s3Bucket: 'nonexistent-bucket-xyz-99999',
                saveLocal: tmpDir
            });

            // Should have logged a warning about S3 failure
            assert.ok(warnings.some(w => w.includes('S3 upload failed')));
            // Local save should still work
            assert.ok(result.local);

            const jsonContent = await readFile(path.join(result.local, 'results.json'), 'utf-8');
            assert.ok(jsonContent.length > 0);
        } finally {
            console.warn = originalWarn;
        }
    });

    it('returns s3: false when S3 upload fails', async () => {
        const runResult = makeRunResult({ runId: 's3-status', tier: 'ci' });

        const result = await saveArtifacts(runResult, {
            s3Bucket: 'nonexistent-bucket-xyz-88888',
            saveLocal: tmpDir
        });

        assert.strictEqual(result.s3, false);
    });
});
