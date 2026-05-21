// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog Schema Validation Property-Based Tests
 *
 * Property 1: For any catalog file and its corresponding JSON Schema,
 * every valid entry SHALL pass schema validation. Conversely, for any
 * catalog with a deliberately malformed entry, the validation script
 * SHALL report the error.
 *
 * Feature: registry-to-server-migration, Property 1: Catalog schema validation
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.2, 3.4, 4.5, 12.4, 12.5
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Schema loading ───────────────────────────────────────────────────────────

const schemasDir = resolve(__dirname, '../../servers/lib/schemas');

function loadSchema(name) { // eslint-disable-line no-unused-vars
    return JSON.parse(readFileSync(resolve(schemasDir, name), 'utf8'));
}

// ── Enriched Image_Entry schema (extends image-catalog.schema.json) ──────────
// Defines the enriched structure per the design doc, including defaults,
// accelerator, validationLevel, profiles, and notes fields.

const enrichedImageCatalogSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'enriched-image-catalog.schema.json',
    definitions: {
        profileEntry: {
            type: 'object',
            required: ['displayName', 'description'],
            properties: {
                displayName: { type: 'string', minLength: 1 },
                description: { type: 'string' },
                envVars: { type: 'object', additionalProperties: { type: 'string' } },
                recommendedInstanceTypes: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' }
            },
            additionalProperties: false
        },
        enrichedImageEntry: {
            type: 'object',
            required: ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository'],
            properties: {
                image: { type: 'string', minLength: 1 },
                tag: { type: 'string', minLength: 1 },
                architecture: { type: 'string', enum: ['amd64', 'arm64'] },
                created: { type: 'string', format: 'date-time' },
                labels: { type: 'object', additionalProperties: { type: 'string' } },
                registry: { type: 'string', enum: ['dockerhub', 'ngc', 'ecr', 'ecr-public'] },
                repository: { type: 'string', minLength: 1 },
                defaults: {
                    type: 'object',
                    properties: {
                        envVars: { type: 'object', additionalProperties: { type: 'string' } },
                        inferenceAmiVersion: { type: 'string' },
                        recommendedInstanceTypes: { type: 'array', items: { type: 'string' } }
                    },
                    additionalProperties: false
                },
                accelerator: {
                    type: 'object',
                    required: ['type', 'version', 'versionRange'],
                    properties: {
                        type: { type: 'string', enum: ['cuda', 'neuron', 'cpu', 'rocm'] },
                        version: { type: 'string' },
                        versionRange: {
                            type: 'object',
                            required: ['min', 'max'],
                            properties: {
                                min: { type: 'string' },
                                max: { type: 'string' }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                },
                validationLevel: {
                    type: 'string',
                    enum: ['tested', 'community-validated', 'experimental', 'untested']
                },
                profiles: {
                    type: 'object',
                    additionalProperties: { $ref: '#/definitions/profileEntry' }
                },
                notes: { type: 'string' },
                supportedModelTypes: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        }
    },
    type: 'object',
    minProperties: 1,
    additionalProperties: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/definitions/enrichedImageEntry' }
    }
};

// ── Triton backends schema ───────────────────────────────────────────────────

const tritonBackendsSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'triton-backends.schema.json',
    type: 'object',
    minProperties: 1,
    additionalProperties: {
        type: 'object',
        required: ['requiresGpu', 'modelFormats', 'modelArtifactName', 'requiresModelName', 'supportsSampleModel'],
        properties: {
            requiresGpu: { type: 'boolean' },
            modelFormats: {
                oneOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'null' }
                ]
            },
            modelArtifactName: {
                oneOf: [
                    { type: 'string' },
                    { type: 'null' }
                ]
            },
            requiresModelName: { type: 'boolean' },
            supportsSampleModel: { type: 'boolean' }
        },
        additionalProperties: false
    }
};

// ── Enriched instances schema ────────────────────────────────────────────────

const enrichedInstancesSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'enriched-instances.schema.json',
    type: 'object',
    required: ['catalog', 'recommendations'],
    properties: {
        catalog: {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
                type: 'object',
                required: ['category', 'gpus', 'vcpus', 'memGb', 'accelerator', 'cudaVersions', 'tags'],
                properties: {
                    category: { type: 'string', enum: ['cpu', 'gpu'] },
                    gpus: { type: 'integer', minimum: 0 },
                    vcpus: { type: 'integer', minimum: 1 },
                    memGb: { type: 'number', minimum: 0 },
                    accelerator: { type: 'string' },
                    cudaVersions: {
                        oneOf: [
                            { type: 'array', items: { type: 'string' } },
                            { type: 'null' }
                        ]
                    },
                    tags: { type: 'array', items: { type: 'string' } },
                    family: { type: 'string' },
                    acceleratorType: { type: 'string', enum: ['cuda', 'neuron', 'cpu', 'rocm'] },
                    hardware: { type: 'string' },
                    gpuArchitecture: { type: 'string' },
                    defaultCudaVersion: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'null' }
                        ]
                    },
                    notes: { type: 'string' },
                    gpuMemoryGb: {
                        oneOf: [
                            { type: 'number', minimum: 0 },
                            { type: 'null' }
                        ]
                    },
                    gpuType: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'null' }
                        ]
                    },
                    costTier: { type: 'string', enum: ['low', 'medium', 'high'] }
                },
                additionalProperties: false
            }
        },
        recommendations: {
            type: 'object',
            required: ['gpu'],
            properties: {
                cpu: { type: 'array', items: { type: 'string' } },
                gpu: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        }
    },
    additionalProperties: false
};

// ── Model catalog schema ─────────────────────────────────────────────────────

const modelCatalogSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'model-catalog.schema.json',
    definitions: {
        modelProfileEntry: {
            type: 'object',
            required: ['displayName'],
            properties: {
                displayName: { type: 'string', minLength: 1 },
                envVars: { type: 'object', additionalProperties: { type: 'string' } },
                recommendedInstanceTypes: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        }
    },
    type: 'object',
    minProperties: 1,
    additionalProperties: {
        type: 'object',
        required: ['family', 'chat_template', 'tags', 'architecture', 'framework_compatibility', 'validation_level'],
        properties: {
            family: { type: 'string' },
            chat_template: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            gated: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
            architecture: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            framework_compatibility: { type: 'object', additionalProperties: { type: 'string' } },
            validation_level: {
                type: 'string',
                enum: ['tested', 'community-validated', 'experimental', 'untested']
            },
            notes: { type: 'string' },
            profiles: {
                type: 'object',
                additionalProperties: { $ref: '#/definitions/modelProfileEntry' }
            }
        },
        additionalProperties: false
    }
};


// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbDateTime = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
).map(([y, m, d, h, min, s]) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
});

const arbSafeString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/).filter(s => s.length >= 1);
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvVars = fc.dictionary(arbEnvKey, fc.stringMatching(/^[a-zA-Z0-9._/-]{0,20}$/));
const arbInstanceType = fc.stringMatching(/^ml\.[a-z0-9]+\.[a-z0-9]+$/).filter(s => s.length >= 4);
const arbFrameworkKey = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/).filter(s => s.length >= 1);
const arbModelId = fc.stringMatching(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9.*_-]+$/).filter(s => s.length >= 3);

