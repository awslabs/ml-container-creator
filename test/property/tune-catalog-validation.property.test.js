// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Catalog Validation Property-Based Tests
 *
 * Property 5: Catalog schema validity
 *
 * For any entry in the Supported_Model_Catalog, it SHALL have:
 * a non-empty jumpStartModelId, a non-empty techniques object where
 * each technique key is one of KNOWN_TECHNIQUES (sft, dpo, rlvr, rlaif, mtrl —
 * derived from src/lib/managed-techniques.js, not hardcoded), each technique
 * has a non-empty trainingTypes array containing only [lora, full-rank],
 * and a non-empty datasetFormat label. BL129 (ODP-1): the dataset SCHEMA is a
 * catalog field only for the jsonl techniques (sft/dpo); the managed-RL
 * techniques (rlvr/rlaif/mtrl) carry their dataset contract in the tune
 * DESCRIPTOR (templates/code/tune.d/<technique>/manifest.json), asserted in the
 * dedicated descriptor-contract describe block.
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
import { PROPERTY_CONFIG } from '../helpers/property-config.js';
import { KNOWN_TECHNIQUES } from '../../src/lib/managed-techniques.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Catalog loading ──────────────────────────────────────────────────────────

const catalogPath = resolve(__dirname, '../../config/tune-catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

// DERIVE from the single source of truth (managed-techniques.js), not a hardcoded copy —
// `sync-model-families` retains any recipe whose technique is in KNOWN_TECHNIQUES, so the
// catalog can legitimately carry ANY of them (incl. `mtrl`, confirmed present on
// huggingface-vlm-qwen3-6-27b / gemma-4). A frozen literal here drifts the moment the
// catalog gains a model advertising a new managed technique (derive-dont-hardcode / ADR-008).
const VALID_TECHNIQUES = [...KNOWN_TECHNIQUES];
const VALID_TRAINING_TYPES = ['lora', 'full-rank'];

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: managed-model-customization, Property 5: Catalog schema validity', () => {

    let modelKeys;

    before(() => {
        modelKeys = Object.keys(catalog.models);
    });

    it('every catalog entry has required metadata fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                assert.ok(entry.family,
                    `Model "${modelKey}" must have a non-empty family`);
                assert.ok(entry.provider,
                    `Model "${modelKey}" must have a non-empty provider`);
                assert.ok(entry.displayName,
                    `Model "${modelKey}" must have a non-empty displayName`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('every technique key is a KNOWN managed technique (sft|dpo|rlvr|rlaif|mtrl)', function () {
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

    // BL129 (ODP-1): the dataset contract for the managed-RL techniques (rlvr/rlaif/
    // mtrl) is STRUCTURAL and lives in the tune DESCRIPTOR
    // (templates/code/tune.d/<technique>/manifest.json → dataset_contract), consumed
    // by the do/tune Gate's field-schema half — NOT a synced catalog guess. Only the
    // jsonl techniques (sft/dpo) carry a catalog `datasetSchema` (read by do/tune's
    // jsonl line-check). The old `sync-model-families.getDefaultDatasetSchema()` RL
    // arm (a verified-WRONG `{prompt: array}`) was removed; a fresh sync writes no
    // catalog schema for RL. This asserts the BEHAVIOR (where each technique's contract
    // lives), not the frozen pre-BL129 snapshot. `datasetFormat` stays a harmless label
    // for every technique.
    const JSONL_TECHNIQUES = new Set(['sft', 'dpo']);

    it('every technique has a non-empty datasetFormat label', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                for (const [technique, config] of Object.entries(entry.techniques)) {
                    assert.strictEqual(typeof config.datasetFormat, 'string',
                        `Model "${modelKey}" technique "${technique}" datasetFormat must be a string`);
                    assert.ok(config.datasetFormat.length > 0,
                        `Model "${modelKey}" technique "${technique}" datasetFormat must not be empty`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('jsonl techniques (sft/dpo) carry a catalog datasetSchema object with required columns', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constantFrom(...modelKeys),
            (modelKey) => {
                const entry = catalog.models[modelKey];
                for (const [technique, config] of Object.entries(entry.techniques)) {
                    // Only sft/dpo are asserted here — do/tune's jsonl line-check reads
                    // their catalog datasetSchema. The RL techniques' contract lives in
                    // the tune descriptor (asserted in the descriptor-contract describe
                    // block below), NOT the catalog, so they are intentionally skipped
                    // here — a catalog datasetSchema for them is neither required nor the
                    // source of truth (BL129 ODP-1).
                    if (!JSONL_TECHNIQUES.has(technique)) continue;
                    assert.ok(config.datasetSchema && typeof config.datasetSchema === 'object'
                        && !Array.isArray(config.datasetSchema),
                    `Model "${modelKey}" jsonl technique "${technique}" must carry a datasetSchema object`);
                    assert.ok(Array.isArray(config.datasetSchema.required)
                        && config.datasetSchema.required.length > 0,
                    `Model "${modelKey}" jsonl technique "${technique}" datasetSchema must list required columns`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── BL129 (ODP-1): the RL dataset contract lives in the descriptor, not the catalog ──
// Validates: Requirement 7.2 — the scoped getDefaultDatasetSchema removal + the
// descriptor as the single source of truth for the managed-RL dataset contract.

import { readDatasetContract } from '../../src/lib/tune-manifest-reader.js';

describe('Feature: v2-w3-01-bl129, RL dataset contract lives in the tune descriptor', () => {

    it('the RL dataset contract is the real verl-5field, NOT the removed {prompt:array} guess', () => {
        // BL129 Req 7.2 / ODP-1: the wrong RL arm of sync-model-families
        // getDefaultDatasetSchema() ({prompt:array}) was removed; a fresh sync writes
        // contract-absent {} for RL (covered by sync-tune-descriptors.test.js). The
        // AUTHORITATIVE contract now lives in the descriptor — assert it carries the real
        // verl-5field parquet / message-list shape, which is what the old catalog guess
        // got WRONG.
        for (const technique of ['rlvr', 'rlaif']) {
            const contract = readDatasetContract(technique, 'lora');
            assert.ok(contract, `${technique} must have a descriptor dataset_contract`);
            assert.strictEqual(contract.schema, 'verl-5field',
                `${technique} dataset contract must be verl-5field (the real contract), not a catalog guess`);
            assert.strictEqual(contract.format, 'parquet');
            assert.strictEqual(contract.prompt_shape, 'message-list',
                `${technique} prompt is a message list, NOT the old {prompt:array}/string guess`);
        }
    });

    it('mtrl declares an honest unverified contract in the descriptor', () => {
        const contract = readDatasetContract('mtrl', 'lora');
        assert.ok(contract);
        assert.strictEqual(contract.schema, 'mtrl-rollout');
        assert.strictEqual(contract.verified, false);
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
