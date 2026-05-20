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
        if (!fields || fields.includes('architecture') || fields.includes('model_type')) {
            const modelConfig = await this._fetchJson(
                `${this.baseUrl}/${modelId}/resolve/main/config.json`
            )
            metadata.architecture = modelConfig?.architectures?.[0] || null
            metadata.model_type = modelConfig?.model_type || null
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


// ── JumpStartPublicResolver ───────────────────────────────────────────────────

/**
 * Credential-related error names/codes that indicate missing or expired AWS credentials.
 * When these occur, the resolver falls back to the static catalog.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
    'CredentialsError',
    'CredentialsProviderError',
    'ExpiredTokenException',
    'ExpiredToken',
    'InvalidIdentityToken',
    'NoSuchTokenException',
    'UnrecognizedClientException'
])

/**
 * JumpStartPublicResolver — fetches model metadata from the JumpStart public
 * S3 cache bucket (`jumpstart-cache-prod-{region}`).
 *
 * Handles model IDs matching the `jumpstart://` URI prefix. Retrieves the
 * `models_manifest.json` to find the model's `spec_key`, then fetches the
 * full model spec JSON at that key (e.g.
 * `community_models/{model-id}/specs_v{version}.json`).
 *
 * Uses anonymous (unsigned) S3 requests since the bucket is publicly readable.
 * On S3 error or timeout, falls back to the static catalog.
 * AWS SDK is lazy-imported to keep the server fast in static mode.
 */
class JumpStartPublicResolver extends ModelResolver {
    constructor(options = {}) {
        super()
        this.timeout = options.timeout ?? 10000
        this.region = options.region || process.env.AWS_REGION || 'us-east-1'
        this._client = null
        this._sdkModule = null
        this._staticCatalog = options.staticCatalog || null
    }

    supportedPatterns() {
        return ['jumpstart://*']
    }

    /**
     * Fetch metadata for a JumpStart public model.
     *
     * For a specific model ID, fetches `models_manifest.json` from the
     * JumpStart S3 cache bucket, finds the latest version entry for the
     * requested model, then fetches the full spec JSON using the entry's
     * `spec_key`.
     *
     * For list mode (bareId === '*'), returns metadata from the first
     * manifest entry.
     *
     * @param {string} modelId - e.g. 'jumpstart://huggingface-llm-falcon-7b'
     * @param {object} options - { fields, context }
     * @returns {Promise<object|null>} ModelMetadata or null
     */
    async fetchModelMetadata(modelId, options = {}) {
        const bareId = modelId.replace(/^jumpstart:\/\//, '')

        try {
            const sdk = await this._loadSdk()
            const client = this._createClient(sdk)

            // Fetch the manifest
            const manifestCmd = new sdk.GetObjectCommand({
                Bucket: this._bucketName(),
                Key: 'models_manifest.json'
            })
            const manifestResp = await client.send(manifestCmd)
            const manifestBody = await manifestResp.Body.transformToString()
            const manifest = JSON.parse(manifestBody)

            if (!Array.isArray(manifest) || manifest.length === 0) {
                return null
            }

            // List mode — return metadata from the first manifest entry
            if (!bareId || bareId === '*') {
                return this._mapToMetadata(manifest[0], manifest[0].model_id || '*')
            }

            // Find the latest version entry for the requested model
            const entry = this._findLatestEntry(manifest, bareId)
            if (!entry || !entry.spec_key) {
                process.stderr.write(
                    `[jumpstart] Model not found in manifest: ${bareId}\n`
                )
                return this._fallbackToStaticCatalog(modelId)
            }

            // Fetch the full spec using the spec_key from the manifest
            const specCmd = new sdk.GetObjectCommand({
                Bucket: this._bucketName(),
                Key: entry.spec_key
            })
            const specResp = await client.send(specCmd)
            const specBody = await specResp.Body.transformToString()
            const spec = JSON.parse(specBody)
            return this._mapToMetadata(spec, bareId)
        } catch (err) {
            if (this._isCredentialError(err)) {
                process.stderr.write(
                    `[jumpstart] AWS credentials not available. Falling back to static catalog.\n`
                )
                return this._fallbackToStaticCatalog(modelId)
            }

            process.stderr.write(
                `[jumpstart] JumpStart S3 bucket unreachable: ${err.name || err.code || 'Unknown'}. Falling back to static catalog.\n`
            )
            return this._fallbackToStaticCatalog(modelId)
        }
    }

    /**
     * Find the latest non-deprecated manifest entry for a given model ID.
     *
     * The manifest contains multiple version entries per model. This method
     * finds the first non-deprecated entry (manifest is sorted newest-first
     * per model).
     *
     * @param {Array} manifest - Parsed models_manifest.json array
     * @param {string} bareId - Model ID without the jumpstart:// prefix
     * @returns {object|null} Manifest entry or null
     */
    _findLatestEntry(manifest, bareId) {
        return manifest.find(e => e.model_id === bareId && !e.deprecated) ||
               manifest.find(e => e.model_id === bareId) ||
               null
    }

    /**
     * Lazy-load the @aws-sdk/client-s3 module.
     * @returns {Promise<object>} The SDK module
     */
    async _loadSdk() {
        if (!this._sdkModule) {
            this._sdkModule = await import('@aws-sdk/client-s3')
        }
        return this._sdkModule
    }

    /**
     * Create an S3Client configured for anonymous (unsigned) access to the
     * JumpStart public cache bucket. Reuses the client across calls.
     *
     * The JumpStart cache bucket is publicly readable, so requests are sent
     * without AWS credentials — equivalent to `--no-sign-request` in the CLI.
     *
     * @param {object} sdk - The loaded @aws-sdk/client-s3 module
     * @returns {object} S3Client instance
     */
    _createClient(sdk) {
        if (!this._client) {
            this._client = new sdk.S3Client({
                region: this.region,
                requestHandler: {
                    requestTimeout: this.timeout
                },
                signer: { sign: async (request) => request }
            })
        }
        return this._client
    }

    /**
     * Return the JumpStart public cache bucket name for the configured region.
     * @returns {string} Bucket name
     */
    _bucketName() {
        return `jumpstart-cache-prod-${this.region}`
    }

    /**
     * Map a JumpStart model spec JSON object (or manifest entry) to the
     * common ModelMetadata shape.
     *
     * Handles both full spec objects (from spec_key fetch) and manifest
     * entries. Full specs have fields like `hosting_ecr_specs`, `provider`,
     * `url`, `supported_inference_instance_types`. Manifest entries have
     * `model_id`, `version`, `spec_key`, `provider`, `search_keywords`.
     *
     * @param {object} spec - JumpStart model spec JSON or manifest entry
     * @param {string} bareId - The model ID without the jumpstart:// prefix
     * @returns {object} ModelMetadata
     */
    _mapToMetadata(spec, bareId) {
        if (!spec) return null

        const modelId = spec.model_id || bareId
        const metadata = {
            provider: 'jumpstart',
            modelId: `jumpstart://${modelId}`,
            description: this._humanReadableId(modelId)
        }

        // Extract framework from hosting_ecr_specs (full spec) or spec.framework
        const framework = spec.hosting_ecr_specs?.framework ||
                          spec.hosting_ecr_specs?.Framework ||
                          spec.framework
        if (framework) {
            metadata.framework = framework
        }

        // Extract tags from search_keywords or task-related fields
        const tags = []
        if (Array.isArray(spec.search_keywords)) {
            tags.push(...spec.search_keywords)
        }
        if (spec.model_type) tags.push(spec.model_type)
        if (spec.inference_task) tags.push(spec.inference_task)
        if (tags.length > 0) {
            metadata.tags = [...new Set(tags)]
        }

        // Extract default instance type if available
        if (spec.default_inference_instance_type) {
            metadata.defaultInstanceType = spec.default_inference_instance_type
        }

        // Extract supported instance types if available
        if (Array.isArray(spec.supported_inference_instance_types) &&
            spec.supported_inference_instance_types.length > 0) {
            metadata.supportedInstanceTypes = spec.supported_inference_instance_types
        }

        // Extract artifact URI from hosting artifact keys
        // Prefer hosting_prepacked_artifact_key (pre-packaged model ready for serving)
        // Fall back to hosting_artifact_key (raw model artifacts)
        const artifactKey = spec.hosting_prepacked_artifact_key || spec.hosting_artifact_key
        if (artifactKey) {
            metadata.artifactUri = `s3://${this._bucketName()}/${artifactKey}`
        } else {
            process.stderr.write(
                `[jumpstart] No artifact key found for model ${modelId}. artifactUri will be undefined.\n`
            )
        }

        return metadata
    }

    /**
     * Convert a model ID like "huggingface-reasoning-qwen3-8b" into a
     * human-readable description: "Huggingface Reasoning Qwen3 8b".
     *
     * @param {string} id - Raw model ID
     * @returns {string} Title-cased, space-separated description
     */
    _humanReadableId(id) {
        if (!id) return ''
        return id
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ')
    }

    /**
     * Check if an error is a credential-related error.
     * @param {Error} err
     * @returns {boolean}
     */
    _isCredentialError(err) {
        return CREDENTIAL_ERROR_NAMES.has(err.name) ||
            CREDENTIAL_ERROR_NAMES.has(err.Code) ||
            (err.message && err.message.includes('credentials'))
    }

    /**
     * Fall back to the static catalog for a given model ID.
     * @param {string} modelId - Full model ID with jumpstart:// prefix
     * @returns {object|null} Static catalog entry or null
     */
    _fallbackToStaticCatalog(modelId) {
        if (this._staticCatalog && this._staticCatalog[modelId]) {
            return { ...this._staticCatalog[modelId] }
        }
        return null
    }
}


// ── JumpStartPrivateResolver ──────────────────────────────────────────────────

/**
 * JumpStartPrivateResolver — fetches model metadata from a private SageMaker
 * JumpStart model hub via the SageMaker API.
 *
 * Handles model IDs matching the `jumpstart-hub://` URI prefix. Parses the URI
 * into hub name and model name, then queries:
 *   - ListHubContents — browse models in a private hub
 *   - DescribeHubContent — get detailed metadata for a specific model in a hub
 *
 * Distinct error handling:
 *   - ResourceNotFoundException for hub → "Hub not found: {hubName}"
 *   - ResourceNotFoundException for model → "Model not found in hub: {hubName}/{modelName}"
 *   - AccessDeniedException → "Access denied to hub: {hubName}" (no credential details)
 *   - Credential failure → return null + log to stderr
 *
 * AWS SDK is lazy-imported to keep the server fast in static mode.
 */
class JumpStartPrivateResolver extends ModelResolver {
    constructor(options = {}) {
        super()
        this.timeout = options.timeout ?? 10000
        this.region = options.region || process.env.AWS_REGION || 'us-east-1'
        this._client = null
        this._sdkModule = null
    }

    supportedPatterns() {
        return ['jumpstart-hub://*']
    }

    /**
     * Parse a jumpstart-hub:// URI into hub name and model name.
     *
     * @param {string} modelId - e.g. 'jumpstart-hub://my-hub/my-model'
     * @returns {{ hubName: string, modelName: string } | null}
     */
    _parseHubUri(modelId) {
        const withoutPrefix = modelId.replace(/^jumpstart-hub:\/\//, '')
        if (!withoutPrefix) return null

        const slashIndex = withoutPrefix.indexOf('/')
        if (slashIndex === -1) {
            // Only hub name, no model name — list mode
            return { hubName: withoutPrefix, modelName: null }
        }

        const hubName = withoutPrefix.slice(0, slashIndex)
        const modelName = withoutPrefix.slice(slashIndex + 1) || null

        if (!hubName) return null
        return { hubName, modelName }
    }

    /**
     * Fetch metadata for a model in a private JumpStart hub.
     *
     * @param {string} modelId - e.g. 'jumpstart-hub://my-hub/my-model'
     * @param {object} options - { fields, context }
     * @returns {Promise<object|null>} ModelMetadata or null
     */
    async fetchModelMetadata(modelId, options = {}) {
        const parsed = this._parseHubUri(modelId)
        if (!parsed) {
            process.stderr.write(
                `[jumpstart-hub] Invalid hub URI: ${modelId}\n`
            )
            return null
        }

        const { hubName, modelName } = parsed

        try {
            const sdk = await this._loadSdk()
            const client = this._createClient(sdk)

            // If a specific model is requested, describe it
            if (modelName) {
                const command = new sdk.DescribeHubContentCommand({
                    HubName: hubName,
                    HubContentName: modelName,
                    HubContentType: 'Model'
                })
                const response = await client.send(command)
                return this._mapToMetadata(response, hubName)
            }

            // Otherwise list hub contents
            const command = new sdk.ListHubContentsCommand({
                HubName: hubName,
                HubContentType: 'Model'
            })
            const response = await client.send(command)
            if (response.HubContentSummaries && response.HubContentSummaries.length > 0) {
                return this._mapToMetadata(response.HubContentSummaries[0], hubName)
            }

            return null
        } catch (err) {
            return this._handleError(err, hubName, modelName)
        }
    }

    /**
     * Lazy-load the @aws-sdk/client-sagemaker module.
     * @returns {Promise<object>} The SDK module
     */
    async _loadSdk() {
        if (!this._sdkModule) {
            this._sdkModule = await import('@aws-sdk/client-sagemaker')
        }
        return this._sdkModule
    }

    /**
     * Create a SageMakerClient with region and timeout configuration.
     * Reuses the client across calls.
     *
     * @param {object} sdk - The loaded @aws-sdk/client-sagemaker module
     * @returns {object} SageMakerClient instance
     */
    _createClient(sdk) {
        if (!this._client) {
            this._client = new sdk.SageMakerClient({
                region: this.region,
                requestHandler: {
                    requestTimeout: this.timeout
                }
            })
        }
        return this._client
    }

    /**
     * Map a JumpStart hub API response to the common ModelMetadata shape.
     *
     * @param {object} apiResponse - DescribeHubContent or HubContentSummary from the API
     * @param {string} hubName - The hub name from the URI
     * @returns {object} ModelMetadata
     */
    _mapToMetadata(apiResponse, hubName) {
        if (!apiResponse) return null

        const contentName = apiResponse.HubContentName || apiResponse.HubContentDisplayName || ''
        const metadata = {
            provider: 'jumpstart-hub',
            modelId: `jumpstart-hub://${hubName}/${contentName}`,
            description: apiResponse.HubContentDescription || apiResponse.HubContentDisplayName || contentName,
            hubName
        }

        // Extract framework from hub content document schema or search keywords
        if (apiResponse.HubContentDocument) {
            try {
                const doc = typeof apiResponse.HubContentDocument === 'string'
                    ? JSON.parse(apiResponse.HubContentDocument)
                    : apiResponse.HubContentDocument
                if (doc.Framework) {
                    metadata.framework = doc.Framework
                }
                if (doc.ModelFormat) {
                    metadata.modelFormat = doc.ModelFormat
                }
                // artifactUri extraction (Requirement 1.2): extract from
                // HubContentDocument — check both ArtifactUri and HostingArtifactUri
                // as the field name varies by hub content document schema
                if (doc.ArtifactUri) {
                    metadata.artifactUri = doc.ArtifactUri
                } else if (doc.HostingArtifactUri) {
                    metadata.artifactUri = doc.HostingArtifactUri
                }
            } catch {
                // Ignore JSON parse errors in hub content document
            }
        }

        // Extract tags from search keywords
        if (Array.isArray(apiResponse.HubContentSearchKeywords)) {
            metadata.tags = apiResponse.HubContentSearchKeywords
        }

        return metadata
    }

    /**
     * Check if an error is a credential-related error.
     * @param {Error} err
     * @returns {boolean}
     */
    _isCredentialError(err) {
        return CREDENTIAL_ERROR_NAMES.has(err.name) ||
            CREDENTIAL_ERROR_NAMES.has(err.Code) ||
            (err.message && err.message.includes('credentials'))
    }

    /**
     * Handle errors from SageMaker API calls with distinct error messages.
     *
     * @param {Error} err - The caught error
     * @param {string} hubName - The hub name from the URI
     * @param {string|null} modelName - The model name, if provided
     * @returns {null}
     */
    _handleError(err, hubName, modelName) {
        if (this._isCredentialError(err)) {
            process.stderr.write(
                `[jumpstart-hub] AWS credentials required for private hub access.\n`
            )
            return null
        }

        if (err.name === 'ResourceNotFoundException' || err.Code === 'ResourceNotFoundException') {
            if (modelName) {
                process.stderr.write(
                    `[jumpstart-hub] Model not found in hub: ${hubName}/${modelName}\n`
                )
            } else {
                process.stderr.write(
                    `[jumpstart-hub] Hub not found: ${hubName}\n`
                )
            }
            return null
        }

        if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException' ||
            err.$metadata?.httpStatusCode === 403) {
            process.stderr.write(
                `[jumpstart-hub] Access denied to hub: ${hubName}\n`
            )
            return null
        }

        process.stderr.write(
            `[jumpstart-hub] SageMaker API error: ${err.name || err.code || 'Unknown'}.\n`
        )
        return null
    }
}


// ── ModelRegistryResolver ──────────────────────────────────────────────────────

/**
 * ModelRegistryResolver — fetches model metadata from SageMaker Model Registry
 * via the SageMaker API.
 *
 * Handles model IDs matching the `registry://` URI prefix. Parses the URI
 * into group name and optional version, then queries:
 *   - ListModelPackages — list versions in a model package group (no version)
 *   - DescribeModelPackage — get detailed metadata for a specific version
 *
 * On credential failure or group not found, returns null and logs to stderr.
 * AWS SDK is lazy-imported to keep the server fast in static mode.
 */
class ModelRegistryResolver extends ModelResolver {
    constructor(options = {}) {
        super()
        this.timeout = options.timeout ?? 10000
        this.region = options.region || process.env.AWS_REGION || 'us-east-1'
        this._client = null
        this._sdkModule = null
    }

    supportedPatterns() {
        return ['registry://*']
    }

    /**
     * Parse a registry:// URI into group name and optional version.
     *
     * @param {string} modelId - e.g. 'registry://my-model-group/3'
     * @returns {{ groupName: string, version: string|null } | null}
     */
    _parseRegistryUri(modelId) {
        const withoutPrefix = modelId.replace(/^registry:\/\//, '')
        if (!withoutPrefix) return null

        const slashIndex = withoutPrefix.indexOf('/')
        if (slashIndex === -1) {
            // Only group name, no version — list mode
            return { groupName: withoutPrefix, version: null }
        }

        const groupName = withoutPrefix.slice(0, slashIndex)
        const version = withoutPrefix.slice(slashIndex + 1) || null

        if (!groupName) return null
        return { groupName, version }
    }

    /**
     * Fetch metadata for a model in SageMaker Model Registry.
     *
     * @param {string} modelId - e.g. 'registry://my-model-group/3'
     * @param {object} options - { fields, context }
     * @returns {Promise<object|null>} ModelMetadata or null
     */
    async fetchModelMetadata(modelId, options = {}) {
        const parsed = this._parseRegistryUri(modelId)
        if (!parsed) {
            process.stderr.write(
                `[registry] Invalid registry URI: ${modelId}\n`
            )
            return null
        }

        const { groupName, version } = parsed

        try {
            const sdk = await this._loadSdk()
            const client = this._createClient(sdk)

            // If a specific version is requested, describe that model package
            if (version) {
                const command = new sdk.DescribeModelPackageCommand({
                    ModelPackageName: `${groupName}/${version}`
                })
                const response = await client.send(command)
                return this._mapToMetadata(response, groupName)
            }

            // Otherwise list model packages in the group
            const command = new sdk.ListModelPackagesCommand({
                ModelPackageGroupName: groupName
            })
            const response = await client.send(command)
            if (response.ModelPackageSummaryList && response.ModelPackageSummaryList.length > 0) {
                return this._mapToMetadata(response.ModelPackageSummaryList[0], groupName)
            }

            return null
        } catch (err) {
            return this._handleError(err, groupName)
        }
    }

    /**
     * Lazy-load the @aws-sdk/client-sagemaker module.
     * @returns {Promise<object>} The SDK module
     */
    async _loadSdk() {
        if (!this._sdkModule) {
            this._sdkModule = await import('@aws-sdk/client-sagemaker')
        }
        return this._sdkModule
    }

    /**
     * Create a SageMakerClient with region and timeout configuration.
     * Reuses the client across calls.
     *
     * @param {object} sdk - The loaded @aws-sdk/client-sagemaker module
     * @returns {object} SageMakerClient instance
     */
    _createClient(sdk) {
        if (!this._client) {
            this._client = new sdk.SageMakerClient({
                region: this.region,
                requestHandler: {
                    requestTimeout: this.timeout
                }
            })
        }
        return this._client
    }

    /**
     * Map a Model Registry API response to the common ModelMetadata shape.
     *
     * @param {object} apiResponse - DescribeModelPackage or ModelPackageSummary from the API
     * @param {string} groupName - The model package group name from the URI
     * @returns {object} ModelMetadata
     */
    _mapToMetadata(apiResponse, groupName) {
        if (!apiResponse) return null

        const metadata = {
            provider: 'registry',
            modelId: `registry://${groupName}`,
            description: apiResponse.ModelPackageDescription || `Model package group: ${groupName}`
        }

        // Model package ARN
        if (apiResponse.ModelPackageArn) {
            metadata.modelPackageArn = apiResponse.ModelPackageArn
        }

        // Group name
        metadata.modelPackageGroupName = apiResponse.ModelPackageGroupName || groupName

        // Version
        if (apiResponse.ModelPackageVersion !== undefined && apiResponse.ModelPackageVersion !== null) {
            metadata.modelPackageVersion = apiResponse.ModelPackageVersion
            metadata.modelId = `registry://${groupName}/${apiResponse.ModelPackageVersion}`
        }

        // Approval status
        if (apiResponse.ModelApprovalStatus) {
            metadata.approvalStatus = apiResponse.ModelApprovalStatus
        }

        // artifactUri extraction (Requirement 1.3): extract from
        // InferenceSpecification.Containers[0].ModelDataUrl — the S3 URI
        // where the registered model package stores its inference artifacts
        const container = apiResponse.InferenceSpecification?.Containers?.[0]
        if (container) {
            if (container.Framework) {
                metadata.framework = container.Framework
            }
            if (container.ModelDataUrl) {
                metadata.artifactUri = container.ModelDataUrl
            }
        }

        // Fallback: top-level ModelDataUrl when InferenceSpecification is absent
        if (!metadata.artifactUri && apiResponse.ModelDataUrl) {
            metadata.artifactUri = apiResponse.ModelDataUrl
        }

        return metadata
    }

    /**
     * Check if an error is a credential-related error.
     * @param {Error} err
     * @returns {boolean}
     */
    _isCredentialError(err) {
        return CREDENTIAL_ERROR_NAMES.has(err.name) ||
            CREDENTIAL_ERROR_NAMES.has(err.Code) ||
            (err.message && err.message.includes('credentials'))
    }

    /**
     * Handle errors from SageMaker API calls with distinct error messages.
     *
     * @param {Error} err - The caught error
     * @param {string} groupName - The model package group name from the URI
     * @returns {null}
     */
    _handleError(err, groupName) {
        if (this._isCredentialError(err)) {
            process.stderr.write(
                `[registry] AWS credentials required for Model Registry access.\n`
            )
            return null
        }

        if (err.name === 'ResourceNotFoundException' || err.Code === 'ResourceNotFoundException' ||
            err.name === 'ValidationException') {
            process.stderr.write(
                `[registry] Model package group not found: ${groupName}\n`
            )
            return null
        }

        if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException' ||
            err.$metadata?.httpStatusCode === 403) {
            process.stderr.write(
                `[registry] Access denied to model package group: ${groupName}\n`
            )
            return null
        }

        process.stderr.write(
            `[registry] SageMaker API error: ${err.name || err.code || 'Unknown'}.\n`
        )
        return null
    }
}


// ── S3Resolver ────────────────────────────────────────────────────────────────

/**
 * S3Resolver — validates S3 URIs and inspects model artifacts stored in Amazon S3.
 *
 * Handles model IDs matching the `s3://` URI prefix. Uses:
 *   - HeadObject — check single-file artifacts (e.g. model.tar.gz)
 *   - ListObjectsV2 — inspect directory-style artifacts
 *
 * Infers framework from config files (config.json, tokenizer_config.json,
 * serving.properties) when the artifact is a directory.
 *
 * On credential failure, bucket/key not found, or access denied, returns null
 * with a descriptive message logged to stderr. AWS SDK is lazy-imported.
 */
class S3Resolver extends ModelResolver {
    constructor(options = {}) {
        super()
        this.timeout = options.timeout ?? 10000
        this.region = options.region || process.env.AWS_REGION || 'us-east-1'
        this._client = null
        this._sdkModule = null
    }

    supportedPatterns() {
        return ['s3://*']
    }

    /**
     * Fetch metadata for a model artifact in S3.
     *
     * @param {string} modelId - e.g. 's3://my-bucket/path/to/model.tar.gz'
     * @param {object} options - { fields, context }
     * @returns {Promise<object|null>} ModelMetadata or null
     */
    async fetchModelMetadata(modelId, options = {}) {
        const parsed = parseS3Uri(modelId)
        if (parsed.error) {
            process.stderr.write(
                `[s3] Invalid S3 URI: ${parsed.error}\n`
            )
            return null
        }

        const { bucket, key } = parsed

        try {
            const sdk = await this._loadSdk()
            const client = this._createClient(sdk)

            // Try HeadObject first to check if it's a single file
            if (key && !key.endsWith('/')) {
                try {
                    const headCommand = new sdk.HeadObjectCommand({
                        Bucket: bucket,
                        Key: key
                    })
                    const headResponse = await client.send(headCommand)

                    const artifactType = key.endsWith('.tar.gz') || key.endsWith('.tgz')
                        ? 'tarball' : 'single-file'

                    const metadata = {
                        provider: 's3',
                        modelId,
                        description: `S3 model artifact: ${modelId}`,
                        // artifactUri extraction (Requirement 1.4): for S3 models,
                        // artifactUri is the original s3:// URI itself — the model
                        // is already in S3, so no additional resolution is needed
                        artifactUri: modelId,
                        artifactType,
                        artifactSizeBytes: headResponse.ContentLength ?? null,
                        lastModified: headResponse.LastModified
                            ? headResponse.LastModified.toISOString() : null
                    }

                    return metadata
                } catch (headErr) {
                    // If it's a 404, the key might be a directory prefix — fall through to ListObjectsV2
                    if (headErr.name !== 'NotFound' && headErr.$metadata?.httpStatusCode !== 404) {
                        throw headErr
                    }
                }
            }

            // List objects under the key prefix (directory-style artifact)
            const prefix = key ? (key.endsWith('/') ? key : key + '/') : ''
            const listCommand = new sdk.ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                MaxKeys: 1000
            })
            const listResponse = await client.send(listCommand)

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                process.stderr.write(
                    `[s3] Key not found: ${bucket}/${key}\n`
                )
                return null
            }

            // Calculate total size and find last modified
            let totalSize = 0
            let latestModified = null
            const fileNames = []

            for (const obj of listResponse.Contents) {
                totalSize += obj.Size ?? 0
                if (obj.LastModified && (!latestModified || obj.LastModified > latestModified)) {
                    latestModified = obj.LastModified
                }
                // Extract relative file name from the key
                const relativeName = prefix ? obj.Key.slice(prefix.length) : obj.Key
                if (relativeName) {
                    fileNames.push(relativeName)
                }
            }

            // Try to infer framework from config files
            const configFiles = {}
            const configFileNames = ['config.json', 'tokenizer_config.json', 'serving.properties']

            for (const cfgName of configFileNames) {
                if (fileNames.includes(cfgName)) {
                    try {
                        const getCommand = new sdk.GetObjectCommand({
                            Bucket: bucket,
                            Key: prefix + cfgName
                        })
                        const getResponse = await client.send(getCommand)
                        const body = await getResponse.Body.transformToString()
                        configFiles[cfgName] = body
                    } catch {
                        // Ignore errors reading individual config files
                    }
                }
            }

            const framework = this._inferFramework(configFiles)

            const metadata = {
                provider: 's3',
                modelId,
                description: `S3 model directory: ${modelId}`,
                // artifactUri extraction (Requirement 1.4): for S3 models,
                // artifactUri is the original s3:// URI itself — the model
                // is already in S3, so no additional resolution is needed
                artifactUri: modelId,
                artifactType: 'directory',
                artifactSizeBytes: totalSize,
                lastModified: latestModified ? latestModified.toISOString() : null
            }

            if (framework) {
                metadata.framework = framework
            }

            return metadata
        } catch (err) {
            return this._handleError(err, bucket, key, modelId)
        }
    }

    /**
     * Infer the ML framework from config file contents.
     *
     * @param {object} configFiles - Map of filename → file content string
     * @returns {string|null} Inferred framework name or null
     */
    _inferFramework(configFiles) {
        // Check config.json for HuggingFace transformer architectures
        if (configFiles['config.json']) {
            try {
                const config = JSON.parse(configFiles['config.json'])
                if (config.architectures && Array.isArray(config.architectures) && config.architectures.length > 0) {
                    return 'huggingface'
                }
                if (config.model_type) {
                    return 'huggingface'
                }
            } catch {
                // Invalid JSON — skip
            }
        }

        // Check tokenizer_config.json — presence implies HuggingFace
        if (configFiles['tokenizer_config.json']) {
            try {
                JSON.parse(configFiles['tokenizer_config.json'])
                return 'huggingface'
            } catch {
                // Invalid JSON — skip
            }
        }

        // Check serving.properties for DJL serving configuration
        if (configFiles['serving.properties']) {
            const content = configFiles['serving.properties']
            if (content.includes('model_id') || content.includes('option.model_id')) {
                return 'djl'
            }
        }

        return null
    }

    /**
     * Lazy-load the @aws-sdk/client-s3 module.
     * @returns {Promise<object>} The SDK module
     */
    async _loadSdk() {
        if (!this._sdkModule) {
            this._sdkModule = await import('@aws-sdk/client-s3')
        }
        return this._sdkModule
    }

    /**
     * Create an S3Client with region and timeout configuration.
     * Reuses the client across calls.
     *
     * @param {object} sdk - The loaded @aws-sdk/client-s3 module
     * @returns {object} S3Client instance
     */
    _createClient(sdk) {
        if (!this._client) {
            this._client = new sdk.S3Client({
                region: this.region,
                requestHandler: {
                    requestTimeout: this.timeout
                }
            })
        }
        return this._client
    }

    /**
     * Check if an error is a credential-related error.
     * @param {Error} err
     * @returns {boolean}
     */
    _isCredentialError(err) {
        return CREDENTIAL_ERROR_NAMES.has(err.name) ||
            CREDENTIAL_ERROR_NAMES.has(err.Code) ||
            (err.message && err.message.includes('credentials'))
    }

    /**
     * Handle errors from S3 API calls with distinct error messages.
     *
     * @param {Error} err - The caught error
     * @param {string} bucket - The bucket name
     * @param {string} key - The object key
     * @param {string} uri - The original S3 URI
     * @returns {null}
     */
    _handleError(err, bucket, key, uri) {
        if (this._isCredentialError(err)) {
            process.stderr.write(
                `[s3] AWS credentials required for S3 access.\n`
            )
            return null
        }

        if (err.name === 'NoSuchBucket' || err.Code === 'NoSuchBucket') {
            process.stderr.write(
                `[s3] Bucket not found: ${bucket}\n`
            )
            return null
        }

        if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' ||
            err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            process.stderr.write(
                `[s3] Key not found: ${bucket}/${key}\n`
            )
            return null
        }

        if (err.name === 'AccessDenied' || err.Code === 'AccessDenied' ||
            err.$metadata?.httpStatusCode === 403) {
            process.stderr.write(
                `[s3] Access denied: ${uri}\n`
            )
            return null
        }

        process.stderr.write(
            `[s3] S3 API error: ${err.name || err.code || 'Unknown'}.\n`
        )
        return null
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

