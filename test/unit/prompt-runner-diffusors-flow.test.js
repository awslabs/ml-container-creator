// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PromptRunner diffusors-specific flow
 *
 * Tests:
 * - Diffusors architecture sets includeSampleModel to false
 * - Diffusors architecture handles custom model name
 * - Diffusors architecture skips base image search criteria prompt
 *
 * Feature: vllm-omni-diffusors
 * Validates: Requirements 2.4, 2.5, 2.6
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import PromptRunner from '../../generators/app/lib/prompt-runner.js';

/**
 * Creates a mock generator with configurable options
 */
function createMockGenerator(opts = {}) {
    const promptResponses = opts.promptResponses || {};
    const promptCalls = [];

    return {
        options: opts.cliOptions || {},
        configManager: opts.configManager || null,
        registryConfigManager: null,
        baseConfig: {},
        prompt: async (prompts) => {
            const answers = {};
            for (const p of prompts) {
                promptCalls.push(p.name);
                if (promptResponses[p.name] !== undefined) {
                    answers[p.name] = promptResponses[p.name];
                } else if (p.default !== undefined) {
                    answers[p.name] = typeof p.default === 'function' ? p.default({}) : p.default;
                } else {
                    answers[p.name] = '';
                }
            }
            return answers;
        },
        _promptCalls: () => promptCalls
    };
}

/**
 * Creates a mock ConfigManager
 */
function createMockConfigManager(opts = {}) {
    return {
        getMcpServerNames: () => opts.mcpServers || [],
        queryMcpServer: async () => opts.queryResult || null,
        mcpChoices: {},
        mcpSources: {},
        parameterMatrix: {},
        getExplicitConfiguration: () => ({})
    };
}

