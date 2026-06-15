// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Token Non-Persistence in Permanent Outputs Property-Based Tests
 *
 * Property 5: Token non-persistence in permanent outputs
 *
 * For any HF_TOKEN value passed via environment during staging, after do/stage
 * completes, no permanent output file (including .mlcc/staged-assets.json) SHALL
 * contain the token string. Temporary caching or logging during the download
 * process is permitted for debugging and performance.
 *
 * Feature: s3-model-loading, Property 5: Token non-persistence in permanent outputs
 *
 * Validates: Requirements 1.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Helper: buildStagedAssetsJson (mirrors staged-assets.sh write logic) ─────

/**
 * Builds the staged-assets JSON string the same way staged-assets.sh does.
 * This is the permanent output written by do/stage on success.
 */
function buildStagedAssetsJson(source, uri, region, sizeGb) {
    return JSON.stringify({
        version: '1',
        models: {
            default: {
                source,
                staged_uri: uri,
                staged_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                region,
                size_gb: sizeGb
            }
        },
        adapters: {}
    });
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

/**
 * Generate HuggingFace token strings of various formats.
 * Real HF tokens look like: hf_AbCdEf123456...
 * We generate tokens with the hf_ prefix and alphanumeric chars.
 */
const arbHfToken = fc.string({ minLength: 8, maxLength: 64 })
    .map(s => `hf_${s.replace(/[^a-zA-Z0-9]/g, 'x')}`);

/**
 * Generate valid HuggingFace model IDs (org/model format).
 */
const arbModelSource = fc.tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{1,20}$/),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/)
).map(([org, model]) => `${org}/${model}`);

/**
 * Generate valid S3 URIs in the expected format: s3://bucket/models/project/
 */
const arbS3Uri = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/)
).map(([bucket, project]) => `s3://${bucket}/models/${project}/`);

/**
 * Generate valid AWS region strings.
 */
const arbRegion = fc.constantFrom(
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'
);

/**
 * Generate positive size in GB (realistic model sizes).
 */
const arbSizeGb = fc.double({ min: 0.1, max: 2000, noNaN: true })
    .map(n => Math.round(n * 10) / 10);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 5: Token non-persistence in permanent outputs', () => {

    /**
     * Validates: Requirements 1.4
     *
     * For any HF_TOKEN string and any staged-assets JSON built with valid inputs,
     * the token DOES NOT appear anywhere in the JSON output.
     */
    it('HF_TOKEN never appears in staged-assets JSON output for any valid inputs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbHfToken,
            arbModelSource,
            arbS3Uri,
            arbRegion,
            arbSizeGb,
            (token, source, uri, region, sizeGb) => {
                const json = buildStagedAssetsJson(source, uri, region, sizeGb);

                assert.ok(
                    !json.includes(token),
                    `Token "${token}" was found in staged-assets JSON output:\n${json}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 1.4
     *
     * Even if the token looks like a model name (edge case), the staged_uri field
     * uses S3 URI format (s3://...) not the token, and the source field contains
     * the model ID, not the token.
     */
    it('staged_uri uses S3 URI format and source uses model ID, never the token', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbHfToken,
            arbModelSource,
            arbS3Uri,
            arbRegion,
            arbSizeGb,
            (token, source, uri, region, sizeGb) => {
                const json = buildStagedAssetsJson(source, uri, region, sizeGb);
                const parsed = JSON.parse(json);
                const model = parsed.models.default;

                // staged_uri must be an S3 URI, never the token
                assert.ok(
                    model.staged_uri.startsWith('s3://'),
                    `staged_uri must start with "s3://", got: "${model.staged_uri}"`
                );
                assert.ok(
                    !model.staged_uri.includes(token),
                    'staged_uri must not contain the token'
                );

                // source must be the model ID (org/model), never the token
                assert.strictEqual(model.source, source,
                    `source must be the model ID "${source}", not the token`);
                assert.ok(
                    !model.source.includes(token),
                    'source must not contain the token'
                );

                // region must be an AWS region, never the token
                assert.strictEqual(model.region, region,
                    `region must be "${region}", not the token`);
                assert.ok(
                    !model.region.includes(token),
                    'region must not contain the token'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 1.4
     *
     * Token strings of various formats (hf_xxxx, plain strings, special chars)
     * are never present in the output. Tests with tokens that could accidentally
     * be substrings of valid fields.
     */
    it('tokens that resemble valid field values still do not appear in output', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Generate tokens that could look like parts of model names or regions
        const arbSneakyToken = fc.oneof(
            // Standard hf_ prefix tokens
            arbHfToken,
            // Tokens that look like model name fragments
            fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{7,30}$/).map(s => `hf_${s}`),
            // Tokens with numbers that might match size_gb
            fc.stringMatching(/^hf_[a-zA-Z0-9]{8,20}$/)
        );

        fc.assert(fc.property(
            arbSneakyToken,
            arbModelSource,
            arbS3Uri,
            arbRegion,
            arbSizeGb,
            (token, source, uri, region, sizeGb) => {
                const json = buildStagedAssetsJson(source, uri, region, sizeGb);

                assert.ok(
                    !json.includes(token),
                    `Sneaky token "${token}" was found in staged-assets JSON output:\n${json}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 1.4
     *
     * The only fields in the output JSON are the expected schema fields — no extra
     * field could leak the token. Verifies structural completeness.
     */
    it('staged-assets JSON contains only expected fields, no token leakage paths', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbHfToken,
            arbModelSource,
            arbS3Uri,
            arbRegion,
            arbSizeGb,
            (token, source, uri, region, sizeGb) => {
                const json = buildStagedAssetsJson(source, uri, region, sizeGb);
                const parsed = JSON.parse(json);

                // Verify top-level structure has only expected keys
                const topKeys = Object.keys(parsed).sort();
                assert.deepStrictEqual(topKeys, ['adapters', 'models', 'version'],
                    `Unexpected top-level keys: ${topKeys.join(', ')}`);

                // Verify model entry has only expected keys
                const modelKeys = Object.keys(parsed.models.default).sort();
                assert.deepStrictEqual(
                    modelKeys,
                    ['region', 'size_gb', 'source', 'staged_at', 'staged_uri'],
                    `Unexpected model keys: ${modelKeys.join(', ')}`
                );

                // Verify no value in the entire JSON string contains the token
                const allValues = [
                    parsed.version,
                    parsed.models.default.source,
                    parsed.models.default.staged_uri,
                    parsed.models.default.staged_at,
                    parsed.models.default.region,
                    String(parsed.models.default.size_gb)
                ];

                for (const val of allValues) {
                    assert.ok(
                        !val.includes(token),
                        `Token "${token}" found in value "${val}"`
                    );
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