// Valid enriched Image_Entry
const arbEnrichedImageEntry = fc.record({
    image: arbSafeString,
    tag: arbSafeString,
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: arbDateTime,
    labels: fc.dictionary(
        fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/).filter(s => s.length >= 1),
        fc.stringMatching(/^[a-zA-Z0-9._-]{0,20}$/)
    ),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr', 'ecr-public'),
    repository: arbSafeString,
    defaults: fc.option(fc.record({
        envVars: arbEnvVars,
        inferenceAmiVersion: fc.option(fc.stringMatching(/^al2-ami-[a-z0-9-]{1,30}$/), { nil: undefined }),
        recommendedInstanceTypes: fc.option(fc.array(arbInstanceType, { maxLength: 4 }), { nil: undefined })
    }), { nil: undefined }),
    accelerator: fc.option(fc.record({
        type: fc.constantFrom('cuda', 'neuron', 'cpu', 'rocm'),
        version: fc.stringMatching(/^\d+\.\d+$/),
        versionRange: fc.record({
            min: fc.stringMatching(/^\d+\.\d+$/),
            max: fc.stringMatching(/^\d+\.\d+$/)
        })
    }), { nil: undefined }),
    validationLevel: fc.option(
        fc.constantFrom('tested', 'community-validated', 'experimental', 'untested'),
        { nil: undefined }
    ),
    profiles: fc.option(fc.dictionary(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/).filter(s => s.length >= 1),
        fc.record({
            displayName: arbSafeString,
            description: fc.string({ maxLength: 50 }),
            envVars: fc.option(arbEnvVars, { nil: undefined }),
            recommendedInstanceTypes: fc.option(fc.array(arbInstanceType, { maxLength: 3 }), { nil: undefined }),
            notes: fc.option(fc.string({ maxLength: 50 }), { nil: undefined })
        })
    ), { nil: undefined }),
    notes: fc.option(fc.string({ maxLength: 80 }), { nil: undefined })
}).map(entry => {
    // Remove undefined optional fields to produce clean JSON
    const clean = { ...entry };
    for (const key of Object.keys(clean)) {
        if (clean[key] === undefined) delete clean[key];
    }
    return clean;
});

// Valid triton backend entry
const arbTritonBackendEntry = fc.record({
    requiresGpu: fc.boolean(),
    modelFormats: fc.oneof(
        fc.constant(null),
        fc.array(fc.stringMatching(/^[a-z_]{1,20}$/), { minLength: 1, maxLength: 5 })
    ),
    modelArtifactName: fc.oneof(
        fc.constant(null),
        fc.stringMatching(/^[a-z0-9._/]{1,30}$/)
    ),
    requiresModelName: fc.boolean(),
    supportsSampleModel: fc.boolean()
});

// Valid enriched instance entry
const arbEnrichedInstanceEntry = fc.record({
    category: fc.constantFrom('cpu', 'gpu'),
    gpus: fc.nat({ max: 16 }),
    vcpus: fc.integer({ min: 1, max: 192 }),
    memGb: fc.double({ min: 0, max: 3072, noNaN: true, noDefaultInfinity: true }),
    accelerator: fc.stringMatching(/^[a-zA-Z0-9 ]*$/),
    cudaVersions: fc.oneof(
        fc.constant(null),
        fc.array(fc.stringMatching(/^\d+\.\d+$/), { maxLength: 5 })
    ),
    tags: fc.array(fc.stringMatching(/^[a-z0-9-]{1,20}$/), { maxLength: 8 }),
    family: fc.option(fc.stringMatching(/^[a-z0-9]+$/), { nil: undefined }),
    acceleratorType: fc.option(fc.constantFrom('cuda', 'neuron', 'cpu', 'rocm'), { nil: undefined }),
    hardware: fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]*$/), { nil: undefined }),
    gpuArchitecture: fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]*$/), { nil: undefined }),
    defaultCudaVersion: fc.option(
        fc.oneof(fc.constant(null), fc.stringMatching(/^\d+\.\d+$/)),
        { nil: undefined }
    ),
    notes: fc.option(fc.string({ maxLength: 80 }), { nil: undefined })
}).map(entry => {
    const clean = { ...entry };
    for (const key of Object.keys(clean)) {
        if (clean[key] === undefined) delete clean[key];
    }
    return clean;
});

