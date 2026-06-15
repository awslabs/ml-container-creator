// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable eqeqeq */

/**
 * Service Model Parser Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 11: Service model parser extracts all constraints
 * Feature: schema-driven-validation, Property 12: Conforming payload produces zero errors
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ServiceModelParser from '../../src/lib/service-model-parser.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid shape name (PascalCase identifier).
 */
const arbShapeName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{1,30}$/);

/**
 * Generate a valid member name (PascalCase identifier for AWS shapes).
 */
const arbMemberName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{1,20}$/);

/**
 * Generate a valid enum array for string shapes.
 */
const arbEnumValues = fc.array(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
    { minLength: 1, maxLength: 10 }
).filter(arr => new Set(arr).size === arr.length);

/**
 * Generate min/max numeric constraints.
 */
const arbMinMax = fc.tuple(
    fc.integer({ min: 0, max: 1000 }),
    fc.integer({ min: 1, max: 10000 })
).map(([a, b]) => {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    return { min, max };
});

/**
 * Generate a valid regex pattern for string shapes.
 */
const arbPattern = fc.constantFrom(
    '^[a-zA-Z0-9]+$',
    '^arn:aws:[a-z]+:.*$',
    '^[0-9]{12}$',
    '^ml\\.[a-z0-9]+\\.[a-z0-9]+$',
    '^[a-z][a-z0-9-]*$'
);

/**
 * Generate a random valid shape definition as it would appear in service-2.json.
 */
const arbStructureShape = fc.tuple(
    fc.array(arbMemberName, { minLength: 1, maxLength: 5 })
        .filter(arr => new Set(arr).size === arr.length),
    fc.array(arbShapeName, { minLength: 1, maxLength: 5 })
        .filter(arr => new Set(arr).size === arr.length)
).chain(([memberNames, shapeRefs]) => {
    const members = {};
    const usedShapeRefs = shapeRefs.slice(0, memberNames.length);
    for (let i = 0; i < memberNames.length; i++) {
        members[memberNames[i]] = { shape: usedShapeRefs[i % usedShapeRefs.length] };
    }
    const requiredSubset = fc.subarray(memberNames, { minLength: 0 });
    return requiredSubset.map(required => ({
        type: 'structure',
        required,
        members
    }));
});

const arbStringShapeWithEnum = arbEnumValues.map(enumValues => ({
    type: 'string',
    enum: enumValues
}));

const arbStringShapeWithPattern = arbPattern.map(pattern => ({
    type: 'string',
    pattern
}));

const arbNumericShapeWithConstraints = fc.tuple(
    fc.constantFrom('integer', 'long', 'float', 'double'),
    arbMinMax
).map(([type, { min, max }]) => ({
    type,
    min,
    max
}));

const arbListShape = arbShapeName.map(shapeName => ({
    type: 'list',
    member: { shape: shapeName }
}));

const arbMapShape = fc.tuple(arbShapeName, arbShapeName).map(([keyShape, valueShape]) => ({
    type: 'map',
    key: { shape: keyShape },
    value: { shape: valueShape }
}));

const arbPlainShape = fc.constantFrom(
    { type: 'string' },
    { type: 'integer' },
    { type: 'long' },
    { type: 'boolean' },
    { type: 'timestamp' },
    { type: 'blob' }
);

/**
 * Generate any valid shape definition.
 */
const arbShapeDefinition = fc.oneof(
    arbStructureShape,
    arbStringShapeWithEnum,
    arbStringShapeWithPattern,
    arbNumericShapeWithConstraints,
    arbListShape,
    arbMapShape,
    arbPlainShape
);

/**
 * Generate a valid service-2.json model with operations and shapes.
 */
