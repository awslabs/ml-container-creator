// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Missing Field Detection Property-Based Tests
 *
 * Property 9: Missing required field produces named error
 *
 * For any required field in the training config schema (image, script,
 * instance_type, dataset, output_path), if that field is absent from
 * the config, the validation function SHALL produce an error message
 * that names the specific missing field.
 *
 * Feature: fine-tuning-training, Property 9: Missing required field produces named error
 * Validates: Requirements 2.12, 10.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import {
    validateRequiredFields,
    REQUIRED_FIELDS
} from '../../src/lib/train-config-validator.js';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid ECR image URI.
 */
const ecrImageArb = fc.tuple(
    fc.stringMatching(/^[0-9]{12}$/),
    fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,10}$/)
).map(([account, region, repo, tag]) =>
    `${account}.dkr.ecr.${region}.amazonaws.com/${repo}:${tag}`
);

/**
 * Generate a valid S3 path.
 */
const s3PathArb = fc.tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9.-]{2,20}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9/_.-]{1,30}$/)
).map(([bucket, key]) => `s3://${bucket}/${key}`);

/**
 * Generate a valid SageMaker instance type.
 */
const instanceTypeArb = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.m5.4xlarge',
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge',
    'ml.p3.2xlarge', 'ml.p4d.24xlarge'
);

/**
 * Generate a complete valid training config with all required fields.
 */
const validConfigArb = fc.record({
    image: ecrImageArb,
    script: s3PathArb,
    instance_type: instanceTypeArb,
    dataset: s3PathArb,
    output_path: s3PathArb
});

/**
 * Generate a required field name to remove.
 */
