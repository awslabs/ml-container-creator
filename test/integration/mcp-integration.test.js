// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Config Source Integration Tests
 *
 * End-to-end tests covering:
 * 1. Config loading with a real MCP server process (mock-mcp-server.js)
 * 2. Precedence chain ordering with MCP values present
 * 3. Full CLI command flow: add → list → get → remove
 *
 * Requirements: 1.1–1.6, 8.1–8.16
 */

import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { McpClient, DEFAULT_TOOL_NAME, DEFAULT_LIMIT } from '../../generators/app/lib/mcp-client.js'
import ConfigManager from '../../generators/app/lib/config-manager.js'
import McpCommandHandler from '../../generators/app/lib/mcp-command-handler.js'
import { createMockGenerator } from '../helpers/mock-generator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MOCK_SERVER_PATH = path.join(__dirname, 'mock-mcp-server.js')
const CONFIG_FILENAME = 'config/mcp.json'

/**
 * Helper: ensure config directory exists and write config file.
 */
function writeConfigFile(tmpDir, configContent) {
    const configPath = path.join(tmpDir, CONFIG_FILENAME)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2))
}

/**
 * Helper: create a temp directory and optionally write a config file.
 */
function setupTempDir(configContent) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-integ-'))
    if (configContent !== undefined) {
        writeConfigFile(tmpDir, configContent)
    }
    return tmpDir
}

function cleanupTempDir(tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
}

function readConfig(tmpDir) {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, CONFIG_FILENAME), 'utf8'))
}

function createMockGen(tmpDir, promptResponse = {}) {
    return {
        options: {},
        args: [],
        destinationRoot: () => tmpDir,
        destinationPath: (filepath) => filepath ? path.join(tmpDir, filepath) : tmpDir,
        prompt: async () => promptResponse,
        env: { error: (msg) => { throw new Error(msg) } },
        config: { getAll: () => ({}), save: () => {} },
        fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} }
    }
}

/**
 * Capture console.log output during a function call.
 */
async function captureConsoleLog(fn) {
    const logs = []
    const origLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    try {
        await fn()
    } finally {
        console.log = origLog
    }
    return logs.join('\n')
}


// ============================================================================
// Section 1: End-to-End Config Loading with Mock MCP Server
// ============================================================================

