// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Catalog Validator
 *
 * Validates the e2e test catalog against a JSON Schema and enforces
 * additional constraints (unique IDs) that JSON Schema alone cannot express.
 * Also provides tier-based filtering of catalog entries.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalogSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['configs'],
    properties: {
        configs: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'tier', 'track', 'args', 'lifecycle', 'timeout'],
                additionalProperties: false,
                properties: {
                    id: { type: 'string', pattern: '^[a-z0-9-]+$' },
                    tier: { type: 'string', enum: ['ci', 'nightly', 'weekly'] },
                    track: { type: 'string', enum: ['realtime', 'hyperpod', 'async', 'batch'] },
                    args: { type: 'string' },
                    lifecycle: {
                        type: 'array',
                        items: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
                        minItems: 1
                    },
                    timeout: { type: 'integer', minimum: 60 },
                    tuneTimeout: { type: 'integer', minimum: 60 },
                    tuneConfig: {
                        type: 'object',
                        required: ['tuneId', 'technique', 'trainingType', 'dataset'],
                        properties: {
                            tuneId: { type: 'string' },
                            technique: { type: 'string', enum: ['sft', 'dpo', 'rlaif', 'rlvr'] },
                            trainingType: { type: 'string', enum: ['lora', 'full-rank'] },
                            dataset: { type: 'string' }
                        },
                        additionalProperties: false
                    }
                }
            }
        }
    }
};

/**
 * Custom validation rules for tune lifecycle entries.
 *
 * Enforces:
 * - Entries with tune lifecycle steps (steps starting with "tune-") must have a `tuneConfig` object
 * - Entries with tune lifecycle steps must include `--enable-lora` in their `args` field
 * - If `tuneTimeout` is present, it must be a positive integer >= 60
 *
 * @param {Object} catalog - The catalog object with a `configs` array
 * @param {Array<{ path: string, message: string }>} errors - Errors array to append to
 */
export function validateTuneConstraints(catalog, errors) {
    if (!catalog || !Array.isArray(catalog.configs)) {
        return;
    }

    for (let i = 0; i < catalog.configs.length; i++) {
        const entry = catalog.configs[i];
        if (!entry || !Array.isArray(entry.lifecycle)) {
            continue;
        }

        const hasTuneSteps = entry.lifecycle.some((s) => typeof s === 'string' && s.startsWith('tune-'));

        if (hasTuneSteps) {
            // Must have tuneConfig
            if (!entry.tuneConfig) {
                errors.push({
                    path: `/configs/${i}`,
                    message: `entry "${entry.id}" has tune lifecycle steps but no tuneConfig`
                });
                continue;
            }

            // Must have --enable-lora in args
            if (!entry.args || !entry.args.includes('--enable-lora')) {
                errors.push({
                    path: `/configs/${i}/args`,
                    message: `entry "${entry.id}" has tune steps but args missing --enable-lora`
                });
            }
        }

        // tuneTimeout validation (if present)
        if (entry.tuneTimeout !== undefined) {
            if (typeof entry.tuneTimeout !== 'number' || !Number.isInteger(entry.tuneTimeout) || entry.tuneTimeout < 60) {
                errors.push({
                    path: `/configs/${i}/tuneTimeout`,
                    message: `entry "${entry.id}": tuneTimeout must be a positive integer >= 60`
                });
            }
        }
    }
}

/**
 * Validate lifecycle ordering for tune-group steps.
 *
 * Tune-group steps are: any step starting with "tune-", "adapter-add", and "test-adapter".
 * These must appear AFTER the "test" step and BEFORE the "clean" step in the lifecycle array.
 *
 * @param {Object} catalog - The catalog object with a `configs` array
 * @param {Array<{ path: string, message: string }>} errors - Errors array to append to
 */
export function validateLifecycleOrdering(catalog, errors) {
    if (!catalog || !Array.isArray(catalog.configs)) {
        return;
    }

    for (let i = 0; i < catalog.configs.length; i++) {
        const entry = catalog.configs[i];
        if (!entry || !Array.isArray(entry.lifecycle)) {
            continue;
        }

        // Identify tune-group steps in this entry's lifecycle
        const tuneGroupSteps = entry.lifecycle.filter(
            (s) => typeof s === 'string' && (s.startsWith('tune-') || s === 'adapter-add' || s === 'test-adapter')
        );

        if (tuneGroupSteps.length === 0) {
            continue;
        }

        const testIdx = entry.lifecycle.indexOf('test');
        const cleanIdx = entry.lifecycle.indexOf('clean');

        for (const step of tuneGroupSteps) {
            const stepIdx = entry.lifecycle.indexOf(step);

            if (testIdx >= 0 && stepIdx <= testIdx) {
                errors.push({
                    path: `/configs/${i}/lifecycle`,
                    message: `entry "${entry.id}": "${step}" must come after "test"`
                });
            }

            if (cleanIdx >= 0 && stepIdx >= cleanIdx) {
                errors.push({
                    path: `/configs/${i}/lifecycle`,
                    message: `entry "${entry.id}": "${step}" must come before "clean"`
                });
            }
        }
    }
}

/**
 * Validate tuneConfig entries against tune-catalog.json.
 * This is a "soft" validation — returns an empty errors array if tune-catalog is unavailable.
 *
 * For each catalog entry with a tuneConfig:
 * - Checks that tuneConfig.tuneId exists as a key in the tune-catalog's models object
 * - Checks that the specified technique is supported for that model
 * - Checks that the specified trainingType is in the technique's trainingTypes array
 *
 * @param {Object} catalog - The catalog object with a configs array
 * @param {string} tuneCatalogPath - Path to the tune-catalog.json file
 * @returns {Array<{ path: string, message: string }>} Array of validation errors
 */
