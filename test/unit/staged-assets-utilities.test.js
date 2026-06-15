// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for staged-assets.sh utility functions.
 *
 * Tests the JSON logic of staged_assets_write_model and staged_assets_read_model_uri
 * by replicating the behavior in JavaScript. The actual functions are bash (using jq),
 * so we validate the JSON schema contract and read/write semantics here.
 *
 * Feature: s3-model-loading
 * Validates: Requirements 3.1, 3.2, 3.4
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';

// ── Replicated utilities (mirror staged-assets.sh behavior) ──────────────────

/**
 * Simulates staged_assets_write_model behavior.
 * Creates or updates the staged-assets JSON structure with a model entry.
 *
 * @param {string|null} existingJson - Current file content (null if no file)
 * @param {string} source - HuggingFace model ID
 * @param {string} uri - S3 URI where the model was staged
 * @param {string} region - AWS region
 * @param {number} sizeGb - Model size in GB
 * @param {string} [icName='default'] - Inference Component name (key in models)
 * @returns {string} Updated JSON string
 */
function writeModel(existingJson, source, uri, region, sizeGb, icName = 'default') {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const base = existingJson ? JSON.parse(existingJson) : { version: '1', models: {}, adapters: {} };
    base.models[icName] = { source, staged_uri: uri, staged_at: timestamp, region, size_gb: sizeGb };
    return JSON.stringify(base, null, 2);
}

/**
 * Simulates staged_assets_read_model_uri behavior.
 * Reads the staged S3 URI for the default model from JSON content.
 *
 * @param {string|null} json - File content (null/empty if no file)
 * @returns {string} S3 URI or empty string
 */
