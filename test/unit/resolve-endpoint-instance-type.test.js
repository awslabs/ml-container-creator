// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for _resolveEndpointInstanceType
 *
 * Tests the resolution of instance type from an existing endpoint for
 * driver-aware base image filtering (US-1 ordering constraint).
 *
 * Validates: Requirements US-1
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import McpQueryRunner from '../../src/lib/mcp-query-runner.js';

/**
 * Creates a mock runner with configurable state
 */
function createMockRunner(opts = {}) {
    return {
        _endpointPickerMetadata: opts.endpointPickerMetadata || null,
        configManager: opts.configManager || { config: {} },
        options: opts.options || {},
        _runPrompts: async () => ({})
    };
}

describe('McpQueryRunner._resolveEndpointInstanceType', () => {

    describe('Strategy 1: endpoint-picker metadata lookup', () => {
        it('should resolve instance type from metadata when available', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: {
                    'my-endpoint': {
                        instanceType: 'ml.g5.24xlarge',
                        instanceCount: 1,
                        icCount: 2,
                        availableGpus: 4
                    }
                }
            });
            const queryRunner = new McpQueryRunner(runner);

            const result = await queryRunner._resolveEndpointInstanceType('my-endpoint', 'us-east-1');
            assert.strictEqual(result, 'ml.g5.24xlarge');
        });

        it('should strip pool annotation from instance type', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: {
                    'pool-endpoint': {
                        instanceType: 'ml.g5.12xlarge (pool: 3 types)',
                        instanceCount: 1,
                        icCount: 0,
                        availableGpus: 4
                    }
                }
            });
            const queryRunner = new McpQueryRunner(runner);

            const result = await queryRunner._resolveEndpointInstanceType('pool-endpoint', 'us-east-1');
            assert.strictEqual(result, 'ml.g5.12xlarge');
        });

        it('should skip metadata entry with "unknown" instance type', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: {
                    'unknown-ep': {
                        instanceType: 'unknown',
                        instanceCount: 1,
                        icCount: 0,
                        availableGpus: '?'
                    }
                }
            });
            const queryRunner = new McpQueryRunner(runner);

            // Should fall through to Strategy 2 (AWS SDK call), which will fail
            // gracefully in test (no real AWS credentials)
            const result = await queryRunner._resolveEndpointInstanceType('unknown-ep', 'us-east-1');
            // Without AWS credentials, this will return null (graceful fallback)
            assert.strictEqual(result, null);
        });

        it('should return null when endpoint is not in metadata', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: {
                    'other-endpoint': {
                        instanceType: 'ml.p5.48xlarge',
                        instanceCount: 1,
                        icCount: 1,
                        availableGpus: 6
                    }
                }
            });
            const queryRunner = new McpQueryRunner(runner);

            // Endpoint not in metadata — falls through to Strategy 2 (AWS SDK) → null
            const result = await queryRunner._resolveEndpointInstanceType('missing-endpoint', 'us-east-1');
            assert.strictEqual(result, null);
        });

        it('should return null when no metadata is available at all', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: null
            });
            const queryRunner = new McpQueryRunner(runner);

            const result = await queryRunner._resolveEndpointInstanceType('any-endpoint', 'us-east-1');
            assert.strictEqual(result, null);
        });
    });

    describe('Graceful fallback on AWS SDK failure', () => {
        it('should return null when AWS SDK call fails (no credentials)', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: null // Force Strategy 2
            });
            const queryRunner = new McpQueryRunner(runner);

            const result = await queryRunner._resolveEndpointInstanceType('some-endpoint', 'us-east-1');
            assert.strictEqual(result, null);
        });

        it('should not throw when resolution fails', async () => {
            const runner = createMockRunner({
                endpointPickerMetadata: {} // Empty metadata, force Strategy 2
            });
            const queryRunner = new McpQueryRunner(runner);

            // Should not throw, just return null
            const result = await queryRunner._resolveEndpointInstanceType('bad-endpoint', 'us-west-2');
            assert.strictEqual(result, null);
        });
    });

    describe('Integration with prompt-runner flow', () => {
        it('should store metadata from endpoint-picker query results', async () => {
            const runner = createMockRunner();
            const queryRunner = new McpQueryRunner(runner);

            // Simulate what _queryMcpForEndpoints does when it stores metadata
            const mockMetadata = {
                'endpoint-a': { instanceType: 'ml.g5.2xlarge', icCount: 1, availableGpus: 1 },
                'endpoint-b': { instanceType: 'ml.p5.48xlarge', icCount: 0, availableGpus: 8 }
            };
            runner._endpointPickerMetadata = mockMetadata;

            // Resolution should use stored metadata
            const resultA = await queryRunner._resolveEndpointInstanceType('endpoint-a', 'us-east-1');
            assert.strictEqual(resultA, 'ml.g5.2xlarge');

            const resultB = await queryRunner._resolveEndpointInstanceType('endpoint-b', 'us-east-1');
            assert.strictEqual(resultB, 'ml.p5.48xlarge');
        });
    });
});
