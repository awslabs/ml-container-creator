// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable eqeqeq */

/**
 * Schema Validator Core Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 1: Enum validation correctness
 * Feature: schema-driven-validation, Property 2: Enum error reporting completeness
 * Feature: schema-driven-validation, Property 3: Pattern validation correctness
 * Feature: schema-driven-validation, Property 4: Required field detection
 * Feature: schema-driven-validation, Property 5: Recursive structure validation
 * Feature: schema-driven-validation, Property 6: Present-field validation uniformity
 * Feature: schema-driven-validation, Property 7: Type validation correctness
 * Feature: schema-driven-validation, Property 8: Range validation correctness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import EnumValidator from '../../src/lib/validators/enum-validator.js';
import TypeValidator from '../../src/lib/validators/type-validator.js';
import RequiredFieldValidator from '../../src/lib/validators/required-field-validator.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid field name (PascalCase identifier for AWS shapes).
 */
const arbFieldName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{1,15}$/);

/**
 * Generate a valid enum array for string shapes.
 */
const arbEnumValues = fc.array(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
    { minLength: 2, maxLength: 8 }
).filter(arr => new Set(arr).size === arr.length);

/**
 * Helper to build a minimal service model with one operation and shapes.
 */
function buildServiceModel(shapes, operationName, inputShapeName) {
    const shapesMap = new Map();
    for (const [name, def] of Object.entries(shapes)) {
        shapesMap.set(name, {
            type: def.type || 'string',
            required: def.required || [],
            members: def.members ? new Map(Object.entries(def.members)) : new Map(),
            enum: def.enum || null,
            min: def.min != null ? def.min : null,
            max: def.max != null ? def.max : null,
            pattern: def.pattern || null,
            member: def.member || null,
            key: def.key || null,
            value: def.value || null
        });
    }

    const operations = new Map();
    operations.set(operationName, {
        input: inputShapeName,
        output: null,
        errors: []
    });

    return { metadata: {}, operations, shapes: shapesMap };
}

/**
 * Build a validation context with a single operation payload.
 */
