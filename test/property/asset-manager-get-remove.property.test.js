// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager getResource and removeResource Property-Based Tests
 *
 * Property 9: getResource returns matching record or null
 * Property 10: removeResource reduces count by 1, subsequent getResource returns null
 *
 * Feature: deployment-registry, Properties 9–10: getResource and removeResource
 *
 * **Validates: Requirements 8.4, 8.5**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager, { VALID_RESOURCE_TYPES, VALID_STATUSES } from '../../src/lib/asset-manager.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

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

describe('Feature: deployment-registry, Properties 9–10: getResource and removeResource', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-get-remove-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Property 9: getResource returns matching record or null
     *
     * **Validates: Requirements 8.4**
     */
    it('getResource returns matching record for added resources and null for non-existent', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 1, maxLength: 10 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                })
                .filter(records => records.length >= 1),
            arbResourceId,
            (records, nonExistentId) => {
                const existingIds = new Set(records.map(r => r.resourceId));
                if (existingIds.has(nonExistentId)) return true; // skip collision

                const manager = new AssetManager('get-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                // Each added resource should be retrievable
                for (const record of records) {
                    const result = manager.getResource(record.resourceId);
                    assert.ok(result !== null, `Should find resource ${record.resourceId}`);
                    assert.strictEqual(result.resourceId, record.resourceId);
                    assert.strictEqual(result.resourceType, record.resourceType);
                    assert.strictEqual(result.project, record.project);
                }

                // Non-existent resource should return null
                const missing = manager.getResource(nonExistentId);
                assert.strictEqual(missing, null, 'Should return null for non-existent resourceId');

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-get-remove-'));

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Property 10: removeResource reduces count by 1, subsequent getResource returns null
     *
     * **Validates: Requirements 8.5**
     */
    it('removeResource reduces count by 1 and subsequent getResource returns null', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 1, maxLength: 10 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                })
                .filter(records => records.length >= 1),
            (records) => {
                const manager = new AssetManager('remove-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const countBefore = manager.listResources().length;
                const targetId = records[0].resourceId;

                const result = manager.removeResource(targetId);
                assert.strictEqual(result, true, 'Should return true for existing resource');

                const countAfter = manager.listResources().length;
                assert.strictEqual(
                    countAfter,
                    countBefore - 1,
                    'Count should decrease by exactly 1'
                );

                // Subsequent getResource should return null
                const removed = manager.getResource(targetId);
                assert.strictEqual(removed, null, 'Removed resource should not be found');

                // Other records should remain
                for (let i = 1; i < records.length; i++) {
                    const other = manager.getResource(records[i].resourceId);
                    assert.ok(other !== null, `Other resource ${records[i].resourceId} should still exist`);
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-get-remove-'));

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
