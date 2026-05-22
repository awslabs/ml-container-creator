// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Export Property-Based Tests
 *
 * Property 10: Export format structure and default status filter
 * Property 11: Export single entry by ID
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import DeploymentRegistry from '../../src/lib/deployment-registry.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

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

const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

const arbNullableString = fc.oneof(
    fc.constant(null),
    arbNonEmptyString
);

const SENSITIVE_PARAM_KEYS = ['HF_TOKEN', 'NGC_API_KEY'];

/**
 * Generate a valid deployment entry WITHOUT an id field.
 * Used for add() which generates the id internally.
 */
const arbValidEntryWithoutId = fc.record({
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

// ── ISO 8601 regex ───────────────────────────────────────────────────────────

const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 10: Export format structure and default status filter', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-export-p10-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 7.1, 7.3, 7.7
     *
     * For any registry, calling exportEntries with no ID and no status filter
     * should produce an Export Format object with: version equal to "1.0",
     * exportedAt as a valid ISO 8601 string, exportedBy equal to "anonymous",
     * and entries containing only entries with status "success". All entries
     * in the output should have sensitive fields stripped.
     */
    it('exportEntries(null) returns correct format with only success entries and stripped sensitive fields', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            fc.tuple(
                arbValidEntryWithoutId.map(e => ({ ...e, status: 'success' })),
                arbValidEntryWithoutId.map(e => ({ ...e, status: 'failed' })),
                fc.array(arbValidEntryWithoutId, { minLength: 0, maxLength: 3 })
            ),
            ([successEntry, failedEntry, extraEntries]) => {
                // Use a fresh registry file per iteration to avoid accumulation
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                // Add entries with mixed statuses
                const addedIds = [];
                addedIds.push({ id: reg.add(successEntry), status: 'success' });
                addedIds.push({ id: reg.add(failedEntry), status: 'failed' });
                for (const entry of extraEntries) {
                    addedIds.push({ id: reg.add(entry), status: entry.status });
                }

                // Export with no ID and no status filter (defaults to 'success')
                const exported = reg.exportEntries(null);

                // Verify Export Format structure
                assert.strictEqual(exported.version, '1.0', 'version should be "1.0"');
                assert.strictEqual(typeof exported.exportedAt, 'string', 'exportedAt should be a string');
                assert.ok(
                    ISO_8601_PATTERN.test(exported.exportedAt),
                    `exportedAt should be valid ISO 8601 but got "${exported.exportedAt}"`
                );
                assert.strictEqual(exported.exportedBy, 'anonymous', 'exportedBy should be "anonymous"');
                assert.ok(Array.isArray(exported.entries), 'entries should be an array');

                // Count how many success entries we added
                const expectedSuccessCount = addedIds.filter(e => e.status === 'success').length;

                // Verify only success entries are included
                assert.strictEqual(
                    exported.entries.length,
                    expectedSuccessCount,
                    `Should have ${expectedSuccessCount} success entries but got ${exported.entries.length}`
                );

                for (const entry of exported.entries) {
                    assert.strictEqual(entry.status, 'success', 'All exported entries should have status "success"');
                }

                // Verify sensitive fields are stripped from all exported entries
                for (const entry of exported.entries) {
                    assert.strictEqual(
                        'roleArn' in (entry.infrastructure || {}),
                        false,
                        'roleArn should be stripped'
                    );
                    assert.strictEqual(
                        'region' in (entry.infrastructure || {}),
                        false,
                        'region should be stripped'
                    );
                    if (entry.configuration?.parameters) {
                        for (const key of SENSITIVE_PARAM_KEYS) {
                            assert.strictEqual(
                                key in entry.configuration.parameters,
                                false,
                                `${key} should be stripped from parameters`
                            );
                        }
                    }
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

describe('Feature: deployment-registry, Property 11: Export single entry by ID', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-export-p11-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 7.2
     *
     * For any registry and any entry ID present in the registry, calling
     * exportEntries with that ID should produce an Export Format with
     * exactly one entry matching that ID (with sensitive fields stripped).
     */
    it('exportEntries(id) returns exactly one entry matching that ID with sensitive fields stripped', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            fc.array(arbValidEntryWithoutId, { minLength: 1, maxLength: 5 }),
            fc.nat(),
            (entries, pickIndex) => {
                // Use a fresh registry file per iteration
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                // Add all entries and collect their IDs
                const ids = entries.map(entry => reg.add(entry));

                // Pick a random entry by index
                const targetIndex = pickIndex % ids.length;
                const targetId = ids[targetIndex];

                // Export by ID
                const exported = reg.exportEntries(targetId);

                // Verify Export Format structure
                assert.strictEqual(exported.version, '1.0', 'version should be "1.0"');
                assert.strictEqual(typeof exported.exportedAt, 'string', 'exportedAt should be a string');
                assert.ok(
                    ISO_8601_PATTERN.test(exported.exportedAt),
                    `exportedAt should be valid ISO 8601 but got "${exported.exportedAt}"`
                );
                assert.strictEqual(exported.exportedBy, 'anonymous', 'exportedBy should be "anonymous"');
                assert.ok(Array.isArray(exported.entries), 'entries should be an array');

                // Verify exactly one entry
                assert.strictEqual(
                    exported.entries.length,
                    1,
                    `Should have exactly 1 entry but got ${exported.entries.length}`
                );

                // Verify the entry has the correct ID
                assert.strictEqual(
                    exported.entries[0].id,
                    targetId,
                    `Exported entry ID should be "${targetId}" but got "${exported.entries[0].id}"`
                );

                // Verify sensitive fields are stripped
                const entry = exported.entries[0];
                assert.strictEqual(
                    'roleArn' in (entry.infrastructure || {}),
                    false,
                    'roleArn should be stripped'
                );
                assert.strictEqual(
                    'region' in (entry.infrastructure || {}),
                    false,
                    'region should be stripped'
                );
                if (entry.configuration?.parameters) {
                    for (const key of SENSITIVE_PARAM_KEYS) {
                        assert.strictEqual(
                            key in entry.configuration.parameters,
                            false,
                            `${key} should be stripped from parameters`
                        );
                    }
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
