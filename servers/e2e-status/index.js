#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Status MCP Server
 *
 * An optional bundled MCP server that surfaces E2E validation status
 * from the DynamoDB CI table. Disabled by default in config/mcp.json.
 *
 * Tools:
 *   get_e2e_status  - Query CI table by configId list, returns per-config status
 *   list_e2e_runs   - Query recent E2E run summaries grouped by runId
 *
 * The server reads from the DynamoDB CI table using the bootstrap config
 * for credentials/region. If the table is not provisioned, tools return
 * empty results with a warning.
 *
 * PATTERN: MCP server built on the shared createPickerServer factory. Declares
 *   only its DynamoDB-backed tools and defers the scaffold (logger, main-guard,
 *   stdio wiring) to the factory. Not a catalog-backed picker; it queries the
 *   CI table at request time rather than a bundled JSON catalog.
 * COLLABORATORS: servers/lib/create-picker-server.js (scaffold); reads the
 *   DynamoDB CI table via @aws-sdk/client-dynamodb and src/lib/bootstrap-config.js;
 *   spawned by src/lib/mcp-client.js over stdio.
 * DATA-FLOW ROLE: query. Given configIds or a tier/limit, returns per-config
 *   status or grouped run summaries pulled from the CI table.
 * See: docs/architecture/mcp-servers.md,
 *   docs/adr/ADR-003-mcp-picker-server-factory.md
 */

import { z } from 'zod';
import { createPickerServer } from '../lib/create-picker-server.js';

// ── Bootstrap config loader ──────────────────────────────────────────────────

/**
 * Load the bootstrap config to get CI table name and AWS region.
 * Falls back to environment variable CI_TABLE_NAME (default: "mlcc-ci-table")
 * and AWS_REGION / AWS_DEFAULT_REGION if bootstrap config is unavailable.
 *
 * @returns {Promise<{tableName: string, region: string}|null>}
 */