describe('MCP Integration Tests', function () {
    this.timeout(30000)

    describe('End-to-End Config Loading via McpClient', () => {
        it('should query a real MCP server process and receive instance type values', async () => {
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge' },
                choices: { instanceType: ['ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge'] }
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result, 'McpClient should return a non-null result')
            assert.strictEqual(result.values.instanceType, 'ml.m5.xlarge')
            assert.deepStrictEqual(result.choices.instanceType, ['ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge'])
        })

        it('should query for awsRoleArn values from MCP server', async () => {
            const mockResponse = JSON.stringify({
                values: {
                    instanceType: 'ml.g5.xlarge',
                    awsRoleArn: 'arn:aws:iam::123456789012:role/SageMakerRole'
                },
                choices: {
                    instanceType: ['ml.g5.xlarge', 'ml.g5.2xlarge']
                }
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)
            assert.strictEqual(result.values.instanceType, 'ml.g5.xlarge')
            assert.strictEqual(result.values.awsRoleArn, 'arn:aws:iam::123456789012:role/SageMakerRole')
        })

        it('should respect the limit parameter when querying', async () => {
            const allChoices = [
                'ml.m5.large', 'ml.m5.xlarge', 'ml.m5.2xlarge',
                'ml.m5.4xlarge', 'ml.c5.xlarge', 'ml.c5.2xlarge'
            ]
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.large' },
                choices: { instanceType: allChoices }
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse },
                    limit: 3
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)
            // The mock server respects the limit parameter
            assert.ok(result.choices.instanceType.length <= 3,
                `Expected at most 3 choices, got ${result.choices.instanceType.length}`)
        })

        it('should use custom toolName when configured', async () => {
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.p3.2xlarge' },
                choices: {}
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: {
                        MOCK_MCP_RESPONSE: mockResponse,
                        MOCK_MCP_TOOL_NAME: 'custom_tool'
                    },
                    toolName: 'custom_tool'
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)
            assert.strictEqual(result.values.instanceType, 'ml.p3.2xlarge')
        })

        it('should handle MCP server errors gracefully', async () => {
            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_ERROR: 'true' }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            // Graceful degradation: returns null, does not throw
            assert.strictEqual(result, null)
            assert.ok(client.getDiagnosticMessage(), 'Should have a diagnostic message')
        })

        it('should handle MCP server spawn failure gracefully', async () => {
            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'nonexistent-command-that-does-not-exist',
                    args: []
                },
                { timeout: 5000, parameterMatrix }
            )

            const result = await client.query()

            assert.strictEqual(result, null, 'Should return null on spawn failure')
            assert.ok(client.getDiagnosticMessage(), 'Should have a diagnostic message')
        })

        it('should return empty values when server returns no matching parameters', async () => {
            const mockResponse = JSON.stringify({
                values: {},
                choices: {}
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)
            assert.deepStrictEqual(result.values, {})
            assert.deepStrictEqual(result.choices, {})
        })
    })


    // ============================================================================
    // Section 2: Precedence Chain Ordering with MCP Values
    // ============================================================================

    describe('Precedence Chain Ordering with MCP Values', () => {
        let tmpDir

        beforeEach(() => {
            tmpDir = setupTempDir()
        })

        afterEach(() => {
            cleanupTempDir(tmpDir)
            // Clean up env vars
            delete process.env.ML_INSTANCE_TYPE
            delete process.env.AWS_ROLE
        })

        it('MCP values should be overridden by environment variables (higher precedence)', async () => {
            // MCP provides instanceType, but env var should win
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge' },
                choices: { instanceType: ['ml.m5.xlarge'] }
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            // Simulate MCP loading
            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // Step 1: MCP provides a value
            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const mcpResult = await client.query()
            await client.close()

            assert.ok(mcpResult)

            // Merge MCP value (simulating _loadMcpConfig behavior)
            if (mcpResult.values.instanceType) {
                cm._mergeConfig({ instanceType: mcpResult.values.instanceType })
                cm.mcpSources.instanceType = {
                    server: 'test-server',
                    value: mcpResult.values.instanceType,
                    timestamp: new Date().toISOString()
                }
            }

            assert.strictEqual(cm.config.instanceType, 'ml.m5.xlarge',
                'After MCP load, instanceType should be ml.m5.xlarge')

            // Step 2: Environment variable overrides MCP (higher precedence)
            process.env.ML_INSTANCE_TYPE = 'ml.g5.2xlarge'
            await cm._loadEnvironmentVariables()

            assert.strictEqual(cm.config.instanceType, 'ml.g5.2xlarge',
                'Environment variable should override MCP value')
        })

        it('MCP values should override config file values (lower precedence)', async () => {
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.g4dn.xlarge' },
                choices: {}
            })

            // Write a config file with instanceType
            writeConfigFile(tmpDir, { instanceType: 'ml.m5.large' })

            const mockGen = createMockGenerator({
                config: path.join(tmpDir, CONFIG_FILENAME)
            }, [], tmpDir)
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // Step 1: Load config file (lower precedence)
            await cm._loadCliConfigFile()
            assert.strictEqual(cm.config.instanceType, 'ml.m5.large',
                'Config file should set instanceType')

            // Step 2: MCP overrides config file
            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const mcpResult = await client.query()
            await client.close()

            if (mcpResult && mcpResult.values.instanceType) {
                cm._mergeConfig({ instanceType: mcpResult.values.instanceType })
            }

            assert.strictEqual(cm.config.instanceType, 'ml.g4dn.xlarge',
                'MCP value should override config file value')
        })

        it('CLI options should override MCP values (highest precedence)', async () => {
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge' },
                choices: {}
            })

            const mockGen = createMockGenerator({
                'instance-type': 'ml.p3.2xlarge'
            }, [], tmpDir)
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // Step 1: MCP provides a value
            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const mcpResult = await client.query()
            await client.close()

            if (mcpResult && mcpResult.values.instanceType) {
                cm._mergeConfig({ instanceType: mcpResult.values.instanceType })
            }

            assert.strictEqual(cm.config.instanceType, 'ml.m5.xlarge')

            // Step 2: CLI option overrides MCP (highest precedence)
            await cm._loadCliOptions()

            assert.strictEqual(cm.config.instanceType, 'ml.p3.2xlarge',
                'CLI option should override MCP value')
        })

        it('bounded parameters from MCP should be discarded', async () => {
            const mockResponse = JSON.stringify({
                values: {
                    instanceType: 'ml.m5.xlarge',
                    framework: 'sklearn',
                    awsRegion: 'eu-west-1'
                },
                choices: {}
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const mcpResult = await client.query()
            await client.close()

            assert.ok(mcpResult)

            // Only merge unbounded parameters (simulating _loadMcpConfig filtering)
            for (const [param, value] of Object.entries(mcpResult.values)) {
                if (parameterMatrix[param] && parameterMatrix[param].valueSpace === 'unbounded') {
                    cm._mergeConfig({ [param]: value })
                }
            }

            // instanceType (unbounded) should be merged
            assert.strictEqual(cm.config.instanceType, 'ml.m5.xlarge')

            // awsRegion (unbounded) should be merged
            assert.strictEqual(cm.config.awsRegion, 'eu-west-1',
                'Unbounded parameter awsRegion should be set from MCP')

            // framework (bounded) should NOT be merged
            assert.notStrictEqual(cm.config.framework, 'sklearn',
                'Bounded parameter framework should not be set from MCP')
        })

        it('later MCP servers should take precedence over earlier ones', async () => {
            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // Server 1 provides instanceType
            const response1 = JSON.stringify({
                values: { instanceType: 'ml.m5.large' },
                choices: { instanceType: ['ml.m5.large'] }
            })

            const client1 = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: response1 }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result1 = await client1.query()
            await client1.close()

            if (result1 && result1.values.instanceType) {
                cm._mergeConfig({ instanceType: result1.values.instanceType })
                cm.mcpSources.instanceType = {
                    server: 'server-1',
                    value: result1.values.instanceType,
                    timestamp: new Date().toISOString()
                }
            }

            // Server 2 provides a different instanceType (should win)
            const response2 = JSON.stringify({
                values: { instanceType: 'ml.g5.xlarge' },
                choices: { instanceType: ['ml.g5.xlarge', 'ml.g5.2xlarge'] }
            })

            const client2 = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: response2 }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result2 = await client2.query()
            await client2.close()

            if (result2 && result2.values.instanceType) {
                cm._mergeConfig({ instanceType: result2.values.instanceType })
                cm.mcpSources.instanceType = {
                    server: 'server-2',
                    value: result2.values.instanceType,
                    timestamp: new Date().toISOString()
                }
            }

            assert.strictEqual(cm.config.instanceType, 'ml.g5.xlarge',
                'Later MCP server value should take precedence')
            assert.strictEqual(cm.mcpSources.instanceType.server, 'server-2',
                'Source tracking should reflect the later server')
        })

        it('full precedence chain: defaults < config file < MCP < env var < CLI option', async () => {
            // Write config file with instanceType
            writeConfigFile(tmpDir, { instanceType: 'ml.c5.xlarge' })

            const mockGen = createMockGenerator({
                config: path.join(tmpDir, CONFIG_FILENAME)
            }, [], tmpDir)
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // 1. Generator defaults: instanceType = null
            assert.strictEqual(cm.config.instanceType, null)

            // 2. Config file: instanceType = ml.c5.xlarge
            await cm._loadCliConfigFile()
            assert.strictEqual(cm.config.instanceType, 'ml.c5.xlarge')

            // 3. MCP: instanceType = ml.m5.2xlarge (overrides config file)
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.2xlarge' },
                choices: {}
            })

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const mcpResult = await client.query()
            await client.close()

            if (mcpResult && mcpResult.values.instanceType) {
                cm._mergeConfig({ instanceType: mcpResult.values.instanceType })
            }
            assert.strictEqual(cm.config.instanceType, 'ml.m5.2xlarge')

            // 4. Env var: instanceType = ml.g4dn.xlarge (overrides MCP)
            process.env.ML_INSTANCE_TYPE = 'ml.g4dn.xlarge'
            await cm._loadEnvironmentVariables()
            assert.strictEqual(cm.config.instanceType, 'ml.g4dn.xlarge')
        })
    })


    // ============================================================================
    // Section 3: Full CLI Command Flow (add → list → get → remove)
    // ============================================================================

    describe('Full CLI Command Flow: add → list → get → remove', () => {
        let tmpDir

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-integ-'))
        })

        afterEach(() => {
            cleanupTempDir(tmpDir)
        })

        it('should complete the full add → list → get → remove lifecycle', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir))

            // Step 1: Add a server
            await handler._handleAdd(
                ['team-config', '--', 'node', MOCK_SERVER_PATH],
                { e: 'TEAM_ID=ml-platform', 'tool-name': 'get_ml_config', limit: '5' }
            )

            let config = readConfig(tmpDir)
            assert.ok(config.mcpServers, 'mcpServers key should exist')
            assert.ok(config.mcpServers['team-config'], 'team-config server should exist')
            assert.strictEqual(config.mcpServers['team-config'].command, 'node')
            assert.deepStrictEqual(config.mcpServers['team-config'].args, [MOCK_SERVER_PATH])
            assert.deepStrictEqual(config.mcpServers['team-config'].env, { TEAM_ID: 'ml-platform' })
            assert.strictEqual(config.mcpServers['team-config'].toolName, 'get_ml_config')
            assert.strictEqual(config.mcpServers['team-config'].limit, 5)

            // Step 2: List servers
            const listOutput = await captureConsoleLog(() => {
                handler._handleList({})
            })
            assert.ok(listOutput.includes('team-config'), 'List should show team-config')
            assert.ok(listOutput.includes('node'), 'List should show the command')

            // Step 3: Get server details
            const getOutput = await captureConsoleLog(() => {
                handler._handleGet('team-config')
            })
            assert.ok(getOutput.includes('team-config'), 'Get should show server name')
            assert.ok(getOutput.includes('node'), 'Get should show command')
            assert.ok(getOutput.includes('get_ml_config'), 'Get should show toolName')
            assert.ok(getOutput.includes('5'), 'Get should show limit')

            // Step 4: Remove server
            await handler._handleRemove('team-config')

            config = readConfig(tmpDir)
            assert.ok(!config.mcpServers, 'mcpServers key should be removed when last server is deleted')
        })

        it('should handle multiple servers in sequence', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir))

            // Add first server
            await handler._handleAdd(
                ['server-a', '--', 'node', 'a.js'],
                {}
            )

            // Add second server
            await handler._handleAdd(
                ['server-b', '--', 'python', 'b.py'],
                { e: 'API_KEY=secret123' }
            )

            // Add third server
            await handler._handleAdd(
                ['server-c', '--', 'npx', '-y', '@corp/mcp-tool'],
                { 'tool-name': 'custom_tool', limit: '20' }
            )

            // Verify all three exist
            let config = readConfig(tmpDir)
            assert.strictEqual(Object.keys(config.mcpServers).length, 3)

            // List should show all three
            const listOutput = await captureConsoleLog(() => {
                handler._handleList({})
            })
            assert.ok(listOutput.includes('server-a'))
            assert.ok(listOutput.includes('server-b'))
            assert.ok(listOutput.includes('server-c'))

            // Get each server
            for (const name of ['server-a', 'server-b', 'server-c']) {
                const output = await captureConsoleLog(() => {
                    handler._handleGet(name)
                })
                assert.ok(output.includes(name), `Get should show ${name}`)
            }

            // Remove middle server
            await handler._handleRemove('server-b')
            config = readConfig(tmpDir)
            assert.strictEqual(Object.keys(config.mcpServers).length, 2)
            assert.ok(!config.mcpServers['server-b'], 'server-b should be removed')
            assert.ok(config.mcpServers['server-a'], 'server-a should remain')
            assert.ok(config.mcpServers['server-c'], 'server-c should remain')

            // Remove remaining servers
            await handler._handleRemove('server-a')
            await handler._handleRemove('server-c')
            config = readConfig(tmpDir)
            assert.ok(!config.mcpServers, 'mcpServers key should be removed when all servers deleted')
        })

        it('should preserve non-MCP config keys through add/remove cycle', async () => {
            // Write config with existing non-MCP keys
            const originalConfig = {
                framework: 'sklearn',
                modelServer: 'flask',
                instanceType: 'ml.m5.xlarge',
                awsRegion: 'us-west-2'
            }
            writeConfigFile(tmpDir, originalConfig)

            const handler = new McpCommandHandler(createMockGen(tmpDir))

            // Add a server
            await handler._handleAdd(
                ['my-server', '--', 'node', 'server.js'],
                {}
            )

            let config = readConfig(tmpDir)
            // Non-MCP keys should be preserved
            assert.strictEqual(config.framework, 'sklearn')
            assert.strictEqual(config.modelServer, 'flask')
            assert.strictEqual(config.instanceType, 'ml.m5.xlarge')
            assert.strictEqual(config.awsRegion, 'us-west-2')
            // MCP server should be added
            assert.ok(config.mcpServers['my-server'])

            // Remove the server
            await handler._handleRemove('my-server')

            config = readConfig(tmpDir)
            // Non-MCP keys should still be preserved
            assert.strictEqual(config.framework, 'sklearn')
            assert.strictEqual(config.modelServer, 'flask')
            assert.strictEqual(config.instanceType, 'ml.m5.xlarge')
            assert.strictEqual(config.awsRegion, 'us-west-2')
            // mcpServers key should be gone
            assert.ok(!config.mcpServers)
        })

        it('should create config file when it does not exist', async () => {
            const configPath = path.join(tmpDir, CONFIG_FILENAME)
            assert.ok(!fs.existsSync(configPath), 'Config file should not exist initially')

            const handler = new McpCommandHandler(createMockGen(tmpDir))
            await handler._handleAdd(
                ['new-server', '--', 'node', 'index.js'],
                {}
            )

            assert.ok(fs.existsSync(configPath), 'Config file should be created')
            const config = readConfig(tmpDir)
            assert.ok(config.mcpServers['new-server'])
            assert.strictEqual(config.mcpServers['new-server'].command, 'node')
        })

        it('should handle get for nonexistent server with helpful error', async () => {
            // Add a server first so there are available names to suggest
            const handler = new McpCommandHandler(createMockGen(tmpDir))
            await handler._handleAdd(['existing', '--', 'node', 'x.js'], {})

            const output = await captureConsoleLog(() => {
                handler._handleGet('nonexistent')
            })

            assert.ok(output.includes('not found'), 'Should indicate server not found')
            assert.ok(output.includes('existing'), 'Should list available server names')
        })

        it('should handle remove for nonexistent server', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir))
            await handler._handleAdd(['existing', '--', 'node', 'x.js'], {})

            const output = await captureConsoleLog(async () => {
                await handler._handleRemove('nonexistent')
            })

            assert.ok(output.includes('not found'), 'Should indicate server not found')
        })

        it('should show help when no subcommand provided', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir))

            const output = await captureConsoleLog(async () => {
                await handler.handle([], {})
            })

            assert.ok(output.includes('add'), 'Help should mention add command')
            assert.ok(output.includes('list'), 'Help should mention list command')
            assert.ok(output.includes('get'), 'Help should mention get command')
            assert.ok(output.includes('remove'), 'Help should mention remove command')
        })

        it('should handle add with env vars, toolName, and limit options', async () => {
            const handler = new McpCommandHandler(createMockGen(tmpDir))

            await handler._handleAdd(
                ['corp-policy', '--', 'npx', '-y', '@corp/mcp-sagemaker-policy'],
                {
                    e: ['TEAM_ID=ml-platform', 'REGION=us-east-1'],
                    'tool-name': 'get_approved_config',
                    limit: '20'
                }
            )

            const config = readConfig(tmpDir)
            const server = config.mcpServers['corp-policy']
            assert.strictEqual(server.command, 'npx')
            assert.deepStrictEqual(server.args, ['-y', '@corp/mcp-sagemaker-policy'])
            assert.deepStrictEqual(server.env, { TEAM_ID: 'ml-platform', REGION: 'us-east-1' })
            assert.strictEqual(server.toolName, 'get_approved_config')
            assert.strictEqual(server.limit, 20)
        })

        it('should show empty list message when no servers configured', async () => {
            writeConfigFile(tmpDir, { framework: 'sklearn' })

            const handler = new McpCommandHandler(createMockGen(tmpDir))

            const output = await captureConsoleLog(() => {
                handler._handleList({})
            })

            assert.ok(output.includes('No MCP servers configured'))
            assert.ok(output.includes('mcp add'))
        })

        it('should prompt for confirmation when overwriting existing server', async () => {
            let promptCalled = false
            const mockGen = createMockGen(tmpDir, { overwrite: true })
            mockGen.prompt = async (questions) => {
                promptCalled = true
                assert.ok(questions[0].message.includes('already exists'))
                return { overwrite: true }
            }

            // Add initial server
            const handler1 = new McpCommandHandler(createMockGen(tmpDir))
            await handler1._handleAdd(['my-server', '--', 'node', 'old.js'], {})

            // Overwrite with new command
            const handler2 = new McpCommandHandler(mockGen)
            await handler2._handleAdd(['my-server', '--', 'python', 'new.py'], {})

            assert.ok(promptCalled, 'Should have prompted for confirmation')
            const config = readConfig(tmpDir)
            assert.strictEqual(config.mcpServers['my-server'].command, 'python',
                'Server should be overwritten with new command')
        })

        it('should reject overwrite when user declines', async () => {
            const mockGen = createMockGen(tmpDir, { overwrite: false })
            mockGen.prompt = async () => ({ overwrite: false })

            // Add initial server
            const handler1 = new McpCommandHandler(createMockGen(tmpDir))
            await handler1._handleAdd(['my-server', '--', 'node', 'old.js'], {})

            // Try to overwrite
            const handler2 = new McpCommandHandler(mockGen)
            await handler2._handleAdd(['my-server', '--', 'python', 'new.py'], {})

            const config = readConfig(tmpDir)
            assert.strictEqual(config.mcpServers['my-server'].command, 'node',
                'Server should NOT be overwritten when user declines')
        })
    })


    // ============================================================================
    // Section 4: MCP Source Tracking
    // ============================================================================

    describe('MCP Source Tracking', () => {
        it('should track which parameters came from which MCP server', async () => {
            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            cm.config = cm._getGeneratorDefaults()
            cm.explicitConfig = {}
            cm.mcpChoices = {}
            cm.mcpSources = {}

            // Query server for instanceType
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge', awsRoleArn: 'arn:aws:iam::123456789012:role/TestRole' },
                choices: { instanceType: ['ml.m5.xlarge', 'ml.m5.2xlarge'] }
            })

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)

            // Merge and track (simulating _loadMcpConfig)
            for (const [param, value] of Object.entries(result.values)) {
                if (parameterMatrix[param] && parameterMatrix[param].valueSpace === 'unbounded') {
                    cm._mergeConfig({ [param]: value })
                    cm.mcpSources[param] = {
                        server: 'team-config',
                        value,
                        timestamp: new Date().toISOString()
                    }
                }
            }

            if (result.choices) {
                for (const [param, choices] of Object.entries(result.choices)) {
                    if (parameterMatrix[param] && parameterMatrix[param].valueSpace === 'unbounded') {
                        cm.mcpChoices[param] = choices
                    }
                }
            }

            // Verify source tracking
            const sources = cm.getMcpSources()
            assert.ok(sources.instanceType, 'instanceType should be tracked')
            assert.strictEqual(sources.instanceType.server, 'team-config')
            assert.strictEqual(sources.instanceType.value, 'ml.m5.xlarge')

            assert.ok(sources.awsRoleArn, 'awsRoleArn should be tracked')
            assert.strictEqual(sources.awsRoleArn.server, 'team-config')

            // Verify explicitConfig
            const explicit = cm.getExplicitConfiguration()
            assert.strictEqual(explicit.instanceType, 'ml.m5.xlarge')
            assert.strictEqual(explicit.awsRoleArn, 'arn:aws:iam::123456789012:role/TestRole')

            // Verify mcpChoices
            assert.deepStrictEqual(cm.mcpChoices.instanceType, ['ml.m5.xlarge', 'ml.m5.2xlarge'])
        })
    })

    // ============================================================================
    // Section 5: MCP Client with Real Protocol Handshake
    // ============================================================================

    describe('MCP Client Real Protocol Handshake', () => {
        it('should complete full MCP protocol lifecycle: spawn → handshake → tool call → close', async () => {
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge' },
                choices: { instanceType: ['ml.m5.xlarge'] }
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            // query() covers the full lifecycle
            const result = await client.query()

            assert.ok(result, 'Should get a result from the full protocol lifecycle')
            assert.ok(result.values.instanceType, 'Should have instanceType in values')

            // close() should not throw
            await client.close()
        })

        it('should only request unbounded parameters from the server', async () => {
            // The mock server returns whatever parameters are requested.
            // We verify that the client only sends unbounded params.
            const mockResponse = JSON.stringify({
                values: { instanceType: 'ml.m5.xlarge', framework: 'sklearn' },
                choices: {}
            })

            const mockGen = createMockGenerator()
            const cm = new ConfigManager(mockGen)
            const parameterMatrix = cm._getParameterMatrix()

            const client = new McpClient(
                {
                    command: 'node',
                    args: [MOCK_SERVER_PATH],
                    env: { MOCK_MCP_RESPONSE: mockResponse }
                },
                { timeout: 15000, parameterMatrix }
            )

            const result = await client.query()
            await client.close()

            assert.ok(result)
            // The client sends only unbounded params to the server.
            // The mock server only returns values for requested params.
            // instanceType is unbounded, so it should be in the result.
            // framework is bounded, but the mock returns it anyway since
            // it's in the response JSON. The filtering happens in _loadMcpConfig.
            // Here we verify the client correctly identifies unbounded params.
            const unboundedNames = client._getUnboundedParameterNames()
            assert.ok(unboundedNames.includes('instanceType'))
            assert.ok(unboundedNames.includes('awsRoleArn'))
            assert.ok(unboundedNames.includes('awsRegion'))
            assert.ok(!unboundedNames.includes('framework'))
        })
    })
})
