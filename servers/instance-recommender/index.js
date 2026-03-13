#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Recommender MCP Server
 *
 * A bundled MCP server that recommends SageMaker instance types and
 * IAM role ARNs based on the current ML framework and model configuration.
 *
 * Supports two modes:
 *   - Static (default): Returns hardcoded instance lists by framework category
 *   - Smart (--smart flag or BEDROCK_SMART=true): Queries Amazon Bedrock for
 *     context-aware recommendations, falling back to static on failure
 *
 * Tool: get_ml_config
 *   Accepts: { parameters: string[], limit: number, context: object }
 *   Returns: { values: Record<string, string>, choices: Record<string, string[]> }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { queryBedrock } from '../lib/bedrock-client.js'

/**
 * Instance recommendations by framework category.
 * Traditional ML frameworks use CPU instances; transformer frameworks use GPU instances.
 * Each entry includes metadata for keyword-based search filtering.
 *
 * cudaVersions is derived from the GPU architecture's supported CUDA toolkit versions
 * (see generators/app/config/registries/instance-accelerator-mapping.js).
 * CPU instances have cudaVersions: null.
 */
const INSTANCE_CATALOG = {
    'ml.m5.large':     { category: 'cpu', gpus: 0, vcpus: 2,  memGb: 8,   accelerator: '',              cudaVersions: null,                    tags: ['small', 'cpu', 'general', 'cheap', 'cost-effective', 'budget'] },
    'ml.m5.xlarge':    { category: 'cpu', gpus: 0, vcpus: 4,  memGb: 16,  accelerator: '',              cudaVersions: null,                    tags: ['medium', 'cpu', 'general', 'cost-effective'] },
    'ml.m5.2xlarge':   { category: 'cpu', gpus: 0, vcpus: 8,  memGb: 32,  accelerator: '',              cudaVersions: null,                    tags: ['large', 'cpu', 'general', 'high-memory'] },
    'ml.m5.4xlarge':   { category: 'cpu', gpus: 0, vcpus: 16, memGb: 64,  accelerator: '',              cudaVersions: null,                    tags: ['xlarge', 'cpu', 'general', 'high-memory', 'high-cpu'] },
    'ml.c5.xlarge':    { category: 'cpu', gpus: 0, vcpus: 4,  memGb: 8,   accelerator: '',              cudaVersions: null,                    tags: ['compute', 'cpu', 'cost-effective'] },
    'ml.c5.2xlarge':   { category: 'cpu', gpus: 0, vcpus: 8,  memGb: 16,  accelerator: '',              cudaVersions: null,                    tags: ['compute', 'cpu', 'high-cpu'] },
    'ml.r5.large':     { category: 'cpu', gpus: 0, vcpus: 2,  memGb: 16,  accelerator: '',              cudaVersions: null,                    tags: ['memory', 'cpu', 'high-memory'] },
    'ml.r5.xlarge':    { category: 'cpu', gpus: 0, vcpus: 4,  memGb: 32,  accelerator: '',              cudaVersions: null,                    tags: ['memory', 'cpu', 'high-memory'] },
    'ml.g4dn.xlarge':  { category: 'gpu', gpus: 1, vcpus: 4,  memGb: 16,  accelerator: 'T4 16GB',      cudaVersions: ['11.4', '11.8'],        tags: ['gpu', 'single-gpu', 'budget', 'cost-effective', 'inference', 't4', 'cuda-11'] },
    'ml.g4dn.2xlarge': { category: 'gpu', gpus: 1, vcpus: 8,  memGb: 32,  accelerator: 'T4 16GB',      cudaVersions: ['11.4', '11.8'],        tags: ['gpu', 'single-gpu', 'budget', 'cost-effective', 'inference', 't4', 'cuda-11'] },
    'ml.g5.xlarge':    { category: 'gpu', gpus: 1, vcpus: 4,  memGb: 16,  accelerator: 'A10G 24GB',    cudaVersions: ['11.8', '12.1', '12.2'], tags: ['gpu', 'single-gpu', 'inference', 'a10g', 'cuda-11', 'cuda-12'] },
    'ml.g5.2xlarge':   { category: 'gpu', gpus: 1, vcpus: 8,  memGb: 32,  accelerator: 'A10G 24GB',    cudaVersions: ['11.8', '12.1', '12.2'], tags: ['gpu', 'single-gpu', 'inference', 'a10g', 'cuda-11', 'cuda-12'] },
    'ml.g5.4xlarge':   { category: 'gpu', gpus: 1, vcpus: 16, memGb: 64,  accelerator: 'A10G 24GB',    cudaVersions: ['11.8', '12.1', '12.2'], tags: ['gpu', 'single-gpu', 'large', 'a10g', 'cuda-11', 'cuda-12'] },
    'ml.g5.12xlarge':  { category: 'gpu', gpus: 4, vcpus: 48, memGb: 192, accelerator: '4x A10G 96GB', cudaVersions: ['11.8', '12.1', '12.2'], tags: ['gpu', 'multi-gpu', 'large', 'a10g', 'parallel', 'cuda-11', 'cuda-12'] },
    'ml.g6.xlarge':    { category: 'gpu', gpus: 1, vcpus: 4,  memGb: 16,  accelerator: 'L4 24GB',      cudaVersions: ['12.1', '12.2', '12.4'], tags: ['gpu', 'single-gpu', 'inference', 'l4', 'newer', 'cuda-12'] },
    'ml.g6.2xlarge':   { category: 'gpu', gpus: 1, vcpus: 8,  memGb: 32,  accelerator: 'L4 24GB',      cudaVersions: ['12.1', '12.2', '12.4'], tags: ['gpu', 'single-gpu', 'inference', 'l4', 'newer', 'cuda-12'] },
    'ml.g6.12xlarge':  { category: 'gpu', gpus: 4, vcpus: 48, memGb: 192, accelerator: '4x L4 96GB',   cudaVersions: ['12.1', '12.2', '12.4'], tags: ['gpu', 'multi-gpu', 'large', 'l4', 'newer', 'parallel', 'cuda-12'] },
    'ml.p3.2xlarge':   { category: 'gpu', gpus: 1, vcpus: 8,  memGb: 61,  accelerator: 'V100 16GB',    cudaVersions: ['11.0', '11.4', '11.8'], tags: ['gpu', 'single-gpu', 'high-performance', 'training', 'v100', 'cuda-11'] },
    'ml.p3.8xlarge':   { category: 'gpu', gpus: 4, vcpus: 32, memGb: 244, accelerator: '4x V100 64GB', cudaVersions: ['11.0', '11.4', '11.8'], tags: ['gpu', 'multi-gpu', 'high-performance', 'training', 'v100', 'parallel', 'cuda-11'] }
}

