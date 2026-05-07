// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration System Tests
 * 
 * Consolidated tests for configuration management, matching, and precedence.
 * 
 * Requirements: 1.7, 2.1, 2.2, 2.3, 4.1, 4.2, 5.9
 * 
 * Consolidates:
 * - configuration-manager.test.js
 * - configuration-matcher.test.js
 * - configuration-files.test.js
 * - configuration-precedence.test.js
 * - configuration-export.test.js
 */

import { setupTestHooks } from './test-utils.js';
import assert from 'assert';
import ConfigurationManager from '../../src/lib/configuration-manager.js';
import ConfigurationMatcher from '../../src/lib/configuration-matcher.js';

describe('Configuration System', () => {
    setupTestHooks('Configuration System');

    describe('ConfigurationManager', () => {
        let configManager;

        beforeEach(() => {
            configManager = new ConfigurationManager({ offline: true });
        });

        it('should load all registries successfully', async () => {
            await configManager.loadRegistries();
            
            assert.ok(configManager.frameworkRegistry !== null);
            assert.ok(configManager.modelRegistry !== null);
            assert.ok(configManager.instanceMapping !== null);
            assert.ok(configManager.configMatcher !== null);
        });

        it('should handle missing registries gracefully', async () => {
            await configManager.loadRegistries();
            
            assert.strictEqual(typeof configManager.frameworkRegistry, 'object');
            assert.strictEqual(typeof configManager.modelRegistry, 'object');
            assert.strictEqual(typeof configManager.instanceMapping, 'object');
        });

        it('should match framework configuration', async () => {
            configManager.frameworkRegistry = {
                'vllm': {
                    '0.3.0': {
                        baseImage: 'vllm:0.3.0',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: { VLLM_VERSION: '0.3.0' },
                        inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    }
                }
            };
            
            configManager.modelRegistry = {};
            configManager.instanceMapping = {};
            
            const ConfigMatcher = (await import('../../src/lib/configuration-matcher.js')).default;
            configManager.configMatcher = new ConfigMatcher(
                configManager.frameworkRegistry,
                configManager.modelRegistry
            );

            const result = await configManager.matchConfiguration({
                framework: 'vllm',
                version: '0.3.0'
            });
            
            assert.ok(result !== null);
            assert.strictEqual(result.framework, 'vllm');
            assert.strictEqual(result.version, '0.3.0');
            assert.strictEqual(result.baseImage, 'vllm:0.3.0');
        });
    });

    describe('ConfigurationMatcher', () => {
        it('should find exact version match', () => {
            const registry = {
                'vllm': {
                    '0.3.0': {
                        baseImage: 'vllm:0.3.0',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    }
                }
            };
            
            const matcher = new ConfigurationMatcher(registry, {});
            const result = matcher.matchFramework('vllm', '0.3.0');
            
            assert.ok(result !== null);
            assert.strictEqual(result.matchType, 'exact');
            assert.strictEqual(result.matchedVersion, '0.3.0');
            assert.strictEqual(result.baseImage, 'vllm:0.3.0');
        });

        it('should find closest version when no exact match', () => {
            const registry = {
                'vllm': {
                    '0.2.0': {
                        baseImage: 'vllm:0.2.0',
                        accelerator: { type: 'cuda', version: '11.8' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    },
                    '0.4.0': {
                        baseImage: 'vllm:0.4.0',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    }
                }
            };
            
            const matcher = new ConfigurationMatcher(registry, {});
            const result = matcher.matchFramework('vllm', '0.3.0');
            
            assert.ok(result !== null);
            assert.strictEqual(result.matchType, 'fuzzy');
            assert.strictEqual(result.requestedVersion, '0.3.0');
            assert.ok(['0.2.0', '0.4.0'].includes(result.matchedVersion));
        });

        it('should return null for unknown framework', () => {
            const registry = {
                'vllm': {
                    '0.3.0': {
                        baseImage: 'vllm:0.3.0',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    }
                }
            };
            
            const matcher = new ConfigurationMatcher(registry, {});
            const result = matcher.matchFramework('unknown-framework', '1.0.0');
            
            assert.strictEqual(result, null);
        });

        it('should return null for empty registry', () => {
            const matcher = new ConfigurationMatcher({}, {});
            const result = matcher.matchFramework('vllm', '0.3.0');
            
            assert.strictEqual(result, null);
        });

        it('should match model by exact ID', () => {
            const modelRegistry = {
                'meta-llama/Llama-2-7b-chat-hf': {
                    family: 'llama-2',
                    chatTemplate: '{% for message in messages %}...',
                    requiresTemplate: true,
                    validationLevel: 'tested',
                    frameworkCompatibility: {}
                }
            };
            
            const matcher = new ConfigurationMatcher({}, modelRegistry);
            const result = matcher.matchModel('meta-llama/Llama-2-7b-chat-hf');
            
            assert.ok(result !== null);
            assert.strictEqual(result.matchType, 'exact');
            assert.strictEqual(result.family, 'llama-2');
        });

        it('should match model by pattern', () => {
            const modelRegistry = {
                'meta-llama/*': {
                    family: 'llama',
                    chatTemplate: '{% for message in messages %}...',
                    requiresTemplate: true,
                    validationLevel: 'community',
                    frameworkCompatibility: {}
                }
            };
            
            const matcher = new ConfigurationMatcher({}, modelRegistry);
            const result = matcher.matchModel('meta-llama/Llama-3-8b-instruct');
            
            assert.ok(result !== null);
            assert.strictEqual(result.matchType, 'pattern');
            assert.strictEqual(result.family, 'llama');
        });
    });

    describe('Configuration Precedence', () => {
        it('should prioritize exact matches over patterns', () => {
            const modelRegistry = {
                'meta-llama/Llama-2-7b-chat-hf': {
                    family: 'llama-2',
                    validationLevel: 'tested'
                },
                'meta-llama/*': {
                    family: 'llama',
                    validationLevel: 'community'
                }
            };
            
            const matcher = new ConfigurationMatcher({}, modelRegistry);
            const result = matcher.matchModel('meta-llama/Llama-2-7b-chat-hf');
            
            assert.strictEqual(result.matchType, 'exact');
            assert.strictEqual(result.validationLevel, 'tested');
        });

        it('should prioritize tested over community validation levels', () => {
            const registry = {
                'vllm': {
                    '0.3.0': {
                        baseImage: 'vllm:0.3.0',
                        validationLevel: 'tested',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge']
                    },
                    '0.3.1': {
                        baseImage: 'vllm:0.3.1',
                        validationLevel: 'community',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: {},
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge']
                    }
                }
            };
            
            const matcher = new ConfigurationMatcher(registry, {});
            
            // When both versions are close, should prefer tested
            const result = matcher.matchFramework('vllm', '0.3.0');
            assert.strictEqual(result.validationLevel, 'tested');
        });
    });

    describe('Configuration Export', () => {
        it('should export configuration with all required fields', async () => {
            const configManager = new ConfigurationManager({ offline: true });
            
            configManager.frameworkRegistry = {
                'vllm': {
                    '0.3.0': {
                        baseImage: 'vllm:0.3.0',
                        accelerator: { type: 'cuda', version: '12.1' },
                        envVars: { VLLM_VERSION: '0.3.0' },
                        inferenceAmiVersion: 'al2-ami-test',
                        recommendedInstanceTypes: ['ml.g5.xlarge'],
                        validationLevel: 'tested'
                    }
                }
            };
            
            const ConfigMatcher = (await import('../../src/lib/configuration-matcher.js')).default;
            configManager.configMatcher = new ConfigMatcher(
                configManager.frameworkRegistry,
                {}
            );

            const result = await configManager.matchConfiguration({
                framework: 'vllm',
                version: '0.3.0'
            });
            
            assert.ok(result.baseImage);
            assert.ok(result.accelerator);
            assert.ok(result.envVars);
            assert.ok(result.validationLevel);
        });
    });
});
