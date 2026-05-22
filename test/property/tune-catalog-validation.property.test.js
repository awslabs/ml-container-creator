// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Catalog Validation Property-Based Tests
 *
 * Property 5: Catalog schema validity
 *
 * For any entry in the Supported_Model_Catalog, it SHALL have:
 * a non-empty jumpStartModelId, a non-empty techniques object where
 * each technique key is one of [sft, dpo, rlaif, rlvr], each technique
 * has a non-empty trainingTypes array containing only [lora, full-rank],
 * and each technique has a non-empty datasetFormat string with a
 * corresponding datasetSchema.
 *
 * Feature: managed-model-customization, Property 5: Catalog schema validity
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Catalog loading ──────────────────────────────────────────────────────────

const catalogPath = resolve(__dirname, '../../config/tune-catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const VALID_TECHNIQUES = ['sft', 'dpo', 'rlaif', 'rlvr'];
const VALID_TRAINING_TYPES = ['lora', 'full-rank'];

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 5: Catalog schema validity', () => {

    let modelKeys;

    before(() => {
        modelKeys = Object.keys(catalog.models);
    });

    it('every catalog entry has a non-empty jumpStartModelId', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                assert.ok(entry.jumpStartModelId,
                    `Model "${modelKey}" must have a non-empty jumpStartModelId`);
                assert.strictEqual(typeof entry.jumpStartModelId, 'string',
                    `Model "${modelKey}" jumpStartModelId must be a string`);
                assert.ok(entry.jumpStartModelId.length > 0,
                    `Model "${modelKey}" jumpStartModelId must not be empty`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every technique key is one of sft|dpo|rlaif|rlvr', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                const techniques = Object.keys(entry.techniques);
                assert.ok(techniques.length > 0,
                    `Model "${modelKey}" must have at least one technique`);
                for (const technique of techniques) {
                    assert.ok(VALID_TECHNIQUES.includes(technique),
                        `Model "${modelKey}" has invalid technique "${technique}". Must be one of: ${VALID_TECHNIQUES.join(', ')}`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every technique has a non-empty trainingTypes array containing only lora|full-rank', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                for (const [technique, config] of Object.entries(entry.techniques)) {
                    assert.ok(Array.isArray(config.trainingTypes),
                        `Model "${modelKey}" technique "${technique}" trainingTypes must be an array`);
                    assert.ok(config.trainingTypes.length > 0,
                        `Model "${modelKey}" technique "${technique}" trainingTypes must not be empty`);
                    for (const tt of config.trainingTypes) {
                        assert.ok(VALID_TRAINING_TYPES.includes(tt),
                            `Model "${modelKey}" technique "${technique}" has invalid trainingType "${tt}". Must be one of: ${VALID_TRAINING_TYPES.join(', ')}`);
                    }
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every technique has a non-empty datasetFormat string with a corresponding datasetSchema', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                for (const [technique, config] of Object.entries(entry.techniques)) {
                    // datasetFormat must be a non-empty string
                    assert.strictEqual(typeof config.datasetFormat, 'string',
                        `Model "${modelKey}" technique "${technique}" datasetFormat must be a string`);
                    assert.ok(config.datasetFormat.length > 0,
                        `Model "${modelKey}" technique "${technique}" datasetFormat must not be empty`);

                    // datasetSchema must exist and be an object
                    assert.ok(config.datasetSchema !== null && config.datasetSchema !== undefined,
                        `Model "${modelKey}" technique "${technique}" must have a datasetSchema`);
                    assert.strictEqual(typeof config.datasetSchema, 'object',
                        `Model "${modelKey}" technique "${technique}" datasetSchema must be an object`);
                    assert.ok(!Array.isArray(config.datasetSchema),
                        `Model "${modelKey}" technique "${technique}" datasetSchema must not be an array`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 3: Unsupported model produces descriptive exit message ──────────
// Validates: Requirements 1.4, 4.2

import { validateModel, isTuneSupported, validateTechnique, validateTrainingType } from '../../src/lib/tune-catalog-validator.js';

describe('Feature: managed-model-customization, Property 3: Unsupported model produces descriptive exit message', () => {

    let modelKeys;
    let families;

    before(() => {
        modelKeys = Object.keys(catalog.models);
        const familySet = new Set();
        for (const entry of Object.values(catalog.models)) {
            if (entry.family) {
                familySet.add(entry.family);
            }
        }
        families = [...familySet];
    });

    it('error contains model ID, "not yet supported", at least one family, and do/train reference', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(s => !modelKeys.includes(s)),
            (randomModelId) => {
                const result = validateModel(randomModelId, catalog);

                // Must be invalid
                assert.strictEqual(result.valid, false,
                    `Model "${randomModelId}" should not be valid`);

                // Error must contain the model ID
                assert.ok(result.error.includes(randomModelId),
                    `Error must contain the model ID "${randomModelId}"`);

                // Error must contain "not yet supported"
                assert.ok(result.error.includes('not yet supported'),
                    'Error must contain "not yet supported"');

                // Error must contain at least one supported family name
                const containsFamily = families.some(f => result.error.includes(f));
                assert.ok(containsFamily,
                    `Error must contain at least one supported family name. Families: ${families.join(', ')}. Error: ${result.error}`);

                // Error must reference do/train
                assert.ok(result.error.includes('do/train'),
                    'Error must reference do/train');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 4: TUNE_SUPPORTED matches catalog membership ───────────────────
// Validates: Requirements 1.5

describe('Feature: managed-model-customization, Property 4: TUNE_SUPPORTED matches catalog membership', () => {

    let modelKeys;

    before(() => {
        modelKeys = Object.keys(catalog.models);
    });

    it('isTuneSupported returns true for catalog members', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...Object.keys(catalog.models)),
            (modelId) => {
                assert.strictEqual(isTuneSupported(modelId, catalog), true,
                    `Model "${modelId}" is in catalog so isTuneSupported must return true`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('isTuneSupported returns false for non-members', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(s => !modelKeys.includes(s)),
            (modelId) => {
                assert.strictEqual(isTuneSupported(modelId, catalog), false,
                    `Model "${modelId}" is NOT in catalog so isTuneSupported must return false`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 9: Unsupported technique exits with supported list ─────────────
// Validates: Requirements 4.3

describe('Feature: managed-model-customization, Property 9: Unsupported technique exits with supported list', () => {

    it('error lists all supported techniques for the model when technique is unsupported', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...Object.keys(catalog.models)),
            fc.string({ minLength: 1, maxLength: 30 }),
            (modelId, technique) => {
                const entry = catalog.models[modelId];
                const supportedTechniques = Object.keys(entry.techniques);

                // Only test when the technique is NOT supported
                fc.pre(!supportedTechniques.includes(technique));

                const result = validateTechnique(modelId, technique, catalog);

                // Must be invalid
                assert.strictEqual(result.valid, false,
                    `Technique "${technique}" should not be valid for model "${modelId}"`);

                // Error must list all supported techniques for this model
                for (const supported of supportedTechniques) {
                    assert.ok(result.error.includes(supported),
                        `Error must list supported technique "${supported}" for model "${modelId}". Error: ${result.error}`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 10: Unsupported training type exits with supported list ────────
// Validates: Requirements 4.4

describe('Feature: managed-model-customization, Property 10: Unsupported training type exits with supported list', () => {

    let modelTechniquePairs;

    before(() => {
        modelTechniquePairs = [];
        for (const [modelId, entry] of Object.entries(catalog.models)) {
            for (const technique of Object.keys(entry.techniques)) {
                modelTechniquePairs.push({ modelId, technique });
            }
        }
    });

    it('error lists supported training types when training type is unsupported', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...Object.entries(catalog.models).flatMap(
                ([modelId, entry]) => Object.keys(entry.techniques).map(t => ({ modelId, technique: t }))
            )),
            fc.string({ minLength: 1, maxLength: 30 }),
            (pair, trainingType) => {
                const { modelId, technique } = pair;
                const entry = catalog.models[modelId];
                const supportedTypes = entry.techniques[technique].trainingTypes;

                // Only test when the training type is NOT supported
                fc.pre(!supportedTypes.includes(trainingType));

                const result = validateTrainingType(modelId, technique, trainingType, catalog);

                // Must be invalid
                assert.strictEqual(result.valid, false,
                    `Training type "${trainingType}" should not be valid for model "${modelId}" technique "${technique}"`);

                // Error must list all supported training types for this model+technique
                for (const supported of supportedTypes) {
                    assert.ok(result.error.includes(supported),
                        `Error must list supported training type "${supported}" for model "${modelId}" technique "${technique}". Error: ${result.error}`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
