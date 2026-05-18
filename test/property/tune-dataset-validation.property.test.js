// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Dataset Validation Property-Based Tests
 *
 * Property 6: Dataset argument parsing accepts valid formats
 *
 * For any string matching the pattern `s3://[bucket]/[key]` or
 * `hf://[org]/[name]` (optionally with `/[split]`), the dataset
 * argument parser SHALL accept it as valid input without error.
 *
 * Feature: managed-model-customization, Property 6: Dataset argument parsing accepts valid formats
 * Validates: Requirements 3.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { parseDatasetArg, validateDatasetFormat } from '../../src/lib/tune-dataset-validator.js';

const require = createRequire(import.meta.url);
const catalog = require('../../config/tune-catalog.json');

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid S3 bucket name segment (alphanumeric + hyphens,
 * must start/end with alphanumeric, 3-63 chars).
 */
const s3BucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);

/**
 * Generate a valid S3 key (non-empty path, alphanumeric + common path chars).
 */
const s3KeyArb = fc.array(
    fc.stringMatching(/^[a-zA-Z0-9_.-]+$/),
    { minLength: 1, maxLength: 5 }
).map(parts => parts.join('/'));

/**
 * Generate a valid S3 URI: s3://bucket/key
 */
const s3UriArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/${key}`);

/**
 * Generate a valid HF org/name segment (alphanumeric + hyphens,
 * at least 1 char).
 */
const hfSegmentArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}[a-zA-Z0-9]$/);

/**
 * Generate a valid HF reference without split: hf://org/name
 */
const hfRefNoSplitArb = fc.tuple(hfSegmentArb, hfSegmentArb)
    .map(([org, name]) => `hf://${org}/${name}`);

/**
 * Generate a valid HF reference with split: hf://org/name/split
 */
