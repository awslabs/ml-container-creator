// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Resource Grouping Property-Based Tests
 *
 * Property 11: Resource grouping by project
 *
 * getResourcesByProject returns Map where union of all arrays equals full resource list.
 * getStatusCounts has active + deleted + unknown = total count.
 *
 * Feature: deployment-registry, Property 11: Resource grouping by project
 *
 * **Validates: Requirements 6.2, 6.3, 6.6**
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

const arbProjectName = fc.constantFrom(
    'project-alpha', 'project-beta', 'project-gamma', 'project-delta'
);

const arbMetadata = fc.dictionary(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/).filter(s => s.length >= 1),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { minKeys: 0, maxKeys: 3 }
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

describe('Feature: deployment-registry, Property 11: Resource grouping by project', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-grouping-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 6.2, 6.3**
     */
    it('getResourcesByProject returns Map where union of all arrays equals full resource list', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 0, maxLength: 12 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                }),
            (records) => {
                const manager = new AssetManager('grouping-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const grouped = manager.getResourcesByProject();
                assert.ok(grouped instanceof Map, 'Should return a Map');

                // Union of all arrays should equal total resource count
                let totalGrouped = 0;
                const allGroupedIds = new Set();
                for (const [project, resources] of grouped) {
                    totalGrouped += resources.length;
                    for (const r of resources) {
                        assert.strictEqual(
                            r.project,
                            project,
                            `Resource in group "${project}" should have matching project`
                        );
                        allGroupedIds.add(r.resourceId);
                    }
                }

                assert.strictEqual(
                    totalGrouped,
                    records.length,
                    'Union of all groups should equal total resource count'
                );

                // Every record should appear in exactly one group
                for (const record of records) {
                    assert.ok(
                        allGroupedIds.has(record.resourceId),
                        `Resource ${record.resourceId} should appear in a group`
                    );
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-grouping-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 6.6**
     */
    it('getStatusCounts has active + deleted + unknown = total count', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 0, maxLength: 12 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                }),
            (records) => {
                const manager = new AssetManager('counts-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const counts = manager.getStatusCounts();
                const total = counts.active + counts.deleted + counts.unknown;

                assert.strictEqual(
                    total,
                    records.length,
                    `active(${counts.active}) + deleted(${counts.deleted}) + unknown(${counts.unknown}) should equal total(${records.length})`
                );

                // Verify counts match manual counting
                const expectedActive = records.filter(r => r.status === 'active').length;
                const expectedDeleted = records.filter(r => r.status === 'deleted').length;
                const expectedUnknown = records.filter(r => r.status === 'unknown').length;

                assert.strictEqual(counts.active, expectedActive);
                assert.strictEqual(counts.deleted, expectedDeleted);
                assert.strictEqual(counts.unknown, expectedUnknown);

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-grouping-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
