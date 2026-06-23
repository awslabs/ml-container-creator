// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Client
 *
 * Spawns an MCP server as a child process via stdio transport,
 * performs the protocol handshake, calls the configured tool,
 * and returns parsed configuration values.
 *
 * All errors are caught and returned as null with a diagnostic
 * message — never thrown.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __mcp_filename = fileURLToPath(import.meta.url);
const __mcp_dirname = path.dirname(__mcp_filename);
const PACKAGE_ROOT = path.resolve(__mcp_dirname, '../..');

const DEFAULT_TOOL_NAME = 'get_ml_config';
const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT = 10000; // 10 seconds
// const KILL_GRACE_PERIOD = 2000; // reserved for future graceful-shutdown logic

class McpClient {
    /**
     * @param {object} serverConfig - { command, args, env, toolName, limit }
     * @param {object} options - { timeout, parameterMatrix }
     */
    constructor(serverConfig, options = {}) {
        this.serverConfig = serverConfig;
        this.toolName = serverConfig.toolName || DEFAULT_TOOL_NAME;
        this.limit = serverConfig.limit || DEFAULT_LIMIT;
        this.timeout = options.timeout || DEFAULT_TIMEOUT;
        this.parameterMatrix = options.parameterMatrix || {};
        this.smart = options.smart || false;
        this.discover = options.discover !== undefined ? options.discover : true;
        this._transport = null;
        this._client = null;
        this._diagnosticMessage = null;
    }

    /**
     * Connect to the MCP server, perform handshake, query for config values.
     * @returns {Promise<{ values: Record<string, any>, choices: Record<string, string[]> } | null>}
     */
    async query() {
        try {
            return await this._queryWithTimeout();
        } catch (err) {
            this._diagnosticMessage = `MCP query failed: ${err.message}`;
            return null;
        }
    }

    /**
     * Wraps the actual query logic with a timeout that covers the
     * entire lifecycle: spawn + handshake + tool call + response parsing.
     */
    async _queryWithTimeout() {
        return new Promise((resolve, _reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    this._diagnosticMessage = `MCP server timed out after ${this.timeout}ms`;
                    this.close().catch(() => {});
                    resolve(null);
                }
            }, this.timeout);

