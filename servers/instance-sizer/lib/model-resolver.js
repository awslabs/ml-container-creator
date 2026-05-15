// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Metadata Resolver
 *
 * Three-tier resolution strategy for model metadata:
 * 1. Check model-sizes catalog (exact match or glob pattern match)
 * 2. If discover mode enabled, fetch HuggingFace config.json
 * 3. If neither available, return null (caller handles fallback)
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_CATALOG_PATH = join(__dirname, '..', '..', 'lib', 'catalogs', 'models.json')
const HUGGINGFACE_BASE_URL = 'https://huggingface.co'
const HUGGINGFACE_TIMEOUT_MS = 5000

// ── Glob Pattern Matching ────────────────────────────────────────────────────

/**
 * Simple glob pattern matcher supporting * wildcards.
 * Case-insensitive matching.
 *
 * @param {string} pattern - Glob pattern (e.g., 'meta-llama/Llama-2-7b*')
 * @param {string} text - Text to match against
 * @returns {boolean} Whether the text matches the pattern
 */
const globMatch = (pattern, text) => {
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
    const regex = new RegExp(`^${regexStr}$`, 'i')
    return regex.test(text)
}

// ── Catalog Lookup ───────────────────────────────────────────────────────────

/**
 * Load the model-sizes catalog from disk.
 *
 * @param {string} [catalogPath] - Path to catalog JSON file
 * @returns {Promise<object|null>} Parsed catalog or null on failure
 */
const loadCatalog = async (catalogPath) => {
    try {
        const raw = await readFile(catalogPath || DEFAULT_CATALOG_PATH, 'utf-8')
        return JSON.parse(raw)
    } catch {
        return null
    }
}

/**
 * Look up a model in the catalog by exact match or glob pattern.
 *
 * @param {string} modelName - HuggingFace model ID or catalog key
 * @param {object} catalog - Parsed catalog object (flat or with .models wrapper)
 * @returns {object|null} Catalog entry or null if not found
 */
const catalogLookup = (modelName, catalog) => {
    if (!catalog) {
        return null
    }

    // Support both flat catalog (models.json) and wrapped format ({ models: {...} })
    const models = catalog.models || catalog

    // Try exact match first
    if (models[modelName]) {
        return models[modelName]
    }

    // Try glob pattern matching
    for (const pattern of Object.keys(models)) {
        if (globMatch(pattern, modelName)) {
            return models[pattern]
        }
    }

    return null
}

// ── HuggingFace API ──────────────────────────────────────────────────────────

/**
 * Fetch model config.json from HuggingFace Hub.
 *
 * @param {string} modelName - HuggingFace model ID (e.g., 'meta-llama/Llama-2-7b-chat-hf')
 * @returns {Promise<object|null>} Parsed config or null on failure
 */
const fetchHuggingFaceConfig = async (modelName) => {
    const url = `${HUGGINGFACE_BASE_URL}/${modelName}/resolve/main/config.json`

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), HUGGINGFACE_TIMEOUT_MS)

        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        })

        clearTimeout(timeout)

        if (!response.ok) {
            return null
        }

        return await response.json()
    } catch {
        return null
    }
}

/**
 * Estimate parameter count from architecture dimensions.
 * Uses the approximation: hidden_size × num_hidden_layers × 12
 *
 * This accounts for:
 * - Attention weights (Q, K, V, O projections = 4 × hidden_size²)
 * - FFN weights (typically 8 × hidden_size²)
 * - Embeddings and other components
 *
 * @param {object} config - HuggingFace config.json contents
 * @returns {number|null} Estimated parameter count or null if dimensions unavailable
 */
const estimateParamsFromConfig = (config) => {
    const hiddenSize = config.hidden_size
    const numLayers = config.num_hidden_layers

    if (!hiddenSize || !numLayers) {
        return null
    }

    return hiddenSize * numLayers * 12
}

/**
 * Extract model metadata from a HuggingFace config.json.
 *
 * @param {object} config - Parsed HuggingFace config.json
 * @returns {object} Extracted metadata
 */
