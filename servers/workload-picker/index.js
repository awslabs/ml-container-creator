#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Workload Picker MCP Server
 *
 * PATTERN: MCP picker server built on the shared createPickerServer factory.
 *   Declares only its unique pieces — the workload-profiles catalog and the
 *   list_workloads / get_workload_profile tools — and lets the factory own the
 *   scaffold (catalog loader, logger, main-guard, stdio wiring).
 * COLLABORATORS: servers/lib/create-picker-server.js (scaffold),
 *   servers/lib/load-catalog.js (catalog loader);
 *   catalog ./catalogs/workload-profiles.json; spawned by src/lib/mcp-client.js
 *   and used by do/benchmark.
 * DATA-FLOW ROLE: returns benchmark workload profiles (token distributions,
 *   concurrency, streaming mode) by name or as a list.
 * See: docs/architecture/mcp-servers.md,
 *   docs/adr/ADR-003-mcp-picker-server-factory.md
 */

import { z } from 'zod';
import { createPickerServer } from '../lib/create-picker-server.js';
import { makeLoadCatalog, resolveServerDir } from '../lib/load-catalog.js';

// ── Catalog (loaded before tool schemas that reference workload names) ────────

const loadCatalog = makeLoadCatalog(resolveServerDir(import.meta.url));
const WORKLOAD_CATALOG = loadCatalog('./catalogs/workload-profiles.json');
const WORKLOAD_NAMES = Object.keys(WORKLOAD_CATALOG.workloads);

// ── Helper functions (exported for standalone tests) ──────────────────────────

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

// ── Server construction (scaffold via the factory) ────────────────────────────

const picker = createPickerServer({
    name: 'workload-picker',
    serverDir: import.meta.url,
    tools: [
        {
            name: 'list_workloads',
            description: 'Returns all available benchmark workload profiles with names, descriptions, and use cases',
            schema: {},
            handler: async () => {
                const result = listWorkloads();
                log(`list_workloads → ${result.workloads.length} workloads`);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            }
        },
        {
            name: 'get_workload_profile',
            description: 'Returns benchmark workload parameters for a named workload profile. Use list_workloads first to see available options.',
            schema: {
                workload: z.enum(WORKLOAD_NAMES).describe('Named workload profile to retrieve')
            },
            handler: async ({ workload }) => {
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
        }
    ]
});

const { log } = picker;

// ── Start server (connects only when run as the main module) ──────────────────

await picker.start({
    entryUrl: import.meta.url,
    onStart: () => log('Starting workload-picker MCP server...')
});
