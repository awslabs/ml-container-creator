// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog JSON Round-Trip Property-Based Tests
 *
 * Verifies that parsing each catalog JSON file and serializing it back
 * with JSON.stringify produces a value that deep-equals the original
 * parsed result — confirming no data is lost or mutated during round-trip.
 *
 * Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
=======
import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}

const baseImagePickerCatalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs')
const instanceRecommenderCatalogsDir = resolve(__dirname, '../../servers/instance-recommender/catalogs')
const regionPickerCatalogsDir = resolve(__dirname, '../../servers/region-picker/catalogs')
=======
};

const baseImagePickerCatalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs');
const instanceRecommenderCatalogsDir = resolve(__dirname, '../../servers/instance-recommender/catalogs');
const regionPickerCatalogsDir = resolve(__dirname, '../../servers/region-picker/catalogs');
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load a catalog file as raw text, parse it, and return both the
 * parsed object and the raw string for round-trip verification.
 */
function loadRawAndParsed(catalogsDir, filename) {
<<<<<<< HEAD
    const raw = readFileSync(resolve(catalogsDir, filename), 'utf8')
    const parsed = JSON.parse(raw)
    return { raw, parsed }
=======
    const raw = readFileSync(resolve(catalogsDir, filename), 'utf8');
    const parsed = JSON.parse(raw);
    return { raw, parsed };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Catalog JSON Round-Trip Property-Based Tests', () => {

<<<<<<< HEAD
    let modelServersCatalog
    let pythonSlimCatalog

    before(() => {
        modelServersCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'model-servers.json')
        pythonSlimCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'python-slim.json')
    })
