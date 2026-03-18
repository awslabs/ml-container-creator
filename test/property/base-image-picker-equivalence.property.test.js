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
    resolveBaseImage,
    TRANSFORMER_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    StaticCatalogResolver
<<<<<<< HEAD
} from '../../servers/base-image-picker/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
=======
} from '../../servers/base-image-picker/index.js';

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
// outputs and compare against resolveBaseImage() results.

<<<<<<< HEAD
const catalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs')

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'))
=======
const catalogsDir = resolve(__dirname, '../../servers/base-image-picker/catalogs');

function loadCatalogDirect(filename) {
    return JSON.parse(readFileSync(resolve(catalogsDir, filename), 'utf8'));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the expected resolveBaseImage output for a given context and limit,
 * using a fresh StaticCatalogResolver constructed from the raw catalog files.
 * This simulates what the original hardcoded version would have returned.
 */
async function buildExpectedOutput(snapshotResolver, context, limit) {
<<<<<<< HEAD
    const { framework, modelServer, searchCriteria } = context

    const resolverKey = (framework === 'transformers' && modelServer)
        ? modelServer
        : 'python-slim'

    const result = await snapshotResolver.fetchImages(resolverKey, { limit, searchCriteria })

    const images = result.images.map(e => e.image)
=======
    const { framework, modelServer, searchCriteria } = context;

    const resolverKey = (framework === 'transformers' && modelServer)
        ? modelServer
        : 'python-slim';

    const result = await snapshotResolver.fetchImages(resolverKey, { limit, searchCriteria });

    const images = result.images.map(e => e.image);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
    return {
        values: { baseImage: result.defaultImage },
        choices: { baseImage: images },
        metadata: { baseImage: result.images }
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Generators ───────────────────────────────────────────────────────────────

<<<<<<< HEAD
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']
const NON_TRANSFORMER_FRAMEWORKS = ['sklearn', 'xgboost', 'tensorflow']
const ALL_FRAMEWORKS = ['transformers', ...NON_TRANSFORMER_FRAMEWORKS]
=======
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'];
const NON_TRANSFORMER_FRAMEWORKS = ['sklearn', 'xgboost', 'tensorflow'];
// All frameworks (used by arbAnyContext below)
const ALL_FRAMEWORKS = ['transformers', ...NON_TRANSFORMER_FRAMEWORKS]; // eslint-disable-line no-unused-vars
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a random context object representing a transformer framework
 * with a specific model server.
 */
const arbTransformerContext = fc.record({
    framework: fc.constant('transformers'),
    modelServer: fc.constantFrom(...MODEL_SERVERS),
    searchCriteria: fc.constant(undefined)
<<<<<<< HEAD
})
=======
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a random context object representing a non-transformer framework
 * (routes to python-slim), optionally with search criteria.
 */
const arbNonTransformerContext = fc.record({
    framework: fc.constantFrom(...NON_TRANSFORMER_FRAMEWORKS),
    modelServer: fc.constant(undefined),
    searchCriteria: fc.option(
<<<<<<< HEAD
        fc.stringMatching(/^[a-zA-Z0-9.\-]{1,10}$/),
        { nil: undefined }
    )
})
=======
        fc.stringMatching(/^[a-zA-Z0-9.-]{1,10}$/),
        { nil: undefined }
    )
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate any valid context object — either transformer or non-transformer.
 */
<<<<<<< HEAD
const arbContext = fc.oneof(arbTransformerContext, arbNonTransformerContext)

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 20 })
=======
const arbContext = fc.oneof(arbTransformerContext, arbNonTransformerContext);

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 20 });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Base Image Picker Response Equivalence Property-Based Tests', () => {

<<<<<<< HEAD
    let snapshotTransformerCatalog
    let snapshotPythonSlimCatalog
    let snapshotResolver
=======
    let snapshotTransformerCatalog;
    let snapshotPythonSlimCatalog;
    let snapshotResolver;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    before(() => {
        // Load catalogs independently from the JSON files to build a
        // "snapshot" resolver that represents the original hardcoded behavior
<<<<<<< HEAD
        snapshotTransformerCatalog = loadCatalogDirect('model-servers.json')
        snapshotPythonSlimCatalog = loadCatalogDirect('python-slim.json')
        snapshotResolver = new StaticCatalogResolver(
            snapshotTransformerCatalog,
            snapshotPythonSlimCatalog
        )
    })