/**
 * Legacy flat lists — used when no search term is provided.
 * Kept as original hardcoded values for backward compatibility with existing tests.
 */
const INSTANCE_RECOMMENDATIONS = {
    cpu: [
        'ml.m5.large',
        'ml.m5.xlarge',
        'ml.m5.2xlarge',
        'ml.m5.4xlarge',
        'ml.c5.xlarge',
        'ml.c5.2xlarge',
        'ml.r5.large',
        'ml.r5.xlarge'
    ],
    gpu: [
        'ml.g4dn.xlarge',
        'ml.g4dn.2xlarge',
        'ml.g5.xlarge',
        'ml.g5.2xlarge',
        'ml.g5.4xlarge',
        'ml.p3.2xlarge'
    ]
}

const GPU_FRAMEWORKS = new Set(['transformers'])

// Bedrock configuration
const SMART_MODE = process.env.BEDROCK_SMART === 'true'
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-20250514-v1:0'
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'

/**
 * Per-server configuration passed to the shared Bedrock client.
 */
const SERVER_CONFIG = {
    serverName: 'instance-recommender',
    systemPromptTemplate: `You are an AWS SageMaker instance type advisor. Given the following ML deployment context, recommend the best SageMaker instance types.

Current configuration: {context}
Requested parameters: {parameters}
Maximum recommendations per parameter: {limit}

Respond with ONLY a JSON object in this exact format, no other text:
{
  "values": {
    "instanceType": "the single best instance type as a string",
    "awsRoleArn": "a recommended role ARN pattern if applicable"
  }
}

Rules:
- Only include parameters that were requested
- For instanceType: recommend real SageMaker instance types (ml.* prefix) appropriate for the framework and model
- For awsRoleArn: skip this field, do not recommend ARNs
- The first value in any list should be your top recommendation
- Consider GPU vs CPU needs based on the framework
- Consider model size and memory requirements if model info is available
- Return valid JSON only`,
    temperature: 0.3,
    maxTokens: 1024,
    modelId: BEDROCK_MODEL,
    region: BEDROCK_REGION
}

/**
 * Determine which instance list to use based on framework context and optional search term.
 * When instanceSearch is provided, filters the catalog by keyword matching.
 */
