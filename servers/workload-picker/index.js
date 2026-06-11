#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Workload Picker MCP Server
 *
 * A bundled MCP server that provides named benchmark workload profiles
 * for use with `do/benchmark`. Workloads define token distributions,
 * concurrency levels, streaming mode, and intended use cases.
 *
 * Tools:
 *   - list_workloads: Returns all available workload names with descriptions
 *   - get_workload_profile: Returns full parameters for a named workload
 *
 * The catalog is loaded from ./catalogs/workload-profiles.json and can be
 * extended by adding entries to that file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// ── Catalog loader ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load and parse a JSON catalog file relative to the server directory.
 * Throws on missing file or invalid JSON with the file path in the message.
 *
 * @param {string} relativePath - Path relative to server dir
 * @returns {any} Parsed JSON content
 */
function loadCatalog(relativePath) {
    const fullPath = resolve(__dirname, relativePath);
    let raw;
    try {
        raw = readFileSync(fullPath, 'utf8');
    } catch (err) {
        throw new Error(`Catalog file not found: ${fullPath}`);
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`Failed to parse catalog ${fullPath}: ${err.message}`);
    }
}

// ── Load workload profiles ───────────────────────────────────────────────────

let WORKLOAD_CATALOG;

try {
    WORKLOAD_CATALOG = loadCatalog('./catalogs/workload-profiles.json');
} catch (err) {
    process.stderr.write(`[workload-picker] Fatal: ${err.message}\n`);
    process.exit(1);
}

const WORKLOAD_NAMES = Object.keys(WORKLOAD_CATALOG.workloads);

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * List all available workloads with name + description + use_case.
 *
 * @returns {{ workloads: Array<{ name: string, description: string, use_case: string }> }}
 */
export function listWorkloads() {
    const workloads = WORKLOAD_NAMES.map(name => ({
        name,
        description: WORKLOAD_CATALOG.workloads[name].description,
        use_case: WORKLOAD_CATALOG.workloads[name].use_case
    }));
    return { workloads };
}

/**
 * Get full workload profile by name.
 *
 * @param {string} workloadName - One of the defined workload names
 * @returns {object|null} Full workload profile or null if not found
 */
export function getWorkloadProfile(workloadName) {
    const profile = WORKLOAD_CATALOG.workloads[workloadName];
    if (!profile) return null;
    return { name: workloadName, ...profile };
}

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[workload-picker] ${message}\n`);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'workload-picker',
    version: '1.0.0'
});

// Register the list_workloads tool
server.tool(
    'list_workloads',
    'Returns all available benchmark workload profiles with names, descriptions, and use cases',
    {},
    async () => {
        const result = listWorkloads();
        log(`list_workloads → ${result.workloads.length} workloads`);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }]
        };
    }
);

// Register the get_workload_profile tool
server.tool(
    'get_workload_profile',
    'Returns benchmark workload parameters for a named workload profile. Use list_workloads first to see available options.',
    {
        workload: z.enum(WORKLOAD_NAMES).describe('Named workload profile to retrieve')
    },
    async ({ workload }) => {
        const profile = getWorkloadProfile(workload);

        if (!profile) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        error: `Unknown workload: ${workload}`,
                        available: WORKLOAD_NAMES
                    })
                }],
                isError: true
            };
        }

        log(`get_workload_profile → ${workload}`);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(profile, null, 2)
            }]
        };
    }
);

// ── Start server ─────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    log('Starting workload-picker MCP server...');
    await server.connect(transport);
    log('Server connected and ready');
}

main().catch(err => {
    process.stderr.write(`[workload-picker] Fatal startup error: ${err.message}\n`);
    process.exit(1);
});
