// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Drift Detection Property-Based Tests
 *
 * Property 12: Drift detection status update
 *
 * For any manifest containing `active` resources, when drift detection
 * determines a resource does not exist in AWS, the Asset_Manager SHALL
 * update that resource's status to `unknown`. Resources confirmed to
 * exist SHALL remain `active`. Resources already `deleted` or `unknown`
 * SHALL not be checked.
 *
 * Feature: deployment-registry, Property 12: Drift detection status update
 *
 * **Validates: Requirements 7.7**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager, { VALID_RESOURCE_TYPES, VALID_STATUSES } from '../../src/lib/asset-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
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

describe('Feature: deployment-registry, Property 12: Drift detection status update', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-drift-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 7.7**
     *
     * Simulates drift detection:
     * 1. Create a manifest with random active/deleted/unknown resources
     * 2. Randomly decide which active resources "exist" in AWS (simulated boolean)
     * 3. For active resources that don't exist, call updateStatus(id, 'unknown')
     * 4. Verify: active resources that "exist" remain active, those that don't
     *    become unknown, deleted/unknown resources are unchanged
     */
    it('drift detection updates missing active resources to unknown and leaves others unchanged', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 1, maxLength: 12 })
                .map(records => {
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                })
                .filter(records => records.length >= 1),
            fc.infiniteStream(fc.boolean()),
            (records, existsStream) => {
                const manager = new AssetManager('drift-test', { configDir: tmpDir });

                // Seed the manifest with all records
                for (const record of records) {
                    manager.addResource(record);
                }

                // Snapshot the state before drift detection
                const beforeResources = manager.listResources();
                const beforeMap = new Map(
                    beforeResources.map(r => [r.resourceId, { ...r }])
                );

                // Identify active resources and simulate AWS existence check
                const activeResources = beforeResources.filter(r => r.status === 'active');
                const existsMap = new Map();
                for (const resource of activeResources) {
                    existsMap.set(resource.resourceId, existsStream.next().value);
                }

                // Simulate drift detection: only check active resources
                for (const resource of activeResources) {
                    const existsInAws = existsMap.get(resource.resourceId);
                    if (!existsInAws) {
                        manager.updateStatus(resource.resourceId, 'unknown');
                    }
                }

                // Verify results
                const afterResources = manager.listResources();

                // Total resource count should not change
                assert.strictEqual(
                    afterResources.length,
                    beforeResources.length,
                    'Resource count should not change during drift detection'
                );

                for (const after of afterResources) {
                    const before = beforeMap.get(after.resourceId);

                    if (before.status === 'deleted' || before.status === 'unknown') {
                        // Resources already deleted or unknown should not be checked
                        assert.strictEqual(
                            after.status,
                            before.status,
                            `Resource ${after.resourceId} with status '${before.status}' should remain unchanged`
                        );
                        assert.strictEqual(
                            after.lastUpdatedAt,
                            before.lastUpdatedAt,
                            `Resource ${after.resourceId} lastUpdatedAt should remain unchanged`
                        );
                    } else if (before.status === 'active') {
                        const existsInAws = existsMap.get(after.resourceId);
                        if (existsInAws) {
                            // Active resources confirmed to exist remain active
                            assert.strictEqual(
                                after.status,
                                'active',
                                `Resource ${after.resourceId} confirmed to exist should remain active`
                            );
                        } else {
                            // Active resources not found become unknown
                            assert.strictEqual(
                                after.status,
                                'unknown',
                                `Resource ${after.resourceId} not found in AWS should become unknown`
                            );
                        }
                    }
                }

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-drift-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