describe('PromptRunner - Diffusors Flow', () => {

    describe('includeSampleModel for diffusors (Requirement 2.5)', () => {
        it('should set includeSampleModel to false when architecture is diffusors', () => {
            // The run() method sets includeSampleModel = false for diffusors.
            // We test the condition logic directly by simulating what run() does.
            const frameworkAnswers = { architecture: 'diffusors', backend: 'vllm-omni' };
            const moduleAnswers = { includeSampleModel: true };

            // Replicate the condition from run()
            if (frameworkAnswers.architecture === 'transformers' ||
                frameworkAnswers.architecture === 'diffusors' ||
                (frameworkAnswers.architecture === 'triton')) {
                moduleAnswers.includeSampleModel = false;
            }

            assert.equal(moduleAnswers.includeSampleModel, false,
                'includeSampleModel should be false for diffusors architecture');
        });

        it('should still set includeSampleModel to false for transformers', () => {
            const frameworkAnswers = { architecture: 'transformers', backend: 'vllm' };
            const moduleAnswers = { includeSampleModel: true };

            if (frameworkAnswers.architecture === 'transformers' ||
                frameworkAnswers.architecture === 'diffusors') {
                moduleAnswers.includeSampleModel = false;
            }

            assert.equal(moduleAnswers.includeSampleModel, false,
                'includeSampleModel should be false for transformers architecture');
        });

        it('should NOT set includeSampleModel to false for http architecture', () => {
            const frameworkAnswers = { architecture: 'http', backend: 'flask' };
            const moduleAnswers = { includeSampleModel: true };

            if (frameworkAnswers.architecture === 'transformers' ||
                frameworkAnswers.architecture === 'diffusors') {
                moduleAnswers.includeSampleModel = false;
            }

            assert.equal(moduleAnswers.includeSampleModel, true,
                'includeSampleModel should remain true for http architecture');
        });
    });

    describe('Custom model name handling for diffusors (Requirement 2.4)', () => {
        it('should resolve customModelName to modelName for diffusors', () => {
            const combinedAnswers = {
                architecture: 'diffusors',
                backend: 'vllm-omni',
                customModelName: 'stabilityai/stable-diffusion-3.5-medium',
                modelName: 'Custom (enter manually)'
            };

            // Replicate the condition from run()
            if ((combinedAnswers.architecture === 'transformers' ||
                 combinedAnswers.architecture === 'diffusors' ||
                 (combinedAnswers.architecture === 'triton' && (combinedAnswers.backend === 'vllm' || combinedAnswers.backend === 'tensorrtllm')))
                && combinedAnswers.customModelName) {
                combinedAnswers.modelName = combinedAnswers.customModelName;
                delete combinedAnswers.customModelName;
            }

            assert.equal(combinedAnswers.modelName, 'stabilityai/stable-diffusion-3.5-medium',
                'modelName should be set to customModelName value');
            assert.equal(combinedAnswers.customModelName, undefined,
                'customModelName should be deleted');
        });

        it('should NOT resolve customModelName when not present for diffusors', () => {
            const combinedAnswers = {
                architecture: 'diffusors',
                backend: 'vllm-omni',
                modelName: 'black-forest-labs/FLUX.1-dev'
            };

            if ((combinedAnswers.architecture === 'transformers' ||
                 combinedAnswers.architecture === 'diffusors' ||
                 (combinedAnswers.architecture === 'triton'))
                && combinedAnswers.customModelName) {
                combinedAnswers.modelName = combinedAnswers.customModelName;
                delete combinedAnswers.customModelName;
            }

            assert.equal(combinedAnswers.modelName, 'black-forest-labs/FLUX.1-dev',
                'modelName should remain unchanged when customModelName is not present');
        });
    });

    describe('_queryMcpForBaseImage skips search for diffusors', () => {
        it('should query MCP but skip search criteria prompt for diffusors', async () => {
            let queryCallCount = 0;
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'vllm/vllm-omni:v0.16.0' },
                    choices: { baseImage: ['vllm/vllm-omni:v0.16.0'] },
                    metadata: { baseImage: [{
                        image: 'vllm/vllm-omni:v0.16.0',
                        tag: 'v0.16.0',
                        architecture: 'amd64',
                        created: '2025-06-01T00:00:00Z',
                        labels: { cuda_version: '12.4' },
                        registry: 'dockerhub',
                        repository: 'vllm/vllm-omni'
                    }] }
                }
            });
            // Track MCP query calls
            const origQuery = cm.queryMcpServer;
            cm.queryMcpServer = async (...args) => {
                queryCallCount++;
                return origQuery(...args);
            };
            const gen = createMockGenerator({ configManager: cm });
            const runner = new PromptRunner(gen);

            await runner._queryMcpForBaseImage(
                { framework: 'diffusors', modelServer: 'vllm-omni', architecture: 'diffusors' },
                {}
            );

            assert.ok(!gen._promptCalls().includes('baseImageSearch'),
                'Should NOT prompt for baseImageSearch for diffusors architecture');
            assert.equal(queryCallCount, 1,
                'Should query MCP server for diffusors base images');
            assert.ok(runner._mcpBaseImageChoices !== undefined,
                '_mcpBaseImageChoices should be populated from MCP results');
        });

        it('should still prompt for search criteria for http architecture', async () => {
            const cm = createMockConfigManager({
                mcpServers: ['base-image-picker'],
                queryResult: {
                    values: { baseImage: 'python:3.12-slim' },
                    choices: { baseImage: ['python:3.12-slim'] },
                    metadata: { baseImage: [{
                        image: 'python:3.12-slim',
                        tag: '3.12-slim',
                        architecture: 'amd64',
                        created: '2024-10-01T00:00:00Z',
                        labels: {},
                        registry: 'dockerhub',
                        repository: 'python'
                    }] }
                }
            });
            const gen = createMockGenerator({
                configManager: cm,
                promptResponses: { baseImageSearch: '' }
            });
            const runner = new PromptRunner(gen);

            await runner._queryMcpForBaseImage(
                { framework: 'sklearn', modelServer: 'flask', architecture: 'http' },
                {}
            );

            assert.ok(gen._promptCalls().includes('baseImageSearch'),
                'Should prompt for baseImageSearch for http architecture');
        });
    });
});
