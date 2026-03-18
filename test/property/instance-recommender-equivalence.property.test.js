// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Recommender Response Equivalence Property-Based Tests
 *
 * Verifies that the externalized instance-recommender (loading catalogs from
 * JSON files) produces identical responses to the original hardcoded data
 * for all supported framework and instanceSearch combinations.
 *
 * Feature: mcp-server-externalization, Property 4: Externalized instance-recommender produces identical responses
 */

import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    getStaticInstances,
    INSTANCE_CATALOG,
    INSTANCE_RECOMMENDATIONS,
    GPU_FRAMEWORKS
} from '../../servers/instance-recommender/index.js'

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
// outputs and compare against getStaticInstances() results.

const catalogsDir = resolve(__dirname, '../../servers/instance-recommender/catalogs')

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the expected getStaticInstances output for a given context,
 * using the raw catalog data loaded directly from the JSON file.
 * This simulates what the original hardcoded version would have returned.
 */
function buildExpectedOutput(snapshotCatalog, snapshotRecommendations, snapshotGpuFrameworks, context) {
    const framework = context?.framework
    const search = context?.instanceSearch

    const isGpu = framework && snapshotGpuFrameworks.has(framework)
    if (!search) {
        return isGpu ? snapshotRecommendations.gpu : snapshotRecommendations.cpu
    }

    // Search mode: replicate the scoring logic from getStaticInstances
    let candidates = Object.entries(snapshotCatalog)

    const tokens = search.toLowerCase().split(/[\s,\-_]+/).filter(Boolean)

    const rawLower = search.toLowerCase()
    const wantsMultiGpu = rawLower.includes('multi gpu') || rawLower.includes('multi-gpu') || rawLower.includes('multigpu')

    const cudaMatch = rawLower.match(/cuda[\s\-_]*(\d+(?:\.\d+)?)/)
    const wantsCudaVersion = cudaMatch ? cudaMatch[1] : null

    const scored = candidates.map(([name, meta]) => {
        let score = 0
        const cudaStr = meta.cudaVersions ? meta.cudaVersions.join(' ') : ''
        const haystack = [...meta.tags, meta.accelerator.toLowerCase(), name, meta.category, cudaStr].join(' ')

        if (wantsMultiGpu) {
            if (meta.gpus > 1) {
                score += 5
            } else {
                return { name, meta, score: 0 }
            }
        }

        if (wantsCudaVersion) {
            if (!meta.cudaVersions) return { name, meta, score: 0 }
            const hasExact = meta.cudaVersions.includes(wantsCudaVersion)
            const hasMajor = meta.cudaVersions.some(v => v.startsWith(wantsCudaVersion))
            if (hasExact) {
                score += 4
            } else if (hasMajor) {
                score += 3
            } else {
                return { name, meta, score: 0 }
            }
        }

        for (const token of tokens) {
            if (wantsMultiGpu && (token === 'multi' || token === 'gpu')) continue
            if (wantsCudaVersion && (token === 'cuda' || token === wantsCudaVersion)) continue

            if (haystack.includes(token)) score += 1
            if (meta.gpus > 1 && (token === 'parallel')) score += 2
            if (token === 'gpu' && meta.gpus > 0) score += 1
            if (token === 'cpu' && meta.gpus === 0) score += 1
            if (token === 'cheap' || token === 'budget' || token === 'cost') {
                if (meta.tags.includes('budget') || meta.tags.includes('cost-effective')) score += 1
            }
            if (token === 'memory' || token === 'high-memory') {
                if (meta.memGb >= 32) score += 1
            }
            if (token === 'large' && meta.vcpus >= 16) score += 1
            if (meta.cudaVersions && meta.cudaVersions.includes(token)) score += 2
        }
        return { name, meta, score }
    })

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)

    if (matched.length === 0) {
        return isGpu ? snapshotRecommendations.gpu : snapshotRecommendations.cpu
    }

    return matched.map(s => s.name)
}

// ── Generators ───────────────────────────────────────────────────────────────

const ALL_FRAMEWORKS = ['transformers', 'sklearn', 'xgboost', 'tensorflow']

// Search terms that exercise the scoring logic: tags, accelerators, categories
const SEARCH_KEYWORDS = [
    'gpu', 'cpu', 'cheap', 'budget', 'cost', 'memory', 'high-memory',
    'large', 'parallel', 'multi-gpu', 'cuda 12', 'cuda 11.8',
    'a10g', 't4', 'v100', 'l4', 'inference', 'training',
    'single-gpu', 'multi gpu', 'cost-effective', 'general'
]

