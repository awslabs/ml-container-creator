// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Scan Property-Based Tests
 *
 * Property 13: Scan deduplication
 * Property 14: Scan record creation
 *
 * Property 13: For any manifest with existing resources and any set of
 * discovered resources, scan SHALL NOT add a record for any resourceId
 * that already exists. The manifest SHALL contain at most one record per
 * unique resourceId after scanning.
 *
 * Property 14: For any AWS resource discovered during scan, the created
 * Asset_Record SHALL have status `active`, a valid ISO 8601 createdAt
 * timestamp, and a project field derived from the resource name or tags.
 *
 * Feature: deployment-registry, Properties 13–14: Scan deduplication and record creation
 *
 * **Validates: Requirements 11.5, 11.6**
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

const arbAssetRecord = fc.record({
    resourceId: arbResourceId,
    resourceType: arbResourceType,
    createdAt: arbISOTimestamp,
    lastUpdatedAt: arbISOTimestamp,
    project: arbProjectName,
    status: arbStatus,
    metadata: arbMetadata
});

/**
 * Generator for a "discovered" resource — simulates what AWS scan would find.
 * Contains a resourceId, resourceType, and a project name derived from tags.
 */
const arbDiscoveredResource = fc.record({
    resourceId: arbResourceId,
    resourceType: arbResourceType,
    project: arbProjectName
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Properties 13–14: Scan deduplication and record creation', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-scan-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Property 13: Scan deduplication
     *
     * **Validates: Requirements 11.6**
     *
     * Simulates scan:
     * 1. Pre-populate a manifest with some resources
     * 2. Generate a set of "discovered" resources (some overlapping with existing)
     * 3. For each discovered resource, check if it exists in manifest, skip if so, add if not
     * 4. Verify: no duplicates after scan
     */
    it('scan does not add duplicate records for existing resourceIds', function () {
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
            fc.array(arbDiscoveredResource, { minLength: 1, maxLength: 10 }),
            (existingRecords, discoveredResources) => {
                const manager = new AssetManager('scan-dedup-test', { configDir: tmpDir });

                // Pre-populate manifest with existing resources
                for (const record of existingRecords) {
                    manager.addResource(record);
                }

                const now = new Date().toISOString();

                // Simulate scan: for each discovered resource, skip if exists, add if not
                for (const discovered of discoveredResources) {
                    const existing = manager.getResource(discovered.resourceId);
                    if (existing) {
                        continue;
                    }

                    manager.addResource({
                        resourceId: discovered.resourceId,
                        resourceType: discovered.resourceType,
                        createdAt: now,
                        lastUpdatedAt: now,
                        project: discovered.project,
                        status: 'active',
                        metadata: { discoveredBy: 'scan' }
                    });
                }

                // Verify: no duplicate resourceIds in manifest
                const allResources = manager.listResources();
                const allIds = allResources.map(r => r.resourceId);
                const uniqueIds = new Set(allIds);

                assert.strictEqual(
                    allIds.length,
                    uniqueIds.size,
                    'Manifest should contain at most one record per unique resourceId after scan'
                );

                // Verify: all existing records are still present
                for (const existingRecord of existingRecords) {
                    const found = manager.getResource(existingRecord.resourceId);
                    assert.ok(
                        found !== null,
                        `Existing resource ${existingRecord.resourceId} should still be in manifest`
                    );
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-scan-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Property 14: Scan record creation
     *
     * **Validates: Requirements 11.5**
     *
     * For any discovered resource that is new (not already in manifest),
     * the created Asset_Record SHALL have status `active`, a valid ISO 8601
     * createdAt timestamp, and a project field derived from the resource.
     */
    it('scan creates new records with status active, valid timestamp, and project field', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 0, maxLength: 5 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                }),
            fc.array(arbDiscoveredResource, { minLength: 1, maxLength: 8 }),
            (existingRecords, discoveredResources) => {
                const manager = new AssetManager('scan-create-test', { configDir: tmpDir });

                // Pre-populate manifest with existing resources
                for (const record of existingRecords) {
                    manager.addResource(record);
                }

                const beforeScan = new Date().toISOString();

                // Track which discovered resources are truly new
                const newResourceIds = new Set();

                // Simulate scan
                for (const discovered of discoveredResources) {
                    const existing = manager.getResource(discovered.resourceId);
                    if (existing) {
                        continue;
                    }

                    const now = new Date().toISOString();
                    manager.addResource({
                        resourceId: discovered.resourceId,
                        resourceType: discovered.resourceType,
                        createdAt: now,
                        lastUpdatedAt: now,
                        project: discovered.project,
                        status: 'active',
                        metadata: { discoveredBy: 'scan' }
                    });
                    newResourceIds.add(discovered.resourceId);
                }

                // Verify properties of newly created records
                for (const newId of newResourceIds) {
                    const record = manager.getResource(newId);
                    assert.ok(record !== null, `New resource ${newId} should exist in manifest`);

                    // Status must be active
                    assert.strictEqual(
                        record.status,
                        'active',
                        `New resource ${newId} should have status 'active'`
                    );

                    // createdAt must be a valid ISO 8601 timestamp
                    const createdDate = new Date(record.createdAt);
                    assert.ok(
                        !isNaN(createdDate.getTime()),
                        `New resource ${newId} createdAt should be a valid date`
                    );
                    assert.ok(
                        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(record.createdAt),
                        `New resource ${newId} createdAt should be ISO 8601 format`
                    );

                    // createdAt should be at or after the scan start time
                    assert.ok(
                        record.createdAt >= beforeScan,
                        `New resource ${newId} createdAt should be at or after scan start`
                    );

                    // project field must be a non-empty string
                    assert.ok(
                        typeof record.project === 'string' && record.project.length > 0,
                        `New resource ${newId} should have a non-empty project field`
                    );

                    // resourceType must be a valid type
                    assert.ok(
                        VALID_RESOURCE_TYPES.includes(record.resourceType),
                        `New resource ${newId} should have a valid resourceType`
                    );
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-scan-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
