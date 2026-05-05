// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager updateStatus Property-Based Tests
 *
 * Property 6: updateStatus on existing resource updates exactly that record
 * Property 7: updateStatus on non-existent resourceId returns false, leaves manifest unchanged
 *
 * Feature: deployment-registry, Properties 6–7: updateStatus correctness
 *
 * **Validates: Requirements 5.1–5.4, 5.9, 5.10, 8.2**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager, { VALID_RESOURCE_TYPES, VALID_STATUSES } from '../../generators/app/lib/asset-manager.js';

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

const arbAssetRecord = fc.record({
    resourceId: arbResourceId,
    resourceType: arbResourceType,
    createdAt: arbISOTimestamp,
    lastUpdatedAt: arbISOTimestamp,
    project: arbProjectName,
    status: arbStatus,
    metadata: arbMetadata
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Properties 6–7: updateStatus correctness', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-update-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Property 6: updateStatus on existing resource updates exactly that record
     *
     * **Validates: Requirements 5.1–5.4, 5.9, 8.2**
     */
    it('updateStatus on existing resource updates exactly that record', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 1, maxLength: 8 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                })
                .filter(records => records.length >= 1),
            arbStatus,
            (records, newStatus) => {
                const manager = new AssetManager('update-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                // Pick the first record to update
                const targetId = records[0].resourceId;
                const beforeUpdate = new Date().toISOString();

                const result = manager.updateStatus(targetId, newStatus);
                assert.strictEqual(result, true, 'Should return true for existing resource');

                // Verify the target was updated
                const updated = manager.getResource(targetId);
                assert.strictEqual(updated.status, newStatus, 'Status should be updated');
                assert.ok(
                    updated.lastUpdatedAt >= beforeUpdate,
                    'lastUpdatedAt should be updated to current time or later'
                );

                // Verify other records are unchanged
                for (let i = 1; i < records.length; i++) {
                    const other = manager.getResource(records[i].resourceId);
                    assert.strictEqual(
                        other.status,
                        records[i].status,
                        `Other record ${records[i].resourceId} status should be unchanged`
                    );
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-update-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Property 7: updateStatus on non-existent resourceId returns false, leaves manifest unchanged
     *
     * **Validates: Requirements 5.10**
     */
    it('updateStatus on non-existent resourceId returns false and leaves manifest unchanged', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 0, maxLength: 8 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                }),
            arbResourceId,
            arbStatus,
            (records, nonExistentId, newStatus) => {
                // Ensure nonExistentId is not in the records
                const existingIds = new Set(records.map(r => r.resourceId));
                if (existingIds.has(nonExistentId)) return true; // skip this case

                const manager = new AssetManager('update-noexist-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                // Snapshot before
                const resourcesBefore = manager.listResources();

                const result = manager.updateStatus(nonExistentId, newStatus);
                assert.strictEqual(result, false, 'Should return false for non-existent resource');

                // Verify manifest is unchanged
                const resourcesAfter = manager.listResources();
                assert.strictEqual(
                    resourcesAfter.length,
                    resourcesBefore.length,
                    'Resource count should be unchanged'
                );

                for (let i = 0; i < resourcesBefore.length; i++) {
                    assert.deepStrictEqual(
                        resourcesAfter[i],
                        resourcesBefore[i],
                        'Each record should be unchanged'
                    );
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-update-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
