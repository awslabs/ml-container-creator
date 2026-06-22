// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Base Image Picker Registration Integration Tests
 *
 * Tests that:
 * 1. `mcp init` discovers and registers `base-image-picker` in config/mcp.json
 * 2. The registered server can be queried via McpClient
 *
 * Requirements: 10.1, 10.2
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import McpCommandHandler from '../../src/lib/mcp-command-handler.js';
import { McpClient } from '../../src/lib/mcp-client.js';

const CONFIG_FILENAME = 'config/mcp.json';

function createMockGen(tmpDir) {
    return {
        options: {},
        args: [],
        destinationRoot: () => tmpDir,
        destinationPath: (filepath) => filepath ? path.join(tmpDir, filepath) : tmpDir,
        prompt: async () => ({}),
        env: { error: (msg) => { throw new Error(msg); } },
        config: { getAll: () => ({}), save: () => {} },
        fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} }
    };
}

function readConfig(tmpDir) {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, CONFIG_FILENAME), 'utf8'));
}

async function captureConsoleLog(fn) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.log = origLog;
    }
    return logs.join('\n');
}

describe('MCP Base Image Picker Registration', function () {
    this.timeout(30000);

    // ========================================================================
    // Section 1: Discovery via _getAvailableBundledServers
    // ========================================================================

    describe('Server Discovery', () => {
        it('should discover base-image-picker as a bundled server', () => {
            const handler = new McpCommandHandler(createMockGen(os.tmpdir()));
            const servers = handler._getAvailableBundledServers();

            const baseImagePicker = servers.find(s => s.name === 'base-image-picker');
            assert.ok(baseImagePicker, 'base-image-picker should be in the list of available bundled servers');
        });

        it('should detect @modelcontextprotocol/sdk dependency in base-image-picker package.json', () => {
            const handler = new McpCommandHandler(createMockGen(os.tmpdir()));
            const servers = handler._getAvailableBundledServers();

            const baseImagePicker = servers.find(s => s.name === 'base-image-picker');
            assert.ok(baseImagePicker, 'base-image-picker should be discovered');
            // If it's in the list, it means the SDK dependency was detected
            // (servers without @modelcontextprotocol/sdk are filtered out)
            assert.ok(baseImagePicker.description && baseImagePicker.description !== '(unable to read package.json)',
                'Should have a valid description from package.json');
        });
    });

    // ========================================================================
    // Section 2: Registration via mcp init
    // ========================================================================

    describe('Registration via mcp init', function () {
        this.timeout(120000);
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reg-integ-'));
        });

        afterEach(() => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        });

        it('should register base-image-picker in config/mcp.json via _handleInit', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));

            await captureConsoleLog(() => handler._handleInit());

            const config = readConfig(tmpDir);
            assert.ok(config.mcpServers, 'mcpServers key should exist after init');
            assert.ok(config.mcpServers['base-image-picker'],
                'base-image-picker should be registered in mcpServers');
        });

        it('should register base-image-picker with correct command and entry point', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));

            await captureConsoleLog(() => handler._handleInit());

            const config = readConfig(tmpDir);
            const server = config.mcpServers['base-image-picker'];
            assert.strictEqual(server.command, 'node', 'Command should be "node"');
            assert.ok(Array.isArray(server.args), 'args should be an array');
            assert.ok(server.args[0].endsWith('servers/base-image-picker/index.js'),
                `Entry point should end with servers/base-image-picker/index.js, got: ${server.args[0]}`);
        });

        it('should skip base-image-picker if already registered', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));

            // First init
            await captureConsoleLog(() => handler._handleInit());
            const configAfterFirst = readConfig(tmpDir);
            const originalArgs = configAfterFirst.mcpServers['base-image-picker'].args;

            // Second init — should skip
            const output = await captureConsoleLog(() => handler._handleInit());
            const configAfterSecond = readConfig(tmpDir);

            assert.deepStrictEqual(
                configAfterSecond.mcpServers['base-image-picker'].args,
                originalArgs,
                'Server config should not change on re-init'
            );
            assert.ok(output.includes('already configured') || output.includes('skipped'),
                'Should indicate servers were skipped');
        });
    });

    // ========================================================================
    // Section 3: Querying the registered server via McpClient
    // ========================================================================

    describe('Query via McpClient', () => {
        it('should query base-image-picker for transformer images (vllm)', async () => {
            // Resolve the actual server entry point
            const handler = new McpCommandHandler(createMockGen(os.tmpdir()));
            const resolved = handler._resolveBundledServer('base-image-picker');
            assert.ok(resolved, 'Should resolve base-image-picker server path');

            const client = new McpClient(
                {
                    command: 'node',
                    args: [resolved.entryPoint],
                    toolName: 'get_base_images'
                },
                {
                    timeout: 15000,
                    parameterMatrix: {
                        baseImage: { valueSpace: 'unbounded', mcp: true }
                    }
                }
            );

            // Override _buildContext to inject transformer context
            client._buildContext = () => ({
                framework: 'transformers',
                modelServer: 'vllm'
            });

            const result = await client.query();
            await client.close();

            assert.ok(result, 'Should return a non-null result');
            assert.ok(result.values, 'Result should have values');
            assert.ok(result.choices, 'Result should have choices');
        });

        it('should query base-image-picker for python-slim images', async () => {
            const handler = new McpCommandHandler(createMockGen(os.tmpdir()));
            const resolved = handler._resolveBundledServer('base-image-picker');

            const client = new McpClient(
                {
                    command: 'node',
                    args: [resolved.entryPoint],
                    toolName: 'get_base_images'
                },
                {
                    timeout: 15000,
                    parameterMatrix: {
                        baseImage: { valueSpace: 'unbounded', mcp: true }
                    }
                }
            );

            client._buildContext = () => ({
                framework: 'sklearn'
            });

            const result = await client.query();
            await client.close();

            assert.ok(result, 'Should return a non-null result');
            assert.ok(result.values, 'Result should have values');
            assert.ok(result.choices, 'Result should have choices');
        });
    });
});
