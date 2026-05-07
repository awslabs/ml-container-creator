// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Record Validation Property-Based Tests
 *
 * Property 4: Asset_Record schema validation
 *
 * Invalid records SHALL be rejected; valid records SHALL pass.
 *
 * Feature: deployment-registry, Property 4: Asset_Record schema validation
 *
 * **Validates: Requirements 2.1–2.8**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager, { VALID_RESOURCE_TYPES, VALID_STATUSES } from '../../src/lib/asset-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbResourceType = fc.constantFrom(...VALID_RESOURCE_TYPES);

const arbStatus = fc.constantFrom(...VALID_STATUSES);

const arbISOTimestamp = fc.integer({
    min: new Date('2020-01-01T00:00:00Z').getTime(),
    max: new Date('2030-12-31T23:59:59Z').getTime()
}).map(ms => new Date(ms).toISOString());

const arbResourceId = fc.stringMatching(/^[a-zA-Z0-9:/_-]{5,80}$/);

const arbProjectName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,19}$/)
    .filter(s => s.length >= 1);

const arbMetadata = fc.dictionary(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/).filter(s => s.length >= 1),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { minKeys: 0, maxKeys: 5 }
);

const arbValidRecord = fc.record({
    resourceId: arbResourceId,
    resourceType: arbResourceType,
    createdAt: arbISOTimestamp,
    lastUpdatedAt: arbISOTimestamp,
    project: arbProjectName,
    status: arbStatus,
    metadata: arbMetadata
});

const REQUIRED_FIELDS = [
    'resourceId', 'resourceType', 'createdAt',
    'lastUpdatedAt', 'project', 'status', 'metadata'
];

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 4: Asset_Record schema validation', () => {

    let tmpDir;
    let manager;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-validation-'));
        manager = new AssetManager('validation-test', { configDir: tmpDir });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('valid records pass validation', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidRecord,
            (record) => {
                const result = manager._validateRecord(record);
                assert.strictEqual(
                    result.valid,
                    true,
                    `Valid record should pass validation, got errors: ${result.errors.join('; ')}`
                );
                assert.strictEqual(result.errors.length, 0);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('records missing a required field are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidRecord,
            fc.constantFrom(...REQUIRED_FIELDS),
            (record, fieldToRemove) => {
                const incomplete = { ...record };
                delete incomplete[fieldToRemove];

                const result = manager._validateRecord(incomplete);
                assert.strictEqual(
                    result.valid,
                    false,
                    `Record missing "${fieldToRemove}" should fail validation`
                );
                assert.ok(
                    result.errors.some(e => e.includes(fieldToRemove)),
                    `Errors should mention missing field "${fieldToRemove}"`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('records with invalid resourceType are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const arbInvalidType = fc.stringMatching(/^[a-z]{3,20}$/)
            .filter(s => !VALID_RESOURCE_TYPES.includes(s));

        fc.assert(fc.property(
            arbValidRecord,
            arbInvalidType,
            (record, badType) => {
                const invalid = { ...record, resourceType: badType };
                const result = manager._validateRecord(invalid);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some(e => e.includes('Invalid resourceType')));
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('records with invalid status are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const arbInvalidStatus = fc.stringMatching(/^[a-z]{3,15}$/)
            .filter(s => !VALID_STATUSES.includes(s));

        fc.assert(fc.property(
            arbValidRecord,
            arbInvalidStatus,
            (record, badStatus) => {
                const invalid = { ...record, status: badStatus };
                const result = manager._validateRecord(invalid);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some(e => e.includes('Invalid status')));
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('records with non-ISO-8601 timestamps are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const arbBadTimestamp = fc.constantFrom(
            'not-a-date', '2026/05/04', '05-04-2026',
            'yesterday', '1234', 'Jan 1 2026'
        );

        fc.assert(fc.property(
            arbValidRecord,
            arbBadTimestamp,
            fc.constantFrom('createdAt', 'lastUpdatedAt'),
            (record, badTs, field) => {
                const invalid = { ...record, [field]: badTs };
                const result = manager._validateRecord(invalid);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some(e => e.includes(`Invalid ${field}`)));
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 2.1–2.8**
     */
    it('records with non-object metadata are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const arbBadMetadata = fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.array(fc.integer(), { minLength: 1, maxLength: 3 })
        );

        fc.assert(fc.property(
            arbValidRecord,
            arbBadMetadata,
            (record, badMeta) => {
                const invalid = { ...record, metadata: badMeta };
                const result = manager._validateRecord(invalid);
                // null metadata triggers "Missing required field", arrays/strings trigger "Invalid metadata"
                assert.strictEqual(result.valid, false);
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
