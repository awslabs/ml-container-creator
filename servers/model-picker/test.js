#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the model-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/model-picker/test.js
 */

import assert from 'node:assert';
import fc from 'fast-check';
import {
    POPULAR_MODELS_CATALOG,
    StaticCatalogResolver,
    S3Resolver,
    resolveModel,
    mergeMetadata,
    parseS3Uri,
    buildS3Uri,
    staticResolver,
    loadCatalog,
    registry,
    JumpStartPublicResolver,
    JumpStartPrivateResolver,
    ModelRegistryResolver,
    HuggingFaceResolver,
    filterByProvider,
    formatModelChoice
} from './index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

console.log('\nmodel-picker: catalog loading\n');

test('POPULAR_MODELS_CATALOG is a non-empty object', () => {
    assert.ok(typeof POPULAR_MODELS_CATALOG === 'object');
    assert.ok(Object.keys(POPULAR_MODELS_CATALOG).length > 0);
});

test('loadCatalog returns object for valid path', () => {
    const catalog = loadCatalog(new URL('../lib/catalogs/models.json', import.meta.url).pathname);
    assert.ok(typeof catalog === 'object');
    assert.ok(Object.keys(catalog).length > 0);
});

test('loadCatalog throws for invalid path', () => {
    assert.throws(() => loadCatalog('/nonexistent/path.json'), /Catalog file not found/);
});

console.log('\nmodel-picker: StaticCatalogResolver\n');

test('staticResolver supports known keys', () => {
    const keys = staticResolver.supportedKeys();
    assert.ok(keys.length > 0, 'should support at least one key');
});

test('catalog contains expected model families', () => {
    const modelIds = Object.keys(POPULAR_MODELS_CATALOG);
    const hasLlama = modelIds.some(id => id.includes('Llama') || id.includes('llama'));
    const hasMistral = modelIds.some(id => id.includes('Mistral') || id.includes('mistral'));
    assert.ok(hasLlama || hasMistral, 'catalog should contain Llama or Mistral models');
});

test('catalog entries have required fields', () => {
    for (const [modelId, entry] of Object.entries(POPULAR_MODELS_CATALOG)) {
        // Unified catalog entries from model-sizes may not have family (they have architecture/modelType)
        // JumpStart entries have provider instead of family
        assert.ok(
            entry.family !== undefined || entry.modelType !== undefined || entry.provider !== undefined,
            `${modelId} should have family, modelType, or provider field`
        );
    }
});

console.log('\nmodel-picker: mergeMetadata\n');

test('live data takes precedence over catalog for non-null fields', () => {
    const hfData = { family: 'hf-family', tags: ['text-generation'] };
    const catalogData = { family: 'catalog-family', validation_level: 'tested' };
    const merged = mergeMetadata(hfData, catalogData);
    assert.strictEqual(merged.family, 'hf-family');
    assert.strictEqual(merged.validation_level, 'tested');
    assert.deepStrictEqual(merged.tags, ['text-generation']);
});

test('mergeMetadata handles null inputs', () => {
    const result = mergeMetadata(null, null);
    assert.ok(typeof result === 'object');
});

test('mergeMetadata with only HF data', () => {
    const hfData = { family: 'llama', tags: ['text-generation'] };
    const merged = mergeMetadata(hfData, null);
    assert.strictEqual(merged.family, 'llama');
});

test('mergeMetadata with only catalog data', () => {
    const catalogData = { family: 'llama', validation_level: 'tested' };
    const merged = mergeMetadata(null, catalogData);
    assert.strictEqual(merged.family, 'llama');
    assert.strictEqual(merged.validation_level, 'tested');
});

console.log('\nmodel-picker: resolveModel\n');

await asyncTest('resolveModel returns data for known model', async () => {
    const knownModel = Object.keys(POPULAR_MODELS_CATALOG).find(id => !id.includes('*'));
    if (!knownModel) return; // skip if no non-glob models
    const result = await resolveModel({ model_id: knownModel, mode: 'static' });
    assert.ok(result.content, 'should have content');
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.values, 'should have values');
    assert.ok(Object.keys(parsed.values).length > 0, 'values should not be empty for known model');
});

await asyncTest('resolveModel returns message for unknown model', async () => {
    const result = await resolveModel({ model_id: 'nonexistent/model-xyz-999', mode: 'static' });
    assert.ok(result.content, 'should have content');
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.message, 'should have a message for unknown model');
});

// ── Property-Based Tests ──────────────────────────────────────────────────────

console.log('\nmodel-picker: property-based tests\n');

// Feature: alternate-model-providers, Property 5: S3 URI round-trip
// For any valid S3 URI, parsing then reconstructing produces the original URI.
// Validates: Requirements 6.5, 13.6

/**
 * Generator for valid S3 bucket names.
 * Rules: 3–63 chars, lowercase letters/numbers/hyphens/periods,
 * must start and end with letter or number, no consecutive periods,
 * not an IP address format.
 */
function validBucketName() {
    const alphaNum = fc.stringOf(
        fc.mapToConstant(
            { num: 26, build: v => String.fromCharCode(97 + v) }, // a-z
            { num: 10, build: v => String.fromCharCode(48 + v) }  // 0-9
        ),
        { minLength: 1, maxLength: 61 }
    );
    return alphaNum.map(middle => {
        // Ensure 3–63 chars total, starts/ends with alnum
        const name = middle.length < 1 ? 'aaa' : middle;
        return name.length < 3 ? name.padEnd(3, 'a') : name.slice(0, 63);
    });
}

/**
 * Generator for valid S3 object keys (≤ 1024 chars).
 * Uses printable ASCII characters that are common in S3 keys.
 */
function validKey() {
    const keyChar = fc.mapToConstant(
        { num: 26, build: v => String.fromCharCode(97 + v) },  // a-z
        { num: 26, build: v => String.fromCharCode(65 + v) },  // A-Z
        { num: 10, build: v => String.fromCharCode(48 + v) },  // 0-9
        { num: 5, build: v => ['-', '_', '.', '/', '!'][v] }   // common key chars
    );
    return fc.stringOf(keyChar, { minLength: 0, maxLength: 1024 });
}

test('Property 5: S3 URI round-trip — parse then rebuild equals original', () => {
    fc.assert(
        fc.property(
            fc.tuple(validBucketName(), validKey()),
            ([bucket, key]) => {
                const uri = `s3://${bucket}/${key}`;
                const parsed = parseS3Uri(uri);

                // Must parse successfully
                assert.ok(!parsed.error, `Expected valid parse for ${uri}, got error: ${parsed.error}`);
                assert.strictEqual(parsed.bucket, bucket);
                assert.strictEqual(parsed.key, key);

                // Round-trip: rebuild must equal original
                const rebuilt = buildS3Uri(parsed.bucket, parsed.key);
                assert.strictEqual(rebuilt, uri);
            }
        ),
        { numRuns: 100 }
    );
});

// Feature: alternate-model-providers, Property 4: S3 URI parse/validate correctness
// For any string input, parseS3Uri either returns a valid { bucket, key } conforming
// to S3 naming rules, or { error } with a descriptive message. It never throws.
// Validates: Requirements 5.2, 5.3, 6.1, 6.2, 6.3, 6.4

