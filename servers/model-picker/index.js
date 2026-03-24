#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Picker MCP Server
 *
 * A bundled MCP server that returns model metadata for ML Container Creator.
 * Supports two operating modes:
 *   - Static: Returns metadata from local catalog files (popular-transformers.json, popular-diffusors.json)
 *   - Discover: Queries HuggingFace Hub API for live metadata, merging with static catalog
 *
 * Uses a pluggable ModelResolver architecture. V1 ships with HuggingFaceResolver
 * and StaticCatalogResolver.
 *
 * Tool: get_models
 *   Accepts: { model_id: string, fields?: string[], mode?: string, context?: object }
 *   Returns: { values, choices, message }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { DynamicResolver } from '../lib/dynamic-resolver.js'

// ── Catalog loader ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Load and parse a JSON catalog file relative to the server directory.
 * Throws on missing file or invalid JSON with the file path in the message.
 *
 * @param {string} relativePath - Path relative to server dir (e.g. './catalogs/popular-transformers.json')
 * @returns {any} Parsed JSON content
 */
function loadCatalog(relativePath) {
    const fullPath = resolve(__dirname, relativePath)
    let raw
    try {
        raw = readFileSync(fullPath, 'utf8')
    } catch (err) {
        throw new Error(`Catalog file not found: ${fullPath}`)
    }
    try {
        return JSON.parse(raw)
    } catch (err) {
        throw new Error(`Failed to parse catalog ${fullPath}: ${err.message}`)
    }
}

// ── ModelResolver interface ──────────────────────────────────────────────────

/**
 * ModelResolver — model-specific dynamic resolver.
 *
 * Extends DynamicResolver with model-specific method names (fetchModelMetadata,
 * supportedPatterns) that delegate to the generic fetch/supportedKeys interface.
 *
 * Each resolver knows how to fetch metadata from a specific model source.
 * The MCP server delegates to the appropriate resolver based on model ID pattern.
 */
class ModelResolver extends DynamicResolver {
    /**
     * Fetch metadata for a model ID.
     * @param {string} modelId - e.g. 'meta-llama/Llama-2-7b-chat-hf'
     * @param {object} options - { fields, limit, context }
     * @returns {Promise<object|null>} Model metadata or null
     */
    async fetchModelMetadata(modelId, options = {}) {
        throw new Error('fetchModelMetadata() must be implemented by subclass')
    }

    /**
     * Returns glob patterns this resolver handles.
     * @returns {string[]} e.g. ['hf:org/model'] for HuggingFace org/model pattern
     */
    supportedPatterns() {
        throw new Error('supportedPatterns() must be implemented by subclass')
    }

    // ── DynamicResolver interface bridge ─────────────────────────────────

    async fetch(key, options = {}) {
        return this.fetchModelMetadata(key, options)
    }

    supportedKeys() {
        return this.supportedPatterns()
    }
}


// ── StaticCatalogResolver ────────────────────────────────────────────────────

/**
 * StaticCatalogResolver — fallback resolver.
 *
 * Returns model metadata from the static catalog.
 * No network calls, no auth, no external dependencies.
 * Supports exact match and glob-style pattern matching.
 */
class StaticCatalogResolver extends ModelResolver {
    constructor(catalog) {
        super()
        this._catalog = catalog
    }

    supportedPatterns() {
        return ['*']
    }

    async fetchModelMetadata(modelId, options = {}) {
        // Exact match first
        if (this._catalog[modelId]) {
            return { ...this._catalog[modelId] }
        }

        // Glob pattern match (e.g., 'meta-llama/Llama-2-*')
        for (const [pattern, metadata] of Object.entries(this._catalog)) {
            if (pattern.includes('*') || pattern.includes('?')) {
                if (this._globMatch(modelId, pattern)) {
                    return { ...metadata }
                }
            }
        }

        return null
    }

