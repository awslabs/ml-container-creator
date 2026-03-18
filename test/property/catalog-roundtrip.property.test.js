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

import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
}

const baseImagePickerCatalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs')
const instanceRecommenderCatalogsDir = resolve(__dirname, '../../servers/instance-recommender/catalogs')
const regionPickerCatalogsDir = resolve(__dirname, '../../servers/region-picker/catalogs')

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load a catalog file as raw text, parse it, and return both the
 * parsed object and the raw string for round-trip verification.
 */
function loadRawAndParsed(catalogsDir, filename) {
    const raw = readFileSync(resolve(catalogsDir, filename), 'utf8')
    const parsed = JSON.parse(raw)
    return { raw, parsed }
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Catalog JSON Round-Trip Property-Based Tests', () => {

    let modelServersCatalog
    let pythonSlimCatalog

    before(() => {
        modelServersCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'model-servers.json')
        pythonSlimCatalog = loadRawAndParsed(baseImagePickerCatalogsDir, 'python-slim.json')
    })

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
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalogFiles = [
                { name: 'model-servers.json', data: modelServersCatalog },
                { name: 'python-slim.json', data: pythonSlimCatalog }
            ]

            fc.assert(fc.property(
                fc.constantFrom(...catalogFiles),
                (catalog) => {
                    const original = catalog.data.parsed

                    // Round-trip: serialize back to JSON, then parse again
                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        `Round-trip failed for ${catalog.name}: parsed → stringify → parse did not deep-equal original`
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
                return fc.integer({ min: 0, max: entries.length - 1 }).map(idx => ({
                    serverName,
                    idx,
                    entry: entries[idx]
                }))
            })

            fc.assert(fc.property(
                arbEntry,
                ({ serverName, idx, entry }) => {
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for model-servers.json[${serverName}][${idx}]`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every entry in python-slim.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = pythonSlimCatalog.parsed

            fc.assert(fc.property(
                fc.integer({ min: 0, max: catalog.length - 1 }),
                (idx) => {
                    const entry = catalog[idx]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for python-slim.json[${idx}]`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip (instances.json)
    describe('Property 1 (partial): instances.json round-trip', () => {

        let instancesCatalog

        before(() => {
            instancesCatalog = loadRawAndParsed(instanceRecommenderCatalogsDir, 'instances.json')
        })

        /**
         * Validates: Requirements 6.3, 6.7
         *
         * Parsing instances.json, serializing back with JSON.stringify,
         * and parsing again should produce a value that deep-equals the
         * original parsed result.
         */
        it('instances.json survives parse → stringify → parse round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.constant(instancesCatalog),
                (catalog) => {
                    const original = catalog.parsed

                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        'Round-trip failed for instances.json: parsed → stringify → parse did not deep-equal original'
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every catalog entry in instances.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = instancesCatalog.parsed.catalog
            const instanceTypes = Object.keys(catalog)

            fc.assert(fc.property(
                fc.constantFrom(...instanceTypes),
                (instanceType) => {
                    const entry = catalog[instanceType]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for instances.json catalog[${instanceType}]`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('recommendations in instances.json survive round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const recommendations = instancesCatalog.parsed.recommendations

            fc.assert(fc.property(
                fc.constantFrom('cpu', 'gpu'),
                (category) => {
                    const original = recommendations[category]
                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        `Round-trip failed for instances.json recommendations.${category}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-server-externalization, Property 1: Catalog JSON round-trip (regions.json)
    describe('Property 1 (partial): regions.json round-trip', () => {

        let regionsCatalog

        before(() => {
            regionsCatalog = loadRawAndParsed(regionPickerCatalogsDir, 'regions.json')
        })

        /**
         * Validates: Requirements 6.4, 6.8
         *
         * Parsing regions.json, serializing back with JSON.stringify,
         * and parsing again should produce a value that deep-equals the
         * original parsed result.
         */
        it('regions.json survives parse → stringify → parse round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.constant(regionsCatalog),
                (catalog) => {
                    const original = catalog.parsed

                    const serialized = JSON.stringify(original)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        original,
                        'Round-trip failed for regions.json: parsed → stringify → parse did not deep-equal original'
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('every RegionEntry in regions.json survives individual round-trip', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const catalog = regionsCatalog.parsed

            fc.assert(fc.property(
                fc.integer({ min: 0, max: catalog.length - 1 }),
                (idx) => {
                    const entry = catalog[idx]
                    const serialized = JSON.stringify(entry)
                    const roundTripped = JSON.parse(serialized)

                    assert.deepStrictEqual(
                        roundTripped,
                        entry,
                        `Round-trip failed for regions.json[${idx}] (code: ${entry.code})`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