const extractFromHuggingFaceConfig = (config) => {
    const parameterCount = config.num_parameters
        ?? estimateParamsFromConfig(config)

    const dtype = config.torch_dtype || 'float16'
    const architecture = config.architectures?.[0] || 'unknown'
    const maxPositionEmbeddings = config.max_position_embeddings || 4096

    return {
        parameterCount,
        dtype,
        architecture,
        maxPositionEmbeddings,
        source: 'huggingface_api'
    }
}

// ── In-memory cache for discover mode ────────────────────────────────────────

const discoverCache = new Map()

// ── Protocol prefix detection ────────────────────────────────────────────────

const PROTOCOL_PREFIXES = ['jumpstart://', 'jumpstart-hub://', 's3://', 'registry://']

/**
 * Check if a model name matches the HuggingFace org/model-name pattern.
 * Must contain exactly one `/` and no protocol prefix.
 *
 * @param {string} modelName - Model identifier to check
 * @returns {boolean} True if it matches the HuggingFace pattern
 */
const isHuggingFacePattern = (modelName) => {
    if (!modelName || typeof modelName !== 'string') return false
    // Must not have a protocol prefix
    if (PROTOCOL_PREFIXES.some(prefix => modelName.startsWith(prefix))) return false
    // Must contain exactly one `/` (org/model-name)
    const slashCount = (modelName.match(/\//g) || []).length
    return slashCount === 1
}

// ── Main Resolver ────────────────────────────────────────────────────────────

/**
 * Resolve model metadata from available sources.
 *
 * Three-tier resolution:
 * 1. Check model-sizes catalog (exact match or pattern match)
 * 2. If discover mode enabled AND model matches HuggingFace pattern, fetch config.json
 * 3. If neither available, return null
 *
 * @param {string} modelName - HuggingFace model ID or catalog key
 * @param {object} [options={}]
 * @param {boolean} [options.discover=false] - Enable HuggingFace API lookups
 * @param {string} [options.catalogPath] - Path to model-sizes catalog (for testing)
 * @returns {Promise<{ parameterCount: number, dtype: string, architecture: string, maxPositionEmbeddings: number, source: string } | null>}
 */
const resolveModelMetadata = async (modelName, options = {}) => {
    const { discover = true, catalogPath } = options

    // Tier 1: Catalog lookup
    const catalog = await loadCatalog(catalogPath)
    const catalogEntry = catalogLookup(modelName, catalog)

    if (catalogEntry) {
        // Only use catalog entry if it has a usable parameterCount for VRAM estimation.
        // If parameterCount is missing, fall through to HuggingFace API (tier 2).
        if (catalogEntry.parameterCount) {
            return {
                parameterCount: catalogEntry.parameterCount,
                dtype: catalogEntry.defaultDtype,
                architecture: catalogEntry.architecture,
                maxPositionEmbeddings: catalogEntry.maxPositionEmbeddings,
                source: 'catalog'
            }
        }
    }

    // Tier 2: HuggingFace API (only in discover mode, only for org/model-name pattern)
    if (discover && isHuggingFacePattern(modelName)) {
        // Check in-memory cache first
        if (discoverCache.has(modelName)) {
            return discoverCache.get(modelName)
        }

        const config = await fetchHuggingFaceConfig(modelName)

        if (config) {
            const metadata = extractFromHuggingFaceConfig(config)

            // Only return if we got a usable parameter count
            if (metadata.parameterCount) {
                // Cache for session duration
                discoverCache.set(modelName, metadata)
                return metadata
            }
        }
    }

    // Tier 3: No metadata available
    return null
}

export {
    resolveModelMetadata,
    globMatch,
    loadCatalog,
    catalogLookup,
    fetchHuggingFaceConfig,
    estimateParamsFromConfig,
    extractFromHuggingFaceConfig,
    isHuggingFacePattern,
    discoverCache,
    PROTOCOL_PREFIXES,
    DEFAULT_CATALOG_PATH,
    HUGGINGFACE_BASE_URL,
    HUGGINGFACE_TIMEOUT_MS
}
