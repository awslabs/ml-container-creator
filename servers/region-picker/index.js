#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Region Picker MCP Server
 *
 * A bundled MCP server that suggests AWS regions based on a search term.
 * Useful for discovering available SageMaker regions without memorizing codes.
 *
 * Supports two modes:
 *   - Static (default): Filters a hardcoded region list by string matching
 *   - Smart (BEDROCK_SMART=true): Queries Amazon Bedrock for context-aware
 *     region suggestions, falling back to static on failure
 *
 * Tool: get_ml_config
 *   Accepts: { parameters: string[], limit: number, context: object }
 *   Returns: { values: Record<string, string>, choices: Record<string, string[]> }
 *
 * Environment variables:
 *   BEDROCK_SMART  - Set to "true" to enable Bedrock-powered recommendations
 *   BEDROCK_MODEL  - Bedrock model ID (default: global.anthropic.claude-sonnet-4-20250514-v1:0)
 *   BEDROCK_REGION - AWS region for Bedrock API calls (fallback: AWS_REGION, then us-east-1)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { queryBedrock } from '../lib/bedrock-client.js'

/**
 * AWS regions with SageMaker availability and descriptive labels.
 * `labels` is an array of searchable strings: the official name plus colloquial
 * names, city aliases, country names, and common misspellings so that both
 * human search terms and LLM-resolved queries can match.
 */
const AWS_REGIONS = [
    { code: 'us-east-1', labels: ['US East (N. Virginia)', 'virginia', 'nova', 'n. virginia', 'east coast', 'us east', 'new york', 'washington dc', 'dc'] },
    { code: 'us-east-2', labels: ['US East (Ohio)', 'ohio', 'columbus', 'us east', 'midwest'] },
    { code: 'us-west-1', labels: ['US West (N. California)', 'california', 'n. california', 'san francisco', 'sf', 'bay area', 'us west', 'norcal'] },
    { code: 'us-west-2', labels: ['US West (Oregon)', 'oregon', 'portland', 'us west', 'pacific northwest', 'pnw', 'seattle'] },
    { code: 'ca-central-1', labels: ['Canada (Central)', 'canada', 'montreal', 'toronto', 'canadian'] },
    { code: 'eu-west-1', labels: ['Europe (Ireland)', 'ireland', 'dublin', 'europe west', 'eu west', 'uk nearby'] },
    { code: 'eu-west-2', labels: ['Europe (London)', 'london', 'uk', 'united kingdom', 'england', 'britain', 'europe west', 'eu west'] },
    { code: 'eu-west-3', labels: ['Europe (Paris)', 'paris', 'france', 'french', 'europe west', 'eu west'] },
    { code: 'eu-central-1', labels: ['Europe (Frankfurt)', 'frankfurt', 'germany', 'german', 'europe central', 'eu central', 'dach'] },
    { code: 'eu-central-2', labels: ['Europe (Zurich)', 'zurich', 'switzerland', 'swiss', 'europe central', 'eu central', 'dach'] },
    { code: 'eu-north-1', labels: ['Europe (Stockholm)', 'stockholm', 'sweden', 'swedish', 'nordic', 'scandinavia', 'europe north', 'eu north'] },
    { code: 'eu-south-1', labels: ['Europe (Milan)', 'milan', 'italy', 'italian', 'europe south', 'eu south', 'mediterranean'] },
    { code: 'ap-northeast-1', labels: ['Asia Pacific (Tokyo)', 'tokyo', 'japan', 'japanese', 'asia pacific', 'apac', 'east asia'] },
    { code: 'ap-northeast-2', labels: ['Asia Pacific (Seoul)', 'seoul', 'korea', 'korean', 'south korea', 'asia pacific', 'apac', 'east asia'] },
    { code: 'ap-northeast-3', labels: ['Asia Pacific (Osaka)', 'osaka', 'japan', 'japanese', 'kansai', 'asia pacific', 'apac'] },
    { code: 'ap-southeast-1', labels: ['Asia Pacific (Singapore)', 'singapore', 'sg', 'southeast asia', 'sea', 'asia pacific', 'apac'] },
    { code: 'ap-southeast-2', labels: ['Asia Pacific (Sydney)', 'sydney', 'australia', 'australian', 'oceania', 'asia pacific', 'apac', 'down under'] },
    { code: 'ap-south-1', labels: ['Asia Pacific (Mumbai)', 'mumbai', 'india', 'indian', 'south asia', 'asia pacific', 'apac', 'bombay'] },
    { code: 'sa-east-1', labels: ['South America (São Paulo)', 'sao paulo', 'brazil', 'brazilian', 'south america', 'latin america', 'latam'] },
    { code: 'me-south-1', labels: ['Middle East (Bahrain)', 'bahrain', 'middle east', 'gulf', 'gcc', 'mena'] },
    { code: 'af-south-1', labels: ['Africa (Cape Town)', 'cape town', 'africa', 'south africa', 'african'] },
    { code: 'il-central-1', labels: ['Israel (Tel Aviv)', 'tel aviv', 'israel', 'israeli', 'middle east'] }
]