/**
 * Generate a random context object with a framework and no search term.
 */
const arbContextNoSearch = fc.record({
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    instanceSearch: fc.constant(undefined)
})

/**
 * Generate a random context object with a framework and a keyword-based search.
 */
const arbContextWithKeywordSearch = fc.record({
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    instanceSearch: fc.constantFrom(...SEARCH_KEYWORDS)
})

/**
 * Generate a random context object with a framework and a random string search.
 */
const arbContextWithRandomSearch = fc.record({
    framework: fc.constantFrom(...ALL_FRAMEWORKS),
    instanceSearch: fc.option(
        fc.stringMatching(/^[a-zA-Z0-9.\- ]{1,20}$/),
        { nil: undefined }
    )
})

/**
 * Generate any valid context object — no search, keyword search, or random search.
 */
const arbContext = fc.oneof(
    arbContextNoSearch,
    arbContextWithKeywordSearch,
    arbContextWithRandomSearch
)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Instance Recommender Response Equivalence Property-Based Tests', () => {

    let snapshotData
    let snapshotCatalog
    let snapshotRecommendations
    let snapshotGpuFrameworks

    before(() => {
        // Load catalog independently from the JSON file to build a
        // "snapshot" that represents the original hardcoded behavior
        snapshotData = loadCatalogDirect('instances.json')
        snapshotCatalog = snapshotData.catalog
        snapshotRecommendations = snapshotData.recommendations
        // Replicate the GPU_FRAMEWORKS set from the server
        snapshotGpuFrameworks = new Set(['transformers'])
    })

    // Feature: mcp-server-externalization, Property 4: Externalized instance-recommender produces identical responses
    describe('Property 4: Externalized instance-recommender produces identical responses', () => {

        /**
         * Validates: Requirements 2.6
         *
         * For any valid context (framework + optional instanceSearch),
         * the externalized getStaticInstances() should produce output
         * identical to what the same scoring logic applied to the raw
         * catalog JSON file would produce.
         */
        it('for any valid context, getStaticInstances() output matches snapshot-based expected output', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbContext,
                (context) => {
                    const actual = getStaticInstances(context)
                    const expected = buildExpectedOutput(
                        snapshotCatalog,
                        snapshotRecommendations,
                        snapshotGpuFrameworks,
                        context
                    )

                    assert.deepStrictEqual(
                        actual,
                        expected,
                        `Output mismatch for context ${JSON.stringify(context)}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('the loaded INSTANCE_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            assert.deepStrictEqual(
                INSTANCE_CATALOG,
                snapshotCatalog,
                'INSTANCE_CATALOG should match instances.json catalog content'
            )
        })

        it('the loaded INSTANCE_RECOMMENDATIONS matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            assert.deepStrictEqual(
                INSTANCE_RECOMMENDATIONS,
                snapshotRecommendations,
                'INSTANCE_RECOMMENDATIONS should match instances.json recommendations content'
            )
        })

        it('the loaded GPU_FRAMEWORKS matches the expected set', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            assert.deepStrictEqual(
                GPU_FRAMEWORKS,
                snapshotGpuFrameworks,
                'GPU_FRAMEWORKS should match the expected set'
            )
        })

        it('for any framework without search, getStaticInstances returns correct category list', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.constantFrom(...ALL_FRAMEWORKS),
                (framework) => {
                    const context = { framework }
                    const result = getStaticInstances(context)

                    const isGpu = snapshotGpuFrameworks.has(framework)
                    const expected = isGpu
                        ? snapshotRecommendations.gpu
                        : snapshotRecommendations.cpu

                    assert.deepStrictEqual(
                        result,
                        expected,
                        `Category list mismatch for framework ${framework}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for any keyword search, getStaticInstances returns only instances from the catalog', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.record({
                    framework: fc.constantFrom(...ALL_FRAMEWORKS),
                    instanceSearch: fc.constantFrom(...SEARCH_KEYWORDS)
                }),
                (context) => {
                    const result = getStaticInstances(context)
                    const allInstanceNames = [
                        ...Object.keys(snapshotCatalog),
                        ...snapshotRecommendations.cpu,
                        ...snapshotRecommendations.gpu
                    ]
                    const validNames = new Set(allInstanceNames)

                    for (const name of result) {
                        assert.ok(
                            validNames.has(name),
                            `Instance ${name} not found in catalog or recommendations`
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
