// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * McpCommandHandler Unit Tests
 *
 * Tests for the MCP CLI subcommand handler: add, list, get, remove.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import McpCommandHandler from '../../generators/app/lib/mcp-command-handler.js';

const CONFIG_FILENAME = 'config/mcp.json';

function createMockGen(tmpDir, promptResponse = {}) {
    return {
        options: {},
        args: [],
        destinationRoot: () => tmpDir,
        destinationPath: (filepath) => filepath ? path.join(tmpDir, filepath) : tmpDir,
        prompt: async () => promptResponse,
        env: { error: (msg) => { throw new Error(msg); } },
        config: { getAll: () => ({}), save: () => {} },
        fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} }
    };
}

function readConfig(tmpDir) {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, CONFIG_FILENAME), 'utf8'));
}

function writeConfig(tmpDir, config) {
    const configPath = path.join(tmpDir, CONFIG_FILENAME);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

describe('McpCommandHandler Unit Tests', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cmd-test-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    describe('mcp add', () => {
        it('should add a new server to empty config', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleAdd(['my-server', '--', 'node', 'server.js'], {});

            const config = readConfig(tmpDir);
            assert.ok(config.mcpServers);
            assert.ok(config.mcpServers['my-server']);
            assert.strictEqual(config.mcpServers['my-server'].command, 'node');
            assert.deepStrictEqual(config.mcpServers['my-server'].args, ['server.js']);
        });

        it('should add a server with env, toolName, and limit', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleAdd(
                ['team-config', '--', 'npx', '-y', '@corp/mcp-policy'],
                { e: ['TEAM_ID=ml-platform', 'ENV=prod'], 'tool-name': 'get_approved_config', limit: '5' }
            );

            const config = readConfig(tmpDir);
            const server = config.mcpServers['team-config'];
            assert.strictEqual(server.command, 'npx');
            assert.deepStrictEqual(server.args, ['-y', '@corp/mcp-policy']);
            assert.deepStrictEqual(server.env, { TEAM_ID: 'ml-platform', ENV: 'prod' });
            assert.strictEqual(server.toolName, 'get_approved_config');
            assert.strictEqual(server.limit, 5);
        });

        it('should prompt for confirmation when server already exists', async () => {
            let promptCalled = false;
            const mockGen = createMockGen(tmpDir, { overwrite: false });
            mockGen.prompt = async (questions) => {
                promptCalled = true;
                assert.ok(questions[0].message.includes('already exists'));
                return { overwrite: false };
            };

            writeConfig(tmpDir, { mcpServers: { existing: { command: 'old' } } });

            const handler = new McpCommandHandler(mockGen);
            await handler._handleAdd(['existing', '--', 'new-cmd'], {});

            assert.ok(promptCalled, 'Should have prompted for confirmation');
            // Should NOT have overwritten
            const config = readConfig(tmpDir);
            assert.strictEqual(config.mcpServers.existing.command, 'old');
        });

        it('should overwrite when user confirms', async () => {
            const mockGen = createMockGen(tmpDir, { overwrite: true });
            writeConfig(tmpDir, { mcpServers: { existing: { command: 'old' } } });

            const handler = new McpCommandHandler(mockGen);
            await handler._handleAdd(['existing', '--', 'new-cmd'], {});

            const config = readConfig(tmpDir);
            assert.strictEqual(config.mcpServers.existing.command, 'new-cmd');
        });

        it('should create config file when it does not exist', async () => {
            assert.ok(!fs.existsSync(path.join(tmpDir, CONFIG_FILENAME)));

            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleAdd(['new-server', '--', 'node', 'index.js'], {});

            assert.ok(fs.existsSync(path.join(tmpDir, CONFIG_FILENAME)));
            const config = readConfig(tmpDir);
            assert.ok(config.mcpServers['new-server']);
        });

        it('should reject invalid limit', async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                await handler._handleAdd(['s', '--', 'cmd'], { limit: 'abc' });
            } finally {
                console.log = origLog;
            }

            assert.ok(logs.some(l => l.includes('positive integer')));
            assert.ok(!fs.existsSync(path.join(tmpDir, CONFIG_FILENAME)));
        });

        it('should show usage when no separator provided', async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                await handler._handleAdd(['my-server', 'node', 'server.js'], {});
            } finally {
                console.log = origLog;
            }

            assert.ok(logs.some(l => l.includes('--')));
        });
    });

    describe('mcp list', () => {
        it('should list all configured servers', () => {
            writeConfig(tmpDir, {
                mcpServers: {
                    'server-a': { command: 'node', args: ['a.js'] },
                    'server-b': { command: 'python', args: ['b.py'] }
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleList({});
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('server-a'));
            assert.ok(output.includes('server-b'));
            assert.ok(output.includes('node'));
            assert.ok(output.includes('python'));
        });

        it('should show message when no servers configured', () => {
            writeConfig(tmpDir, {});

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleList({});
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('No MCP servers configured'));
            assert.ok(output.includes('mcp add'));
        });

        it('should show message when config file does not exist', () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleList({});
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('No MCP servers configured'));
        });
    });

    describe('mcp get', () => {
        it('should display full server configuration', () => {
            writeConfig(tmpDir, {
                mcpServers: {
                    'my-server': {
                        command: 'node',
                        args: ['server.js', '--port', '3000'],
                        env: { API_KEY: 'secret123' },
                        toolName: 'custom_tool',
                        limit: 25
                    }
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleGet('my-server');
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('node'));
            assert.ok(output.includes('server.js --port 3000'));
            assert.ok(output.includes('API_KEY'));
            assert.ok(output.includes('custom_tool'));
            assert.ok(output.includes('25'));
        });

        it('should show error with available names when server not found', () => {
            writeConfig(tmpDir, {
                mcpServers: {
                    'existing-a': { command: 'node' },
                    'existing-b': { command: 'python' }
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleGet('nonexistent');
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('not found'));
            assert.ok(output.includes('existing-a'));
            assert.ok(output.includes('existing-b'));
        });

        it('should show defaults for missing optional fields', () => {
            writeConfig(tmpDir, {
                mcpServers: {
                    'minimal': { command: 'node' }
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                handler._handleGet('minimal');
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('(none)') || output.includes('(default'));
            assert.ok(output.includes('get_ml_config'));
        });
    });

    describe('mcp remove', () => {
        it('should remove a server', async () => {
            writeConfig(tmpDir, {
                mcpServers: {
                    'server-a': { command: 'node' },
                    'server-b': { command: 'python' }
                }
            });

            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleRemove('server-a');

            const config = readConfig(tmpDir);
            assert.strictEqual(config.mcpServers['server-a'], undefined);
            assert.ok(config.mcpServers['server-b']);
        });

        it('should remove mcpServers key when last server removed', async () => {
            writeConfig(tmpDir, {
                framework: 'sklearn',
                mcpServers: { 'only-server': { command: 'node' } }
            });

            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleRemove('only-server');

            const config = readConfig(tmpDir);
            assert.strictEqual(config.mcpServers, undefined);
            assert.strictEqual(config.framework, 'sklearn');
        });

        it('should show error when server not found', async () => {
            writeConfig(tmpDir, { mcpServers: {} });

            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                await handler._handleRemove('nonexistent');
            } finally {
                console.log = origLog;
            }

            assert.ok(logs.some(l => l.includes('not found')));
        });
    });

    describe('Config file preservation', () => {
        it('should preserve non-MCP keys when adding a server', async () => {
            writeConfig(tmpDir, {
                framework: 'sklearn',
                modelServer: 'flask',
                instanceType: 'ml.m5.large'
            });

            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleAdd(['new-server', '--', 'node', 'srv.js'], {});

            const config = readConfig(tmpDir);
            assert.strictEqual(config.framework, 'sklearn');
            assert.strictEqual(config.modelServer, 'flask');
            assert.strictEqual(config.instanceType, 'ml.m5.large');
            assert.ok(config.mcpServers['new-server']);
        });

        it('should preserve non-MCP keys when removing a server', async () => {
            writeConfig(tmpDir, {
                framework: 'transformers',
                mcpServers: { 'srv': { command: 'node' } }
            });

            const handler = new McpCommandHandler(createMockGen(tmpDir));
            await handler._handleRemove('srv');

            const config = readConfig(tmpDir);
            assert.strictEqual(config.framework, 'transformers');
            assert.strictEqual(config.mcpServers, undefined);
        });
    });

    describe('handle() dispatch', () => {
        it('should show help when no subcommand provided', async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                await handler.handle([], {});
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('SUBCOMMANDS'));
        });

        it('should show help for unknown subcommand', async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                const handler = new McpCommandHandler(createMockGen(tmpDir));
                await handler.handle(['unknown'], {});
            } finally {
                console.log = origLog;
            }

            const output = logs.join('\n');
            assert.ok(output.includes('Unknown mcp subcommand'));
        });
    });

    describe('_parseEnvFlags()', () => {
        it('should parse single -e flag', () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            const env = handler._parseEnvFlags({ e: 'KEY=value' });
            assert.deepStrictEqual(env, { KEY: 'value' });
        });

        it('should parse multiple -e flags', () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            const env = handler._parseEnvFlags({ e: ['A=1', 'B=2'] });
            assert.deepStrictEqual(env, { A: '1', B: '2' });
        });

        it('should handle values with equals signs', () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            const env = handler._parseEnvFlags({ e: 'KEY=val=ue=extra' });
            assert.deepStrictEqual(env, { KEY: 'val=ue=extra' });
        });

        it('should return empty object when no env flags', () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir));
            const env = handler._parseEnvFlags({});
            assert.deepStrictEqual(env, {});
        });
    });
});
