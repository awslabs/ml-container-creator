// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ParameterSchemaValidator Unit Tests
 *
 * Tests schema loading, validation, constraint retrieval, and error messages.
 * Requirements: 10.1, 10.2, 10.5, 10.6, 10.8
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import ParameterSchemaValidator, { PARAMETER_NAME_MAP, SUPPORTED_SCHEMA_VERSION, BUNDLED_SCHEMA_PATH } from '../../src/lib/parameter-schema-validator.js';

describe('ParameterSchemaValidator', () => {
    describe('constructor - schema loading', () => {
        it('should load schema from bundled file path by default', () => {
            const validator = new ParameterSchemaValidator();
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.ok(constraints);
            assert.strictEqual(constraints.type, 'integer');
            assert.strictEqual(constraints.min, 1);
            assert.strictEqual(constraints.max, 16384);
        });

        it('should load schema from explicit file path', () => {
            const validator = new ParameterSchemaValidator(BUNDLED_SCHEMA_PATH);
            const constraints = validator.getConstraints('endpointInitialInstanceCount');
            assert.ok(constraints);
            assert.strictEqual(constraints.type, 'integer');
            assert.strictEqual(constraints.min, 1);
        });

        it('should accept an object override directly', () => {
            const customSchema = {
                schemaVersion: '1.0.0',
                deploymentTargets: {
                    'managed-inference': {
                        endpoint: {
                            volumeSize: {
                                type: 'integer',
                                min: 10,
                                max: 500,
                                apiReference: 'Custom.VolumeSize'
                            }
                        }
                    }
                }
            };
            const validator = new ParameterSchemaValidator(customSchema);
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.ok(constraints);
            assert.strictEqual(constraints.min, 10);
            assert.strictEqual(constraints.max, 500);
        });

        it('should fall back to bundled baseline when file path is invalid', () => {
            const validator = new ParameterSchemaValidator('/nonexistent/path/schema.json');
            // Should still work with bundled schema
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.ok(constraints);
            assert.strictEqual(constraints.type, 'integer');
        });

        it('should handle completely missing bundled schema gracefully', () => {
            const validator = new ParameterSchemaValidator({
                schemaVersion: '1.0.0',
                deploymentTargets: {}
            });
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.strictEqual(constraints, null);
        });
    });

    describe('schema version check', () => {
        it('should accept supported schema version', () => {
            const validator = new ParameterSchemaValidator({
                schemaVersion: SUPPORTED_SCHEMA_VERSION,
                deploymentTargets: {
                    'managed-inference': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 1, max: 100, apiReference: 'Test' }
                        }
                    }
                }
            });
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.ok(constraints);
        });

        it('should warn but not throw for unsupported schema version', () => {
            const validator = new ParameterSchemaValidator({
                schemaVersion: '99.0.0',
                deploymentTargets: {
                    'managed-inference': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 1, max: 100, apiReference: 'Test' }
                        }
                    }
                }
            });
            assert.ok(validator);
        });
    });

    describe('validate() - integer type', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should return valid for value within bounds', () => {
            const result = validator.validate('endpointInitialInstanceCount', 5);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return valid for value at minimum bound', () => {
            const result = validator.validate('endpointInitialInstanceCount', 1);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return valid for value at maximum bound', () => {
            const result = validator.validate('endpointInitialInstanceCount', 100);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return invalid for value below minimum', () => {
            const result = validator.validate('endpointInitialInstanceCount', 0);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
            assert.ok(result.error.includes('endpointInitialInstanceCount'));
        });

        it('should return invalid for value above maximum', () => {
            const result = validator.validate('endpointInitialInstanceCount', 101);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('should return invalid for non-integer value when type is integer', () => {
            const result = validator.validate('endpointInitialInstanceCount', 2.5);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('should return invalid for string value when type is integer', () => {
            const result = validator.validate('endpointInitialInstanceCount', 'abc');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('should return valid for null value (optional parameter)', () => {
            const result = validator.validate('endpointVolumeSize', null);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return valid for undefined value (optional parameter)', () => {
            const result = validator.validate('endpointVolumeSize', undefined);
            assert.deepStrictEqual(result, { valid: true });
        });
    });

    describe('validate() - number type', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should return valid for decimal value within bounds', () => {
            const result = validator.validate('icCpuCount', 4.5);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return valid for value at minimum bound (0.25)', () => {
            const result = validator.validate('icCpuCount', 0.25);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return invalid for value below minimum', () => {
            const result = validator.validate('icCpuCount', 0.1);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('should return valid for modelWeight at boundary', () => {
            const result = validator.validate('icModelWeight', 0.5);
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return invalid for modelWeight above max', () => {
            const result = validator.validate('icModelWeight', 1.5);
            assert.strictEqual(result.valid, false);
        });
    });

    describe('validate() - string type with pattern', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should return valid for string matching pattern', () => {
            const result = validator.validate('endpointVariantName', 'AllTraffic');
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return valid for alphanumeric variant name', () => {
            const result = validator.validate('endpointVariantName', 'primary-variant-1');
            assert.deepStrictEqual(result, { valid: true });
        });

        it('should return invalid for string not matching pattern', () => {
            const result = validator.validate('endpointVariantName', '-invalid');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error);
        });

        it('should return invalid for empty string', () => {
            const result = validator.validate('endpointVariantName', '');
            assert.strictEqual(result.valid, false);
        });

        it('should return invalid for non-string value', () => {
            const result = validator.validate('endpointVariantName', 123);
            assert.strictEqual(result.valid, false);
        });
    });

    describe('validate() - unknown parameters', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should return valid for unknown parameter names', () => {
            const result = validator.validate('unknownParam', 'anything');
            assert.deepStrictEqual(result, { valid: true });
        });
    });

    describe('validate() - deployment target override', () => {
        it('should use deployment target override when provided', () => {
            const validator = new ParameterSchemaValidator({
                schemaVersion: '1.0.0',
                deploymentTargets: {
                    'managed-inference': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 1, max: 100, apiReference: 'MI.VolumeSize' }
                        }
                    },
                    'eks': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 10, max: 500, apiReference: 'EKS.VolumeSize' }
                        }
                    }
                }
            });

            // Default target (managed-inference from PARAMETER_NAME_MAP)
            const result1 = validator.validate('endpointVolumeSize', 5);
            assert.deepStrictEqual(result1, { valid: true });

            // Override to eks target
            const result2 = validator.validate('endpointVolumeSize', 5, 'eks');
            assert.strictEqual(result2.valid, false);
        });
    });

    describe('getConstraints()', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should return constraint object for known parameter', () => {
            const constraints = validator.getConstraints('endpointVolumeSize');
            assert.ok(constraints);
            assert.strictEqual(constraints.type, 'integer');
            assert.strictEqual(constraints.min, 1);
            assert.strictEqual(constraints.max, 16384);
            assert.strictEqual(constraints.apiReference, 'CreateEndpointConfig.ProductionVariants.VolumeSizeInGB');
        });

        it('should return null for unknown parameter', () => {
            const constraints = validator.getConstraints('unknownParam');
            assert.strictEqual(constraints, null);
        });

        it('should return constraints for iC parameters', () => {
            const constraints = validator.getConstraints('icMemorySize');
            assert.ok(constraints);
            assert.strictEqual(constraints.type, 'integer');
            assert.strictEqual(constraints.min, 128);
            assert.strictEqual(constraints.max, 3145728);
        });

        it('should support deployment target override', () => {
            const validator2 = new ParameterSchemaValidator({
                schemaVersion: '1.0.0',
                deploymentTargets: {
                    'managed-inference': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 1, max: 100, apiReference: 'MI' }
                        }
                    },
                    'eks': {
                        endpoint: {
                            volumeSize: { type: 'integer', min: 50, max: 1000, apiReference: 'EKS' }
                        }
                    }
                }
            });
            const constraints = validator2.getConstraints('endpointVolumeSize', 'eks');
            assert.strictEqual(constraints.min, 50);
            assert.strictEqual(constraints.max, 1000);
        });
    });

    describe('getErrorMessage()', () => {
        let validator;

        beforeEach(() => {
            validator = new ParameterSchemaValidator();
        });

        it('should include parameter name in error message', () => {
            const constraint = validator.getConstraints('endpointVolumeSize');
            const msg = validator.getErrorMessage('endpointVolumeSize', 0, constraint);
            assert.ok(msg.includes('endpointVolumeSize'));
        });

        it('should include API reference in error message', () => {
            const constraint = validator.getConstraints('endpointVolumeSize');
            const msg = validator.getErrorMessage('endpointVolumeSize', 0, constraint);
            assert.ok(msg.includes('CreateEndpointConfig.ProductionVariants.VolumeSizeInGB'));
        });

        it('should include constraint description for integer range', () => {
            const constraint = validator.getConstraints('endpointVolumeSize');
            const msg = validator.getErrorMessage('endpointVolumeSize', 0, constraint);
            assert.ok(msg.includes('\u2265 1'));
            assert.ok(msg.includes('\u2264 16384'));
        });

        it('should include pattern description for string type', () => {
            const constraint = validator.getConstraints('endpointVariantName');
            const msg = validator.getErrorMessage('endpointVariantName', '-bad', constraint);
            assert.ok(msg.includes('pattern'));
            assert.ok(msg.includes('CreateEndpointConfig.ProductionVariants.VariantName'));
        });

        it('should format message like: "{param} must be {description} per {apiRef}"', () => {
            const constraint = validator.getConstraints('endpointVolumeSize');
            const msg = validator.getErrorMessage('endpointVolumeSize', 0, constraint);
            assert.ok(msg.startsWith('endpointVolumeSize must be'));
            assert.ok(msg.includes(' per '));
        });
    });

    describe('PARAMETER_NAME_MAP', () => {
        it('should map all endpoint parameters', () => {
            assert.ok(PARAMETER_NAME_MAP.endpointInitialInstanceCount);
            assert.ok(PARAMETER_NAME_MAP.endpointDataCapturePercent);
            assert.ok(PARAMETER_NAME_MAP.endpointVariantName);
            assert.ok(PARAMETER_NAME_MAP.endpointVolumeSize);
        });

        it('should map all iC parameters', () => {
            assert.ok(PARAMETER_NAME_MAP.icCpuCount);
            assert.ok(PARAMETER_NAME_MAP.icMemorySize);
            assert.ok(PARAMETER_NAME_MAP.icGpuCount);
            assert.ok(PARAMETER_NAME_MAP.icCopyCount);
            assert.ok(PARAMETER_NAME_MAP.icModelWeight);
        });

        it('should use correct schema path format', () => {
            Object.values(PARAMETER_NAME_MAP).forEach((schemaPath) => {
                const parts = schemaPath.split('.');
                assert.strictEqual(parts.length, 3, `Schema path "${schemaPath}" should have 3 parts`);
            });
        });
    });
});
