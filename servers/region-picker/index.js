#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Region Picker MCP Server
 *
 * PATTERN: MCP picker server built on the shared createPickerServer factory.
 *   Declares only its unique piece — the AWS-region catalog, the get_regions
 *   tool, and the filter/Bedrock handler — and lets the factory own the
 *   scaffold (catalog loader, logger, main-guard, stdio wiring, smart-mode).
 * COLLABORATORS: servers/lib/create-picker-server.js (scaffold + Bedrock);
 *   catalog servers/lib/catalogs/regions.json; spawned by src/lib/mcp-client.js.
 * DATA-FLOW ROLE: given { parameters, limit, context }, returns
 *   { values: { awsRegion }, choices: { awsRegion: [...] } } filtered from the
 *   region catalog (optionally reranked by Bedrock in smart mode).
 * See: docs/architecture/mcp-servers.md,
 *   docs/adr/ADR-003-mcp-picker-server-factory.md
 *
 * Supports two modes:
 *   - Static (default): Filters a hardcoded region list by string matching
 *   - Smart (BEDROCK_SMART=true): Queries Amazon Bedrock for context-aware
 *     region suggestions, falling back to static on failure
 *
 * Environment variables:
 *   BEDROCK_SMART  - Set to "true" to enable Bedrock-powered recommendations
 *   BEDROCK_MODEL  - Bedrock model ID (default: global.anthropic.claude-sonnet-4-20250514-v1:0)
 *   BEDROCK_REGION - AWS region for Bedrock API calls (fallback: AWS_REGION, then us-east-1)
 */

import { z } from 'zod';
import { createPickerServer } from '../lib/create-picker-server.js';

// ── Bedrock system prompt (used only in smart mode) ───────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an AWS region advisor for SageMaker deployments. Given the following deployment context, recommend the best AWS region.

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
- Return valid JSON only`;

// ── Server construction (scaffold + catalog via the factory) ──────────────────

const picker = createPickerServer({
    name: 'region-picker',
    serverDir: import.meta.url,
    catalogs: { regions: '../lib/catalogs/regions.json' },
    bedrock: { systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE },
    tools: [{
        name: 'get_regions',
        description: 'Returns recommended AWS regions for SageMaker deployments',
        schema: {
            parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
            limit: z.number().int().positive().default(10).describe('Maximum number of choices per parameter'),
            context: z.record(z.string(), z.any()).optional().describe('Current configuration context (regionSearch, framework, etc.)')
        },
        handler: getRegionsHandler
    }]
});

const { log, catalogs, smartMode, querySmart } = picker;

const AWS_REGIONS = catalogs.regions;
const VALID_REGION_CODES = new Set(AWS_REGIONS.map(r => r.code));

/**
 * Filter AWS_REGIONS by a case-insensitive substring match against
 * the region code and all labels in the labels array.
 *
 * @param {string|undefined} searchTerm - Substring to match (case-insensitive)
 * @param {number} limit - Maximum number of results to return
 * @returns {{ values: object, choices: object }}
 */
function filterRegions(searchTerm, limit) {
    let matched;

    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        matched = AWS_REGIONS.filter(
            r => r.code.toLowerCase().includes(term) ||
                 r.labels.some(l => l.toLowerCase().includes(term))
        );
    } else {
        matched = AWS_REGIONS;
    }

    const codes = matched.map(r => r.code).slice(0, limit);

    if (codes.length === 0) {
        return { values: {}, choices: { awsRegion: [] } };
    }

    return {
        values: { awsRegion: codes[0] },
        choices: { awsRegion: codes }
    };
}

/**
 * get_regions tool handler. Static filtering by default; in smart mode, tries
 * Bedrock first and falls back to static filtering on any miss.
 */
async function getRegionsHandler({ parameters, limit, context }) {
    // If awsRegion is not requested, return empty
    if (!parameters.includes('awsRegion')) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ values: {}, choices: {} })
            }]
        };
    }

    const searchTerm = context?.regionSearch;
    let result;

    // Smart mode: try Bedrock first
    if (smartMode) {
        log('[smart] Smart mode enabled, querying Amazon Bedrock...');
        const bedrockResult = await querySmart(parameters, limit, context || {});

        if (bedrockResult?.values?.awsRegion && VALID_REGION_CODES.has(bedrockResult.values.awsRegion)) {
            const bedrockValue = bedrockResult.values.awsRegion;
            log(`[smart] Using Bedrock recommendation: ${bedrockValue}`);

            // Pad with static results, deduplicating the Bedrock pick
            const staticResult = filterRegions(searchTerm, limit);
            const staticCodes = staticResult.choices.awsRegion || [];
            const combined = [bedrockValue, ...staticCodes.filter(c => c !== bedrockValue)];

            result = {
                values: { awsRegion: bedrockValue },
                choices: { awsRegion: combined.slice(0, limit) }
            };
        } else {
            log('[smart] Bedrock did not return usable results, falling back to static filtering');
            result = filterRegions(searchTerm, limit);
        }
    } else {
        // Static mode (default)
        result = filterRegions(searchTerm, limit);
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result)
        }]
    };
}

// Export for standalone testing
export { filterRegions, AWS_REGIONS, VALID_REGION_CODES };

// Connect stdio transport only when run as the main module.
await picker.start({
    entryUrl: import.meta.url,
    onStart: () => {
        if (smartMode) {
            log(`Smart mode enabled (model: ${picker.bedrockConfig.modelId}, region: ${picker.bedrockConfig.region})`);
        } else {
            log('Static mode (set BEDROCK_SMART=true to enable Bedrock-powered recommendations)');
        }
    }
});
