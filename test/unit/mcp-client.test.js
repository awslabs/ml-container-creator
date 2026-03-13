// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * McpClient Unit Tests
 *
 * Tests for the MCP client that spawns server processes,
 * performs protocol handshakes, and parses responses.
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import { McpClient, DEFAULT_TOOL_NAME, DEFAULT_LIMIT, DEFAULT_TIMEOUT } from '../../generators/app/lib/mcp-client.js';
import ConfigManager from '../../generators/app/lib/config-manager.js';
import { createMockGenerator } from '../helpers/mock-generator.js';

describe('McpClient Unit Tests', () => {
    let parameterMatrix;

    beforeEach(() => {
        const mockGen = createMockGenerator();
        const configManager = new ConfigManager(mockGen);
        parameterMatrix = configManager._getParameterMatrix();
    });

    describe('Constructor', () => {
        it('should use default toolName when not provided', () => {
            const client = new McpClient({ command: 'node', args: [] });
            assert.strictEqual(client.toolName, DEFAULT_TOOL_NAME);
        });

        it('should use default limit when not provided', () => {
            const client = new McpClient({ command: 'node', args: [] });
            assert.strictEqual(client.limit, DEFAULT_LIMIT);
        });

        it('should use default timeout when not provided', () => {
            const client = new McpClient({ command: 'node', args: [] });
            assert.strictEqual(client.timeout, DEFAULT_TIMEOUT);
        });

        it('should use provided toolName', () => {
            const client = new McpClient({ command: 'node', args: [], toolName: 'custom_tool' });
            assert.strictEqual(client.toolName, 'custom_tool');
        });

        it('should use provided limit', () => {
            const client = new McpClient({ command: 'node', args: [], limit: 25 });
            assert.strictEqual(client.limit, 25);
        });

        it('should use provided timeout', () => {
            const client = new McpClient({ command: 'node', args: [] }, { timeout: 5000 });
            assert.strictEqual(client.timeout, 5000);
        });

        it('should store parameter matrix from options', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );
            assert.deepStrictEqual(client.parameterMatrix, parameterMatrix);
        });
    });

    describe('_getUnboundedParameterNames()', () => {
        it('should return only unbounded parameter names', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );
            const names = client._getUnboundedParameterNames();

            assert.ok(names.includes('instanceType'));
            assert.ok(names.includes('awsRoleArn'));
            assert.ok(names.includes('awsRegion'));
            assert.strictEqual(names.length, 3);
        });

        it('should not include bounded parameters', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );
            const names = client._getUnboundedParameterNames();

            assert.ok(!names.includes('framework'));
            assert.ok(!names.includes('modelServer'));
        });

        it('should return empty array when no parameter matrix', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix: {} }
            );
            const names = client._getUnboundedParameterNames();

            assert.deepStrictEqual(names, []);
        });
    });

    describe('_parseResponse()', () => {
        let client;

        beforeEach(() => {
            client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );
        });

        it('should parse valid response with values and choices', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        values: {
                            instanceType: 'ml.m5.xlarge',
                            awsRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
                        },
                        choices: {
                            instanceType: ['ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge']
                        }
                    })
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.ok(result !== null);
            assert.strictEqual(result.values.instanceType, 'ml.m5.xlarge');
            assert.strictEqual(result.values.awsRoleArn, 'arn:aws:iam::123456789012:role/TestRole');
            assert.deepStrictEqual(result.choices.instanceType, ['ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge']);
        });

        it('should parse response with only values', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        values: { instanceType: 'ml.m5.xlarge' }
                    })
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.ok(result !== null);
            assert.strictEqual(result.values.instanceType, 'ml.m5.xlarge');
            assert.deepStrictEqual(result.choices, {});
        });

        it('should parse response with only choices', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        choices: { instanceType: ['ml.m5.xlarge', 'ml.g5.xlarge'] }
                    })
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.ok(result !== null);
            assert.deepStrictEqual(result.values, {});
            assert.deepStrictEqual(result.choices.instanceType, ['ml.m5.xlarge', 'ml.g5.xlarge']);
        });

        it('should return null for null result', () => {
            const result = client._parseResponse(null);

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage().includes('empty result'));
        });

        it('should return null for error response', () => {
            const mockResult = {
                isError: true,
                content: [{
                    type: 'text',
                    text: 'Something went wrong'
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage().includes('error'));
        });

        it('should return null for malformed JSON', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: 'not valid json {'
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage().includes('malformed JSON'));
        });

        it('should return null for non-object JSON', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: '"just a string"'
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage().includes('non-object'));
        });

        it('should return null when no text content block exists', () => {
            const mockResult = {
                content: [{
                    type: 'image',
                    data: 'base64data',
                    mimeType: 'image/png'
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage().includes('no text content'));
        });

        it('should return null when content array is empty', () => {
            const mockResult = { content: [] };

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
        });

        it('should return null when content is missing', () => {
            const mockResult = {};

            const result = client._parseResponse(mockResult);

            assert.strictEqual(result, null);
        });

        it('should skip non-array choices entries', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        choices: {
                            instanceType: ['ml.m5.xlarge'],
                            awsRoleArn: 'not-an-array'
                        }
                    })
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.ok(result !== null);
            assert.deepStrictEqual(result.choices.instanceType, ['ml.m5.xlarge']);
            assert.strictEqual(result.choices.awsRoleArn, undefined);
        });

        it('should handle empty values and choices objects', () => {
            const mockResult = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ values: {}, choices: {} })
                }]
            };

            const result = client._parseResponse(mockResult);

            assert.ok(result !== null);
            assert.deepStrictEqual(result.values, {});
            assert.deepStrictEqual(result.choices, {});
        });
    });

    describe('Spawn failure graceful degradation', () => {
        it('should return null when command does not exist', async function () {
            this.timeout(15000);

            const client = new McpClient(
                { command: 'nonexistent-command-xyz-12345', args: [] },
                { timeout: 5000, parameterMatrix }
            );

            const result = await client.query();

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage() !== null);
        });
    });

    describe('Timeout handling', () => {
        it('should return null when server does not respond within timeout', async function () {
            this.timeout(10000);

            // Use a command that hangs (sleep for a long time)
            const client = new McpClient(
                { command: 'sleep', args: ['60'] },
                { timeout: 1000, parameterMatrix }
            );

            const result = await client.query();

            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage() !== null);
            assert.ok(
                client.getDiagnosticMessage().includes('timed out') ||
                client.getDiagnosticMessage().includes('failed'),
                `Expected timeout or failure message, got: ${client.getDiagnosticMessage()}`
            );
        });
    });

    describe('Protocol handshake sequence', () => {
        it('should attempt to connect and perform handshake with a real process', async function () {
            this.timeout(15000);

            // Use a command that exits immediately — the handshake will fail
            // but the client should handle it gracefully
            const client = new McpClient(
                { command: 'echo', args: ['hello'] },
                { timeout: 5000, parameterMatrix }
            );

            const result = await client.query();

            // echo doesn't speak MCP protocol, so query should return null
            assert.strictEqual(result, null);
            assert.ok(client.getDiagnosticMessage() !== null);
        });
    });

    describe('close()', () => {
        it('should not throw when called without prior query', async () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            // Should not throw
            await client.close();
        });

        it('should not throw when called multiple times', async () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            await client.close();
            await client.close();
        });
    });

    describe('getDiagnosticMessage()', () => {
        it('should return null before any operation', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            assert.strictEqual(client.getDiagnosticMessage(), null);
        });
    });

    describe('_buildContext()', () => {
        it('should include bounded parameters with non-null defaults', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            const context = client._buildContext();

            // deployTarget has default 'codebuild' and is bounded
            assert.strictEqual(context.deployTarget, 'codebuild');
        });

        it('should not include parameters with null defaults', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            const context = client._buildContext();

            // framework has default null
            assert.strictEqual(context.framework, undefined);
        });

        it('should not include unbounded parameters', () => {
            const client = new McpClient(
                { command: 'node', args: [] },
                { parameterMatrix }
            );

            const context = client._buildContext();

            // instanceType is unbounded
            assert.strictEqual(context.instanceType, undefined);
            // awsRegion is now unbounded
            assert.strictEqual(context.awsRegion, undefined);
        });
    });
});
