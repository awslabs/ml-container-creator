// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema Validation Property-Based Tests
 *
 * Property-based tests verifying that randomly generated conforming
 * catalog data passes JSON Schema validation without errors.
 *
 * Feature: mcp-server-externalization
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it, before } from 'mocha'
import assert from 'assert'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
=======
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
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}

// ── Schema loading ───────────────────────────────────────────────────────────

const schemasDir = resolve(__dirname, '../../servers/lib/schemas')

function loadSchema(name) {
    return JSON.parse(readFileSync(resolve(schemasDir, name), 'utf8'))
=======
};

// ── Schema loading ───────────────────────────────────────────────────────────

const schemasDir = resolve(__dirname, '../../servers/lib/schemas');

function loadSchema(name) {
    return JSON.parse(readFileSync(resolve(schemasDir, name), 'utf8'));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid ISO 8601 date-time string.
 */
const arbDateTime = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
).map(([y, m, d, h, min, s]) => {
<<<<<<< HEAD
    const pad = (n) => String(n).padStart(2, '0')
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`
})
=======
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a valid ImageEntry conforming to image-entry.schema.json.
 */
const arbImageEntry = fc.record({
<<<<<<< HEAD
    image: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._\-/]{0,49}$/).filter(s => s.length >= 1),
    tag: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._\-]{0,19}$/).filter(s => s.length >= 1),
=======
    image: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9./_-]{0,49}$/).filter(s => s.length >= 1),
    tag: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,19}$/).filter(s => s.length >= 1),
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: arbDateTime,
    labels: fc.dictionary(
        fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/).filter(s => s.length >= 1),
<<<<<<< HEAD
        fc.stringMatching(/^[a-zA-Z0-9._\-]{0,30}$/)
    ),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr', 'ecr-public'),
    repository: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._\-/]{0,49}$/).filter(s => s.length >= 1)
})
=======
        fc.stringMatching(/^[a-zA-Z0-9._-]{0,30}$/)
    ),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr', 'ecr-public'),
    repository: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9./_-]{0,49}$/).filter(s => s.length >= 1)
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a valid InstanceEntry conforming to the catalog entry in instances.schema.json.
 */
const arbInstanceEntry = fc.record({
    category: fc.constantFrom('cpu', 'gpu'),
    gpus: fc.nat({ max: 16 }),
    vcpus: fc.integer({ min: 1, max: 192 }),
    memGb: fc.double({ min: 0, max: 3072, noNaN: true, noDefaultInfinity: true }),
    accelerator: fc.stringMatching(/^[a-zA-Z0-9 ]*$/),
    cudaVersions: fc.oneof(
        fc.constant(null),
        fc.array(fc.stringMatching(/^\d+\.\d+$/), { minLength: 0, maxLength: 5 })
    ),
<<<<<<< HEAD
    tags: fc.array(fc.stringMatching(/^[a-z0-9\-]{1,20}$/), { minLength: 0, maxLength: 8 })
})
=======
    tags: fc.array(fc.stringMatching(/^[a-z0-9-]{1,20}$/), { minLength: 0, maxLength: 8 })
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a valid RegionEntry conforming to regions.schema.json.
 */
const arbRegionCode = fc.tuple(
    fc.stringMatching(/^[a-z]{2,4}$/),
    fc.stringMatching(/^[a-z]+$/).filter(s => s.length >= 1),
    fc.integer({ min: 1, max: 99 })
<<<<<<< HEAD
).map(([prefix, geo, num]) => `${prefix}-${geo}-${num}`)
=======
).map(([prefix, geo, num]) => `${prefix}-${geo}-${num}`);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const arbRegionEntry = fc.record({
    code: arbRegionCode,
    labels: fc.array(
        fc.stringMatching(/^[A-Za-z0-9 ().,-]{1,50}$/),
        { minLength: 1, maxLength: 10 }
    )
<<<<<<< HEAD
})
=======
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Schema Validation Property-Based Tests', () => {

<<<<<<< HEAD
    let ajv
    let validateImageCatalog
    let validateInstances
    let validateRegions

    before(() => {
        ajv = new Ajv({ allErrors: true, strict: false })
        addFormats(ajv)

        const imageCatalogSchema = loadSchema('image-catalog.schema.json')
        const instancesSchema = loadSchema('instances.schema.json')
        const regionsSchema = loadSchema('regions.schema.json')

        validateImageCatalog = ajv.compile(imageCatalogSchema)
        validateInstances = ajv.compile(instancesSchema)
        validateRegions = ajv.compile(regionsSchema)
    })
=======
    let ajv;
    let validateImageCatalog;
    let validateInstances;
    let validateRegions;

    before(() => {
        ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);

        const imageCatalogSchema = loadSchema('image-catalog.schema.json');
        const instancesSchema = loadSchema('instances.schema.json');
        const regionsSchema = loadSchema('regions.schema.json');

        validateImageCatalog = ajv.compile(imageCatalogSchema);
        validateInstances = ajv.compile(instancesSchema);
        validateRegions = ajv.compile(regionsSchema);
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 5: Schema validates conforming catalog data
    describe('Property 5: Schema validates conforming catalog data', () => {

        /**
         * Validates: Requirements 5.1, 5.2, 5.3, 5.4
         */

        it('any valid ImageEntry passes image-catalog schema validation (flat array)', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.array(arbImageEntry, { minLength: 1, maxLength: 10 }),
                (catalog) => {
<<<<<<< HEAD
                    const valid = validateImageCatalog(catalog)
                    assert.ok(
                        valid,
                        `flat array image catalog should validate but got errors: ${JSON.stringify(validateImageCatalog.errors)}`
                    )
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('any valid keyed image catalog passes image-catalog schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.dictionary(
                    fc.stringMatching(/^[a-z][a-z0-9\-]{0,19}$/).filter(s => s.length >= 1),
                    fc.array(arbImageEntry, { minLength: 1, maxLength: 5 })
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateImageCatalog(catalog)
                    assert.ok(
                        valid,
                        `keyed image catalog should validate but got errors: ${JSON.stringify(validateImageCatalog.errors)}`
                    )
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('any valid instances catalog passes instances schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    const valid = validateImageCatalog(catalog);
                    assert.ok(
                        valid,
                        `flat array image catalog should validate but got errors: ${JSON.stringify(validateImageCatalog.errors)}`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('any valid keyed image catalog passes image-catalog schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.dictionary(
                    fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).filter(s => s.length >= 1),
                    fc.array(arbImageEntry, { minLength: 1, maxLength: 5 })
                ).filter(d => Object.keys(d).length >= 1),
                (catalog) => {
                    const valid = validateImageCatalog(catalog);
                    assert.ok(
                        valid,
                        `keyed image catalog should validate but got errors: ${JSON.stringify(validateImageCatalog.errors)}`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('any valid instances catalog passes instances schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.record({
                    catalog: fc.dictionary(
                        fc.stringMatching(/^ml\.[a-z0-9]+\.[a-z0-9]+$/).filter(s => s.length >= 4),
                        arbInstanceEntry
                    ).filter(d => Object.keys(d).length >= 1),
                    recommendations: fc.record({
                        cpu: fc.array(fc.stringMatching(/^ml\.[a-z0-9]+\.[a-z0-9]+$/), { minLength: 0, maxLength: 5 }),
                        gpu: fc.array(fc.stringMatching(/^ml\.[a-z0-9]+\.[a-z0-9]+$/), { minLength: 0, maxLength: 5 })
                    })
                }),
                (catalog) => {
<<<<<<< HEAD
                    const valid = validateInstances(catalog)
                    assert.ok(
                        valid,
                        `instances catalog should validate but got errors: ${JSON.stringify(validateInstances.errors)}`
                    )
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('any valid regions catalog passes regions schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    const valid = validateInstances(catalog);
                    assert.ok(
                        valid,
                        `instances catalog should validate but got errors: ${JSON.stringify(validateInstances.errors)}`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('any valid regions catalog passes regions schema validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.array(arbRegionEntry, { minLength: 1, maxLength: 20 }),
                (catalog) => {
<<<<<<< HEAD
                    const valid = validateRegions(catalog)
                    assert.ok(
                        valid,
                        `regions catalog should validate but got errors: ${JSON.stringify(validateRegions.errors)}`
                    )
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
=======
                    const valid = validateRegions(catalog);
                    assert.ok(
                        valid,
                        `regions catalog should validate but got errors: ${JSON.stringify(validateRegions.errors)}`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 6: Schema rejects non-conforming catalog data with field-level errors
    describe('Property 6: Schema rejects non-conforming catalog data with field-level errors', () => {

        /**
         * Validates: Requirements 5.5
         */

        // ── Violation strategies ─────────────────────────────────────────

        /**
         * Pick a random required field to remove from an ImageEntry.
         */
<<<<<<< HEAD
        const IMAGE_ENTRY_REQUIRED = ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository']
=======
        const IMAGE_ENTRY_REQUIRED = ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository'];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        const arbImageEntryMissingField = fc.tuple(
            arbImageEntry,
            fc.constantFrom(...IMAGE_ENTRY_REQUIRED)
        ).map(([entry, field]) => {
<<<<<<< HEAD
            const copy = { ...entry }
            delete copy[field]
            return { data: copy, removedField: field }
        })
=======
            const copy = { ...entry };
            delete copy[field];
            return { data: copy, removedField: field };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Replace a field with a wrong type in an ImageEntry.
         * Strings become numbers, objects become strings, etc.
         */
        const arbImageEntryWrongType = fc.tuple(
            arbImageEntry,
            fc.constantFrom(
                { field: 'image', bad: 12345 },
                { field: 'tag', bad: false },
                { field: 'architecture', bad: 42 },
                { field: 'created', bad: [] },
                { field: 'labels', bad: 'not-an-object' },
                { field: 'registry', bad: 99 },
                { field: 'repository', bad: null }
            )
        ).map(([entry, { field, bad }]) => {
<<<<<<< HEAD
            const copy = { ...entry, [field]: bad }
            return { data: copy, violatedField: field }
        })
=======
            const copy = { ...entry, [field]: bad };
            return { data: copy, violatedField: field };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Set an enum field to an invalid value.
         */
        const arbImageEntryBadEnum = fc.tuple(
            arbImageEntry,
            fc.constantFrom(
                { field: 'architecture', bad: 'x86_64' },
                { field: 'architecture', bad: 'mips' },
                { field: 'registry', bad: 'github' },
                { field: 'registry', bad: 'quay' }
            )
        ).map(([entry, { field, bad }]) => {
<<<<<<< HEAD
            const copy = { ...entry, [field]: bad }
            return { data: copy, violatedField: field }
        })
=======
            const copy = { ...entry, [field]: bad };
            return { data: copy, violatedField: field };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * InstanceEntry with a missing required field.
         */
<<<<<<< HEAD
        const INSTANCE_ENTRY_REQUIRED = ['category', 'gpus', 'vcpus', 'memGb', 'accelerator', 'cudaVersions', 'tags']
=======
        const INSTANCE_ENTRY_REQUIRED = ['category', 'gpus', 'vcpus', 'memGb', 'accelerator', 'cudaVersions', 'tags'];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        const arbInstanceEntryMissingField = fc.tuple(
            arbInstanceEntry,
            fc.constantFrom(...INSTANCE_ENTRY_REQUIRED)
        ).map(([entry, field]) => {
<<<<<<< HEAD
            const copy = { ...entry }
            delete copy[field]
            return { data: copy, removedField: field }
        })
=======
            const copy = { ...entry };
            delete copy[field];
            return { data: copy, removedField: field };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * InstanceEntry with wrong types.
         */
        const arbInstanceEntryWrongType = fc.tuple(
            arbInstanceEntry,
            fc.constantFrom(
                { field: 'category', bad: 123 },
                { field: 'gpus', bad: 'many' },
                { field: 'vcpus', bad: false },
                { field: 'memGb', bad: 'lots' },
                { field: 'tags', bad: 'not-array' }
            )
        ).map(([entry, { field, bad }]) => {
<<<<<<< HEAD
            const copy = { ...entry, [field]: bad }
            return { data: copy, violatedField: field }
        })
=======
            const copy = { ...entry, [field]: bad };
            return { data: copy, violatedField: field };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * RegionEntry with violations.
         */
        const arbRegionEntryMissingField = fc.tuple(
            arbRegionEntry,
            fc.constantFrom('code', 'labels')
        ).map(([entry, field]) => {
<<<<<<< HEAD
            const copy = { ...entry }
            delete copy[field]
            return { data: copy, removedField: field }
        })

        const arbRegionEntryBadPattern = arbRegionEntry.map((entry) => {
            return { data: { ...entry, code: 'INVALID_CODE' }, violatedField: 'code' }
        })
=======
            const copy = { ...entry };
            delete copy[field];
            return { data: copy, removedField: field };
        });

        const arbRegionEntryBadPattern = arbRegionEntry.map((entry) => {
            return { data: { ...entry, code: 'INVALID_CODE' }, violatedField: 'code' };
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── ImageEntry rejection tests (via image-catalog schema) ─────────

        it('image catalog with missing required field in entry is rejected', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbImageEntryMissingField,
                ({ data, removedField }) => {
                    // Test as flat array
<<<<<<< HEAD
                    const valid = validateImageCatalog([data])
                    assert.strictEqual(valid, false, `Should reject image catalog with entry missing "${removedField}"`)
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('image catalog with wrong type in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    const valid = validateImageCatalog([data]);
                    assert.strictEqual(valid, false, `Should reject image catalog with entry missing "${removedField}"`);
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('image catalog with wrong type in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbImageEntryWrongType,
                ({ data, violatedField }) => {
<<<<<<< HEAD
                    const valid = validateImageCatalog([data])
                    assert.strictEqual(valid, false, `Should reject image catalog with wrong type for "${violatedField}"`)
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('image catalog with invalid enum value in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    const valid = validateImageCatalog([data]);
                    assert.strictEqual(valid, false, `Should reject image catalog with wrong type for "${violatedField}"`);
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('image catalog with invalid enum value in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbImageEntryBadEnum,
                ({ data, violatedField }) => {
<<<<<<< HEAD
                    const valid = validateImageCatalog([data])
                    assert.strictEqual(valid, false, `Should reject image catalog with invalid enum for "${violatedField}"`)
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('keyed image catalog with invalid entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.tuple(
                    fc.stringMatching(/^[a-z][a-z0-9\-]{0,9}$/).filter(s => s.length >= 1),
                    arbImageEntryMissingField
                ),
                ([serverName, { data, removedField }]) => {
                    const catalog = { [serverName]: [data] }
                    const valid = validateImageCatalog(catalog)
                    assert.strictEqual(valid, false, `Should reject keyed catalog with invalid entry missing "${removedField}"`)
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    const valid = validateImageCatalog([data]);
                    assert.strictEqual(valid, false, `Should reject image catalog with invalid enum for "${violatedField}"`);
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('keyed image catalog with invalid entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/).filter(s => s.length >= 1),
                    arbImageEntryMissingField
                ),
                ([serverName, { data, removedField }]) => {
                    const catalog = { [serverName]: [data] };
                    const valid = validateImageCatalog(catalog);
                    assert.strictEqual(valid, false, `Should reject keyed catalog with invalid entry missing "${removedField}"`);
                    assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── instances rejection tests ────────────────────────────────────

        it('instances catalog with missing required field in entry is rejected', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbInstanceEntryMissingField,
                ({ data, removedField }) => {
                    const catalog = {
                        catalog: { 'ml.m5.large': data },
                        recommendations: { cpu: [], gpu: [] }
<<<<<<< HEAD
                    }
                    const valid = validateInstances(catalog)
                    assert.strictEqual(valid, false, `Should reject instance entry missing "${removedField}"`)
                    const allErrors = validateInstances.errors
                    const hasFieldRef = allErrors.some(e =>
                        (e.params?.missingProperty === removedField) ||
                        e.instancePath.includes(removedField)
                    )
                    assert.ok(hasFieldRef, `Errors should reference "${removedField}" but got: ${JSON.stringify(allErrors)}`)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('instances catalog with wrong type in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    };
                    const valid = validateInstances(catalog);
                    assert.strictEqual(valid, false, `Should reject instance entry missing "${removedField}"`);
                    const allErrors = validateInstances.errors;
                    const hasFieldRef = allErrors.some(e =>
                        (e.params?.missingProperty === removedField) ||
                        e.instancePath.includes(removedField)
                    );
                    assert.ok(hasFieldRef, `Errors should reference "${removedField}" but got: ${JSON.stringify(allErrors)}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('instances catalog with wrong type in entry is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbInstanceEntryWrongType,
                ({ data, violatedField }) => {
                    const catalog = {
                        catalog: { 'ml.g5.xlarge': data },
                        recommendations: { cpu: [], gpu: [] }
<<<<<<< HEAD
                    }
                    const valid = validateInstances(catalog)
                    assert.strictEqual(valid, false, `Should reject instance entry with wrong type for "${violatedField}"`)
                    assert.ok(validateInstances.errors.length > 0, 'Should have validation errors')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('instances catalog missing top-level required field is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    };
                    const valid = validateInstances(catalog);
                    assert.strictEqual(valid, false, `Should reject instance entry with wrong type for "${violatedField}"`);
                    assert.ok(validateInstances.errors.length > 0, 'Should have validation errors');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('instances catalog missing top-level required field is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom('catalog', 'recommendations'),
                (field) => {
                    const catalog = {
                        catalog: { 'ml.m5.large': { category: 'cpu', gpus: 0, vcpus: 2, memGb: 8, accelerator: '', cudaVersions: null, tags: [] } },
                        recommendations: { cpu: [], gpu: [] }
<<<<<<< HEAD
                    }
                    delete catalog[field]
                    const valid = validateInstances(catalog)
                    assert.strictEqual(valid, false, `Should reject instances missing "${field}"`)
                    const hasFieldRef = validateInstances.errors.some(e =>
                        e.params?.missingProperty === field
                    )
                    assert.ok(hasFieldRef, `Errors should reference missing "${field}"`)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    };
                    delete catalog[field];
                    const valid = validateInstances(catalog);
                    assert.strictEqual(valid, false, `Should reject instances missing "${field}"`);
                    const hasFieldRef = validateInstances.errors.some(e =>
                        e.params?.missingProperty === field
                    );
                    assert.ok(hasFieldRef, `Errors should reference missing "${field}"`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── regions rejection tests ──────────────────────────────────────

        it('regions catalog with missing required field is rejected', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbRegionEntryMissingField,
                ({ data, removedField }) => {
<<<<<<< HEAD
                    const catalog = [data]
                    const valid = validateRegions(catalog)
                    assert.strictEqual(valid, false, `Should reject region entry missing "${removedField}"`)
                    const hasFieldRef = validateRegions.errors.some(e =>
                        (e.params?.missingProperty === removedField) ||
                        e.instancePath.includes(removedField)
                    )
                    assert.ok(hasFieldRef, `Errors should reference "${removedField}" but got: ${JSON.stringify(validateRegions.errors)}`)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('regions catalog with invalid code pattern is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                    const catalog = [data];
                    const valid = validateRegions(catalog);
                    assert.strictEqual(valid, false, `Should reject region entry missing "${removedField}"`);
                    const hasFieldRef = validateRegions.errors.some(e =>
                        (e.params?.missingProperty === removedField) ||
                        e.instancePath.includes(removedField)
                    );
                    assert.ok(hasFieldRef, `Errors should reference "${removedField}" but got: ${JSON.stringify(validateRegions.errors)}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('regions catalog with invalid code pattern is rejected', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbRegionEntryBadPattern,
                ({ data, violatedField }) => {
<<<<<<< HEAD
                    const catalog = [data]
                    const valid = validateRegions(catalog)
                    assert.strictEqual(valid, false, `Should reject region entry with invalid "${violatedField}"`)
                    const hasFieldRef = validateRegions.errors.some(e =>
                        e.instancePath.includes(violatedField)
                    )
                    assert.ok(hasFieldRef, `Errors should reference "${violatedField}" but got: ${JSON.stringify(validateRegions.errors)}`)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    const catalog = [data];
                    const valid = validateRegions(catalog);
                    assert.strictEqual(valid, false, `Should reject region entry with invalid "${violatedField}"`);
                    const hasFieldRef = validateRegions.errors.some(e =>
                        e.instancePath.includes(violatedField)
                    );
                    assert.ok(hasFieldRef, `Errors should reference "${violatedField}" but got: ${JSON.stringify(validateRegions.errors)}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── Empty / wrong top-level type tests ───────────────────────────

        it('empty object is rejected by image-catalog schema', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const valid = validateImageCatalog({})
            assert.strictEqual(valid, false, 'Empty object should fail image-catalog schema')
            assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
        })

        it('empty array is rejected by image-catalog schema', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const valid = validateImageCatalog([])
            assert.strictEqual(valid, false, 'Empty array should fail image-catalog schema')
            assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors')
        })

        it('empty array is rejected by regions schema', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const valid = validateRegions([])
            assert.strictEqual(valid, false, 'Empty array should fail regions schema')
            assert.ok(validateRegions.errors.length > 0, 'Should have validation errors')
        })
    })
})
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const valid = validateImageCatalog({});
            assert.strictEqual(valid, false, 'Empty object should fail image-catalog schema');
            assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
        });

        it('empty array is rejected by image-catalog schema', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const valid = validateImageCatalog([]);
            assert.strictEqual(valid, false, 'Empty array should fail image-catalog schema');
            assert.ok(validateImageCatalog.errors.length > 0, 'Should have validation errors');
        });

        it('empty array is rejected by regions schema', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const valid = validateRegions([]);
            assert.strictEqual(valid, false, 'Empty array should fail regions schema');
            assert.ok(validateRegions.errors.length > 0, 'Should have validation errors');
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
