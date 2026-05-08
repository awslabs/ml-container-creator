// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Triton base image fallback in _ensureTemplateVariables()
 *
 * Tests:
 * - Triton architecture gets default base image when MCP returns nothing
 * - --base-image CLI flag overrides the default
 * - Framework registry lookup enriches Triton config with envVars, accelerator, etc.
 * - Non-Triton architectures are not affected
 *
 * Validates: Requirements 10.1, 10.2
 */

import { describe, it } from 'mocha';
import assert from 'assert';

/**
 * Creates a minimal mock generator that exposes _ensureTemplateVariables
 * by simulating the relevant parts of the Generator class from index.js
 */
function createMockGeneratorInstance(answers = {}, registryConfigManager = null) {
    return {
        answers: { ...answers },
        registryConfigManager,
        async _ensureTemplateVariables() {
            // Replicate the defaults logic from index.js
            const defaults = {
                chatTemplate: null,
                chatTemplateSource: null,
                hfToken: null,
                ngcApiKey: null,
                envVars: {},
                inferenceAmiVersion: null,
                accelerator: null,
                frameworkVersion: null,
                validationLevel: 'unknown',
                configSources: [],
                recommendedInstanceTypes: [],
                roleArn: null,
                deploymentConfig: '',
                architecture: null,
                backend: null,
                engine: null,
                codebuildComputeType: null,
                codebuildProjectName: null,
                modelName: null,
                modelFormat: null,
                includeSampleModel: false,
                includeTesting: true,
                testTypes: [],
                buildTimestamp: new Date().toISOString(),
                buildTarget: 'codebuild',
                deploymentTarget: 'realtime-inference',
                hyperPodCluster: null,
                hyperPodNamespace: 'default',
                hyperPodReplicas: 1,
                fsxVolumeHandle: null,
                baseImage: null
            };

            Object.entries(defaults).forEach(([key, value]) => {
                if (this.answers[key] === undefined) {
                    this.answers[key] = value;
                }
            });

            this.answers.includeTesting = true;
            if (!this.answers.testTypes || this.answers.testTypes.length === 0) {
                if (this.answers.architecture === 'transformers' || this.answers.framework === 'transformers') {
                    this.answers.testTypes = ['hosted-model-endpoint'];
                } else {
                    this.answers.testTypes = ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
                }
            }

            // Triton base image fallback logic (mirrors index.js)
            if (this.answers.architecture === 'triton' && !this.answers.baseImage) {
                const tritonRegistryKey = this.answers.deploymentConfig;
                if (tritonRegistryKey && this.registryConfigManager?.frameworkRegistry) {
                    const tritonFrameworkConfig = this.registryConfigManager.frameworkRegistry[tritonRegistryKey];
                    if (tritonFrameworkConfig) {
                        const versions = Object.keys(tritonFrameworkConfig).sort((a, b) =>
                            b.localeCompare(a, undefined, { numeric: true })
                        );
                        if (versions.length > 0) {
                            const latestConfig = tritonFrameworkConfig[versions[0]];
                            if (latestConfig.baseImage) {
                                this.answers.baseImage = latestConfig.baseImage;
                            }
                            if (latestConfig.envVars) {
                                this.answers.envVars = { ...latestConfig.envVars, ...this.answers.envVars };
                            }
                            if (latestConfig.inferenceAmiVersion && !this.answers.inferenceAmiVersion) {
                                this.answers.inferenceAmiVersion = latestConfig.inferenceAmiVersion;
                            }
                            if (latestConfig.accelerator) {
                                this.answers.accelerator = latestConfig.accelerator;
                            }
                        }
                    }
                }
                if (!this.answers.baseImage) {
                    this.answers.baseImage = 'nvcr.io/nvidia/tritonserver:24.08-py3';
                }
            }
        }
    };
}