function getStaticInstances(context) {
    const framework = context?.framework
    const search = context?.instanceSearch

    // Start with framework-based category filter
    const isGpu = framework && GPU_FRAMEWORKS.has(framework)
    if (!search) {
        // No search term — return the legacy category-based list
        return isGpu ? INSTANCE_RECOMMENDATIONS.gpu : INSTANCE_RECOMMENDATIONS.cpu
    }

    // Search mode: use the full catalog
    let candidates = Object.entries(INSTANCE_CATALOG)

    // Tokenize search into lowercase keywords
    const tokens = search.toLowerCase().split(/[\s,\-_]+/).filter(Boolean)

    // Detect compound terms before tokenization
    const rawLower = search.toLowerCase()
    const wantsMultiGpu = rawLower.includes('multi gpu') || rawLower.includes('multi-gpu') || rawLower.includes('multigpu')

    // Detect CUDA version requests: "cuda 12", "cuda 11.8", "cuda-12.1"
    const cudaMatch = rawLower.match(/cuda[\s\-_]*(\d+(?:\.\d+)?)/)
    const wantsCudaVersion = cudaMatch ? cudaMatch[1] : null

    // Score each instance by how many tokens match its tags, accelerator, or instance name
    const scored = candidates.map(([name, meta]) => {
        let score = 0
        const cudaStr = meta.cudaVersions ? meta.cudaVersions.join(' ') : ''
        const haystack = [...meta.tags, meta.accelerator.toLowerCase(), name, meta.category, cudaStr].join(' ')

        // Compound term: multi-gpu — only match instances with >1 GPU
        if (wantsMultiGpu) {
            if (meta.gpus > 1) {
                score += 5
            } else {
                return { name, meta, score: 0 }
            }
        }

        // Compound term: cuda version — only match instances supporting that version
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
            // Skip tokens already handled by compound term detection
            if (wantsMultiGpu && (token === 'multi' || token === 'gpu')) continue
            if (wantsCudaVersion && (token === 'cuda' || token === wantsCudaVersion)) continue

            if (haystack.includes(token)) score += 1
            if (meta.gpus > 1 && (token === 'parallel')) score += 2
            if (token === 'gpu' && meta.gpus > 0) score += 1
            if (token === 'cpu' && meta.gpus === 0) score += 1
            if (token === 'cheap' || token === 'budget' || token === 'cost') {
                if (meta.tags.includes('budget') || meta.tags.includes('cost-effective')) score += 1
            }
            if (token === 'memory' || token === 'high-memory') {
                if (meta.memGb >= 32) score += 1
            }
            if (token === 'large' && meta.vcpus >= 16) score += 1
            // Match specific CUDA versions (e.g. "11.8", "12.1")
            if (meta.cudaVersions && meta.cudaVersions.includes(token)) score += 2
        }
        return { name, meta, score }
    })

    // Keep only instances with a positive score, sorted descending
    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)

    if (matched.length === 0) {
        // No matches — fall back to legacy category-based list
        return isGpu ? INSTANCE_RECOMMENDATIONS.gpu : INSTANCE_RECOMMENDATIONS.cpu
    }

    return matched.map(s => s.name)
}

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[instance-recommender] ${message}\n`)
}

// Create MCP server
const server = new McpServer({
    name: 'instance-recommender',
    version: '1.0.0'
})

// Register the get_ml_config tool
server.tool(
    'get_ml_config',
    'Returns recommended SageMaker instance types and configuration values for ML Container Creator',
    {
        parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
        limit: z.number().int().positive().default(10).describe('Maximum number of choices per parameter'),
        context: z.record(z.string(), z.any()).optional().describe('Current configuration context (framework, modelServer, etc.)')
    },
    async ({ parameters, limit, context }) => {
        const values = {}
        const choices = {}
        let usedSmart = false

        // Smart mode: try Bedrock first
        if (SMART_MODE && parameters.includes('instanceType')) {
            log('[smart] Smart mode enabled, querying Amazon Bedrock...')
            const bedrockResult = await queryBedrock(SERVER_CONFIG, parameters, limit, context || {})

            if (bedrockResult?.values?.instanceType) {
                values.instanceType = bedrockResult.values.instanceType
                // Use the Bedrock recommendation as the top choice, pad with static list
                const staticInstances = getStaticInstances(context || {})
                const bedrockValue = bedrockResult.values.instanceType
                const combined = [bedrockValue, ...staticInstances.filter(i => i !== bedrockValue)]
                choices.instanceType = combined.slice(0, limit)
                usedSmart = true
                log(`[smart] Using Bedrock recommendation: ${bedrockValue}`)
            } else {
                log('[smart] Bedrock did not return usable results, falling back to static recommendations')
            }
        }

        // Static fallback (or non-smart mode)
        if (!usedSmart) {
            for (const param of parameters) {
                if (param === 'instanceType') {
                    const instances = getStaticInstances(context || {})
                    const limited = instances.slice(0, limit)
                    values.instanceType = limited[0]
                    choices.instanceType = limited
                }
                // awsRoleArn is left to the user — no default recommendations
            }
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ values, choices })
            }]
        }
    }
)

// Export for standalone testing
export { getStaticInstances, INSTANCE_CATALOG, INSTANCE_RECOMMENDATIONS, GPU_FRAMEWORKS }

// Guard MCP transport — only connect when run as main module
const __filename = fileURLToPath(import.meta.url)
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename

if (isMain) {
    if (SMART_MODE) {
        log(`Smart mode enabled (model: ${BEDROCK_MODEL}, region: ${BEDROCK_REGION})`)
    } else {
        log('Static mode (set BEDROCK_SMART=true to enable Bedrock-powered recommendations)')
    }

    const transport = new StdioServerTransport()
    await server.connect(transport)
}
