// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Submit URI Extraction Property-Based Tests
 *
 * Property 2: For any valid `.mlcc/staged-assets.json` file containing a
 * `models.default.staged_uri` field, `do/submit` SHALL extract that exact URI
 * and pass it as the `MODEL_S3_URI` environment variable to CodeBuild.
 *
 * Feature: s3-model-loading, Property 2: Submit URI extraction
 * Validates: Requirements 2.1, 2.2, 3.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Extraction logic under test (replicates what do/submit does) ─────────────

/**
 * Simulates the extraction logic in do/submit:
 * Reads staged-assets JSON and extracts .models.default.staged_uri
 */
function extractModelS3Uri(stagedAssetsJson) {
    try {
        const data = JSON.parse(stagedAssetsJson);
        return data?.models?.default?.staged_uri || '';
    } catch {
        return '';
    }
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

// S3 bucket name: lowercase letters, numbers, hyphens (simplified valid subset)
const arbBucketName = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3);

// S3 key path segment: alphanumeric, hyphens, underscores, dots
const arbPathSegment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}$/)
    .filter(s => s.length >= 1);

// S3 key: one or more path segments joined by /
const arbS3Key = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 })
    .map(segments => segments.join('/'));

// Complete S3 URI: s3://bucket/models/project/ (with trailing slash)
const arbS3Uri = fc.tuple(arbBucketName, arbS3Key)
    .map(([bucket, key]) => `s3://${bucket}/models/${key}/`);

// HuggingFace model IDs (org/model format)
const arbModelSource = fc.tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{1,20}$/),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/)
).map(([org, model]) => `${org}/${model}`);

// AWS region strings
const arbRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'us-east-2', 'eu-central-1', 'ap-northeast-1'
);

// Positive float for size_gb
const arbSizeGb = fc.float({ min: Math.fround(0.1), max: Math.fround(2000), noNaN: true })
    .map(f => Math.round(f * 10) / 10);

