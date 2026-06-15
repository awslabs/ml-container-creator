// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 URI Round-Trip Preservation Property-Based Tests
 *
 * Property 1: For any valid S3 URI passed as modelName, the generated do/config
 * SHALL contain an export statement with MODEL_NAME set to the exact, unmodified S3 URI.
 *
 * Feature: ftp-benchmark-support, Property 1: S3 URI Round-Trip Preservation
 * Validates: Requirements FTP-2 (2.1, 2.2, 2.4)
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── EJS template snippet (from templates/do/config — transformers framework section) ──

const DO_CONFIG_MODEL_NAME_SNIPPET = [
    '# Framework-specific configuration',
    '<% if (framework === \'transformers\') { %>',
    'export MODEL_NAME="<%= modelName %>"',
    '<% } %>'
].join('\n');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// S3 bucket name: 3-63 chars, lowercase letters, numbers, hyphens, dots
// Simplified to common patterns: lowercase alphanumeric with hyphens
const arbBucketName = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3);

// S3 key path segment: alphanumeric, hyphens, underscores, dots
const arbPathSegment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}$/)
    .filter(s => s.length >= 1);

// S3 key: one or more path segments joined by /
const arbS3Key = fc.array(arbPathSegment, { minLength: 1, maxLength: 5 })
    .map(segments => segments.join('/'));

// Complete S3 URI: s3://bucket/key/ (trailing slash is common for model directories)
const arbS3Uri = fc.tuple(arbBucketName, arbS3Key)
    .map(([bucket, key]) => `s3://${bucket}/${key}/`);

// S3 URI without trailing slash (also valid)
const arbS3UriNoTrailingSlash = fc.tuple(arbBucketName, arbS3Key)
    .map(([bucket, key]) => `s3://${bucket}/${key}`);

// Either form of S3 URI
const arbAnyS3Uri = fc.oneof(arbS3Uri, arbS3UriNoTrailingSlash);

// ── Helper functions ─────────────────────────────────────────────────────────

function renderModelNameSnippet(modelName) {
    return ejs.render(DO_CONFIG_MODEL_NAME_SNIPPET, {
        framework: 'transformers',
        modelName
    });
}

function extractModelNameValue(rendered) {
    const match = rendered.match(/export MODEL_NAME="([^"]*)"/);
    return match ? match[1] : null;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: ftp-benchmark-support, Property 1: S3 URI Round-Trip Preservation', () => {

    describe('S3 URI is preserved exactly in MODEL_NAME export', () => {

        it('for any valid S3 URI with trailing slash, MODEL_NAME matches input exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbS3Uri,
                (s3Uri) => {
                    const rendered = renderModelNameSnippet(s3Uri);
                    const extractedValue = extractModelNameValue(rendered);

                    assert.ok(extractedValue !== null,
                        `rendered output must contain export MODEL_NAME="...", got: "${rendered.trim()}"`);
                    assert.strictEqual(extractedValue, s3Uri,
                        `MODEL_NAME must equal input S3 URI exactly.\n  Input:     "${s3Uri}"\n  Extracted: "${extractedValue}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid S3 URI without trailing slash, MODEL_NAME matches input exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbS3UriNoTrailingSlash,
                (s3Uri) => {
                    const rendered = renderModelNameSnippet(s3Uri);
                    const extractedValue = extractModelNameValue(rendered);

                    assert.ok(extractedValue !== null,
                        `rendered output must contain export MODEL_NAME="...", got: "${rendered.trim()}"`);
                    assert.strictEqual(extractedValue, s3Uri,
                        `MODEL_NAME must equal input S3 URI exactly.\n  Input:     "${s3Uri}"\n  Extracted: "${extractedValue}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid S3 URI (either form), MODEL_NAME preserves the s3:// prefix', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbAnyS3Uri,
                (s3Uri) => {
                    const rendered = renderModelNameSnippet(s3Uri);
                    const extractedValue = extractModelNameValue(rendered);

                    assert.ok(extractedValue !== null,
                        'rendered output must contain export MODEL_NAME="..."');
                    assert.ok(extractedValue.startsWith('s3://'),
                        `MODEL_NAME must start with "s3://", got: "${extractedValue}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('S3 URI round-trip preserves all URI components', () => {

        it('for any valid S3 URI, the bucket name is preserved in MODEL_NAME', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbBucketName, arbS3Key),
                ([bucket, key]) => {
                    const s3Uri = `s3://${bucket}/${key}/`;
                    const rendered = renderModelNameSnippet(s3Uri);
                    const extractedValue = extractModelNameValue(rendered);

                    assert.ok(extractedValue !== null,
                        'rendered output must contain export MODEL_NAME="..."');

                    // Extract bucket from the rendered MODEL_NAME
                    const extractedBucket = extractedValue.replace('s3://', '').split('/')[0];
                    assert.strictEqual(extractedBucket, bucket,
                        `bucket must be preserved. Input: "${bucket}", Extracted: "${extractedBucket}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid S3 URI, the key path is preserved in MODEL_NAME', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbBucketName, arbS3Key),
                ([bucket, key]) => {
                    const s3Uri = `s3://${bucket}/${key}/`;
                    const rendered = renderModelNameSnippet(s3Uri);
                    const extractedValue = extractModelNameValue(rendered);

                    assert.ok(extractedValue !== null,
                        'rendered output must contain export MODEL_NAME="..."');

                    // Extract key path from the rendered MODEL_NAME (everything after bucket/)
                    const afterScheme = extractedValue.replace('s3://', '');
                    const extractedKey = afterScheme.substring(afterScheme.indexOf('/') + 1);
                    // Remove trailing slash for comparison
                    const normalizedKey = extractedKey.endsWith('/') ? extractedKey.slice(0, -1) : extractedKey;
                    assert.strictEqual(normalizedKey, key,
                        `key path must be preserved. Input: "${key}", Extracted: "${normalizedKey}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('MODEL_NAME export format is correct for shell sourcing', () => {

        it('for any valid S3 URI, the export line is well-formed bash', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbAnyS3Uri,
                (s3Uri) => {
                    const rendered = renderModelNameSnippet(s3Uri);
                    // Must contain exactly one export MODEL_NAME line
                    const exportLines = rendered.split('\n')
                        .filter(line => line.trim().startsWith('export MODEL_NAME='));

                    assert.strictEqual(exportLines.length, 1,
                        `must have exactly one export MODEL_NAME line, got ${exportLines.length}`);

                    // Must be properly quoted (double quotes around value)
                    const line = exportLines[0].trim();
                    assert.ok(line.match(/^export MODEL_NAME="[^"]*"$/),
                        `export line must be properly double-quoted: "${line}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