const arbServiceModel = fc.tuple(
    fc.array(
        fc.tuple(arbShapeName, arbShapeDefinition),
        { minLength: 1, maxLength: 8 }
    ).filter(arr => new Set(arr.map(([n]) => n)).size === arr.length),
    fc.record({
        apiVersion: fc.constantFrom('2017-07-24', '2010-05-08', '2015-09-21', '2006-03-01'),
        endpointPrefix: fc.constantFrom('sagemaker', 'iam', 'ecr', 's3'),
        protocol: fc.constantFrom('json', 'query', 'rest-json', 'rest-xml'),
        serviceFullName: fc.constantFrom(
            'Amazon SageMaker Service',
            'AWS Identity and Access Management',
            'Amazon EC2 Container Registry',
            'Amazon Simple Storage Service'
        )
    })
).chain(([shapeEntries, metadata]) => {
    const shapeNames = shapeEntries.map(([name]) => name);

    // Generate operations that reference existing shapes
    const arbOperation = fc.tuple(
        arbShapeName,
        fc.constantFrom(...shapeNames),
        fc.constantFrom(...shapeNames)
    ).map(([opName, inputShape, outputShape]) => [opName, {
        input: { shape: inputShape },
        output: { shape: outputShape },
        errors: []
    }]);

    return fc.array(arbOperation, { minLength: 1, maxLength: 4 })
        .filter(arr => new Set(arr.map(([n]) => n)).size === arr.length)
        .map(opEntries => {
            const operations = {};
            for (const [name, op] of opEntries) {
                operations[name] = op;
            }
            const shapes = {};
            for (const [name, shape] of shapeEntries) {
                shapes[name] = shape;
            }
            return { metadata, operations, shapes };
        });
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Service Model Parser Property-Based Tests', () => {

    const parser = new ServiceModelParser();

    // Feature: schema-driven-validation, Property 11: Service model parser extracts all constraints
    describe('Property 11: Service model parser extracts all constraints', () => {

        /**
         * Validates: Requirements 13.2, 13.3, 13.4, 13.5
         */

        it('parser extracts type correctly for all shape definitions', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbShapeDefinition),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.strictEqual(resolved.type, shapeDef.type,
                        `Type should match: expected "${shapeDef.type}", got "${resolved.type}"`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts required list for structure shapes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbStructureShape),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.deepStrictEqual(
                        [...resolved.required].sort(),
                        [...shapeDef.required].sort(),
                        'Required list should match source JSON'
                    );
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts enum values for string shapes with enum constraint', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbStringShapeWithEnum),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const enumValues = parser.getEnumValues(index, shapeName);

                    assert.ok(enumValues, 'Enum values should not be null for enum shapes');
                    assert.deepStrictEqual(enumValues, shapeDef.enum,
                        'Enum values should match source JSON exactly');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts min/max bounds for constrained numeric shapes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbNumericShapeWithConstraints),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.strictEqual(resolved.min, shapeDef.min,
                        `Min should match: expected ${shapeDef.min}, got ${resolved.min}`);
                    assert.strictEqual(resolved.max, shapeDef.max,
                        `Max should match: expected ${shapeDef.max}, got ${resolved.max}`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts pattern for pattern-constrained string shapes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbStringShapeWithPattern),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.strictEqual(resolved.pattern, shapeDef.pattern,
                        `Pattern should match: expected "${shapeDef.pattern}", got "${resolved.pattern}"`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts members map for structure shapes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbStructureShape),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.ok(resolved.members instanceof Map, 'Members should be a Map');

                    const sourceMembers = Object.keys(shapeDef.members);
                    const parsedMembers = [...resolved.members.keys()];
                    assert.deepStrictEqual(
                        parsedMembers.sort(),
                        sourceMembers.sort(),
                        'Member names should match source JSON'
                    );

                    // Verify each member's shape reference
                    for (const [memberName, memberDef] of Object.entries(shapeDef.members)) {
                        const parsedMember = resolved.members.get(memberName);
                        assert.ok(parsedMember, `Member "${memberName}" should exist`);
                        assert.strictEqual(parsedMember.shape, memberDef.shape,
                            `Member "${memberName}" shape reference should match`);
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts list member shape reference', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbListShape),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.ok(resolved.member, 'List shape should have member');
                    assert.strictEqual(resolved.member.shape, shapeDef.member.shape,
                        'List member shape should match source JSON');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser extracts map key/value shape references', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbMapShape),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const resolved = parser.resolveShape(index, shapeName);

                    assert.ok(resolved, `Shape "${shapeName}" should be resolved`);
                    assert.ok(resolved.key, 'Map shape should have key');
                    assert.ok(resolved.value, 'Map shape should have value');
                    assert.strictEqual(resolved.key.shape, shapeDef.key.shape,
                        'Map key shape should match source JSON');
                    assert.strictEqual(resolved.value.shape, shapeDef.value.shape,
                        'Map value shape should match source JSON');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser stores metadata correctly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    assert.strictEqual(index.metadata.apiVersion, rawModel.metadata.apiVersion);
                    assert.strictEqual(index.metadata.endpointPrefix, rawModel.metadata.endpointPrefix);
                    assert.strictEqual(index.metadata.protocol, rawModel.metadata.protocol);
                    assert.strictEqual(index.metadata.serviceFullName, rawModel.metadata.serviceFullName);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('parser returns null enum values for non-enum shapes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbShapeName, arbNumericShapeWithConstraints),
                ([shapeName, shapeDef]) => {
                    const rawModel = {
                        metadata: {},
                        operations: {},
                        shapes: { [shapeName]: shapeDef }
                    };
                    const index = parser.parse(rawModel);
                    const enumValues = parser.getEnumValues(index, shapeName);

                    assert.strictEqual(enumValues, null,
                        'Non-enum shapes should return null for getEnumValues');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('getOperationInputShape resolves operation input correctly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    for (const [opName, opDef] of Object.entries(rawModel.operations)) {
                        const inputShape = parser.getOperationInputShape(index, opName);
                        const expectedShape = rawModel.shapes[opDef.input.shape];

                        if (expectedShape) {
                            assert.ok(inputShape, `Input shape for "${opName}" should be resolved`);
                            assert.strictEqual(inputShape.type, expectedShape.type,
                                `Input shape type for "${opName}" should match`);
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('getOperationInputShape returns null for non-existent operations', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbServiceModel, arbShapeName),
                ([rawModel, fakeName]) => {
                    // Ensure fakeName is not an actual operation
                    fc.pre(!rawModel.operations[fakeName]);

                    const index = parser.parse(rawModel);
                    const result = parser.getOperationInputShape(index, fakeName);

                    assert.strictEqual(result, null,
                        'Non-existent operation should return null');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 12: Conforming payload produces zero errors
    describe('Property 12: Conforming payload produces zero errors', () => {

        /**
         * Validates: Requirements 13.6
         */

        /**
         * Generate a conforming value for a given shape definition.
         */
        function generateConformingValue(shapeDef, shapes, depth = 0) {
            if (depth > 3) {
                // Prevent infinite recursion for deeply nested shapes
                if (shapeDef.type === 'string') return 'placeholder';
                if (shapeDef.type === 'integer' || shapeDef.type === 'long') return 1;
                if (shapeDef.type === 'float' || shapeDef.type === 'double') return 1.0;
                if (shapeDef.type === 'boolean') return true;
                if (shapeDef.type === 'list') return [];
                if (shapeDef.type === 'map') return {};
                return 'placeholder';
            }

            switch (shapeDef.type) {
            case 'string': {
                if (shapeDef.enum && shapeDef.enum.length > 0) {
                    return shapeDef.enum[0];
                }
                if (shapeDef.pattern) {
                    // Return a simple string that might match common patterns
                    return 'ValidString123';
                }
                return 'test-value';
            }
            case 'integer':
            case 'long': {
                const min = shapeDef.min != null ? shapeDef.min : 1;
                const max = shapeDef.max != null ? shapeDef.max : 100;
                return Math.floor((min + max) / 2);
            }
            case 'float':
            case 'double': {
                const min = shapeDef.min != null ? shapeDef.min : 1.0;
                const max = shapeDef.max != null ? shapeDef.max : 100.0;
                return (min + max) / 2;
            }
            case 'boolean':
                return true;
            case 'timestamp':
                return '2024-01-01T00:00:00Z';
            case 'blob':
                return 'base64data';
            case 'list': {
                if (shapeDef.member && shapeDef.member.shape) {
                    const memberShape = shapes.get
                        ? shapes.get(shapeDef.member.shape)
                        : shapes[shapeDef.member.shape];
                    if (memberShape) {
                        return [generateConformingValue(memberShape, shapes, depth + 1)];
                    }
                }
                return [];
            }
            case 'map': {
                return {};
            }
            case 'structure': {
                const result = {};
                if (shapeDef.required && shapeDef.members) {
                    for (const reqField of shapeDef.required) {
                        const memberDef = shapeDef.members instanceof Map
                            ? shapeDef.members.get(reqField)
                            : shapeDef.members[reqField];
                        if (memberDef && memberDef.shape) {
                            const memberShape = shapes.get
                                ? shapes.get(memberDef.shape)
                                : shapes[memberDef.shape];
                            if (memberShape) {
                                result[reqField] = generateConformingValue(memberShape, shapes, depth + 1);
                            } else {
                                result[reqField] = 'placeholder';
                            }
                        } else {
                            result[reqField] = 'placeholder';
                        }
                    }
                }
                return result;
            }
            default:
                return 'unknown';
            }
        }

        it('conforming payload has all required fields present', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    for (const [opName] of Object.entries(rawModel.operations)) {
                        const inputShape = parser.getOperationInputShape(index, opName);
                        if (!inputShape || inputShape.type !== 'structure') continue;

                        const payload = generateConformingValue(inputShape, index.shapes);

                        // Verify all required fields are present
                        for (const reqField of inputShape.required) {
                            assert.ok(
                                reqField in payload,
                                `Required field "${reqField}" should be present in conforming payload for operation "${opName}"`
                            );
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('conforming payload enum values are within allowed set', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    for (const [opName] of Object.entries(rawModel.operations)) {
                        const inputShape = parser.getOperationInputShape(index, opName);
                        if (!inputShape || inputShape.type !== 'structure') continue;

                        const payload = generateConformingValue(inputShape, index.shapes);

                        // For each field in the payload, check if it's an enum field
                        if (inputShape.members) {
                            for (const [fieldName, fieldValue] of Object.entries(payload)) {
                                const memberDef = inputShape.members instanceof Map
                                    ? inputShape.members.get(fieldName)
                                    : inputShape.members[fieldName];
                                if (!memberDef) continue;

                                const fieldShape = index.shapes.get(memberDef.shape);
                                if (!fieldShape || !fieldShape.enum) continue;

                                assert.ok(
                                    fieldShape.enum.includes(fieldValue),
                                    `Field "${fieldName}" value "${fieldValue}" should be in enum set for operation "${opName}"`
                                );
                            }
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('conforming payload numeric values are within min/max bounds', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    for (const [opName] of Object.entries(rawModel.operations)) {
                        const inputShape = parser.getOperationInputShape(index, opName);
                        if (!inputShape || inputShape.type !== 'structure') continue;

                        const payload = generateConformingValue(inputShape, index.shapes);

                        // For each field in the payload, check numeric constraints
                        if (inputShape.members) {
                            for (const [fieldName, fieldValue] of Object.entries(payload)) {
                                const memberDef = inputShape.members instanceof Map
                                    ? inputShape.members.get(fieldName)
                                    : inputShape.members[fieldName];
                                if (!memberDef) continue;

                                const fieldShape = index.shapes.get(memberDef.shape);
                                if (!fieldShape) continue;

                                const isNumeric = ['integer', 'long', 'float', 'double'].includes(fieldShape.type);
                                if (!isNumeric || typeof fieldValue !== 'number') continue;

                                if (fieldShape.min != null) {
                                    assert.ok(
                                        fieldValue >= fieldShape.min,
                                        `Field "${fieldName}" value ${fieldValue} should be >= ${fieldShape.min} for operation "${opName}"`
                                    );
                                }
                                if (fieldShape.max != null) {
                                    assert.ok(
                                        fieldValue <= fieldShape.max,
                                        `Field "${fieldName}" value ${fieldValue} should be <= ${fieldShape.max} for operation "${opName}"`
                                    );
                                }
                            }
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('conforming payload field types match shape definitions', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServiceModel,
                (rawModel) => {
                    const index = parser.parse(rawModel);

                    for (const [opName] of Object.entries(rawModel.operations)) {
                        const inputShape = parser.getOperationInputShape(index, opName);
                        if (!inputShape || inputShape.type !== 'structure') continue;

                        const payload = generateConformingValue(inputShape, index.shapes);

                        // For each field in the payload, verify type matches
                        if (inputShape.members) {
                            for (const [fieldName, fieldValue] of Object.entries(payload)) {
                                const memberDef = inputShape.members instanceof Map
                                    ? inputShape.members.get(fieldName)
                                    : inputShape.members[fieldName];
                                if (!memberDef) continue;

                                const fieldShape = index.shapes.get(memberDef.shape);
                                if (!fieldShape) continue;

                                switch (fieldShape.type) {
                                case 'string':
                                case 'timestamp':
                                case 'blob':
                                    assert.strictEqual(typeof fieldValue, 'string',
                                        `Field "${fieldName}" should be string for operation "${opName}"`);
                                    break;
                                case 'integer':
                                case 'long':
                                case 'float':
                                case 'double':
                                    assert.strictEqual(typeof fieldValue, 'number',
                                        `Field "${fieldName}" should be number for operation "${opName}"`);
                                    break;
                                case 'boolean':
                                    assert.strictEqual(typeof fieldValue, 'boolean',
                                        `Field "${fieldName}" should be boolean for operation "${opName}"`);
                                    break;
                                case 'list':
                                    assert.ok(Array.isArray(fieldValue),
                                        `Field "${fieldName}" should be array for operation "${opName}"`);
                                    break;
                                case 'map':
                                case 'structure':
                                    assert.strictEqual(typeof fieldValue, 'object',
                                        `Field "${fieldName}" should be object for operation "${opName}"`);
                                    break;
                                }
                            }
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
