// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Metadata Resolver for the instance-sizer MCP server.
 *
 * Resolution pipeline:
 *   1. Load model-sizes catalog (pre-built, offline-safe)
 *   2. Attempt catalog lookup via glob pattern matching
 *   3. If discover=true and no catalog hit, fetch config.json from HuggingFace Hub
 *   4. Extract/estimate parameter count, dtype, architecture, context length
 *
 * Exports:
 *   - resolveModelMetadata(modelName, options) — full resolution pipeline
 *   - globMatch(pattern, string) — glob-style pattern matching (case-insensitive)
 *   - loadCatalog(path) — loads the model-sizes JSON catalog
 *   - catalogLookup(modelName, catalog) — finds a model in the catalog
 *   - estimateParamsFromConfig(config) — estimates params from architecture dimensions
 *   - extractFromHuggingFaceConfig(config) — extracts metadata from HF config.json
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CATALOG_PATH = resolve(__dirname, '../../lib/catalogs/model-sizes.json');

/**
 * Known protocol prefixes that indicate non-HuggingFace model sources.
 * Models with these prefixes are never fetched from HuggingFace Hub.
 */
export const PROTOCOL_PREFIXES = [
    's3://',
    'registry://',
    'marketplace://',
    'jumpstart://',
    'jumpstart-hub://'
];

/**
 * Determine if a model name matches the HuggingFace pattern: org/model-name.
 * Must contain exactly one `/` and must NOT start with a protocol prefix.
 *
 * @param {string} modelName - The model identifier to test
 * @returns {boolean} Whether the model name is a HuggingFace model ID
 */
export function isHuggingFacePattern(modelName) {
    if (!modelName || typeof modelName !== 'string') {
        return false;
    }
    if (PROTOCOL_PREFIXES.some(prefix => modelName.startsWith(prefix))) {
        return false;
    }
    const slashCount = (modelName.match(/\//g) || []).length;
    return slashCount === 1;
}

/**
 * Glob-style pattern matching (case-insensitive).
 * Supports `*` as a wildcard that matches any sequence of characters.
 *
 * @param {string} pattern - Pattern with optional `*` wildcards
 * @param {string} string - String to test against the pattern
 * @returns {boolean} Whether the string matches the pattern
 */
export function globMatch(pattern, string) {
    // Escape regex special characters except `*`
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Replace `*` with `.*` for regex matching
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
    return regex.test(string);
}

/**
 * Load the model-sizes catalog from a JSON file.
 *
 * @param {string} [catalogPath] - Absolute path to the catalog JSON file
 * @returns {Promise<Object|null>} Parsed catalog object, or null if file not found/invalid
 */
export async function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
    try {
        const raw = readFileSync(catalogPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Look up a model in the catalog using glob pattern matching.
 * Iterates over catalog keys (which may contain `*` wildcards) and
 * returns the first matching entry.
 *
 * @param {string} modelName - HuggingFace model ID (e.g., "meta-llama/Llama-3.1-8B-Instruct")
 * @param {Object|null} catalog - Loaded catalog object with a `models` field
 * @returns {Object|null} Matching catalog entry, or null
 */
export function catalogLookup(modelName, catalog) {
    if (!catalog || !catalog.models) {
        return null;
    }

    for (const [pattern, entry] of Object.entries(catalog.models)) {
        if (globMatch(pattern, modelName)) {
            return entry;
        }
    }

    return null;
}

/**
 * Estimate parameter count from model architecture dimensions.
 * Uses the approximation: hidden_size × num_hidden_layers × 12.
 *
 * @param {Object} config - Model configuration (HuggingFace config.json format)
 * @returns {number|null} Estimated parameter count, or null if dimensions are missing
 */
export function estimateParamsFromConfig(config) {
    const hiddenSize = config.hidden_size;
    const numLayers = config.num_hidden_layers;

    if (!hiddenSize || !numLayers) {
        return null;
    }

    return hiddenSize * numLayers * 12;
}

/**
 * Extract model metadata from a HuggingFace config.json object.
 *
 * @param {Object} config - Parsed config.json from HuggingFace Hub
 * @returns {Object} Extracted metadata with parameterCount, dtype, architecture, maxPositionEmbeddings, source
 */
export function extractFromHuggingFaceConfig(config) {
    const parameterCount = config.num_parameters || estimateParamsFromConfig(config);
    const dtype = config.torch_dtype || 'float16';
    const architecture = (config.architectures && config.architectures[0]) || 'unknown';
    const maxPositionEmbeddings = config.max_position_embeddings || 4096;

    return {
        parameterCount,
        dtype,
        architecture,
        maxPositionEmbeddings,
        source: 'huggingface_api'
    };
}

/**
 * Resolve model metadata through the full pipeline:
 *   1. Catalog lookup (offline, fast)
 *   2. HuggingFace Hub fetch (if discover=true and no catalog hit)
 *
 * @param {string} modelName - HuggingFace model ID
 * @param {Object} [options] - Resolution options
 * @param {string} [options.catalogPath] - Path to model-sizes catalog
 * @param {boolean} [options.discover=true] - Whether to fetch from HuggingFace Hub on cache miss
 * @param {number} [options.timeout=5000] - HTTP timeout for HuggingFace API (ms)
 * @returns {Promise<Object|null>} Resolved metadata, or null if unresolvable
 */
export async function resolveModelMetadata(modelName, options = {}) {
    const {
        catalogPath = DEFAULT_CATALOG_PATH,
        discover = true,
        timeout = 5000
    } = options;

    // Step 1: Try catalog lookup
    const catalog = await loadCatalog(catalogPath);
    const catalogEntry = catalogLookup(modelName, catalog);

    if (catalogEntry) {
        return {
            parameterCount: catalogEntry.parameterCount,
            dtype: catalogEntry.defaultDtype || 'float16',
            architecture: catalogEntry.architecture || 'unknown',
            maxPositionEmbeddings: catalogEntry.maxPositionEmbeddings || 4096,
            source: 'catalog'
        };
    }

    // Step 2: If discover mode, try HuggingFace Hub
    if (discover && isHuggingFacePattern(modelName)) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const url = `https://huggingface.co/${modelName}/resolve/main/config.json`;
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'ml-container-creator/instance-sizer' }
            });

            clearTimeout(timer);

            if (response.ok) {
                const config = await response.json();
                return extractFromHuggingFaceConfig(config);
            }
        } catch {
            // Network error or timeout — fall through to null
        }
    }

    return null;
}
