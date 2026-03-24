#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Image Picker MCP Server
 *
 * A bundled MCP server that returns curated base container images for all
 * frameworks. For transformer serving frameworks (vLLM, SGLang, TensorRT-LLM,
 * LMI, DJL), it returns framework-specific serving images from a static catalog.
 * For non-transformer frameworks (sklearn, xgboost, tensorflow), it returns
 * python:3.x-slim images with optional search filtering.
 *
 * Uses a pluggable ImageResolver architecture. V1 ships with StaticCatalogResolver.
 *
 * Tool: get_base_images
 *   Accepts: { parameters: string[], limit: number, context: object }
 *   Returns: { values, choices, metadata }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { DynamicResolver as DynamicResolverBase } from '../lib/dynamic-resolver.js'

// ── Catalog loader ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Load and parse a JSON catalog file relative to the server directory.
 * Throws on missing file or invalid JSON with the file path in the message.
 *
 * @param {string} relativePath - Path relative to server dir (e.g. './catalogs/regions.json')
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

// ── ImageResolver interface ──────────────────────────────────────────────────

/**
 * ImageResolver — image-specific dynamic resolver.
 *
 * Extends DynamicResolver with image-specific method names (fetchImages, supportedFrameworks)
 * that delegate to the generic fetch/supportedKeys interface.
 *
 * Each resolver knows how to fetch images from a specific registry source.
 * The MCP server delegates to the appropriate resolver based on framework/modelServer.
 */
class ImageResolver extends DynamicResolverBase {
    /**
     * Fetch available images for a given framework.
     *
     * @param {string} framework - The framework identifier (e.g., 'vllm', 'python-slim')
     * @param {object} options - Resolver-specific options
     * @param {number} options.limit - Maximum number of images to return
     * @param {string} [options.searchCriteria] - Optional filter string
     * @returns {Promise<{images: object[], defaultImage: string|null}>}
     */
    async fetchImages(framework, options = {}) {
        throw new Error('fetchImages() must be implemented by subclass')
    }

    /**
     * Returns the list of framework identifiers this resolver can handle.
     * @returns {string[]}
     */
    supportedFrameworks() {
        throw new Error('supportedFrameworks() must be implemented by subclass')
    }

    // ── DynamicResolver interface bridge ─────────────────────────────────

    async fetch(key, options = {}) {
        return this.fetchImages(key, options)
    }

    supportedKeys() {
        return this.supportedFrameworks()
    }
}

// ── Load catalogs from JSON files ─────────────────────────────────────────────

let TRANSFORMER_IMAGE_CATALOG
let PYTHON_SLIM_CATALOG
let TRITON_IMAGE_CATALOG

try {
    TRANSFORMER_IMAGE_CATALOG = loadCatalog('./catalogs/model-servers.json')
    PYTHON_SLIM_CATALOG = loadCatalog('./catalogs/python-slim.json')
    TRITON_IMAGE_CATALOG = loadCatalog('./catalogs/triton.json')
} catch (err) {
    process.stderr.write(`[base-image-picker] Fatal: ${err.message}\n`)
    process.exit(1)
}

// ── DynamicResolver ──────────────────────────────────────────────────────────

/**
 * DynamicResolver — fetches recent images from an external registry API.
 *
 * Implements ImageResolver so it can be registered in the ResolverRegistry
 * alongside StaticCatalogResolver. Only activated when --discover flag or
 * MCP_DISCOVER=true is set.
 */
class DynamicResolver extends ImageResolver {
    constructor(options = {}) {
        super()
        this._timeout = options.timeout || 5000
        // Registry API endpoints per framework
        this._registryEndpoints = {
            'vllm': 'https://hub.docker.com/v2/repositories/vllm/vllm-openai/tags',
            'sglang': 'https://hub.docker.com/v2/repositories/lmsysorg/sglang/tags',
            'djl': 'https://hub.docker.com/v2/repositories/deepjavalibrary/djl-serving/tags'
            // tensorrt-llm and lmi require auth — not supported in V1 discover
        }
    }

    async fetchImages(framework, options = {}) {
        const { limit = 5 } = options
        const endpoint = this._registryEndpoints[framework]
        if (!endpoint) {
            return { images: [], defaultImage: null }
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this._timeout)

        try {
            const response = await fetch(
                `${endpoint}?page_size=${limit}&ordering=-last_updated`,
                { signal: controller.signal }
            )
            clearTimeout(timer)

            if (!response.ok) {
                throw new Error(`Registry API returned ${response.status}`)
            }

            const data = await response.json()
            const images = (data.results || []).map(tag => ({
                image: `${this._repoForFramework(framework)}:${tag.name}`,
                tag: tag.name,
                architecture: 'amd64',
                created: tag.last_updated || tag.tag_last_pushed || new Date().toISOString(),
                labels: {},
                registry: 'dockerhub',
                repository: this._repoForFramework(framework)
            }))

            return {
                images: images.slice(0, limit),
                defaultImage: images[0]?.image || null
            }
        } catch (err) {
            log(`[discover] Registry API failed for ${framework}: ${err.message}`)
            return { images: [], defaultImage: null }
        } finally {
            clearTimeout(timer)
        }
    }

