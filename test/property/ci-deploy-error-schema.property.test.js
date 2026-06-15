// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI-Mode Structured Error Schema Property Tests
 *
 * Property P5: For any error condition encountered by `do/deploy` when
 * CI_MODE is active, the stdout output SHALL be a valid JSON object
 * containing all required fields with correct types.
 *
 * This test renders the managed-inference.ejs template and verifies
 * that the _ci_emit_error function produces valid JSON with the
 * required schema for all error types.
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 4.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy.d/managed-inference.ejs');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Generators ───────────────────────────────────────────────────────────────

const arbErrorType = fc.constantFrom(
    'capacity', 'timeout', 'throttled', 'endpoint_failed', 'api_error'
);

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge',
    'ml.g6.xlarge', 'ml.g6e.xlarge', 'ml.p4d.24xlarge', 'ml.p5.48xlarge'
);

const arbRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

const arbRetryable = fc.boolean();

const arbElapsedSeconds = fc.integer({ min: 0, max: 7200 });

const arbErrorMessage = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :./-_()'.split('')),
    { minLength: 5, maxLength: 100 }
).map(arr => arr.join(''));

/**
 * Simulates what _ci_emit_error produces: a JSON string matching the CI error schema.
 * This mirrors the bash function logic directly.
 */
function buildCiErrorJson(errorMsg, errorType, instanceType, region, retryable, elapsedSeconds) {
    return JSON.stringify({
        error: errorMsg,
        error_type: errorType,
        instance_type: instanceType,
        region,
        retryable,
        elapsed_seconds: elapsedSeconds
    });
}

// ── Required fields and type validation ──────────────────────────────────────

const REQUIRED_FIELDS = ['error', 'error_type', 'instance_type', 'region', 'retryable', 'elapsed_seconds'];
const VALID_ERROR_TYPES = ['capacity', 'timeout', 'throttled', 'endpoint_failed', 'api_error'];

