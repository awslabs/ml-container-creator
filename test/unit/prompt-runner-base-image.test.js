// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for _queryMcpForBaseImage and base image prompt flow
 *
 * Tests:
 * - MCP query is skipped when --base-image CLI flag is provided
 * - Search criteria prompt appears only for non-transformer frameworks
 * - _mcpBaseImageChoices are populated from MCP results
 * - Fallback behavior when MCP server is unavailable or returns empty results
 *
 * Feature: transformer-base-image-picker
 * Validates: Requirements 5.1, 5.4, 8.1, 8.2, 9.1, 9.2
 */

import { describe, it, beforeEach } from 'mocha'
import assert from 'assert'
import PromptRunner from '../../generators/app/lib/prompt-runner.js'

/**
 * Creates a mock generator with configurable options
 */
function createMockGenerator(opts = {}) {
    const promptResponses = opts.promptResponses || {}
    let promptCallCount = 0
    const promptCalls = []

    return {
        options: opts.cliOptions || {},
        configManager: opts.configManager || null,
        registryConfigManager: null,
        baseConfig: {},
        prompt: async (prompts) => {
            promptCallCount++
            const answers = {}
            for (const p of prompts) {
                const name = p.name
                promptCalls.push(name)
                if (promptResponses[name] !== undefined) {
                    answers[name] = promptResponses[name]
                } else if (p.default !== undefined) {
                    answers[name] = typeof p.default === 'function' ? p.default({}) : p.default
                } else {
                    answers[name] = ''
                }
            }
            return answers
        },
        _promptCallCount: () => promptCallCount,
        _promptCalls: () => promptCalls
    }
}

/**
 * Creates a mock ConfigManager
 */
function createMockConfigManager(opts = {}) {
    const mcpServers = opts.mcpServers || []
    const queryResult = opts.queryResult || null
    let queryCallCount = 0
    let lastQueryContext = null

    return {
        getMcpServerNames: () => mcpServers,
        queryMcpServer: async (serverName, context) => {
            queryCallCount++
            lastQueryContext = { serverName, context }
            return queryResult
        },
        mcpChoices: {},
        mcpSources: {},
        parameterMatrix: {},
        getExplicitConfiguration: () => ({}),
        _queryCallCount: () => queryCallCount,
        _lastQueryContext: () => lastQueryContext
    }
}