    /**
     * Match a string against a glob pattern.
     * Converts * to .* and ? to . for regex matching.
     *
     * @param {string} str - The string to test
     * @param {string} pattern - Glob pattern with * and ? wildcards
     * @returns {boolean}
     */
    _globMatch(str, pattern) {
        const regex = new RegExp(
            '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        )
        return regex.test(str)
    }
}


// ── HuggingFaceResolver ──────────────────────────────────────────────────────

/**
 * HuggingFaceResolver — fetches live model metadata from HuggingFace Hub API.
 *
 * Handles model IDs matching the org/model-name pattern. Queries three endpoints:
 *   - /api/models/{modelId} — model info (always)
 *   - /{modelId}/resolve/main/tokenizer_config.json — chat template (conditional)
 *   - /{modelId}/resolve/main/config.json — architecture (conditional)
 *
 * All HTTP errors are non-fatal: returns null for affected fields and logs to stderr.
 */
class HuggingFaceResolver extends ModelResolver {
    constructor(options = {}) {
        super()
        this.baseUrl = options.baseUrl || 'https://huggingface.co'
        this.timeout = options.timeout || 5000
    }

    supportedPatterns() {
        return ['hf:*/*']
    }

    async fetchModelMetadata(modelId, options = {}) {
        const { fields } = options
        const metadata = {}

        // Fetch model info (always)
        const modelInfo = await this._fetchJson(
            `${this.baseUrl}/api/models/${modelId}`
        )
        if (modelInfo) {
            metadata.tags = modelInfo.tags || []
            metadata.gated = modelInfo.gated || false
            metadata.pipeline_tag = modelInfo.pipeline_tag || null
        }

        // Fetch tokenizer config (conditional)
        if (!fields || fields.includes('chat_template')) {
            const tokenizerConfig = await this._fetchJson(
                `${this.baseUrl}/${modelId}/resolve/main/tokenizer_config.json`
            )
            metadata.chat_template = tokenizerConfig?.chat_template || null
        }

        // Fetch model config (conditional)
        if (!fields || fields.includes('architecture')) {
            const modelConfig = await this._fetchJson(
                `${this.baseUrl}/${modelId}/resolve/main/config.json`
            )
            metadata.architecture = modelConfig?.architectures?.[0] || null
        }

        return Object.keys(metadata).length > 0 ? metadata : null
    }

    /**
     * Fetch JSON from a URL with timeout and error handling.
     * Returns null on any error (429, 404, network, timeout).
     *
     * @param {string} url - URL to fetch
     * @returns {Promise<object|null>}
     */
    async _fetchJson(url) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)
        try {
            const response = await fetch(url, { signal: controller.signal })
            clearTimeout(timer)
            if (response.status === 429) {
                process.stderr.write(
                    `[model-picker] Rate limited: ${url}\n`
                )
                return null
            }
            if (response.status === 404) return null
            if (!response.ok) return null
            return await response.json()
        } catch (err) {
            clearTimeout(timer)
            process.stderr.write(
                `[model-picker] Fetch failed: ${url} — ${err.message}\n`
            )
            return null
        }
    }
}


// ── ResolverRegistry ─────────────────────────────────────────────────────────

/**
 * ResolverRegistry — maps model ID patterns to their responsible ModelResolver.
 *
 * Each resolver is registered with a match function that determines whether
 * it can handle a given model ID. The first matching resolver wins.
 * A default resolver is used as fallback when no match function returns true.
 */
class ResolverRegistry {
    constructor() {
        this._resolvers = []
        this._defaultResolver = null
    }

    /**
     * Register a resolver with its match function.
     * @param {ModelResolver} resolver
     * @param {function(string): boolean} matchFn
     */
    register(resolver, matchFn) {
        this._resolvers.push({ resolver, matchFn })
    }

    /**
     * Set the fallback resolver used when no match function returns true.
     * @param {ModelResolver} resolver
     */
    setDefault(resolver) {
        this._defaultResolver = resolver
    }

    /**
     * Get the resolver for a given model ID.
     * @param {string} modelId
     * @returns {ModelResolver|null}
     */
    getResolver(modelId) {
        for (const { resolver, matchFn } of this._resolvers) {
            if (matchFn(modelId)) return resolver
        }
        return this._defaultResolver
    }
}

// ── Merge logic ──────────────────────────────────────────────────────────────

