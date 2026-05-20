// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Summary Aggregator Unit Tests
 *
 * Tests the summary aggregation and formatting functions:
 *   - aggregateResults: correct passed/failed counts and duration
 *   - formatMarkdown: markdown table output with all key info
 *   - formatJSON: valid JSON string output
 *
 * Validates: Requirements 5.1, 5.2, 5.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    aggregateResults,
    formatMarkdown,
    formatJSON
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
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe('E2E Summary — formatMarkdown', () => {

    it('contains the tier name', () => {
        const runResult = aggregateResults(
            [makeConfigResult()],
            makeMeta({ tier: 'nightly' })
        );

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('nightly'));
    });

    it('contains passed and failed counts', () => {
        const results = [
            makeConfigResult({ id: 'c1', status: 'pass' }),
            makeConfigResult({ id: 'c2', status: 'fail' }),
            makeConfigResult({ id: 'c3', status: 'pass' })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('2'));  // passed count
        assert.ok(md.includes('1'));  // failed count
    });

    it('contains every config ID', () => {
        const results = [
            makeConfigResult({ id: 'rt-qwen3-06b' }),
            makeConfigResult({ id: 'rt-llama-3.2-1b' }),
            makeConfigResult({ id: 'rt-ds-r1-qwen-1.5b' })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('rt-qwen3-06b'));
        assert.ok(md.includes('rt-llama-3.2-1b'));
        assert.ok(md.includes('rt-ds-r1-qwen-1.5b'));
    });

    it('contains config status indicators', () => {
        const results = [
            makeConfigResult({ id: 'c1', status: 'pass' }),
            makeConfigResult({ id: 'c2', status: 'fail' })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('pass'));
        assert.ok(md.includes('fail'));
    });

    it('contains per-step durations', () => {
        const results = [
            makeConfigResult({
                id: 'c1',
                steps: [
                    makeStepResult({ name: 'build', duration: 180000 }),
                    makeStepResult({ name: 'push', duration: 45000 })
                ]
            })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('build'));
        assert.ok(md.includes('push'));
        // Duration should be formatted
        assert.ok(md.includes('3m'));  // 180000ms = 3m 0s
    });

    it('contains markdown table separators', () => {
        const runResult = aggregateResults([makeConfigResult()], makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('|'));
        assert.ok(md.includes('---'));
    });

    it('includes error information for failed configs', () => {
        const results = [
            makeConfigResult({
                id: 'c1',
                status: 'fail',
                error: 'Build timeout after 300s'
            })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('Build timeout after 300s'));
    });

    it('includes step names in step details section', () => {
        const results = [
            makeConfigResult({
                id: 'c1',
                steps: [
                    makeStepResult({ name: 'build', status: 'pass' }),
                    makeStepResult({ name: 'deploy', status: 'fail' }),
                    makeStepResult({ name: 'clean', status: 'pass' })
                ]
            })
        ];
        const runResult = aggregateResults(results, makeMeta());

        const md = formatMarkdown(runResult);

        assert.ok(md.includes('build'));
        assert.ok(md.includes('deploy'));
        assert.ok(md.includes('clean'));
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

    it('uses 4-space indentation', () => {
        const runResult = aggregateResults([makeConfigResult()], makeMeta());

        const json = formatJSON(runResult);

        // Check that the JSON uses 4-space indentation
        assert.ok(json.includes('    "runId"'));
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
});
