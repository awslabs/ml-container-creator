// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager addResource Property-Based Tests
 *
 * Property 5: addResource correctness and idempotency
 *
 * Manifest SHALL contain exactly one record per unique resourceId;
 * upsert updates lastUpdatedAt and status.
 *
 * Feature: deployment-registry, Property 5: addResource correctness and idempotency
 *
 * **Validates: Requirements 8.1, 8.6**
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

describe('Feature: deployment-registry, Property 5: addResource correctness and idempotency', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-add-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 8.1, 8.6**
     */
    it('manifest contains exactly one record per unique resourceId after multiple adds', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 1, maxLength: 15 }),
            (records) => {
                const manager = new AssetManager('add-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const allResources = manager.listResources();

                // Count unique resourceIds from input
                const uniqueIds = new Set(records.map(r => r.resourceId));

                // Manifest should have exactly one record per unique resourceId
                assert.strictEqual(
                    allResources.length,
                    uniqueIds.size,
                    'Should have exactly one record per unique resourceId'
                );

                // Each unique resourceId should appear exactly once
                const manifestIds = allResources.map(r => r.resourceId);
                const manifestIdSet = new Set(manifestIds);
                assert.strictEqual(
                    manifestIds.length,
                    manifestIdSet.size,
                    'No duplicate resourceIds in manifest'
                );

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-add-'));

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 8.1, 8.6**
     */
    it('upsert updates lastUpdatedAt and status on existing record', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbAssetRecord,
            arbStatus,
            arbISOTimestamp,
            (originalRecord, newStatus, newTimestamp) => {
                const manager = new AssetManager('upsert-test', { configDir: tmpDir });

                // Add original record
                manager.addResource(originalRecord);

                // Add updated record with same resourceId
                const updatedRecord = {
                    ...originalRecord,
                    status: newStatus,
                    lastUpdatedAt: newTimestamp
                };
                manager.addResource(updatedRecord);

                const resources = manager.listResources();
                assert.strictEqual(resources.length, 1, 'Should still have one record');

                const resource = manager.getResource(originalRecord.resourceId);
                assert.strictEqual(resource.status, newStatus, 'Status should be updated');
                assert.strictEqual(resource.lastUpdatedAt, newTimestamp, 'lastUpdatedAt should be updated');

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-add-'));

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
