// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parameter Schema Violation Property-Based Tests
 *
 * Property 2: Schema violation produces constraint-referencing error
 *
 * For any infrastructure parameter and for any value that violates the
 * constraints defined in the Parameter_Schema (below min, above max, wrong
 * type, pattern mismatch), the ConfigManager SHALL return a validation error
 * whose message references the specific constraint definition (parameter name,
 * constraint type, and API reference) rather than a generic "invalid value"
 * message.
 *
 * Feature: cli-config-parameters, Property 2
 *
 * **Validates: Requirements 1.5, 2.6, 10.6**
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ParameterSchemaValidator from '../../src/lib/parameter-schema-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Schema loading ───────────────────────────────────────────────────────────

const schemaPath = resolve(__dirname, '../../config/parameter-schema-v2.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// ── Parameter definitions ────────────────────────────────────────────────────

/**
 * Integer parameters with their schema constraints and API references.
 * API references match the AWS API action paths used by ParameterSchemaValidator.
 */
const INTEGER_PARAMS = [
    {
        name: 'endpointInitialInstanceCount',
        min: 1,
        max: 100,
        apiReference: 'CreateEndpointConfig.ProductionVariants.InitialInstanceCount'
    },
    {
        name: 'endpointDataCapturePercent',
        min: 0,
        max: 100,
        apiReference: 'CreateEndpointConfig.DataCaptureConfig.InitialSamplingPercentage'
    },
    {
        name: 'endpointVolumeSize',
        min: 1,
        max: 16384,
        apiReference: 'CreateEndpointConfig.ProductionVariants.VolumeSizeInGB'
    },
    {
        name: 'icMemorySize',
        min: 128,
        max: 3145728,
        apiReference: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.MinMemoryRequiredInMb'
    },
    {
        name: 'icGpuCount',
        min: 0,
        max: 8,
        apiReference: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired'
    },
    {
        name: 'icCopyCount',
        min: 0,
        max: 100,
        apiReference: 'CreateInferenceComponent.RuntimeConfig.CopyCount'
    }
];

/**
 * Number (float) parameters with their schema constraints and API references.
 * API references match the AWS API action paths used by ParameterSchemaValidator.
 */
const NUMBER_PARAMS = [
    {
        name: 'icCpuCount',
        min: 0.25,
        max: 768,
        apiReference: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.NumberOfCpuCoresRequired'
    },
    {
        name: 'icModelWeight',
        min: 0,
        max: 1,
        apiReference: 'CreateInferenceComponent.RuntimeConfig.ModelWeight'
    }
];

/**
 * String parameters with pattern constraints.
 * API references match the AWS API action paths used by ParameterSchemaValidator.
 */
const STRING_PARAMS = [
    {
        name: 'endpointVariantName',
        pattern: '^[a-zA-Z0-9]([\\w-]{0,62}[a-zA-Z0-9])?$',
        apiReference: 'CreateEndpointConfig.ProductionVariants.VariantName'
    }
];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate an integer value below the minimum bound.
 */
function arbBelowMin(min) {
    return fc.integer({ min: min - 1000, max: min - 1 });
}

/**
 * Generate an integer value above the maximum bound.
 */
function arbAboveMax(max) {
    return fc.integer({ min: max + 1, max: max + 1000 });
}

/**
 * Generate a number (float) value below the minimum bound.
 */
function arbNumberBelowMin(min) {
    return fc.double({ min: min - 1000, max: min - 0.001, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generate a number (float) value above the maximum bound.
 */
function arbNumberAboveMax(max) {
    return fc.double({ min: max + 0.001, max: max + 1000, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generate strings that do NOT match the variant name pattern.
 * The pattern requires: starts with alphanumeric, optional middle chars (word chars or hyphens),
 * ends with alphanumeric, total length 1-64.
 * We generate strings that violate this by starting with special chars or containing invalid chars.
 */
const arbInvalidVariantName = fc.oneof(
    // Starts with a special character
    fc.tuple(
        fc.constantFrom('!', '@', '#', '$', '%', '^', '&', '*', '(', ')', ' ', '.', ','),
        fc.string({ minLength: 0, maxLength: 10 })
    ).map(([prefix, rest]) => prefix + rest),
    // Contains only special characters
    fc.stringMatching(/^[!@#$%^&*()\s.,/\\]{1,10}$/),
    // Ends with a special character (length > 1 to avoid single-char valid match)
    fc.tuple(
        fc.stringMatching(/^[a-c1-3]{1,5}$/),
        fc.constantFrom('!', '@', '#', '$', '%', '^', '&', '*', '(', ')', ' ', '.', ',')
    ).map(([body, suffix]) => body + suffix),
    // Too long (exceeds 64 characters)
    fc.stringMatching(/^[a-c1-3]{65,80}$/)
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Parameter Schema Violation Property-Based Tests', () => {

    let validator;

    before(() => {
        validator = new ParameterSchemaValidator(schema);
    });

    // Feature: cli-config-parameters, Property 2: Schema violation produces constraint-referencing error
    describe('Property 2: Schema violation produces constraint-referencing error', () => {

        /**
         * Validates: Requirements 1.5, 2.6, 10.6
         */

        describe('Integer parameters - values below minimum', () => {
            for (const param of INTEGER_PARAMS) {
                it(`${param.name}: value below min (${param.min}) produces error referencing parameter name, constraint, and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        arbBelowMin(param.min),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with value ${value} (below min ${param.min}) should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(String(param.min)),
                                `Error should contain min constraint "${param.min}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('Integer parameters - values above maximum', () => {
            for (const param of INTEGER_PARAMS) {
                it(`${param.name}: value above max (${param.max}) produces error referencing parameter name, constraint, and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        arbAboveMax(param.max),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with value ${value} (above max ${param.max}) should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(String(param.max)),
                                `Error should contain max constraint "${param.max}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('Number parameters - values below minimum', () => {
            for (const param of NUMBER_PARAMS) {
                it(`${param.name}: value below min (${param.min}) produces error referencing parameter name, constraint, and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        arbNumberBelowMin(param.min),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with value ${value} (below min ${param.min}) should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(String(param.min)),
                                `Error should contain min constraint "${param.min}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('Number parameters - values above maximum', () => {
            for (const param of NUMBER_PARAMS) {
                it(`${param.name}: value above max (${param.max}) produces error referencing parameter name, constraint, and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        arbNumberAboveMax(param.max),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with value ${value} (above max ${param.max}) should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(String(param.max)),
                                `Error should contain max constraint "${param.max}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('String parameters - pattern mismatches', () => {
            for (const param of STRING_PARAMS) {
                it(`${param.name}: invalid pattern produces error referencing parameter name, pattern, and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        arbInvalidVariantName,
                        (value) => {
                            // Double-check the value actually violates the pattern
                            const regex = new RegExp(param.pattern);
                            if (regex.test(value)) {
                                // Skip values that accidentally match
                                return true;
                            }

                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with value "${value}" should be invalid (pattern mismatch)`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes('pattern'),
                                `Error should contain constraint type "pattern" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('Integer parameters - wrong type (non-integer number)', () => {
            for (const param of INTEGER_PARAMS) {
                it(`${param.name}: non-integer number produces error referencing parameter name and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        fc.double({ min: param.min, max: param.max, noNaN: true, noDefaultInfinity: true })
                            .filter(v => !Number.isInteger(v)),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with non-integer value ${value} should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('Numeric parameters - wrong type (string value)', () => {
            const allNumericParams = [...INTEGER_PARAMS, ...NUMBER_PARAMS];

            for (const param of allNumericParams) {
                it(`${param.name}: string value produces error referencing parameter name and API reference`, function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    fc.assert(fc.property(
                        fc.string({ minLength: 1, maxLength: 20 }),
                        (value) => {
                            const result = validator.validate(param.name, value);
                            assert.strictEqual(result.valid, false,
                                `${param.name} with string value "${value}" should be invalid`);
                            assert.ok(result.error, 'Error message should be present');
                            assert.ok(result.error.includes(param.name),
                                `Error should contain parameter name "${param.name}" but got: "${result.error}"`);
                            assert.ok(result.error.includes(param.apiReference),
                                `Error should contain API reference "${param.apiReference}" but got: "${result.error}"`);
                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });
    });
});