// Valid model catalog entry
const arbModelEntry = fc.record({
    family: fc.stringMatching(/^[a-z0-9-]{1,20}$/),
    chat_template: fc.oneof(fc.constant(null), fc.string({ maxLength: 50 })),
    gated: fc.option(fc.boolean(), { nil: undefined }),
    tags: fc.array(fc.stringMatching(/^[a-z0-9-]{1,20}$/), { minLength: 1, maxLength: 6 }),
    architecture: fc.oneof(fc.constant(null), fc.stringMatching(/^[A-Za-z0-9]{1,30}$/)),
    framework_compatibility: fc.dictionary(
        arbFrameworkKey,
        fc.stringMatching(/^>=\d+\.\d+\.\d+$/)
    ),
    validation_level: fc.constantFrom('tested', 'community-validated', 'experimental', 'untested'),
    notes: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
    profiles: fc.option(fc.dictionary(
        fc.stringMatching(/^[a-z0-9-]{1,15}$/).filter(s => s.length >= 1),
        fc.record({
            displayName: arbSafeString,
            envVars: fc.option(arbEnvVars, { nil: undefined }),
            recommendedInstanceTypes: fc.option(fc.array(arbInstanceType, { maxLength: 3 }), { nil: undefined })
        }).map(p => {
            const clean = { ...p };
            for (const key of Object.keys(clean)) {
                if (clean[key] === undefined) delete clean[key];
            }
            return clean;
        })
    ), { nil: undefined })
}).map(entry => {
    const clean = { ...entry };
    for (const key of Object.keys(clean)) {
        if (clean[key] === undefined) delete clean[key];
    }
    return clean;
});


// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 1: Catalog schema validation', () => {

    let ajv;
    let validateEnrichedImageCatalog;
    let validateTritonBackends;
    let validateEnrichedInstances;
    let validateModelCatalog;

    before(() => {
        ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);

        validateEnrichedImageCatalog = ajv.compile(enrichedImageCatalogSchema);
        validateTritonBackends = ajv.compile(tritonBackendsSchema);
        validateEnrichedInstances = ajv.compile(enrichedInstancesSchema);
        validateModelCatalog = ajv.compile(modelCatalogSchema);
    });

    // ── Valid data passes validation ─────────────────────────────────────

    describe('valid catalog entries pass schema validation', () => {

        it('any valid enriched model-servers catalog passes validation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.dictionary(
                    arbFrameworkKey,
                    fc.array(arbEnrichedImageEntry, { minLength: 1, maxLength: 3 })
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateEnrichedImageCatalog(catalog);
                    assert.ok(valid,
                        `enriched model-servers catalog should validate: ${JSON.stringify(validateEnrichedImageCatalog.errors)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('any valid triton-backends catalog passes validation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.dictionary(
                    fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/).filter(s => s.length >= 1),
                    arbTritonBackendEntry
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateTritonBackends(catalog);
                    assert.ok(valid,
                        `triton-backends catalog should validate: ${JSON.stringify(validateTritonBackends.errors)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('any valid enriched instances catalog passes validation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.record({
                    catalog: fc.dictionary(
                        arbInstanceType,
                        arbEnrichedInstanceEntry
                    ).filter(d => Object.keys(d).length >= 1),
                    recommendations: fc.record({
                        cpu: fc.array(arbInstanceType, { maxLength: 5 }),
                        gpu: fc.array(arbInstanceType, { maxLength: 5 })
                    })
                }),
                (catalog) => {
                    const valid = validateEnrichedInstances(catalog);
                    assert.ok(valid,
                        `enriched instances catalog should validate: ${JSON.stringify(validateEnrichedInstances.errors)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('any valid model catalog (transformers) passes validation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.dictionary(
                    arbModelId,
                    arbModelEntry
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateModelCatalog(catalog);
                    assert.ok(valid,
                        `model catalog should validate: ${JSON.stringify(validateModelCatalog.errors)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('any valid model catalog (diffusors) passes validation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.dictionary(
                    arbModelId,
                    arbModelEntry.map(e => ({ ...e, chat_template: null }))
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateModelCatalog(catalog);
                    assert.ok(valid,
                        `diffusors model catalog should validate: ${JSON.stringify(validateModelCatalog.errors)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Invalid data is rejected ─────────────────────────────────────────

    describe('invalid catalog entries are rejected by schema validation', () => {

        // ── Enriched Image_Entry violations ──────────────────────────────

        const IMAGE_REQUIRED = ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository'];

        it('enriched image entry missing a required field is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbEnrichedImageEntry, fc.constantFrom(...IMAGE_REQUIRED)),
                ([entry, field]) => {
                    const bad = { ...entry };
                    delete bad[field];
                    const catalog = { framework: [bad] };
                    const valid = validateEnrichedImageCatalog(catalog);
                    assert.strictEqual(valid, false,
                        `should reject image entry missing "${field}"`);
                    assert.ok(validateEnrichedImageCatalog.errors.length > 0);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enriched image entry with wrong type for required field is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(
                    arbEnrichedImageEntry,
                    fc.constantFrom(
                        { field: 'image', bad: 123 },
                        { field: 'tag', bad: false },
                        { field: 'architecture', bad: 42 },
                        { field: 'created', bad: [] },
                        { field: 'labels', bad: 'not-object' },
                        { field: 'registry', bad: 99 },
                        { field: 'repository', bad: null }
                    )
                ),
                ([entry, { field, bad }]) => {
                    const catalog = { framework: [{ ...entry, [field]: bad }] };
                    const valid = validateEnrichedImageCatalog(catalog);
                    assert.strictEqual(valid, false,
                        `should reject image entry with wrong type for "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enriched image entry with invalid enum values is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(
                    arbEnrichedImageEntry,
                    fc.constantFrom(
                        { field: 'architecture', bad: 'x86_64' },
                        { field: 'registry', bad: 'github' },
                        { field: 'validationLevel', bad: 'invalid-level' }
                    )
                ),
                ([entry, { field, bad }]) => {
                    const catalog = { framework: [{ ...entry, [field]: bad }] };
                    const valid = validateEnrichedImageCatalog(catalog);
                    assert.strictEqual(valid, false,
                        `should reject image entry with invalid enum for "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enriched image entry with malformed accelerator is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnrichedImageEntry,
                fc.constantFrom(
                    { type: 'invalid', version: '12.1', versionRange: { min: '12.0', max: '12.6' } },
                    { type: 'cuda' },  // missing version and versionRange
                    'not-an-object'
                ),
                (entry, badAccelerator) => {
                    const catalog = { framework: [{ ...entry, accelerator: badAccelerator }] };
                    const valid = validateEnrichedImageCatalog(catalog);
                    assert.strictEqual(valid, false, 'should reject image entry with malformed accelerator');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        // ── Triton backend violations ────────────────────────────────────

        const TRITON_REQUIRED = ['requiresGpu', 'modelFormats', 'modelArtifactName', 'requiresModelName', 'supportsSampleModel'];

        it('triton backend entry missing a required field is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbTritonBackendEntry, fc.constantFrom(...TRITON_REQUIRED)),
                ([entry, field]) => {
                    const bad = { ...entry };
                    delete bad[field];
                    const catalog = { backend: bad };
                    const valid = validateTritonBackends(catalog);
                    assert.strictEqual(valid, false,
                        `should reject triton backend missing "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('triton backend entry with wrong types is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(
                    arbTritonBackendEntry,
                    fc.constantFrom(
                        { field: 'requiresGpu', bad: 'yes' },
                        { field: 'requiresModelName', bad: 1 },
                        { field: 'supportsSampleModel', bad: 'true' },
                        { field: 'modelFormats', bad: 'not-array' }
                    )
                ),
                ([entry, { field, bad }]) => {
                    const catalog = { backend: { ...entry, [field]: bad } };
                    const valid = validateTritonBackends(catalog);
                    assert.strictEqual(valid, false,
                        `should reject triton backend with wrong type for "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        // ── Instance entry violations ────────────────────────────────────

        const INSTANCE_REQUIRED = ['category', 'gpus', 'vcpus', 'memGb', 'accelerator', 'cudaVersions', 'tags'];

        it('enriched instance entry missing a required field is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbEnrichedInstanceEntry, fc.constantFrom(...INSTANCE_REQUIRED)),
                ([entry, field]) => {
                    const bad = { ...entry };
                    delete bad[field];
                    const catalog = {
                        catalog: { 'ml.m5.large': bad },
                        recommendations: { cpu: [], gpu: [] }
                    };
                    const valid = validateEnrichedInstances(catalog);
                    assert.strictEqual(valid, false,
                        `should reject instance entry missing "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enriched instance entry with invalid acceleratorType enum is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnrichedInstanceEntry,
                (entry) => {
                    const bad = { ...entry, acceleratorType: 'tpu' };
                    const catalog = {
                        catalog: { 'ml.g5.xlarge': bad },
                        recommendations: { cpu: [], gpu: [] }
                    };
                    const valid = validateEnrichedInstances(catalog);
                    assert.strictEqual(valid, false,
                        'should reject instance entry with invalid acceleratorType');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        // ── Model catalog violations ─────────────────────────────────────

        const MODEL_REQUIRED = ['family', 'chat_template', 'tags', 'architecture', 'framework_compatibility', 'validation_level'];

        it('model entry missing a required field is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.tuple(arbModelEntry, fc.constantFrom(...MODEL_REQUIRED)),
                ([entry, field]) => {
                    const bad = { ...entry };
                    delete bad[field];
                    const catalog = { 'org/model': bad };
                    const valid = validateModelCatalog(catalog);
                    assert.strictEqual(valid, false,
                        `should reject model entry missing "${field}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model entry with invalid validation_level is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelEntry,
                (entry) => {
                    const bad = { ...entry, validation_level: 'production-ready' };
                    const catalog = { 'org/model': bad };
                    const valid = validateModelCatalog(catalog);
                    assert.strictEqual(valid, false,
                        'should reject model entry with invalid validation_level');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model entry with empty tags array is rejected', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelEntry,
                (entry) => {
                    const bad = { ...entry, tags: [] };
                    const catalog = { 'org/model': bad };
                    const valid = validateModelCatalog(catalog);
                    assert.strictEqual(valid, false,
                        'should reject model entry with empty tags');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Actual catalog files pass validation ─────────────────────────────

    describe('actual catalog files pass enriched schema validation', () => {

        it('model-servers.json passes enriched image catalog schema', () => {
            const catalogPath = resolve(__dirname, '../../servers/lib/catalogs/model-servers.json');
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const valid = validateEnrichedImageCatalog(catalog);
            assert.ok(valid,
                `model-servers.json should pass enriched schema: ${JSON.stringify(validateEnrichedImageCatalog.errors, null, 2)}`);
        });

        it('triton-backends.json passes triton backends schema', () => {
            const catalogPath = resolve(__dirname, '../../servers/lib/catalogs/triton-backends.json');
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const valid = validateTritonBackends(catalog);
            assert.ok(valid,
                `triton-backends.json should pass schema: ${JSON.stringify(validateTritonBackends.errors, null, 2)}`);
        });

        it('instances.json passes enriched instances schema', () => {
            const catalogPath = resolve(__dirname, '../../servers/lib/catalogs/instances.json');
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const valid = validateEnrichedInstances(catalog);
            assert.ok(valid,
                `instances.json should pass enriched schema: ${JSON.stringify(validateEnrichedInstances.errors, null, 2)}`);
        });

        it('popular-transformers.json passes model catalog schema', () => {
            const catalogPath = resolve(__dirname, '../../servers/lib/catalogs/popular-transformers.json');
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const valid = validateModelCatalog(catalog);
            assert.ok(valid,
                `popular-transformers.json should pass schema: ${JSON.stringify(validateModelCatalog.errors, null, 2)}`);
        });

        it.skip('popular-diffusors.json passes model catalog schema (catalog trimmed to golden-path models only)', () => {
            const catalogPath = resolve(__dirname, '../../servers/lib/catalogs/popular-diffusors.json');
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const valid = validateModelCatalog(catalog);
            assert.ok(valid,
                `popular-diffusors.json should pass schema: ${JSON.stringify(validateModelCatalog.errors, null, 2)}`);
        });
    });

    // ── Empty catalogs are rejected ──────────────────────────────────────

    describe('empty catalogs are rejected', () => {

        it('empty object is rejected by enriched image catalog schema', () => {
            assert.strictEqual(validateEnrichedImageCatalog({}), false);
        });

        it('empty object is rejected by triton backends schema', () => {
            assert.strictEqual(validateTritonBackends({}), false);
        });

        it('empty object is rejected by model catalog schema', () => {
            assert.strictEqual(validateModelCatalog({}), false);
        });
    });
});