// ── S3 URI parsing ───────────────────────────────────────────────────────────

/**
 * Regex for valid S3 bucket names: 3–63 chars, lowercase letters/numbers/hyphens/periods,
 * no consecutive periods, not an IP address format.
 */
const S3_BUCKET_REGEX = /^(?!(\d{1,3}\.){3}\d{1,3}$)[a-z0-9]([a-z0-9.\-]*[a-z0-9])?$/

/**
 * Parse and validate an S3 URI into bucket and key components.
 * Never throws — returns { bucket, key } on success or { error } on failure.
 *
 * Validation rules:
 *   - Must start with 's3://'
 *   - Bucket: 3–63 chars, lowercase letters/numbers/hyphens/periods,
 *     no consecutive periods, no IP address format
 *   - Key: ≤ 1024 characters
 *
 * @param {string} uri - e.g. 's3://my-bucket/path/to/model.tar.gz'
 * @returns {{ bucket: string, key: string } | { error: string }}
 */
function parseS3Uri(uri) {
    if (typeof uri !== 'string') {
        return { error: 'S3 URI must be a string' }
    }

    if (!uri.startsWith('s3://')) {
        return { error: 'S3 URI must start with s3://' }
    }

    const withoutPrefix = uri.slice(5) // strip 's3://'
    const slashIndex = withoutPrefix.indexOf('/')
    const bucket = slashIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, slashIndex)
    const key = slashIndex === -1 ? '' : withoutPrefix.slice(slashIndex + 1)

    // Validate bucket name
    if (bucket.length === 0) {
        return { error: 'Bucket name must not be empty' }
    }
    if (bucket.length < 3 || bucket.length > 63) {
        return { error: `Bucket name must be 3–63 characters, got ${bucket.length}` }
    }
    if (bucket.includes('..')) {
        return { error: 'Bucket name must not contain consecutive periods' }
    }
    if (!S3_BUCKET_REGEX.test(bucket)) {
        return { error: `Invalid bucket name: ${bucket}` }
    }

    // Validate key length
    if (key.length > 1024) {
        return { error: `Key must be ≤ 1024 characters, got ${key.length}` }
    }

    return { bucket, key }
}

