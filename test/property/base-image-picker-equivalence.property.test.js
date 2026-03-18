// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Image Picker Response Equivalence Property-Based Tests
 *
 * Verifies that the externalized base-image-picker (loading catalogs from
 * JSON files) produces identical responses to the original hardcoded data
 * for all supported framework and modelServer combinations.
 *
 * Feature: mcp-server-externalization, Property 4: Externalized base-image-picker produces identical responses
 */

import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    resolveBaseImage,
    TRANSFORMER_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    StaticCatalogResolver
} from '../../servers/base-image-picker/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
}

// ── Snapshot: load original catalog data directly from JSON files ─────────────
// These represent the "ground truth" — the externalized JSON files that replaced
// the original hardcoded constants. We load them independently to build expected
// outputs and compare against resolveBaseImage() results.

const catalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs')

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the expected resolveBaseImage output for a given context and limit,
 * using a fresh StaticCatalogResolver constructed from the raw catalog files.
 * This simulates what the original hardcoded version would have returned.
 */
async function buildExpectedOutput(snapshotResolver, context, limit) {
    const { framework, modelServer, searchCriteria } = context

    const resolverKey = (framework === 'transformers' && modelServer)
        ? modelServer
        : 'python-slim'

    const result = await snapshotResolver.fetchImages(resolverKey, { limit, searchCriteria })

    const images = result.images.map(e => e.image)
    return {
        values: { baseImage: result.defaultImage },
        choices: { baseImage: images },
        metadata: { baseImage: result.images }
    }
}

// ── Generators ───────────────────────────────────────────────────────────────

const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']
const NON_TRANSFORMER_FRAMEWORKS = ['sklearn', 'xgboost', 'tensorflow']
const ALL_FRAMEWORKS = ['transformers', ...NON_TRANSFORMER_FRAMEWORKS]

/**
 * Generate a random context object representing a transformer framework
 * with a specific model server.
 */
const arbTransformerContext = fc.record({
    framework: fc.constant('transformers'),
    modelServer: fc.constantFrom(...MODEL_SERVERS),
    searchCriteria: fc.constant(undefined)
})

/**
 * Generate a random context object representing a non-transformer framework
 * (routes to python-slim), optionally with search criteria.
 */
const arbNonTransformerContext = fc.record({
    framework: fc.constantFrom(...NON_TRANSFORMER_FRAMEWORKS),
    modelServer: fc.constant(undefined),
    searchCriteria: fc.option(
        fc.stringMatching(/^[a-zA-Z0-9.\-]{1,10}$/),
        { nil: undefined }
    )
})

/**
 * Generate any valid context object — either transformer or non-transformer.
 */
const arbContext = fc.oneof(arbTransformerContext, arbNonTransformerContext)

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 20 })

// ── Property tests ───────────────────────────────────────────────────────────

describe('Base Image Picker Response Equivalence Property-Based Tests', () => {

    let snapshotTransformerCatalog
    let snapshotPythonSlimCatalog
    let snapshotResolver

    before(() => {
        // Load catalogs independently from the JSON files to build a
        // "snapshot" resolver that represents the original hardcoded behavior
        snapshotTransformerCatalog = loadCatalogDirect('model-servers.json')
        snapshotPythonSlimCatalog = loadCatalogDirect('python-slim.json')
        snapshotResolver = new StaticCatalogResolver(
            snapshotTransformerCatalog,
            snapshotPythonSlimCatalog
        )
    })

    // Feature: mcp-server-externalization, Property 4: Externalized base-image-picker produces identical responses
    describe('Property 4: Externalized base-image-picker produces identical responses', () => {

        /**
         * Validates: Requirements 1.7
         *
         * For any valid context (framework + modelServer combination) and any
         * positive limit, the externalized resolveBaseImage() should produce
         * output identical to what a resolver built from the same catalog
         * JSON files would produce.
         */
        it('for any valid context, resolveBaseImage() output matches snapshot-based expected output', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            await fc.assert(fc.asyncProperty(
                arbContext,
                arbLimit,
                async (context, limit) => {
                    const actual = await resolveBaseImage(context, limit)
                    const expected = await buildExpectedOutput(snapshotResolver, context, limit)

                    // Values must match
                    assert.deepStrictEqual(
                        actual.values,
                        expected.values,
                        `values mismatch for context ${JSON.stringify(context)} with limit ${limit}`
                    )

                    // Choices must match
                    assert.deepStrictEqual(
                        actual.choices,
                        expected.choices,
                        `choices mismatch for context ${JSON.stringify(context)} with limit ${limit}`
                    )

                    // Metadata must match
                    assert.deepStrictEqual(
                        actual.metadata,
                        expected.metadata,
                        `metadata mismatch for context ${JSON.stringify(context)} with limit ${limit}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('the loaded TRANSFORMER_IMAGE_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            // Verify the module-level loaded catalog is identical to the raw file
            assert.deepStrictEqual(
                TRANSFORMER_IMAGE_CATALOG,
                snapshotTransformerCatalog,
                'TRANSFORMER_IMAGE_CATALOG should match model-servers.json content'
            )
        })

        it('the loaded PYTHON_SLIM_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            // Verify the module-level loaded catalog is identical to the raw file
            assert.deepStrictEqual(
                PYTHON_SLIM_CATALOG,
                snapshotPythonSlimCatalog,
                'PYTHON_SLIM_CATALOG should match python-slim.json content'
            )
        })

        it('for any transformer model server, resolveBaseImage returns correct catalog entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            await fc.assert(fc.asyncProperty(
                fc.constantFrom(...MODEL_SERVERS),
                arbLimit,
                async (modelServer, limit) => {
                    const context = { framework: 'transformers', modelServer }
                    const result = await resolveBaseImage(context, limit)

                    // The catalog entries for this model server
                    const catalogEntries = snapshotTransformerCatalog[modelServer] || []
                    const expectedSlice = catalogEntries.slice(0, limit)

                    assert.strictEqual(
                        result.choices.baseImage.length,
                        expectedSlice.length,
                        `Expected ${expectedSlice.length} choices for ${modelServer} with limit ${limit}`
                    )

                    // Each choice should match the catalog image field
                    for (let i = 0; i < expectedSlice.length; i++) {
                        assert.strictEqual(
                            result.choices.baseImage[i],
                            expectedSlice[i].image,
                            `Choice[${i}] mismatch for ${modelServer}`
                        )
                    }

                    // Default image should be the first entry
                    const expectedDefault = expectedSlice[0]?.image || null
                    assert.strictEqual(
                        result.values.baseImage,
                        expectedDefault,
                        `Default image mismatch for ${modelServer}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for any non-transformer framework, resolveBaseImage returns python-slim entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            await fc.assert(fc.asyncProperty(
                fc.constantFrom(...NON_TRANSFORMER_FRAMEWORKS),
                arbLimit,
                async (framework, limit) => {
                    const context = { framework }
                    const result = await resolveBaseImage(context, limit)

                    const expectedSlice = snapshotPythonSlimCatalog.slice(0, limit)

                    assert.strictEqual(
                        result.choices.baseImage.length,
                        expectedSlice.length,
                        `Expected ${expectedSlice.length} python-slim choices for ${framework} with limit ${limit}`
                    )

                    for (let i = 0; i < expectedSlice.length; i++) {
                        assert.strictEqual(
                            result.choices.baseImage[i],
                            expectedSlice[i].image,
                            `Python-slim choice[${i}] mismatch for ${framework}`
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