function buildContext(service, operation, payload) {
    return {
        payloads: { [`${service}:${operation}`]: payload },
        config: {},
        deploymentTarget: 'realtime-inference',
        metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [service] }
    };
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Schema Validator Core Property-Based Tests', () => {

    const enumValidator = new EnumValidator();
    const typeValidator = new TypeValidator();
    const requiredFieldValidator = new RequiredFieldValidator();


    // Feature: schema-driven-validation, Property 1: Enum validation correctness
    describe('Property 1: Enum validation correctness', () => {

        /**
         * Validates: Requirements 4.1, 4.5
         */

        it('reports error iff value is not in enum set', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbEnumValues, fc.boolean()),
                ([fieldName, enumValues, useValidValue]) => {
                    const shapeName = 'InputShape';
                    const enumShapeName = 'EnumField';

                    const shapes = {
                        [shapeName]: {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: enumShapeName } }
                        },
                        [enumShapeName]: {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', shapeName);

                    if (useValidValue) {
                        // Pick a valid value from the enum set
                        const validValue = enumValues[0];
                        const context = buildContext('sagemaker', 'TestOp', { [fieldName]: validValue });
                        const findings = [];

                        // Run synchronously via internal method
                        enumValidator._validateStructure(
                            context.payloads['sagemaker:TestOp'],
                            model.shapes.get(shapeName),
                            model, 'sagemaker', 'TestOp', '', findings
                        );

                        assert.strictEqual(findings.length, 0,
                            `Valid enum value "${validValue}" should produce no errors`);
                    } else {
                        // Generate an invalid value
                        const invalidValue = `INVALID_VALUE_${  Date.now()}`;
                        const context = buildContext('sagemaker', 'TestOp', { [fieldName]: invalidValue });
                        const findings = [];

                        enumValidator._validateStructure(
                            context.payloads['sagemaker:TestOp'],
                            model.shapes.get(shapeName),
                            model, 'sagemaker', 'TestOp', '', findings
                        );

                        assert.strictEqual(findings.length, 1,
                            `Invalid enum value "${invalidValue}" should produce exactly one error`);
                        assert.strictEqual(findings[0].severity, 'error');
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('validates optional fields with same rigor as required fields', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbEnumValues),
                ([fieldName, enumValues]) => {
                    const shapeName = 'InputShape';
                    const enumShapeName = 'EnumField';

                    // Field is NOT in required list (optional)
                    const shapes = {
                        [shapeName]: {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: enumShapeName } }
                        },
                        [enumShapeName]: {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', shapeName);
                    const invalidValue = `INVALID_OPTIONAL_${  Date.now()}`;
                    const findings = [];

                    enumValidator._validateStructure(
                        { [fieldName]: invalidValue },
                        model.shapes.get(shapeName),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1,
                        'Optional field with invalid enum value should produce an error');
                    assert.strictEqual(findings[0].severity, 'error',
                        'Should be an error, not a warning');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 2: Enum error reporting completeness
    describe('Property 2: Enum error reporting completeness', () => {

        /**
         * Validates: Requirements 4.2
         */

        it('error finding contains invalid value, full field path, and complete valid enum set', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbEnumValues),
                ([fieldName, enumValues]) => {
                    const shapeName = 'InputShape';
                    const enumShapeName = 'EnumField';

                    const shapes = {
                        [shapeName]: {
                            type: 'structure',
                            required: [fieldName],
                            members: { [fieldName]: { shape: enumShapeName } }
                        },
                        [enumShapeName]: {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', shapeName);
                    const invalidValue = `INVALID_REPORT_${  Date.now()}`;
                    const findings = [];

                    enumValidator._validateStructure(
                        { [fieldName]: invalidValue },
                        model.shapes.get(shapeName),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1, 'Should produce exactly one finding');

                    const finding = findings[0];

                    // Must contain the invalid value
                    assert.strictEqual(finding.invalidValue, invalidValue,
                        'Finding should contain the invalid value');

                    // Must contain the full field path
                    assert.strictEqual(finding.fieldPath, fieldName,
                        'Finding should contain the field path');

                    // Must contain the complete valid enum set
                    assert.ok(finding.constraint, 'Finding should have constraint');
                    assert.strictEqual(finding.constraint.type, 'enum',
                        'Constraint type should be enum');
                    assert.deepStrictEqual(finding.constraint.values, enumValues,
                        'Constraint should contain the complete valid enum set');

                    // Must have required metadata
                    assert.strictEqual(finding.service, 'sagemaker');
                    assert.strictEqual(finding.operation, 'TestOp');
                    assert.strictEqual(finding.source, 'enum');
                    assert.strictEqual(finding.severity, 'error');
                    assert.strictEqual(finding.confidence, 'definitive');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('nested field paths use dot-notation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbFieldName, arbEnumValues),
                ([parentField, childField, enumValues]) => {
                    fc.pre(parentField !== childField);

                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [parentField]: { shape: 'NestedShape' } }
                        },
                        'NestedShape': {
                            type: 'structure',
                            required: [],
                            members: { [childField]: { shape: 'EnumField' } }
                        },
                        'EnumField': {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const invalidValue = `NESTED_INVALID_${  Date.now()}`;
                    const findings = [];

                    enumValidator._validateStructure(
                        { [parentField]: { [childField]: invalidValue } },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1);
                    assert.strictEqual(findings[0].fieldPath, `${parentField}.${childField}`,
                        'Nested field path should use dot-notation');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 3: Pattern validation correctness
    describe('Property 3: Pattern validation correctness', () => {

        /**
         * Validates: Requirements 4.4
         */

        it('reports error iff value does not match pattern regex', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.constantFrom(
                        { pattern: '^[a-z][a-z0-9-]*$', valid: 'my-value-123', invalid: 'MY_VALUE' },
                        { pattern: '^arn:aws:iam::\\d{12}:role\\/.+$', valid: 'arn:aws:iam::123456789012:role/MyRole', invalid: 'not-an-arn' },
                        { pattern: '^ml\\.[a-z0-9]+\\.[a-z0-9]+$', valid: 'ml.m5.xlarge', invalid: 'invalid-instance' },
                        { pattern: '^[A-Z][A-Za-z0-9]+$', valid: 'MyName123', invalid: 'lowercase' }
                    ),
                    fc.boolean()
                ),
                ([fieldName, patternDef, useValid]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'PatternField' } }
                        },
                        'PatternField': {
                            type: 'string',
                            pattern: patternDef.pattern
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const value = useValid ? patternDef.valid : patternDef.invalid;
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: value },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    const patternFindings = findings.filter(f => f.constraint && f.constraint.type === 'pattern');

                    if (useValid) {
                        assert.strictEqual(patternFindings.length, 0,
                            `Valid value "${value}" should not produce pattern error`);
                    } else {
                        assert.strictEqual(patternFindings.length, 1,
                            `Invalid value "${value}" should produce exactly one pattern error`);
                        assert.strictEqual(patternFindings[0].invalidValue, value);
                        assert.strictEqual(patternFindings[0].constraint.pattern, patternDef.pattern);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('pattern validation is skipped when shape has enum', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbEnumValues),
                ([fieldName, enumValues]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'EnumPatternField' } }
                        },
                        'EnumPatternField': {
                            type: 'string',
                            enum: enumValues,
                            pattern: '^IMPOSSIBLE_PATTERN$'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    // Use a valid enum value that doesn't match the pattern
                    const value = enumValues[0];
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: value },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    const patternFindings = findings.filter(f => f.constraint && f.constraint.type === 'pattern');
                    assert.strictEqual(patternFindings.length, 0,
                        'Pattern validation should be skipped when shape has enum');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 4: Required field detection
    describe('Property 4: Required field detection', () => {

        /**
         * Validates: Requirements 5.1, 5.2
         */

        it('reports error for each missing required field', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFieldName, { minLength: 2, maxLength: 5 })
                    .filter(arr => new Set(arr).size === arr.length)
                    .chain(fieldNames => {
                        // Choose a non-empty subset to be required
                        return fc.subarray(fieldNames, { minLength: 1 })
                            .map(required => ({ fieldNames, required }));
                    }),
                ({ fieldNames, required }) => {
                    const members = {};
                    for (const name of fieldNames) {
                        members[name] = { shape: 'StringField' };
                    }

                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required,
                            members
                        },
                        'StringField': {
                            type: 'string'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');

                    // Provide an empty payload — all required fields are missing
                    const findings = [];
                    requiredFieldValidator._validateRequiredFields(
                        {},
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, required.length,
                        `Should report ${required.length} errors for ${required.length} missing required fields`);

                    // Each finding should reference a required field
                    const reportedFields = findings.map(f => f.fieldPath);
                    for (const reqField of required) {
                        assert.ok(reportedFields.includes(reqField),
                            `Missing required field "${reqField}" should be reported`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('no error when all required fields are present and non-empty', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFieldName, { minLength: 1, maxLength: 4 })
                    .filter(arr => new Set(arr).size === arr.length),
                (fieldNames) => {
                    const members = {};
                    for (const name of fieldNames) {
                        members[name] = { shape: 'StringField' };
                    }

                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: fieldNames,
                            members
                        },
                        'StringField': {
                            type: 'string'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');

                    // Provide all required fields with non-empty values
                    const payload = {};
                    for (const name of fieldNames) {
                        payload[name] = 'valid-value';
                    }

                    const findings = [];
                    requiredFieldValidator._validateRequiredFields(
                        payload,
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 0,
                        'No errors when all required fields are present and non-empty');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 5: Recursive structure validation
    describe('Property 5: Recursive structure validation', () => {

        /**
         * Validates: Requirements 5.3
         */

        it('validates fields at every nesting depth with full dot-notation path', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    arbFieldName,
                    arbFieldName
                ).filter(([a, b, c]) => a !== b && b !== c && a !== c),
                ([level1, level2, level3]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [level1]: { shape: 'Level2Shape' } }
                        },
                        'Level2Shape': {
                            type: 'structure',
                            required: [],
                            members: { [level2]: { shape: 'Level3Shape' } }
                        },
                        'Level3Shape': {
                            type: 'structure',
                            required: [level3],
                            members: { [level3]: { shape: 'StringField' } }
                        },
                        'StringField': {
                            type: 'string'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');

                    // Provide nested structure with missing required field at depth 3
                    const payload = {
                        [level1]: {
                            [level2]: {}
                        }
                    };

                    const findings = [];
                    requiredFieldValidator._validateRequiredFields(
                        payload,
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1,
                        'Should detect missing required field at depth 3');
                    assert.strictEqual(findings[0].fieldPath, `${level1}.${level2}.${level3}`,
                        'Field path should use full dot-notation from root');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('enum validation works at nested depths', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbFieldName, arbEnumValues)
                    .filter(([a, b]) => a !== b),
                ([parentField, childField, enumValues]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [parentField]: { shape: 'NestedShape' } }
                        },
                        'NestedShape': {
                            type: 'structure',
                            required: [],
                            members: { [childField]: { shape: 'EnumField' } }
                        },
                        'EnumField': {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const invalidValue = `DEEP_INVALID_${  Date.now()}`;
                    const findings = [];

                    enumValidator._validateStructure(
                        { [parentField]: { [childField]: invalidValue } },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1);
                    assert.strictEqual(findings[0].fieldPath, `${parentField}.${childField}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 6: Present-field validation uniformity
    describe('Property 6: Present-field validation uniformity', () => {

        /**
         * Validates: Requirements 5.5, 5.6
         */

        it('optional fields with invalid values produce errors not warnings', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, arbEnumValues),
                ([fieldName, enumValues]) => {
                    // Field is optional (not in required list)
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'EnumField' } }
                        },
                        'EnumField': {
                            type: 'string',
                            enum: enumValues
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const invalidValue = `OPTIONAL_INVALID_${  Date.now()}`;

                    const context = buildContext('sagemaker', 'TestOp', { [fieldName]: invalidValue });
                    const findings = [];

                    enumValidator._validateStructure(
                        context.payloads['sagemaker:TestOp'],
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 1,
                        'Optional field with invalid value should produce a finding');
                    assert.strictEqual(findings[0].severity, 'error',
                        'Finding should be an error, not a warning');
                    assert.strictEqual(findings[0].confidence, 'definitive',
                        'Finding should have definitive confidence');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('optional fields with invalid types produce errors', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.constantFrom('integer', 'boolean', 'string'),
                    fc.constantFrom(
                        { type: 'integer', badValue: 'not-a-number' },
                        { type: 'boolean', badValue: 42 },
                        { type: 'string', badValue: 123 }
                    )
                ),
                ([fieldName, _, mismatch]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'TypedField' } }
                        },
                        'TypedField': {
                            type: mismatch.type
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: mismatch.badValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        'Optional field with type mismatch should produce at least one error');
                    assert.strictEqual(findings[0].severity, 'error',
                        'Type mismatch should be an error, not a warning');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 7: Type validation correctness
    describe('Property 7: Type validation correctness', () => {

        /**
         * Validates: Requirements 6.1, 6.2, 6.3, 6.4
         */

        it('integer fields reject non-integer values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.oneof(
                        fc.string(),
                        fc.double({ noNaN: true }).filter(n => !Number.isInteger(n)),
                        fc.boolean()
                    )
                ),
                ([fieldName, badValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'IntField' } }
                        },
                        'IntField': {
                            type: 'integer'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: badValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        `Non-integer value ${JSON.stringify(badValue)} should produce a type error`);
                    assert.strictEqual(findings[0].constraint.type, 'type');
                    assert.strictEqual(findings[0].constraint.expected, 'integer');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('integer fields accept valid integers', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFieldName, fc.integer()),
                ([fieldName, validInt]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'IntField' } }
                        },
                        'IntField': {
                            type: 'integer'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: validInt },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.strictEqual(findings.length, 0,
                        `Valid integer ${validInt} should produce no type errors`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('string fields reject non-string values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.oneof(
                        fc.integer(),
                        fc.boolean(),
                        fc.constant([1, 2, 3])
                    )
                ),
                ([fieldName, badValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'StrField' } }
                        },
                        'StrField': {
                            type: 'string'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: badValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        `Non-string value ${JSON.stringify(badValue)} should produce a type error`);
                    assert.strictEqual(findings[0].constraint.type, 'type');
                    assert.strictEqual(findings[0].constraint.expected, 'string');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('boolean fields reject non-boolean values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.oneof(
                        fc.integer(),
                        fc.string(),
                        fc.constant(null)
                    ).filter(v => v !== null)
                ),
                ([fieldName, badValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'BoolField' } }
                        },
                        'BoolField': {
                            type: 'boolean'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: badValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        `Non-boolean value ${JSON.stringify(badValue)} should produce a type error`);
                    assert.strictEqual(findings[0].constraint.type, 'type');
                    assert.strictEqual(findings[0].constraint.expected, 'boolean');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('list fields reject non-array values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.oneof(
                        fc.integer(),
                        fc.string(),
                        fc.boolean()
                    )
                ),
                ([fieldName, badValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'ListField' } }
                        },
                        'ListField': {
                            type: 'list',
                            member: { shape: 'StringField' }
                        },
                        'StringField': {
                            type: 'string'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: badValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        `Non-array value ${JSON.stringify(badValue)} should produce a type error`);
                    assert.strictEqual(findings[0].constraint.type, 'type');
                    assert.strictEqual(findings[0].constraint.expected, 'list');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('list fields recursively validate elements', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.integer({ min: 1, max: 5 })
                ),
                ([fieldName, listLength]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'ListField' } }
                        },
                        'ListField': {
                            type: 'list',
                            member: { shape: 'IntElement' }
                        },
                        'IntElement': {
                            type: 'integer'
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');

                    // Create a list with one invalid element (string instead of integer)
                    const listValue = Array.from({ length: listLength }, (_, i) => i + 1);
                    listValue[0] = 'not-an-integer';

                    const findings = [];
                    typeValidator._validateStructure(
                        { [fieldName]: listValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    assert.ok(findings.length >= 1,
                        'Invalid list element should produce a type error');
                    assert.ok(findings[0].fieldPath.includes('[0]'),
                        'Error path should include array index');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });


    // Feature: schema-driven-validation, Property 8: Range validation correctness
    describe('Property 8: Range validation correctness', () => {

        /**
         * Validates: Requirements 6.5
         */

        it('reports error iff numeric value falls outside [min, max] range', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.integer({ min: 1, max: 100 }),
                    fc.integer({ min: 101, max: 1000 }),
                    fc.integer({ min: -1000, max: 2000 })
                ),
                ([fieldName, min, max, testValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'RangeField' } }
                        },
                        'RangeField': {
                            type: 'integer',
                            min,
                            max
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: testValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    const rangeFindings = findings.filter(f => f.constraint && f.constraint.type === 'range');
                    const isInRange = testValue >= min && testValue <= max;

                    if (isInRange) {
                        assert.strictEqual(rangeFindings.length, 0,
                            `Value ${testValue} in range [${min}, ${max}] should produce no range error`);
                    } else {
                        assert.strictEqual(rangeFindings.length, 1,
                            `Value ${testValue} outside range [${min}, ${max}] should produce exactly one range error`);
                        assert.strictEqual(rangeFindings[0].invalidValue, testValue);
                        assert.strictEqual(rangeFindings[0].constraint.min, min);
                        assert.strictEqual(rangeFindings[0].constraint.max, max);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('validates min-only constraints correctly', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.integer({ min: 1, max: 100 }),
                    fc.integer({ min: -100, max: 200 })
                ),
                ([fieldName, min, testValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'MinField' } }
                        },
                        'MinField': {
                            type: 'integer',
                            min
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: testValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    const rangeFindings = findings.filter(f => f.constraint && f.constraint.type === 'range');

                    if (testValue >= min) {
                        assert.strictEqual(rangeFindings.length, 0,
                            `Value ${testValue} >= min ${min} should produce no range error`);
                    } else {
                        assert.strictEqual(rangeFindings.length, 1,
                            `Value ${testValue} < min ${min} should produce a range error`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('validates max-only constraints correctly', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbFieldName,
                    fc.integer({ min: 100, max: 1000 }),
                    fc.integer({ min: 0, max: 1500 })
                ),
                ([fieldName, max, testValue]) => {
                    const shapes = {
                        'InputShape': {
                            type: 'structure',
                            required: [],
                            members: { [fieldName]: { shape: 'MaxField' } }
                        },
                        'MaxField': {
                            type: 'integer',
                            max
                        }
                    };

                    const model = buildServiceModel(shapes, 'TestOp', 'InputShape');
                    const findings = [];

                    typeValidator._validateStructure(
                        { [fieldName]: testValue },
                        model.shapes.get('InputShape'),
                        model, 'sagemaker', 'TestOp', '', findings
                    );

                    const rangeFindings = findings.filter(f => f.constraint && f.constraint.type === 'range');

                    if (testValue <= max) {
                        assert.strictEqual(rangeFindings.length, 0,
                            `Value ${testValue} <= max ${max} should produce no range error`);
                    } else {
                        assert.strictEqual(rangeFindings.length, 1,
                            `Value ${testValue} > max ${max} should produce a range error`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
