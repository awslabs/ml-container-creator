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

<<<<<<< HEAD
import { describe, it, beforeEach } from 'mocha'
import assert from 'assert'
import PromptRunner from '../../generators/app/lib/prompt-runner.js'
=======
import { describe, it } from 'mocha';
import assert from 'assert';
import PromptRunner from '../../generators/app/lib/prompt-runner.js';
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Creates a mock generator with configurable options
 */
function createMockGenerator(opts = {}) {
<<<<<<< HEAD
    const promptResponses = opts.promptResponses || {}
    let promptCallCount = 0
    const promptCalls = []
=======
    const promptResponses = opts.promptResponses || {};
    let promptCallCount = 0;
    const promptCalls = [];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    return {
        options: opts.cliOptions || {},
        configManager: opts.configManager || null,
        registryConfigManager: null,
        baseConfig: {},
        prompt: async (prompts) => {
<<<<<<< HEAD
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
=======
            promptCallCount++;
            const answers = {};
            for (const p of prompts) {
                const name = p.name;
                promptCalls.push(name);
                if (promptResponses[name] !== undefined) {
                    answers[name] = promptResponses[name];
                } else if (p.default !== undefined) {
                    answers[name] = typeof p.default === 'function' ? p.default({}) : p.default;
                } else {
                    answers[name] = '';
                }
            }
            return answers;
        },
        _promptCallCount: () => promptCallCount,
        _promptCalls: () => promptCalls
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

/**
 * Creates a mock ConfigManager
 */
function createMockConfigManager(opts = {}) {
<<<<<<< HEAD
    const mcpServers = opts.mcpServers || []
    const queryResult = opts.queryResult || null
    let queryCallCount = 0
    let lastQueryContext = null
=======
    const mcpServers = opts.mcpServers || [];
    const queryResult = opts.queryResult || null;
    let queryCallCount = 0;
    let lastQueryContext = null;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    return {
        getMcpServerNames: () => mcpServers,
        queryMcpServer: async (serverName, context) => {
<<<<<<< HEAD
            queryCallCount++
            lastQueryContext = { serverName, context }
            return queryResult
=======
            queryCallCount++;
            lastQueryContext = { serverName, context };
            return queryResult;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
        },
        mcpChoices: {},
        mcpSources: {},
        parameterMatrix: {},
        getExplicitConfiguration: () => ({}),
        _queryCallCount: () => queryCallCount,
        _lastQueryContext: () => lastQueryContext
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

describe('PromptRunner._queryMcpForBaseImage', () => {

    describe('CLI override (--base-image)', () => {
        it('should skip MCP query when --base-image CLI flag is provided', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: { values: { baseImage: 'python:3.12-slim' }, choices: { baseImage: ['python:3.12-slim'] }, metadata: { baseImage: [{ image: 'python:3.12-slim' }] } }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({
                cliOptions: { 'base-image': 'custom/image:latest' },
                configManager: cm
            })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({
                cliOptions: { 'base-image': 'custom/image:latest' },
                configManager: cm
            });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
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
=======
            );

            assert.strictEqual(cm._queryCallCount(), 0,
                'MCP query should not be called when --base-image is provided');
            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set');
        });
    });

    describe('MCP server not configured', () => {
        it('should skip when configManager is null', async () => {
            const gen = createMockGenerator({ configManager: null });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined)
        })

        it('should skip when base-image-picker is not in MCP servers', async () => {
            const cm = createMockConfigManager({ mcpServers: ['region-picker'] })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            );

            assert.strictEqual(runner._mcpBaseImageChoices, undefined);
        });

        it('should skip when base-image-picker is not in MCP servers', async () => {
            const cm = createMockConfigManager({ mcpServers: ['region-picker'] });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
            )

            assert.strictEqual(cm._queryCallCount(), 0)
            assert.strictEqual(runner._mcpBaseImageChoices, undefined)
        })
    })
=======
            );

            assert.strictEqual(cm._queryCallCount(), 0);
            assert.strictEqual(runner._mcpBaseImageChoices, undefined);
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

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
<<<<<<< HEAD
            })
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '3.11' }
            })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '3.11' }
            });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
            )

            // Should have prompted for search criteria
            assert.ok(gen._promptCalls().includes('baseImageSearch'),
                'Should prompt for baseImageSearch for non-transformer framework')

            // Should have passed searchCriteria to MCP
            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.context.searchCriteria, '3.11')
        })
=======
            );

            // Should have prompted for search criteria
            assert.ok(gen._promptCalls().includes('baseImageSearch'),
                'Should prompt for baseImageSearch for non-transformer framework');

            // Should have passed searchCriteria to MCP
            const ctx = cm._lastQueryContext();
            assert.strictEqual(ctx.context.searchCriteria, '3.11');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

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
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
<<<<<<< HEAD
            )

            assert.ok(!gen._promptCalls().includes('baseImageSearch'),
                'Should NOT prompt for baseImageSearch for transformer framework')
        })
    })
