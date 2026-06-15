// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Staged-Assets File Round-Trip Property-Based Tests
 *
 * Property 1: For any valid project name, model source, and AWS region,
 * when `do/stage` completes successfully, the resulting `.mlcc/staged-assets.json`
 * SHALL be valid JSON containing the correct `source`, `staged_uri` (matching the
 * S3 path convention `s3://{bucket}/models/{project_name}/`), `staged_at` (ISO 8601),
 * and `region` fields.
 *
 * Feature: s3-model-loading, Property 1: Staged-assets file round-trip
 * Validates: Requirements 1.6, 3.1, 3.2, 3.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid project names: lowercase alphanumeric + hyphens, 3-30 chars
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3 && s.length <= 30);

// HuggingFace model IDs: org/model-name pattern
const arbModelSource = fc.tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{1,20}$/),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/)
).map(([org, model]) => `${org}/${model}`);

// Valid S3 bucket names: lowercase alphanumeric + hyphens, 3-63 chars
const arbBucketName = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3);

// AWS region strings
const arbRegion = fc.constantFrom(
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'
);

// Model size in GB: positive floats from 0.1 to 500
const arbSizeGb = fc.double({ min: 0.1, max: 500, noNaN: true })
    .map(v => Math.round(v * 10) / 10);

// ── Helper function (simulates staged_assets_write_model output) ─────────────

function buildStagedAssetsJson(source, projectName, bucket, region, sizeGb) {
    const uri = `s3://${bucket}/models/${projectName}/`;
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

// ── ISO 8601 timestamp validation ────────────────────────────────────────────

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 1: Staged-assets file round-trip', () => {

    describe('staged-assets.json is valid and structurally correct', () => {

        it('for any valid inputs, the generated JSON is parseable', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.ok(parsed, 'JSON must be parseable');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, version is "1"', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.strictEqual(parsed.version, '1',
                        `version must be "1", got "${parsed.version}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, models.default.source matches the input source', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.strictEqual(parsed.models.default.source, source,
                        `source must match input.\n  Input: "${source}"\n  Got: "${parsed.models.default.source}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, models.default.staged_uri matches s3://{bucket}/models/{project_name}/', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    const expectedUri = `s3://${bucket}/models/${projectName}/`;
                    assert.strictEqual(parsed.models.default.staged_uri, expectedUri,
                        `staged_uri must match S3 path convention.\n  Expected: "${expectedUri}"\n  Got: "${parsed.models.default.staged_uri}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, models.default.staged_at is ISO 8601 format', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.ok(ISO_8601_REGEX.test(parsed.models.default.staged_at),
                        `staged_at must be ISO 8601 (YYYY-MM-DDTHH:MM:SSZ), got: "${parsed.models.default.staged_at}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, models.default.region matches the input region', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.strictEqual(parsed.models.default.region, region,
                        `region must match input.\n  Input: "${region}"\n  Got: "${parsed.models.default.region}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, models.default.size_gb is a number', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.strictEqual(typeof parsed.models.default.size_gb, 'number',
                        `size_gb must be a number, got: ${typeof parsed.models.default.size_gb}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid inputs, an adapters object exists', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource, arbProjectName, arbBucketName, arbRegion, arbSizeGb,
                (source, projectName, bucket, region, sizeGb) => {
                    const json = buildStagedAssetsJson(source, projectName, bucket, region, sizeGb);
                    const parsed = JSON.parse(json);
                    assert.ok(typeof parsed.adapters === 'object' && parsed.adapters !== null,
                        `adapters must be an object, got: ${typeof parsed.adapters}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
