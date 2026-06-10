// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Benchmark Fields Unit Tests
 *
 * Tests for DynamoDB schema extension with benchmark fields.
 * Validates backward compatibility, default handling, and helper functions.
 *
 * Feature: ci-benchmark-pipeline
 * Task: 3.1 Extend DynamoDB schema with benchmark fields
 * Requirements: 7.1, 7.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    applyRecordDefaults,
    buildBenchmarkFields,
    hasBeenBenchmarked,
    isBenchmarkEnabled,
    getBenchmarkConcurrencyLevels,
    buildCiRecord
} from '../../src/lib/ci-register-helpers.js';

describe('CI Benchmark Fields - applyRecordDefaults', () => {

    it('adds benchmarkEnabled=false when field is missing', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.benchmarkEnabled, false);
    });

    it('adds benchmarkConcurrencyLevels=[1,4,8] when field is missing', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        const result = applyRecordDefaults(record);
        assert.deepStrictEqual(result.benchmarkConcurrencyLevels, [1, 4, 8]);
    });

    it('preserves existing benchmarkEnabled=true', () => {
        const record = { configId: 'abc123', testStatus: 'passed', benchmarkEnabled: true };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.benchmarkEnabled, true);
    });

    it('preserves existing benchmarkConcurrencyLevels', () => {
        const record = { configId: 'abc123', testStatus: 'passed', benchmarkConcurrencyLevels: [2, 8, 16] };
        const result = applyRecordDefaults(record);
        assert.deepStrictEqual(result.benchmarkConcurrencyLevels, [2, 8, 16]);
    });

    it('does NOT add lastBenchmarkRunId default (absence means never benchmarked)', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.lastBenchmarkRunId, undefined);
    });

    it('does NOT add lastBenchmarkTimestamp default', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.lastBenchmarkTimestamp, undefined);
    });

    it('does NOT add lastBenchmarkStatus default', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.lastBenchmarkStatus, undefined);
    });

    it('preserves existing benchmark run fields when present', () => {
        const record = {
            configId: 'abc123',
            testStatus: 'passed',
            lastBenchmarkRunId: 'bmk-20260609T143022Z',
            lastBenchmarkTimestamp: '2026-06-09T14:30:22Z',
            lastBenchmarkStatus: 'completed'
        };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.lastBenchmarkRunId, 'bmk-20260609T143022Z');
        assert.strictEqual(result.lastBenchmarkTimestamp, '2026-06-09T14:30:22Z');
        assert.strictEqual(result.lastBenchmarkStatus, 'completed');
    });

    it('handles benchmarkEnabled=null as missing (defaults to false)', () => {
        const record = { configId: 'abc123', benchmarkEnabled: null };
        const result = applyRecordDefaults(record);
        assert.strictEqual(result.benchmarkEnabled, false);
    });
});