=======
            );

            assert.ok(!gen._promptCalls().includes('baseImageSearch'),
                'Should NOT prompt for baseImageSearch for transformer framework');
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

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
<<<<<<< HEAD
            ]
=======
            ];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-openai:v0.10.1' },
                    choices: { baseImage: entries.map(e => e.image) },
                    metadata: { baseImage: entries }
                }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
<<<<<<< HEAD
            )

            assert.ok(runner._mcpBaseImageChoices, '_mcpBaseImageChoices should be populated')
            assert.strictEqual(runner._mcpBaseImageChoices.length, 2)
            assert.strictEqual(runner._mcpBaseImageChoices[0].value, 'vllm/vllm-openai:v0.10.1')
            assert.strictEqual(runner._mcpBaseImageChoices[1].value, 'vllm/vllm-openai:v0.9.1')
        })
    })
=======
            );

            assert.ok(runner._mcpBaseImageChoices, '_mcpBaseImageChoices should be populated');
            assert.strictEqual(runner._mcpBaseImageChoices.length, 2);
            assert.strictEqual(runner._mcpBaseImageChoices[0].value, 'vllm/vllm-openai:v0.10.1');
            assert.strictEqual(runner._mcpBaseImageChoices[1].value, 'vllm/vllm-openai:v0.9.1');
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    describe('Fallback behavior', () => {
        it('should not set _mcpBaseImageChoices when MCP returns null', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: null
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
<<<<<<< HEAD
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns null')
        })
=======
            );

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns null');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        it('should not set _mcpBaseImageChoices when MCP returns empty metadata', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: null },
                    choices: { baseImage: [] },
                    metadata: { baseImage: [] }
                }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'unknown-server' },
                {}
<<<<<<< HEAD
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns empty metadata')
        })
=======
            );

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when MCP returns empty metadata');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        it('should not set _mcpBaseImageChoices when MCP result has no metadata field', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.12-slim' },
                    choices: { baseImage: ['python:3.12-slim'] }
                }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
            )

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when metadata is missing')
        })
    })
=======
            );

            assert.strictEqual(runner._mcpBaseImageChoices, undefined,
                '_mcpBaseImageChoices should not be set when metadata is missing');
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    describe('MCP query context', () => {
        it('should pass framework and modelServer in context for transformer', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-openai:v0.10.1' },
                    choices: { baseImage: ['vllm/vllm-openai:v0.10.1'] },
                    metadata: { baseImage: [{ image: 'vllm/vllm-openai:v0.10.1', tag: 'v0.10.1', architecture: 'amd64', created: '2025-01-15T00:00:00Z', labels: { cuda_version: '12.4', python_version: '3.12' }, registry: 'dockerhub', repository: 'vllm/vllm-openai' }] }
                }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({ configManager: cm })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'transformers', modelServer: 'vllm' },
                {}
<<<<<<< HEAD
            )

            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.serverName, 'base-image-picker')
            assert.strictEqual(ctx.context.framework, 'transformers')
            assert.strictEqual(ctx.context.modelServer, 'vllm')
        })
=======
            );

            const ctx = cm._lastQueryContext();
            assert.strictEqual(ctx.serverName, 'base-image-picker');
            assert.strictEqual(ctx.context.framework, 'transformers');
            assert.strictEqual(ctx.context.modelServer, 'vllm');
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        it('should pass framework in context for non-transformer without search', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.12-slim' },
                    choices: { baseImage: ['python:3.12-slim'] },
                    metadata: { baseImage: [{ image: 'python:3.12-slim', tag: '3.12-slim', architecture: 'amd64', created: '2024-10-01T00:00:00Z', labels: { python_version: '3.12' }, registry: 'dockerhub', repository: 'python' }] }
                }
<<<<<<< HEAD
            })
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '' }
            })
            const runner = new PromptRunner(gen)
=======
            });
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '' }
            });
            const runner = new PromptRunner(gen);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask' },
                {}
<<<<<<< HEAD
            )

            const ctx = cm._lastQueryContext()
            assert.strictEqual(ctx.context.framework, 'sklearn')
            assert.strictEqual(ctx.context.modelServer, 'flask')
            assert.strictEqual(ctx.context.searchCriteria, undefined,
                'Empty search should not set searchCriteria')
        })
    })
})
=======
            );

            const ctx = cm._lastQueryContext();
            assert.strictEqual(ctx.context.framework, 'sklearn');
            assert.strictEqual(ctx.context.modelServer, 'flask');
            assert.strictEqual(ctx.context.searchCriteria, undefined,
                'Empty search should not set searchCriteria');
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
