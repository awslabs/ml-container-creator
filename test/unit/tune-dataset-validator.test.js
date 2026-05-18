// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for tune dataset validator.
 *
 * Tests:
 * - parseDatasetArg correctly parses S3 URIs
 * - parseDatasetArg correctly parses HF references
 * - parseDatasetArg rejects invalid formats
 * - validateDatasetFormat accepts valid JSONL
 * - validateDatasetFormat rejects invalid JSONL
 * - validateDatasetFormat inspects only first 10 lines
 *
 * Validates: Requirements 3.1, 3.5, 3.6, 3.7, 3.8, 3.10, 3.11, 3.12
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { parseDatasetArg, validateDatasetFormat } from '../../src/lib/tune-dataset-validator.js';

// ── parseDatasetArg Tests ────────────────────────────────────────────────────

describe('parseDatasetArg', () => {
    describe('S3 URIs', () => {
        it('parses a simple S3 URI', () => {
            const result = parseDatasetArg('s3://my-bucket/train.jsonl');
            assert.deepStrictEqual(result, {
                valid: true,
                type: 's3',
                bucket: 'my-bucket',
                key: 'train.jsonl'
            });
        });

        it('parses an S3 URI with nested path', () => {
            const result = parseDatasetArg('s3://my-bucket/path/to/dataset.jsonl');
            assert.deepStrictEqual(result, {
                valid: true,
                type: 's3',
                bucket: 'my-bucket',
                key: 'path/to/dataset.jsonl'
            });
        });

        it('rejects S3 URI without key', () => {
            const result = parseDatasetArg('s3://my-bucket/');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('Key path is empty'));
        });

        it('rejects S3 URI without bucket', () => {
            const result = parseDatasetArg('s3:///key');
            assert.strictEqual(result.valid, false);
        });

        it('rejects S3 URI with only scheme', () => {
            const result = parseDatasetArg('s3://bucket');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('s3://bucket/key'));
        });
    });

    describe('Hugging Face references', () => {
        it('parses HF reference with org and name', () => {
            const result = parseDatasetArg('hf://my-org/my-dataset');
            assert.deepStrictEqual(result, {
                valid: true,
                type: 'hf',
                org: 'my-org',
                name: 'my-dataset',
                split: 'train'
            });
        });

        it('parses HF reference with explicit split', () => {
            const result = parseDatasetArg('hf://my-org/my-dataset/validation');
            assert.deepStrictEqual(result, {
                valid: true,
                type: 'hf',
                org: 'my-org',
                name: 'my-dataset',
                split: 'validation'
            });
        });

        it('defaults to train split when not specified', () => {
            const result = parseDatasetArg('hf://org/name');
            assert.strictEqual(result.split, 'train');
        });

        it('rejects HF reference without name', () => {
            const result = parseDatasetArg('hf://org-only');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('hf://org/name'));
        });

        it('rejects HF reference with empty org', () => {
            const result = parseDatasetArg('hf:///name');
            assert.strictEqual(result.valid, false);
        });
    });

    describe('invalid inputs', () => {
        it('rejects empty string', () => {
            const result = parseDatasetArg('');
            assert.strictEqual(result.valid, false);
        });

        it('rejects null', () => {
            const result = parseDatasetArg(null);
            assert.strictEqual(result.valid, false);
        });

        it('rejects undefined', () => {
            const result = parseDatasetArg(undefined);
            assert.strictEqual(result.valid, false);
        });

        it('rejects unknown scheme', () => {
            const result = parseDatasetArg('gs://bucket/key');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('Expected s3://'));
        });

        it('rejects plain path', () => {
            const result = parseDatasetArg('/local/path/data.jsonl');
            assert.strictEqual(result.valid, false);
        });
    });
});

// ── validateDatasetFormat Tests ──────────────────────────────────────────────

