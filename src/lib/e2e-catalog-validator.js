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
                    timeout: { type: 'integer', minimum: 60 }
                }
            }
        }
    }
};

/**
 * Validate an e2e catalog object against the schema and uniqueness constraints.
 *
 * @param {Object} catalog - The catalog object to validate
 * @returns {{ valid: boolean, errors?: Array<{ path: string, message: string }> }}
 */
export function validateCatalog(catalog) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(catalogSchema);

    const valid = validate(catalog);
    const errors = [];

    if (!valid) {
        for (const err of validate.errors) {
            errors.push({
                path: err.instancePath || '/',
                message: err.message
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