const S3_BUCKET_REGEX = /^(?!(\d{1,3}\.){3}\d{1,3}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

test('Property 4: S3 URI parse/validate — always returns valid result or error, never throws', () => {
    fc.assert(
        fc.property(
            fc.string(),
            (input) => {
                let result;
                try {
                    result = parseS3Uri(input);
                } catch (err) {
                    assert.fail(`parseS3Uri threw on input ${JSON.stringify(input)}: ${err.message}`);
                }

                assert.ok(typeof result === 'object' && result !== null, 'result must be a non-null object');

                if (result.error !== undefined) {
                    // Error path: must have a descriptive string message
                    assert.strictEqual(typeof result.error, 'string', 'error must be a string');
                    assert.ok(result.error.length > 0, 'error message must not be empty');
                    assert.strictEqual(result.bucket, undefined, 'error result must not have bucket');
                    assert.strictEqual(result.key, undefined, 'error result must not have key');
                } else {
                    // Success path: bucket and key must conform to rules
                    assert.strictEqual(typeof result.bucket, 'string', 'bucket must be a string');
                    assert.strictEqual(typeof result.key, 'string', 'key must be a string');

                    // Bucket naming rules: 3–63 chars
                    assert.ok(result.bucket.length >= 3, `bucket too short: ${result.bucket.length}`);
                    assert.ok(result.bucket.length <= 63, `bucket too long: ${result.bucket.length}`);

                    // Lowercase letters, numbers, hyphens, periods only; no consecutive periods
                    assert.ok(!result.bucket.includes('..'), 'bucket must not have consecutive periods');
                    assert.ok(S3_BUCKET_REGEX.test(result.bucket), `bucket fails naming regex: ${result.bucket}`);

                    // Key ≤ 1024 chars
                    assert.ok(result.key.length <= 1024, `key too long: ${result.key.length}`);
                }
            }
        ),
        { numRuns: 100 }
    );
});

// Feature: alternate-model-providers, Property 3: JumpStart catalog schema validity
// For any entry in jumpstart-public.json, the entry has required fields with correct types.
// Validates: Requirements 2.2

test('Property 3: JumpStart catalog schema validity — all entries have required fields with correct types', () => {
    const catalog = loadCatalog(new URL('./catalogs/jumpstart-public.json', import.meta.url).pathname);
    const entries = Object.entries(catalog);

    assert.ok(entries.length > 0, 'catalog must have at least one entry');

    for (const [key, entry] of entries) {
        assert.strictEqual(typeof entry.modelId, 'string', `${key}: modelId must be a string`);
        assert.ok(entry.modelId.length > 0, `${key}: modelId must not be empty`);

        assert.strictEqual(typeof entry.framework, 'string', `${key}: framework must be a string`);
        assert.ok(entry.framework.length > 0, `${key}: framework must not be empty`);

        assert.strictEqual(typeof entry.provider, 'string', `${key}: provider must be a string`);
        assert.strictEqual(entry.provider, 'jumpstart', `${key}: provider must equal 'jumpstart'`);

        assert.ok(Array.isArray(entry.tags), `${key}: tags must be an array`);
        for (const tag of entry.tags) {
            assert.strictEqual(typeof tag, 'string', `${key}: each tag must be a string`);
        }

        assert.strictEqual(typeof entry.description, 'string', `${key}: description must be a string`);
        assert.ok(entry.description.length > 0, `${key}: description must not be empty`);
    }
});

// Feature: alternate-model-providers, Property 6: Framework inference determinism
// For any set of config file contents, _inferFramework returns a consistent framework
// string. When config.json has architectures, returns 'huggingface'. When
// serving.properties has model_id/option.model_id, returns 'djl'.
// Validates: Requirements 5.6

test('Property 6: Framework inference determinism — consistent output for same input', () => {
    const resolver = new S3Resolver();

    fc.assert(
        fc.property(
            fc.record({
                architectures: fc.option(
                    fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
                    { nil: undefined }
                ),
                model_type: fc.option(fc.string({ minLength: 1 }), { nil: undefined })
            }),
            (configShape) => {
                // Build config files from the generated shape
                const configFiles = {};

                // Build a config.json with the generated fields
                const configJson = {};
                if (configShape.architectures !== undefined) {
                    configJson.architectures = configShape.architectures;
                }
                if (configShape.model_type !== undefined) {
                    configJson.model_type = configShape.model_type;
                }
                if (Object.keys(configJson).length > 0) {
                    configFiles['config.json'] = JSON.stringify(configJson);
                }

                // Call _inferFramework twice with the same input
                const result1 = resolver._inferFramework(configFiles);
                const result2 = resolver._inferFramework(configFiles);

                // Determinism: same input always produces same output
                assert.strictEqual(result1, result2, 'framework inference must be deterministic');

                // Type check: result is either a string or null
                if (result1 !== null) {
                    assert.strictEqual(typeof result1, 'string', 'framework must be a string when not null');
                    assert.ok(result1.length > 0, 'framework string must not be empty');
                }

                // When architectures is a non-empty array, framework must be 'huggingface'
                if (configShape.architectures !== undefined && configShape.architectures.length > 0) {
                    assert.strictEqual(result1, 'huggingface',
                        'config.json with architectures should infer huggingface');
                }

                // When model_type is present (and no architectures), framework must be 'huggingface'
                if (configShape.architectures === undefined && configShape.model_type !== undefined) {
                    assert.strictEqual(result1, 'huggingface',
                        'config.json with model_type should infer huggingface');
                }
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 6: Framework inference — serving.properties with model_id infers djl', () => {
    const resolver = new S3Resolver();

    fc.assert(
        fc.property(
            fc.oneof(
                fc.constant('model_id=some-model\n'),
                fc.constant('option.model_id=some-model\n'),
                fc.constant('batch_size=4\nmodel_id=my-model\nengine=Python\n'),
                fc.constant('option.model_id=meta-llama/Llama-2\noption.tensor_parallel_degree=2\n')
            ),
            (servingContent) => {
                const configFiles = { 'serving.properties': servingContent };

                const result1 = resolver._inferFramework(configFiles);
                const result2 = resolver._inferFramework(configFiles);

                assert.strictEqual(result1, result2, 'must be deterministic');
                assert.strictEqual(result1, 'djl', 'serving.properties with model_id should infer djl');
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 6: Framework inference — empty config files returns null', () => {
    const resolver = new S3Resolver();
    const result = resolver._inferFramework({});
    assert.strictEqual(result, null, 'empty config files should return null');
});

// Feature: alternate-model-providers, Property 1: URI-prefix routing correctness
// For any model ID string, the ResolverRegistry routes it to the correct resolver
// based on URI prefix, following first-match semantics.
// Validates: Requirements 1.1, 3.1, 4.1, 5.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6

test('Property 1: URI-prefix routing correctness — each prefix routes to the correct resolver', () => {
    const HF_PATTERN = /^[^/]+\/[^/]+$/;

    fc.assert(
        fc.property(
            fc.oneof(
                fc.constant('jumpstart://'),
                fc.constant('jumpstart-hub://'),
                fc.constant('registry://'),
                fc.constant('s3://'),
                fc.constant('')
            ).chain(prefix => fc.string().map(s => prefix + s)),
            (modelId) => {
                const resolver = registry.getResolver(modelId);

                if (modelId.startsWith('jumpstart://')) {
                    assert.ok(
                        resolver instanceof JumpStartPublicResolver,
                        `Expected JumpStartPublicResolver for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                } else if (modelId.startsWith('jumpstart-hub://')) {
                    assert.ok(
                        resolver instanceof JumpStartPrivateResolver,
                        `Expected JumpStartPrivateResolver for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                } else if (modelId.startsWith('registry://')) {
                    assert.ok(
                        resolver instanceof ModelRegistryResolver,
                        `Expected ModelRegistryResolver for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                } else if (modelId.startsWith('s3://')) {
                    assert.ok(
                        resolver instanceof S3Resolver,
                        `Expected S3Resolver for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                } else if (HF_PATTERN.test(modelId) && !modelId.includes('://')) {
                    assert.ok(
                        resolver instanceof HuggingFaceResolver,
                        `Expected HuggingFaceResolver for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                } else {
                    assert.ok(
                        resolver instanceof StaticCatalogResolver,
                        `Expected StaticCatalogResolver (default) for "${modelId}", got ${resolver?.constructor?.name}`
                    );
                }
            }
        ),
        { numRuns: 100 }
    );
});

// Feature: alternate-model-providers, Property 9: Provider filter correctness
// For any set of models from mixed providers and any provider filter value,
// the filtered result contains only models whose provider matches the filter,
// and contains all such matching models from the original set.
// Validates: Requirements 10.4

test('Property 9: Provider filter correctness — filtered results contain only and all matching models', () => {
    fc.assert(
        fc.property(
            fc.array(fc.record({
                provider: fc.oneof(
                    fc.constant('jumpstart'),
                    fc.constant('jumpstart-hub'),
                    fc.constant('registry'),
                    fc.constant('s3'),
                    fc.constant('huggingface')
                ),
                modelId: fc.string({ minLength: 1 })
            })),
            fc.oneof(
                fc.constant('jumpstart'),
                fc.constant('jumpstart-hub'),
                fc.constant('registry'),
                fc.constant('s3'),
                fc.constant('huggingface')
            ),
            (models, provider) => {
                const result = filterByProvider(models, provider);

                // All returned models have provider === filter
                for (const model of result) {
                    assert.strictEqual(model.provider, provider,
                        `Expected provider "${provider}", got "${model.provider}"`);
                }

                // Count of returned models equals count of matching models in original array
                const expectedCount = models.filter(m => m && m.provider === provider).length;
                assert.strictEqual(result.length, expectedCount,
                    `Expected ${expectedCount} models with provider "${provider}", got ${result.length}`);

                // No matching models were dropped (completeness)
                const expectedModels = models.filter(m => m && m.provider === provider);
                for (let i = 0; i < expectedModels.length; i++) {
                    assert.strictEqual(result[i].modelId, expectedModels[i].modelId,
                        `Model at index ${i} was dropped or reordered`);
                }
            }
        ),
        { numRuns: 100 }
    );
});

// Feature: alternate-model-providers, Property 8: Provider prefix formatting
// For any model metadata with a known provider, the formatted choice string
// includes the correct bracket prefix followed by the modelId.
// Validates: Requirements 10.2

test('Property 8: Provider prefix formatting — correct bracket prefix for each provider', () => {
    const PROVIDER_LABELS = {
        'jumpstart': '[JumpStart]',
        'jumpstart-hub': '[JumpStart Hub]',
        'registry': '[Registry]',
        's3': '[S3]',
        'huggingface': '[HuggingFace]'
    };

    fc.assert(
        fc.property(
            fc.record({
                provider: fc.oneof(
                    fc.constant('jumpstart'),
                    fc.constant('jumpstart-hub'),
                    fc.constant('registry'),
                    fc.constant('s3'),
                    fc.constant('huggingface')
                ),
                modelId: fc.string({ minLength: 1 })
            }),
            (metadata) => {
                const result = formatModelChoice(metadata);

                // Result must be a non-empty string
                assert.strictEqual(typeof result, 'string', 'result must be a string');
                assert.ok(result.length > 0, 'result must not be empty');

                // Result must start with the correct bracket prefix for the provider
                const expectedPrefix = PROVIDER_LABELS[metadata.provider];
                assert.ok(result.startsWith(`${expectedPrefix  } `),
                    `Expected result to start with "${expectedPrefix} ", got "${result}"`);

                // Result must contain the modelId after the prefix
                const afterPrefix = result.slice(expectedPrefix.length + 1);
                assert.strictEqual(afterPrefix, metadata.modelId,
                    `Expected modelId "${metadata.modelId}" after prefix, got "${afterPrefix}"`);
            }
        ),
        { numRuns: 100 }
    );
});

// Feature: alternate-model-providers, Property 2: Metadata mapping completeness
// For any valid API response from any resolver, the mapped ModelMetadata object
// always contains provider, modelId, and description. When the source includes
// framework/artifactUri/modelFormat/modelSize, those are present in the output.
// Validates: Requirements 1.4, 3.4, 4.4, 5.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7

console.log('\nmodel-picker: Property 2 — Metadata mapping completeness\n');

test('Property 2: JumpStartPublicResolver._mapToMetadata always returns provider, modelId, description', () => {
    const resolver = new JumpStartPublicResolver();

    fc.assert(
        fc.property(
            fc.record({
                model_id: fc.string({ minLength: 1 }),
                framework: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                model_type: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                inference_task: fc.option(fc.string({ minLength: 1 }), { nil: undefined })
            }),
            (spec) => {
                const bareId = spec.model_id;
                const result = resolver._mapToMetadata(spec, bareId);

                // Must always have the three required fields
                assert.ok(result !== null, 'result must not be null for non-null input');
                assert.strictEqual(typeof result.provider, 'string', 'provider must be a string');
                assert.strictEqual(result.provider, 'jumpstart', 'provider must be jumpstart');
                assert.strictEqual(typeof result.modelId, 'string', 'modelId must be a string');
                assert.ok(result.modelId.length > 0, 'modelId must not be empty');
                assert.strictEqual(typeof result.description, 'string', 'description must be a string');

                // When source has framework, output must include it
                if (spec.framework) {
                    assert.strictEqual(typeof result.framework, 'string', 'framework must be present when source has it');
                    assert.strictEqual(result.framework, spec.framework, 'framework must match source');
                }

                // When source has model_type or inference_task, tags must be present
                if (spec.model_type || spec.inference_task) {
                    assert.ok(Array.isArray(result.tags), 'tags must be an array when task fields present');
                    assert.ok(result.tags.length > 0, 'tags must not be empty when task fields present');
                }
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 2: JumpStartPublicResolver._mapToMetadata returns null for null input', () => {
    const resolver = new JumpStartPublicResolver();
    const result = resolver._mapToMetadata(null, 'test-id');
    assert.strictEqual(result, null, 'null input must return null');
});

test('Property 2: JumpStartPrivateResolver._mapToMetadata always returns provider, modelId, description', () => {
    const resolver = new JumpStartPrivateResolver();

    fc.assert(
        fc.property(
            fc.record({
                HubContentName: fc.string({ minLength: 1 }),
                HubContentDisplayName: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                HubContentDescription: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                HubContentSearchKeywords: fc.option(fc.array(fc.string()), { nil: undefined }),
                HubContentDocument: fc.option(
                    fc.record({
                        Framework: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                        ModelFormat: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                        ArtifactUri: fc.option(fc.string({ minLength: 1 }), { nil: undefined })
                    }).map(doc => JSON.stringify(doc)),
                    { nil: undefined }
                )
            }),
            fc.string({ minLength: 1 }),
            (apiResponse, hubName) => {
                const result = resolver._mapToMetadata(apiResponse, hubName);

                assert.ok(result !== null, 'result must not be null for non-null input');
                assert.strictEqual(typeof result.provider, 'string', 'provider must be a string');
                assert.strictEqual(result.provider, 'jumpstart-hub', 'provider must be jumpstart-hub');
                assert.strictEqual(typeof result.modelId, 'string', 'modelId must be a string');
                assert.ok(result.modelId.length > 0, 'modelId must not be empty');
                assert.strictEqual(typeof result.description, 'string', 'description must be a string');
                assert.strictEqual(result.hubName, hubName, 'hubName must be passed through');

                // When source has HubContentDocument with Framework, output must include it
                if (apiResponse.HubContentDocument) {
                    try {
                        const doc = JSON.parse(apiResponse.HubContentDocument);
                        if (doc.Framework) {
                            assert.strictEqual(typeof result.framework, 'string', 'framework must be present when doc has it');
                        }
                        if (doc.ArtifactUri) {
                            assert.strictEqual(typeof result.artifactUri, 'string', 'artifactUri must be present when doc has it');
                        }
                        if (doc.ModelFormat) {
                            assert.strictEqual(typeof result.modelFormat, 'string', 'modelFormat must be present when doc has it');
                        }
                    } catch {
                        // JSON parse failure is acceptable — resolver handles it gracefully
                    }
                }
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 2: JumpStartPrivateResolver._mapToMetadata returns null for null input', () => {
    const resolver = new JumpStartPrivateResolver();
    const result = resolver._mapToMetadata(null, 'my-hub');
    assert.strictEqual(result, null, 'null input must return null');
});

test('Property 2: ModelRegistryResolver._mapToMetadata always returns provider, modelId, description', () => {
    const resolver = new ModelRegistryResolver();

    fc.assert(
        fc.property(
            fc.record({
                ModelPackageArn: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                ModelPackageGroupName: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                ModelPackageVersion: fc.option(fc.nat(), { nil: undefined }),
                ModelPackageDescription: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                ModelApprovalStatus: fc.option(
                    fc.oneof(fc.constant('Approved'), fc.constant('Rejected'), fc.constant('PendingManualApproval')),
                    { nil: undefined }
                ),
                ModelDataUrl: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                InferenceSpecification: fc.option(
                    fc.record({
                        Containers: fc.array(
                            fc.record({
                                Framework: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                                ModelDataUrl: fc.option(fc.string({ minLength: 1 }), { nil: undefined })
                            }),
                            { minLength: 1, maxLength: 3 }
                        )
                    }),
                    { nil: undefined }
                )
            }),
            fc.string({ minLength: 1 }),
            (apiResponse, groupName) => {
                const result = resolver._mapToMetadata(apiResponse, groupName);

                assert.ok(result !== null, 'result must not be null for non-null input');
                assert.strictEqual(typeof result.provider, 'string', 'provider must be a string');
                assert.strictEqual(result.provider, 'registry', 'provider must be registry');
                assert.strictEqual(typeof result.modelId, 'string', 'modelId must be a string');
                assert.ok(result.modelId.length > 0, 'modelId must not be empty');
                assert.strictEqual(typeof result.description, 'string', 'description must be a string');

                // When source has InferenceSpecification with Framework, output must include it
                const container = apiResponse.InferenceSpecification?.Containers?.[0];
                if (container?.Framework) {
                    assert.strictEqual(typeof result.framework, 'string', 'framework must be present when source has it');
                }

                // When source has artifact URI (from container or top-level), output must include it
                if (container?.ModelDataUrl || apiResponse.ModelDataUrl) {
                    assert.strictEqual(typeof result.artifactUri, 'string', 'artifactUri must be present when source has it');
                }

                // When source has ModelPackageArn, output must include it
                if (apiResponse.ModelPackageArn) {
                    assert.strictEqual(result.modelPackageArn, apiResponse.ModelPackageArn, 'modelPackageArn must be mapped');
                }

                // When source has ModelPackageVersion, output must include it
                if (apiResponse.ModelPackageVersion !== undefined && apiResponse.ModelPackageVersion !== null) {
                    assert.strictEqual(result.modelPackageVersion, apiResponse.ModelPackageVersion, 'modelPackageVersion must be mapped');
                }

                // When source has ModelApprovalStatus, output must include it
                if (apiResponse.ModelApprovalStatus) {
                    assert.strictEqual(result.approvalStatus, apiResponse.ModelApprovalStatus, 'approvalStatus must be mapped');
                }
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 2: ModelRegistryResolver._mapToMetadata returns null for null input', () => {
    const resolver = new ModelRegistryResolver();
    const result = resolver._mapToMetadata(null, 'my-group');
    assert.strictEqual(result, null, 'null input must return null');
});

// Note: S3Resolver does not have a separate _mapToMetadata — metadata is built
// inline in fetchModelMetadata. We verify the S3 metadata shape via the existing
// Property 5 (round-trip) and Property 4 (parse/validate) tests, plus the
// example-based tests in task 12. The S3 metadata always includes provider,
// modelId, and description by construction in fetchModelMetadata.

// Feature: alternate-model-providers, Property 7: Graceful degradation — null return without throwing
// For any AWS-backed resolver and any AWS SDK error type, the resolver returns
// null without throwing an exception.
// Validates: Requirements 9.1, 9.3

console.log('\nmodel-picker: Property 7 — Graceful degradation\n');

await asyncTest('Property 7: JumpStartPublicResolver returns null on any error, never throws', async () => {
    const errorTypes = [
        { name: 'NetworkError', message: 'Network failure' },
        { name: 'TimeoutError', message: 'Request timed out' },
        { name: 'CredentialsError', message: 'Missing credentials' },
        { name: 'CredentialsProviderError', message: 'No credential provider' },
        { name: 'ExpiredTokenException', message: 'Token expired' },
        { name: 'AccessDeniedException', message: 'Access denied' },
        { name: 'ThrottlingException', message: 'Rate exceeded' },
        { name: 'ServiceUnavailableException', message: 'Service unavailable' },
        { name: 'InternalServerError', message: 'Internal error' },
        { name: 'UnknownError', message: 'Something went wrong' }
    ];

    for (const errDef of errorTypes) {
        const resolver = new JumpStartPublicResolver();

        // Override _loadSdk to return a mock SDK that always throws
        resolver._loadSdk = async () => {
            const err = new Error(errDef.message);
            err.name = errDef.name;
            return {
                DescribeFoundationModelCommand: class { constructor() {} },
                ListFoundationModelsCommand: class { constructor() {} },
                SageMakerClient: class {
                    constructor() {}
                    send() { throw err; }
                    destroy() {}
                }
            };
        };

        let result;
        try {
            result = await resolver.fetchModelMetadata('jumpstart://test-model');
        } catch (thrown) {
            assert.fail(`JumpStartPublicResolver threw on ${errDef.name}: ${thrown.message}`);
        }

        // Must return null (or a static catalog fallback object for credential errors)
        assert.ok(result === null || typeof result === 'object',
            `Expected null or fallback object for ${errDef.name}, got ${typeof result}`);
    }
});

await asyncTest('Property 7: JumpStartPrivateResolver returns null on any error, never throws', async () => {
    const errorTypes = [
        { name: 'NetworkError', message: 'Network failure' },
        { name: 'TimeoutError', message: 'Request timed out' },
        { name: 'CredentialsError', message: 'Missing credentials' },
        { name: 'CredentialsProviderError', message: 'No credential provider' },
        { name: 'ExpiredTokenException', message: 'Token expired' },
        { name: 'ResourceNotFoundException', message: 'Hub not found' },
        { name: 'AccessDeniedException', message: 'Access denied' },
        { name: 'ThrottlingException', message: 'Rate exceeded' },
        { name: 'ServiceUnavailableException', message: 'Service unavailable' },
        { name: 'InternalServerError', message: 'Internal error' },
        { name: 'UnknownError', message: 'Something went wrong' }
    ];

    for (const errDef of errorTypes) {
        const resolver = new JumpStartPrivateResolver();

        resolver._loadSdk = async () => {
            const err = new Error(errDef.message);
            err.name = errDef.name;
            return {
                DescribeHubContentCommand: class { constructor() {} },
                ListHubContentsCommand: class { constructor() {} },
                SageMakerClient: class {
                    constructor() {}
                    send() { throw err; }
                    destroy() {}
                }
            };
        };

        let result;
        try {
            result = await resolver.fetchModelMetadata('jumpstart-hub://my-hub/my-model');
        } catch (thrown) {
            assert.fail(`JumpStartPrivateResolver threw on ${errDef.name}: ${thrown.message}`);
        }

        assert.strictEqual(result, null,
            `Expected null for ${errDef.name}, got ${JSON.stringify(result)}`);
    }
});

await asyncTest('Property 7: ModelRegistryResolver returns null on any error, never throws', async () => {
    const errorTypes = [
        { name: 'NetworkError', message: 'Network failure' },
        { name: 'TimeoutError', message: 'Request timed out' },
        { name: 'CredentialsError', message: 'Missing credentials' },
        { name: 'CredentialsProviderError', message: 'No credential provider' },
        { name: 'ExpiredTokenException', message: 'Token expired' },
        { name: 'ResourceNotFoundException', message: 'Group not found' },
        { name: 'AccessDeniedException', message: 'Access denied' },
        { name: 'ValidationException', message: 'Invalid input' },
        { name: 'ThrottlingException', message: 'Rate exceeded' },
        { name: 'ServiceUnavailableException', message: 'Service unavailable' },
        { name: 'InternalServerError', message: 'Internal error' },
        { name: 'UnknownError', message: 'Something went wrong' }
    ];

    for (const errDef of errorTypes) {
        const resolver = new ModelRegistryResolver();

        resolver._loadSdk = async () => {
            const err = new Error(errDef.message);
            err.name = errDef.name;
            return {
                DescribeModelPackageCommand: class { constructor() {} },
                ListModelPackagesCommand: class { constructor() {} },
                SageMakerClient: class {
                    constructor() {}
                    send() { throw err; }
                    destroy() {}
                }
            };
        };

        let result;
        try {
            result = await resolver.fetchModelMetadata('registry://my-group/1');
        } catch (thrown) {
            assert.fail(`ModelRegistryResolver threw on ${errDef.name}: ${thrown.message}`);
        }

        assert.strictEqual(result, null,
            `Expected null for ${errDef.name}, got ${JSON.stringify(result)}`);
    }
});

await asyncTest('Property 7: S3Resolver returns null on any error, never throws', async () => {
    const errorTypes = [
        { name: 'NetworkError', message: 'Network failure' },
        { name: 'TimeoutError', message: 'Request timed out' },
        { name: 'CredentialsError', message: 'Missing credentials' },
        { name: 'CredentialsProviderError', message: 'No credential provider' },
        { name: 'ExpiredTokenException', message: 'Token expired' },
        { name: 'NoSuchBucket', message: 'Bucket not found' },
        { name: 'NoSuchKey', message: 'Key not found' },
        { name: 'AccessDenied', message: 'Access denied' },
        { name: 'ThrottlingException', message: 'Rate exceeded' },
        { name: 'ServiceUnavailableException', message: 'Service unavailable' },
        { name: 'InternalServerError', message: 'Internal error' },
        { name: 'UnknownError', message: 'Something went wrong' }
    ];

    for (const errDef of errorTypes) {
        const resolver = new S3Resolver();

        resolver._loadSdk = async () => {
            const err = new Error(errDef.message);
            err.name = errDef.name;
            return {
                HeadObjectCommand: class { constructor() {} },
                ListObjectsV2Command: class { constructor() {} },
                GetObjectCommand: class { constructor() {} },
                S3Client: class {
                    constructor() {}
                    send() { throw err; }
                    destroy() {}
                }
            };
        };

        let result;
        try {
            result = await resolver.fetchModelMetadata('s3://my-bucket/my-model');
        } catch (thrown) {
            assert.fail(`S3Resolver threw on ${errDef.name}: ${thrown.message}`);
        }

        assert.strictEqual(result, null,
            `Expected null for ${errDef.name}, got ${JSON.stringify(result)}`);
    }
});

await asyncTest('Property 7: Graceful degradation with fc-generated error types', async () => {
    // Use fast-check to generate random error configurations
    const resolverConfigs = [
        {
            name: 'JumpStartPublicResolver',
            create: () => new JumpStartPublicResolver(),
            modelId: 'jumpstart://test-model',
            sdkCommands: {
                DescribeFoundationModelCommand: class { constructor() {} },
                ListFoundationModelsCommand: class { constructor() {} }
            },
            clientClass: 'SageMakerClient'
        },
        {
            name: 'JumpStartPrivateResolver',
            create: () => new JumpStartPrivateResolver(),
            modelId: 'jumpstart-hub://test-hub/test-model',
            sdkCommands: {
                DescribeHubContentCommand: class { constructor() {} },
                ListHubContentsCommand: class { constructor() {} }
            },
            clientClass: 'SageMakerClient'
        },
        {
            name: 'ModelRegistryResolver',
            create: () => new ModelRegistryResolver(),
            modelId: 'registry://test-group/1',
            sdkCommands: {
                DescribeModelPackageCommand: class { constructor() {} },
                ListModelPackagesCommand: class { constructor() {} }
            },
            clientClass: 'SageMakerClient'
        },
        {
            name: 'S3Resolver',
            create: () => new S3Resolver(),
            modelId: 's3://my-bucket/my-model',
            sdkCommands: {
                HeadObjectCommand: class { constructor() {} },
                ListObjectsV2Command: class { constructor() {} },
                GetObjectCommand: class { constructor() {} }
            },
            clientClass: 'S3Client'
        }
    ];

    for (const config of resolverConfigs) {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    fc.constant('NetworkError'),
                    fc.constant('TimeoutError'),
                    fc.constant('CredentialsError'),
                    fc.constant('CredentialsProviderError'),
                    fc.constant('ExpiredTokenException'),
                    fc.constant('ResourceNotFoundException'),
                    fc.constant('AccessDeniedException'),
                    fc.constant('NoSuchBucket'),
                    fc.constant('NoSuchKey'),
                    fc.constant('AccessDenied'),
                    fc.constant('ThrottlingException'),
                    fc.constant('ServiceUnavailableException'),
                    fc.constant('InternalServerError')
                ),
                fc.string({ minLength: 1, maxLength: 100 }),
                async (errorName, errorMessage) => {
                    const resolver = config.create();

                    const err = new Error(errorMessage);
                    err.name = errorName;

                    resolver._loadSdk = async () => {
                        const ClientClass = class {
                            constructor() {}
                            send() { throw err; }
                            destroy() {}
                        };
                        return {
                            ...config.sdkCommands,
                            [config.clientClass]: ClientClass
                        };
                    };

                    let result;
                    try {
                        result = await resolver.fetchModelMetadata(config.modelId);
                    } catch (thrown) {
                        assert.fail(
                            `${config.name} threw on error "${errorName}": ${thrown.message}`
                        );
                    }

                    // Must return null or a fallback object (JumpStartPublic may return static catalog)
                    assert.ok(result === null || typeof result === 'object',
                        `${config.name}: expected null or object for "${errorName}", got ${typeof result}`);
                }
            ),
            { numRuns: 100 }
        );
    }
});

// ── Example-Based Unit Tests ──────────────────────────────────────────────────
// Feature: alternate-model-providers, Task 12.1
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8

console.log('\nmodel-picker: example-based unit tests — JumpStart Public\n');

await asyncTest('JumpStart Public static mode: jumpstart:// IDs resolve from static catalog', async () => {
    const result = await resolveModel({
        model_id: 'jumpstart://huggingface-llm-falcon-7b',
        mode: 'static'
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(Object.keys(parsed.values).length > 0, 'should have values from static catalog');
    assert.strictEqual(parsed.values.provider, 'jumpstart', 'provider should be jumpstart');
    assert.strictEqual(parsed.values.framework, 'huggingface', 'framework should be huggingface');
    assert.ok(parsed.values.description.includes('Falcon'), 'description should mention Falcon');
});

await asyncTest('JumpStart Public static mode: unknown jumpstart:// ID returns message', async () => {
    const result = await resolveModel({
        model_id: 'jumpstart://nonexistent-model-xyz',
        mode: 'static'
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.message, 'should have a message for unknown model');
    assert.ok(parsed.message.includes('jumpstart://nonexistent-model-xyz'), 'message should include model ID');
});

await asyncTest('JumpStart Public API fallback: credential error falls back to static catalog in discover mode', async () => {
    const resolver = new JumpStartPublicResolver({
        staticCatalog: POPULAR_MODELS_CATALOG
    });

    resolver._loadSdk = async () => {
        const err = new Error('Missing credentials');
        err.name = 'CredentialsError';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://huggingface-llm-falcon-7b');
    assert.ok(result !== null, 'should fall back to static catalog, not null');
    assert.strictEqual(result.provider, 'jumpstart', 'fallback should have provider jumpstart');
    assert.ok(result.description.includes('Falcon'), 'fallback should have Falcon description');
});

await asyncTest('JumpStart Public API fallback: non-credential error returns null for unknown model', async () => {
    const resolver = new JumpStartPublicResolver();

    resolver._loadSdk = async () => {
        const err = new Error('Service unavailable');
        err.name = 'ServiceUnavailableException';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://some-model');
    assert.strictEqual(result, null, 'should return null on non-credential API error');
});

console.log('\nmodel-picker: example-based unit tests — JumpStart Private\n');

await asyncTest('JumpStart Private hub not found: ResourceNotFoundException returns null with hub name', async () => {
    const resolver = new JumpStartPrivateResolver();

    resolver._loadSdk = async () => {
        const err = new Error('Hub not found');
        err.name = 'ResourceNotFoundException';
        return {
            DescribeHubContentCommand: class { constructor() {} },
            ListHubContentsCommand: class { constructor() {} },
            SageMakerClient: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    // Capture stderr
    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('jumpstart-hub://my-private-hub');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('my-private-hub'), 'stderr should include hub name');
    assert.ok(stderrOutput.includes('Hub not found'), 'stderr should indicate hub not found');
});

await asyncTest('JumpStart Private model not found: ResourceNotFoundException returns null with hub + model name', async () => {
    const resolver = new JumpStartPrivateResolver();

    resolver._loadSdk = async () => {
        const err = new Error('Model not found');
        err.name = 'ResourceNotFoundException';
        return {
            DescribeHubContentCommand: class { constructor() {} },
            ListHubContentsCommand: class { constructor() {} },
            SageMakerClient: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('jumpstart-hub://my-hub/my-model');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('my-hub'), 'stderr should include hub name');
    assert.ok(stderrOutput.includes('my-model'), 'stderr should include model name');
    assert.ok(stderrOutput.includes('Model not found in hub'), 'stderr should indicate model not found in hub');
});

await asyncTest('JumpStart Private access denied: AccessDeniedException returns null without credential details', async () => {
    const resolver = new JumpStartPrivateResolver();

    resolver._loadSdk = async () => {
        const err = new Error('User: arn:aws:iam::123456789012:user/test is not authorized');
        err.name = 'AccessDeniedException';
        return {
            DescribeHubContentCommand: class { constructor() {} },
            ListHubContentsCommand: class { constructor() {} },
            SageMakerClient: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('jumpstart-hub://secure-hub/secret-model');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('Access denied'), 'stderr should indicate access denied');
    assert.ok(stderrOutput.includes('secure-hub'), 'stderr should include hub name');
    assert.ok(!stderrOutput.includes('arn:aws:iam'), 'stderr must NOT include IAM ARN details');
    assert.ok(!stderrOutput.includes('123456789012'), 'stderr must NOT include account ID');
});

console.log('\nmodel-picker: example-based unit tests — Model Registry\n');

await asyncTest('Model Registry group not found: returns null with descriptive message', async () => {
    const resolver = new ModelRegistryResolver();

    resolver._loadSdk = async () => {
        const err = new Error('Group not found');
        err.name = 'ResourceNotFoundException';
        return {
            DescribeModelPackageCommand: class { constructor() {} },
            ListModelPackagesCommand: class { constructor() {} },
            SageMakerClient: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('registry://my-model-group');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('my-model-group'), 'stderr should include group name');
    assert.ok(stderrOutput.includes('not found'), 'stderr should indicate not found');
});

console.log('\nmodel-picker: example-based unit tests — S3\n');

await asyncTest('S3 bucket not found: NoSuchBucket returns null with bucket name', async () => {
    const resolver = new S3Resolver();

    resolver._loadSdk = async () => {
        const err = new Error('The specified bucket does not exist');
        err.name = 'NoSuchBucket';
        return {
            HeadObjectCommand: class { constructor() {} },
            ListObjectsV2Command: class { constructor() {} },
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('s3://nonexistent-bucket/model.tar.gz');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('nonexistent-bucket'), 'stderr should include bucket name');
    assert.ok(stderrOutput.includes('Bucket not found'), 'stderr should indicate bucket not found');
});

await asyncTest('S3 key not found: NoSuchKey returns null with bucket + key', async () => {
    const resolver = new S3Resolver();

    // HeadObject throws NoSuchKey, then ListObjectsV2 also throws NoSuchKey
    resolver._loadSdk = async () => {
        const err = new Error('The specified key does not exist');
        err.name = 'NoSuchKey';
        return {
            HeadObjectCommand: class { constructor() {} },
            ListObjectsV2Command: class { constructor() {} },
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('s3://my-bucket/path/to/model');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('my-bucket'), 'stderr should include bucket name');
    assert.ok(stderrOutput.includes('Key not found') || stderrOutput.includes('path/to/model'),
        'stderr should indicate key not found or include key path');
});

await asyncTest('S3 access denied: AccessDenied returns null with URI, no credentials', async () => {
    const resolver = new S3Resolver();

    resolver._loadSdk = async () => {
        const err = new Error('Access Denied for AKIAIOSFODNN7EXAMPLE');
        err.name = 'AccessDenied';
        return {
            HeadObjectCommand: class { constructor() {} },
            ListObjectsV2Command: class { constructor() {} },
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); };

    const result = await resolver.fetchModelMetadata('s3://private-bucket/secret-model.tar.gz');

    process.stderr.write = origWrite;

    assert.strictEqual(result, null, 'should return null');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('Access denied'), 'stderr should indicate access denied');
    assert.ok(stderrOutput.includes('s3://private-bucket/secret-model.tar.gz'), 'stderr should include the S3 URI');
    assert.ok(!stderrOutput.includes('AKIAIOSFODNN7EXAMPLE'), 'stderr must NOT include access key');
});

console.log('\nmodel-picker: example-based unit tests — Credential handling\n');

test('Resolvers default to us-east-1 when AWS_REGION is unset', () => {
    const origRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;

    try {
        const jsPublic = new JumpStartPublicResolver();
        const jsPrivate = new JumpStartPrivateResolver();
        const mrResolver = new ModelRegistryResolver();
        const s3r = new S3Resolver();

        assert.strictEqual(jsPublic.region, 'us-east-1', 'JumpStartPublicResolver should default to us-east-1');
        assert.strictEqual(jsPrivate.region, 'us-east-1', 'JumpStartPrivateResolver should default to us-east-1');
        assert.strictEqual(mrResolver.region, 'us-east-1', 'ModelRegistryResolver should default to us-east-1');
        assert.strictEqual(s3r.region, 'us-east-1', 'S3Resolver should default to us-east-1');
    } finally {
        if (origRegion !== undefined) {
            process.env.AWS_REGION = origRegion;
        }
    }
});

test('Resolvers use AWS_REGION when set', () => {
    const origRegion = process.env.AWS_REGION;
    process.env.AWS_REGION = 'eu-west-1';

    try {
        const jsPublic = new JumpStartPublicResolver();
        const jsPrivate = new JumpStartPrivateResolver();
        const mrResolver = new ModelRegistryResolver();
        const s3r = new S3Resolver();

        assert.strictEqual(jsPublic.region, 'eu-west-1', 'JumpStartPublicResolver should use eu-west-1');
        assert.strictEqual(jsPrivate.region, 'eu-west-1', 'JumpStartPrivateResolver should use eu-west-1');
        assert.strictEqual(mrResolver.region, 'eu-west-1', 'ModelRegistryResolver should use eu-west-1');
        assert.strictEqual(s3r.region, 'eu-west-1', 'S3Resolver should use eu-west-1');
    } finally {
        if (origRegion !== undefined) {
            process.env.AWS_REGION = origRegion;
        } else {
            delete process.env.AWS_REGION;
        }
    }
});

console.log('\nmodel-picker: example-based unit tests — Manifest\n');

await asyncTest('manifest.json includes jumpstart-public catalog', async () => {
    const fs = await import('node:fs');
    const manifestPath = new URL('./manifest.json', import.meta.url).pathname;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    assert.ok(manifest.catalogs, 'manifest should have catalogs');
    assert.ok(manifest.catalogs['jumpstart-public'], 'manifest should include jumpstart-public catalog');
    assert.strictEqual(
        manifest.catalogs['jumpstart-public'],
        '../lib/catalogs/jumpstart-public.json',
        'jumpstart-public catalog path should be correct'
    );
    assert.ok(manifest.catalogs['models'], 'manifest should include models catalog');
    assert.strictEqual(
        manifest.catalogs['models'],
        '../lib/catalogs/models.json',
        'models catalog path should be correct'
    );
});

await asyncTest('manifest.json has correct mode declarations', async () => {
    const fs = await import('node:fs');
    const manifestPath = new URL('./manifest.json', import.meta.url).pathname;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    assert.ok(manifest.modes, 'manifest should have modes');
    assert.strictEqual(manifest.modes.static, true, 'static mode should be true');
    assert.strictEqual(manifest.modes.discover, true, 'discover mode should be true');
    assert.strictEqual(manifest.modes.smart, false, 'smart mode should be false');
});

console.log('\nmodel-picker: example-based unit tests — Resolver pattern matching\n');

test('JumpStartPublicResolver accepts jumpstart:// and rejects other prefixes', () => {
    const resolver = new JumpStartPublicResolver();
    const patterns = resolver.supportedPatterns();
    assert.ok(patterns.includes('jumpstart://*'), 'should support jumpstart://*');

    // Verify via registry routing
    const r = registry.getResolver('jumpstart://some-model');
    assert.ok(r instanceof JumpStartPublicResolver, 'jumpstart:// should route to JumpStartPublicResolver');

    const r2 = registry.getResolver('s3://some-bucket/model');
    assert.ok(!(r2 instanceof JumpStartPublicResolver), 's3:// should NOT route to JumpStartPublicResolver');
});

test('JumpStartPrivateResolver accepts jumpstart-hub:// and rejects other prefixes', () => {
    const resolver = new JumpStartPrivateResolver();
    const patterns = resolver.supportedPatterns();
    assert.ok(patterns.includes('jumpstart-hub://*'), 'should support jumpstart-hub://*');

    const r = registry.getResolver('jumpstart-hub://my-hub/model');
    assert.ok(r instanceof JumpStartPrivateResolver, 'jumpstart-hub:// should route to JumpStartPrivateResolver');

    const r2 = registry.getResolver('jumpstart://some-model');
    assert.ok(!(r2 instanceof JumpStartPrivateResolver), 'jumpstart:// should NOT route to JumpStartPrivateResolver');
});

test('ModelRegistryResolver accepts registry:// and rejects other prefixes', () => {
    const resolver = new ModelRegistryResolver();
    const patterns = resolver.supportedPatterns();
    assert.ok(patterns.includes('registry://*'), 'should support registry://*');

    const r = registry.getResolver('registry://my-group/1');
    assert.ok(r instanceof ModelRegistryResolver, 'registry:// should route to ModelRegistryResolver');

    const r2 = registry.getResolver('jumpstart://some-model');
    assert.ok(!(r2 instanceof ModelRegistryResolver), 'jumpstart:// should NOT route to ModelRegistryResolver');
});

test('S3Resolver accepts s3:// and rejects other prefixes', () => {
    const resolver = new S3Resolver();
    const patterns = resolver.supportedPatterns();
    assert.ok(patterns.includes('s3://*'), 'should support s3://*');

    const r = registry.getResolver('s3://my-bucket/model');
    assert.ok(r instanceof S3Resolver, 's3:// should route to S3Resolver');

    const r2 = registry.getResolver('registry://my-group');
    assert.ok(!(r2 instanceof S3Resolver), 'registry:// should NOT route to S3Resolver');
});

console.log('\nmodel-picker: example-based unit tests — ResolverRegistry routing\n');

test('ResolverRegistry routes jumpstart:// to JumpStartPublicResolver', () => {
    const r = registry.getResolver('jumpstart://huggingface-llm-falcon-7b');
    assert.ok(r instanceof JumpStartPublicResolver);
});

test('ResolverRegistry routes jumpstart-hub:// to JumpStartPrivateResolver', () => {
    const r = registry.getResolver('jumpstart-hub://my-hub/my-model');
    assert.ok(r instanceof JumpStartPrivateResolver);
});

test('ResolverRegistry routes registry:// to ModelRegistryResolver', () => {
    const r = registry.getResolver('registry://my-group/1');
    assert.ok(r instanceof ModelRegistryResolver);
});

test('ResolverRegistry routes s3:// to S3Resolver', () => {
    const r = registry.getResolver('s3://my-bucket/path/to/model');
    assert.ok(r instanceof S3Resolver);
});

test('ResolverRegistry routes org/model to HuggingFaceResolver', () => {
    const r = registry.getResolver('meta-llama/Llama-2-7b');
    assert.ok(r instanceof HuggingFaceResolver);
});

test('ResolverRegistry routes unknown IDs to StaticCatalogResolver (default)', () => {
    const r = registry.getResolver('some-random-string');
    assert.ok(r instanceof StaticCatalogResolver);
});

test('ResolverRegistry first-match wins: jumpstart-hub:// does not match jumpstart://', () => {
    const r = registry.getResolver('jumpstart-hub://hub/model');
    assert.ok(r instanceof JumpStartPrivateResolver, 'jumpstart-hub:// must route to Private, not Public');
    assert.ok(!(r instanceof JumpStartPublicResolver), 'must NOT route to JumpStartPublicResolver');
});

// ── Unit Tests — JumpStart S3-based resolver (Task 4) ─────────────────────────
// Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.3, 3.6

console.log('\nmodel-picker: unit tests — JumpStartPublicResolver S3-based retrieval\n');

// Task 4.1: _mapToMetadata with mock JumpStart model spec JSON
test('4.1: _mapToMetadata maps model spec fields to ModelMetadata shape', () => {
    const resolver = new JumpStartPublicResolver();
    const spec = {
        model_id: 'huggingface-reasoning-qwen3-8b',
        framework: 'huggingface',
        model_type: 'llm',
        inference_task: 'text-generation'
    };
    const result = resolver._mapToMetadata(spec, 'huggingface-reasoning-qwen3-8b');

    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.modelId, 'jumpstart://huggingface-reasoning-qwen3-8b');
    assert.strictEqual(result.description, 'Huggingface Reasoning Qwen3 8b');
    assert.strictEqual(result.framework, 'huggingface');
    assert.deepStrictEqual(result.tags, ['llm', 'text-generation']);
});

test('4.1: _mapToMetadata uses bareId when spec.model_id is absent', () => {
    const resolver = new JumpStartPublicResolver();
    const spec = { framework: 'pytorch' };
    const result = resolver._mapToMetadata(spec, 'my-custom-model');

    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.modelId, 'jumpstart://my-custom-model');
    assert.strictEqual(result.description, 'My Custom Model');
    assert.strictEqual(result.framework, 'pytorch');
    assert.strictEqual(result.tags, undefined);
});

test('4.1: _mapToMetadata returns null for null spec', () => {
    const resolver = new JumpStartPublicResolver();
    assert.strictEqual(resolver._mapToMetadata(null, 'test'), null);
});

test('4.1: _mapToMetadata omits tags when no task fields present', () => {
    const resolver = new JumpStartPublicResolver();
    const spec = { model_id: 'simple-model' };
    const result = resolver._mapToMetadata(spec, 'simple-model');

    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.modelId, 'jumpstart://simple-model');
    assert.strictEqual(result.tags, undefined);
});

// Task 4.2: fetchModelMetadata with mock S3 client returning valid model spec
await asyncTest('4.2: fetchModelMetadata returns correct metadata from S3 model spec', async () => {
    const manifestJson = [
        {
            model_id: 'huggingface-llm-mistral-7b-instruct',
            version: '1.0.0',
            spec_key: 'community_models/huggingface-llm-mistral-7b-instruct/specs_v1.0.0.json',
            deprecated: false,
            provider: 'mistralai'
        }
    ];
    const specJson = {
        model_id: 'huggingface-llm-mistral-7b-instruct',
        hosting_ecr_specs: { framework: 'huggingface' },
        default_inference_instance_type: 'ml.g5.2xlarge',
        supported_inference_instance_types: ['ml.g5.2xlarge', 'ml.g5.4xlarge'],
        search_keywords: ['Text Generation', 'LLM']
    };

    const resolver = new JumpStartPublicResolver({ region: 'us-west-2' });

    resolver._loadSdk = async () => ({
        GetObjectCommand: class {
            constructor(params) { this.params = params; }
        },
        S3Client: class {
            constructor() {}
            send(cmd) {
                // First call fetches manifest, second fetches spec
                if (cmd.params.Key === 'models_manifest.json') {
                    return { Body: { transformToString: () => JSON.stringify(manifestJson) } };
                }
                return { Body: { transformToString: () => JSON.stringify(specJson) } };
            }
            destroy() {}
        }
    });

    const result = await resolver.fetchModelMetadata('jumpstart://huggingface-llm-mistral-7b-instruct');

    assert.ok(result !== null, 'should return metadata');
    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.modelId, 'jumpstart://huggingface-llm-mistral-7b-instruct');
    assert.strictEqual(result.framework, 'huggingface');
    assert.strictEqual(result.description, 'Huggingface Llm Mistral 7b Instruct');
    assert.strictEqual(result.defaultInstanceType, 'ml.g5.2xlarge');
    assert.deepStrictEqual(result.tags, ['Text Generation', 'LLM']);
});

// Task 4.3: fetchModelMetadata with mock S3 client throwing NoSuchKey — fallback to static catalog
await asyncTest('4.3: fetchModelMetadata falls back to static catalog on NoSuchKey', async () => {
    const staticCatalog = {
        'jumpstart://huggingface-llm-falcon-7b': {
            provider: 'jumpstart',
            modelId: 'jumpstart://huggingface-llm-falcon-7b',
            description: 'Falcon 7B',
            framework: 'huggingface'
        }
    };

    const resolver = new JumpStartPublicResolver({ staticCatalog });

    resolver._loadSdk = async () => {
        const err = new Error('The specified key does not exist');
        err.name = 'NoSuchKey';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    // NoSuchKey on manifest fetch falls back to static catalog
    const result = await resolver.fetchModelMetadata('jumpstart://huggingface-llm-falcon-7b');
    assert.ok(result !== null, 'should fall back to static catalog');
    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.description, 'Falcon 7B');
});

await asyncTest('4.3: fetchModelMetadata returns null on NoSuchKey for unknown model', async () => {
    const resolver = new JumpStartPublicResolver();

    resolver._loadSdk = async () => {
        const err = new Error('The specified key does not exist');
        err.name = 'NoSuchKey';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://nonexistent-model');
    assert.strictEqual(result, null, 'should return null for unknown model on NoSuchKey');
});

// Task 4.4: fetchModelMetadata with mock S3 client throwing credential errors — fallback to static catalog
await asyncTest('4.4: fetchModelMetadata falls back to static catalog on CredentialsProviderError', async () => {
    const staticCatalog = {
        'jumpstart://huggingface-llm-falcon-7b': {
            provider: 'jumpstart',
            modelId: 'jumpstart://huggingface-llm-falcon-7b',
            description: 'Falcon 7B',
            framework: 'huggingface'
        }
    };

    const resolver = new JumpStartPublicResolver({ staticCatalog });

    resolver._loadSdk = async () => {
        const err = new Error('Could not load credentials');
        err.name = 'CredentialsProviderError';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://huggingface-llm-falcon-7b');
    assert.ok(result !== null, 'should fall back to static catalog');
    assert.strictEqual(result.provider, 'jumpstart');
    assert.strictEqual(result.description, 'Falcon 7B');
});

await asyncTest('4.4: fetchModelMetadata returns null on CredentialsError for model not in static catalog', async () => {
    const resolver = new JumpStartPublicResolver();

    resolver._loadSdk = async () => {
        const err = new Error('Missing credentials');
        err.name = 'CredentialsError';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://some-model-not-in-catalog');
    assert.strictEqual(result, null, 'should return null when model not in static catalog');
});

await asyncTest('4.4: fetchModelMetadata falls back on ExpiredTokenException', async () => {
    const staticCatalog = {
        'jumpstart://huggingface-llm-falcon-7b': {
            provider: 'jumpstart',
            modelId: 'jumpstart://huggingface-llm-falcon-7b',
            description: 'Falcon 7B',
            framework: 'huggingface'
        }
    };

    const resolver = new JumpStartPublicResolver({ staticCatalog });

    resolver._loadSdk = async () => {
        const err = new Error('Token expired');
        err.name = 'ExpiredTokenException';
        return {
            GetObjectCommand: class { constructor() {} },
            S3Client: class {
                constructor() {}
                send() { throw err; }
                destroy() {}
            }
        };
    };

    const result = await resolver.fetchModelMetadata('jumpstart://huggingface-llm-falcon-7b');
    assert.ok(result !== null, 'should fall back to static catalog on expired token');
    assert.strictEqual(result.provider, 'jumpstart');
});

// Task 4.5: _bucketName() returns correct bucket name
test('4.5: _bucketName returns jumpstart-cache-prod-{region} for configured region', () => {
    const resolver1 = new JumpStartPublicResolver({ region: 'us-east-1' });
    assert.strictEqual(resolver1._bucketName(), 'jumpstart-cache-prod-us-east-1');

    const resolver2 = new JumpStartPublicResolver({ region: 'eu-west-1' });
    assert.strictEqual(resolver2._bucketName(), 'jumpstart-cache-prod-eu-west-1');

    const resolver3 = new JumpStartPublicResolver({ region: 'ap-southeast-1' });
    assert.strictEqual(resolver3._bucketName(), 'jumpstart-cache-prod-ap-southeast-1');
});

test('4.5: _bucketName defaults to us-east-1 when no region specified', () => {
    const origRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    try {
        const resolver = new JumpStartPublicResolver();
        assert.strictEqual(resolver._bucketName(), 'jumpstart-cache-prod-us-east-1');
    } finally {
        if (origRegion !== undefined) {
            process.env.AWS_REGION = origRegion;
        }
    }
});

// ── PBT — JumpStart Model Discovery Fix ──────────────────────────────────────

console.log('\nmodel-picker: PBT — JumpStart Model Discovery Fix\n');

// Feature: jumpstart-model-discovery-fix, Property 1 — Bug Condition
// For any JumpStart model spec JSON object with optional fields, _mapToMetadata
// always returns provider = 'jumpstart', a non-empty modelId with jumpstart://
// prefix, and a non-empty description.
// **Validates: Requirements 2.1, 2.2**

test('Property 1 [Bug Condition]: _mapToMetadata always returns provider, prefixed modelId, and description for any spec', () => {
    const resolver = new JumpStartPublicResolver();

    // Generator for JumpStart model spec JSON objects
    const modelSpecArb = fc.record({
        model_id: fc.stringOf(
            fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },  // a-z
                { num: 10, build: v => String.fromCharCode(48 + v) },  // 0-9
                { num: 2, build: v => ['-', '_'][v] }
            ),
            { minLength: 1, maxLength: 80 }
        ),
        framework: fc.option(
            fc.oneof(
                fc.constant('huggingface'),
                fc.constant('pytorch'),
                fc.constant('tensorflow'),
                fc.constant('mxnet'),
                fc.constant('xgboost'),
                fc.string({ minLength: 1, maxLength: 30 })
            ),
            { nil: undefined }
        ),
        model_type: fc.option(
            fc.oneof(
                fc.constant('llm'),
                fc.constant('embedding'),
                fc.constant('vision'),
                fc.constant('tabular'),
                fc.string({ minLength: 1, maxLength: 30 })
            ),
            { nil: undefined }
        ),
        inference_task: fc.option(
            fc.oneof(
                fc.constant('text-generation'),
                fc.constant('text-classification'),
                fc.constant('image-classification'),
                fc.constant('object-detection'),
                fc.string({ minLength: 1, maxLength: 30 })
            ),
            { nil: undefined }
        )
    });

    fc.assert(
        fc.property(
            modelSpecArb,
            (spec) => {
                const bareId = spec.model_id;
                const result = resolver._mapToMetadata(spec, bareId);

                // Must not be null
                assert.ok(result !== null, 'result must not be null for valid spec');

                // provider must be 'jumpstart'
                assert.strictEqual(result.provider, 'jumpstart',
                    `provider must be 'jumpstart', got '${result.provider}'`);

                // modelId must start with 'jumpstart://' and be non-empty
                assert.strictEqual(typeof result.modelId, 'string', 'modelId must be a string');
                assert.ok(result.modelId.length > 0, 'modelId must not be empty');
                assert.ok(result.modelId.startsWith('jumpstart://'),
                    `modelId must start with 'jumpstart://', got '${result.modelId}'`);

                // The part after the prefix must be non-empty
                const afterPrefix = result.modelId.slice('jumpstart://'.length);
                assert.ok(afterPrefix.length > 0,
                    'modelId must have content after jumpstart:// prefix');

                // description must be a non-empty string
                assert.strictEqual(typeof result.description, 'string', 'description must be a string');
                assert.ok(result.description.length > 0, 'description must not be empty');

                // When framework is present in spec, it must appear in result
                if (spec.framework !== undefined) {
                    assert.strictEqual(result.framework, spec.framework,
                        'framework must be passed through from spec');
                }

                // When model_type or inference_task present, tags must exist
                if (spec.model_type !== undefined || spec.inference_task !== undefined) {
                    assert.ok(Array.isArray(result.tags), 'tags must be an array when task fields present');
                    assert.ok(result.tags.length > 0, 'tags must not be empty when task fields present');
                }
            }
        ),
        { numRuns: 200 }
    );
});

// Feature: jumpstart-model-discovery-fix, Property 2 — Preservation
// For any model ID with various prefixes, registry.getResolver() returns the
// same resolver class as before the fix (routing preservation).
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

test('Property 2 [Preservation]: resolver routing is preserved for all model ID prefixes', () => {
    const HF_PATTERN = /^[^/]+\/[^/]+$/;

    // Generator for model IDs with various prefixes
    const modelIdArb = fc.oneof(
        // s3:// prefix
        fc.tuple(
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 1, build: () => '-' }
            ), { minLength: 3, maxLength: 30 }),
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 3, build: v => ['/', '-', '.'][v] }
            ), { minLength: 1, maxLength: 50 })
        ).map(([bucket, key]) => `s3://${bucket}/${key}`),

        // registry:// prefix
        fc.stringOf(fc.mapToConstant(
            { num: 26, build: v => String.fromCharCode(97 + v) },
            { num: 10, build: v => String.fromCharCode(48 + v) },
            { num: 1, build: () => '-' }
        ), { minLength: 1, maxLength: 30 }).map(name => `registry://${name}`),

        // jumpstart-hub:// prefix
        fc.tuple(
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 1, build: () => '-' }
            ), { minLength: 1, maxLength: 20 }),
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 1, build: () => '-' }
            ), { minLength: 1, maxLength: 20 })
        ).map(([hub, model]) => `jumpstart-hub://${hub}/${model}`),

        // bare org/model (HuggingFace pattern)
        fc.tuple(
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 1, build: () => '-' }
            ), { minLength: 1, maxLength: 20 }),
            fc.stringOf(fc.mapToConstant(
                { num: 26, build: v => String.fromCharCode(97 + v) },
                { num: 10, build: v => String.fromCharCode(48 + v) },
                { num: 1, build: () => '-' }
            ), { minLength: 1, maxLength: 20 })
        ).map(([org, model]) => `${org}/${model}`),

        // random strings (should fall through to StaticCatalogResolver)
        fc.stringOf(fc.mapToConstant(
            { num: 26, build: v => String.fromCharCode(97 + v) },
            { num: 10, build: v => String.fromCharCode(48 + v) },
            { num: 2, build: v => ['-', '_'][v] }
        ), { minLength: 1, maxLength: 40 })
    );

    fc.assert(
        fc.property(
            modelIdArb,
            (modelId) => {
                const resolver = registry.getResolver(modelId);

                if (modelId.startsWith('s3://')) {
                    assert.ok(resolver instanceof S3Resolver,
                        `s3:// should route to S3Resolver, got ${resolver?.constructor?.name}`);
                } else if (modelId.startsWith('registry://')) {
                    assert.ok(resolver instanceof ModelRegistryResolver,
                        `registry:// should route to ModelRegistryResolver, got ${resolver?.constructor?.name}`);
                } else if (modelId.startsWith('jumpstart-hub://')) {
                    assert.ok(resolver instanceof JumpStartPrivateResolver,
                        `jumpstart-hub:// should route to JumpStartPrivateResolver, got ${resolver?.constructor?.name}`);
                } else if (modelId.startsWith('jumpstart://')) {
                    assert.ok(resolver instanceof JumpStartPublicResolver,
                        `jumpstart:// should route to JumpStartPublicResolver, got ${resolver?.constructor?.name}`);
                } else if (HF_PATTERN.test(modelId) && !modelId.includes('://')) {
                    assert.ok(resolver instanceof HuggingFaceResolver,
                        `org/model should route to HuggingFaceResolver, got ${resolver?.constructor?.name}`);
                } else {
                    assert.ok(resolver instanceof StaticCatalogResolver,
                        `fallback should route to StaticCatalogResolver, got ${resolver?.constructor?.name}`);
                }
            }
        ),
        { numRuns: 200 }
    );
});

// --- Unified catalog tests ---
console.log('\nmodel-picker: unified catalog (models.json)\n');

test('unified catalog contains transformer models', () => {
    const transformerModels = Object.entries(POPULAR_MODELS_CATALOG)
        .filter(([, entry]) => entry.modelType === 'transformer');
    assert.ok(transformerModels.length > 0, 'should have at least one transformer model');
});

test('unified catalog contains diffusor models', () => {
    const diffusorModels = Object.entries(POPULAR_MODELS_CATALOG)
        .filter(([, entry]) => entry.modelType === 'diffusor');
    assert.ok(diffusorModels.length > 0, 'should have at least one diffusor model');
});

test('unified catalog entries have modelType field', () => {
    const validTypes = ['transformer', 'diffusor', 'predictor'];
    for (const [modelId, entry] of Object.entries(POPULAR_MODELS_CATALOG)) {
        if (entry.modelType) {
            assert.ok(validTypes.includes(entry.modelType),
                `${modelId}: invalid modelType "${entry.modelType}"`);
        }
    }
});

test('unified catalog entries have tasks array', () => {
    for (const [modelId, entry] of Object.entries(POPULAR_MODELS_CATALOG)) {
        if (entry.tasks) {
            assert.ok(Array.isArray(entry.tasks), `${modelId}: tasks should be an array`);
            assert.ok(entry.tasks.length > 0, `${modelId}: tasks should be non-empty`);
        }
    }
});

test('transformer models can be filtered by modelType', () => {
    const transformers = Object.entries(POPULAR_MODELS_CATALOG)
        .filter(([, entry]) => entry.modelType === 'transformer')
        .map(([id]) => id);
    assert.ok(transformers.some(id => id.includes('Llama') || id.includes('llama')),
        'filtered transformers should include Llama models');
});

test('diffusor models can be filtered by modelType', () => {
    const diffusors = Object.entries(POPULAR_MODELS_CATALOG)
        .filter(([, entry]) => entry.modelType === 'diffusor')
        .map(([id]) => id);
    assert.ok(diffusors.some(id => id.includes('stable-diffusion') || id.includes('FLUX')),
        'filtered diffusors should include Stable Diffusion or FLUX models');
});

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