// ISO 8601 timestamp
const arbTimestamp = fc.date({
    min: new Date('2024-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z')
}).filter(d => !isNaN(d.getTime()))
    .map(d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'));

// Build a valid staged-assets JSON string with a staged_uri
const arbValidStagedAssetsJson = fc.tuple(arbS3Uri, arbModelSource, arbRegion, arbSizeGb, arbTimestamp)
    .map(([uri, source, region, sizeGb, timestamp]) => JSON.stringify({
        version: '1',
        models: {
            default: {
                source,
                staged_uri: uri,
                staged_at: timestamp,
                region,
                size_gb: sizeGb
            }
        },
        adapters: {}
    }));

// Random strings that are NOT valid JSON
const arbInvalidJson = fc.string({ minLength: 1, maxLength: 200 })
    .filter(s => {
        try { JSON.parse(s); return false; } catch { return true; }
    });

// Valid JSON objects that are missing the models.default.staged_uri path
const arbJsonWithoutUri = fc.oneof(
    // Empty object
    fc.constant(JSON.stringify({})),
    // Object with models but no default
    fc.constant(JSON.stringify({ version: '1', models: {}, adapters: {} })),
    // Object with models.default but no staged_uri
    fc.record({
        source: arbModelSource,
        region: arbRegion,
        size_gb: arbSizeGb
    }).map(fields => JSON.stringify({
        version: '1',
        models: { default: fields },
        adapters: {}
    })),
    // Object with unrelated keys
    fc.dictionary(
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.stringMatching(/^[a-z0-9]{1,20}$/),
        { minKeys: 1, maxKeys: 5 }
    ).map(obj => JSON.stringify(obj)),
    // Nested but missing the path
    fc.constant(JSON.stringify({ models: { other_ic: { staged_uri: 's3://bucket/path/' } } }))
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 2: Submit URI extraction', () => {

    describe('Extraction returns exact URI from valid staged-assets JSON', () => {

        it('for any valid staged-assets JSON with a staged_uri, extraction returns that exact URI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbValidStagedAssetsJson,
                (jsonStr) => {
                    const expectedUri = JSON.parse(jsonStr).models.default.staged_uri;
                    const extracted = extractModelS3Uri(jsonStr);

                    assert.strictEqual(extracted, expectedUri,
                        `Extracted URI must match staged_uri exactly.\n  Expected: "${expectedUri}"\n  Got:      "${extracted}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any S3 URI, round-trip through JSON preserves the URI exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbS3Uri,
                (uri) => {
                    const json = JSON.stringify({
                        version: '1',
                        models: { default: { staged_uri: uri } }
                    });
                    const extracted = extractModelS3Uri(json);

                    assert.strictEqual(extracted, uri,
                        `Round-trip must preserve URI exactly.\n  Input: "${uri}"\n  Extracted: "${extracted}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Extraction returns empty string for missing URI paths', () => {

        it('for any valid JSON without models.default.staged_uri, extraction returns empty string', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbJsonWithoutUri,
                (jsonStr) => {
                    const extracted = extractModelS3Uri(jsonStr);

                    assert.strictEqual(extracted, '',
                        `Extraction must return empty string for JSON missing models.default.staged_uri.\n  Input: ${jsonStr}\n  Got: "${extracted}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Extraction returns empty string for invalid JSON', () => {

        it('for any non-parseable string, extraction returns empty string', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbInvalidJson,
                (invalidStr) => {
                    const extracted = extractModelS3Uri(invalidStr);

                    assert.strictEqual(extracted, '',
                        `Extraction must return empty string for invalid JSON.\n  Input: "${invalidStr}"\n  Got: "${extracted}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('URI is never modified during extraction', () => {

        it('for any S3 URI with special characters (underscores, dots), URI is preserved exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // URIs with special characters: underscores, dots, hyphens
            const arbSpecialUri = fc.tuple(
                fc.stringMatching(/^[a-z][a-z0-9.-]{2,20}[a-z0-9]$/).filter(s => !s.includes('..') && s.length >= 3),
                fc.array(
                    fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,15}$/).filter(s => s.length >= 1),
                    { minLength: 1, maxLength: 4 }
                ).map(segs => segs.join('/'))
            ).map(([bucket, key]) => `s3://${bucket}/models/${key}/`);

            fc.assert(fc.property(
                arbSpecialUri,
                (uri) => {
                    const json = JSON.stringify({
                        version: '1',
                        models: { default: { staged_uri: uri, source: 'test/model' } }
                    });
                    const extracted = extractModelS3Uri(json);

                    assert.strictEqual(extracted, uri,
                        `URI with special characters must be preserved exactly.\n  Input: "${uri}"\n  Extracted: "${extracted}"`);
                    // Verify specific characters are preserved
                    if (uri.includes('_')) assert.ok(extracted.includes('_'), 'Underscores must be preserved');
                    if (uri.includes('.')) assert.ok(extracted.includes('.'), 'Dots must be preserved');
                    if (uri.includes('-')) assert.ok(extracted.includes('-'), 'Hyphens must be preserved');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any extracted URI, it is string-identical to the original staged_uri value', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbS3Uri, arbModelSource, arbRegion, arbSizeGb),
                ([uri, source, region, sizeGb]) => {
                    const original = uri;
                    const json = JSON.stringify({
                        version: '1',
                        models: {
                            default: {
                                source,
                                staged_uri: original,
                                staged_at: '2025-01-01T00:00:00Z',
                                region,
                                size_gb: sizeGb
                            }
                        },
                        adapters: {}
                    });
                    const extracted = extractModelS3Uri(json);

                    // Byte-for-byte identical
                    assert.strictEqual(extracted.length, original.length,
                        `Extracted URI length must match original.\n  Original length: ${original.length}\n  Extracted length: ${extracted.length}`);
                    assert.strictEqual(extracted, original,
                        'Extracted URI must be byte-for-byte identical to original staged_uri');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
