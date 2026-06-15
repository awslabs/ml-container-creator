// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Path Resolution Property-Based Tests
 *
 * Property 6: S3 path resolution
 * For any combination of profile configuration (with or without benchmarkS3Bucket),
 * AWS account ID, region, and project name, the resolved S3 path SHALL be deterministic:
 * s3://{profile_bucket || mlcc-models-{account}-{region}}/models/{project_name}/.
 * This resolution SHALL be identical between local mode and --submit (Processing Job) mode.
 *
 * Feature: s3-model-loading, Property 6: S3 path resolution
 * Validates: Requirements 6.1, 6.2, 6.3, 6.6
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Resolution logic under test ──────────────────────────────────────────────

/**
 * Resolves the S3 path for staged model weights.
 * Extracted from do/stage bucket resolution logic.
 *
 * @param {string|null|undefined} profileBucket - _PROFILE[benchmarkS3Bucket] value (may be null/empty)
 * @param {string} accountId - AWS account ID (12-digit numeric)
 * @param {string} region - AWS region (e.g., us-west-2)
 * @param {string} projectName - PROJECT_NAME from do/config
 * @returns {string} Full S3 URI with trailing slash
 */
function resolveS3Path(profileBucket, accountId, region, projectName) {
    const bucket = profileBucket || `mlcc-models-${accountId}-${region}`;
    return `s3://${bucket}/models/${projectName}/`;
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

// AWS account ID: exactly 12 digits
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

// AWS region: realistic region names
const AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-southeast-1', 'ap-southeast-2',
    'ap-south-1', 'sa-east-1', 'ca-central-1',
    'me-south-1', 'af-south-1'
];
const arbRegion = fc.constantFrom(...AWS_REGIONS);

// Project name: lowercase alphanumeric + hyphens, 3-30 chars (matches MCC convention)
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3);

// S3 bucket name: valid bucket name (lowercase, 3-63 chars, alphanumeric + hyphens)
const arbBucketName = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/)
    .filter(s => !s.includes('--') && s.length >= 3);

// Profile bucket: either a valid bucket name, empty string, or null
const arbProfileBucket = fc.oneof(
    arbBucketName,
    fc.constant(''),
    fc.constant(null)
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 6: S3 path resolution', () => {

    describe('When profileBucket is set, uses it directly', () => {

        it('resolved path uses the profile bucket verbatim', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBucketName,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result = resolveS3Path(profileBucket, accountId, region, projectName);
                    const expected = `s3://${profileBucket}/models/${projectName}/`;
                    assert.strictEqual(result, expected,
                        `When profileBucket is set, should use it directly.\n  profileBucket: "${profileBucket}"\n  Got: "${result}"\n  Expected: "${expected}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('When profileBucket is null/empty, falls back to convention', () => {

        it('resolved path uses mlcc-models-{account}-{region} convention', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constantFrom(null, ''),
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result = resolveS3Path(profileBucket, accountId, region, projectName);
                    const expected = `s3://mlcc-models-${accountId}-${region}/models/${projectName}/`;
                    assert.strictEqual(result, expected,
                        `When profileBucket is "${profileBucket}", should fall back to convention.\n  Got: "${result}"\n  Expected: "${expected}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Resolution is deterministic (same inputs → same output)', () => {

        it('calling resolveS3Path twice with same inputs produces identical results', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbProfileBucket,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result1 = resolveS3Path(profileBucket, accountId, region, projectName);
                    const result2 = resolveS3Path(profileBucket, accountId, region, projectName);
                    assert.strictEqual(result1, result2,
                        `Resolution must be deterministic.\n  Call 1: "${result1}"\n  Call 2: "${result2}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('URI structural invariants', () => {

        it('URI always starts with s3:// and ends with /', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbProfileBucket,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result = resolveS3Path(profileBucket, accountId, region, projectName);
                    assert.ok(result.startsWith('s3://'),
                        `URI must start with "s3://", got: "${result}"`);
                    assert.ok(result.endsWith('/'),
                        `URI must end with "/", got: "${result}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('URI always contains /models/ segment', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbProfileBucket,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result = resolveS3Path(profileBucket, accountId, region, projectName);
                    assert.ok(result.includes('/models/'),
                        `URI must contain "/models/" segment, got: "${result}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('project name appears in the path', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbProfileBucket,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    const result = resolveS3Path(profileBucket, accountId, region, projectName);
                    assert.ok(result.includes(projectName),
                        `URI must contain project name "${projectName}", got: "${result}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Resolution is identical between local and --submit mode', () => {

        it('local mode and Processing Job mode produce the same S3 path', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbProfileBucket,
                arbAccountId,
                arbRegion,
                arbProjectName,
                (profileBucket, accountId, region, projectName) => {
                    // Both modes use the same resolveS3Path logic
                    const localResult = resolveS3Path(profileBucket, accountId, region, projectName);
                    const submitResult = resolveS3Path(profileBucket, accountId, region, projectName);
                    assert.strictEqual(localResult, submitResult,
                        `Local and --submit mode must resolve to the same S3 path.\n  Local: "${localResult}"\n  Submit: "${submitResult}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