    supportedFrameworks() {
        return Object.keys(this._registryEndpoints)
    }

    _repoForFramework(framework) {
        const map = {
            'vllm': 'vllm/vllm-openai',
            'sglang': 'lmsysorg/sglang',
            'djl': 'deepjavalibrary/djl-serving'
        }
        return map[framework] || framework
    }
}

// ── Merge logic ──────────────────────────────────────────────────────────────

/**
 * Merge static catalog entries with dynamic registry results.
 *
 * Rules:
 * (a) Static entries come first, in their original order
 * (b) No duplicate image identifiers — static takes precedence
 * (c) Net-new dynamic entries follow, sorted by created date descending
 * (d) Result is capped at `limit`
 *
 * @param {object[]} staticImages - Static catalog entries (original order)
 * @param {object[]} dynamicImages - Dynamic registry entries
 * @param {number} [limit] - Optional cap on total results
 * @returns {object[]} Merged, deduplicated image list
 */
function mergeStaticAndDynamic(staticImages, dynamicImages, limit) {
    const staticIds = new Set(staticImages.map(e => e.image))
    const netNew = dynamicImages.filter(e => !staticIds.has(e.image))

    // Sort net-new by created desc
    netNew.sort((a, b) => new Date(b.created) - new Date(a.created))

    const merged = [...staticImages, ...netNew]
    return limit != null ? merged.slice(0, limit) : merged
}

// ── StaticCatalogResolver ────────────────────────────────────────────────────

/**
 * StaticCatalogResolver — V1 implementation.
 *
 * Returns images from the externalized catalog JSON files.
 * No network calls, no auth, no external dependencies.
 */
class StaticCatalogResolver extends ImageResolver {
    constructor(transformerCatalog, pythonSlimCatalog, tritonCatalog) {
        super()
        this._transformerCatalog = transformerCatalog
        this._pythonSlimCatalog = pythonSlimCatalog
        this._tritonCatalog = tritonCatalog || []
    }

    async fetchImages(framework, options = {}) {
        const { limit = 5, searchCriteria } = options

        if (framework === 'python-slim') {
            return this._resolvePythonSlim(limit, searchCriteria)
        }

        if (framework === 'triton') {
            return this._resolveTriton(limit, searchCriteria)
        }

        const catalog = this._transformerCatalog[framework] || []
        const sliced = catalog.slice(0, limit)
        return {
            images: sliced,
            defaultImage: sliced[0]?.image || null
        }
    }

    supportedFrameworks() {
        return [
            ...Object.keys(this._transformerCatalog),
            'python-slim',
            'triton'
        ]
    }

    _resolvePythonSlim(limit, searchCriteria) {
        let catalog = [...this._pythonSlimCatalog]

        if (searchCriteria && searchCriteria.trim()) {
            const query = searchCriteria.trim().toLowerCase()
            catalog = catalog.filter(entry =>
                entry.tag.toLowerCase().includes(query) ||
                entry.image.toLowerCase().includes(query) ||
                (entry.labels.python_version && entry.labels.python_version.toLowerCase().includes(query))
            )
        }

        const sliced = catalog.slice(0, limit)
        return {
            images: sliced,
            defaultImage: sliced[0]?.image || null
        }
    }

    _resolveTriton(limit, searchCriteria) {
        let catalog = [...this._tritonCatalog]

        if (searchCriteria && searchCriteria.trim()) {
            const query = searchCriteria.trim().toLowerCase()
            catalog = catalog.filter(entry =>
                entry.tag.toLowerCase().includes(query) ||
                entry.image.toLowerCase().includes(query) ||
                (entry.labels.triton_version && entry.labels.triton_version.toLowerCase().includes(query)) ||
                (entry.labels.cuda_version && entry.labels.cuda_version.toLowerCase().includes(query))
            )
        }

        const sliced = catalog.slice(0, limit)
        return {
            images: sliced,
            defaultImage: sliced[0]?.image || null
        }
    }
}

// ── ResolverRegistry ─────────────────────────────────────────────────────────

/**
 * ResolverRegistry — maps framework identifiers to their ImageResolver.
 *
 * V1: All frameworks → StaticCatalogResolver
 * Future: Each framework → its appropriate dynamic resolver
 */
class ResolverRegistry {
    constructor() {
        this._resolvers = new Map()
        this._defaultResolver = null
    }

