// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager listResources Filtering Property-Based Tests
 *
 * Property 8: listResources filtering
 *
 * listResources returns exactly those records matching ALL provided
 * filters (AND logic).
 *
 * Feature: deployment-registry, Property 8: listResources filtering
 *
 * **Validates: Requirement 8.3**
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

const arbFilters = fc.record({
    resourceType: fc.option(arbResourceType, { nil: undefined }),
    project: fc.option(arbProjectName, { nil: undefined }),
    status: fc.option(arbStatus, { nil: undefined })
}).map(f => {
    const cleaned = {};
    if (f.resourceType !== undefined) cleaned.resourceType = f.resourceType;
    if (f.project !== undefined) cleaned.project = f.project;
    if (f.status !== undefined) cleaned.status = f.status;
    return cleaned;
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 8: listResources filtering', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-filter-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirement 8.3**
     */
    it('listResources returns exactly those records matching ALL provided filters', function () {
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
            arbFilters,
            (records, filters) => {
                const manager = new AssetManager('filter-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const result = manager.listResources(filters);

                // Compute expected result manually with AND logic
                const expected = records.filter(r => {
                    if (filters.resourceType && r.resourceType !== filters.resourceType) return false;
                    if (filters.project && r.project !== filters.project) return false;
                    if (filters.status && r.status !== filters.status) return false;
                    return true;
                });

                assert.strictEqual(
                    result.length,
                    expected.length,
                    `Filter ${JSON.stringify(filters)} should return ${expected.length} records, got ${result.length}`
                );

                // Verify each returned record matches all filters
                for (const r of result) {
                    if (filters.resourceType) {
                        assert.strictEqual(r.resourceType, filters.resourceType);
                    }
                    if (filters.project) {
                        assert.strictEqual(r.project, filters.project);
                    }
                    if (filters.status) {
                        assert.strictEqual(r.status, filters.status);
                    }
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-filter-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
