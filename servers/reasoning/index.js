#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reasoning MCP Server
 *
 * A bundled MCP server that provides a single stateless reasoning/interpretation
 * tool powered by Amazon Bedrock. This is the centralized reasoning surface for
 * all MLCC components — do/benchmark --recommend, do/optimize, mcc hey, and
 * GoalPlanner all route through this.
 *
 * Tool: interpret
 *   Accepts: { context, data?, objective }
 *   Returns: { interpretation, confidence?, suggestions? }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// ── Path setup ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '../../');

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message) {
    process.stderr.write(`[reasoning] ${message}\n`);
}

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Default reasoning configuration used when config/agent.json does not
 * contain a `reasoning` block.
 */
const DEFAULT_REASONING_CONFIG = {
    provider: 'bedrock',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 2048,
    temperature: 0.3
};

/**
 * Load reasoning configuration from config/agent.json.
 * Falls back to defaults if the file is missing or has no reasoning block.
 */
function loadReasoningConfig() {
    try {
        const configPath = resolve(PACKAGE_ROOT, 'config/agent.json');
        const raw = readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw);

        if (config.reasoning && typeof config.reasoning === 'object') {
            return {
                provider: config.reasoning.provider || DEFAULT_REASONING_CONFIG.provider,
                modelId: config.reasoning.modelId || DEFAULT_REASONING_CONFIG.modelId,
                maxTokens: config.reasoning.maxTokens || DEFAULT_REASONING_CONFIG.maxTokens,
                temperature: config.reasoning.temperature ?? DEFAULT_REASONING_CONFIG.temperature
            };
        }

        return { ...DEFAULT_REASONING_CONFIG };
    } catch (err) {
        log(`Config load warning: ${err.message}. Using defaults.`);
        return { ...DEFAULT_REASONING_CONFIG };
    }
}

const reasoningConfig = loadReasoningConfig();

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a concise ML infrastructure advisor for Amazon SageMaker deployments. Reason carefully about the provided context and data to fulfill the stated objective.

Rules:
- Be direct and actionable. Avoid generic advice.
- When recommending, explain tradeoffs briefly.
- When diagnosing, identify the most likely root cause first.
- When planning, produce ordered steps with clear rationale.
- If data is provided, base your reasoning on the actual numbers/facts.
- Structure your response with a main interpretation, and optionally include a confidence level (0-1) and actionable suggestions.

Respond with ONLY a JSON object in this format:
{
  "interpretation": "Your main reasoning output here",
  "confidence": 0.85,
  "suggestions": ["actionable suggestion 1", "actionable suggestion 2"]
}

The "confidence" and "suggestions" fields are optional — include them only when relevant.
Always return valid JSON only, no markdown fences or additional text.`;

// ── Bedrock provider ─────────────────────────────────────────────────────────

/**
 * Invoke Amazon Bedrock with the reasoning prompt constructed from
 * context, data, and objective.
 *
 * @param {string} context - Background about the project/deployment/model
 * @param {object|undefined} data - Structured data to reason about
 * @param {string} objective - What to do (explain, recommend, diagnose, plan)
 * @param {object} config - Reasoning config (modelId, maxTokens, temperature)
 * @returns {Promise<{interpretation: string, confidence?: number, suggestions?: string[], error?: string}>}
 */
async function invokeBedrockProvider(context, data, objective, config) {
    // Dynamic import of AWS SDK
    let BedrockRuntimeClient, InvokeModelCommand;
    try {
        const mod = await Promise.race([
            import('@aws-sdk/client-bedrock-runtime'),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Import timed out')), 2000)
            )
        ]);
        BedrockRuntimeClient = mod.BedrockRuntimeClient;
        InvokeModelCommand = mod.InvokeModelCommand;
    } catch (err) {
        return {
            interpretation: '',
            error: `Failed to load AWS SDK: ${err.message}`
        };
    }

    const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
    const client = new BedrockRuntimeClient({
        region,
        requestHandler: { requestTimeout: 30000 }
    });

    // Construct user message
    let userMessage = `## Context\n${context}\n\n`;
    if (data && Object.keys(data).length > 0) {
        // Truncate data serialization to prevent excessive token usage
        let dataStr = JSON.stringify(data, null, 2);
        if (dataStr.length > 50000) {
            dataStr = `${dataStr.slice(0, 50000)  }\n... [truncated]`;
        }
        userMessage += `## Data\n\`\`\`json\n${dataStr}\n\`\`\`\n\n`;
    }
    userMessage += `## Objective\n${objective}`;

    try {
        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: config.maxTokens,
            temperature: config.temperature,
            system: SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: userMessage
            }]
        });

        const command = new InvokeModelCommand({
            modelId: config.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body
        });

        const response = await client.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const text = responseBody.content?.[0]?.text;

        if (!text) {
            return {
                interpretation: '',
                error: 'Bedrock response contained no text content'
            };
        }

        // Parse structured response
        return parseBedrockResponse(text);
    } catch (err) {
        if (err.name === 'ThrottlingException') {
            return { interpretation: '', error: 'ThrottlingException: Rate limit exceeded. Retry later.' };
        }
        if (err.name === 'ModelNotReadyException') {
            return { interpretation: '', error: 'ModelNotReadyException: Model is not ready. Retry later.' };
        }
        if (err.name === 'AccessDeniedException') {
            return { interpretation: '', error: `AccessDeniedException: Check bedrock:InvokeModel permission for ${config.modelId}` };
        }
        return {
            interpretation: '',
            error: `${err.name || 'Error'}: ${err.message}`
        };
    }
}

