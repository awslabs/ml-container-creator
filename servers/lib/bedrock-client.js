// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Bedrock Client
 *
 * Reusable module that encapsulates Amazon Bedrock LLM invocation,
 * JSON extraction, and fail-fast error handling for bundled MCP servers.
 *
 * Each server passes its own SERVER_CONFIG to queryBedrock() so that
 * system prompts, hyperparameters, and model selection are per-server.
 */

/**
 * Extract a JSON object from text that may be raw JSON or wrapped
 * in a markdown-fenced code block (```json ... ```).
 *
 * @param {string} text - Raw LLM response text
 * @returns {object|null} Parsed JSON object, or null if extraction fails
 */
export function extractJson(text) {
    if (!text || typeof text !== 'string') return null

    // Try markdown-fenced code block first (```json ... ``` or ``` ... ```)
    const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    if (fencedMatch) {
        try {
            return JSON.parse(fencedMatch[1].trim())
        } catch {
            // Fall through to raw extraction
        }
    }

    // Try extracting raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0])
        } catch {
            return null
        }
    }

    return null
}

/**
 * Query Amazon Bedrock for context-aware recommendations.
 * Returns parsed JSON object on success, null on any failure.
 *
 * @param {object} serverConfig - Per-server configuration
 * @param {string} serverConfig.systemPromptTemplate - Prompt template with {context}, {parameters}, {limit} placeholders
 * @param {number} serverConfig.temperature - LLM temperature (0-1)
 * @param {number} serverConfig.maxTokens - Max response tokens
 * @param {string} serverConfig.modelId - Bedrock model ID
 * @param {string} serverConfig.region - AWS region for Bedrock API
 * @param {string} serverConfig.serverName - Server name for log prefixes
 * @param {string[]} parameters - Requested parameter names
 * @param {number} limit - Max choices per parameter
 * @param {object} context - Current configuration context
 * @returns {Promise<{values: object} | null>}
 */
export async function queryBedrock(serverConfig, parameters, limit, context) {
    const prefix = `[${serverConfig.serverName}]`

    // Dynamic import with 1s timeout
    let BedrockRuntimeClient, InvokeModelCommand
    try {
        const mod = await Promise.race([
            import('@aws-sdk/client-bedrock-runtime'),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Import timed out')), 1000)
            )
        ])
        BedrockRuntimeClient = mod.BedrockRuntimeClient
        InvokeModelCommand = mod.InvokeModelCommand
    } catch {
        log(prefix, 'Failed to load @aws-sdk/client-bedrock-runtime. Run "npm install" in the servers/lib/ directory')
        return null
    }

    const client = new BedrockRuntimeClient({
        region: serverConfig.region,
        requestHandler: {
            requestTimeout: 10000
        }
    })

    // Build prompt from template
    const contextStr = context && Object.keys(context).length > 0
        ? JSON.stringify(context)
        : 'No specific configuration context provided.'

    const prompt = serverConfig.systemPromptTemplate
        .replace('{context}', contextStr)
        .replace('{parameters}', parameters.join(', '))
        .replace('{limit}', String(limit))

    try {
        log(prefix, `Querying Bedrock model ${serverConfig.modelId} in ${serverConfig.region}...`)

        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: serverConfig.maxTokens,
            temperature: serverConfig.temperature,
            messages: [{
                role: 'user',
                content: prompt
            }]
        })

        const command = new InvokeModelCommand({
            modelId: serverConfig.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body
        })

        const response = await client.send(command)
        const responseBody = JSON.parse(new TextDecoder().decode(response.body))

        const text = responseBody.content?.[0]?.text
        if (!text) {
            log(prefix, 'Bedrock response contained no text content')
            return null
        }

        const parsed = extractJson(text)
        if (!parsed) {
            log(prefix, 'Could not extract JSON from Bedrock response')
            return null
        }

        if (!parsed.values || typeof parsed.values !== 'object') {
            log(prefix, 'Bedrock response missing "values" object')
            return null
        }

        log(prefix, `Bedrock returned recommendations: ${JSON.stringify(parsed.values)}`)
        return parsed
    } catch (err) {
        if (err.name === 'AccessDeniedException') {
            log(prefix, `Access denied. Ensure bedrock:InvokeModel permission for arn:aws:bedrock:${serverConfig.region}:*:inference-profile/${serverConfig.modelId}`)
        } else if (err.name === 'ResourceNotFoundException') {
            log(prefix, `Model "${serverConfig.modelId}" not found. Set BEDROCK_MODEL env var. Example: BEDROCK_MODEL=global.anthropic.claude-sonnet-4-20250514-v1:0`)
        } else if (err.name === 'ThrottlingException') {
            log(prefix, 'Bedrock rate limit hit. Falling back to static recommendations')
        } else {
            log(prefix, `Bedrock query failed: ${err.name}: ${err.message}`)
        }
        return null
    }
}

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(prefix, message) {
    process.stderr.write(`${prefix} ${message}\n`)
}