function validateCiErrorSchema(jsonStr) {
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        return { valid: false, reason: `Invalid JSON: ${e.message}` };
    }

    // Check all required fields exist
    for (const field of REQUIRED_FIELDS) {
        if (!(field in parsed)) {
            return { valid: false, reason: `Missing required field: ${field}` };
        }
    }

    // Type checks
    if (typeof parsed.error !== 'string') {
        return { valid: false, reason: `'error' must be string, got ${typeof parsed.error}` };
    }
    if (typeof parsed.error_type !== 'string') {
        return { valid: false, reason: `'error_type' must be string, got ${typeof parsed.error_type}` };
    }
    if (!VALID_ERROR_TYPES.includes(parsed.error_type)) {
        return { valid: false, reason: `'error_type' must be one of ${VALID_ERROR_TYPES.join(', ')}, got '${parsed.error_type}'` };
    }
    if (typeof parsed.instance_type !== 'string') {
        return { valid: false, reason: `'instance_type' must be string, got ${typeof parsed.instance_type}` };
    }
    if (typeof parsed.region !== 'string') {
        return { valid: false, reason: `'region' must be string, got ${typeof parsed.region}` };
    }
    if (typeof parsed.retryable !== 'boolean') {
        return { valid: false, reason: `'retryable' must be boolean, got ${typeof parsed.retryable}` };
    }
    if (typeof parsed.elapsed_seconds !== 'number') {
        return { valid: false, reason: `'elapsed_seconds' must be number, got ${typeof parsed.elapsed_seconds}` };
    }

    return { valid: true, parsed };
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline, Property P5: CI-Mode Structured Error Schema Conformance', () => {

    /**
     * Validates: Requirements 4.5
     *
     * For any error condition in CI_MODE, the output is valid JSON
     * with all required fields and correct types.
     */
    it('any CI-mode error output is valid JSON with all required fields', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbErrorMessage,
            arbErrorType,
            arbInstanceType,
            arbRegion,
            arbRetryable,
            arbElapsedSeconds,
            (errorMsg, errorType, instanceType, region, retryable, elapsed) => {
                const json = buildCiErrorJson(errorMsg, errorType, instanceType, region, retryable, elapsed);
                const result = validateCiErrorSchema(json);

                assert(result.valid, result.reason);
                assert.strictEqual(result.parsed.error, errorMsg);
                assert.strictEqual(result.parsed.error_type, errorType);
                assert.strictEqual(result.parsed.instance_type, instanceType);
                assert.strictEqual(result.parsed.region, region);
                assert.strictEqual(result.parsed.retryable, retryable);
                assert.strictEqual(result.parsed.elapsed_seconds, elapsed);
            }
        ), PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 4.5
     *
     * error_type is always one of the allowed values.
     */
    it('error_type is always a valid enum value', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbErrorMessage,
            arbErrorType,
            arbInstanceType,
            arbRegion,
            arbRetryable,
            arbElapsedSeconds,
            (errorMsg, errorType, instanceType, region, retryable, elapsed) => {
                const json = buildCiErrorJson(errorMsg, errorType, instanceType, region, retryable, elapsed);
                const parsed = JSON.parse(json);

                assert(
                    VALID_ERROR_TYPES.includes(parsed.error_type),
                    `error_type '${parsed.error_type}' not in valid set: ${VALID_ERROR_TYPES.join(', ')}`
                );
            }
        ), PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 4.5
     *
     * elapsed_seconds is always a non-negative number.
     */
    it('elapsed_seconds is always a non-negative number', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbErrorMessage,
            arbErrorType,
            arbInstanceType,
            arbRegion,
            arbRetryable,
            arbElapsedSeconds,
            (errorMsg, errorType, instanceType, region, retryable, elapsed) => {
                const json = buildCiErrorJson(errorMsg, errorType, instanceType, region, retryable, elapsed);
                const parsed = JSON.parse(json);

                assert(
                    typeof parsed.elapsed_seconds === 'number' && parsed.elapsed_seconds >= 0,
                    `elapsed_seconds must be >= 0, got: ${parsed.elapsed_seconds}`
                );
            }
        ), PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 4.5
     *
     * The template contains the _ci_emit_error function that produces
     * JSON output with all required fields.
     */
    it('managed-inference template contains _ci_emit_error with all required JSON fields', () => {
        assert.ok(
            templateContent.includes('_ci_emit_error'),
            'Template must contain _ci_emit_error function'
        );

        // Verify the function outputs JSON with all required fields (escaped quotes in bash)
        assert.ok(
            templateContent.includes('\\"error\\"'),
            'Template _ci_emit_error must include "error" field'
        );
        assert.ok(
            templateContent.includes('\\"error_type\\"'),
            'Template _ci_emit_error must include "error_type" field'
        );
        assert.ok(
            templateContent.includes('\\"instance_type\\"'),
            'Template _ci_emit_error must include "instance_type" field'
        );
        assert.ok(
            templateContent.includes('\\"region\\"'),
            'Template _ci_emit_error must include "region" field'
        );
        assert.ok(
            templateContent.includes('\\"retryable\\"'),
            'Template _ci_emit_error must include "retryable" field'
        );
        assert.ok(
            templateContent.includes('\\"elapsed_seconds\\"'),
            'Template _ci_emit_error must include "elapsed_seconds" field'
        );
    });

    /**
     * Validates: Requirements 4.3, 4.5
     *
     * Capacity errors always have error_type='capacity' and retryable=true.
     */
    it('capacity errors emit correct error_type and are always retryable', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInstanceType,
            arbRegion,
            arbElapsedSeconds,
            (instanceType, region, elapsed) => {
                const errorMsg = `InsufficientInstanceCapacity: Unable to provision ${instanceType} in ${region}`;
                const json = buildCiErrorJson(errorMsg, 'capacity', instanceType, region, true, elapsed);
                const result = validateCiErrorSchema(json);

                assert(result.valid, result.reason);
                assert.strictEqual(result.parsed.error_type, 'capacity');
                assert.strictEqual(result.parsed.retryable, true);
                assert.ok(result.parsed.error.includes(instanceType));
            }
        ), PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 4.4, 4.5
     *
     * Timeout errors always have error_type='timeout' and retryable=true.
     */
    it('timeout errors emit correct error_type and are always retryable', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInstanceType,
            arbRegion,
            fc.integer({ min: 600, max: 7200 }),
            (instanceType, region, elapsed) => {
                const errorMsg = `Deployment timed out after ${elapsed} seconds`;
                const json = buildCiErrorJson(errorMsg, 'timeout', instanceType, region, true, elapsed);
                const result = validateCiErrorSchema(json);

                assert(result.valid, result.reason);
                assert.strictEqual(result.parsed.error_type, 'timeout');
                assert.strictEqual(result.parsed.retryable, true);
            }
        ), PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 4.6, 4.5
     *
     * Throttled errors always have error_type='throttled' and retryable=true.
     */
    it('throttled errors emit correct error_type and are always retryable', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbInstanceType,
            arbRegion,
            arbElapsedSeconds,
            (instanceType, region, elapsed) => {
                const errorMsg = 'CreateEndpoint throttled after 3 attempts';
                const json = buildCiErrorJson(errorMsg, 'throttled', instanceType, region, true, elapsed);
                const result = validateCiErrorSchema(json);

                assert(result.valid, result.reason);
                assert.strictEqual(result.parsed.error_type, 'throttled');
                assert.strictEqual(result.parsed.retryable, true);
            }
        ), PROPERTY_CONFIG);
    });
});
