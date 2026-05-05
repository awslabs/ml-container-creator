// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager File Format Correctness Property-Based Tests
 *
 * Property 2: Manifest file format correctness
 *
 * Written manifest SHALL have schemaVersion matching YYYY-MM-DD,
 * resources array, 2-space indentation, trailing newline.
 *
 * Feature: deployment-registry, Property 2: Manifest file format correctness
 *
 * **Validates: Requirements 1.3, 1.4**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

describe('Feature: deployment-registry, Property 2: Manifest file format correctness', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-format-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * **Validates: Requirements 1.3, 1.4**
     */
    it('written manifest has correct schemaVersion, resources array, 2-space indentation, and trailing newline', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

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
                const manager = new AssetManager('format-test', { configDir: tmpDir });

                for (const record of records) {
                    manager.addResource(record);
                }

                const raw = readFileSync(manager.manifestPath, 'utf8');
                const data = JSON.parse(raw);

                // schemaVersion matches YYYY-MM-DD
                assert.ok(
                    /^\d{4}-\d{2}-\d{2}$/.test(data.schemaVersion),
                    `schemaVersion should match YYYY-MM-DD: ${data.schemaVersion}`
                );

                // resources is an array
                assert.ok(
                    Array.isArray(data.resources),
                    'resources should be an array'
                );

                // Trailing newline
                assert.ok(
                    raw.endsWith('\n'),
                    'file should end with trailing newline'
                );

                // 2-space indentation: re-serialize with 2-space and compare
                const expected = `${JSON.stringify(data, null, 2)  }\n`;
                assert.strictEqual(
                    raw,
                    expected,
                    'file should use 2-space indentation'
                );

                // Clean up for next iteration
                rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = mkdtempSync(join(tmpdir(), 'asset-format-'));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