describe('validateDatasetFormat', () => {
    const sftSchema = {
        required: ['prompt', 'completion'],
        types: { prompt: 'string', completion: 'string' }
    };

    const dpoSchema = {
        required: ['prompt', 'chosen', 'rejected'],
        types: { prompt: 'string', chosen: 'string', rejected: 'string' }
    };

    const rlvrSchema = {
        required: ['prompt', 'reward_model'],
        types: { prompt: 'array', reward_model: 'string' }
    };

    describe('valid datasets', () => {
        it('accepts valid SFT JSONL', () => {
            const lines = [
                '{"prompt": "What is AI?", "completion": "AI is artificial intelligence."}',
                '{"prompt": "Hello", "completion": "Hi there!"}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.error, null);
            assert.strictEqual(result.lineNumber, null);
            assert.strictEqual(result.malformedLine, null);
        });

        it('accepts valid DPO JSONL', () => {
            const lines = [
                '{"prompt": "Explain X", "chosen": "Good answer", "rejected": "Bad answer"}'
            ];
            const result = validateDatasetFormat(lines, dpoSchema);
            assert.strictEqual(result.valid, true);
        });

        it('accepts valid RLVR JSONL with array prompt', () => {
            const lines = [
                '{"prompt": [{"role": "user", "content": "Solve 2+2"}], "reward_model": "arn:aws:lambda:us-east-1:123:function:reward"}'
            ];
            const result = validateDatasetFormat(lines, rlvrSchema);
            assert.strictEqual(result.valid, true);
        });

        it('accepts lines with extra keys beyond required', () => {
            const lines = [
                '{"prompt": "Q", "completion": "A", "metadata": {"source": "test"}}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, true);
        });

        it('skips empty lines', () => {
            const lines = [
                '{"prompt": "Q", "completion": "A"}',
                '',
                '{"prompt": "Q2", "completion": "A2"}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('invalid datasets — missing keys', () => {
        it('reports missing required key', () => {
            const lines = [
                '{"prompt": "What is AI?"}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.lineNumber, 1);
            assert.ok(result.error.includes('missing required key "completion"'));
            assert.strictEqual(result.malformedLine, lines[0]);
            assert.ok(result.expectedFormat.includes('prompt'));
            assert.ok(result.expectedFormat.includes('completion'));
        });

        it('reports first malformed line when error is on line 3', () => {
            const lines = [
                '{"prompt": "Q1", "completion": "A1"}',
                '{"prompt": "Q2", "completion": "A2"}',
                '{"prompt": "Q3"}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.lineNumber, 3);
            assert.ok(result.error.includes('Line 3'));
        });
    });

    describe('invalid datasets — wrong types', () => {
        it('reports wrong type for string field', () => {
            const lines = [
                '{"prompt": 123, "completion": "A"}'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('wrong type'));
            assert.ok(result.error.includes('"string"'));
            assert.ok(result.error.includes('"number"'));
        });

        it('reports wrong type for array field', () => {
            const lines = [
                '{"prompt": "not an array", "reward_model": "arn"}'
            ];
            const result = validateDatasetFormat(lines, rlvrSchema);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('wrong type'));
            assert.ok(result.error.includes('"array"'));
        });
    });

    describe('invalid datasets — malformed JSON', () => {
        it('reports invalid JSON', () => {
            const lines = [
                'not json at all'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.lineNumber, 1);
            assert.ok(result.error.includes('not valid JSON'));
            assert.strictEqual(result.malformedLine, 'not json at all');
        });

        it('reports non-object JSON (array)', () => {
            const lines = [
                '[1, 2, 3]'
            ];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('must be a JSON object'));
        });

        it('reports non-object JSON (null)', () => {
            const lines = ['null'];
            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('must be a JSON object'));
        });
    });

    describe('10-line inspection limit', () => {
        it('only inspects first 10 lines', () => {
            const validLines = Array.from({ length: 10 }, (_, i) =>
                `{"prompt": "Q${i}", "completion": "A${i}"}`
            );
            // Line 11 is invalid but should not be inspected
            const invalidLine = '{"prompt": "missing completion"}';
            const lines = [...validLines, invalidLine];

            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, true);
        });

        it('catches error on line 10', () => {
            const validLines = Array.from({ length: 9 }, (_, i) =>
                `{"prompt": "Q${i}", "completion": "A${i}"}`
            );
            const invalidLine = '{"prompt": "missing completion"}';
            const lines = [...validLines, invalidLine];

            const result = validateDatasetFormat(lines, sftSchema);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.lineNumber, 10);
        });
    });

    describe('edge cases', () => {
        it('returns error for null lines', () => {
            const result = validateDatasetFormat(null, sftSchema);
            assert.strictEqual(result.valid, false);
        });

        it('returns error for missing schema', () => {
            const result = validateDatasetFormat(['{}'], null);
            assert.strictEqual(result.valid, false);
        });

        it('accepts empty lines array', () => {
            const result = validateDatasetFormat([], sftSchema);
            assert.strictEqual(result.valid, true);
        });
    });
});
