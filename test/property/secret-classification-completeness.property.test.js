// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret Classification Registry Completeness Property-Based Tests
 *
 * Property 8: Registry Entry Completeness
 *
 * For any entry in the SECRET_CLASSIFICATIONS registry, it SHALL contain
 * all required fields: identifier, displayName, stages (non-empty array),
 * purpose, cliFlag, cliFlagPlaintext, envVar, envVarArn, and promptLabel.
 *
 * Feature: secrets-manager-integration, Property 8: Registry Entry Completeness
 *
 * Validates: Requirements 5.1, 5.5, 13.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { SECRET_CLASSIFICATIONS } from '../../src/lib/secret-classification.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// Required fields that every registry entry must have
const REQUIRED_FIELDS = [
    'identifier',
    'displayName',
    'stages',
    'purpose',
    'cliFlag',
    'cliFlagPlaintext',
    'envVar',
    'envVarArn',
    'promptLabel'
];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random index into the SECRET_CLASSIFICATIONS array.
 * This allows fast-check to select any entry from the registry across iterations.
 */
const arbRegistryIndex = fc.integer({ min: 0, max: SECRET_CLASSIFICATIONS.length - 1 });

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 8: Registry Entry Completeness', () => {

    /**
     * Validates: Requirements 5.1, 5.5, 13.4
     */

    it('every registry entry contains all required fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbRegistryIndex,
            (index) => {
                const entry = SECRET_CLASSIFICATIONS[index];

                for (const field of REQUIRED_FIELDS) {
                    assert.ok(
                        field in entry,
                        `Entry "${entry.identifier || index}" is missing required field "${field}"`
                    );
                }
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every registry entry has non-empty string values for string fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const STRING_FIELDS = [
            'identifier',
            'displayName',
            'purpose',
            'cliFlag',
            'cliFlagPlaintext',
            'envVar',
            'envVarArn',
            'promptLabel'
        ];

        fc.assert(fc.property(
            arbRegistryIndex,
            (index) => {
                const entry = SECRET_CLASSIFICATIONS[index];

                for (const field of STRING_FIELDS) {
                    assert.strictEqual(
                        typeof entry[field],
                        'string',
                        `Entry "${entry.identifier}": field "${field}" should be a string but got ${typeof entry[field]}`
                    );
                    assert.ok(
                        entry[field].length > 0,
                        `Entry "${entry.identifier}": field "${field}" should be non-empty`
                    );
                }
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every registry entry has a non-empty stages array', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbRegistryIndex,
            (index) => {
                const entry = SECRET_CLASSIFICATIONS[index];

                assert.ok(
                    Array.isArray(entry.stages),
                    `Entry "${entry.identifier}": stages should be an array but got ${typeof entry.stages}`
                );
                assert.ok(
                    entry.stages.length > 0,
                    `Entry "${entry.identifier}": stages array should be non-empty`
                );

                // Each stage should be a non-empty string
                for (const stage of entry.stages) {
                    assert.strictEqual(
                        typeof stage,
                        'string',
                        `Entry "${entry.identifier}": each stage should be a string but got ${typeof stage}`
                    );
                    assert.ok(
                        stage.length > 0,
                        `Entry "${entry.identifier}": each stage should be non-empty`
                    );
                }
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every registry entry has unique identifier across the registry', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbRegistryIndex,
            (index) => {
                const entry = SECRET_CLASSIFICATIONS[index];
                const matchingEntries = SECRET_CLASSIFICATIONS.filter(
                    e => e.identifier === entry.identifier
                );

                assert.strictEqual(
                    matchingEntries.length,
                    1,
                    `Identifier "${entry.identifier}" appears ${matchingEntries.length} times — must be unique`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
