#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Sizer MCP Server
 *
 * A bundled MCP server that estimates VRAM requirements from model metadata
 * and returns a filtered, ranked list of compatible SageMaker instances.
 *
 * Supports three modes:
 *   - Static (default): Uses pre-built model-sizes catalog for popular models
 *   - Smart (BEDROCK_SMART=true): Queries Bedrock for edge-case reasoning
 *   - Discover (--discover flag): Fetches model config.json from HuggingFace Hub
 *
 * Tool: get_instance_recommendation
 *   Accepts: { modelName, quantization?, maxSequenceLength?, batchSize?, limit?, context? }
 *   Returns: { values, choices, metadata }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { resolveModelMetadata } from './lib/model-resolver.js'
import { estimateVram } from './lib/vram-estimator.js'
import { filterAndRankInstances } from './lib/instance-ranker.js'
import { queryBedrock } from '../lib/bedrock-client.js'

// ── Path setup ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── Load instance catalog from shared lib ────────────────────────────────────

let INSTANCE_CATALOG

try {
    const catalogPath = resolve(__dirname, '../lib/catalogs/instances.json')
    const raw = readFileSync(catalogPath, 'utf8')
    const data = JSON.parse(raw)
    INSTANCE_CATALOG = data.catalog
} catch (err) {
    process.stderr.write(`[instance-sizer] Fatal: Failed to load instance catalog: ${err.message}\n`)
    process.exit(1)
}

// ── Mode configuration ───────────────────────────────────────────────────────

const DISCOVER_MODE = process.argv.includes('--discover') || process.env.DISCOVER_MODE === 'true'
const SMART_MODE = process.env.BEDROCK_SMART === 'true'
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-20250514-v1:0'
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'

// ── Bedrock server config ─────────────────────────────────────────────────────

/**
 * Per-server configuration passed to the shared Bedrock client.
 * The system prompt provides model context and asks Bedrock to validate
 * or adjust the static recommendation for edge cases.
 */