/**
 * Merge live API metadata with static catalog metadata.
 * Live data takes precedence for non-null fields.
 *
 * @param {object|null} liveData - Metadata from live API (e.g. HuggingFace)
 * @param {object|null} staticData - Metadata from static catalog
 * @returns {object|null} Merged metadata, or null if both inputs are null
 */
function mergeMetadata(liveData, staticData) {
    if (!liveData && !staticData) return null
    if (!liveData) return { ...staticData }
    if (!staticData) return { ...liveData }

    // Shallow merge: live takes precedence for non-null fields
    const merged = { ...staticData }
    for (const [key, value] of Object.entries(liveData)) {
        if (value !== null && value !== undefined) {
            merged[key] = value
        }
    }
    return merged
}

// ── Load catalogs ────────────────────────────────────────────────────────────

let POPULAR_MODELS_CATALOG

try {
    POPULAR_MODELS_CATALOG = {
        ...loadCatalog('./catalogs/popular-transformers.json'),
        ...loadCatalog('./catalogs/popular-diffusors.json')
    }
} catch (err) {
    process.stderr.write(`[model-picker] Fatal: ${err.message}\n`)
    process.exit(1)
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const staticResolver = new StaticCatalogResolver(POPULAR_MODELS_CATALOG)
const hfResolver = new HuggingFaceResolver()
const registry = new ResolverRegistry()

registry.register(
    hfResolver,
    id => /^[^/]+\/[^/]+$/.test(id) && !id.includes('://')
)
registry.setDefault(staticResolver)

// ── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Handle a get_models tool call.
 * Extracted as a standalone function so tests can call it directly.
 *
 * @param {object} params
 * @param {string} params.model_id - Model identifier
 * @param {string[]} [params.fields] - Metadata fields to return
 * @param {string} [params.mode] - 'static' or 'discover'
 * @param {object} [params.context] - Configuration context
 * @returns {Promise<{content: Array}>} MCP response
 */
async function resolveModel({ model_id, fields, mode = 'discover', context }) {
    let values = {}
    let message = null

    if (mode === 'static') {
        // Static mode: use StaticCatalogResolver only
        const metadata = await staticResolver.fetchModelMetadata(model_id, { fields })
        if (metadata) {
            values = { ...metadata }
        } else {
            message = `Model not found in static catalog: ${model_id}`
        }
    } else {
        // Discover mode: use ResolverRegistry for live data, merge with static
        const resolver = registry.getResolver(model_id)
        let liveData = null

        if (resolver) {
            liveData = await resolver.fetchModelMetadata(model_id, { fields })
        }

        const staticData = await staticResolver.fetchModelMetadata(model_id, { fields })
        const merged = mergeMetadata(liveData, staticData)

        if (merged) {
            values = { ...merged }
        } else {
            message = `Model not found: ${model_id}`
        }
    }

    // Filter fields if specified
    if (fields && fields.length > 0 && Object.keys(values).length > 0) {
        const filtered = {}
        for (const field of fields) {
            if (field in values) {
                filtered[field] = values[field]
            }
        }
        values = filtered
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({ values, choices: {}, message })
        }]
    }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'model-picker',
    version: '1.0.0'
})

server.tool(
    'get_models',
    'Returns model metadata for ML Container Creator',
    {
        model_id: z.string().min(1).describe('Model identifier'),
        fields: z.array(z.string()).optional().describe(
            'Metadata fields to return (omit for all)'
        ),
        mode: z.enum(['static', 'discover']).optional().default('discover')
            .describe('Operating mode'),
        context: z.record(z.string(), z.any()).optional().describe(
            'Current configuration context'
        )
    },
    async (params) => resolveModel(params)
)

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    loadCatalog,
    ModelResolver,
    StaticCatalogResolver,
    HuggingFaceResolver,
    ResolverRegistry,
    mergeMetadata,
    resolveModel,
    staticResolver,
    hfResolver,
    registry,
    POPULAR_MODELS_CATALOG
}

// ── Main guard ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename

if (isMain) {
    process.stderr.write('[model-picker] Starting model-picker MCP server\n')
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
