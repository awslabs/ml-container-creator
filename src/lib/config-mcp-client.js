// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Config MCP Client - Handles MCP server queries for configuration.
 * Uses delegation pattern: receives parent ConfigManager reference to access shared state.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');

export default class ConfigMcpClient {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Query configured MCP servers for unbounded parameter values.
     * @private
     */
    async _queryMcpServers() {
        // No-op: MCP queries now happen on-demand during prompting
        // via queryMcpServer(). This method is kept for backward compatibility.
    }

    /**
     * Query a single named MCP server on-demand with the given context.
     * @param {string} serverName - Name of the server in mcpServers config
     * @param {object} context - Context to pass to the MCP tool
     * @returns {Promise<{ values: object, choices: object } | null>}
     */
    async queryMcpServer(serverName, context = {}) {
        let mcpServerConfigs;
        try {
            const configPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(configPath)) return null;
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            mcpServerConfigs = config.mcpServers;
        } catch {
            return null;
        }

        if (!mcpServerConfigs || !mcpServerConfigs[serverName]) return null;

        const smart = this.manager.options.smart === true;
        const discover = this.manager.options.discover !== false;
        const serverConfig = mcpServerConfigs[serverName];

        const client = new McpClient(serverConfig, {
            timeout: 15000,
            parameterMatrix: this.manager.parameterMatrix,
            smart,
            discover
        });

        // Override the _buildContext to merge our search context
        const origBuildContext = client._buildContext.bind(client);
        client._buildContext = () => ({ ...origBuildContext(), ...context });

        try {
            const result = await client.query();
            await client.close();

            if (!result) {
                const diag = client.getDiagnosticMessage();
                if (diag) console.log(`   ⚠️  ${serverName}: ${diag}`);
                return null;
            }

            // Store values
            for (const [param, value] of Object.entries(result.values || {})) {
                const paramConfig = this.manager.parameterMatrix[param];
                if (paramConfig && paramConfig.valueSpace === 'unbounded' && paramConfig.mcp === true) {
                    this.manager.mcpSources[param] = {
                        server: serverName,
                        value,
                        timestamp: new Date().toISOString()
                    };
                }
            }

            // Store choices
            for (const [param, choices] of Object.entries(result.choices || {})) {
                const paramConfig = this.manager.parameterMatrix[param];
                if (paramConfig && paramConfig.valueSpace === 'unbounded' && paramConfig.mcp === true && Array.isArray(choices)) {
                    this.manager.mcpChoices[param] = choices;
                }
            }

            return result;
        } catch (err) {
            await client.close().catch(() => {});
            console.log(`   ⚠️  ${serverName}: ${err.message}`);
            return null;
        }
    }

    /**
     * Get the names of configured MCP servers.
     * @returns {string[]}
     */
    getMcpServerNames() {
        try {
            const configPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(configPath)) return [];
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return Object.keys(config.mcpServers || {});
        } catch {
            return [];
        }
    }
}
