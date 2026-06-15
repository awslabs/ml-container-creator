// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 URI CLI Validation Property-Based Tests
 *
 * Property 3: S3 URI Accepted by CLI Validator
 *
 * For any valid S3 URI matching pattern `s3://<bucket>/<path>`, the CLI schema
 * validator SHALL accept it as a valid modelName value without error.
 *
 * Feature: ftp-benchmark-support, Property 3: S3 URI Accepted by CLI Validator
 *
 * **Validates: Requirements FTP-2 (2.5)**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { validationRules } from '../../src/lib/generated/validation-rules.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid S3 bucket name per AWS rules:
 * - 3-63 characters
 * - lowercase letters, numbers, hyphens
 * - starts and ends with a letter or number
 * - no consecutive hyphens
 */
const arbBucketName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/)
    .filter(s => !s.includes('--'));

/**
 * Generate a valid S3 key path segment:
 * - alphanumeric, hyphens, underscores, dots
 * - at least 1 character
 */
const arbPathSegment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}$/);

/**
 * Generate a valid S3 key path with 1-4 segments separated by slashes.
 */
const arbS3Path = fc.array(arbPathSegment, { minLength: 1, maxLength: 4 })
    .map(segments => segments.join('/'));

/**
 * Generate a complete valid S3 URI: s3://<bucket>/<path>
 * Optionally includes a trailing slash (common for model directories).
 */
const arbS3Uri = fc.tuple(arbBucketName, arbS3Path, fc.boolean())
    .map(([bucket, path, trailingSlash]) =>
        `s3://${bucket}/${path}${trailingSlash ? '/' : ''}`
    );

// ── Property Tests ───────────────────────────────────────────────────────────

describe('S3 URI CLI Validation Property-Based Tests', () => {

    // Feature: ftp-benchmark-support, Property 3: S3 URI Accepted by CLI Validator
    describe('Property 3: S3 URI Accepted by CLI Validator', () => {

        /**
         * Validates: Requirements FTP-2 (2.5)
         */

        it('any valid S3 URI is accepted by the modelName validation rule', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const modelNameValidator = validationRules['modelName'];
            assert.ok(modelNameValidator, 'modelName validation rule must exist');

            fc.assert(fc.property(
                arbS3Uri,
                (uri) => {
                    const error = modelNameValidator(uri);
                    assert.strictEqual(error, null,
                        `S3 URI "${uri}" should be accepted by modelName validator, but got error: "${error}"`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('S3 URIs with varied bucket names are accepted', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const modelNameValidator = validationRules['modelName'];

            fc.assert(fc.property(
                fc.tuple(
                    fc.constantFrom(
                        'my-bucket',
                        'sagemaker-benchmark-us-east-2-946952788839',
                        'ml-models-prod',
                        'a1b2c3',
                        'test-bucket-123'
                    ),
                    arbS3Path
                ),
                ([bucket, path]) => {
                    const uri = `s3://${bucket}/${path}/`;
                    const error = modelNameValidator(uri);
                    assert.strictEqual(error, null,
                        `S3 URI "${uri}" should be accepted, but got: "${error}"`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('S3 URIs with deep paths are accepted', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const modelNameValidator = validationRules['modelName'];

            fc.assert(fc.property(
                fc.tuple(
                    arbBucketName,
                    fc.array(arbPathSegment, { minLength: 1, maxLength: 6 })
                ),
                ([bucket, segments]) => {
                    const uri = `s3://${bucket}/${segments.join('/')}/`;
                    const error = modelNameValidator(uri);
                    assert.strictEqual(error, null,
                        `Deep-path S3 URI "${uri}" should be accepted, but got: "${error}"`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