const VALID_REGION_CODES = new Set(AWS_REGIONS.map(r => r.code))

// Bedrock / smart-mode configuration
const SMART_MODE = process.env.BEDROCK_SMART === 'true'
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-20250514-v1:0'
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'

/**
 * Per-server configuration passed to the shared Bedrock client.
 */
const SERVER_CONFIG = {
    serverName: 'region-picker',
    systemPromptTemplate: `You are an AWS region advisor for SageMaker deployments. Given the following deployment context, recommend the best AWS region.

Current configuration: {context}
Requested parameters: {parameters}
Maximum recommendations: {limit}

Respond with ONLY a JSON object in this exact format, no other text:
{
  "values": {
    "awsRegion": "the single best region code as a string"
  }
}

Rules:
- Only include parameters that were requested
- For awsRegion: recommend real AWS region codes (e.g., us-east-1, eu-west-1)
- Consider service availability, latency, and pricing
- Consider the user's existing configuration context
- The first value should be your top recommendation
- Return valid JSON only`,
    temperature: 0.3,
    maxTokens: 1024,
    modelId: BEDROCK_MODEL,
    region: BEDROCK_REGION
}

/**
 * Filter AWS_REGIONS by a case-insensitive substring match against
 * the region code and all labels in the labels array.
 *
 * @param {string|undefined} searchTerm - Substring to match (case-insensitive)
 * @param {number} limit - Maximum number of results to return
 * @returns {{ values: object, choices: object }}
 */
function filterRegions(searchTerm, limit) {
    let matched

    if (searchTerm) {
        const term = searchTerm.toLowerCase()
        matched = AWS_REGIONS.filter(
            r => r.code.toLowerCase().includes(term) ||
                 r.labels.some(l => l.toLowerCase().includes(term))
        )
    } else {
        matched = AWS_REGIONS
    }

    const codes = matched.map(r => r.code).slice(0, limit)

    if (codes.length === 0) {
        return { values: {}, choices: { awsRegion: [] } }
    }

    return {
        values: { awsRegion: codes[0] },
        choices: { awsRegion: codes }
    }
}

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[region-picker] ${message}\n`)
}

// Create MCP server
const server = new McpServer({
    name: 'region-picker',
    version: '1.0.0'
})

// Register the get_ml_config tool
server.tool(
    'get_ml_config',
    'Returns recommended AWS regions for SageMaker deployments',
    {
        parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
        limit: z.number().int().positive().default(10).describe('Maximum number of choices per parameter'),
        context: z.record(z.string(), z.any()).optional().describe('Current configuration context (regionSearch, framework, etc.)')
    },
    async ({ parameters, limit, context }) => {
        // If awsRegion is not requested, return empty
        if (!parameters.includes('awsRegion')) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ values: {}, choices: {} })
                }]
            }
        }

        const searchTerm = context?.regionSearch
        let result

        // Smart mode: try Bedrock first
        if (SMART_MODE) {
            log('[smart] Smart mode enabled, querying Amazon Bedrock...')
            const bedrockResult = await queryBedrock(SERVER_CONFIG, parameters, limit, context || {})

            if (bedrockResult?.values?.awsRegion && VALID_REGION_CODES.has(bedrockResult.values.awsRegion)) {
                const bedrockValue = bedrockResult.values.awsRegion
                log(`[smart] Using Bedrock recommendation: ${bedrockValue}`)

                // Pad with static results, deduplicating the Bedrock pick
                const staticResult = filterRegions(searchTerm, limit)
                const staticCodes = staticResult.choices.awsRegion || []
                const combined = [bedrockValue, ...staticCodes.filter(c => c !== bedrockValue)]

                result = {
                    values: { awsRegion: bedrockValue },
                    choices: { awsRegion: combined.slice(0, limit) }
                }
            } else {
                log('[smart] Bedrock did not return usable results, falling back to static filtering')
                result = filterRegions(searchTerm, limit)
            }
        } else {
            // Static mode (default)
            result = filterRegions(searchTerm, limit)
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        }
    }
)

// Export for standalone testing
export { filterRegions, AWS_REGIONS, VALID_REGION_CODES }

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