const SERVER_CONFIG = {
    serverName: 'instance-sizer',
    systemPromptTemplate: `You are an AWS SageMaker instance sizing advisor specializing in GPU memory estimation for ML model deployment.

Given the following model metadata and VRAM estimate, validate or adjust the instance recommendation for edge cases (unusual architectures, custom quantization, multi-modal models, etc.).

Model context:
{context}

Requested parameters: {parameters}
Maximum recommendations: {limit}

Respond with ONLY a JSON object in this exact format, no other text:
{
  "values": {
    "instanceType": "the single best instance type as a string"
  },
  "reasoning": "brief explanation of why this instance is recommended or why the static recommendation was adjusted"
}

Rules:
- Only recommend real SageMaker instance types (ml.* prefix)
- Consider the VRAM estimate and breakdown provided
- If the static recommendation looks correct, return the same instance type
- If you detect an edge case (e.g., model needs more headroom for KV cache, unusual architecture overhead), adjust accordingly
- Prefer single-GPU instances when the model fits
- Consider tensor parallelism for models that exceed single-GPU capacity
- Return valid JSON only`,
    temperature: 0.3,
    maxTokens: 1024,
    modelId: BEDROCK_MODEL,
    region: BEDROCK_REGION
}

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[instance-sizer] ${message}\n`)
}

// ── Tag-based search filtering ───────────────────────────────────────────────

/**
 * Search instances by tag/keyword matching.
 * Ported from instance-recommender's getStaticInstances logic.
 *
 * @param {string} search - Search query string
 * @param {object} instanceCatalog - Instance catalog object
 * @param {object} [options={}]
 * @param {number} [options.limit=8] - Max results
 * @returns {string[]} Matching instance type names, sorted by relevance
 */
function searchInstancesByTag(search, instanceCatalog, options = {}) {
    const { limit = 8 } = options
    const candidates = Object.entries(instanceCatalog)

    // Tokenize search into lowercase keywords
    const tokens = search.toLowerCase().split(/[\s,\-_]+/).filter(Boolean)

    // Detect compound terms
    const rawLower = search.toLowerCase()
    const wantsMultiGpu = rawLower.includes('multi gpu') || rawLower.includes('multi-gpu') || rawLower.includes('multigpu')

    // Detect CUDA version requests: "cuda 12", "cuda 11.8", "cuda-12.1"
    const cudaMatch = rawLower.match(/cuda[\s\-_]*(\d+(?:\.\d+)?)/)
    const wantsCudaVersion = cudaMatch ? cudaMatch[1] : null

    // Score each instance
    const scored = candidates.map(([name, meta]) => {
        let score = 0
        const cudaStr = meta.cudaVersions ? meta.cudaVersions.join(' ') : ''
        const haystack = [...(meta.tags || []), (meta.accelerator || '').toLowerCase(), name, meta.category || '', cudaStr].join(' ')

        // Compound term: multi-gpu
        if (wantsMultiGpu) {
            if (meta.gpus > 1) {
                score += 5
            } else {
                return { name, meta, score: 0 }
            }
        }

        // Compound term: cuda version
        if (wantsCudaVersion) {
            if (!meta.cudaVersions) return { name, meta, score: 0 }
            const hasExact = meta.cudaVersions.includes(wantsCudaVersion)
            const hasMajor = meta.cudaVersions.some(v => v.startsWith(wantsCudaVersion))
            if (hasExact) {
                score += 4
            } else if (hasMajor) {
                score += 3
            } else {
                return { name, meta, score: 0 }
            }
        }

        for (const token of tokens) {
            if (wantsMultiGpu && (token === 'multi' || token === 'gpu')) continue
            if (wantsCudaVersion && (token === 'cuda' || token === wantsCudaVersion)) continue

            if (haystack.includes(token)) score += 1
            if (meta.gpus > 1 && token === 'parallel') score += 2
            if (token === 'gpu' && meta.gpus > 0) score += 1
            if (token === 'cpu' && meta.gpus === 0) score += 1
            if (token === 'cheap' || token === 'budget' || token === 'cost') {
                if ((meta.tags || []).includes('budget') || (meta.tags || []).includes('cost-effective')) score += 1
            }
            if (token === 'memory' || token === 'high-memory') {
                if (meta.memGb >= 32) score += 1
            }
            if (token === 'large' && meta.vcpus >= 16) score += 1
            if (meta.cudaVersions && meta.cudaVersions.includes(token)) score += 2
        }
        return { name, meta, score }
    })

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)

    if (matched.length === 0) {
        return []
    }

    return matched.slice(0, limit).map(s => s.name)
}

// ── CUDA version filtering ───────────────────────────────────────────────────

/**
 * Filter instances to only those supporting a required CUDA version.
 *
 * @param {object} instanceCatalog - Instance catalog object
 * @param {string} requiredCuda - Required CUDA version (e.g., "12.1")
 * @returns {object} Filtered instance catalog
 */
function filterByCudaVersion(instanceCatalog, requiredCuda) {
    const majorRequired = requiredCuda.split('.')[0]
    const filtered = {}

    for (const [name, meta] of Object.entries(instanceCatalog)) {
        if (!meta.cudaVersions || meta.cudaVersions.length === 0) continue
        const hasCompatible = meta.cudaVersions.some(v => {
            if (v === requiredCuda) return true
            if (v.startsWith(majorRequired + '.')) return true
            return false
        })
        if (hasCompatible) {
            filtered[name] = meta
        }
    }

    return filtered
}

// ── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Handle the get_instance_recommendation tool invocation.
 *
 * Pipeline: resolveModelMetadata → estimateVram → filterAndRankInstances
 *
 * @param {object} params - Tool input parameters
 * @returns {object} MCP tool response
 */
async function handleGetInstanceRecommendation(params) {
    const {
        modelName,
        instanceSearch,
        quantization,
        maxSequenceLength,
        batchSize,
        cudaVersion,
        limit = 8,
        context
    } = params

    // Apply profile ENV overrides to sequence length and batch size
    let effectiveMaxSeqLen = maxSequenceLength
    let effectiveBatchSize = batchSize
    if (context?.profileEnvVars) {
        if (context.profileEnvVars.VLLM_MAX_MODEL_LEN) {
            effectiveMaxSeqLen = parseInt(context.profileEnvVars.VLLM_MAX_MODEL_LEN, 10) || effectiveMaxSeqLen
        }
        if (context.profileEnvVars.VLLM_MAX_NUM_SEQS) {
            effectiveBatchSize = parseInt(context.profileEnvVars.VLLM_MAX_NUM_SEQS, 10) || effectiveBatchSize
        }
    }

    // Apply CUDA version filtering to instance catalog
    let effectiveCatalog = INSTANCE_CATALOG
    if (cudaVersion) {
        effectiveCatalog = filterByCudaVersion(INSTANCE_CATALOG, cudaVersion)
        if (Object.keys(effectiveCatalog).length === 0) {
            log(`CUDA version ${cudaVersion} filter eliminated all instances`)
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        values: { instanceType: null },
                        choices: { instanceType: [] },
                        metadata: {
                            modelName: modelName || null,
                            warning: `No instances support CUDA version ${cudaVersion}. Check base image compatibility.`,
                            cudaVersionFilter: cudaVersion
                        }
                    })
                }]
            }
        }
    }

    // Mode: tag-based search only (no model name)
    if (!modelName && instanceSearch) {
        const searchResults = searchInstancesByTag(instanceSearch, effectiveCatalog, { limit })
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    values: { instanceType: searchResults[0] || null },
                    choices: { instanceType: searchResults },
                    metadata: {
                        instanceSearch,
                        source: 'tag-search',
                        cudaVersionFilter: cudaVersion || null,
                        resultCount: searchResults.length
                    }
                })
            }]
        }
    }

    // Mode: no model name and no search — return all GPU instances
    if (!modelName) {
        const allGpuInstances = Object.keys(effectiveCatalog)
            .filter(key => effectiveCatalog[key].category === 'gpu')
            .slice(0, limit)

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    values: { instanceType: allGpuInstances[0] || null },
                    choices: { instanceType: allGpuInstances },
                    metadata: {
                        modelName: null,
                        source: 'unfiltered',
                        cudaVersionFilter: cudaVersion || null,
                        warning: 'No model name provided. Returning GPU instances without VRAM filtering.'
                    }
                })
            }]
        }
    }

    // Step 1: Resolve model metadata
    const modelMetadata = await resolveModelMetadata(modelName, {
        discover: DISCOVER_MODE
    })

    // If model metadata cannot be resolved, return all GPU instances unfiltered
    if (!modelMetadata) {
        log(`Model metadata not found for "${modelName}", returning unfiltered GPU instances`)
        const allGpuInstances = Object.keys(effectiveCatalog)
            .filter(key => effectiveCatalog[key].category === 'gpu')
            .slice(0, limit)

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    values: { instanceType: allGpuInstances[0] || null },
                    choices: { instanceType: allGpuInstances },
                    metadata: {
                        modelName,
                        parameterCount: null,
                        dtype: null,
                        quantization: quantization || null,
                        estimatedVramGb: null,
                        vramBreakdown: null,
                        recommendations: allGpuInstances.map(instanceType => ({
                            instanceType,
                            gpuCount: effectiveCatalog[instanceType]?.gpus || 0,
                            totalVramGb: null,
                            utilizationPercent: null,
                            tensorParallelism: null,
                            costTier: null
                        })),
                        source: 'unfiltered',
                        cudaVersionFilter: cudaVersion || null,
                        warning: `Could not resolve model metadata for "${modelName}". Returning all GPU instances without filtering.`
                    }
                })
            }]
        }
    }

    // Step 2: Estimate VRAM
    const vramEstimate = estimateVram({
        parameterCount: modelMetadata.parameterCount,
        dtype: modelMetadata.dtype,
        quantization: quantization || undefined,
        maxSequenceLength: effectiveMaxSeqLen || undefined,
        batchSize: effectiveBatchSize || undefined
    })

    // Step 3: Filter and rank instances
    let recommendations = filterAndRankInstances(
        vramEstimate.vramGb,
        effectiveCatalog,
        { limit }
    )

    // Step 3b: If instanceSearch is also provided, further filter by tags
    if (instanceSearch && recommendations.length > 0) {
        const searchMatches = new Set(searchInstancesByTag(instanceSearch, effectiveCatalog, { limit: 100 }))
        recommendations = recommendations.filter(r => searchMatches.has(r.instanceType))
    }

    // Step 4: Smart mode — query Bedrock for edge-case reasoning
    let finalRecommendations = recommendations
    let smartModeUsed = false

    if (SMART_MODE && recommendations.length > 0) {
        log('[smart] Smart mode enabled, querying Amazon Bedrock...')

        const bedrockContext = {
            modelName,
            parameterCount: modelMetadata.parameterCount,
            dtype: modelMetadata.dtype,
            quantization: quantization || null,
            estimatedVramGb: vramEstimate.vramGb,
            vramBreakdown: vramEstimate.breakdown,
            staticRecommendations: recommendations.slice(0, 3).map(r => ({
                instanceType: r.instanceType,
                gpuCount: r.gpuCount,
                totalVramGb: r.totalVramGb,
                utilizationPercent: r.utilizationPercent,
                tensorParallelism: r.tensorParallelism
            })),
            ...(context || {})
        }

        const bedrockResult = await queryBedrock(
            SERVER_CONFIG,
            ['instanceType'],
            limit,
            bedrockContext
        )

        if (bedrockResult?.values?.instanceType) {
            const bedrockInstance = bedrockResult.values.instanceType
            log(`[smart] Bedrock recommendation: ${bedrockInstance}`)

            // Check if Bedrock's suggestion is already in our list
            const existingIndex = finalRecommendations.findIndex(
                r => r.instanceType === bedrockInstance
            )

            if (existingIndex > 0) {
                // Move Bedrock's pick to the top
                const [picked] = finalRecommendations.splice(existingIndex, 1)
                finalRecommendations = [picked, ...finalRecommendations]
                smartModeUsed = true
            } else if (existingIndex === 0) {
                // Already at the top — Bedrock agrees with static
                smartModeUsed = true
                log('[smart] Bedrock agrees with static top recommendation')
            } else {
                // Bedrock suggested an instance not in our filtered list;
                // verify it exists in the catalog before prepending
                if (INSTANCE_CATALOG[bedrockInstance]) {
                    const catalogEntry = INSTANCE_CATALOG[bedrockInstance]
                    const bedrockRec = {
                        instanceType: bedrockInstance,
                        gpuCount: catalogEntry.gpus || 0,
                        totalVramGb: (catalogEntry.gpuMemoryGb || 0) * (catalogEntry.gpus || 1),
                        utilizationPercent: null,
                        tensorParallelism: catalogEntry.gpus || 1,
                        costTier: catalogEntry.costTier || null
                    }
                    finalRecommendations = [bedrockRec, ...finalRecommendations].slice(0, limit)
                    smartModeUsed = true
                } else {
                    log(`[smart] Bedrock suggested unknown instance "${bedrockInstance}", ignoring`)
                }
            }
        } else {
            log('[smart] Bedrock did not return usable results, falling back to static recommendations')
        }
    }

    // Build response
    const topRecommendation = finalRecommendations.length > 0
        ? finalRecommendations[0].instanceType
        : null

    const rankedList = finalRecommendations.map(r => r.instanceType)

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                values: { instanceType: topRecommendation },
                choices: { instanceType: rankedList },
                metadata: {
                    modelName,
                    parameterCount: modelMetadata.parameterCount,
                    dtype: modelMetadata.dtype,
                    quantization: quantization || null,
                    estimatedVramGb: vramEstimate.vramGb,
                    vramBreakdown: vramEstimate.breakdown,
                    recommendations: finalRecommendations,
                    source: modelMetadata.source,
                    smartModeUsed
                }
            })
        }]
    }
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'instance-sizer',
    version: '1.0.0'
})

// Register the get_instance_recommendation tool
server.tool(
    'get_instance_recommendation',
    'Estimates VRAM requirements from model metadata and returns filtered, ranked SageMaker instance recommendations. Supports VRAM-based sizing, tag-based search, or both combined.',
    {
        modelName: z.string().optional().describe('HuggingFace model ID or catalog key'),
        instanceSearch: z.string().optional().describe('Tag/keyword search for instances (e.g., "multi-gpu", "cost-effective cpu")'),
        quantization: z.string().optional().describe('Quantization method: awq, gptq, bnb-4bit, bnb-8bit'),
        maxSequenceLength: z.number().optional().describe('Max context/sequence length (affects KV cache estimate)'),
        batchSize: z.number().optional().describe('Expected concurrent batch size'),
        cudaVersion: z.string().optional().describe('Required CUDA version from base image (filters incompatible instances)'),
        limit: z.number().optional().default(8).describe('Maximum number of instance recommendations to return'),
        context: z.object({
            architecture: z.string().optional(),
            backend: z.string().optional(),
            deploymentTarget: z.string().optional(),
            profileEnvVars: z.record(z.string()).optional().describe('Serving profile ENV overrides (e.g., VLLM_MAX_MODEL_LEN)')
        }).optional().describe('Additional deployment context')
    },
    async (params) => {
        return handleGetInstanceRecommendation(params)
    }
)

// Register alias tool name for backward compatibility
server.tool(
    'get_instance_types',
    'Alias for get_instance_recommendation — recommends SageMaker instances via VRAM sizing and/or tag-based search',
    {
        modelName: z.string().optional().describe('HuggingFace model ID or catalog key'),
        instanceSearch: z.string().optional().describe('Tag/keyword search for instances (e.g., "multi-gpu", "cost-effective cpu")'),
        quantization: z.string().optional().describe('Quantization method: awq, gptq, bnb-4bit, bnb-8bit'),
        maxSequenceLength: z.number().optional().describe('Max context/sequence length (affects KV cache estimate)'),
        batchSize: z.number().optional().describe('Expected concurrent batch size'),
        cudaVersion: z.string().optional().describe('Required CUDA version from base image (filters incompatible instances)'),
        limit: z.number().optional().default(8).describe('Maximum number of instance recommendations to return'),
        context: z.object({
            architecture: z.string().optional(),
            backend: z.string().optional(),
            deploymentTarget: z.string().optional(),
            profileEnvVars: z.record(z.string()).optional().describe('Serving profile ENV overrides (e.g., VLLM_MAX_MODEL_LEN)')
        }).optional().describe('Additional deployment context')
    },
    async (params) => {
        return handleGetInstanceRecommendation(params)
    }
)

// ── Exports for testing ──────────────────────────────────────────────────────

export { handleGetInstanceRecommendation, INSTANCE_CATALOG, SERVER_CONFIG, server, searchInstancesByTag, filterByCudaVersion }

// ── Transport connection (main module only) ──────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename

if (isMain) {
    if (SMART_MODE) {
        log(`Smart mode enabled (model: ${BEDROCK_MODEL}, region: ${BEDROCK_REGION})`)
    } else if (DISCOVER_MODE) {
        log('Discover mode enabled (HuggingFace API lookups active)')
    } else {
        log('Static mode (catalog-only, no network calls)')
    }

    const transport = new StdioServerTransport()
    await server.connect(transport)
}
