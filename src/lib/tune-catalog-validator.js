// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Catalog Validator
 *
 * Validates model IDs, techniques, and training types against the
 * Supported Model Catalog. Provides descriptive error messages when
 * a requested configuration is not supported.
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6, 4.1, 4.2, 4.3, 4.4
 */

/**
 * Look up a model entry in the catalog by model ID.
 * Tries: direct key match, huggingFaceId field match, then normalized/suffix matching.
 * @param {string} modelId - The model ID to look up (Hub content name or HuggingFace ID)
 * @param {Object} catalog - The tune catalog object with a `models` map
 * @returns {Object|null} The catalog entry for the model, or null if not found
 */
export function lookupModel(modelId, catalog) {
    if (!catalog || !catalog.models) {
        return null;
    }

    // Direct key match (Hub content name)
    if (Object.hasOwn(catalog.models, modelId)) {
        return catalog.models[modelId] || null;
    }

    // Match by huggingFaceId field (e.g., "Qwen/Qwen3-0.6B")
    for (const [, entry] of Object.entries(catalog.models)) {
        if (entry.huggingFaceId === modelId) {
            return entry;
        }
    }

    // Normalized match: strip org prefix, lowercase, replace dots/spaces with hyphens
    const normalized = modelId.split('/').pop().toLowerCase().replace(/[.\s]+/g, '-');
    if (normalized && Object.hasOwn(catalog.models, normalized)) {
        return catalog.models[normalized] || null;
    }

    // Try without trailing suffixes like -instruct, -chat, -hf, -base
    const base = normalized ? normalized.replace(/-(instruct|chat|hf|base)$/i, '') : '';
    if (base && base !== normalized && Object.hasOwn(catalog.models, base)) {
        return catalog.models[base] || null;
    }

    // Suffix match: catalog keys may have prefixes (e.g., "huggingface-reasoning-")
    // Match if a catalog key ends with the normalized name (must be non-trivial match)
    if (normalized && normalized.length >= 4) {
        for (const [key, entry] of Object.entries(catalog.models)) {
            if (key.endsWith(normalized) || (base && base.length >= 4 && key.endsWith(base))) {
                return entry || null;
            }
        }
    }

    return null;
}

/**
 * Check whether a model ID is present in the Supported Model Catalog.
 * @param {string} modelId - The model ID to check
 * @param {Object} catalog - The tune catalog object with a `models` map
 * @returns {boolean} True if the model is in the catalog
 */
export function isTuneSupported(modelId, catalog) {
    return lookupModel(modelId, catalog) !== null;
}

/**
 * Validate that a model ID exists in the catalog.
 * Returns a descriptive error when the model is not supported, including
 * the model name, supported families, and a reference to `do/train`.
 * @param {string} modelId - The model ID to validate
 * @param {Object} catalog - The tune catalog object with a `models` map
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateModel(modelId, catalog) {
    if (isTuneSupported(modelId, catalog)) {
        return { valid: true };
    }

    const families = _getSupportedFamilies(catalog);
    const familyList = families.join(', ');

    return {
        valid: false,
        error: `Model "${modelId}" is not yet supported for managed serverless customization. ` +
            `Supported model families: ${familyList}. ` +
            'For custom training workflows, see `do/train`.'
    };
}

/**
 * Validate that a technique is supported for the given model.
 * Returns a descriptive error listing the supported techniques when
 * the requested technique is not available.
 * @param {string} modelId - The model ID
 * @param {string} technique - The technique to validate (e.g., 'sft', 'dpo')
 * @param {Object} catalog - The tune catalog object with a `models` map
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTechnique(modelId, technique, catalog) {
    const entry = lookupModel(modelId, catalog);
    if (!entry) {
        return validateModel(modelId, catalog);
    }

    const supportedTechniques = Object.keys(entry.techniques);
    if (supportedTechniques.includes(technique)) {
        return { valid: true };
    }

    return {
        valid: false,
        error: `Technique "${technique}" is not supported for model "${modelId}". ` +
            `Supported techniques: ${supportedTechniques.join(', ')}.`
    };
}

/**
 * Validate that a training type is supported for the given model and technique.
 * Returns a descriptive error listing the supported training types when
 * the requested type is not available.
 * @param {string} modelId - The model ID
 * @param {string} technique - The technique (e.g., 'sft', 'dpo')
 * @param {string} trainingType - The training type to validate (e.g., 'lora', 'full-rank')
 * @param {Object} catalog - The tune catalog object with a `models` map
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTrainingType(modelId, technique, trainingType, catalog) {
    const entry = lookupModel(modelId, catalog);
    if (!entry) {
        return validateModel(modelId, catalog);
    }

    const techniqueEntry = entry.techniques[technique];
    if (!techniqueEntry) {
        return validateTechnique(modelId, technique, catalog);
    }

    const supportedTypes = techniqueEntry.trainingTypes;
    if (supportedTypes.includes(trainingType)) {
        return { valid: true };
    }

    return {
        valid: false,
        error: `Training type "${trainingType}" is not supported for model "${modelId}" ` +
            `with technique "${technique}". ` +
            `Supported training types: ${supportedTypes.join(', ')}.`
    };
}

/**
 * Extract unique model family names from the catalog.
 * @param {Object} catalog - The tune catalog object
 * @returns {string[]} Array of unique family names
 * @private
 */
function _getSupportedFamilies(catalog) {
    if (!catalog || !catalog.models) {
        return [];
    }

    const families = new Set();
    for (const entry of Object.values(catalog.models)) {
        if (entry.family) {
            families.add(entry.family);
        }
    }
    return [...families];
}
