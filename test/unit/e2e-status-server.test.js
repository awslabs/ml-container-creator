// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Status MCP Server Unit Tests — get_e2e_status tool
 *
 * Tests:
 * - BatchGetItem query with found and missing configIds
 * - failingStage derivation from testStatus
 * - Untested entries for missing configIds
 * - Graceful error handling when DynamoDB is unreachable
 * - Chunking for >100 configIds
 *
 * Feature: e2e-catalog-consolidation
 * Validates: Requirements 6.1, 6.2
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';

/**
 * Simple unmarshall for DynamoDB AttributeValue format used in tests.
 * Only handles { S: string } attributes which is all we need.
 */
function simpleUnmarshall(item) {
    const result = {};
    for (const [key, value] of Object.entries(item)) {
        if (value && typeof value === 'object' && 'S' in value) {
            result[key] = value.S;
        } else if (value && typeof value === 'object' && 'N' in value) {
            result[key] = Number(value.N);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Replicates the core logic of getE2eStatus from servers/e2e-status/index.js
 * without requiring AWS SDK imports. This tests the business logic in isolation.
 */
function createGetE2eStatus(mockSend) {
    return async function getE2eStatus(configIds) {
        const tableName = process.env.CI_TABLE_NAME || 'mlcc-ci-table';

        try {
            // BatchGetItem has a 100-item limit; chunk if needed
            const chunks = [];
            for (let i = 0; i < configIds.length; i += 100) {
                chunks.push(configIds.slice(i, i + 100));
            }

            const results = [];

            for (const chunk of chunks) {
                const keys = chunk.map(id => ({ configId: { S: id } }));

                const response = await mockSend({
                    RequestItems: {
                        [tableName]: { Keys: keys }
                    }
                });

                const items = response.Responses?.[tableName] || [];
                for (const rawItem of items) {
                    const item = simpleUnmarshall(rawItem);
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
    };
}

describe('E2E Status MCP Server — get_e2e_status', () => {

    describe('getE2eStatus — result mapping', () => {

        it('returns correct fields for a passing config', async () => {
            const mockSend = async (_params) => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'abc123def456' },
                            testStatus: { S: 'pass' },
                            lastTestTimestamp: { S: '2025-01-15T10:30:00Z' },
                            tier: { S: 'ci' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['abc123def456']);

            assert.strictEqual(result.results.length, 1);
            const entry = result.results[0];
            assert.strictEqual(entry.configId, 'abc123def456');
            assert.strictEqual(entry.testStatus, 'pass');
            assert.strictEqual(entry.lastTestTimestamp, '2025-01-15T10:30:00Z');
            assert.strictEqual(entry.tier, 'ci');
            assert.strictEqual(entry.failingStage, null);
        });

        it('derives failingStage from fail- prefix in testStatus', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'config-001' },
                            testStatus: { S: 'fail-tune-sft' },
                            lastTestTimestamp: { S: '2025-01-15T08:00:00Z' },
                            tier: { S: 'nightly' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['config-001']);

            assert.strictEqual(result.results.length, 1);
            assert.strictEqual(result.results[0].testStatus, 'fail-tune-sft');
            assert.strictEqual(result.results[0].failingStage, 'tune-sft');
        });

        it('returns failingStage null for non-fail statuses', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'config-002' },
                            testStatus: { S: 'pass' },
                            lastTestTimestamp: { S: '2025-01-15T08:00:00Z' },
                            tier: { S: 'ci' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['config-002']);

            assert.strictEqual(result.results[0].failingStage, null);
        });

        it('returns untested entries for configIds not found in table', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'found-id' },
                            testStatus: { S: 'pass' },
                            lastTestTimestamp: { S: '2025-01-15T08:00:00Z' },
                            tier: { S: 'ci' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['found-id', 'missing-id-1', 'missing-id-2']);

            assert.strictEqual(result.results.length, 3);

            const found = result.results.find(r => r.configId === 'found-id');
            assert.strictEqual(found.testStatus, 'pass');

            const missing1 = result.results.find(r => r.configId === 'missing-id-1');
            assert.strictEqual(missing1.testStatus, 'untested');
            assert.strictEqual(missing1.lastTestTimestamp, null);
            assert.strictEqual(missing1.tier, null);
            assert.strictEqual(missing1.failingStage, null);

            const missing2 = result.results.find(r => r.configId === 'missing-id-2');
            assert.strictEqual(missing2.testStatus, 'untested');
        });

        it('returns all entries as untested when table is empty', async () => {
            const mockSend = async () => ({
                Responses: { 'mlcc-ci-table': [] }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['id-a', 'id-b']);

            assert.strictEqual(result.results.length, 2);
            assert.ok(result.results.every(r => r.testStatus === 'untested'));
            assert.ok(result.results.every(r => r.lastTestTimestamp === null));
            assert.ok(result.results.every(r => r.tier === null));
            assert.ok(result.results.every(r => r.failingStage === null));
        });

        it('handles fail-deploy stage correctly', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'deploy-fail' },
                            testStatus: { S: 'fail-deploy' },
                            lastTestTimestamp: { S: '2025-01-14T12:00:00Z' },
                            tier: { S: 'weekly' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['deploy-fail']);

            assert.strictEqual(result.results[0].failingStage, 'deploy');
            assert.strictEqual(result.results[0].tier, 'weekly');
        });

        it('handles missing lastTestTimestamp gracefully', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'no-timestamp' },
                            testStatus: { S: 'pass' },
                            tier: { S: 'ci' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['no-timestamp']);

            assert.strictEqual(result.results[0].lastTestTimestamp, null);
        });

        it('handles missing tier gracefully', async () => {
            const mockSend = async () => ({
                Responses: {
                    'mlcc-ci-table': [
                        {
                            configId: { S: 'no-tier' },
                            testStatus: { S: 'pass' },
                            lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }
                        }
                    ]
                }
            });

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['no-tier']);

            assert.strictEqual(result.results[0].tier, null);
        });
    });

    describe('getE2eStatus — error handling', () => {

        it('returns error message when DynamoDB call fails', async () => {
            const mockSend = async () => {
                throw new Error('Network timeout');
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['some-id']);

            assert.deepStrictEqual(result.results, []);
            assert.ok(result.error);
            assert.ok(result.error.includes('Network timeout'));
        });

        it('returns error message when access denied', async () => {
            const mockSend = async () => {
                throw new Error('Access denied: User is not authorized');
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['some-id']);

            assert.deepStrictEqual(result.results, []);
            assert.ok(result.error.includes('Access denied'));
        });

        it('error message includes "Failed to query CI table" prefix', async () => {
            const mockSend = async () => {
                throw new Error('Connection refused');
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(['some-id']);

            assert.ok(result.error.startsWith('Failed to query CI table:'));
        });
    });

    describe('getE2eStatus — chunking for >100 configIds', () => {

        it('handles more than 100 configIds by chunking', async () => {
            const configIds = Array.from({ length: 150 }, (_, i) => `config-${i.toString().padStart(3, '0')}`);

            let callCount = 0;
            const mockSend = async (params) => {
                callCount++;
                const keys = params.RequestItems['mlcc-ci-table'].Keys;
                // Return items only for the first 50 keys in the first chunk
                const items = callCount === 1
                    ? keys.slice(0, 50).map(k => ({
                        configId: k.configId,
                        testStatus: { S: 'pass' },
                        lastTestTimestamp: { S: '2025-01-15T10:00:00Z' },
                        tier: { S: 'ci' }
                    }))
                    : [];

                return {
                    Responses: { 'mlcc-ci-table': items }
                };
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            const result = await getE2eStatus(configIds);

            // Should have called send twice (100 + 50 items)
            assert.strictEqual(callCount, 2);

            // Should have all 150 results
            assert.strictEqual(result.results.length, 150);

            // First 50 should be 'pass'
            const passed = result.results.filter(r => r.testStatus === 'pass');
            assert.strictEqual(passed.length, 50);

            // Remaining 100 should be 'untested'
            const untested = result.results.filter(r => r.testStatus === 'untested');
            assert.strictEqual(untested.length, 100);
        });

        it('chunks exactly at 100-item boundaries', async () => {
            const configIds = Array.from({ length: 200 }, (_, i) => `id-${i}`);

            let callCount = 0;
            const mockSend = async (params) => {
                callCount++;
                const keys = params.RequestItems['mlcc-ci-table'].Keys;
                // Verify each chunk has at most 100 keys
                assert.ok(keys.length <= 100, `Chunk should have <= 100 keys, got ${keys.length}`);
                return { Responses: { 'mlcc-ci-table': [] } };
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            await getE2eStatus(configIds);

            assert.strictEqual(callCount, 2);
        });
    });

    describe('getE2eStatus — environment variable fallback', () => {

        it('uses CI_TABLE_NAME env var for table name', async () => {
            const originalEnv = process.env.CI_TABLE_NAME;
            process.env.CI_TABLE_NAME = 'custom-table-name';

            let capturedTableName = null;
            const mockSend = async (params) => {
                capturedTableName = Object.keys(params.RequestItems)[0];
                return { Responses: { [capturedTableName]: [] } };
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            await getE2eStatus(['test-id']);

            assert.strictEqual(capturedTableName, 'custom-table-name');

            // Restore
            if (originalEnv === undefined) {
                delete process.env.CI_TABLE_NAME;
            } else {
                process.env.CI_TABLE_NAME = originalEnv;
            }
        });

        it('defaults to mlcc-ci-table when CI_TABLE_NAME is not set', async () => {
            const originalEnv = process.env.CI_TABLE_NAME;
            delete process.env.CI_TABLE_NAME;

            let capturedTableName = null;
            const mockSend = async (params) => {
                capturedTableName = Object.keys(params.RequestItems)[0];
                return { Responses: { [capturedTableName]: [] } };
            };

            const getE2eStatus = createGetE2eStatus(mockSend);
            await getE2eStatus(['test-id']);

            assert.strictEqual(capturedTableName, 'mlcc-ci-table');

            // Restore
            if (originalEnv !== undefined) {
                process.env.CI_TABLE_NAME = originalEnv;
            }
        });
    });
});


// ── list_e2e_runs tests ──────────────────────────────────────────────────────

/**
 * E2E Status MCP Server Unit Tests — list_e2e_runs tool
 *
 * Tests:
 * - Grouping entries by runId (tier + date)
 * - Correct pass/fail counting
 * - Tier filtering
 * - Limit parameter
 * - Empty table handling
 * - Error handling when DynamoDB is unreachable
 *
 * Feature: e2e-catalog-consolidation
 * Validates: Requirements 6.6
 */

/**
 * Replicates the core logic of listE2eRuns from servers/e2e-status/index.js
 * without requiring AWS SDK imports. This tests the business logic in isolation.
 */
function createListE2eRuns(mockSend) {
    return async function listE2eRuns(options = {}) {
        const { tier, limit = 10 } = options;
        const tableName = process.env.CI_TABLE_NAME || 'mlcc-ci-table';

        try {
            const scanParams = {
                TableName: tableName,
                Limit: 500
            };

            // Apply tier filter if specified
            if (tier) {
                scanParams.FilterExpression = 'tier = :tier';
                scanParams.ExpressionAttributeValues = { ':tier': { S: tier } };
            }

            const response = await mockSend(scanParams);
            const items = (response.Items || []).map(i => simpleUnmarshall(i));

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
    };
}

describe('E2E Status MCP Server — list_e2e_runs', () => {

    describe('listE2eRuns — grouping by runId', () => {

        it('groups entries by tier + date into distinct runs', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T11:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-c' }, testStatus: { S: 'fail-deploy' }, lastTestTimestamp: { S: '2025-01-15T09:00:00Z' }, tier: { S: 'nightly' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 2);

            const ciRun = result.runs.find(r => r.runId === 'ci-2025-01-15');
            assert.ok(ciRun, 'Should have a ci-2025-01-15 run');
            assert.strictEqual(ciRun.tier, 'ci');

            const nightlyRun = result.runs.find(r => r.runId === 'nightly-2025-01-15');
            assert.ok(nightlyRun, 'Should have a nightly-2025-01-15 run');
            assert.strictEqual(nightlyRun.tier, 'nightly');
        });

        it('groups entries from different dates into separate runs', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-14T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 2);
            assert.ok(result.runs.find(r => r.runId === 'ci-2025-01-15'));
            assert.ok(result.runs.find(r => r.runId === 'ci-2025-01-14'));
        });

        it('uses "unknown" tier when tier is missing from item', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 1);
            assert.strictEqual(result.runs[0].runId, 'unknown-2025-01-15');
            assert.strictEqual(result.runs[0].tier, 'unknown');
        });

        it('skips items without lastTestTimestamp', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 1);
            assert.strictEqual(result.runs[0].passed, 1);
        });

        it('keeps the most recent timestamp for a run group', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T08:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T14:30:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-c' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 1);
            assert.strictEqual(result.runs[0].timestamp, '2025-01-15T14:30:00Z');
        });
    });

    describe('listE2eRuns — pass/fail counting', () => {

        it('counts passing and failing entries correctly', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T11:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-c' }, testStatus: { S: 'fail-deploy' }, lastTestTimestamp: { S: '2025-01-15T12:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-d' }, testStatus: { S: 'fail-tune-sft' }, lastTestTimestamp: { S: '2025-01-15T13:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 1);
            assert.strictEqual(result.runs[0].passed, 2);
            assert.strictEqual(result.runs[0].failed, 2);
        });

        it('counts non-pass statuses as failures', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'fail-build' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'fail-deploy' }, lastTestTimestamp: { S: '2025-01-15T11:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-c' }, testStatus: { S: 'untested' }, lastTestTimestamp: { S: '2025-01-15T12:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs[0].passed, 0);
            assert.strictEqual(result.runs[0].failed, 3);
        });

        it('returns zero counts when all items lack timestamps', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'fail-build' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 0);
        });
    });

    describe('listE2eRuns — tier filtering', () => {

        it('passes tier filter expression to scan params', async () => {
            let capturedParams = null;
            const mockSend = async (params) => {
                capturedParams = params;
                return { Items: [] };
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            await listE2eRuns({ tier: 'nightly' });

            assert.strictEqual(capturedParams.FilterExpression, 'tier = :tier');
            assert.deepStrictEqual(capturedParams.ExpressionAttributeValues, { ':tier': { S: 'nightly' } });
        });

        it('does not include filter expression when tier is not specified', async () => {
            let capturedParams = null;
            const mockSend = async (params) => {
                capturedParams = params;
                return { Items: [] };
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            await listE2eRuns();

            assert.strictEqual(capturedParams.FilterExpression, undefined);
            assert.strictEqual(capturedParams.ExpressionAttributeValues, undefined);
        });

        it('returns only items matching the specified tier', async () => {
            const mockSend = async (params) => {
                // Simulate DynamoDB filtering by tier
                const allItems = [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'config-b' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'nightly' } }
                ];
                if (params.FilterExpression) {
                    const filterTier = params.ExpressionAttributeValues[':tier'].S;
                    return { Items: allItems.filter(i => i.tier.S === filterTier) };
                }
                return { Items: allItems };
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns({ tier: 'ci' });

            assert.strictEqual(result.runs.length, 1);
            assert.strictEqual(result.runs[0].tier, 'ci');
        });
    });

    describe('listE2eRuns — limit parameter', () => {

        it('limits the number of returned runs', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'c1' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c2' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-14T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c3' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-13T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c4' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-12T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c5' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-11T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns({ limit: 3 });

            assert.strictEqual(result.runs.length, 3);
        });

        it('defaults to 10 when limit is not specified', async () => {
            // Create 12 distinct runs (different dates)
            const items = Array.from({ length: 12 }, (_, i) => ({
                configId: { S: `config-${i}` },
                testStatus: { S: 'pass' },
                lastTestTimestamp: { S: `2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z` },
                tier: { S: 'ci' }
            }));

            const mockSend = async () => ({ Items: items });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 10);
        });

        it('returns all runs when fewer than limit exist', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'c1' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c2' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-14T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns({ limit: 10 });

            assert.strictEqual(result.runs.length, 2);
        });

        it('sorts runs by timestamp descending before applying limit', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'c1' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-10T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c2' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } },
                    { configId: { S: 'c3' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-12T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns({ limit: 2 });

            assert.strictEqual(result.runs.length, 2);
            assert.strictEqual(result.runs[0].runId, 'ci-2025-01-15');
            assert.strictEqual(result.runs[1].runId, 'ci-2025-01-12');
        });
    });

    describe('listE2eRuns — empty table handling', () => {

        it('returns empty runs array when table has no items', async () => {
            const mockSend = async () => ({ Items: [] });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.deepStrictEqual(result.runs, []);
        });

        it('returns empty runs array when Items is undefined', async () => {
            const mockSend = async () => ({});

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.deepStrictEqual(result.runs, []);
        });
    });

    describe('listE2eRuns — error handling', () => {

        it('returns error message when DynamoDB scan fails', async () => {
            const mockSend = async () => {
                throw new Error('Network timeout');
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.deepStrictEqual(result.runs, []);
            assert.ok(result.error);
            assert.ok(result.error.includes('Network timeout'));
        });

        it('returns error message when access is denied', async () => {
            const mockSend = async () => {
                throw new Error('Access denied: User is not authorized');
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.deepStrictEqual(result.runs, []);
            assert.ok(result.error.includes('Access denied'));
        });

        it('error message includes "Failed to scan CI table" prefix', async () => {
            const mockSend = async () => {
                throw new Error('Connection refused');
            };

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.ok(result.error.startsWith('Failed to scan CI table:'));
        });
    });

    describe('listE2eRuns — return shape', () => {

        it('returns runs with correct shape: runId, tier, timestamp, passed, failed', async () => {
            const mockSend = async () => ({
                Items: [
                    { configId: { S: 'config-a' }, testStatus: { S: 'pass' }, lastTestTimestamp: { S: '2025-01-15T10:00:00Z' }, tier: { S: 'ci' } }
                ]
            });

            const listE2eRuns = createListE2eRuns(mockSend);
            const result = await listE2eRuns();

            assert.strictEqual(result.runs.length, 1);
            const run = result.runs[0];
            assert.ok('runId' in run, 'run should have runId');
            assert.ok('tier' in run, 'run should have tier');
            assert.ok('timestamp' in run, 'run should have timestamp');
            assert.ok('passed' in run, 'run should have passed');
            assert.ok('failed' in run, 'run should have failed');
            assert.strictEqual(typeof run.runId, 'string');
            assert.strictEqual(typeof run.tier, 'string');
            assert.strictEqual(typeof run.timestamp, 'string');
            assert.strictEqual(typeof run.passed, 'number');
            assert.strictEqual(typeof run.failed, 'number');
        });
    });
});
