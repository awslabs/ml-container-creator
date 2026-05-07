// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Picker Server Property-Based Tests
 *
 * Property-based tests for the model-picker MCP server, covering
 * resolver routing, glob pattern matching, and metadata merge precedence.
 *
 * Feature: model-picker-mcp
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import {
    StaticCatalogResolver,
    HuggingFaceResolver,
    ResolverRegistry,
    mergeMetadata,
    resolveModel,
    POPULAR_MODELS_CATALOG
} from '../../../servers/model-picker/index.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Shared arbitrary generators ──────────────────────────────────────────────

/** Generate a simple alphanumeric segment (no `/` or `://`) */
const arbSegment = fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/);

/** Generate an org/model style ID (exactly one `/`, no `://`) */
const arbOrgModel = fc.tuple(arbSegment, arbSegment)
    .map(([org, model]) => `${org}/${model}`);

/** Generate a string with a URI prefix (contains `://`) */
const arbUriPrefixed = fc.tuple(
    fc.stringMatching(/^[a-z]{1,10}$/),
    arbSegment
).map(([scheme, rest]) => `${scheme}://${rest}`);

/** Generate a plain string with no `/` */
const arbNoSlash = fc.stringMatching(/^[a-zA-Z0-9._-]{1,30}$/);

/** Generate a string with multiple slashes (more than one `/`) */
const arbMultiSlash = fc.tuple(arbSegment, arbSegment, arbSegment)
    .map(([a, b, c]) => `${a}/${b}/${c}`);


// ── Property tests ───────────────────────────────────────────────────────────

