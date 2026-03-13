#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock MCP Server for Integration Tests
 *
 * A minimal MCP server that speaks the JSON-RPC protocol over stdio.
 * Configurable via environment variables:
 *   MOCK_MCP_TOOL_NAME   - Tool name to register (default: get_ml_config)
 *   MOCK_MCP_RESPONSE     - JSON string of the response to return
 *   MOCK_MCP_ERROR        - If set, return an error response
 *   MOCK_MCP_DELAY_MS     - Delay before responding (for timeout tests)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const toolName = process.env.MOCK_MCP_TOOL_NAME || 'get_ml_config'
const delayMs = parseInt(process.env.MOCK_MCP_DELAY_MS || '0', 10)
const shouldError = process.env.MOCK_MCP_ERROR === 'true'

// Parse the response from env or use a default
let mockResponse
try {
    mockResponse = process.env.MOCK_MCP_RESPONSE
        ? JSON.parse(process.env.MOCK_MCP_RESPONSE)
        : { values: {}, choices: {} }
} catch {
    mockResponse = { values: {}, choices: {} }
}

const server = new McpServer({
    name: 'mock-mcp-server',
    version: '1.0.0'
})

server.tool(
    toolName,
    'Mock MCP tool for integration testing',
    {
        parameters: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        context: z.record(z.string(), z.any()).optional()
    },
    async ({ parameters, limit, context }) => {
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs))
        }

        if (shouldError) {
            throw new Error('Mock MCP server error')
        }

        // Build response based on requested parameters and limit
        const values = {}
        const choices = {}

        for (const param of (parameters || [])) {
            if (mockResponse.values && mockResponse.values[param] !== undefined) {
                values[param] = mockResponse.values[param]
            }
            if (mockResponse.choices && mockResponse.choices[param]) {
                const paramChoices = mockResponse.choices[param]
                choices[param] = limit ? paramChoices.slice(0, limit) : paramChoices
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

const transport = new StdioServerTransport()
await server.connect(transport)
