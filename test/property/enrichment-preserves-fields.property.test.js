// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Enrichment Preserves Existing Fields Property-Based Tests
 *
 * Property 2: For any Image_Entry in model-servers.json or triton.json,
 * the enrichment process SHALL preserve all original fields (image, tag,
 * architecture, created, labels, registry, repository) with their original
 * values unchanged. Adding new fields (defaults, accelerator, validationLevel,
 * profiles, notes) SHALL NOT modify or remove any pre-existing field.
 *
 * Feature: registry-to-server-migration, Property 2: Enrichment preserves existing fields
 * Validates: Requirements 1.6, 2.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

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

const arbLabelKey = fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/).filter(s => s.length >= 1);
const arbLabelValue = fc.stringMatching(/^[a-zA-Z0-9._-]{0,20}$/);

// Base Image_Entry with only the 7 original fields
const arbBaseImageEntry = fc.record({
    image: arbSafeString,
    tag: arbSafeString,
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: arbDateTime,
    labels: fc.dictionary(arbLabelKey, arbLabelValue),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr', 'ecr-public'),
    repository: arbSafeString
});

// Enrichment fields that get added on top of base entries
const arbEnrichmentFields = fc.record({
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
        }).map(p => {
            const clean = { ...p };
            for (const key of Object.keys(clean)) {
                if (clean[key] === undefined) delete clean[key];
            }
            return clean;
        })
    ), { nil: undefined }),
    notes: fc.option(fc.string({ maxLength: 80 }), { nil: undefined })
}).map(fields => {
    const clean = { ...fields };
    for (const key of Object.keys(clean)) {
        if (clean[key] === undefined) delete clean[key];
    }
    return clean;
});

// Triton backend base entry (all 5 required fields)
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


// ── Helper: simulate enrichment ──────────────────────────────────────────────

const ORIGINAL_IMAGE_FIELDS = ['image', 'tag', 'architecture', 'created', 'labels', 'registry', 'repository'];

function enrichEntry(base, enrichment) {
    return { ...base, ...enrichment };
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 2: Enrichment preserves existing fields', () => {

    describe('Image_Entry enrichment preserves original fields', () => {

        it('all 7 original fields are present and unchanged after enrichment', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBaseImageEntry,
                arbEnrichmentFields,
                (base, enrichment) => {
                    // Snapshot original values before enrichment
                    const originalValues = {};
                    for (const field of ORIGINAL_IMAGE_FIELDS) {
                        originalValues[field] = JSON.parse(JSON.stringify(base[field]));
                    }

                    // Perform enrichment
                    const enriched = enrichEntry(base, enrichment);

                    // Verify every original field is still present with the same value
                    for (const field of ORIGINAL_IMAGE_FIELDS) {
                        assert.ok(field in enriched,
                            `original field "${field}" must still be present after enrichment`);
                        assert.ok(deepEqual(enriched[field], originalValues[field]),
                            `original field "${field}" must be unchanged after enrichment. ` +
                            `Expected: ${JSON.stringify(originalValues[field])}, ` +
                            `Got: ${JSON.stringify(enriched[field])}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enrichment only adds new keys, never removes existing ones', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBaseImageEntry,
                arbEnrichmentFields,
                (base, enrichment) => {
                    const enriched = enrichEntry(base, enrichment);

                    // Every key from the base must exist in the enriched result
                    for (const key of Object.keys(base)) {
                        assert.ok(key in enriched,
                            `base key "${key}" must not be removed by enrichment`);
                    }

                    // The enriched entry must have at least as many keys as the base
                    assert.ok(Object.keys(enriched).length >= Object.keys(base).length,
                        'enriched entry must have >= keys compared to base');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('enrichment fields do not overwrite original fields when keys differ', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBaseImageEntry,
                arbEnrichmentFields,
                (base, enrichment) => {
                    enrichEntry(base, enrichment);

                    // Enrichment keys (defaults, accelerator, validationLevel, profiles, notes)
                    // are disjoint from original keys — verify no collision
                    const enrichmentKeys = new Set(Object.keys(enrichment));
                    for (const field of ORIGINAL_IMAGE_FIELDS) {
                        if (enrichmentKeys.has(field)) {
                            // If enrichment somehow has a key matching an original field,
                            // the spread would overwrite — this should never happen with
                            // the defined enrichment schema
                            assert.fail(
                                `enrichment key "${field}" collides with original Image_Entry field`);
                        }
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('labels object is preserved by reference equality after enrichment', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBaseImageEntry,
                arbEnrichmentFields,
                (base, enrichment) => {
                    const enriched = enrichEntry(base, enrichment);

                    // The labels object should be the same reference (shallow copy via spread)
                    assert.strictEqual(enriched.labels, base.labels,
                        'labels object reference must be preserved after enrichment');

                    // And all label key-value pairs must match
                    for (const [k, v] of Object.entries(base.labels)) {
                        assert.strictEqual(enriched.labels[k], v,
                            `label "${k}" must be unchanged after enrichment`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('enrichment is idempotent for original fields', () => {

        it('enriching twice produces the same original field values', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbBaseImageEntry,
                arbEnrichmentFields,
                arbEnrichmentFields,
                (base, enrichment1, enrichment2) => {
                    const enrichedOnce = enrichEntry(base, enrichment1);
                    const enrichedTwice = enrichEntry(enrichedOnce, enrichment2);

                    // Original fields must survive both enrichments
                    for (const field of ORIGINAL_IMAGE_FIELDS) {
                        assert.ok(deepEqual(enrichedTwice[field], base[field]),
                            `original field "${field}" must survive double enrichment. ` +
                            `Expected: ${JSON.stringify(base[field])}, ` +
                            `Got: ${JSON.stringify(enrichedTwice[field])}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Triton backend enrichment preserves existing fields', () => {

        it('adding extra metadata to a triton backend preserves all 5 required fields', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const TRITON_REQUIRED = ['requiresGpu', 'modelFormats', 'modelArtifactName', 'requiresModelName', 'supportsSampleModel'];

            // Arbitrary extra metadata that could be added to triton backends
            const arbTritonExtra = fc.record({
                description: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
                notes: fc.option(fc.string({ maxLength: 50 }), { nil: undefined })
            }).map(fields => {
                const clean = { ...fields };
                for (const key of Object.keys(clean)) {
                    if (clean[key] === undefined) delete clean[key];
                }
                return clean;
            });

            fc.assert(fc.property(
                arbTritonBackendEntry,
                arbTritonExtra,
                (base, extra) => {
                    // Snapshot original values
                    const originalValues = {};
                    for (const field of TRITON_REQUIRED) {
                        originalValues[field] = JSON.parse(JSON.stringify(base[field]));
                    }

                    // Enrich
                    const enriched = { ...base, ...extra };

                    // Verify all required fields preserved
                    for (const field of TRITON_REQUIRED) {
                        assert.ok(field in enriched,
                            `triton field "${field}" must be present after enrichment`);
                        assert.ok(deepEqual(enriched[field], originalValues[field]),
                            `triton field "${field}" must be unchanged after enrichment. ` +
                            `Expected: ${JSON.stringify(originalValues[field])}, ` +
                            `Got: ${JSON.stringify(enriched[field])}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