describe('PromptRunner._queryMcpForBaseImage', () => {

    describe('CLI override (--base-image)', () => {
        it('should skip MCP query when --base-image CLI flag is provided', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: { values: { baseImage: 'python:3.12-slim' }, choices: { baseImage: ['python:3.12-slim'] }, metadata: { baseImage: [{ image: 'python:3.12-slim' }] } }
            })
            const gen = createMockGenerator({
                cliOptions: { 'base-image': 'custom/image:latest' },
                configManager: cm
            })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            assert.strictEqual(cm._queryCallCount(), 0,
                'MCP query should not be called when --base-image is provided')
            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set')
        })
    })

    describe('MCP server not configured', () => {
        it('should skip when configManager is null', async () => {
            const gen = createMockGenerator({ configManager: null })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined)
        })

        it('should skip when base-image-picker is not in MCP servers', async () => {
            const cm = createMockConfigManager({ mcpServers: ['region-picker'] })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            assert.strictEqual(cm._queryCallCount(), 0)
            assert.strictEqual(runner._mcpBaseImageChoices, undefined)
        })
    })

    describe('Search criteria prompt for non-transformer frameworks', () => {
        it('should prompt for search criteria when framework is not transformers', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.11-slim' },
                    choices: { baseImage: ['python:3.11-slim'] },
                    metadata: { baseImage: [{
                        image: 'python:3.11-slim',
                        tag: '3.11-slim',
                        architecture: 'amd64',
                        created: '2023-10-01T00:00:00Z',
                        labels: { python_version: '3.11' },
                        registry: 'dockerhub',
                        repository: 'python'
                    }] }
                }
            })
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '3.11' }
            })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            // Should have prompted for search criteria
            assert.ok(gen._promptCalls().includes('baseImageSearch'),
                'Should prompt for baseImageSearch for non-transformer framework')

            // Should have passed searchCriteria to MCP
            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.context.searchCriteria, '3.11')
        })

        it('should NOT prompt for search criteria when framework is transformers', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-openai:v0.10.1' },
                    choices: { baseImage: ['vllm/vllm-openai:v0.10.1'] },
                    metadata: { baseImage: [{
                        image: 'vllm/vllm-openai:v0.10.1',
                        tag: 'v0.10.1',
                        architecture: 'amd64',
                        created: '2025-01-15T00:00:00Z',
                        labels: { cuda_version: '12.4', python_version: '3.12', framework_version: '0.10.1' },
                        registry: 'dockerhub',
                        repository: 'vllm/vllm-openai'
                    }] }
                }
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
            )

            assert.ok(!gen._promptCalls().includes('baseImageSearch'),
                'Should NOT prompt for baseImageSearch for transformer framework')
        })
    })

    describe('_mcpBaseImageChoices population', () => {
        it('should populate _mcpBaseImageChoices from MCP metadata results', async () => {
            const entries = [
                {
                    image: 'vllm/vllm-openai:v0.10.1',
                    tag: 'v0.10.1',
                    architecture: 'amd64',
                    created: '2025-01-15T00:00:00Z',
                    labels: { cuda_version: '12.4', python_version: '3.12', framework_version: '0.10.1' },
                    registry: 'dockerhub',
                    repository: 'vllm/vllm-openai'
                },
                {
                    image: 'vllm/vllm-openai:v0.9.1',
                    tag: 'v0.9.1',
                    architecture: 'amd64',
                    created: '2024-12-10T00:00:00Z',
                    labels: { cuda_version: '12.1', python_version: '3.12', framework_version: '0.9.1' },
                    registry: 'dockerhub',
                    repository: 'vllm/vllm-openai'
                }
            ]
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-openai:v0.10.1' },
                    choices: { baseImage: entries.map(e => e.image) },
                    metadata: { baseImage: entries }
                }
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
            )

            assert.ok(runner._mcpBaseImageChoices, '_mcpBaseImageChoices should be populated')
            assert.strictEqual(runner._mcpBaseImageChoices.length, 2)
            assert.strictEqual(runner._mcpBaseImageChoices[0].value, 'vllm/vllm-openai:v0.10.1')
            assert.strictEqual(runner._mcpBaseImageChoices[1].value, 'vllm/vllm-openai:v0.9.1')
        })
    })

    describe('Fallback behavior', () => {
        it('should not set _mcpBaseImageChoices when MCP returns null', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: null
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns null')
        })

        it('should not set _mcpBaseImageChoices when MCP returns empty metadata', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: null },
                    choices: { baseImage: [] },
                    metadata: { baseImage: [] }
                }
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'unknown-server' },
                {}
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns empty metadata')
        })

        it('should not set _mcpBaseImageChoices when MCP result has no metadata field', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.12-slim' },
                    choices: { baseImage: ['python:3.12-slim'] }
                }
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when metadata is missing')
        })
    })

    describe('MCP query context', () => {
        it('should pass framework and modelServer in context for transformer', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-openai:v0.10.1' },
                    choices: { baseImage: ['vllm/vllm-openai:v0.10.1'] },
                    metadata: { baseImage: [{ image: 'vllm/vllm-openai:v0.10.1', tag: 'v0.10.1', architecture: 'amd64', created: '2025-01-15T00:00:00Z', labels: { cuda_version: '12.4', python_version: '3.12' }, registry: 'dockerhub', repository: 'vllm/vllm-openai' }] }
                }
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
            )

            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.serverName, 'base-image-picker')
            assert.strictEqual(ctx.context.framework, 'transformers')
            assert.strictEqual(ctx.context.modelServer, 'vllm')
        })

        it('should pass framework in context for non-transformer without search', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.12-slim' },
                    choices: { baseImage: ['python:3.12-slim'] },
                    metadata: { baseImage: [{ image: 'python:3.12-slim', tag: '3.12-slim', architecture: 'amd64', created: '2024-10-01T00:00:00Z', labels: { python_version: '3.12' }, registry: 'dockerhub', repository: 'python' }] }
                }
            })
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '' }
            })
            const runner = new PromptRunner(gen)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
            )

            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.context.framework, 'sklearn')
            assert.strictEqual(ctx.context.modelServer, 'flask')
            assert.strictEqual(ctx.context.searchCriteria, undefined,
                'Empty search should not set searchCriteria')
        })
    })
})
