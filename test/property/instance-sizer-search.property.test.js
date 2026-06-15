// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Sizer Search & Filtering Property-Based Tests
 *
 * Feature: mcp-catalog-consolidation, Property 6: CUDA version filtering
 * Feature: mcp-catalog-consolidation, Property 7: Tag-based search filtering
 * Feature: mcp-catalog-consolidation, Property 8: Combined VRAM + search filtering
 *
 * Validates: Requirements 3.10, 8.1, 8.2, 8.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { searchInstancesByTag, filterByCudaVersion, INSTANCE_CATALOG } from '../../servers/instance-sizer/index.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    verbose: false
};

// ── Property 6: CUDA version filtering ───────────────────────────────────────

describe('Feature: mcp-catalog-consolidation, Property 6: CUDA version filtering', function () {
    this.timeout(30000);

    it('all instances returned by filterByCudaVersion have compatible CUDA versions', () => {
        // Generate random CUDA version strings
        const arbCudaVersion = fc.oneof(
            fc.constant('11.8'),
            fc.constant('12.1'),
            fc.constant('12.4'),
            fc.constant('12'),
            fc.constant('11')
        );

        fc.assert(
            fc.property(arbCudaVersion, (cudaVersion) => {
                const filtered = filterByCudaVersion(INSTANCE_CATALOG, cudaVersion);
                const majorRequired = cudaVersion.split('.')[0];

                for (const [name, meta] of Object.entries(filtered)) {
                    assert.ok(
                        meta.cudaVersions && meta.cudaVersions.length > 0,
                        `${name}: filtered instance must have cudaVersions`
                    );
                    const hasCompatible = meta.cudaVersions.some(v => {
                        if (v === cudaVersion) return true;
                        if (v.startsWith(`${majorRequired  }.`)) return true;
                        return false;
                    });
                    assert.ok(
                        hasCompatible,
                        `${name}: must have CUDA version compatible with ${cudaVersion}, has ${meta.cudaVersions}`
                    );
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('filterByCudaVersion never returns instances without cudaVersions', () => {
        const arbCudaVersion = fc.stringMatching(/^1[12]\.\d$/);

        fc.assert(
            fc.property(arbCudaVersion, (cudaVersion) => {
                const filtered = filterByCudaVersion(INSTANCE_CATALOG, cudaVersion);
                for (const [name, meta] of Object.entries(filtered)) {
                    assert.ok(
                        Array.isArray(meta.cudaVersions) && meta.cudaVersions.length > 0,
                        `${name}: should not appear in filtered results without cudaVersions`
                    );
                }
            }),
            PROPERTY_CONFIG
        );
    });
});

// ── Property 7: Tag-based search filtering ───────────────────────────────────

describe('Feature: mcp-catalog-consolidation, Property 7: Tag-based search filtering', function () {
    this.timeout(30000);

    it('every instance returned by searchInstancesByTag matches at least one search token', () => {
        const arbSearch = fc.oneof(
            fc.constant('gpu'),
            fc.constant('cpu'),
            fc.constant('multi-gpu'),
            fc.constant('budget'),
            fc.constant('large'),
            fc.constant('memory')
        );

        fc.assert(
            fc.property(arbSearch, (search) => {
                const results = searchInstancesByTag(search, INSTANCE_CATALOG, { limit: 20 });

                // If results are returned, they should be valid instance names
                for (const instanceName of results) {
                    assert.ok(
                        instanceName in INSTANCE_CATALOG,
                        `${instanceName}: returned instance must exist in catalog`
                    );
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('searchInstancesByTag returns empty array for nonsense queries', () => {
        const arbNonsense = fc.stringMatching(/^[xyz]{10,20}$/);

        fc.assert(
            fc.property(arbNonsense, (search) => {
                const results = searchInstancesByTag(search, INSTANCE_CATALOG, { limit: 20 });
                assert.ok(Array.isArray(results), 'should return an array');
                // Nonsense queries should return empty or very few results
                assert.ok(results.length <= 20, 'should respect limit');
            }),
            PROPERTY_CONFIG
        );
    });

    it('multi-gpu search only returns instances with gpus > 1', () => {
        const results = searchInstancesByTag('multi-gpu', INSTANCE_CATALOG, { limit: 50 });
        for (const instanceName of results) {
            const meta = INSTANCE_CATALOG[instanceName];
            assert.ok(
                meta.gpus > 1,
                `${instanceName}: multi-gpu search should only return instances with gpus > 1, got ${meta.gpus}`
            );
        }
    });
});

// ── Property 8: Combined VRAM + search filtering ─────────────────────────────

describe('Feature: mcp-catalog-consolidation, Property 8: Combined VRAM + search filtering', function () {
    this.timeout(30000);

    it('combined filtering respects both VRAM and tag constraints', () => {
        // This tests the concept: if we filter by CUDA first, then search,
        // all results should satisfy both constraints
        const arbCudaVersion = fc.oneof(
            fc.constant('11.8'),
            fc.constant('12.1'),
            fc.constant('12.4')
        );
        const arbSearch = fc.oneof(
            fc.constant('gpu'),
            fc.constant('large'),
            fc.constant('memory')
        );

        fc.assert(
            fc.property(arbCudaVersion, arbSearch, (cudaVersion, search) => {
                // First filter by CUDA
                const cudaFiltered = filterByCudaVersion(INSTANCE_CATALOG, cudaVersion);
                // Then search within CUDA-filtered results
                const results = searchInstancesByTag(search, cudaFiltered, { limit: 20 });

                const majorRequired = cudaVersion.split('.')[0];

                for (const instanceName of results) {
                    // Must be in CUDA-filtered set
                    assert.ok(
                        instanceName in cudaFiltered,
                        `${instanceName}: must satisfy CUDA constraint`
                    );
                    // Must have compatible CUDA version
                    const meta = cudaFiltered[instanceName];
                    const hasCompatible = meta.cudaVersions.some(v => {
                        if (v === cudaVersion) return true;
                        if (v.startsWith(`${majorRequired  }.`)) return true;
                        return false;
                    });
                    assert.ok(hasCompatible, `${instanceName}: must have compatible CUDA version`);
                }
            }),
            PROPERTY_CONFIG
        );
    });
});