export function validateTuneCatalogReferences(catalog, tuneCatalogPath) {
    const errors = [];

    if (!catalog || !Array.isArray(catalog.configs)) {
        return errors;
    }

    let tuneCatalog;
    try {
        const raw = readFileSync(tuneCatalogPath, 'utf8');
        tuneCatalog = JSON.parse(raw);
    } catch {
        // tune-catalog not available or unparseable — skip cross-reference validation
        return errors;
    }

    if (!tuneCatalog || !tuneCatalog.models) {
        return errors;
    }

    for (let i = 0; i < catalog.configs.length; i++) {
        const entry = catalog.configs[i];
        if (!entry || !entry.tuneConfig) {
            continue;
        }

        const { tuneId, technique, trainingType } = entry.tuneConfig;

        // Check tuneId exists in tune-catalog models
        const tuneModel = tuneCatalog.models[tuneId];
        if (!tuneModel) {
            errors.push({
                path: `/configs/${i}/tuneConfig/tuneId`,
                message: `entry "${entry.id}": tuneId "${tuneId}" not found in tune-catalog`
            });
            continue;
        }

        // Check technique is supported for this model
        if (!tuneModel.techniques || !tuneModel.techniques[technique]) {
            errors.push({
                path: `/configs/${i}/tuneConfig/technique`,
                message: `entry "${entry.id}": technique "${technique}" not supported for model "${tuneId}"`
            });
            continue;
        }

        // Check trainingType is in the technique's trainingTypes array
        const supportedTrainingTypes = tuneModel.techniques[technique].trainingTypes;
        if (!Array.isArray(supportedTrainingTypes) || !supportedTrainingTypes.includes(trainingType)) {
            errors.push({
                path: `/configs/${i}/tuneConfig/trainingType`,
                message: `entry "${entry.id}": trainingType "${trainingType}" not supported for ${tuneId}/${technique}`
            });
        }
    }

    return errors;
}

/**
 * Validate an e2e catalog object against the schema and uniqueness constraints.
 *
 * @param {Object} catalog - The catalog object to validate
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.tuneCatalogPath] - Custom path to tune-catalog.json for cross-reference validation
 * @returns {{ valid: boolean, errors?: Array<{ path: string, message: string }> }}
 */
export function validateCatalog(catalog, options = {}) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(catalogSchema);

    const valid = validate(catalog);
    const errors = [];

    if (!valid) {
        for (const err of validate.errors) {
            // Try to include the entry id in the error message for better diagnostics
            let message = err.message;
            const pathMatch = (err.instancePath || '').match(/^\/configs\/(\d+)/);
            if (pathMatch && catalog && Array.isArray(catalog.configs)) {
                const idx = parseInt(pathMatch[1], 10);
                const entry = catalog.configs[idx];
                if (entry && typeof entry.id === 'string') {
                    message = `entry "${entry.id}": ${err.message}`;
                }
            }
            errors.push({
                path: err.instancePath || '/',
                message
            });
        }
    }

    // Custom check: unique IDs across all entries
    if (catalog && catalog.configs && Array.isArray(catalog.configs)) {
        const seen = new Map();
        for (let i = 0; i < catalog.configs.length; i++) {
            const entry = catalog.configs[i];
            if (entry && typeof entry.id === 'string') {
                if (seen.has(entry.id)) {
                    errors.push({
                        path: `/configs/${i}/id`,
                        message: `duplicate id "${entry.id}" (first seen at index ${seen.get(entry.id)})`
                    });
                } else {
                    seen.set(entry.id, i);
                }
            }
        }
    }

    // Custom check: tune constraints (runs after Ajv schema validation)
    validateTuneConstraints(catalog, errors);

    // Custom check: lifecycle ordering for tune-group steps
    validateLifecycleOrdering(catalog, errors);

    // Cross-reference validation against tune-catalog.json
    const tuneCatalogPath = options.tuneCatalogPath || path.resolve(process.cwd(), 'config/tune-catalog.json');
    const crossRefErrors = validateTuneCatalogReferences(catalog, tuneCatalogPath);
    errors.push(...crossRefErrors);

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true };
}

/**
 * Filter catalog configs by tier.
 *
 * @param {Object} catalog - The catalog object with a `configs` array
 * @param {string} tier - The tier to filter by (e.g., 'ci', 'nightly', 'weekly')
 * @returns {Array<Object>} Configs matching the given tier
 */
export function filterByTier(catalog, tier) {
    if (!catalog || !Array.isArray(catalog.configs)) {
        return [];
    }
    return catalog.configs.filter((config) => config.tier === tier);
}

/**
 * Filter configs by a specific config id.
 *
 * First attempts to find the config within the provided (tier-filtered) configs array.
 * If not found there, falls back to searching the full catalog — this is a convenience
 * for re-runs where the user specifies --config without matching the tier.
 *
 * @param {Array<Object>} configs - Pre-filtered configs (e.g., from filterByTier)
 * @param {Object} catalog - The full catalog object with a `configs` array
 * @param {string} configId - The config id to filter by
 * @returns {Array<Object>} Matching configs (0 or 1 element)
 */
export function filterByConfig(configs, catalog, configId) {
    if (!configId) {
        return configs;
    }

    // First try within the already-filtered set (tier-filtered)
    const inTier = configs.filter(c => c.id === configId);
    if (inTier.length > 0) {
        return inTier;
    }

    // Fallback: search the full catalog (convenience for --config without matching tier)
    if (catalog && Array.isArray(catalog.configs)) {
        return catalog.configs.filter(c => c.id === configId);
    }

    return [];
}
