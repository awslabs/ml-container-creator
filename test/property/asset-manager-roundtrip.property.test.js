// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Round-Trip Integrity Property-Based Tests
 *
 * Property 1: Manifest round-trip integrity
 *
 * For any valid manifest, reading then writing SHALL produce byte-equivalent
 * content, preserving schema version, resource order, field values, 2-space
 * indentation, and trailing newline.
 *
 * Feature: deployment-registry, Property 1: Manifest round-trip integrity
 *
 * **Validates: Requirements 1.7**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

describe('Feature: deployment-registry, Property 1: Manifest round-trip integrity', () => {

    let tmpDir;
    let manager;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-roundtrip-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 1.7**
     */
    it('reading then writing a manifest produces byte-equivalent content', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbAssetRecord, { minLength: 0, maxLength: 10 })
                .map(records => {
                    // Deduplicate by resourceId
                    const seen = new Set();
                    return records.filter(r => {
                        if (seen.has(r.resourceId)) return false;
                        seen.add(r.resourceId);
                        return true;
                    });
                }),
            (records) => {
                manager = new AssetManager('roundtrip-test', { configDir: tmpDir });

                // Add all records to build a manifest
                for (const record of records) {
                    manager.addResource(record);
                }

                if (records.length === 0) {
                    // No file created yet, nothing to round-trip
                    return true;
                }

                // Read the file content before round-trip
                const contentBefore = readFileSync(manager.manifestPath, 'utf8');

                // Perform round-trip: read then write
                const manifest = manager._readManifest();
                manager._writeManifest(manifest);

                // Read the file content after round-trip
                const contentAfter = readFileSync(manager.manifestPath, 'utf8');

                assert.strictEqual(
                    contentAfter,
                    contentBefore,
                    'Round-trip should produce byte-equivalent content'
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