describe('CI Benchmark Fields - buildBenchmarkFields', () => {

    it('returns correct fields for completed status', () => {
        const fields = buildBenchmarkFields('bmk-20260609T143022Z', 'completed', '2026-06-09T14:30:22Z');
        assert.strictEqual(fields.lastBenchmarkRunId, 'bmk-20260609T143022Z');
        assert.strictEqual(fields.lastBenchmarkTimestamp, '2026-06-09T14:30:22Z');
        assert.strictEqual(fields.lastBenchmarkStatus, 'completed');
    });

    it('returns correct fields for failed status', () => {
        const fields = buildBenchmarkFields('bmk-fail-001', 'failed', '2026-06-09T15:00:00Z');
        assert.strictEqual(fields.lastBenchmarkStatus, 'failed');
    });

    it('returns correct fields for in-progress status', () => {
        const fields = buildBenchmarkFields('bmk-running-001', 'in-progress', '2026-06-09T15:00:00Z');
        assert.strictEqual(fields.lastBenchmarkStatus, 'in-progress');
    });

    it('generates timestamp when not provided', () => {
        const fields = buildBenchmarkFields('bmk-20260609T143022Z', 'completed');
        assert.ok(fields.lastBenchmarkTimestamp);
        // ISO 8601 format without milliseconds
        assert.match(fields.lastBenchmarkTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('throws on invalid status', () => {
        assert.throws(
            () => buildBenchmarkFields('bmk-001', 'invalid-status'),
            /Invalid benchmark status/
        );
    });

    it('throws on empty runId', () => {
        assert.throws(
            () => buildBenchmarkFields('', 'completed'),
            /Benchmark runId is required/
        );
    });

    it('throws on null runId', () => {
        assert.throws(
            () => buildBenchmarkFields(null, 'completed'),
            /Benchmark runId is required/
        );
    });

    it('does not include testStatus or other existing fields', () => {
        const fields = buildBenchmarkFields('bmk-001', 'completed', '2026-06-09T14:30:22Z');
        assert.strictEqual(Object.keys(fields).length, 3);
        assert.ok(!('testStatus' in fields));
        assert.ok(!('configJson' in fields));
        assert.ok(!('configId' in fields));
    });
});

describe('CI Benchmark Fields - hasBeenBenchmarked', () => {

    it('returns false for record without lastBenchmarkRunId', () => {
        const record = { configId: 'abc123', testStatus: 'passed' };
        assert.strictEqual(hasBeenBenchmarked(record), false);
    });

    it('returns true for record with lastBenchmarkRunId', () => {
        const record = { configId: 'abc123', lastBenchmarkRunId: 'bmk-001' };
        assert.strictEqual(hasBeenBenchmarked(record), true);
    });

    it('returns false for null record', () => {
        assert.strictEqual(hasBeenBenchmarked(null), false);
    });

    it('returns false for undefined record', () => {
        assert.strictEqual(hasBeenBenchmarked(undefined), false);
    });

    it('returns false for empty lastBenchmarkRunId', () => {
        const record = { configId: 'abc123', lastBenchmarkRunId: '' };
        assert.strictEqual(hasBeenBenchmarked(record), false);
    });
});

describe('CI Benchmark Fields - isBenchmarkEnabled', () => {

    it('returns false when benchmarkEnabled is missing', () => {
        const record = { configId: 'abc123' };
        assert.strictEqual(isBenchmarkEnabled(record), false);
    });

    it('returns false when benchmarkEnabled is false', () => {
        const record = { configId: 'abc123', benchmarkEnabled: false };
        assert.strictEqual(isBenchmarkEnabled(record), false);
    });

    it('returns true when benchmarkEnabled is true', () => {
        const record = { configId: 'abc123', benchmarkEnabled: true };
        assert.strictEqual(isBenchmarkEnabled(record), true);
    });

    it('returns false for null record', () => {
        assert.strictEqual(isBenchmarkEnabled(null), false);
    });

    it('returns false for undefined record', () => {
        assert.strictEqual(isBenchmarkEnabled(undefined), false);
    });
});

describe('CI Benchmark Fields - getBenchmarkConcurrencyLevels', () => {

    it('returns default [1,4,8] when field is missing', () => {
        const record = { configId: 'abc123' };
        assert.deepStrictEqual(getBenchmarkConcurrencyLevels(record), [1, 4, 8]);
    });

    it('returns custom levels when set', () => {
        const record = { configId: 'abc123', benchmarkConcurrencyLevels: [2, 16, 32] };
        assert.deepStrictEqual(getBenchmarkConcurrencyLevels(record), [2, 16, 32]);
    });

    it('returns default for null record', () => {
        assert.deepStrictEqual(getBenchmarkConcurrencyLevels(null), [1, 4, 8]);
    });

    it('returns default when field is not an array', () => {
        const record = { configId: 'abc123', benchmarkConcurrencyLevels: 'invalid' };
        assert.deepStrictEqual(getBenchmarkConcurrencyLevels(record), [1, 4, 8]);
    });
});

describe('CI Benchmark Fields - backward compatibility with buildCiRecord', () => {

    it('buildCiRecord does not include benchmark fields (they are added separately)', () => {
        const record = buildCiRecord('abc123def456', '{}', {
            deploymentConfig: 'transformers-vllm',
            baseImage: 'vllm/vllm-openai:v0.8.5',
            baseImageVersion: 'v0.8.5',
            projectName: 'test-project'
        });
        // Benchmark fields should NOT be present in newly created records
        assert.strictEqual(record.lastBenchmarkRunId, undefined);
        assert.strictEqual(record.lastBenchmarkTimestamp, undefined);
        assert.strictEqual(record.lastBenchmarkStatus, undefined);
        assert.strictEqual(record.benchmarkEnabled, undefined);
        assert.strictEqual(record.benchmarkConcurrencyLevels, undefined);
    });

    it('existing records without benchmark fields can be read with applyRecordDefaults', () => {
        // Simulate a legacy record from before benchmark fields existed
        const legacyRecord = {
            configId: 'abc123def456',
            schemaVersion: 1,
            configJson: '{"test":"data"}',
            testStatus: 'passed',
            lastTestTimestamp: '2026-05-01T10:00:00Z',
            deploymentConfig: 'transformers-vllm',
            baseImage: 'vllm/vllm-openai:v0.8.5',
            baseImageVersion: 'v0.8.5',
            projectName: 'test-project',
            createdAt: '2026-01-01T00:00:00Z'
        };

        const result = applyRecordDefaults(legacyRecord);

        // Original fields preserved
        assert.strictEqual(result.testStatus, 'passed');
        assert.strictEqual(result.configId, 'abc123def456');
        assert.strictEqual(result.deploymentConfig, 'transformers-vllm');

        // Benchmark defaults applied
        assert.strictEqual(result.benchmarkEnabled, false);
        assert.deepStrictEqual(result.benchmarkConcurrencyLevels, [1, 4, 8]);

        // No phantom benchmark history
        assert.strictEqual(result.lastBenchmarkRunId, undefined);
        assert.strictEqual(result.lastBenchmarkTimestamp, undefined);
        assert.strictEqual(result.lastBenchmarkStatus, undefined);
    });
});