    /**
     * Register a resolver for all its supported frameworks.
     * @param {ImageResolver} resolver
     */
    register(resolver) {
        for (const framework of resolver.supportedFrameworks()) {
            this._resolvers.set(framework, resolver)
        }
    }

    /**
     * Set the fallback resolver used when no framework-specific resolver is found.
     * @param {ImageResolver} resolver
     */
    setDefault(resolver) {
        this._defaultResolver = resolver
    }

    /**
     * Get the resolver for a given framework.
     * @param {string} framework
     * @returns {ImageResolver|null}
     */
    getResolver(framework) {
        return this._resolvers.get(framework) || this._defaultResolver
    }
}

// ── V1 wiring ────────────────────────────────────────────────────────────────

const staticResolver = new StaticCatalogResolver(TRANSFORMER_IMAGE_CATALOG, PYTHON_SLIM_CATALOG, TRITON_IMAGE_CATALOG)
const registry = new ResolverRegistry()
registry.register(staticResolver)
registry.setDefault(staticResolver)

// ── Discover mode ────────────────────────────────────────────────────────────

/**
 * Detect discover mode from CLI flag or environment variable.
 * --discover flag or MCP_DISCOVER=true activates discover mode.
 */
const discoverMode = process.argv.includes('--discover') ||
    process.env.MCP_DISCOVER === 'true'

let dynamicResolver = null

if (discoverMode) {
    dynamicResolver = new DynamicResolver()
    registry.register(dynamicResolver)
}

// ── Routing logic ────────────────────────────────────────────────────────────

/**
 * Resolve base images based on context.
 * Routes transformer frameworks by modelServer, non-transformers to python-slim.
 * When discover mode is active, merges static and dynamic results.
 */
async function resolveBaseImage(context, limit) {
    const { framework, modelServer, searchCriteria, architecture } = context

    // Determine which framework identifier to resolve
    let resolverKey
    if (architecture === 'triton') {
        resolverKey = 'triton'
    } else if (architecture === 'diffusors' && modelServer) {
        resolverKey = modelServer
    } else if (framework === 'transformers' && modelServer) {
        resolverKey = modelServer
    } else {
        resolverKey = 'python-slim'
    }

    const resolver = registry.getResolver(resolverKey)
    if (!resolver) {
        return { values: { baseImage: null }, choices: { baseImage: [] }, metadata: { baseImage: [] } }
    }

    let resultImages

    if (discoverMode && dynamicResolver && dynamicResolver.supportedFrameworks().includes(resolverKey)) {
        // Fetch both static and dynamic results, then merge
        const staticResult = await staticResolver.fetchImages(resolverKey, { limit, searchCriteria })
        const dynamicResult = await dynamicResolver.fetchImages(resolverKey, { limit: 5 })

        resultImages = mergeStaticAndDynamic(staticResult.images, dynamicResult.images, limit)
    } else {
        // Static-only path (no network calls)
        const result = await resolver.fetchImages(resolverKey, { limit, searchCriteria })
        resultImages = result.images
    }

    const images = resultImages.map(e => e.image)
    return {
        values: { baseImage: images[0] || null },
        choices: { baseImage: images },
        metadata: { baseImage: resultImages }
    }
}

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[base-image-picker] ${message}\n`)
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'base-image-picker',
    version: '1.0.0'
})

server.tool(
    'get_base_images',
    'Returns curated base container images for ML Container Creator Dockerfiles',
    {
        parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
        limit: z.number().int().positive().default(5).describe('Maximum number of choices per parameter'),
        context: z.record(z.string(), z.any()).optional().describe('Current configuration context (framework, modelServer, searchCriteria)')
    },
    async ({ parameters, limit, context }) => {
        const values = {}
        const choices = {}
        const metadata = {}

        if (parameters.includes('baseImage')) {
            const result = await resolveBaseImage(context || {}, limit)
            Object.assign(values, result.values)
            Object.assign(choices, result.choices)
            Object.assign(metadata, result.metadata)
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ values, choices, metadata })
            }]
        }
    }
)

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    loadCatalog,
    ImageResolver,
    StaticCatalogResolver,
    DynamicResolver,
    ResolverRegistry,
    TRANSFORMER_IMAGE_CATALOG,
    PYTHON_SLIM_CATALOG,
    TRITON_IMAGE_CATALOG,
    resolveBaseImage,
    mergeStaticAndDynamic,
    registry,
    staticResolver,
    dynamicResolver,
    discoverMode
}

export { DynamicResolverBase as DynamicResolverBase }

// ── Main guard ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename

if (isMain) {
    if (discoverMode) {
        log('Discover mode — serving curated catalogs + live registry lookups')
    } else {
        log('Static mode — serving curated base image catalogs')
    }
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
