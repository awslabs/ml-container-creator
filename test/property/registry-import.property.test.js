// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Import Property-Based Tests
 *
 * Property 12: Import sets metadata fields
 * Property 13: Import conflict resolution strategies
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import DeploymentRegistry from '../../generators/app/lib/deployment-registry.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
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

const arbHexId = fc.stringMatching(/^[0-9a-f]{8}$/);

const arbFilename = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,19}\.json$/)
    .filter(s => s.length >= 5);

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

/**
 * Generate a valid deployment entry WITH an id field.
 * Used for building Export Format entries.
 */
const arbValidEntryWithId = fc.tuple(arbHexId, arbValidEntryWithoutId)
    .map(([id, entry]) => ({ ...entry, id }));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 12: Import sets metadata fields', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-import-p12-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 8.2
     *
     * For any valid Export Format and any filename, importing should set
     * metadata.source to "imported" and metadata.importedFrom to the
     * filename on every imported entry.
     */
    it('importing sets metadata.source to "imported" and metadata.importedFrom to filename on all entries', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            fc.array(arbValidEntryWithId, { minLength: 1, maxLength: 5 }),
            arbFilename,
            (entries, filename) => {
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                const exportFormat = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'anonymous',
                    entries
                };

                reg.importEntries(exportFormat, 'skip', filename);

                // Read back all entries from the registry
                const allEntries = reg.list();

                // Every imported entry should have correct metadata
                assert.strictEqual(
                    allEntries.length,
                    entries.length,
                    `Registry should have ${entries.length} entries but has ${allEntries.length}`
                );

                for (const entry of allEntries) {
                    assert.strictEqual(
                        entry.metadata.source,
                        'imported',
                        `metadata.source should be "imported" but got "${entry.metadata.source}"`
                    );
                    assert.strictEqual(
                        entry.metadata.importedFrom,
                        filename,
                        `metadata.importedFrom should be "${filename}" but got "${entry.metadata.importedFrom}"`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});


describe('Feature: deployment-registry, Property 13: Import conflict resolution strategies', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-import-p13-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 8.3, 8.4, 8.5, 8.6
     *
     * For any registry with existing entries and any import containing
     * conflicting entries (matching modelName, backend, instanceType,
     * and parameters): with default strategy, conflicting entries are
     * skipped; with merge, both are present; with replace, the imported
     * entry replaces the existing one. In all cases, the returned summary
     * counts (added + skipped + conflicts) should equal the total number
     * of entries in the import.
     */
    it('skip strategy: conflicting entries are skipped, registry unchanged', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            arbValidEntryWithoutId,
            arbNonEmptyString,
            (baseEntry, extraNotes) => {
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                // Add the base entry to the registry
                const existingId = reg.add(baseEntry);
                const countBefore = reg.list().length;

                // Create a conflicting import entry: same modelName, backend,
                // instanceType, parameters but different notes
                const conflictingEntry = JSON.parse(JSON.stringify(baseEntry));
                conflictingEntry.id = 'cc000001';
                conflictingEntry.outcome = { notes: extraNotes };

                const exportFormat = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'anonymous',
                    entries: [conflictingEntry]
                };

                const result = reg.importEntries(exportFormat, 'skip', 'test.json');

                // With skip strategy, conflicting entry is skipped
                assert.ok(result.skipped >= 1, 'Should have at least 1 skipped entry');
                assert.ok(result.conflicts >= 1, 'Should have at least 1 conflict detected');

                // Registry size should be unchanged
                const countAfter = reg.list().length;
                assert.strictEqual(countAfter, countBefore, 'Registry size should not change with skip strategy');

                // Original entry should still be there
                const original = reg.get(existingId);
                assert.ok(original, 'Original entry should still exist');

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('merge strategy: both existing and imported entries are present', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            arbValidEntryWithoutId,
            arbNonEmptyString,
            (baseEntry, extraNotes) => {
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                // Add the base entry to the registry
                const existingId = reg.add(baseEntry);
                const countBefore = reg.list().length;

                // Create a conflicting import entry
                const conflictingEntry = JSON.parse(JSON.stringify(baseEntry));
                conflictingEntry.id = 'cc000002';
                conflictingEntry.outcome = { notes: extraNotes };

                const exportFormat = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'anonymous',
                    entries: [conflictingEntry]
                };

                const result = reg.importEntries(exportFormat, 'merge', 'test.json');

                // With merge, conflict is detected and both entries are kept
                assert.strictEqual(result.conflicts, 1, 'Should have 1 conflict');
                assert.strictEqual(result.skipped, 0, 'Should have 0 skipped with merge');

                // Registry should have one more entry (both kept)
                const countAfter = reg.list().length;
                assert.strictEqual(countAfter, countBefore + 1, 'Registry should grow by 1 with merge strategy');

                // Original entry should still be there
                const original = reg.get(existingId);
                assert.ok(original, 'Original entry should still exist');

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('replace strategy: imported entry replaces existing one', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            arbValidEntryWithoutId,
            arbNonEmptyString,
            (baseEntry, extraNotes) => {
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                // Add the base entry to the registry
                const existingId = reg.add(baseEntry);
                const countBefore = reg.list().length;

                // Create a conflicting import entry
                const conflictingEntry = JSON.parse(JSON.stringify(baseEntry));
                conflictingEntry.id = 'cc000003';
                conflictingEntry.outcome = { notes: extraNotes };

                const exportFormat = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'anonymous',
                    entries: [conflictingEntry]
                };

                const result = reg.importEntries(exportFormat, 'replace', 'test.json');

                // With replace, conflict is detected and existing is replaced
                assert.strictEqual(result.conflicts, 1, 'Should have 1 conflict');
                assert.strictEqual(result.skipped, 0, 'Should have 0 skipped with replace');

                // Registry size should be unchanged (replaced, not added)
                const countAfter = reg.list().length;
                assert.strictEqual(countAfter, countBefore, 'Registry size should not change with replace strategy');

                // The entry at the existing ID should now have imported metadata
                const replaced = reg.get(existingId);
                assert.ok(replaced, 'Replaced entry should exist at original ID');
                assert.strictEqual(
                    replaced.metadata.source,
                    'imported',
                    'Replaced entry should have metadata.source = "imported"'
                );
                assert.strictEqual(
                    replaced.metadata.importedFrom,
                    'test.json',
                    'Replaced entry should have metadata.importedFrom = "test.json"'
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('non-conflicting entries are always added regardless of strategy', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        let iterCount = 0;

        fc.assert(fc.property(
            arbValidEntryWithId,
            fc.constantFrom('skip', 'merge', 'replace'),
            arbFilename,
            (importEntry, strategy, filename) => {
                // Empty registry — no conflicts possible
                const iterPath = join(tmpDir, `registry-${iterCount++}.json`);
                const reg = new DeploymentRegistry(iterPath);

                const exportFormat = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'anonymous',
                    entries: [importEntry]
                };

                const result = reg.importEntries(exportFormat, strategy, filename);

                // No conflicts, so the entry should be added
                assert.strictEqual(result.added, 1, 'Should have 1 added entry');
                assert.strictEqual(result.conflicts, 0, 'Should have 0 conflicts');
                assert.strictEqual(result.skipped, 0, 'Should have 0 skipped');

                // Verify the entry is in the registry
                const allEntries = reg.list();
                assert.strictEqual(allEntries.length, 1, 'Registry should have 1 entry');

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
