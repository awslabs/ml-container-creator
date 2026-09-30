// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * createPickerServer — shared scaffold factory for bundled MCP picker servers.
 *
 * PATTERN: Factory. Builds the identical scaffold every servers/<name>/index.js
 *   used to copy-paste (McpServer + StdioServerTransport wiring, catalog loader,
 *   stderr logger, main-module guard, and opt-in Bedrock smart-mode), so each
 *   server file declares only its unique catalogs, tools, and handler logic.
 * COLLABORATORS: called by servers/<name>/index.js (all 14 picker servers);
 *   reuses servers/lib/bedrock-client.js (queryBedrock) for smart-mode; wraps
 *   @modelcontextprotocol/sdk McpServer + StdioServerTransport. Reached at
 *   runtime by src/lib/mcp-client.js, which spawns each server over stdio.
 * DATA-FLOW ROLE: server-construction. Consumes a declarative server spec
 *   ({ name, catalogs, tools, bedrock }); produces a live McpServer plus the
 *   loadCatalog/log/start helpers a server needs. Tool handlers still produce
 *   the { values, choices } MCP text envelope themselves.
 * See: docs/adr/ADR-003-mcp-picker-server-factory.md,
 *   docs/architecture/mcp-servers.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { queryBedrock } from './bedrock-client.js';
import { makeLoadCatalog, resolveServerDir } from './load-catalog.js';

/**
 * Default Bedrock model + region, matching the historical per-server defaults.
 * A server's `bedrock` config may override modelId/region.
 */
const DEFAULT_BEDROCK_MODEL = 'global.anthropic.claude-sonnet-4-20250514-v1:0';

/**
 * Build the picker-server scaffold.
 *
 * @param {object} spec
 * @param {string} spec.name - Server name; used as the McpServer name and the
 *   `[name]` stderr log prefix.
 * @param {string} spec.serverDir - The calling server's `import.meta.url` (or an
 *   absolute dir path). Catalog paths resolve relative to this, so each server
 *   loads its own catalogs regardless of where this factory lives.
 * @param {string} [spec.version='1.0.0'] - MCP server version.
 * @param {Object<string,string>} [spec.catalogs={}] - Map of catalogKey →
 *   path relative to serverDir. Loaded eagerly; a load/parse failure throws
 *   (fatal at startup, matching prior behavior).
 * @param {Array<{name:string, description:string, schema:object, handler:Function}>} spec.tools
 *   - One or more MCP tools to register (server.tool(name, description, schema, handler)).
 * @param {object} [spec.bedrock=null] - Opt-in smart-mode config. When present
 *   and BEDROCK_SMART=true, `querySmart()` calls Bedrock via bedrock-client.
 *   Fields: { systemPromptTemplate, modelId?, temperature?, maxTokens? }.
 * @returns {{
 *   server: McpServer,
 *   log: (msg:string)=>void,
 *   loadCatalog: (relativePath:string)=>any,
 *   catalogs: Object<string,any>,
 *   smartMode: boolean,
 *   querySmart: (parameters:string[], limit:number, context:object)=>Promise<object|null>,
 *   bedrockConfig: object|null,
 *   start: ()=>Promise<void>
 * }}
 */
export function createPickerServer(spec) {
    const {
        name,
        serverDir,
        version = '1.0.0',
        catalogs = {},
        tools = [],
        bedrock = null
    } = spec || {};

    if (!name) throw new Error('createPickerServer: `name` is required');
    if (!serverDir) throw new Error('createPickerServer: `serverDir` is required (pass import.meta.url)');
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('createPickerServer: `tools` must be a non-empty array');
    }

    // Resolve the server's directory whether serverDir is a file:// URL
    // (import.meta.url) or an absolute path.
    const dir = resolveServerDir(serverDir);

    /**
     * Log to stderr with the server name prefix. stdout is reserved for the MCP
     * stdio protocol, so all diagnostics go to stderr.
     */
    const log = (message) => {
        process.stderr.write(`[${name}] ${message}\n`);
    };

    // Shared catalog loader bound to this server's directory (single source of
    // truth in servers/lib/load-catalog.js).
    const loadCatalog = makeLoadCatalog(dir);

    // Eagerly load declared catalogs (fatal on failure — matches prior startup
    // behavior where a missing catalog exits the server).
    const loadedCatalogs = {};
    for (const [key, relativePath] of Object.entries(catalogs)) {
        loadedCatalogs[key] = loadCatalog(relativePath);
    }

    // ── Bedrock smart-mode (opt-in) ──────────────────────────────────────────
    const smartMode = bedrock ? process.env.BEDROCK_SMART === 'true' : false;
    let bedrockConfig = null;
    if (bedrock) {
        bedrockConfig = {
            serverName: name,
            systemPromptTemplate: bedrock.systemPromptTemplate,
            temperature: bedrock.temperature ?? 0.3,
            maxTokens: bedrock.maxTokens ?? 1024,
            modelId: bedrock.modelId
                || process.env.BEDROCK_MODEL
                || DEFAULT_BEDROCK_MODEL,
            region: bedrock.region
                || process.env.BEDROCK_REGION
                || process.env.AWS_REGION
                || 'us-east-1'
        };
    }

    /**
     * Query Bedrock with this server's config. Returns the parsed result or
     * null (on any failure or when smart-mode/bedrock is not configured), so a
     * handler can fall back to static results. Handlers keep their own
     * static→smart→fallback control flow; the factory just supplies the call.
     */
    const querySmart = async (parameters, limit, context) => {
        if (!bedrockConfig) return null;
        return queryBedrock(bedrockConfig, parameters, limit, context || {});
    };

    // ── MCP server + tool registration ───────────────────────────────────────
    const server = new McpServer({ name, version });
    for (const tool of tools) {
        if (!tool || !tool.name || typeof tool.handler !== 'function') {
            throw new Error(
                `createPickerServer(${name}): each tool needs { name, description, schema, handler }`
            );
        }
        server.tool(tool.name, tool.description || '', tool.schema || {}, tool.handler);
    }

    /**
     * Connect the stdio transport only when the calling module is the process
     * entrypoint. Importing a server (e.g. from a test) never opens a transport.
     * The caller passes its own import.meta.url so the guard compares the right
     * file.
     *
     * @param {object} [opts]
     * @param {string} [opts.entryUrl] - The server's import.meta.url. If omitted,
     *   falls back to the serverDir-derived path.
     * @param {()=>void} [opts.onStart] - Optional hook run before connecting
     *   (e.g. to log smart/static mode).
     */
    const start = async ({ entryUrl, onStart } = {}) => {
        const entryPath = entryUrl && entryUrl.startsWith('file:')
            ? fileURLToPath(entryUrl)
            : (entryUrl || null);
        const invoked = process.argv[1] && entryPath
            ? resolve(process.argv[1]) === resolve(entryPath)
            : false;
        if (!invoked) return;
        if (typeof onStart === 'function') onStart();
        const transport = new StdioServerTransport();
        await server.connect(transport);
    };

    return {
        server,
        log,
        loadCatalog,
        catalogs: loadedCatalogs,
        smartMode,
        querySmart,
        bedrockConfig,
        start
    };
}