/**
 * Reconstruct an S3 URI from bucket and key components.
 *
 * @param {string} bucket
 * @param {string} key
 * @returns {string} 's3://<bucket>/<key>'
 */
function buildS3Uri(bucket, key) {
    return `s3://${bucket}/${key}`
}

// ── Load catalogs ────────────────────────────────────────────────────────────

let POPULAR_MODELS_CATALOG

try {
    POPULAR_MODELS_CATALOG = {
        ...loadCatalog('../lib/catalogs/models.json'),
        ...loadCatalog('../lib/catalogs/jumpstart-public.json')
    }
} catch (err) {
    process.stderr.write(`[model-picker] Fatal: ${err.message}\n`)
    process.exit(1)
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const staticResolver = new StaticCatalogResolver(POPULAR_MODELS_CATALOG)
const hfResolver = new HuggingFaceResolver()
const jumpStartPublicResolver = new JumpStartPublicResolver()
const jumpStartPrivateResolver = new JumpStartPrivateResolver()
const modelRegistryResolver = new ModelRegistryResolver()
const s3Resolver = new S3Resolver()
const registry = new ResolverRegistry()

registry.register(
    jumpStartPublicResolver,
    id => id.startsWith('jumpstart://')
)
registry.register(
    jumpStartPrivateResolver,
    id => id.startsWith('jumpstart-hub://')
)
registry.register(
    modelRegistryResolver,
    id => id.startsWith('registry://')
)
registry.register(
    s3Resolver,
    id => id.startsWith('s3://')
)
registry.register(
    hfResolver,
    id => /^[^/]+\/[^/]+$/.test(id) && !id.includes('://')
)
registry.setDefault(staticResolver)

// ── Choice formatting helpers ─────────────────────────────────────────────────

/**
 * Provider prefix label mapping for model choice formatting.
 */
const PROVIDER_LABELS = {
    'jumpstart': '[JumpStart]',
    'jumpstart-hub': '[JumpStart Hub]',
    'registry': '[Registry]',
    's3': '[S3]',
    'huggingface': '[HuggingFace]'
}

/**
 * Format a model choice with a provider prefix label.
 *
 * @param {object} metadata - Model metadata object with `provider` and `modelId` fields
 * @returns {string} Formatted choice string, e.g. '[JumpStart] huggingface-llm-falcon-7b'
 */
function formatModelChoice(metadata) {
    if (!metadata || !metadata.modelId) return ''
    const label = PROVIDER_LABELS[metadata.provider]
    if (label) {
        return `${label} ${metadata.modelId}`
    }
    return metadata.modelId
}

/**
 * Filter an array of model metadata objects by provider.
 *
 * @param {object[]} models - Array of model metadata objects
 * @param {string} provider - Provider string to filter by
 * @returns {object[]} Filtered array containing only models whose `provider` matches
 */
function filterByProvider(models, provider) {
    if (!Array.isArray(models) || !provider) return models || []
    return models.filter(m => m && m.provider === provider)
}

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

    // Reject deprecated JumpStart prefixes
    if (model_id.startsWith('jumpstart://') || model_id.startsWith('jumpstart-hub://')) {
        const bareId = model_id.replace(/^jumpstart(-hub)?:\/\//, '')
        message = `JumpStart is no longer supported. Use the HuggingFace model ID directly: ${bareId}`
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ values: {}, choices: {}, message })
            }]
        }
    }

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
        let resolverFailed = false

        if (resolver) {
            liveData = await resolver.fetchModelMetadata(model_id, { fields })
            if (liveData === null) {
                resolverFailed = true
            }
        }

        const staticData = await staticResolver.fetchModelMetadata(model_id, { fields })
        const merged = mergeMetadata(liveData, staticData)

        if (merged) {
            values = { ...merged }
            // If the resolver failed but we got data from static catalog, note the fallback
            if (resolverFailed && !liveData && staticData) {
                if (model_id.startsWith('registry://')) {
                    message = '[registry] SageMaker API unreachable. Using static catalog fallback.'
                } else if (model_id.startsWith('s3://')) {
                    message = '[s3] S3 API unreachable. Using static catalog fallback.'
                }
            }
        } else {
            // No data from either source
            if (resolverFailed) {
                if (model_id.startsWith('registry://')) {
                    message = `[registry] Resolver could not fetch data for: ${model_id}`
                } else if (model_id.startsWith('s3://')) {
                    message = `[s3] Resolver could not fetch data for: ${model_id}`
                } else {
                    message = `Model not found: ${model_id}`
                }
            } else {
                message = `Model not found: ${model_id}`
            }
        }
    }

    // Apply provider filter from context
    if (context && context.provider && Object.keys(values).length > 0) {
        if (values.provider && values.provider !== context.provider) {
            message = `Model ${model_id} is from provider '${values.provider}', not '${context.provider}'`
            values = {}
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

    // Exclude jumpstart:// prefixed results from output
    const resolvedModelId = values.modelId || model_id
    if (resolvedModelId.startsWith('jumpstart://') || resolvedModelId.startsWith('jumpstart-hub://')) {
        const bareId = resolvedModelId.replace(/^jumpstart(-hub)?:\/\//, '')
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ values: {}, choices: {}, message: `JumpStart is no longer supported. Use the HuggingFace model ID directly: ${bareId}` })
            }]
        }
    }

    // Build choices with provider prefix labels
    const choices = {}
    if (Object.keys(values).length > 0) {
        const choiceLabel = formatModelChoice(values)
        if (choiceLabel) {
            choices[choiceLabel] = values.modelId || model_id
        }
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({ values, choices, message })
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
    JumpStartPublicResolver,
    JumpStartPrivateResolver,
    ModelRegistryResolver,
    S3Resolver,
    ResolverRegistry,
    mergeMetadata,
    parseS3Uri,
    buildS3Uri,
    formatModelChoice,
    filterByProvider,
    resolveModel,
    staticResolver,
    hfResolver,
    jumpStartPublicResolver,
    jumpStartPrivateResolver,
    modelRegistryResolver,
    s3Resolver,
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
