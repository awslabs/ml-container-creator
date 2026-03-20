// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Schema Validation Property-Based Tests
 *
 * Property 5: Schema validation rejects invalid entries
 *
 * Generates random valid deployment entries (should pass validation)
 * and random invalid entries with missing fields, bad enums, and bad
 * timestamps (should fail validation).
 *
 * Feature: deployment-registry, Property 5: Schema validation rejects invalid entries
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import Ajv from 'ajv';
import deploymentEntrySchema from '../../generators/app/config/schemas/deployment-entry-schema.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid 8-char hex ID.
 */
const arbHexId = fc.stringMatching(/^[0-9a-f]{8}$/);

/**
 * Generate a valid ISO 8601 timestamp.
 */
const arbTimestamp = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
).map(([y, m, d, h, min, s]) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
});

/**
 * Generate a non-empty alphanumeric string.
 */
const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a nullable string (string or null).
 */
const arbNullableString = fc.oneof(
    fc.constant(null),
    arbNonEmptyString
);

/**
 * Generate a valid deployment entry matching the schema.
 */
const arbValidDeploymentEntry = fc.record({
    id: arbHexId,
    timestamp: arbTimestamp,
    status: fc.constantFrom('success', 'partial', 'failed'),
    deployment: fc.record({
        deploymentConfig: arbNonEmptyString,
        architecture: fc.constantFrom('http', 'transformers', 'triton'),
        backend: arbNonEmptyString,
        baseImage: arbNullableString,
        deploymentTarget: arbNullableString,
        buildTarget: arbNullableString
    }),
    model: fc.record({
        modelName: arbNonEmptyString,
        modelFormat: arbNullableString
    }),
    infrastructure: fc.record({
        instanceType: arbNullableString,
        region: arbNullableString,
        roleArn: arbNullableString
    }),
    configuration: fc.record({
        parameters: fc.dictionary(
            fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1),
            fc.string({ minLength: 0, maxLength: 20 })
        )
    }),
    outcome: fc.record({
        notes: arbNullableString
    }),
    metadata: fc.record({
        generatorVersion: arbNonEmptyString,
        source: fc.constantFrom('local', 'imported', 'community'),
        importedFrom: arbNullableString
    })
});

// ── Invalid entry generators ─────────────────────────────────────────────────

const TOP_LEVEL_REQUIRED = [
    'id', 'timestamp', 'status', 'deployment', 'model',
    'infrastructure', 'configuration', 'outcome', 'metadata'
];

/**
 * Generate an entry with a random required top-level field removed.
 */
const arbEntryMissingField = fc.tuple(
    arbValidDeploymentEntry,
    fc.constantFrom(...TOP_LEVEL_REQUIRED)
).map(([entry, field]) => {
    const copy = { ...entry };
    delete copy[field];
    return { data: copy, removedField: field };
});

/**
 * Generate an entry with an invalid status enum value.
 */
const arbEntryBadStatus = arbValidDeploymentEntry.map(entry => ({
    ...entry,
    status: 'invalid-status'
}));

/**
 * Generate an entry with an invalid architecture enum value.
 */
const arbEntryBadArchitecture = arbValidDeploymentEntry.map(entry => ({
    ...entry,
    deployment: { ...entry.deployment, architecture: 'invalid-arch' }
}));

/**
 * Generate an entry with an invalid source enum value.
 */
const arbEntryBadSource = arbValidDeploymentEntry.map(entry => ({
    ...entry,
    metadata: { ...entry.metadata, source: 'invalid-source' }
}));

/**
 * Generate an entry with an invalid timestamp (does not match the schema's
 * ISO 8601 regex pattern).
 */
const arbEntryBadTimestamp = fc.tuple(
    arbValidDeploymentEntry,
    fc.constantFrom(
        'not-a-date',
        '2024/01/01',
        '01-01-2024',
        'yesterday',
        '',
        '2024-01-01 12:00:00',
        '2024-01-01',
        '12:00:00Z'
    )
).map(([entry, badTs]) => ({
    ...entry,
    timestamp: badTs
}));

/**
 * Generate an entry with an invalid id (not 8-char hex).
 */
const arbEntryBadId = fc.tuple(
    arbValidDeploymentEntry,
    fc.constantFrom(
        'ZZZZZZZZ',
        'short',
        '123456789',
        '',
        'ghijklmn'
    )
).map(([entry, badId]) => ({
    ...entry,
    id: badId
}));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 5: Schema validation rejects invalid entries', () => {

    let validate;

    before(() => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        validate = ajv.compile(deploymentEntrySchema);
    });

    /**
     * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
     */

    // ── Valid entries should pass ─────────────────────────────────────

    it('any valid deployment entry passes schema validation', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentEntry,
            (entry) => {
                const valid = validate(entry);
                assert.ok(
                    valid,
                    `Valid entry should pass validation but got errors: ${JSON.stringify(validate.errors)}`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── Missing required fields should fail ───────────────────────────

    it('entry with missing required top-level field is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryMissingField,
            ({ data, removedField }) => {
                const valid = validate(data);
                assert.strictEqual(valid, false, `Should reject entry missing "${removedField}"`);
                assert.ok(validate.errors.length > 0, 'Should have validation errors');
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── Invalid enum values should fail ───────────────────────────────

    it('entry with invalid status enum is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryBadStatus,
            (entry) => {
                const valid = validate(entry);
                assert.strictEqual(valid, false, 'Should reject entry with invalid status');
                const hasStatusError = validate.errors.some(e =>
                    e.instancePath === '/status' || e.params?.allowedValues
                );
                assert.ok(hasStatusError, `Should have status-related error but got: ${JSON.stringify(validate.errors)}`);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('entry with invalid architecture enum is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryBadArchitecture,
            (entry) => {
                const valid = validate(entry);
                assert.strictEqual(valid, false, 'Should reject entry with invalid architecture');
                const hasArchError = validate.errors.some(e =>
                    e.instancePath.includes('architecture') || e.params?.allowedValues
                );
                assert.ok(hasArchError, `Should have architecture-related error but got: ${JSON.stringify(validate.errors)}`);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('entry with invalid source enum is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryBadSource,
            (entry) => {
                const valid = validate(entry);
                assert.strictEqual(valid, false, 'Should reject entry with invalid source');
                const hasSourceError = validate.errors.some(e =>
                    e.instancePath.includes('source') || e.params?.allowedValues
                );
                assert.ok(hasSourceError, `Should have source-related error but got: ${JSON.stringify(validate.errors)}`);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── Invalid timestamps should fail ────────────────────────────────

    it('entry with non-ISO-8601 timestamp is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryBadTimestamp,
            (entry) => {
                const valid = validate(entry);
                assert.strictEqual(valid, false, `Should reject entry with bad timestamp "${entry.timestamp}"`);
                const hasTimestampError = validate.errors.some(e =>
                    e.instancePath === '/timestamp'
                );
                assert.ok(hasTimestampError, `Should have timestamp-related error but got: ${JSON.stringify(validate.errors)}`);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── Invalid ID format should fail ─────────────────────────────────

    it('entry with invalid id format is rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryBadId,
            (entry) => {
                const valid = validate(entry);
                assert.strictEqual(valid, false, `Should reject entry with bad id "${entry.id}"`);
                const hasIdError = validate.errors.some(e =>
                    e.instancePath === '/id'
                );
                assert.ok(hasIdError, `Should have id-related error but got: ${JSON.stringify(validate.errors)}`);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