            this._executeQuery()
                .then(result => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve(result);
                    }
                })
                .catch(err => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        this._diagnosticMessage = `MCP query failed: ${err.message}`;
                        resolve(null);
                    }
                });
        });
    }

    /**
     * Performs the actual MCP protocol flow:
     * 1. Spawn server via StdioClientTransport
     * 2. Connect Client (performs initialize handshake + initialized notification)
     * 3. Call the configured tool with unbounded parameter names and limit
     * 4. Parse and return the response
     */
    async _executeQuery() {
        const { command, args = [], env } = this.serverConfig;

        // Resolve relative paths in args against the package root
        const resolvedArgs = args.map(arg => {
            if (arg && !path.isAbsolute(arg) && !arg.startsWith('-')) {
                const resolved = path.resolve(PACKAGE_ROOT, arg);
                return resolved;
            }
            return arg;
        });

        // Build environment: merge process.env with server-specific env
        // When --smart flag is active, inject BEDROCK_SMART=true for this run
        // Discover mode is now default; inject DISCOVER_MODE=false only when explicitly disabled
        // Always pass process.env so child processes inherit AWS credentials, profiles, etc.
        const smartEnv = this.smart ? { BEDROCK_SMART: 'true' } : {};
        const discoverEnv = this.discover === false ? { DISCOVER_MODE: 'false' } : {};
        const serverEnv = env && Object.keys(env).length > 0 ? env : {};
        const spawnEnv = { ...process.env, ...smartEnv, ...discoverEnv, ...serverEnv };

        // Create stdio transport — spawns the server process
        this._transport = new StdioClientTransport({
            command,
            args: resolvedArgs,
            env: spawnEnv,
            stderr: 'pipe'
        });

        // Create MCP client
        this._client = new Client(
            { name: 'ml-container-creator', version: '1.0.0' },
            { capabilities: {} }
        );

        // Connect performs the initialize handshake automatically
        await this._client.connect(this._transport);

        // Build the list of unbounded parameter names
        const unboundedParams = this._getUnboundedParameterNames();

        // Build context from bounded parameters that have defaults
        const context = this._buildContext();

        // Auto-discover tool name if using the default (get_ml_config)
        // Each server registers its own tool name (e.g. get_base_images, get_inference_endpoints)
        let toolName = this.toolName;
        if (toolName === DEFAULT_TOOL_NAME) {
            try {
                const toolList = await this._client.listTools();
                if (toolList && toolList.tools && toolList.tools.length > 0) {
                    toolName = toolList.tools[0].name;
                }
            } catch (_listErr) {
                // Fall through to use default tool name
            }
        }

        // Call the configured tool
        const result = await this._client.callTool({
            name: toolName,
            arguments: {
                parameters: unboundedParams,
                limit: this.limit,
                context
            }
        });

        // Parse the response
        return this._parseResponse(result);
    }

    /**
     * Extract unbounded parameter names from the parameter matrix.
     * @returns {string[]}
     */
    _getUnboundedParameterNames() {
        const names = [];
        for (const [name, config] of Object.entries(this.parameterMatrix)) {
            if (config.valueSpace === 'unbounded' && config.mcp === true) {
                names.push(name);
            }
        }
        return names;
    }

    /**
     * Build context object from bounded parameters with known defaults.
     * This gives the MCP server context about the current configuration.
     * @returns {object}
     */
    _buildContext() {
        const context = {};
        for (const [name, config] of Object.entries(this.parameterMatrix)) {
            if (config.valueSpace === 'bounded' && config.default !== null && config.default !== undefined) {
                context[name] = config.default;
            }
        }
        return context;
    }

    /**
     * Parse the MCP tool call response into { values, choices }.
     * The response content is an array of content blocks; we look for
     * a text block containing JSON with values and/or choices.
     * @param {object} result - The callTool result
     * @returns {{ values: Record<string, any>, choices: Record<string, string[]> } | null}
     */
    _parseResponse(result) {
        if (!result) {
            this._diagnosticMessage = 'MCP server returned empty result';
            return null;
        }

        // Check for error flag
        if (result.isError) {
            const errorText = this._extractTextContent(result);
            this._diagnosticMessage = `MCP server returned error: ${errorText || 'unknown error'}`;
            return null;
        }

        // Extract text content from the response
        const textContent = this._extractTextContent(result);
        if (!textContent) {
            this._diagnosticMessage = 'MCP server returned no text content';
            return null;
        }

        // Parse JSON from text content
        let parsed;
        try {
            parsed = JSON.parse(textContent);
        } catch (err) {
            this._diagnosticMessage = `MCP server returned malformed JSON: ${err.message}`;
            return null;
        }

        // Validate structure
        if (typeof parsed !== 'object' || parsed === null) {
            this._diagnosticMessage = 'MCP server returned non-object response';
            return null;
        }

        const values = {};
        const choices = {};
        const metadata = {};

        // Extract values — only for unbounded parameters
        if (parsed.values && typeof parsed.values === 'object') {
            for (const [key, value] of Object.entries(parsed.values)) {
                values[key] = value;
            }
        }

        // Extract choices — only for unbounded parameters
        if (parsed.choices && typeof parsed.choices === 'object') {
            for (const [key, choiceList] of Object.entries(parsed.choices)) {
                if (Array.isArray(choiceList)) {
                    choices[key] = choiceList;
                }
            }
        }

        // Extract metadata — pass through for rich display (e.g., ImageEntry objects)
        if (parsed.metadata && typeof parsed.metadata === 'object') {
            for (const [key, value] of Object.entries(parsed.metadata)) {
                metadata[key] = value;
            }
        }

        const response = { values, choices, message: parsed.message || null };
        if (Object.keys(metadata).length > 0) {
            response.metadata = metadata;
        }
        return response;
    }

    /**
     * Extract text content from an MCP tool result.
     * @param {object} result
     * @returns {string | null}
     */
    _extractTextContent(result) {
        if (!result.content || !Array.isArray(result.content)) {
            return null;
        }

        const textBlock = result.content.find(block => block.type === 'text');
        return textBlock ? textBlock.text : null;
    }

    /**
     * Get the diagnostic message from the last operation.
     * @returns {string | null}
     */
    getDiagnosticMessage() {
        return this._diagnosticMessage;
    }

    /**
     * Cleanly terminate the server process.
     * Sends SIGTERM first, then SIGKILL after grace period.
     */
    async close() {
        try {
            if (this._client) {
                await this._client.close();
                this._client = null;
            }
            if (this._transport) {
                await this._transport.close();
                this._transport = null;
            }
        } catch (err) {
            // If graceful close fails, force kill via transport
            if (this._transport) {
                try {
                    // The transport's close() handles SIGTERM + SIGKILL
                    await this._transport.close();
                } catch (_) {
                    // Ignore — process may already be dead
                }
                this._transport = null;
            }
            this._client = null;
        }
    }
}

export default McpClient;
export { McpClient, DEFAULT_TOOL_NAME, DEFAULT_LIMIT, DEFAULT_TIMEOUT };
