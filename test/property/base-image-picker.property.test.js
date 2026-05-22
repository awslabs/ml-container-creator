// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Image Picker Server Property-Based Tests
 *
 * Property-based tests for the base-image-picker MCP server, covering
 * static catalog resolution, Python slim search, schema validation,
 * and resolver registry routing.
 *
 * Feature: transformer-base-image-picker
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    StaticCatalogResolver,
    ResolverRegistry,
    TRANSFORMER_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    resolveBaseImage,
    staticResolver
} from '../../servers/base-image-picker/index.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Shared arbitrary generators ──────────────────────────────────────────────

/** Any supported framework (transformer + python-slim) */
const arbSupportedFramework = fc.constantFrom(...staticResolver.supportedFrameworks());

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 20 });

/** Search criteria strings for Python slim filtering */
const arbSearchCriteria = fc.stringMatching(/^[a-zA-Z0-9.-]{0,20}$/);

/** Strings that are NOT keys in the transformer catalog */
const arbUnknownModelServer = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => !TRANSFORMER_IMAGE_CATALOG[s]);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Base Image Picker Server Property-Based Tests', () => {

    // Property 1: Catalog results are sorted by created date descending
    describe('Property 1: Catalog results sorted by created date descending', () => {
        it('for any supported framework, fetchImages() returns images sorted by created date descending', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbSupportedFramework,
                async (framework) => {
                    const result = await staticResolver.fetchImages(framework, { limit: 100 });
                    const images = result.images;

                    for (let i = 1; i < images.length; i++) {
                        const prev = new Date(images[i - 1].created).getTime();
                        const curr = new Date(images[i].created).getTime();
                        assert.ok(prev >= curr,
                            `Images not sorted descending: ${images[i - 1].created} should be >= ${images[i].created} for framework "${framework}"`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 2: Limit parameter caps result size
    describe('Property 2: Limit parameter caps result size', () => {
        it('for any supported framework and positive limit, result length equals min(limit, catalog_size)', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbSupportedFramework,
                arbLimit,
                async (framework, limit) => {
                    const fullResult = await staticResolver.fetchImages(framework, { limit: 1000 });
                    const limitedResult = await staticResolver.fetchImages(framework, { limit });

                    const expected = Math.min(limit, fullResult.images.length);
                    assert.strictEqual(limitedResult.images.length, expected,
                        `Expected ${expected} images for framework "${framework}" with limit ${limit}, got ${limitedResult.images.length}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 3: Default image equals first result
    describe('Property 3: Default image equals first result', () => {
        it('for any supported framework, defaultImage equals first image or null if empty', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbSupportedFramework,
                async (framework) => {
                    const result = await staticResolver.fetchImages(framework, { limit: 100 });

                    if (result.images.length > 0) {
                        assert.strictEqual(result.defaultImage, result.images[0].image,
                            `defaultImage should equal first image for framework "${framework}"`);
                    } else {
                        assert.strictEqual(result.defaultImage, null,
                            `defaultImage should be null when no images for framework "${framework}"`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 4: Metadata and choices correspond 1:1
    describe('Property 4: Metadata and choices correspond 1:1', () => {
        it('for any MCP resolution, metadata.baseImage and choices.baseImage correspond 1:1', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbSupportedFramework,
                arbLimit,
                async (framework, limit) => {
                    // Route through resolveBaseImage like the MCP handler does
                    const isTransformer = Object.keys(TRANSFORMER_IMAGE_CATALOG).includes(framework);
                    const context = isTransformer
                        ? { framework: 'transformers', modelServer: framework }
                        : { framework: 'sklearn' };

                    const result = await resolveBaseImage(context, limit);

                    assert.strictEqual(result.metadata.baseImage.length, result.choices.baseImage.length,
                        `metadata length (${result.metadata.baseImage.length}) should equal choices length (${result.choices.baseImage.length})`);

                    for (let i = 0; i < result.metadata.baseImage.length; i++) {
                        assert.strictEqual(result.metadata.baseImage[i].image, result.choices.baseImage[i],
                            `metadata[${i}].image should equal choices[${i}]`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 5: Unknown modelServer returns empty results
    describe('Property 5: Unknown modelServer returns empty results', () => {
        it('for any string not in the transformer catalog, resolving returns empty choices and null value', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbUnknownModelServer,
                async (unknownServer) => {
                    const result = await resolveBaseImage(
                        { framework: 'transformers', modelServer: unknownServer },
                        5
                    );

                    assert.deepStrictEqual(result.choices.baseImage, [],
                        `Expected empty choices for unknown modelServer "${unknownServer}"`);
                    assert.strictEqual(result.values.baseImage, null,
                        `Expected null value for unknown modelServer "${unknownServer}"`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 6: Search criteria filters Python slim results correctly
    describe('Property 6: Search criteria filters Python slim results correctly', () => {
        it('for any non-empty search string, every returned entry contains the search string in tag or python_version', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbSearchCriteria.filter(s => s.trim().length > 0),
                async (searchCriteria) => {
                    const result = await staticResolver.fetchImages('python-slim', {
                        limit: 100,
                        searchCriteria
                    });

                    const query = searchCriteria.trim().toLowerCase();
                    for (const entry of result.images) {
                        const matchesTag = entry.tag.toLowerCase().includes(query);
                        const matchesImage = entry.image.toLowerCase().includes(query);
                        const matchesPython = entry.labels.python_version &&
                            entry.labels.python_version.toLowerCase().includes(query);

                        assert.ok(matchesTag || matchesImage || matchesPython,
                            `Entry "${entry.image}" does not contain search criteria "${searchCriteria}" in tag, image, or python_version`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 7: Empty search criteria returns full Python slim catalog
    describe('Property 7: Empty search criteria returns full Python slim catalog', () => {
        it('for any empty/whitespace search string, result equals full catalog up to limit', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbEmptySearch = fc.oneof(
                fc.constant(''),
                fc.constant('   '),
                fc.constant(undefined),
                fc.constant(null)
            );

            await fc.assert(fc.asyncProperty(
                arbEmptySearch,
                arbLimit,
                async (searchCriteria, limit) => {
                    const withSearch = await staticResolver.fetchImages('python-slim', {
                        limit,
                        searchCriteria
                    });
                    const withoutSearch = await staticResolver.fetchImages('python-slim', {
                        limit
                    });

                    assert.deepStrictEqual(withSearch.images, withoutSearch.images,
                        'Empty search criteria should return same results as no search criteria');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 8: ImageEntry schema validation
    describe('Property 8: ImageEntry schema validation', () => {
        it('every ImageEntry in both catalogs has all required fields and valid formats', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const requiredFields = ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository'];
            const dockerRefPattern = /^[a-zA-Z0-9._\-/:]+:[a-zA-Z0-9._\-]+$/; // eslint-disable-line no-useless-escape

            // Collect all entries from both catalogs
            const allTransformerEntries = Object.entries(TRANSFORMER_IMAGE_CATALOG)
                .flatMap(([fw, entries]) => entries.map(e => ({ ...e, _framework: fw })));
            const allPythonEntries = PYTHON_SLIM_CATALOG.map(e => ({ ...e, _framework: 'python-slim' }));
            const allEntries = [...allTransformerEntries, ...allPythonEntries];

            // Use fast-check to pick any entry from the combined catalog
            fc.assert(fc.property(
                fc.constantFrom(...allEntries),
                (entry) => {
                    // (a) All required fields present and non-null
                    for (const field of requiredFields) {
                        assert.ok(entry[field] !== undefined && entry[field] !== null,
                            `Field "${field}" missing or null in entry "${entry.image}" (framework: ${entry._framework})`);
                    }

                    // (b) image matches Docker reference pattern
                    assert.ok(dockerRefPattern.test(entry.image),
                        `Image "${entry.image}" does not match Docker reference pattern`);

                    // (c) created is valid ISO 8601
                    const date = new Date(entry.created);
                    assert.ok(!isNaN(date.getTime()),
                        `Created "${entry.created}" is not a valid ISO 8601 date`);

                    // (d) labels is a plain object with string values
                    assert.strictEqual(typeof entry.labels, 'object',
                        `Labels should be an object for "${entry.image}"`);
                    assert.ok(!Array.isArray(entry.labels),
                        `Labels should not be an array for "${entry.image}"`);
                    for (const [key, val] of Object.entries(entry.labels)) {
                        assert.strictEqual(typeof key, 'string',
                            `Label key should be string in "${entry.image}"`);
                        assert.strictEqual(typeof val, 'string',
                            `Label value for "${key}" should be string in "${entry.image}"`);
                    }

                    // (e) Transformer entries have cuda_version and framework_version
                    if (entry._framework !== 'python-slim') {
                        assert.ok(entry.labels.cuda_version && entry.labels.cuda_version.length > 0,
                            `Transformer entry "${entry.image}" missing non-empty cuda_version`);
                        assert.ok(entry.labels.framework_version && entry.labels.framework_version.length > 0,
                            `Transformer entry "${entry.image}" missing non-empty framework_version`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Property 9: ResolverRegistry routes to registered resolver
    describe('Property 9: ResolverRegistry routes to registered resolver', () => {
        it('registered frameworks return their resolver; unregistered return default', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            // Create a fresh registry with a known resolver and default
            const testResolver = new StaticCatalogResolver(TRANSFORMER_IMAGE_CATALOG, PYTHON_SLIM_CATALOG);
            const defaultResolver = new StaticCatalogResolver({}, []);
            const testRegistry = new ResolverRegistry();
            testRegistry.register(testResolver);
            testRegistry.setDefault(defaultResolver);

            const registeredFrameworks = testResolver.supportedFrameworks();

            fc.assert(fc.property(
                fc.constantFrom(...registeredFrameworks),
                (framework) => {
                    const resolver = testRegistry.getResolver(framework);
                    assert.strictEqual(resolver, testResolver,
                        `Registered framework "${framework}" should return the registered resolver`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });

            // Unregistered frameworks should return default
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 20 }).filter(s => !registeredFrameworks.includes(s)),
                (unknownFramework) => {
                    const resolver = testRegistry.getResolver(unknownFramework);
                    assert.strictEqual(resolver, defaultResolver,
                        `Unregistered framework "${unknownFramework}" should return the default resolver`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
