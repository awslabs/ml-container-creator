// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Region Picker Response Equivalence Property-Based Tests
 *
 * Verifies that the externalized region-picker (loading catalogs from
 * JSON files) produces identical responses to the original hardcoded data
 * for all search term combinations.
 *
 * Feature: mcp-server-externalization, Property 4: Externalized region-picker produces identical responses
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
=======
import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
import {
    filterRegions,
    AWS_REGIONS,
    VALID_REGION_CODES
<<<<<<< HEAD
} from '../../servers/region-picker/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
=======
} from '../../servers/region-picker/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}
=======
};
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Snapshot: load original catalog data directly from JSON files ─────────────
// These represent the "ground truth" — the externalized JSON files that replaced
// the original hardcoded constants. We load them independently to build expected
// outputs and compare against filterRegions() results.

<<<<<<< HEAD
const catalogsDir = resolve(__dirname, '../../servers/region-picker/catalogs')

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'))
=======
const catalogsDir = resolve(__dirname, '../../servers/region-picker/catalogs');

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the expected filterRegions output for a given search term and limit,
 * using the raw catalog data loaded directly from the JSON file.
 * This simulates what the original hardcoded version would have returned.
 */
function buildExpectedOutput(snapshotRegions, searchTerm, limit) {
<<<<<<< HEAD
    let matched

    if (searchTerm) {
        const term = searchTerm.toLowerCase()
        matched = snapshotRegions.filter(
            r => r.code.toLowerCase().includes(term) ||
                 r.labels.some(l => l.toLowerCase().includes(term))
        )
    } else {
        matched = snapshotRegions
    }

    const codes = matched.map(r => r.code).slice(0, limit)

    if (codes.length === 0) {
        return { values: {}, choices: { awsRegion: [] } }
=======
    let matched;

    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        matched = snapshotRegions.filter(
            r => r.code.toLowerCase().includes(term) ||
                 r.labels.some(l => l.toLowerCase().includes(term))
        );
    } else {
        matched = snapshotRegions;
    }

    const codes = matched.map(r => r.code).slice(0, limit);

    if (codes.length === 0) {
        return { values: {}, choices: { awsRegion: [] } };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
    }

    return {
        values: { awsRegion: codes[0] },
        choices: { awsRegion: codes }
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Generators ───────────────────────────────────────────────────────────────

// Search terms that exercise the filtering logic: region codes, labels, partial matches
const SEARCH_KEYWORDS = [
    'us-east', 'eu-west', 'ap-northeast', 'virginia', 'oregon',
    'london', 'tokyo', 'mumbai', 'ireland', 'frankfurt',
    'canada', 'brazil', 'singapore', 'sydney', 'seoul',
    'europe', 'asia', 'pacific', 'east', 'west',
    'us', 'eu', 'ap', 'sa', 'me', 'af'
<<<<<<< HEAD
]
=======
];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a random search term — either undefined, a keyword, or a random string.
 */
const arbSearchTerm = fc.oneof(
    fc.constant(undefined),
    fc.constantFrom(...SEARCH_KEYWORDS),
    fc.option(fc.string(), { nil: undefined })
<<<<<<< HEAD
)

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 30 })
=======
);

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 30 });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Region Picker Response Equivalence Property-Based Tests', () => {

<<<<<<< HEAD
    let snapshotRegions
=======
    let snapshotRegions;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    before(() => {
        // Load catalog independently from the JSON file to build a
        // "snapshot" that represents the original hardcoded behavior
<<<<<<< HEAD
        snapshotRegions = loadCatalogDirect('regions.json')
    })
=======
        snapshotRegions = loadCatalogDirect('regions.json');
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 4: Externalized region-picker produces identical responses
    describe('Property 4: Externalized region-picker produces identical responses', () => {

        /**
         * Validates: Requirements 3.5
         *
         * For any search term (including undefined) and any positive limit,
         * the externalized filterRegions() should produce output identical
         * to what the same filtering logic applied to the raw catalog JSON
         * file would produce.
         */
        it('for any search term, filterRegions() output matches snapshot-based expected output', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbSearchTerm,
                arbLimit,
                (searchTerm, limit) => {
<<<<<<< HEAD
                    const actual = filterRegions(searchTerm, limit)
                    const expected = buildExpectedOutput(snapshotRegions, searchTerm, limit)
=======
                    const actual = filterRegions(searchTerm, limit);
                    const expected = buildExpectedOutput(snapshotRegions, searchTerm, limit);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        actual,
                        expected,
                        `Output mismatch for searchTerm=${JSON.stringify(searchTerm)} limit=${limit}`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('the loaded AWS_REGIONS matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('the loaded AWS_REGIONS matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            assert.deepStrictEqual(
                AWS_REGIONS,
                snapshotRegions,
                'AWS_REGIONS should match regions.json content'
<<<<<<< HEAD
            )
        })

        it('the loaded VALID_REGION_CODES matches the catalog JSON file codes', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const expectedCodes = new Set(snapshotRegions.map(r => r.code))
=======
            );
        });

        it('the loaded VALID_REGION_CODES matches the catalog JSON file codes', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const expectedCodes = new Set(snapshotRegions.map(r => r.code));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
            assert.deepStrictEqual(
                VALID_REGION_CODES,
                expectedCodes,
                'VALID_REGION_CODES should match the set of codes from regions.json'
<<<<<<< HEAD
            )
        })

        it('for any keyword search, filterRegions returns only valid region codes', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            );
        });

        it('for any keyword search, filterRegions returns only valid region codes', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom(...SEARCH_KEYWORDS),
                arbLimit,
                (searchTerm, limit) => {
<<<<<<< HEAD
                    const result = filterRegions(searchTerm, limit)
                    const allCodes = new Set(snapshotRegions.map(r => r.code))
=======
                    const result = filterRegions(searchTerm, limit);
                    const allCodes = new Set(snapshotRegions.map(r => r.code));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    for (const code of result.choices.awsRegion) {
                        assert.ok(
                            allCodes.has(code),
                            `Region code ${code} not found in catalog`
<<<<<<< HEAD
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for undefined search term, filterRegions returns all regions up to limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('for undefined search term, filterRegions returns all regions up to limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbLimit,
                (limit) => {
<<<<<<< HEAD
                    const result = filterRegions(undefined, limit)
                    const expectedCount = Math.min(snapshotRegions.length, limit)
=======
                    const result = filterRegions(undefined, limit);
                    const expectedCount = Math.min(snapshotRegions.length, limit);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.strictEqual(
                        result.choices.awsRegion.length,
                        expectedCount,
                        `Expected ${expectedCount} regions for undefined search with limit ${limit}`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Default value should be the first region
                    assert.strictEqual(
                        result.values.awsRegion,
                        snapshotRegions[0].code,
                        'Default region should be the first catalog entry'
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