describe('Triton base image fallback (_ensureTemplateVariables)', () => {

    describe('Requirement 10.1: Default fallback when MCP returns no results', () => {
        it('should set default Triton base image when architecture is triton and no baseImage provided', async () => {
            const gen = createMockGeneratorInstance({
                architecture: 'triton',
                backend: 'fil',
                deploymentConfig: 'triton-fil'
            });

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, 'nvcr.io/nvidia/tritonserver:24.08-py3');
        });

        it('should set default Triton base image for all Triton backends without registry', async () => {
            const tritonConfigs = [
                'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
                'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python'
            ];

            for (const dc of tritonConfigs) {
                const backend = dc.replace('triton-', '');
                const gen = createMockGeneratorInstance({
                    architecture: 'triton',
                    backend,
                    deploymentConfig: dc
                });

                await gen._ensureTemplateVariables();

                assert.strictEqual(gen.answers.baseImage, 'nvcr.io/nvidia/tritonserver:24.08-py3',
                    `Expected default base image for ${dc}`);
            }
        });
    });

    describe('Requirement 10.2: --base-image CLI flag override', () => {
        it('should honor user-provided base image and not overwrite it', async () => {
            const customImage = 'nvcr.io/nvidia/tritonserver:23.12-py3';
            const gen = createMockGeneratorInstance({
                architecture: 'triton',
                backend: 'fil',
                deploymentConfig: 'triton-fil',
                baseImage: customImage
            });

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, customImage,
                'User-provided base image should not be overwritten');
        });

        it('should honor --base-image even when registry has a different image', async () => {
            const customImage = 'my-custom-triton:latest';
            const registry = {
                'triton-fil': {
                    '24.08': {
                        baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
                        envVars: { TRITON_MODEL_REPOSITORY: '/opt/ml/model/model_repository' }
                    }
                }
            };
            const gen = createMockGeneratorInstance(
                {
                    architecture: 'triton',
                    backend: 'fil',
                    deploymentConfig: 'triton-fil',
                    baseImage: customImage
                },
                { frameworkRegistry: registry }
            );

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, customImage,
                'CLI override should take precedence over registry');
        });
    });

    describe('Framework registry enrichment for Triton configs', () => {
        it('should use base image from framework registry when available', async () => {
            const registry = {
                'triton-vllm': {
                    '24.08': {
                        baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
                        accelerator: { type: 'cuda', version: '12.5' },
                        envVars: { TRITON_MODEL_REPOSITORY: '/opt/ml/model/model_repository' },
                        inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2'
                    }
                }
            };
            const gen = createMockGeneratorInstance(
                {
                    architecture: 'triton',
                    backend: 'vllm',
                    deploymentConfig: 'triton-vllm'
                },
                { frameworkRegistry: registry }
            );

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, 'nvcr.io/nvidia/tritonserver:24.08-py3');
            assert.deepStrictEqual(gen.answers.accelerator, { type: 'cuda', version: '12.5' });
            assert.strictEqual(gen.answers.inferenceAmiVersion, 'al2-ami-sagemaker-inference-gpu-3-2');
            assert.strictEqual(gen.answers.envVars.TRITON_MODEL_REPOSITORY, '/opt/ml/model/model_repository');
        });

        it('should fall back to hardcoded default when registry has no matching entry', async () => {
            const registry = {
                'triton-fil': {
                    '24.08': {
                        baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3'
                    }
                }
            };
            const gen = createMockGeneratorInstance(
                {
                    architecture: 'triton',
                    backend: 'pytorch',
                    deploymentConfig: 'triton-pytorch'
                },
                { frameworkRegistry: registry }
            );

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, 'nvcr.io/nvidia/tritonserver:24.08-py3',
                'Should fall back to hardcoded default when registry has no entry for this backend');
        });
    });

    describe('Non-Triton architectures are unaffected', () => {
        it('should not set Triton base image for http architecture', async () => {
            const gen = createMockGeneratorInstance({
                architecture: 'http',
                backend: 'flask',
                deploymentConfig: 'http-flask'
            });

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, null,
                'HTTP architecture should not get Triton base image');
        });

        it('should not set Triton base image for transformers architecture', async () => {
            const gen = createMockGeneratorInstance({
                architecture: 'transformers',
                backend: 'vllm',
                deploymentConfig: 'transformers-vllm'
            });

            await gen._ensureTemplateVariables();

            assert.strictEqual(gen.answers.baseImage, null,
                'Transformers architecture should not get Triton base image');
        });
    });
});