async function loadBootstrapConfig() {
    // Try bootstrap config first
    try {
        const { default: BootstrapConfig } = await import('../../src/lib/bootstrap-config.js');
        const config = new BootstrapConfig();
        const profile = config.getActiveProfileWithDefaults();
        if (profile && profile.config.ciInfraProvisioned) {
            return {
                tableName: profile.config.ciTableName,
                region: profile.config.awsRegion
            };
        }
    } catch {
        // Bootstrap config not available — fall through to env vars
    }

    // Fall back to environment variables
    const tableName = process.env.CI_TABLE_NAME || 'mlcc-ci-table';
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';

    // Only return config if we have a table name (env var or default)
    return { tableName, region };
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

let dynamoClient = null;
let tableConfig = null;

/**
 * Lazily initialize the DynamoDB client.
 * Returns null if CI table is not provisioned.
 */
async function getDynamoClient() {
    if (dynamoClient) return { client: dynamoClient, tableName: tableConfig.tableName };

    tableConfig = await loadBootstrapConfig();
    if (!tableConfig) return null;

    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    dynamoClient = new DynamoDBClient({ region: tableConfig.region });
    return { client: dynamoClient, tableName: tableConfig.tableName };
}

// ── Tool: get_e2e_status ─────────────────────────────────────────────────────

/**
 * Query DynamoDB CI table by configId list using BatchGetItem.
 * Returns per-config status, timestamp, tier, and failing stage.
 *
 * @param {string[]} configIds - List of configId values to query
 * @returns {Promise<{results: Array}>}
 */
async function getE2eStatus(configIds) {
    const db = await getDynamoClient();
    if (!db) {
        return { results: [], warning: 'CI table not provisioned' };
    }

    const { client, tableName } = db;

    try {
        const { BatchGetItemCommand } = await import('@aws-sdk/client-dynamodb');
        const { unmarshall } = await import('@aws-sdk/util-dynamodb');

        // BatchGetItem has a 100-item limit; chunk if needed
        const chunks = [];
        for (let i = 0; i < configIds.length; i += 100) {
            chunks.push(configIds.slice(i, i + 100));
        }

        const results = [];

        for (const chunk of chunks) {
            const keys = chunk.map(id => ({ configId: { S: id } }));

            const response = await client.send(new BatchGetItemCommand({
                RequestItems: {
                    [tableName]: { Keys: keys }
                }
            }));

            const items = response.Responses?.[tableName] || [];
            for (const rawItem of items) {
                const item = unmarshall(rawItem);
                results.push({
                    configId: item.configId,
                    testStatus: item.testStatus || 'untested',
                    lastTestTimestamp: item.lastTestTimestamp || null,
                    tier: item.tier || null,
                    failingStage: item.testStatus && item.testStatus.startsWith('fail-')
                        ? item.testStatus.replace('fail-', '')
                        : null
                });
            }
        }

        // Add 'untested' entries for configIds not found in the table
        const foundIds = new Set(results.map(r => r.configId));
        for (const id of configIds) {
            if (!foundIds.has(id)) {
                results.push({
                    configId: id,
                    testStatus: 'untested',
                    lastTestTimestamp: null,
                    tier: null,
                    failingStage: null
                });
            }
        }

        return { results };
    } catch (err) {
        return { results: [], error: `Failed to query CI table: ${err.message}` };
    }
}

// ── Tool: list_e2e_runs ──────────────────────────────────────────────────────

/**
 * Scan the CI table for recent entries and group by runId.
 * Returns run summaries with pass/fail counts.
 *
 * Since the CI table stores per-config results (not per-run), we scan
 * recent entries and group them by their lastTestTimestamp date to
 * approximate run grouping. A more precise approach would require a
 * secondary index on runId.
 *
 * @param {object} options
 * @param {string} [options.tier] - Optional tier filter
 * @param {number} [options.limit] - Max number of runs to return (default 10)
 * @returns {Promise<{runs: Array}>}
 */
async function listE2eRuns(options = {}) {
    const { tier, limit = 10 } = options;
    const db = await getDynamoClient();
    if (!db) {
        return { runs: [], warning: 'CI table not provisioned' };
    }

    const { client, tableName } = db;

    try {
        const { ScanCommand } = await import('@aws-sdk/client-dynamodb');
        const { unmarshall } = await import('@aws-sdk/util-dynamodb');

        const scanParams = {
            TableName: tableName,
            Limit: 500 // Scan a reasonable number of recent items
        };

        // Apply tier filter if specified
        if (tier) {
            scanParams.FilterExpression = 'tier = :tier';
            scanParams.ExpressionAttributeValues = { ':tier': { S: tier } };
        }

        const response = await client.send(new ScanCommand(scanParams));
        const items = (response.Items || []).map(i => unmarshall(i));

        // Group items by date (YYYY-MM-DD from lastTestTimestamp) as a run proxy
        const runMap = new Map();
        for (const item of items) {
            if (!item.lastTestTimestamp) continue;
            const dateKey = item.lastTestTimestamp.slice(0, 10); // YYYY-MM-DD
            const runId = `${item.tier || 'unknown'}-${dateKey}`;

            if (!runMap.has(runId)) {
                runMap.set(runId, {
                    runId,
                    tier: item.tier || 'unknown',
                    timestamp: item.lastTestTimestamp,
                    passed: 0,
                    failed: 0
                });
            }

            const run = runMap.get(runId);
            if (item.testStatus === 'pass') {
                run.passed++;
            } else {
                run.failed++;
            }

            // Keep the most recent timestamp for the run
            if (item.lastTestTimestamp > run.timestamp) {
                run.timestamp = item.lastTestTimestamp;
            }
        }

        // Sort by timestamp descending and limit
        const runs = Array.from(runMap.values())
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);

        return { runs };
    } catch (err) {
        return { runs: [], error: `Failed to scan CI table: ${err.message}` };
    }
}

// ── Tool handlers ────────────────────────────────────────────────────────────

async function getE2eStatusHandler({ configIds }) {
    const result = await getE2eStatus(configIds);
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result)
        }]
    };
}

async function listE2eRunsHandler({ tier, limit }) {
    const result = await listE2eRuns({ tier, limit });
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result)
        }]
    };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const picker = createPickerServer({
    name: 'e2e-status',
    serverDir: import.meta.url,
    tools: [
        {
            name: 'get_e2e_status',
            description: 'Returns E2E validation status for one or more configIds from the CI table',
            schema: {
                configIds: z.array(z.string()).min(1).describe('List of configId values to query status for')
            },
            handler: getE2eStatusHandler
        },
        {
            name: 'list_e2e_runs',
            description: 'Returns recent E2E run summaries with pass/fail counts, optionally filtered by tier',
            schema: {
                tier: z.string().optional().describe('Filter by tier (ci, nightly, weekly)'),
                limit: z.number().int().positive().default(10).describe('Maximum number of runs to return')
            },
            handler: listE2eRunsHandler
        }
    ]
});

const { log } = picker;

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    getE2eStatus,
    listE2eRuns,
    loadBootstrapConfig,
    getDynamoClient
};

// ── Main guard ───────────────────────────────────────────────────────────────

await picker.start({
    entryUrl: import.meta.url,
    onStart: () => log('Starting E2E status MCP server')
});