const requiredFieldArb = fc.constantFrom(...Object.keys(REQUIRED_FIELDS));

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: fine-tuning-training, Property 9: Missing required field produces named error', () => {

    it('removing any single required field produces an error naming that field', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validConfigArb,
            requiredFieldArb,
            (config, fieldToRemove) => {
                // Create a config with one required field removed
                const incompleteConfig = { ...config };
                delete incompleteConfig[fieldToRemove];

                const result = validateRequiredFields(incompleteConfig);

                // Validation must fail
                assert.strictEqual(result.valid, false,
                    `Config missing "${fieldToRemove}" must fail validation`);

                // There must be at least one error
                assert.ok(result.errors.length > 0,
                    `Config missing "${fieldToRemove}" must produce at least one error`);

                // The error must name the specific missing field
                const fieldError = result.errors.find(e => e.field === fieldToRemove);
                assert.ok(fieldError,
                    `Errors must include an entry for the missing field "${fieldToRemove}". ` +
                    `Got fields: ${result.errors.map(e => e.field).join(', ')}`);

                // The error message must contain the field name
                assert.ok(fieldError.message.includes(fieldToRemove),
                    `Error message must contain the field name "${fieldToRemove}". ` +
                    `Got: "${fieldError.message}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('setting any single required field to empty string produces an error naming that field', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validConfigArb,
            requiredFieldArb,
            (config, fieldToEmpty) => {
                // Create a config with one required field set to empty string
                const incompleteConfig = { ...config, [fieldToEmpty]: '' };

                const result = validateRequiredFields(incompleteConfig);

                // Validation must fail
                assert.strictEqual(result.valid, false,
                    `Config with empty "${fieldToEmpty}" must fail validation`);

                // The error must name the specific field
                const fieldError = result.errors.find(e => e.field === fieldToEmpty);
                assert.ok(fieldError,
                    `Errors must include an entry for the empty field "${fieldToEmpty}". ` +
                    `Got fields: ${result.errors.map(e => e.field).join(', ')}`);

                // The error message must contain the field name
                assert.ok(fieldError.message.includes(fieldToEmpty),
                    `Error message must contain the field name "${fieldToEmpty}". ` +
                    `Got: "${fieldError.message}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('setting any single required field to null produces an error naming that field', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validConfigArb,
            requiredFieldArb,
            (config, fieldToNull) => {
                // Create a config with one required field set to null
                const incompleteConfig = { ...config, [fieldToNull]: null };

                const result = validateRequiredFields(incompleteConfig);

                // Validation must fail
                assert.strictEqual(result.valid, false,
                    `Config with null "${fieldToNull}" must fail validation`);

                // The error must name the specific field
                const fieldError = result.errors.find(e => e.field === fieldToNull);
                assert.ok(fieldError,
                    `Errors must include an entry for the null field "${fieldToNull}". ` +
                    `Got fields: ${result.errors.map(e => e.field).join(', ')}`);

                // The error message must contain the field name
                assert.ok(fieldError.message.includes(fieldToNull),
                    `Error message must contain the field name "${fieldToNull}". ` +
                    `Got: "${fieldError.message}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('a complete valid config passes validation with no errors', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validConfigArb,
            (config) => {
                const result = validateRequiredFields(config);

                assert.strictEqual(result.valid, true,
                    `Complete config must pass validation. Errors: ${JSON.stringify(result.errors)}`);
                assert.strictEqual(result.errors.length, 0,
                    `Complete config must produce zero errors. Got: ${JSON.stringify(result.errors)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('removing multiple required fields produces errors naming each missing field', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            validConfigArb,
            fc.subarray(Object.keys(REQUIRED_FIELDS), { minLength: 2 }),
            (config, fieldsToRemove) => {
                // Create a config with multiple required fields removed
                const incompleteConfig = { ...config };
                for (const field of fieldsToRemove) {
                    delete incompleteConfig[field];
                }

                const result = validateRequiredFields(incompleteConfig);

                // Validation must fail
                assert.strictEqual(result.valid, false,
                    `Config missing ${fieldsToRemove.join(', ')} must fail validation`);

                // Each removed field must have a corresponding error
                for (const field of fieldsToRemove) {
                    const fieldError = result.errors.find(e => e.field === field);
                    assert.ok(fieldError,
                        `Errors must include an entry for missing field "${field}". ` +
                        `Got fields: ${result.errors.map(e => e.field).join(', ')}`);
                    assert.ok(fieldError.message.includes(field),
                        `Error message for "${field}" must contain the field name. ` +
                        `Got: "${fieldError.message}"`);
                }

                // Number of errors must match number of removed fields
                assert.strictEqual(result.errors.length, fieldsToRemove.length,
                    `Number of errors (${result.errors.length}) must equal number of ` +
                    `removed fields (${fieldsToRemove.length})`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('an empty config object produces errors for all required fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const result = validateRequiredFields({});

        assert.strictEqual(result.valid, false,
            'Empty config must fail validation');
        assert.strictEqual(result.errors.length, Object.keys(REQUIRED_FIELDS).length,
            `Empty config must produce ${Object.keys(REQUIRED_FIELDS).length} errors`);

        for (const field of Object.keys(REQUIRED_FIELDS)) {
            const fieldError = result.errors.find(e => e.field === field);
            assert.ok(fieldError,
                `Errors must include an entry for "${field}"`);
            assert.ok(fieldError.message.includes(field),
                `Error message must contain "${field}"`);
        }
    });

    it('a null/undefined config produces errors for all required fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const resultNull = validateRequiredFields(null);
        assert.strictEqual(resultNull.valid, false,
            'Null config must fail validation');
        assert.strictEqual(resultNull.errors.length, Object.keys(REQUIRED_FIELDS).length,
            'Null config must produce errors for all required fields');

        const resultUndefined = validateRequiredFields(undefined);
        assert.strictEqual(resultUndefined.valid, false,
            'Undefined config must fail validation');
        assert.strictEqual(resultUndefined.errors.length, Object.keys(REQUIRED_FIELDS).length,
            'Undefined config must produce errors for all required fields');
    });
});