const hfRefWithSplitArb = fc.tuple(hfSegmentArb, hfSegmentArb, hfSegmentArb)
    .map(([org, name, split]) => `hf://${org}/${name}/${split}`);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 6: Dataset argument parsing accepts valid formats', () => {

    it('accepts valid S3 URIs (s3://bucket/key)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            s3UriArb,
            (uri) => {
                const result = parseDatasetArg(uri);
                assert.strictEqual(result.valid, true,
                    `Expected S3 URI "${uri}" to be valid, got error: ${result.error}`);
                assert.strictEqual(result.type, 's3',
                    `Expected type "s3" for URI "${uri}", got "${result.type}"`);
                assert.ok(result.bucket && result.bucket.length > 0,
                    `Expected non-empty bucket for URI "${uri}"`);
                assert.ok(result.key && result.key.length > 0,
                    `Expected non-empty key for URI "${uri}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('accepts valid HF references without split (hf://org/name)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            hfRefNoSplitArb,
            (ref) => {
                const result = parseDatasetArg(ref);
                assert.strictEqual(result.valid, true,
                    `Expected HF ref "${ref}" to be valid, got error: ${result.error}`);
                assert.strictEqual(result.type, 'hf',
                    `Expected type "hf" for ref "${ref}", got "${result.type}"`);
                assert.ok(result.org && result.org.length > 0,
                    `Expected non-empty org for ref "${ref}"`);
                assert.ok(result.name && result.name.length > 0,
                    `Expected non-empty name for ref "${ref}"`);
                assert.strictEqual(result.split, 'train',
                    `Expected default split "train" for ref "${ref}" without explicit split, got "${result.split}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('accepts valid HF references with split (hf://org/name/split)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            hfRefWithSplitArb,
            (ref) => {
                const result = parseDatasetArg(ref);
                assert.strictEqual(result.valid, true,
                    `Expected HF ref "${ref}" to be valid, got error: ${result.error}`);
                assert.strictEqual(result.type, 'hf',
                    `Expected type "hf" for ref "${ref}", got "${result.type}"`);
                assert.ok(result.org && result.org.length > 0,
                    `Expected non-empty org for ref "${ref}"`);
                assert.ok(result.name && result.name.length > 0,
                    `Expected non-empty name for ref "${ref}"`);
                assert.ok(result.split && result.split.length > 0,
                    `Expected non-empty split for ref "${ref}" with explicit split`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('correctly extracts bucket and key from S3 URIs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            s3BucketArb,
            s3KeyArb,
            (bucket, key) => {
                const uri = `s3://${bucket}/${key}`;
                const result = parseDatasetArg(uri);
                assert.strictEqual(result.valid, true,
                    `Expected S3 URI "${uri}" to be valid, got error: ${result.error}`);
                assert.strictEqual(result.bucket, bucket,
                    `Expected bucket "${bucket}", got "${result.bucket}" for URI "${uri}"`);
                assert.strictEqual(result.key, key,
                    `Expected key "${key}", got "${result.key}" for URI "${uri}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('correctly extracts org, name, and split from HF references', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            hfSegmentArb,
            hfSegmentArb,
            hfSegmentArb,
            (org, name, split) => {
                const ref = `hf://${org}/${name}/${split}`;
                const result = parseDatasetArg(ref);
                assert.strictEqual(result.valid, true,
                    `Expected HF ref "${ref}" to be valid, got error: ${result.error}`);
                assert.strictEqual(result.org, org,
                    `Expected org "${org}", got "${result.org}" for ref "${ref}"`);
                assert.strictEqual(result.name, name,
                    `Expected name "${name}", got "${result.name}" for ref "${ref}"`);
                assert.strictEqual(result.split, split,
                    `Expected split "${split}", got "${result.split}" for ref "${ref}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});


// ── Property 7 ───────────────────────────────────────────────────────────────

/**
 * Property 7: Dataset validation is catalog-driven and technique-aware
 *
 * For any model entry in the catalog and any technique supported by that model,
 * the dataset validator SHALL accept a JSONL dataset if and only if every
 * inspected line contains all keys specified in that model+technique's
 * `datasetSchema.required` array with values matching the specified types.
 *
 * Feature: managed-model-customization, Property 7: Dataset validation is catalog-driven and technique-aware
 * Validates: Requirements 3.5, 3.6, 3.7, 3.8
 */

// ── Property 7 Generators ────────────────────────────────────────────────────

/**
 * Generate a value matching the expected schema type.
 */
function valueArbForType(type) {
    switch (type) {
    case 'string':
        return fc.string({ minLength: 1, maxLength: 100 });
    case 'array':
        return fc.array(
            fc.record({ role: fc.constantFrom('user', 'assistant'), content: fc.string({ minLength: 1 }) }),
            { minLength: 1, maxLength: 5 }
        );
    case 'number':
        return fc.double({ min: -1000, max: 1000, noNaN: true });
    case 'object':
        return fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string(), { minKeys: 1, maxKeys: 3 });
    default:
        return fc.string({ minLength: 1 });
    }
}

/**
 * Generate a value that does NOT match the expected schema type.
 */
function wrongValueArbForType(type) {
    switch (type) {
    case 'string':
        // Return a number instead of a string
        return fc.integer({ min: 0, max: 1000 });
    case 'array':
        // Return a string instead of an array
        return fc.string({ minLength: 1, maxLength: 50 });
    case 'number':
        // Return a string instead of a number
        return fc.string({ minLength: 1, maxLength: 20 });
    case 'object':
        // Return an array instead of an object
        return fc.array(fc.string(), { minLength: 1, maxLength: 3 });
    default:
        return fc.constant(null);
    }
}

/**
 * Build all model+technique combinations from the catalog.
 */
function getAllModelTechniqueCombinations() {
    const combinations = [];
    for (const [modelId, modelEntry] of Object.entries(catalog.models)) {
        for (const [technique, techConfig] of Object.entries(modelEntry.techniques)) {
            if (techConfig.datasetSchema) {
                combinations.push({
                    modelId,
                    technique,
                    schema: techConfig.datasetSchema
                });
            }
        }
    }
    return combinations;
}

/**
 * Generate a valid JSONL line object matching the given schema.
 */
function validLineArbForSchema(schema) {
    const recordShape = {};
    for (const key of schema.required) {
        const type = (schema.types && schema.types[key]) || 'string';
        recordShape[key] = valueArbForType(type);
    }
    return fc.record(recordShape);
}

/**
 * Generate an array of valid JSONL line strings for a schema.
 */
function validLinesArb(schema) {
    return fc.array(validLineArbForSchema(schema), { minLength: 1, maxLength: 10 })
        .map(records => records.map(r => JSON.stringify(r)));
}

/**
 * Generate an invalid JSONL line by removing a required key from a valid record.
 */
function lineWithMissingKeyArb(schema) {
    return fc.tuple(
        validLineArbForSchema(schema),
        fc.constantFrom(...schema.required)
    ).map(([record, keyToRemove]) => {
        const copy = { ...record };
        delete copy[keyToRemove];
        return JSON.stringify(copy);
    });
}

/**
 * Generate an invalid JSONL line by using a wrong type for one field.
 */
function lineWithWrongTypeArb(schema) {
    // Only pick keys that have a type defined
    const typedKeys = Object.entries(schema.types || {}).filter(([key]) => schema.required.includes(key));
    if (typedKeys.length === 0) {
        // Fallback: just remove a key
        return lineWithMissingKeyArb(schema);
    }

    return fc.tuple(
        validLineArbForSchema(schema),
        fc.constantFrom(...typedKeys)
    ).chain(([record, [keyToCorrupt, expectedType]]) => {
        return wrongValueArbForType(expectedType).map(wrongValue => {
            const copy = { ...record };
            copy[keyToCorrupt] = wrongValue;
            return JSON.stringify(copy);
        });
    });
}

// ── Property 7 Tests ─────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 7: Dataset validation is catalog-driven and technique-aware', () => {

    const combinations = getAllModelTechniqueCombinations();

    // Deduplicate schemas to avoid redundant tests (many models share the same schema)
    const uniqueSchemas = new Map();
    for (const combo of combinations) {
        const key = JSON.stringify(combo.schema);
        if (!uniqueSchemas.has(key)) {
            uniqueSchemas.set(key, combo);
        }
    }
    const representativeCombos = [...uniqueSchemas.values()];

    it('accepts valid JSONL datasets matching the catalog schema for each model+technique', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                validLinesArb(schema),
                (lines) => {
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, true,
                        `Expected valid dataset for ${modelId}/${technique} to be accepted. ` +
                        `Got error: ${result.error}. Lines: ${JSON.stringify(lines)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('rejects JSONL datasets with missing required keys for each model+technique', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                fc.tuple(
                    fc.array(validLineArbForSchema(schema).map(r => JSON.stringify(r)), { minLength: 0, maxLength: 3 }),
                    lineWithMissingKeyArb(schema),
                    fc.array(validLineArbForSchema(schema).map(r => JSON.stringify(r)), { minLength: 0, maxLength: 3 })
                ),
                ([validBefore, invalidLine, validAfter]) => {
                    const lines = [...validBefore, invalidLine, ...validAfter];
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected dataset with missing key for ${modelId}/${technique} to be rejected. ` +
                        `Lines: ${JSON.stringify(lines)}`);
                    assert.ok(result.error && result.error.length > 0,
                        `Expected non-empty error message for ${modelId}/${technique}`);
                    assert.ok(result.lineNumber !== null && result.lineNumber > 0,
                        `Expected lineNumber to be reported for ${modelId}/${technique}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('rejects JSONL datasets with wrong value types for each model+technique', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                fc.tuple(
                    fc.array(validLineArbForSchema(schema).map(r => JSON.stringify(r)), { minLength: 0, maxLength: 3 }),
                    lineWithWrongTypeArb(schema),
                    fc.array(validLineArbForSchema(schema).map(r => JSON.stringify(r)), { minLength: 0, maxLength: 3 })
                ),
                ([validBefore, invalidLine, validAfter]) => {
                    const lines = [...validBefore, invalidLine, ...validAfter];
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected dataset with wrong type for ${modelId}/${technique} to be rejected. ` +
                        `Lines: ${JSON.stringify(lines)}`);
                    assert.ok(result.error && result.error.length > 0,
                        `Expected non-empty error message for ${modelId}/${technique}`);
                    assert.ok(result.lineNumber !== null && result.lineNumber > 0,
                        `Expected lineNumber to be reported for ${modelId}/${technique}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('validates against the specific schema for each model+technique (catalog-driven)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Verify that different schemas produce different validation results
        // e.g., a valid SFT line should fail DPO validation and vice versa
        for (const [modelId, modelEntry] of Object.entries(catalog.models)) {
            const techniques = Object.entries(modelEntry.techniques);
            if (techniques.length < 2) continue;

            // Pick two techniques with different schemas
            const [tech1Name, tech1Config] = techniques[0];
            const [tech2Name, tech2Config] = techniques[1];
            const schema1 = tech1Config.datasetSchema;
            const schema2 = tech2Config.datasetSchema;

            // Only test if schemas are actually different
            if (JSON.stringify(schema1) === JSON.stringify(schema2)) continue;

            fc.assert(fc.property(
                validLineArbForSchema(schema1),
                (validForSchema1) => {
                    const line = JSON.stringify(validForSchema1);

                    // Valid for schema1
                    const result1 = validateDatasetFormat([line], schema1);
                    assert.strictEqual(result1.valid, true,
                        `Line valid for ${modelId}/${tech1Name} should pass its own schema`);

                    // Check if it would be invalid for schema2
                    // (only if schema2 has required keys not in schema1)
                    const extraKeys = schema2.required.filter(k => !schema1.required.includes(k));
                    if (extraKeys.length > 0) {
                        const result2 = validateDatasetFormat([line], schema2);
                        assert.strictEqual(result2.valid, false,
                            `Line valid for ${modelId}/${tech1Name} should fail ${tech2Name} schema ` +
                            `(missing keys: ${extraKeys.join(', ')})`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });

            break; // One model is sufficient to demonstrate catalog-driven behavior
        }
    });
});


// ── Property 8 ───────────────────────────────────────────────────────────────

/**
 * Property 8: Malformed dataset reports first bad line
 *
 * For any JSONL dataset where at least one of the first 10 lines does not
 * match the expected schema, the validation error SHALL include the line
 * number and content of the first malformed line, plus a description of
 * the expected format.
 *
 * Feature: managed-model-customization, Property 8: Malformed dataset reports first bad line
 * Validates: Requirements 3.11
 */

// ── Property 8 Generators ────────────────────────────────────────────────────

/**
 * Generate a malformed line — not valid JSON.
 */
const notJsonArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 80 }).filter(s => {
        try { JSON.parse(s); return false; } catch { return true; }
    }).filter(s => s.trim() !== ''),
    fc.constant('{ broken json'),
    fc.constant('not json at all'),
    fc.constant('{missing: closing brace')
);

/**
 * Generate a malformed line — valid JSON but missing a required key.
 */
function missingKeyLineArb(schema) {
    return fc.tuple(
        validLineArbForSchema(schema),
        fc.constantFrom(...schema.required)
    ).map(([record, keyToRemove]) => {
        const copy = { ...record };
        delete copy[keyToRemove];
        return JSON.stringify(copy);
    });
}

/**
 * Generate a malformed line — valid JSON but with wrong type for a field.
 */
function wrongTypeLineArb(schema) {
    const typedKeys = Object.entries(schema.types || {}).filter(([key]) => schema.required.includes(key));
    if (typedKeys.length === 0) {
        return missingKeyLineArb(schema);
    }

    return fc.tuple(
        validLineArbForSchema(schema),
        fc.constantFrom(...typedKeys)
    ).chain(([record, [keyToCorrupt, expectedType]]) => {
        return wrongValueArbForType(expectedType).map(wrongValue => {
            const copy = { ...record };
            copy[keyToCorrupt] = wrongValue;
            return JSON.stringify(copy);
        });
    });
}

/**
 * Generate a malformed line using one of three strategies:
 * not valid JSON, missing required key, or wrong type.
 */
function malformedLineArb(schema) {
    return fc.oneof(
        notJsonArb,
        missingKeyLineArb(schema),
        wrongTypeLineArb(schema)
    );
}

/**
 * Generate N valid lines (0 to 9) followed by one malformed line,
 * ensuring the malformed line is within the first 10 lines.
 * Returns { lines, malformedIndex } where malformedIndex is 0-based.
 */
function datasetWithMalformedLineArb(schema) {
    return fc.integer({ min: 0, max: 9 }).chain(n => {
        const validBeforeArb = fc.array(
            validLineArbForSchema(schema).map(r => JSON.stringify(r)),
            { minLength: n, maxLength: n }
        );
        return fc.tuple(validBeforeArb, malformedLineArb(schema)).map(([validLines, badLine]) => ({
            lines: [...validLines, badLine],
            malformedIndex: n
        }));
    });
}

// ── Property 8 Tests ─────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 8: Malformed dataset reports first bad line', () => {

    const combinations = getAllModelTechniqueCombinations();

    // Deduplicate schemas
    const uniqueSchemas = new Map();
    for (const combo of combinations) {
        const key = JSON.stringify(combo.schema);
        if (!uniqueSchemas.has(key)) {
            uniqueSchemas.set(key, combo);
        }
    }
    const representativeCombos = [...uniqueSchemas.values()];

    it('reports the correct line number of the first malformed line', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                datasetWithMalformedLineArb(schema),
                ({ lines, malformedIndex }) => {
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected dataset with malformed line at index ${malformedIndex} to be rejected ` +
                        `for ${modelId}/${technique}`);
                    assert.strictEqual(result.lineNumber, malformedIndex + 1,
                        `Expected lineNumber to be ${malformedIndex + 1} (1-based), ` +
                        `got ${result.lineNumber} for ${modelId}/${technique}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('includes the content of the malformed line in the error', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                datasetWithMalformedLineArb(schema),
                ({ lines, malformedIndex }) => {
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected invalid result for ${modelId}/${technique}`);
                    assert.ok(result.malformedLine !== null && result.malformedLine !== undefined,
                        `Expected malformedLine to be present for ${modelId}/${technique}`);
                    assert.strictEqual(result.malformedLine, lines[malformedIndex],
                        `Expected malformedLine to equal the bad line content for ${modelId}/${technique}. ` +
                        `Got "${result.malformedLine}" but expected "${lines[malformedIndex]}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('includes a non-empty expected format description in the error', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                datasetWithMalformedLineArb(schema),
                ({ lines }) => {
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected invalid result for ${modelId}/${technique}`);
                    assert.ok(result.expectedFormat !== null && result.expectedFormat !== undefined,
                        `Expected expectedFormat to be present for ${modelId}/${technique}`);
                    assert.ok(typeof result.expectedFormat === 'string' && result.expectedFormat.length > 0,
                        `Expected expectedFormat to be a non-empty string for ${modelId}/${technique}, ` +
                        `got: "${result.expectedFormat}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });

    it('reports all three fields together: lineNumber, malformedLine, and expectedFormat', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        for (const { modelId, technique, schema } of representativeCombos) {
            fc.assert(fc.property(
                datasetWithMalformedLineArb(schema),
                ({ lines, malformedIndex }) => {
                    const result = validateDatasetFormat(lines, schema);
                    assert.strictEqual(result.valid, false,
                        `Expected invalid result for ${modelId}/${technique}`);

                    // All three fields must be present simultaneously
                    assert.ok(result.lineNumber !== null,
                        `lineNumber must not be null for ${modelId}/${technique}`);
                    assert.ok(result.malformedLine !== null,
                        `malformedLine must not be null for ${modelId}/${technique}`);
                    assert.ok(result.expectedFormat !== null,
                        `expectedFormat must not be null for ${modelId}/${technique}`);

                    // lineNumber is correct
                    assert.strictEqual(result.lineNumber, malformedIndex + 1,
                        `lineNumber should be ${malformedIndex + 1} for ${modelId}/${technique}`);

                    // malformedLine matches the bad line
                    assert.strictEqual(result.malformedLine, lines[malformedIndex],
                        `malformedLine should match the bad line for ${modelId}/${technique}`);

                    // expectedFormat describes the schema
                    for (const key of schema.required) {
                        assert.ok(result.expectedFormat.includes(key),
                            `expectedFormat should mention required key "${key}" for ${modelId}/${technique}. ` +
                            `Got: "${result.expectedFormat}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        }
    });
});