/**
 * Parse the Bedrock response text into the structured output format.
 * Handles both raw JSON and markdown-fenced JSON responses.
 *
 * @param {string} text - Raw response text from Bedrock
 * @returns {{interpretation: string, confidence?: number, suggestions?: string[]}}
 */
function parseBedrockResponse(text) {
    // Try markdown-fenced code block first
    const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const jsonStr = fencedMatch ? fencedMatch[1].trim() : text.trim();

    // Try parsing as JSON
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        // Try extracting JSON object from the text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch {
                // Fall back to treating the entire text as the interpretation
                return { interpretation: text.trim() };
            }
        } else {
            return { interpretation: text.trim() };
        }
    }

    // Build result from parsed JSON
    const result = {
        interpretation: typeof parsed.interpretation === 'string'
            ? parsed.interpretation
            : text.trim()
    };

    if (typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1) {
        result.confidence = parsed.confidence;
    }

    if (Array.isArray(parsed.suggestions)) {
        result.suggestions = parsed.suggestions.filter(s => typeof s === 'string');
        if (result.suggestions.length === 0) {
            delete result.suggestions;
        }
    }

    return result;
}

// ── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Handle the interpret tool invocation.
 *
 * @param {object} params - Tool input parameters
 * @param {string} params.context - Background context
 * @param {object} [params.data] - Structured data to reason about
 * @param {string} params.objective - What to do
 * @returns {object} MCP tool response
 */
async function handleInterpret({ context, data, objective }) {
    log(`Interpret: objective="${objective.slice(0, 80)}${objective.length > 80 ? '...' : ''}"`);

    if (reasoningConfig.provider !== 'bedrock') {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    interpretation: '',
                    error: `Unsupported provider: "${reasoningConfig.provider}". Only "bedrock" is supported in v1.5.`
                })
            }]
        };
    }

    const result = await invokeBedrockProvider(context, data, objective, reasoningConfig);

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result)
        }]
    };
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'reasoning',
    version: '1.0.0'
});

server.tool(
    'interpret',
    'Stateless reasoning/interpretation tool. Pass context about a project or deployment, optional structured data, and an objective (explain, recommend, diagnose, plan). Returns an interpretation with optional confidence and suggestions.',
    {
        context: z.string().describe('Background about the project, deployment, or model'),
        data: z.record(z.unknown()).optional().describe('Structured data to reason about (metrics, recommendations, log lines, etc.)'),
        objective: z.string().describe('What to do with the context and data (explain, recommend, diagnose, plan)')
    },
    async (params) => {
        return handleInterpret(params);
    }
);

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    handleInterpret,
    invokeBedrockProvider,
    parseBedrockResponse,
    loadReasoningConfig,
    reasoningConfig,
    server,
    DEFAULT_REASONING_CONFIG,
    SYSTEM_PROMPT
};

// ── Transport connection (main module only) ──────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
    log(`Starting reasoning MCP server (provider: ${reasoningConfig.provider}, model: ${reasoningConfig.modelId})`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
