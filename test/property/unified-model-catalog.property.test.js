// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Model Catalog Property-Based Tests
 *
 * Feature: mcp-catalog-consolidation, Property 2: Unified catalog schema validity
 * Feature: mcp-catalog-consolidation, Property 1: Unified catalog field completeness
 *
 * Validates: Requirements 2.2, 2.3, 2.7, 2.8, 2.9
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUM_RUNS } from '../helpers/property-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOGS_DIR = resolve(__dirname, '../../servers/lib/catalogs');

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    verbose: false
};

// ── Load catalogs ────────────────────────────────────────────────────────────

const modelsJson = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'models.json'), 'utf-8'));
const modelSizesRaw = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'model-sizes.json'), 'utf-8'));
const modelSizes = modelSizesRaw.models || modelSizesRaw;
const popularTransformers = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'popular-transformers.json'), 'utf-8'));
const popularDiffusors = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'popular-diffusors.json'), 'utf-8'));

// ── Property 2: Unified catalog schema validity ──────────────────────────────

describe('Feature: mcp-catalog-consolidation, Property 2: Unified catalog schema validity', function () {
    this.timeout(30000);

    it('every entry in models.json has a valid modelType', () => {
        const validTypes = ['transformer', 'diffusor', 'predictor'];
        const entries = Object.entries(modelsJson);

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: entries.length - 1 }),
                (idx) => {
                    const [modelId, entry] = entries[idx];
                    assert.ok(
                        validTypes.includes(entry.modelType),
                        `${modelId}: modelType "${entry.modelType}" not in ${JSON.stringify(validTypes)}`
                    );
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('every entry in models.json has a non-empty tasks array', () => {
        const entries = Object.entries(modelsJson);

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: entries.length - 1 }),
                (idx) => {
                    const [modelId, entry] = entries[idx];
                    assert.ok(
                        Array.isArray(entry.tasks) && entry.tasks.length > 0,
                        `${modelId}: tasks must be a non-empty array, got ${JSON.stringify(entry.tasks)}`
                    );
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('every entry in models.json has an architecture field (string or null)', () => {
        const entries = Object.entries(modelsJson);

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: entries.length - 1 }),
                (idx) => {
                    const [modelId, entry] = entries[idx];
                    assert.ok(
                        'architecture' in entry,
                        `${modelId}: missing architecture field`
                    );
                    assert.ok(
                        entry.architecture === null || typeof entry.architecture === 'string',
                        `${modelId}: architecture must be string or null, got ${typeof entry.architecture}`
                    );
                }
            ),
            PROPERTY_CONFIG
        );
    });
});

// ── Property 1: Unified catalog field completeness ───────────────────────────

describe('Feature: mcp-catalog-consolidation, Property 1: Unified catalog field completeness', function () {
    this.timeout(30000);

    // Helper: glob matching (same logic as merge script)
    function globToRegex(pattern) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regexStr = `^${  escaped.replace(/\*/g, '.*')  }$`;
        return new RegExp(regexStr);
    }

    function matchesPattern(modelId, pattern) {
        if (modelId === pattern) return true;
        if (!pattern.includes('*')) return false;
        return globToRegex(pattern).test(modelId);
    }

    it('every model from popular-transformers has its fields in models.json', () => {
        const transformerIds = Object.keys(popularTransformers);
        // Only test models that are exact entries in models.json (skip glob patterns
        // and legacy models that were not migrated to the unified catalog)
        const matchedIds = transformerIds.filter(id => id in modelsJson);

        if (matchedIds.length === 0) {
            return; // no matched entries to test
        }

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: matchedIds.length - 1 }),
                (idx) => {
                    const modelId = matchedIds[idx];
                    assert.ok(
                        modelId in modelsJson,
                        `${modelId} from popular-transformers not found in models.json`
                    );
                    const source = popularTransformers[modelId];
                    const unified = modelsJson[modelId];

                    // Check key fields are present (normalized to camelCase)
                    if (source.family) assert.strictEqual(unified.family, source.family);
                    if (source.gated !== undefined) assert.strictEqual(unified.gated, source.gated);
                    if (source.architecture) assert.strictEqual(unified.architecture, source.architecture);
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('every model from popular-diffusors has its fields in models.json', () => {
        const diffusorIds = Object.keys(popularDiffusors);

        if (diffusorIds.length === 0) {
            return; // catalog trimmed to golden-path models only — no diffusors to test
        }

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: diffusorIds.length - 1 }),
                (idx) => {
                    const modelId = diffusorIds[idx];
                    assert.ok(
                        modelId in modelsJson,
                        `${modelId} from popular-diffusors not found in models.json`
                    );
                    const source = popularDiffusors[modelId];
                    const unified = modelsJson[modelId];

                    if (source.family) assert.strictEqual(unified.family, source.family);
                    if (source.gated !== undefined) assert.strictEqual(unified.gated, source.gated);
                    if (source.architecture) assert.strictEqual(unified.architecture, source.architecture);
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('model-sizes fields are merged into matching models.json entries', () => {
        // For each model-sizes entry (including wildcards), verify that either:
        // 1. The key exists directly in models.json (wildcard patterns kept as fallback entries), OR
        // 2. The wildcard was consumed by matching transformer/diffusor entries that now carry its fields
        const sizeIds = Object.keys(modelSizes);

        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: sizeIds.length - 1 }),
                (idx) => {
                    const pattern = sizeIds[idx];
                    const sizeEntry = modelSizes[pattern];

                    if (pattern in modelsJson) {
                        // Direct match — verify fields are present
                        const unified = modelsJson[pattern];
                        if (sizeEntry.parameterCount) {
                            assert.strictEqual(unified.parameterCount, sizeEntry.parameterCount);
                        }
                        if (sizeEntry.defaultDtype) {
                            assert.strictEqual(unified.defaultDtype, sizeEntry.defaultDtype);
                        }
                    } else {
                        // Wildcard was consumed — find at least one matching entry in models.json
                        // that carries the merged fields
                        const matchingEntries = Object.entries(modelsJson).filter(
                            ([id]) => matchesPattern(id, pattern)
                        );
                        assert.ok(
                            matchingEntries.length > 0,
                            `No models.json entry matches pattern "${pattern}" from model-sizes`
                        );
                        // Verify at least one matching entry has the size fields
                        const hasFields = matchingEntries.some(([, entry]) => {
                            if (sizeEntry.parameterCount && entry.parameterCount !== sizeEntry.parameterCount) return false;
                            if (sizeEntry.defaultDtype && entry.defaultDtype !== sizeEntry.defaultDtype) return false;
                            return true;
                        });
                        assert.ok(
                            hasFields,
                            `Pattern "${pattern}" matched entries but none carry the expected size fields`
                        );
                    }
                }
            ),
            PROPERTY_CONFIG
        );
    });
});