=======
    let modelServersCatalog;
    let pythonSlimCatalog;

    before(() => {
        modelServersCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'model-servers.json');
        pythonSlimCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'python-slim.json');
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip
    describe('Property 1: model-servers.json and python-slim.json round-trip', () => {

        /**
         * Validates: Requirements 6.1, 6.2
         *
         * For each catalog file, parsing the JSON content, serializing
         * back with JSON.stringify, and parsing again should produce a
         * value that deep-equals the original parsed result.
         */
        it('model-servers.json survives parse → stringify → parse round-trip', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            const catalogFiles = [
                { name: 'model-servers.json', data: modelServersCatalog },
                { name: 'python-slim.json', data: pythonSlimCatalog }
<<<<<<< HEAD
            ]
=======
            ];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom(...catalogFiles),
                (catalog) => {
<<<<<<< HEAD
                    const original = catalog.data.parsed

                    // Round-trip: serialize back to JSON, then parse again
                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)
=======
                    const original = catalog.data.parsed;

                    // Round-trip: serialize back to JSON, then parse again
                    const serialized = JSON.stringify(original);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        `Round-trip failed for ${catalog.name}: parsed → stringify → parse did not deep-equal original`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every entry in model-servers.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = modelServersCatalog.parsed
            const serverNames = Object.keys(catalog)

            // Generate (serverName, entryIndex) pairs to test individual entries
            const arbEntry = fc.constantFrom(...serverNames).chain(serverName => {
                const entries = catalog[serverName]
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('every entry in model-servers.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const catalog = modelServersCatalog.parsed;
            const serverNames = Object.keys(catalog);

            // Generate (serverName, entryIndex) pairs to test individual entries
            const arbEntry = fc.constantFrom(...serverNames).chain(serverName => {
                const entries = catalog[serverName];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                return fc.integer({ min: 0, max: entries.length - 1 }).map(idx => ({
                    serverName,
                    idx,
                    entry: entries[idx]
<<<<<<< HEAD
                }))
            })
=======
                }));
            });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbEntry,
                ({ serverName, idx, entry }) => {
<<<<<<< HEAD
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)
=======
                    const serialized = JSON.stringify(entry);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for model-servers.json[${serverName}][${idx}]`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every entry in python-slim.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = pythonSlimCatalog.parsed
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('every entry in python-slim.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const catalog = pythonSlimCatalog.parsed;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.integer({ min: 0, max: catalog.length - 1 }),
                (idx) => {
<<<<<<< HEAD
                    const entry = catalog[idx]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)
=======
                    const entry = catalog[idx];
                    const serialized = JSON.stringify(entry);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for python-slim.json[${idx}]`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip (instances.json)
    describe('Property 1 (partial): instances.json round-trip', () => {

<<<<<<< HEAD
        let instancesCatalog

        before(() => {
            instancesCatalog = loadRawAndParsed(instanceRecommenderCatalogsDir, 'instances.json')
        })
=======
        let instancesCatalog;

        before(() => {
            instancesCatalog = loadRawAndParsed(instanceRecommenderCatalogsDir, 'instances.json');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Validates: Requirements 6.3, 6.7
         *
         * Parsing instances.json, serializing back with JSON.stringify,
         * and parsing again should produce a value that deep-equals the
         * original parsed result.
         */
        it('instances.json survives parse → stringify → parse round-trip', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constant(instancesCatalog),
                (catalog) => {
<<<<<<< HEAD
                    const original = catalog.parsed

                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)
=======
                    const original = catalog.parsed;

                    const serialized = JSON.stringify(original);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        'Round-trip failed for instances.json: parsed → stringify → parse did not deep-equal original'
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every catalog entry in instances.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = instancesCatalog.parsed.catalog
            const instanceTypes = Object.keys(catalog)
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('every catalog entry in instances.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const catalog = instancesCatalog.parsed.catalog;
            const instanceTypes = Object.keys(catalog);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom(...instanceTypes),
                (instanceType) => {
<<<<<<< HEAD
                    const entry = catalog[instanceType]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)
=======
                    const entry = catalog[instanceType];
                    const serialized = JSON.stringify(entry);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for instances.json catalog[${instanceType}]`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('recommendations in instances.json survive round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const recommendations = instancesCatalog.parsed.recommendations
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('recommendations in instances.json survive round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const recommendations = instancesCatalog.parsed.recommendations;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom('cpu', 'gpu'),
                (category) => {
<<<<<<< HEAD
                    const original = recommendations[category]
                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)
=======
                    const original = recommendations[category];
                    const serialized = JSON.stringify(original);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        `Round-trip failed for instances.json recommendations.${category}`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip (regions.json)
    describe('Property 1 (partial): regions.json round-trip', () => {

<<<<<<< HEAD
        let regionsCatalog

        before(() => {
            regionsCatalog = loadRawAndParsed(regionPickerCatalogsDir, 'regions.json')
        })
=======
        let regionsCatalog;

        before(() => {
            regionsCatalog = loadRawAndParsed(regionPickerCatalogsDir, 'regions.json');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Validates: Requirements 6.4, 6.8
         *
         * Parsing regions.json, serializing back with JSON.stringify,
         * and parsing again should produce a value that deep-equals the
         * original parsed result.
         */
        it('regions.json survives parse → stringify → parse round-trip', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constant(regionsCatalog),
                (catalog) => {
<<<<<<< HEAD
                    const original = catalog.parsed

                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)
=======
                    const original = catalog.parsed;

                    const serialized = JSON.stringify(original);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        'Round-trip failed for regions.json: parsed → stringify → parse did not deep-equal original'
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every RegionEntry in regions.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = regionsCatalog.parsed
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('every RegionEntry in regions.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const catalog = regionsCatalog.parsed;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.integer({ min: 0, max: catalog.length - 1 }),
                (idx) => {
<<<<<<< HEAD
                    const entry = catalog[idx]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)
=======
                    const entry = catalog[idx];
                    const serialized = JSON.stringify(entry);
                    const roundTripped = JSON.parse(serialized);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for regions.json[${idx}] (code: ${entry.code})`
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