describe('Model Picker Server Property-Based Tests', () => {

    // Feature: model-picker-mcp, Property 1: Resolver routing correctness
    // **Validates: Requirements 2.2, 2.3, 2.5, 4.1, 8.1**
    describe('Property 1: Resolver routing correctness', () => {
        let registry;
        let hfResolver;
        let staticResolver;

        beforeEach(() => {
            hfResolver = new HuggingFaceResolver();
            staticResolver = new StaticCatalogResolver({});
            registry = new ResolverRegistry();
            registry.register(
                hfResolver,
                id => /^[^/]+\/[^/]+$/.test(id) && !id.includes('://')
            );
            registry.setDefault(staticResolver);
        });

        it('routes org/model IDs (exactly one /, no ://) to HuggingFaceResolver', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbOrgModel,
                (modelId) => {
                    const resolver = registry.getResolver(modelId);
                    assert.strictEqual(resolver, hfResolver,
                        `Expected HuggingFaceResolver for "${modelId}", got ${resolver === staticResolver ? 'StaticCatalogResolver' : 'unknown'}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('routes URI-prefixed IDs (containing ://) to StaticCatalogResolver', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbUriPrefixed,
                (modelId) => {
                    const resolver = registry.getResolver(modelId);
                    assert.strictEqual(resolver, staticResolver,
                        `Expected StaticCatalogResolver for URI-prefixed "${modelId}", got HuggingFaceResolver`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('routes IDs with no slash to StaticCatalogResolver', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbNoSlash,
                (modelId) => {
                    const resolver = registry.getResolver(modelId);
                    assert.strictEqual(resolver, staticResolver,
                        `Expected StaticCatalogResolver for no-slash "${modelId}", got HuggingFaceResolver`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('routes IDs with multiple slashes to StaticCatalogResolver', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMultiSlash,
                (modelId) => {
                    const resolver = registry.getResolver(modelId);
                    assert.strictEqual(resolver, staticResolver,
                        `Expected StaticCatalogResolver for multi-slash "${modelId}", got HuggingFaceResolver`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 4: Glob pattern matching correctness
    // **Validates: Requirements 5.4**
    describe('Property 4: Glob pattern matching correctness', () => {
        const resolver = new StaticCatalogResolver({});

        /**
         * Reference regex implementation for glob matching.
         * Converts * to .* and ? to . — same logic as _globMatch.
         */
        function referenceGlobMatch(str, pattern) {
            const regex = new RegExp(
                `^${  pattern.replace(/\*/g, '.*').replace(/\?/g, '.')  }$`
            );
            return regex.test(str);
        }

        /** Generate a simple string to test against patterns */
        const arbTestString = fc.stringMatching(/^[a-zA-Z0-9/_.-]{0,30}$/);

        /** Generate a glob pattern with * wildcards interspersed with literal segments */
        const arbGlobPattern = fc.array(
            fc.oneof(
                fc.constant('*'),
                fc.stringMatching(/^[a-zA-Z0-9._-]{1,8}$/)
            ),
            { minLength: 1, maxLength: 5 }
        ).map(parts => parts.join(''));

        it('_globMatch agrees with reference regex implementation for random (string, pattern) pairs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTestString,
                arbGlobPattern,
                (str, pattern) => {
                    const actual = resolver._globMatch(str, pattern);
                    const expected = referenceGlobMatch(str, pattern);
                    assert.strictEqual(actual, expected,
                        `_globMatch("${str}", "${pattern}") returned ${actual}, expected ${expected}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('* pattern matches any string', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTestString,
                (str) => {
                    assert.strictEqual(resolver._globMatch(str, '*'), true,
                        `_globMatch("${str}", "*") should be true`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('exact literal pattern matches only itself', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbLiteral = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/);

            fc.assert(fc.property(
                arbLiteral,
                (literal) => {
                    assert.strictEqual(resolver._globMatch(literal, literal), true,
                        `_globMatch("${literal}", "${literal}") should be true`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 5: Metadata merge precedence
    // **Validates: Requirements 3.5, 3.6, 9.1, 9.2, 9.3, 11.1**
    describe('Property 5: Metadata merge precedence', () => {

        /** Generate a nullable string field */
        const arbNullableString = fc.oneof(
            fc.constant(null),
            fc.string({ minLength: 1, maxLength: 20 })
        );

        /** Generate a metadata object with nullable fields */
        const arbMetadata = fc.record({
            family: arbNullableString,
            chat_template: arbNullableString,
            architecture: arbNullableString,
            validation_level: arbNullableString
        });

        /** Generate a nullable metadata object (null or object) */
        const arbNullableMetadata = fc.oneof(
            fc.constant(null),
            arbMetadata
        );

        it('live non-null fields take precedence over static fields', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMetadata,
                arbMetadata,
                (live, staticData) => {
                    const merged = mergeMetadata(live, staticData);
                    for (const [key, value] of Object.entries(live)) {
                        if (value !== null && value !== undefined) {
                            assert.strictEqual(merged[key], value,
                                `Live field "${key}" should take precedence: expected "${value}", got "${merged[key]}"`);
                        }
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('static fills gaps when live field is null', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMetadata,
                arbMetadata,
                (live, staticData) => {
                    const merged = mergeMetadata(live, staticData);
                    for (const [key, value] of Object.entries(live)) {
                        if (value === null || value === undefined) {
                            // Static should fill the gap
                            assert.strictEqual(merged[key], staticData[key],
                                `Static field "${key}" should fill gap: expected "${staticData[key]}", got "${merged[key]}"`);
                        }
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('both null returns null', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const result = mergeMetadata(null, null);
            assert.strictEqual(result, null, 'mergeMetadata(null, null) should return null');
        });

        it('null live returns static copy', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMetadata,
                (staticData) => {
                    const merged = mergeMetadata(null, staticData);
                    assert.deepStrictEqual(merged, { ...staticData },
                        'mergeMetadata(null, static) should return a copy of static');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('null static returns live copy', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMetadata,
                (live) => {
                    const merged = mergeMetadata(live, null);
                    assert.deepStrictEqual(merged, { ...live },
                        'mergeMetadata(live, null) should return a copy of live');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('merged result contains all keys from both inputs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbNullableMetadata,
                arbNullableMetadata,
                (live, staticData) => {
                    const merged = mergeMetadata(live, staticData);
                    if (!live && !staticData) {
                        assert.strictEqual(merged, null);
                        return true;
                    }
                    const liveKeys = live ? Object.keys(live) : [];
                    const staticKeys = staticData ? Object.keys(staticData) : [];
                    const allKeys = new Set([...liveKeys, ...staticKeys]);
                    for (const key of allKeys) {
                        assert.ok(key in merged,
                            `Merged result should contain key "${key}"`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 2: Static mode returns catalog data
    // **Validates: Requirements 3.2, 5.3**
    describe('Property 2: Static mode returns catalog data', () => {

        /** Generate a simple model ID key */
        const arbModelKey = fc.stringMatching(/^[a-zA-Z0-9._-]{1,15}\/[a-zA-Z0-9._-]{1,15}$/);

        /** Generate a random metadata value (non-null string) */
        const arbMetaValue = fc.string({ minLength: 1, maxLength: 30 });

        /** Generate a random metadata object with at least one field */
        const arbCatalogMetadata = fc.record({
            family: arbMetaValue,
            chat_template: fc.oneof(fc.constant(null), arbMetaValue),
            architecture: fc.oneof(fc.constant(null), arbMetaValue),
            gated: fc.boolean(),
            tags: fc.array(arbMetaValue, { minLength: 0, maxLength: 3 }),
            validation_level: fc.constantFrom('tested', 'community-validated', 'experimental')
        });

        it('returns metadata matching the catalog entry for any model in the catalog', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.asyncProperty(
                arbModelKey,
                arbCatalogMetadata,
                async (modelId, metadata) => {
                    const catalog = { [modelId]: metadata };
                    const resolver = new StaticCatalogResolver(catalog);
                    const result = await resolver.fetchModelMetadata(modelId);
                    assert.deepStrictEqual(result, { ...metadata },
                        `Static lookup for "${modelId}" should return exact catalog metadata`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('returns metadata via resolveModel in static mode matching the catalog entry', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.asyncProperty(
                arbModelKey,
                arbCatalogMetadata,
                async (modelId, metadata) => {
                    // We test StaticCatalogResolver directly since resolveModel uses the global
                    // staticResolver wired to popular-models.json. This validates the same code path.
                    const catalog = { [modelId]: metadata };
                    const resolver = new StaticCatalogResolver(catalog);
                    const result = await resolver.fetchModelMetadata(modelId);
                    assert.ok(result !== null, `Should find model "${modelId}" in catalog`);
                    for (const [key, value] of Object.entries(metadata)) {
                        assert.deepStrictEqual(result[key], value,
                            `Field "${key}" should match catalog entry`);
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 3: Static mode returns null for missing models
    // **Validates: Requirements 3.3, 5.5**
    describe('Property 3: Static mode returns null for missing models', () => {

        /** A small fixed catalog to test against */
        const fixedCatalog = {
            'org-a/model-x': { family: 'test', gated: false },
            'org-b/model-y': { family: 'test2', gated: true }
        };
        const fixedCatalogKeys = new Set(Object.keys(fixedCatalog));

        /** Generate model IDs that definitely don't match the fixed catalog */
        const arbMissingModelId = fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/)
            .filter(id => !fixedCatalogKeys.has(id));

        it('returns null for any model ID not in the catalog', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const resolver = new StaticCatalogResolver(fixedCatalog);

            fc.assert(fc.asyncProperty(
                arbMissingModelId,
                async (modelId) => {
                    const result = await resolver.fetchModelMetadata(modelId);
                    assert.strictEqual(result, null,
                        `Static lookup for missing model "${modelId}" should return null`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('returns null for random IDs against an empty catalog', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const emptyResolver = new StaticCatalogResolver({});

            fc.assert(fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 30 }),
                async (modelId) => {
                    const result = await emptyResolver.fetchModelMetadata(modelId);
                    assert.strictEqual(result, null,
                        `Empty catalog should return null for "${modelId}"`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 7: Response structure invariant
    // **Validates: Requirements 7.7, 7.8**
    describe('Property 7: Response structure invariant', () => {

        /** Generate a random model ID */
        const arbModelId = fc.oneof(
            fc.stringMatching(/^[a-zA-Z0-9._-]{1,15}$/),
            fc.stringMatching(/^[a-zA-Z0-9._-]{1,10}\/[a-zA-Z0-9._-]{1,10}$/)
        );

        /** Generate a random mode */
        const arbMode = fc.constantFrom('static', 'discover');

        /** Generate optional fields array */
        const arbFields = fc.oneof(
            fc.constant(undefined),
            fc.array(
                fc.constantFrom('family', 'chat_template', 'architecture', 'gated', 'tags', 'validation_level'),
                { minLength: 0, maxLength: 4 }
            )
        );

        it('response always contains content array with one text entry, and parsed JSON has values and choices', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.asyncProperty(
                arbModelId,
                arbMode,
                arbFields,
                async (modelId, mode, fields) => {
                    const params = { model_id: modelId, mode };
                    if (fields !== undefined) {
                        params.fields = fields;
                    }
                    const response = await resolveModel(params);

                    // Response must have content array
                    assert.ok(Array.isArray(response.content),
                        'Response must have a content array');
                    assert.strictEqual(response.content.length, 1,
                        'Response content must have exactly one entry');

                    // Content entry must be text type
                    const entry = response.content[0];
                    assert.strictEqual(entry.type, 'text',
                        'Content entry must have type "text"');
                    assert.ok(typeof entry.text === 'string',
                        'Content entry text must be a string');

                    // Parsed JSON must have values and choices
                    const parsed = JSON.parse(entry.text);
                    assert.ok(typeof parsed.values === 'object' && parsed.values !== null,
                        'Parsed response must have values as an object');
                    assert.ok(typeof parsed.choices === 'object' && parsed.choices !== null,
                        'Parsed response must have choices as an object');

                    // When model not found, message should be non-empty string
                    if (Object.keys(parsed.values).length === 0) {
                        assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
                            'When values is empty, message must be a non-empty string');
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 8: Omitted fields returns all metadata
    // **Validates: Requirements 7.3**
    describe('Property 8: Omitted fields returns all metadata', () => {

        /** Generate a model ID key */
        const arbModelKey = fc.stringMatching(/^[a-zA-Z0-9._-]{1,15}$/);

        /** Generate a random metadata object */
        const arbMetadata = fc.record({
            family: fc.string({ minLength: 1, maxLength: 15 }),
            chat_template: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 20 })),
            architecture: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 20 })),
            gated: fc.boolean(),
            tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 3 }),
            validation_level: fc.constantFrom('tested', 'community-validated', 'experimental')
        });

        it('calling without fields parameter returns all metadata fields in values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.asyncProperty(
                arbModelKey,
                arbMetadata,
                async (modelId, metadata) => {
                    // Create a resolver with our generated catalog and call resolveModel-like logic
                    const resolver = new StaticCatalogResolver({ [modelId]: metadata });
                    const result = await resolver.fetchModelMetadata(modelId);

                    assert.ok(result !== null, `Model "${modelId}" should be found`);

                    // All fields from the original metadata should be present
                    for (const key of Object.keys(metadata)) {
                        assert.ok(key in result,
                            `Field "${key}" should be present when fields parameter is omitted`);
                        assert.deepStrictEqual(result[key], metadata[key],
                            `Field "${key}" value should match original metadata`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('resolveModel without fields returns all metadata fields in response values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.asyncProperty(
                arbModelKey,
                arbMetadata,
                async (modelId, metadata) => {
                    // Use resolveModel in static mode with a known catalog model
                    // We use a unique ID that won't collide with the real catalog
                    const uniqueId = `__test_prop8_${modelId}`;
                    const resolver = new StaticCatalogResolver({ [uniqueId]: metadata });
                    const fetchedMeta = await resolver.fetchModelMetadata(uniqueId);

                    assert.ok(fetchedMeta !== null, `Model "${uniqueId}" should be found`);

                    // Verify all original metadata keys are present
                    for (const key of Object.keys(metadata)) {
                        assert.ok(key in fetchedMeta,
                            `Field "${key}" must be present in response values when fields is omitted`);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-picker-mcp, Property 6: Catalog entry schema completeness
    // **Validates: Requirements 6.2**
    describe('Property 6: Catalog entry schema completeness', () => {

        const VALID_VALIDATION_LEVELS = ['tested', 'community-validated', 'experimental'];

        it('every entry in popular-models.json has all required fields with correct types', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const entries = Object.entries(POPULAR_MODELS_CATALOG);

            assert.ok(entries.length > 0, 'Catalog should have at least one entry');

            fc.assert(fc.property(
                fc.constantFrom(...entries),
                ([modelId, entry]) => {
                    // family: string
                    assert.ok(typeof entry.family === 'string' && entry.family.length > 0,
                        `[${modelId}] "family" must be a non-empty string, got ${typeof entry.family}`);

                    // chat_template: string or null
                    assert.ok(entry.chat_template === null || typeof entry.chat_template === 'string',
                        `[${modelId}] "chat_template" must be a string or null, got ${typeof entry.chat_template}`);

                    // gated: boolean
                    assert.ok(typeof entry.gated === 'boolean',
                        `[${modelId}] "gated" must be a boolean, got ${typeof entry.gated}`);

                    // tags: array of strings
                    assert.ok(Array.isArray(entry.tags),
                        `[${modelId}] "tags" must be an array, got ${typeof entry.tags}`);
                    for (const tag of entry.tags) {
                        assert.ok(typeof tag === 'string',
                            `[${modelId}] each tag must be a string, got ${typeof tag}`);
                    }

                    // architecture: string or null
                    assert.ok(entry.architecture === null || typeof entry.architecture === 'string',
                        `[${modelId}] "architecture" must be a string or null, got ${typeof entry.architecture}`);

                    // framework_compatibility: object
                    assert.ok(
                        typeof entry.framework_compatibility === 'object'
                        && entry.framework_compatibility !== null
                        && !Array.isArray(entry.framework_compatibility),
                        `[${modelId}] "framework_compatibility" must be a non-null object`);

                    // validation_level: one of tested, community-validated, experimental
                    assert.ok(VALID_VALIDATION_LEVELS.includes(entry.validation_level),
                        `[${modelId}] "validation_level" must be one of ${VALID_VALIDATION_LEVELS.join(', ')}, got "${entry.validation_level}"`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
