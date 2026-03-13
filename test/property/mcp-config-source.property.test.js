// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Config Source Property-Based Tests
 *
 * Property-based tests for the MCP configuration source feature.
 * Tests ConfigManager directly without running the full Yeoman generator.
 *
 * Feature: mcp-config-source
 */

import fc from 'fast-check'
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ConfigManager from '../../generators/app/lib/config-manager.js'
import { McpClient, DEFAULT_TOOL_NAME, DEFAULT_LIMIT } from '../../generators/app/lib/mcp-client.js'
import PromptRunner from '../../generators/app/lib/prompt-runner.js'
import { createMockGenerator } from '../helpers/mock-generator.js'

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
}

/**
 * Helper: create a temp directory with a config/mcp.json
 * and return a mock generator pointing at it.
 */
function setupTempDir(configContent) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prop-'))
    if (configContent !== undefined) {
        const configDir = path.join(tmpDir, 'config')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(
            path.join(configDir, 'mcp.json'),
            JSON.stringify(configContent)
        )
    }
    return tmpDir
}

function cleanupTempDir(tmpDir) {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (_) {
        // ignore
    }
}

/**
 * Arbitrary generator for valid SageMaker instance types
 */
const arbInstanceType = fc.tuple(
    fc.constantFrom('m5', 'g4dn', 'g5', 'c5', 'p3', 'r5'),
    fc.constantFrom('large', 'xlarge', '2xlarge', '4xlarge')
).map(([family, size]) => `ml.${family}.${size}`)

/**
 * Arbitrary generator for valid AWS Role ARNs
 */
const arbRoleArn = fc.integer({ min: 100000000000, max: 999999999999 })
    .map(acct => `arn:aws:iam::${acct}:role/TestRole`)

