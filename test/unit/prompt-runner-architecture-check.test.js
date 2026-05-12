// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for _checkModelArchitectureCompatibility
 *
 * Tests:
 * - Warning emitted when model_type is not in supportedModelTypes
 * - No warning when model_type is in supportedModelTypes
 * - Silent skip when supportedModelTypes is empty (sync not run)
 * - Silent skip when no model_type is set
 * - Silent skip when custom image is selected
 * - Silent skip when catalog can't be read
 *
 * Feature: model-architecture-validation
 * Validates: Requirements 4.2, 4.3, 4.4, 4.5
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import PromptRunner from '../../src/lib/prompt-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.resolve(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');

/**
 * Creates a PromptRunner instance with minimal config for testing
 */
function createRunner() {
    return new PromptRunner({
        configManager: null,
        options: {},
        registryConfigManager: null,
        baseConfig: {},
        promptFn: async () => ({})
    });
}

/**
 * Captures console.log output during a function call
 */
function captureConsoleLog(fn) {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        fn();
    } finally {
        console.log = originalLog;
    }
    return logs;
}

describe('PromptRunner._checkModelArchitectureCompatibility', () => {
    let originalCatalog;
    let catalogExists;

    beforeEach(() => {
        // Read the real catalog to restore later
        try {
            originalCatalog = fs.readFileSync(CATALOG_PATH, 'utf8');
            catalogExists = true;
        } catch {
            catalogExists = false;
        }
    });

    afterEach(() => {
        // Restore original catalog if it was modified
        if (catalogExists && originalCatalog) {
            fs.writeFileSync(CATALOG_PATH, originalCatalog);
        }
    });

    describe('Warning emission (Requirement 4.3)', () => {
        it('should emit warning when model_type is NOT in supportedModelTypes', () => {
            // Set up catalog with supportedModelTypes that does NOT include our model_type
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama', 'mistral', 'gemma'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen3_5';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm', backend: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            const warningLog = logs.join('\n');
            assert.ok(warningLog.includes('⚠️'), 'Should emit a warning symbol');
            assert.ok(warningLog.includes('qwen3_5'), 'Should include the model_type in warning');
            assert.ok(warningLog.includes('vllm'), 'Should include the server name in warning');
            assert.ok(warningLog.includes('Consider upgrading'), 'Should include upgrade suggestion');
        });

        it('should include server docs URL in warning', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama', 'mistral'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen2';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            const warningLog = logs.join('\n');
            assert.ok(warningLog.includes('https://docs.vllm.ai'), 'Should include vLLM docs URL');
        });

        it('should NOT block generation — warning is advisory only (Requirement 4.4)', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'unknown_arch';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            // Should not throw — advisory only
            assert.doesNotThrow(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });
        });
    });

    describe('No warning when compatible (Requirement 4.2)', () => {
        it('should NOT emit warning when model_type IS in supportedModelTypes', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama', 'mistral', 'qwen2'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen2';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should not emit any warning when model_type is supported');
        });

        it('should compare model_type case-insensitively', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama', 'qwen2'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'Qwen2';  // uppercase
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should not warn when model_type matches case-insensitively');
        });
    });

    describe('Silent skip conditions (Requirement 4.5)', () => {
        it('should skip silently when supportedModelTypes is empty (sync not run)', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = [];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen3_5';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when supportedModelTypes is empty');
        });

        it('should skip silently when supportedModelTypes is absent', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                delete catalog.vllm[0].supportedModelTypes;
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen3_5';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when supportedModelTypes is absent');
        });

        it('should skip silently when no model_type is set', () => {
            const runner = createRunner();
            runner._modelType = null;
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: 'vllm/vllm-openai:v0.10.1', _meta: { labels: {} } }
            ];

            const baseImageAnswers = { baseImage: 'vllm/vllm-openai:v0.10.1' };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when _modelType is null');
        });

        it('should skip silently when custom image is selected', () => {
            const runner = createRunner();
            runner._modelType = 'llama';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: 'vllm/vllm-openai:v0.10.1', _meta: { labels: {} } }
            ];

            const baseImageAnswers = { baseImage: 'custom' };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when custom image is selected');
        });

        it('should skip silently when _mcpBaseImageChoices is not set', () => {
            const runner = createRunner();
            runner._modelType = 'llama';
            runner._mcpBaseImageChoices = undefined;

            const baseImageAnswers = { baseImage: 'vllm/vllm-openai:v0.10.1' };
            const frameworkAnswers = { modelServer: 'vllm' };

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when _mcpBaseImageChoices is undefined');
        });

        it('should skip silently when no server name is available', () => {
            const runner = createRunner();
            runner._modelType = 'llama';
            runner._mcpBaseImageChoices = [
                { name: 'some image', value: 'some/image:v1', _meta: { labels: {} } }
            ];

            const baseImageAnswers = { baseImage: 'some/image:v1' };
            const frameworkAnswers = {};  // no modelServer or backend

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            assert.strictEqual(logs.length, 0, 'Should skip silently when no server name is available');
        });
    });

    describe('Server-specific docs URLs', () => {
        it('should use sglang docs URL for sglang server', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.sglang && catalog.sglang.length > 0) {
                catalog.sglang[0].supportedModelTypes = ['llama'];
                fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

                const runner = createRunner();
                runner._modelType = 'unknown_model';
                runner._mcpBaseImageChoices = [
                    { name: 'sglang image', value: catalog.sglang[0].image, _meta: { labels: catalog.sglang[0].labels } }
                ];

                const baseImageAnswers = { baseImage: catalog.sglang[0].image };
                const frameworkAnswers = { modelServer: 'sglang' };

                const logs = captureConsoleLog(() => {
                    runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
                });

                const warningLog = logs.join('\n');
                assert.ok(warningLog.includes('sgl-project.github.io'), 'Should include SGLang docs URL');
            }
        });
    });

    describe('Backend fallback', () => {
        it('should use backend when modelServer is not set', () => {
            const catalog = JSON.parse(originalCatalog);
            if (catalog.vllm && catalog.vllm.length > 0) {
                catalog.vllm[0].supportedModelTypes = ['llama'];
            }
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 4));

            const runner = createRunner();
            runner._modelType = 'qwen2';
            runner._mcpBaseImageChoices = [
                { name: 'vllm/vllm-openai v0.10.1', value: catalog.vllm[0].image, _meta: { labels: catalog.vllm[0].labels } }
            ];

            const baseImageAnswers = { baseImage: catalog.vllm[0].image };
            const frameworkAnswers = { backend: 'vllm' };  // using backend instead of modelServer

            const logs = captureConsoleLog(() => {
                runner._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);
            });

            const warningLog = logs.join('\n');
            assert.ok(warningLog.includes('⚠️'), 'Should emit warning using backend as server name');
            assert.ok(warningLog.includes('qwen2'), 'Should include model_type');
        });
    });
});