function readModelUri(json) {
    if (!json) return '';
    try {
        const data = JSON.parse(json);
        return data?.models?.default?.staged_uri || '';
    } catch {
        return '';
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Staged-assets utilities (Requirements 3.1, 3.2, 3.4)', () => {

    describe('staged_assets_write_model creates valid JSON', () => {

        it('produces valid JSON parseable without error', () => {
            const result = writeModel(
                null,
                'meta-llama/Llama-3.1-8B-Instruct',
                's3://mlcc-models-123456789012-us-west-2/models/llama-8b-vllm/',
                'us-west-2',
                16.2
            );

            // Must not throw
            const parsed = JSON.parse(result);
            assert.ok(parsed, 'Result must be valid JSON');
        });

        it('contains all required fields with correct values', () => {
            const result = writeModel(
                null,
                'google/gemma-4-31b-it',
                's3://my-bucket/models/gemma-31b/',
                'eu-west-1',
                62.5
            );

            const parsed = JSON.parse(result);

            assert.equal(parsed.version, '1');
            assert.equal(parsed.models.default.source, 'google/gemma-4-31b-it');
            assert.equal(parsed.models.default.staged_uri, 's3://my-bucket/models/gemma-31b/');
            assert.equal(parsed.models.default.region, 'eu-west-1');
            assert.equal(parsed.models.default.size_gb, 62.5);
            assert.ok(typeof parsed.models.default.staged_at === 'string');
            assert.ok(parsed.adapters !== undefined, 'adapters key must exist');
        });

        it('staged_at is ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)', () => {
            const result = writeModel(
                null,
                'Qwen/Qwen3-0.6B',
                's3://bucket/models/qwen/',
                'us-east-1',
                1.2
            );

            const parsed = JSON.parse(result);
            const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
            assert.match(parsed.models.default.staged_at, iso8601Pattern,
                `staged_at should be ISO 8601, got: "${parsed.models.default.staged_at}"`);
        });

        it('size_gb is stored as a number, not a string', () => {
            const result = writeModel(null, 'org/model', 's3://b/m/', 'us-east-1', 7.8);
            const parsed = JSON.parse(result);
            assert.equal(typeof parsed.models.default.size_gb, 'number');
        });
    });

    describe('staged_assets_read_model_uri returns empty string when no file exists', () => {

        it('returns empty string when json is null', () => {
            assert.equal(readModelUri(null), '');
        });

        it('returns empty string when json is empty string', () => {
            assert.equal(readModelUri(''), '');
        });

        it('returns empty string when json is undefined', () => {
            assert.equal(readModelUri(undefined), '');
        });
    });

    describe('staged_assets_read_model_uri returns correct URI from populated file', () => {

        it('extracts staged_uri from a valid staged-assets JSON', () => {
            const json = JSON.stringify({
                version: '1',
                models: {
                    default: {
                        source: 'meta-llama/Llama-3.1-8B-Instruct',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/llama-8b/',
                        staged_at: '2025-01-15T10:30:00Z',
                        region: 'us-west-2',
                        size_gb: 16.2
                    }
                },
                adapters: {}
            });

            assert.equal(
                readModelUri(json),
                's3://mlcc-models-123456789012-us-west-2/models/llama-8b/'
            );
        });

        it('returns the URI written by writeModel', () => {
            const expectedUri = 's3://my-bucket/models/my-project/';
            const json = writeModel(null, 'org/model', expectedUri, 'us-east-1', 5.0);
            assert.equal(readModelUri(json), expectedUri);
        });
    });

    describe('staged_assets_read_model_uri handles invalid JSON', () => {

        it('returns empty string for invalid JSON', () => {
            assert.equal(readModelUri('not valid json {{{'), '');
        });

        it('returns empty string for JSON without models key', () => {
            assert.equal(readModelUri(JSON.stringify({ version: '1' })), '');
        });

        it('returns empty string for JSON without default model', () => {
            const json = JSON.stringify({ version: '1', models: {}, adapters: {} });
            assert.equal(readModelUri(json), '');
        });

        it('returns empty string for JSON with null staged_uri', () => {
            const json = JSON.stringify({
                version: '1',
                models: { default: { source: 'org/m', staged_uri: null } },
                adapters: {}
            });
            assert.equal(readModelUri(json), '');
        });
    });

    describe('schema supports multiple models keyed by IC name without overwriting', () => {

        it('writing a second model preserves the first', () => {
            // Write the default model
            let json = writeModel(
                null,
                'meta-llama/Llama-3.1-8B-Instruct',
                's3://bucket/models/llama-8b/',
                'us-west-2',
                16.2,
                'default'
            );

            // Write a second model with a different IC name
            json = writeModel(
                json,
                'Qwen/Qwen3-4B',
                's3://bucket/models/qwen-4b/',
                'us-west-2',
                8.5,
                'second-ic'
            );

            const parsed = JSON.parse(json);

            // Both models must be present
            assert.equal(Object.keys(parsed.models).length, 2);

            // First model is preserved
            assert.equal(parsed.models.default.source, 'meta-llama/Llama-3.1-8B-Instruct');
            assert.equal(parsed.models.default.staged_uri, 's3://bucket/models/llama-8b/');
            assert.equal(parsed.models.default.region, 'us-west-2');
            assert.equal(parsed.models.default.size_gb, 16.2);

            // Second model is correct
            assert.equal(parsed.models['second-ic'].source, 'Qwen/Qwen3-4B');
            assert.equal(parsed.models['second-ic'].staged_uri, 's3://bucket/models/qwen-4b/');
            assert.equal(parsed.models['second-ic'].region, 'us-west-2');
            assert.equal(parsed.models['second-ic'].size_gb, 8.5);
        });

        it('writing a third model preserves all previous models', () => {
            let json = writeModel(null, 'org/model-a', 's3://b/a/', 'us-east-1', 10, 'ic-a');
            json = writeModel(json, 'org/model-b', 's3://b/b/', 'us-east-1', 20, 'ic-b');
            json = writeModel(json, 'org/model-c', 's3://b/c/', 'us-east-1', 30, 'ic-c');

            const parsed = JSON.parse(json);
            assert.equal(Object.keys(parsed.models).length, 3);
            assert.equal(parsed.models['ic-a'].source, 'org/model-a');
            assert.equal(parsed.models['ic-b'].source, 'org/model-b');
            assert.equal(parsed.models['ic-c'].source, 'org/model-c');
        });

        it('version and adapters are preserved across writes', () => {
            let json = writeModel(null, 'org/m1', 's3://b/m1/', 'us-west-2', 5, 'default');
            json = writeModel(json, 'org/m2', 's3://b/m2/', 'us-west-2', 10, 'other-ic');

            const parsed = JSON.parse(json);
            assert.equal(parsed.version, '1');
            assert.deepEqual(parsed.adapters, {});
        });

        it('overwriting the same IC name updates without creating duplicates', () => {
            let json = writeModel(null, 'org/old-model', 's3://b/old/', 'us-east-1', 5, 'default');
            json = writeModel(json, 'org/new-model', 's3://b/new/', 'us-west-2', 10, 'default');

            const parsed = JSON.parse(json);
            assert.equal(Object.keys(parsed.models).length, 1);
            assert.equal(parsed.models.default.source, 'org/new-model');
            assert.equal(parsed.models.default.staged_uri, 's3://b/new/');
            assert.equal(parsed.models.default.region, 'us-west-2');
            assert.equal(parsed.models.default.size_gb, 10);
        });
    });
});