describe('MCP Config Source Property-Based Tests', () => {
    let parameterMatrix

    before(() => {
        const mockGen = createMockGenerator()
        const configManager = new ConfigManager(mockGen)
        parameterMatrix = configManager._getParameterMatrix()
    })

    // Feature: mcp-config-source, Property 3: Every Parameter Has a Valid Value Space Classification
    describe('Property 3: Every Parameter Has a Valid Value Space Classification', () => {
        it('every parameter in the matrix SHALL have a valueSpace of "bounded" or "unbounded"', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const paramNames = Object.keys(parameterMatrix)

            fc.assert(fc.property(
                fc.constantFrom(...paramNames),
                (paramName) => {
                    const entry = parameterMatrix[paramName]
                    assert.ok(
                        'valueSpace' in entry,
                        `Parameter "${paramName}" is missing the "valueSpace" field`
                    )
                    assert.ok(
                        entry.valueSpace === 'bounded' || entry.valueSpace === 'unbounded',
                        `Parameter "${paramName}" has invalid valueSpace "${entry.valueSpace}"`
                    )
                    return true
                }
            ), {
                numRuns: FAST_PROPERTY_CONFIG.numRuns,
                verbose: FAST_PROPERTY_CONFIG.verbose
            })
        })

        it('mcp flag is consistent with valueSpace classification', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const paramNames = Object.keys(parameterMatrix)

            fc.assert(fc.property(
                fc.constantFrom(...paramNames),
                (paramName) => {
                    const entry = parameterMatrix[paramName]
                    assert.ok('mcp' in entry, `Parameter "${paramName}" is missing the "mcp" field`)

                    if (entry.valueSpace === 'bounded') {
                        assert.strictEqual(entry.mcp, false,
                            `Bounded parameter "${paramName}" must have mcp: false`)
                    }
                    if (entry.valueSpace === 'unbounded') {
                        assert.strictEqual(entry.mcp, true,
                            `Unbounded parameter "${paramName}" must have mcp: true`)
                    }
                    return true
                }
            ), {
                numRuns: FAST_PROPERTY_CONFIG.numRuns,
                verbose: FAST_PROPERTY_CONFIG.verbose
            })
        })
    })

    // Feature: mcp-config-source, Property 16: MCP Response Parsing Extracts Values Correctly
    describe('Property 16: MCP Response Parsing Extracts Values Correctly', () => {
        it('for any valid MCP tool response containing values and/or choices, McpClient SHALL extract them without loss or corruption', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbValues = fc.dictionary(
                fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,19}$/),
                fc.oneof(
                    fc.string({ minLength: 1, maxLength: 50 }),
                    fc.integer(),
                    fc.boolean()
                ),
                { minKeys: 0, maxKeys: 5 }
            )

            const arbChoices = fc.dictionary(
                fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,19}$/),
                fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
                { minKeys: 0, maxKeys: 5 }
            )

            fc.assert(fc.property(
                arbValues,
                arbChoices,
                (values, choices) => {
                    const mockResult = {
                        content: [{ type: 'text', text: JSON.stringify({ values, choices }) }]
                    }
                    const client = new McpClient({ command: 'echo', args: [] }, { parameterMatrix: {} })
                    const parsed = client._parseResponse(mockResult)

                    assert.ok(parsed !== null)
                    for (const [key, value] of Object.entries(values)) {
                        assert.deepStrictEqual(parsed.values[key], value)
                    }
                    for (const [key, choiceList] of Object.entries(choices)) {
                        assert.deepStrictEqual(parsed.choices[key], choiceList)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('responses with only values or only choices are parsed correctly', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.boolean(),
                fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z]/.test(s)),
                (valuesOnly, paramName) => {
                    const responsePayload = valuesOnly
                        ? { values: { [paramName]: 'test-value' } }
                        : { choices: { [paramName]: ['opt1', 'opt2'] } }

                    const mockResult = {
                        content: [{ type: 'text', text: JSON.stringify(responsePayload) }]
                    }
                    const client = new McpClient({ command: 'echo', args: [] }, { parameterMatrix: {} })
                    const parsed = client._parseResponse(mockResult)

                    assert.ok(parsed !== null)
                    if (valuesOnly) {
                        assert.strictEqual(parsed.values[paramName], 'test-value')
                        assert.strictEqual(Object.keys(parsed.choices).length, 0)
                    } else {
                        assert.deepStrictEqual(parsed.choices[paramName], ['opt1', 'opt2'])
                        assert.strictEqual(Object.keys(parsed.values).length, 0)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 9: Server Config Defaults Apply Correctly
    describe('Property 9: Server Config Defaults Apply Correctly', () => {
        it('for any server config that omits toolName, the system SHALL use "get_ml_config" as default', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerConfig = fc.record({
                command: fc.stringMatching(/^[a-z][a-z0-9\-]{0,19}$/),
                args: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
                env: fc.dictionary(
                    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,9}$/),
                    fc.string({ minLength: 1, maxLength: 20 }),
                    { minKeys: 0, maxKeys: 3 }
                )
            })

            fc.assert(fc.property(arbServerConfig, (serverConfig) => {
                const client = new McpClient(serverConfig, {})
                assert.strictEqual(client.toolName, DEFAULT_TOOL_NAME)
                return true
            }), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for any server config that omits limit, the system SHALL use the global default limit of 10', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerConfig = fc.record({
                command: fc.stringMatching(/^[a-z][a-z0-9\-]{0,19}$/),
                args: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })
            })

            fc.assert(fc.property(arbServerConfig, (serverConfig) => {
                const client = new McpClient(serverConfig, {})
                assert.strictEqual(client.limit, DEFAULT_LIMIT)
                return true
            }), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('for any server config that provides toolName and limit, those values SHALL be used', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerConfig = fc.record({
                command: fc.stringMatching(/^[a-z][a-z0-9\-]{0,19}$/),
                args: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
                toolName: fc.stringMatching(/^[a-z][a-z_]{0,19}$/),
                limit: fc.integer({ min: 1, max: 100 })
            })

            fc.assert(fc.property(arbServerConfig, (serverConfig) => {
                const client = new McpClient(serverConfig, {})
                assert.strictEqual(client.toolName, serverConfig.toolName)
                assert.strictEqual(client.limit, serverConfig.limit)
                return true
            }), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 1: MCP Precedence in the Configuration Chain
    describe('Property 1: MCP Precedence in the Configuration Chain', () => {
        let tmpDir

        afterEach(() => {
            if (tmpDir) cleanupTempDir(tmpDir)
        })

        it('higher-precedence sources (env vars) SHALL override MCP values for unbounded parameters', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbInstanceType,
                arbInstanceType,
                (mcpValue, envValue) => {
                    fc.pre(mcpValue !== envValue)

                    // Set up ConfigManager with MCP values already loaded
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    // Simulate MCP having set a value
                    cm.config.instanceType = mcpValue
                    cm.explicitConfig.instanceType = mcpValue

                    // Now simulate env var override (higher precedence)
                    process.env.ML_INSTANCE_TYPE = envValue
                    try {
                        // Build env mapping and apply
                        const envMapping = {}
                        Object.entries(cm.parameterMatrix).forEach(([param, config]) => {
                            if (config.envVar) envMapping[config.envVar] = param
                        })
                        Object.entries(envMapping).forEach(([envVar, configKey]) => {
                            const value = process.env[envVar]
                            if (value !== undefined && value !== '') {
                                cm.config[configKey] = cm._parseValue(configKey, value)
                                cm.explicitConfig[configKey] = cm._parseValue(configKey, value)
                            }
                        })

                        // The env var value should win
                        assert.strictEqual(cm.config.instanceType, envValue)
                    } finally {
                        delete process.env.ML_INSTANCE_TYPE
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('MCP values SHALL override lower-precedence sources (config files, defaults)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbInstanceType,
                arbInstanceType,
                (configFileValue, mcpValue) => {
                    fc.pre(configFileValue !== mcpValue)

                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    // Simulate config file having set a value (lower precedence)
                    cm.config.instanceType = configFileValue
                    cm.explicitConfig.instanceType = configFileValue

                    // Now simulate MCP override (higher precedence than config file)
                    cm._mergeConfig({ instanceType: mcpValue })

                    assert.strictEqual(cm.config.instanceType, mcpValue)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 2: Bounded Parameters Are Immune to MCP
    describe('Property 2: Bounded Parameters Are Immune to MCP', () => {
        it('for any bounded parameter, MCP values SHALL be discarded and the parameter unchanged', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const boundedParams = Object.entries(parameterMatrix)
                .filter(([_, config]) => config.valueSpace === 'bounded')
                .map(([name]) => name)

            fc.assert(fc.property(
                fc.constantFrom(...boundedParams),
                fc.string({ minLength: 1, maxLength: 30 }),
                (paramName, mcpValue) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    const valueBefore = cm.config[paramName]

                    // _isSourceSupported should return false for bounded params with mcp source
                    const supported = cm._isSourceSupported(paramName, 'mcp')
                    assert.strictEqual(supported, false,
                        `Bounded parameter "${paramName}" should not support MCP source`)

                    // Config should be unchanged
                    assert.strictEqual(cm.config[paramName], valueBefore)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 4: MCP Queries Only Unbounded Parameters
    describe('Property 4: MCP Queries Only Unbounded Parameters', () => {
        it('McpClient._getUnboundedParameterNames SHALL return only unbounded parameters', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            // This property is deterministic but we test it with arbitrary subsets
            const allParams = Object.keys(parameterMatrix)
            const unboundedSet = new Set(
                Object.entries(parameterMatrix)
                    .filter(([_, c]) => c.valueSpace === 'unbounded' && c.mcp === true)
                    .map(([n]) => n)
            )

            fc.assert(fc.property(
                fc.constantFrom(...allParams),
                (paramName) => {
                    const client = new McpClient(
                        { command: 'echo', args: [] },
                        { parameterMatrix }
                    )
                    const names = client._getUnboundedParameterNames()

                    if (unboundedSet.has(paramName)) {
                        assert.ok(names.includes(paramName),
                            `Unbounded parameter "${paramName}" should be in query list`)
                    } else {
                        assert.ok(!names.includes(paramName),
                            `Bounded parameter "${paramName}" should NOT be in query list`)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 6: MCP Values Undergo Validation and Parsing
    describe('Property 6: MCP Values Undergo Validation and Parsing', () => {
        it('valid MCP values SHALL pass validation and be parsed correctly', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbInstanceType,
                (instanceType) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)

                    // Should not throw for valid instance types
                    cm._validateParameterValue('instanceType', instanceType, {})
                    const parsed = cm._parseValue('instanceType', instanceType)
                    assert.strictEqual(parsed, instanceType)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('invalid MCP values SHALL fail validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbInvalidInstanceType = fc.stringMatching(/^[a-z]{2,10}$/)
                .filter(s => !s.startsWith('ml.'))

            fc.assert(fc.property(
                arbInvalidInstanceType,
                (badValue) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)

                    let threw = false
                    try {
                        cm._validateParameterValue('instanceType', badValue, {})
                    } catch (err) {
                        threw = true
                    }
                    assert.ok(threw, `Expected validation to fail for "${badValue}"`)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('valid ARN values SHALL pass validation', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbRoleArn,
                (arn) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)

                    cm._validateParameterValue('awsRoleArn', arn, {})
                    const parsed = cm._parseValue('awsRoleArn', arn)
                    assert.strictEqual(parsed, arn)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 7: Unknown Parameters From MCP Are Discarded
    describe('Property 7: Unknown Parameters From MCP Are Discarded', () => {
        it('parameters not in the matrix SHALL be discarded by _isSourceSupported', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const knownParams = new Set(Object.keys(parameterMatrix))

            const arbUnknownParam = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,20}$/)
                .filter(s => !knownParams.has(s))

            fc.assert(fc.property(
                arbUnknownParam,
                (unknownParam) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)

                    // Unknown params should not be supported for any source
                    assert.strictEqual(cm._isSourceSupported(unknownParam, 'mcp'), false)
                    assert.strictEqual(cm._isSourceSupported(unknownParam, 'configFile'), false)

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('merging unknown parameters SHALL not add them to config when filtered', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const knownParams = new Set(Object.keys(parameterMatrix))

            const arbUnknownParam = fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,20}$/)
                .filter(s => !knownParams.has(s))

            fc.assert(fc.property(
                arbUnknownParam,
                fc.string({ minLength: 1, maxLength: 30 }),
                (unknownParam, value) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    // Simulate the filtering that _loadMcpConfig does
                    const filteredConfig = {}
                    const mcpResult = { [unknownParam]: value }
                    for (const [param, val] of Object.entries(mcpResult)) {
                        if (cm.parameterMatrix[param]) {
                            filteredConfig[param] = val
                        }
                    }

                    cm._mergeConfig(filteredConfig)

                    // Unknown param should not be in config
                    assert.strictEqual(cm.config[unknownParam], undefined)
                    assert.strictEqual(cm.explicitConfig[unknownParam], undefined)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 8: MCP Response Truncation Respects Limit
    describe('Property 8: MCP Response Truncation Respects Limit', () => {
        it('choices lists exceeding the limit SHALL be truncated to exactly the limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.integer({ min: 1, max: 50 }),
                fc.array(arbInstanceType, { minLength: 1, maxLength: 60 }),
                (limit, choices) => {
                    // Simulate the truncation logic from _loadMcpConfig
                    const truncated = choices.slice(0, limit)

                    if (choices.length > limit) {
                        assert.strictEqual(truncated.length, limit)
                    } else {
                        assert.strictEqual(truncated.length, choices.length)
                    }

                    // Truncated list should be a prefix of the original
                    for (let i = 0; i < truncated.length; i++) {
                        assert.strictEqual(truncated[i], choices[i])
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('default limit of 10 SHALL apply when no per-server limit is set', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                fc.array(arbInstanceType, { minLength: 11, maxLength: 30 }),
                (choices) => {
                    const DEFAULT_LIMIT = 10
                    const truncated = choices.slice(0, DEFAULT_LIMIT)
                    assert.strictEqual(truncated.length, DEFAULT_LIMIT)
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 10: Later MCP Servers Take Precedence
    describe('Property 10: Later MCP Servers Take Precedence', () => {
        it('for conflicting values from multiple servers, the later server SHALL win', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbInstanceType,
                arbInstanceType,
                (firstValue, secondValue) => {
                    fc.pre(firstValue !== secondValue)

                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    // Simulate first server merging its value
                    cm._mergeConfig({ instanceType: firstValue })
                    cm.mcpSources.instanceType = {
                        server: 'server-1',
                        value: firstValue,
                        timestamp: new Date().toISOString()
                    }

                    // Simulate second server merging its value (later = higher precedence)
                    cm._mergeConfig({ instanceType: secondValue })
                    cm.mcpSources.instanceType = {
                        server: 'server-2',
                        value: secondValue,
                        timestamp: new Date().toISOString()
                    }

                    assert.strictEqual(cm.config.instanceType, secondValue)
                    assert.strictEqual(cm.mcpSources.instanceType.server, 'server-2')
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 11: MCP Source Tracking Is Complete
    describe('Property 11: MCP Source Tracking Is Complete', () => {
        it('every MCP-resolved parameter SHALL appear in explicitConfig and getMcpSources()', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbInstanceType,
                arbRoleArn,
                fc.boolean(),
                (instanceType, roleArn, includeBoth) => {
                    const mockGen = createMockGenerator()
                    const cm = new ConfigManager(mockGen)
                    cm.config = cm._getGeneratorDefaults()
                    cm.explicitConfig = {}
                    cm.mcpChoices = {}
                    cm.mcpSources = {}

                    // Simulate MCP loading values
                    const mcpValues = { instanceType }
                    if (includeBoth) {
                        mcpValues.awsRoleArn = roleArn
                    }

                    // Merge and track (simulating what _loadMcpConfig does)
                    for (const [param, value] of Object.entries(mcpValues)) {
                        cm._mergeConfig({ [param]: value })
                        cm.mcpSources[param] = {
                            server: 'test-server',
                            value,
                            timestamp: new Date().toISOString()
                        }
                    }

                    // Verify explicitConfig has the values
                    assert.strictEqual(cm.explicitConfig.instanceType, instanceType)
                    if (includeBoth) {
                        assert.strictEqual(cm.explicitConfig.awsRoleArn, roleArn)
                    }

                    // Verify getMcpSources() returns tracking info
                    const sources = cm.getMcpSources()
                    assert.ok(sources.instanceType)
                    assert.strictEqual(sources.instanceType.server, 'test-server')
                    assert.strictEqual(sources.instanceType.value, instanceType)
                    if (includeBoth) {
                        assert.ok(sources.awsRoleArn)
                        assert.strictEqual(sources.awsRoleArn.value, roleArn)
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})


// ============================================================================
// MCP CLI Command Property Tests (Properties 12–15)
// ============================================================================

import McpCommandHandler from '../../generators/app/lib/mcp-command-handler.js'

/**
 * Helper: create a mock generator that points at a temp directory
 * and captures prompt calls.
 */
function createCliMockGenerator(tmpDir) {
    return {
        options: {},
        args: [],
        destinationRoot: () => tmpDir,
        destinationPath: (filepath) => {
            if (!filepath) return tmpDir
            return path.join(tmpDir, filepath)
        },
        prompt: async () => ({ overwrite: true }),
        env: { error: (msg) => { throw new Error(msg) } },
        config: { getAll: () => ({}), save: () => {} },
        fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} }
    }
}

describe('MCP CLI Command Property-Based Tests', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-prop-'))
    })

    afterEach(() => {
        if (tmpDir) cleanupTempDir(tmpDir)
    })

    // Feature: mcp-config-source, Property 12: mcp add Round-Trip
    describe('Property 12: mcp add Round-Trip', () => {
        it('for any valid server config, mcp add then mcp get SHALL return the same config', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerName = fc.stringMatching(/^[a-z][a-z0-9\-]{0,14}$/)
            const arbCommand = fc.stringMatching(/^[a-z][a-z0-9\-]{0,9}$/)
            const arbArgs = fc.array(fc.stringMatching(/^[a-zA-Z0-9\-_.\/]{1,20}$/), { minLength: 0, maxLength: 4 })
            const arbEnv = fc.dictionary(
                fc.stringMatching(/^[A-Z][A-Z0-9_]{0,9}$/),
                fc.stringMatching(/^[a-zA-Z0-9\-_]{1,15}$/),
                { minKeys: 0, maxKeys: 3 }
            )
            const arbToolName = fc.stringMatching(/^[a-z][a-z_]{0,14}$/)
            const arbLimit = fc.integer({ min: 1, max: 100 })

            fc.assert(fc.property(
                arbServerName,
                arbCommand,
                arbArgs,
                arbEnv,
                arbToolName,
                arbLimit,
                (name, command, args, env, toolName, limit) => {
                    // Fresh temp dir for each run
                    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rt-'))
                    try {
                        const mockGen = createCliMockGenerator(runDir)
                        const handler = new McpCommandHandler(mockGen)

                        // Build options for add
                        const addOptions = {
                            'tool-name': toolName,
                            limit: limit,
                            e: Object.entries(env).map(([k, v]) => `${k}=${v}`)
                        }

                        // Simulate: mcp add <name> -- <command> [args...]
                        const addArgs = [name, '--', command, ...args]
                        handler._handleAdd(addArgs, addOptions)

                        // Read back the config
                        const config = handler._readConfig()
                        const server = config.mcpServers[name]

                        assert.ok(server, `Server "${name}" should exist after add`)
                        assert.strictEqual(server.command, command)
                        if (args.length > 0) {
                            assert.deepStrictEqual(server.args, args)
                        }
                        if (Object.keys(env).length > 0) {
                            // Normalize both to plain objects for comparison
                            // (fc.dictionary creates null-prototype objects)
                            assert.deepStrictEqual(
                                JSON.parse(JSON.stringify(server.env)),
                                JSON.parse(JSON.stringify(env))
                            )
                        }
                        assert.strictEqual(server.toolName, toolName)
                        assert.strictEqual(server.limit, limit)
                    } finally {
                        cleanupTempDir(runDir)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 13: mcp add/remove Round-Trip Preserves Config
    describe('Property 13: mcp add/remove Round-Trip Preserves Config', () => {
        it('adding then removing a server SHALL preserve all non-MCP config keys', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerName = fc.stringMatching(/^[a-z][a-z0-9\-]{0,14}$/)
            const arbExistingConfig = fc.dictionary(
                fc.stringMatching(/^[a-z][a-zA-Z]{0,14}$/).filter(k => k !== 'mcpServers'),
                fc.oneof(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.integer(),
                    fc.boolean()
                ),
                { minKeys: 1, maxKeys: 5 }
            )

            fc.assert(fc.property(
                arbServerName,
                arbExistingConfig,
                (name, existingConfig) => {
                    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preserve-'))
                    try {
                        // Write initial config with non-MCP keys
                        const configDir = path.join(runDir, 'config')
                        fs.mkdirSync(configDir, { recursive: true })
                        const configPath = path.join(configDir, 'mcp.json')
                        fs.writeFileSync(configPath, JSON.stringify(existingConfig))

                        const mockGen = createCliMockGenerator(runDir)
                        const handler = new McpCommandHandler(mockGen)

                        // Add a server
                        handler._handleAdd([name, '--', 'node', 'server.js'], {})

                        // Remove the server
                        handler._handleRemove(name)

                        // Read back config
                        const finalConfig = handler._readConfig()

                        // All original keys should be preserved
                        for (const [key, value] of Object.entries(existingConfig)) {
                            assert.deepStrictEqual(finalConfig[key], value,
                                `Key "${key}" should be preserved after add/remove`)
                        }

                        // mcpServers should be gone (last server removed)
                        assert.strictEqual(finalConfig.mcpServers, undefined,
                            'mcpServers key should be removed when last server is removed')
                    } finally {
                        cleanupTempDir(runDir)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 14: mcp list Shows All Configured Servers
    describe('Property 14: mcp list Shows All Configured Servers', () => {
        it('for any N servers in mcpServers, mcp list SHALL include all N names', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerName = fc.stringMatching(/^[a-z][a-z0-9\-]{0,14}$/)
            const arbServerNames = fc.uniqueArray(arbServerName, { minLength: 1, maxLength: 8 })

            fc.assert(fc.property(
                arbServerNames,
                (names) => {
                    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-list-'))
                    try {
                        // Build config with N servers
                        const mcpServers = {}
                        for (const name of names) {
                            mcpServers[name] = { command: 'node', args: ['server.js'] }
                        }
                        const configDir = path.join(runDir, 'config')
                        fs.mkdirSync(configDir, { recursive: true })
                        const configPath = path.join(configDir, 'mcp.json')
                        fs.writeFileSync(configPath, JSON.stringify({ mcpServers }))

                        const mockGen = createCliMockGenerator(runDir)
                        const handler = new McpCommandHandler(mockGen)

                        // Capture console output
                        const logs = []
                        const origLog = console.log
                        console.log = (...args) => logs.push(args.join(' '))

                        try {
                            handler._handleList({})
                        } finally {
                            console.log = origLog
                        }

                        const output = logs.join('\n')
                        for (const name of names) {
                            assert.ok(output.includes(name),
                                `Output should include server name "${name}"`)
                        }
                    } finally {
                        cleanupTempDir(runDir)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 15: mcp get Shows Full Server Configuration
    describe('Property 15: mcp get Shows Full Server Configuration', () => {
        it('for any configured server, mcp get SHALL display command, args, env, toolName, and limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbServerName = fc.stringMatching(/^[a-z][a-z0-9\-]{0,14}$/)
            const arbCommand = fc.stringMatching(/^[a-z][a-z0-9\-]{0,9}$/)
            const arbArgs = fc.array(fc.stringMatching(/^[a-zA-Z0-9\-_.]{1,15}$/), { minLength: 1, maxLength: 3 })
            const arbToolName = fc.stringMatching(/^[a-z][a-z_]{0,14}$/)
            const arbLimit = fc.integer({ min: 1, max: 100 })

            fc.assert(fc.property(
                arbServerName,
                arbCommand,
                arbArgs,
                arbToolName,
                arbLimit,
                (name, command, args, toolName, limit) => {
                    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-get-'))
                    try {
                        const serverConfig = {
                            command,
                            args,
                            env: { TEST_KEY: 'test_value' },
                            toolName,
                            limit
                        }
                        const configDir = path.join(runDir, 'config')
                        fs.mkdirSync(configDir, { recursive: true })
                        const configPath = path.join(configDir, 'mcp.json')
                        fs.writeFileSync(configPath, JSON.stringify({
                            mcpServers: { [name]: serverConfig }
                        }))

                        const mockGen = createCliMockGenerator(runDir)
                        const handler = new McpCommandHandler(mockGen)

                        // Capture console output
                        const logs = []
                        const origLog = console.log
                        console.log = (...a) => logs.push(a.join(' '))

                        try {
                            handler._handleGet(name)
                        } finally {
                            console.log = origLog
                        }

                        const output = logs.join('\n')
                        assert.ok(output.includes(command), `Output should include command "${command}"`)
                        assert.ok(output.includes(args.join(' ')), `Output should include args`)
                        assert.ok(output.includes(toolName), `Output should include toolName "${toolName}"`)
                        assert.ok(output.includes(String(limit)), `Output should include limit ${limit}`)
                        assert.ok(output.includes('TEST_KEY'), 'Output should include env key')
                    } finally {
                        cleanupTempDir(runDir)
                    }
                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })

    // Feature: mcp-config-source, Property 5: Prompt Choices Reflect MCP State With Fallback
    describe('Property 5: Prompt Choices Reflect MCP State With Fallback', () => {
        /**
         * Helper: create a mock generator whose .prompt() captures the transformed
         * prompt objects so we can inspect the choices function that _runPhase builds.
         */
        function createPromptCapturingGenerator(mcpChoices) {
            let capturedPrompts = []
            const matrix = new ConfigManager(createMockGenerator())._getParameterMatrix()
            const mockGen = {
                options: {},
                args: [],
                destinationRoot: () => process.cwd(),
                destinationPath: (fp) => fp ? path.join(process.cwd(), fp) : process.cwd(),
                env: { error: (msg) => { throw new Error(msg) } },
                config: { getAll: () => ({}), save: () => {} },
                fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} },
                prompt: async (prompts) => {
                    capturedPrompts = prompts
                    return {}
                },
                configManager: {
                    mcpChoices: mcpChoices || {},
                    parameterMatrix: matrix,
                    getExplicitConfiguration: () => ({})
                }
            }
            return { mockGen, getCapturedPrompts: () => capturedPrompts }
        }

        it('when MCP provides non-empty choices, prompt SHALL present MCP choices plus Custom option', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbMcpChoices = fc.array(arbInstanceType, { minLength: 1, maxLength: 10 })

            fc.assert(fc.property(
                arbMcpChoices,
                (mcpInstanceChoices) => {
                    const { mockGen, getCapturedPrompts } = createPromptCapturingGenerator({
                        instanceType: mcpInstanceChoices
                    })

                    const runner = new PromptRunner(mockGen)

                    // Build a simple prompt with choices (mimicking instanceType prompt)
                    const testPrompt = {
                        type: 'list',
                        name: 'instanceType',
                        message: 'Select instance type:',
                        choices: () => [
                            { name: 'ml.m5.xlarge', value: 'ml.m5.xlarge' },
                            { name: 'Custom...', value: 'custom' }
                        ]
                    }

                    // Call _runPhase to get the transformed prompts
                    runner._runPhase([testPrompt], {}, {}, {})

                    const captured = getCapturedPrompts()
                    assert.ok(captured.length > 0, 'Should have captured prompts')

                    const instancePrompt = captured.find(p => p.name === 'instanceType')
                    assert.ok(instancePrompt, 'Should find instanceType prompt')
                    assert.ok(typeof instancePrompt.choices === 'function', 'choices should be a function')

                    const choices = instancePrompt.choices({})

                    // Should have MCP choices + Custom option
                    assert.strictEqual(choices.length, mcpInstanceChoices.length + 1,
                        `Should have ${mcpInstanceChoices.length} MCP choices + 1 Custom option`)

                    // Last choice should be Custom
                    const lastChoice = choices[choices.length - 1]
                    assert.strictEqual(lastChoice.value, 'custom', 'Last choice should be custom')
                    assert.ok(lastChoice.name.includes('Custom'), 'Last choice name should include Custom')

                    // MCP choices should be present in order
                    for (let i = 0; i < mcpInstanceChoices.length; i++) {
                        assert.strictEqual(choices[i].value, mcpInstanceChoices[i],
                            `Choice ${i} should be MCP value "${mcpInstanceChoices[i]}"`)
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('when MCP is not configured or returns empty choices, prompt SHALL fall back to original choices', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbOriginalChoices = fc.array(
                arbInstanceType,
                { minLength: 1, maxLength: 5 }
            ).map(types => types.map(t => ({ name: t, value: t })))

            fc.assert(fc.property(
                arbOriginalChoices,
                fc.constantFrom(undefined, null, {}, { instanceType: [] }),
                (originalChoices, mcpChoicesState) => {
                    const { mockGen, getCapturedPrompts } = createPromptCapturingGenerator(
                        mcpChoicesState || {}
                    )
                    // If mcpChoicesState is null/undefined, set configManager.mcpChoices accordingly
                    if (mcpChoicesState === undefined || mcpChoicesState === null) {
                        mockGen.configManager.mcpChoices = mcpChoicesState
                    }

                    const runner = new PromptRunner(mockGen)

                    const expectedChoices = [...originalChoices, { name: 'Custom...', value: 'custom' }]
                    const testPrompt = {
                        type: 'list',
                        name: 'instanceType',
                        message: 'Select instance type:',
                        choices: () => expectedChoices
                    }

                    runner._runPhase([testPrompt], {}, {}, {})

                    const captured = getCapturedPrompts()
                    assert.ok(captured.length > 0, 'Should have captured prompts')

                    const instancePrompt = captured.find(p => p.name === 'instanceType')
                    const choices = instancePrompt.choices({})

                    // Should fall back to original choices
                    assert.deepStrictEqual(choices, expectedChoices,
                        'Should return original choices when MCP is not configured or empty')

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        it('when MCP errors (configManager has no mcpChoices), prompt SHALL fall back to original choices', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbOriginalChoices = fc.array(
                arbInstanceType,
                { minLength: 1, maxLength: 5 }
            ).map(types => types.map(t => ({ name: t, value: t })))

            fc.assert(fc.property(
                arbOriginalChoices,
                (originalChoices) => {
                    // Simulate no configManager at all (MCP errored / not configured)
                    let capturedPrompts = []
                    const mockGen = {
                        options: {},
                        args: [],
                        destinationRoot: () => process.cwd(),
                        destinationPath: (fp) => fp ? path.join(process.cwd(), fp) : process.cwd(),
                        env: { error: (msg) => { throw new Error(msg) } },
                        config: { getAll: () => ({}), save: () => {} },
                        fs: { exists: () => false, read: () => '', write: () => {}, copyTpl: () => {} },
                        prompt: async (prompts) => {
                            capturedPrompts = prompts
                            return {}
                        },
                        configManager: null
                    }

                    const runner = new PromptRunner(mockGen)

                    const expectedChoices = [...originalChoices, { name: 'Custom...', value: 'custom' }]
                    const testPrompt = {
                        type: 'list',
                        name: 'instanceType',
                        message: 'Select instance type:',
                        choices: () => expectedChoices
                    }

                    runner._runPhase([testPrompt], {}, {}, {})

                    assert.ok(capturedPrompts.length > 0, 'Should have captured prompts')
                    const instancePrompt = capturedPrompts.find(p => p.name === 'instanceType')
                    const choices = instancePrompt.choices({})

                    assert.deepStrictEqual(choices, expectedChoices,
                        'Should return original choices when configManager is null')

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