=======
        snapshotTransformerCatalog = loadCatalogDirect('model-servers.json');
        snapshotPythonSlimCatalog = loadCatalogDirect('python-slim.json');
        snapshotResolver = new StaticCatalogResolver(
            snapshotTransformerCatalog,
            snapshotPythonSlimCatalog
        );
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

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
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await fc.assert(fc.asyncProperty(
                arbContext,
                arbLimit,
                async (context, limit) => {
<<<<<<< HEAD
                    const actual = await resolveBaseImage(context, limit)
                    const expected = await buildExpectedOutput(snapshotResolver, context, limit)
=======
                    const actual = await resolveBaseImage(context, limit);
                    const expected = await buildExpectedOutput(snapshotResolver, context, limit);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Values must match
                    assert.deepStrictEqual(
                        actual.values,
                        expected.values,
                        `values mismatch for context ${JSON.stringify(context)} with limit ${limit}`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Choices must match
                    assert.deepStrictEqual(
                        actual.choices,
                        expected.choices,
                        `choices mismatch for context ${JSON.stringify(context)} with limit ${limit}`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Metadata must match
                    assert.deepStrictEqual(
                        actual.metadata,
                        expected.metadata,
                        `metadata mismatch for context ${JSON.stringify(context)} with limit ${limit}`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('the loaded TRANSFORMER_IMAGE_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('the loaded TRANSFORMER_IMAGE_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            // Verify the module-level loaded catalog is identical to the raw file
            assert.deepStrictEqual(
                TRANSFORMER_IMAGE_CATALOG,
                snapshotTransformerCatalog,
                'TRANSFORMER_IMAGE_CATALOG should match model-servers.json content'
<<<<<<< HEAD
            )
        })

        it('the loaded PYTHON_SLIM_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            );
        });

        it('the loaded PYTHON_SLIM_CATALOG matches the catalog JSON file content', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            // Verify the module-level loaded catalog is identical to the raw file
            assert.deepStrictEqual(
                PYTHON_SLIM_CATALOG,
                snapshotPythonSlimCatalog,
                'PYTHON_SLIM_CATALOG should match python-slim.json content'
<<<<<<< HEAD
            )
        })

        it('for any transformer model server, resolveBaseImage returns correct catalog entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            );
        });

        it('for any transformer model server, resolveBaseImage returns correct catalog entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await fc.assert(fc.asyncProperty(
                fc.constantFrom(...MODEL_SERVERS),
                arbLimit,
                async (modelServer, limit) => {
<<<<<<< HEAD
                    const context = { framework: 'transformers', modelServer }
                    const result = await resolveBaseImage(context, limit)

                    // The catalog entries for this model server
                    const catalogEntries = snapshotTransformerCatalog[modelServer] || []
                    const expectedSlice = catalogEntries.slice(0, limit)
=======
                    const context = { framework: 'transformers', modelServer };
                    const result = await resolveBaseImage(context, limit);

                    // The catalog entries for this model server
                    const catalogEntries = snapshotTransformerCatalog[modelServer] || [];
                    const expectedSlice = catalogEntries.slice(0, limit);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.strictEqual(
                        result.choices.baseImage.length,
                        expectedSlice.length,
                        `Expected ${expectedSlice.length} choices for ${modelServer} with limit ${limit}`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Each choice should match the catalog image field
                    for (let i = 0; i < expectedSlice.length; i++) {
                        assert.strictEqual(
                            result.choices.baseImage[i],
                            expectedSlice[i].image,
                            `Choice[${i}] mismatch for ${modelServer}`
<<<<<<< HEAD
                        )
                    }

                    // Default image should be the first entry
                    const expectedDefault = expectedSlice[0]?.image || null
=======
                        );
                    }

                    // Default image should be the first entry
                    const expectedDefault = expectedSlice[0]?.image || null;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    assert.strictEqual(
                        result.values.baseImage,
                        expectedDefault,
                        `Default image mismatch for ${modelServer}`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for any non-transformer framework, resolveBaseImage returns python-slim entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('for any non-transformer framework, resolveBaseImage returns python-slim entries', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await fc.assert(fc.asyncProperty(
                fc.constantFrom(...NON_TRANSFORMER_FRAMEWORKS),
                arbLimit,
                async (framework, limit) => {
<<<<<<< HEAD
                    const context = { framework }
                    const result = await resolveBaseImage(context, limit)

                    const expectedSlice = snapshotPythonSlimCatalog.slice(0, limit)
=======
                    const context = { framework };
                    const result = await resolveBaseImage(context, limit);

                    const expectedSlice = snapshotPythonSlimCatalog.slice(0, limit);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.strictEqual(
                        result.choices.baseImage.length,
                        expectedSlice.length,
                        `Expected ${expectedSlice.length} python-slim choices for ${framework} with limit ${limit}`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    for (let i = 0; i < expectedSlice.length; i++) {
                        assert.strictEqual(
                            result.choices.baseImage[i],
                            expectedSlice[i].image,
                            `Python-slim choice[${i}] mismatch for ${framework}`
<<<<<<< HEAD
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
=======
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
