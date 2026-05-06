// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ConfigManager CLI Params Integration Tests
 *
 * Tests for the new CLI configuration parameters:
 * - Parameter_Matrix structure for endpoint and iC parameters (Requirements 1.6, 2.7)
 * - Config file nested object parsing (Requirements 9.1, 9.2, 9.5)
 * - Validation layer API shape from getFullConfiguration() (Requirements 8.4)
 * - do/config summary output (Requirements 7.6)
 */

import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'assert'
import ConfigManager from '../../generators/app/lib/config-manager.js'
import {
    createMockGenerator,
    createMockGeneratorWithOptions,
    cleanupEnvVars
} from '../helpers/mock-generator.js'

describe('ConfigManager CLI Params Integration', () => {
    let configManager
    let mockGenerator
    let envVarsToCleanup = []

    afterEach(() => {
        cleanupEnvVars(envVarsToCleanup)
        envVarsToCleanup = []
    })

    describe('Parameter_Matrix structure (Requirements 1.6, 2.7)', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator()
            configManager = new ConfigManager(mockGenerator)
        })

        it('should define endpointInitialInstanceCount in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.endpointInitialInstanceCount)
            assert.strictEqual(matrix.endpointInitialInstanceCount.cliOption, 'endpoint-initial-instance-count')
            assert.strictEqual(matrix.endpointInitialInstanceCount.configFile, true)
            assert.strictEqual(matrix.endpointInitialInstanceCount.required, false)
            assert.strictEqual(matrix.endpointInitialInstanceCount.schemaValidated, true)
            assert.strictEqual(matrix.endpointInitialInstanceCount.default, 1)
        })

        it('should define endpointDataCapturePercent in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.endpointDataCapturePercent)
            assert.strictEqual(matrix.endpointDataCapturePercent.cliOption, 'endpoint-data-capture-percent')
            assert.strictEqual(matrix.endpointDataCapturePercent.configFile, true)
            assert.strictEqual(matrix.endpointDataCapturePercent.required, false)
            assert.strictEqual(matrix.endpointDataCapturePercent.schemaValidated, true)
            assert.strictEqual(matrix.endpointDataCapturePercent.default, 0)
        })

        it('should define endpointVariantName in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.endpointVariantName)
            assert.strictEqual(matrix.endpointVariantName.cliOption, 'endpoint-variant-name')
            assert.strictEqual(matrix.endpointVariantName.configFile, true)
            assert.strictEqual(matrix.endpointVariantName.required, false)
            assert.strictEqual(matrix.endpointVariantName.schemaValidated, true)
            assert.strictEqual(matrix.endpointVariantName.default, 'AllTraffic')
        })

        it('should define endpointVolumeSize in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.endpointVolumeSize)
            assert.strictEqual(matrix.endpointVolumeSize.cliOption, 'endpoint-volume-size')
            assert.strictEqual(matrix.endpointVolumeSize.configFile, true)
            assert.strictEqual(matrix.endpointVolumeSize.required, false)
            assert.strictEqual(matrix.endpointVolumeSize.schemaValidated, true)
            assert.strictEqual(matrix.endpointVolumeSize.default, null)
        })

        it('should define icCpuCount in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.icCpuCount)
            assert.strictEqual(matrix.icCpuCount.cliOption, 'ic-cpu-count')
            assert.strictEqual(matrix.icCpuCount.configFile, true)
            assert.strictEqual(matrix.icCpuCount.required, false)
            assert.strictEqual(matrix.icCpuCount.schemaValidated, true)
            assert.strictEqual(matrix.icCpuCount.default, null)
        })

        it('should define icMemorySize in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.icMemorySize)
            assert.strictEqual(matrix.icMemorySize.cliOption, 'ic-memory-size')
            assert.strictEqual(matrix.icMemorySize.configFile, true)
            assert.strictEqual(matrix.icMemorySize.required, false)
            assert.strictEqual(matrix.icMemorySize.schemaValidated, true)
            assert.strictEqual(matrix.icMemorySize.default, null)
        })

        it('should define icGpuCount in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.icGpuCount)
            assert.strictEqual(matrix.icGpuCount.cliOption, 'ic-gpu-count')
            assert.strictEqual(matrix.icGpuCount.configFile, true)
            assert.strictEqual(matrix.icGpuCount.required, false)
            assert.strictEqual(matrix.icGpuCount.schemaValidated, true)
            assert.strictEqual(matrix.icGpuCount.default, null)
        })

        it('should define icCopyCount in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.icCopyCount)
            assert.strictEqual(matrix.icCopyCount.cliOption, 'ic-copy-count')
            assert.strictEqual(matrix.icCopyCount.configFile, true)
            assert.strictEqual(matrix.icCopyCount.required, false)
            assert.strictEqual(matrix.icCopyCount.schemaValidated, true)
            assert.strictEqual(matrix.icCopyCount.default, 1)
        })

        it('should define icModelWeight in the parameter matrix', () => {
            const matrix = configManager.parameterMatrix
            assert.ok(matrix.icModelWeight)
            assert.strictEqual(matrix.icModelWeight.cliOption, 'ic-model-weight')
            assert.strictEqual(matrix.icModelWeight.configFile, true)
            assert.strictEqual(matrix.icModelWeight.required, false)
            assert.strictEqual(matrix.icModelWeight.schemaValidated, true)
            assert.strictEqual(matrix.icModelWeight.default, 1.0)
        })

        it('should mark all endpoint/iC parameters as not promptable', () => {
            const matrix = configManager.parameterMatrix
            const params = [
                'endpointInitialInstanceCount',
                'endpointDataCapturePercent',
                'endpointVariantName',
                'endpointVolumeSize',
                'icCpuCount',
                'icMemorySize',
                'icGpuCount',
                'icCopyCount',
                'icModelWeight'
            ]
            for (const param of params) {
                assert.strictEqual(matrix[param].promptable, false,
                    `${param} should not be promptable`)
            }
        })
    })

    describe('Config file nested object parsing (Requirements 9.1, 9.2, 9.5)', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator()
            configManager = new ConfigManager(mockGenerator)
        })

        it('should parse endpointConfig nested object from config file', async () => {
            await configManager.loadConfiguration()

            // Simulate applying a JSON config with nested endpointConfig
            configManager._applyJsonConfig({
                endpointConfig: {
                    initialInstanceCount: 3,
                    dataCapturePercent: 25,
                    variantName: 'primary',
                    volumeSize: 200
                }
            })

            assert.strictEqual(configManager.config.endpointInitialInstanceCount, 3)
            assert.strictEqual(configManager.config.endpointDataCapturePercent, 25)
            assert.strictEqual(configManager.config.endpointVariantName, 'primary')
            assert.strictEqual(configManager.config.endpointVolumeSize, 200)
        })

        it('should parse icConfig nested object from config file', async () => {
            await configManager.loadConfiguration()

            configManager._applyJsonConfig({
                icConfig: {
                    cpuCount: 8,
                    memorySize: 16384,
                    gpuCount: 2,
                    copyCount: 3,
                    modelWeight: 0.75
                }
            })

            assert.strictEqual(configManager.config.icCpuCount, 8)
            assert.strictEqual(configManager.config.icMemorySize, 16384)
            assert.strictEqual(configManager.config.icGpuCount, 2)
            assert.strictEqual(configManager.config.icCopyCount, 3)
            assert.strictEqual(configManager.config.icModelWeight, 0.75)
        })

        it('should parse modelEnvVars from config file', async () => {
            await configManager.loadConfiguration()

            configManager._applyJsonConfig({
                modelEnvVars: {
                    HF_MODEL_ID: 'meta-llama/Llama-2-7b-chat-hf',
                    QUANTIZATION: 'awq'
                }
            })

            assert.strictEqual(configManager.config.modelEnvVars.HF_MODEL_ID, 'meta-llama/Llama-2-7b-chat-hf')
            assert.strictEqual(configManager.config.modelEnvVars.QUANTIZATION, 'awq')
        })

        it('should parse serverEnvVars from config file', async () => {
            await configManager.loadConfiguration()

            configManager._applyJsonConfig({
                serverEnvVars: {
                    TENSOR_PARALLEL_SIZE: '4',
                    MAX_MODEL_LEN: '4096'
                }
            })

            assert.strictEqual(configManager.config.serverEnvVars.TENSOR_PARALLEL_SIZE, '4')
            assert.strictEqual(configManager.config.serverEnvVars.MAX_MODEL_LEN, '4096')
        })

        it('should give CLI precedence over config file for modelEnvVars', async () => {
            // Set up CLI options with model-env
            mockGenerator = createMockGeneratorWithOptions({
                'model-env': 'HF_MODEL_ID=cli-model'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            // Now apply config file with overlapping key
            configManager._applyJsonConfig({
                modelEnvVars: {
                    HF_MODEL_ID: 'config-file-model',
                    EXTRA_KEY: 'extra-value'
                }
            })

            // CLI value should win for overlapping key
            assert.strictEqual(configManager.config.modelEnvVars.HF_MODEL_ID, 'cli-model')
            // Non-overlapping key from config file should be present
            assert.strictEqual(configManager.config.modelEnvVars.EXTRA_KEY, 'extra-value')
        })

        it('should give CLI precedence over config file for serverEnvVars', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'server-env': 'TENSOR_PARALLEL_SIZE=8'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            configManager._applyJsonConfig({
                serverEnvVars: {
                    TENSOR_PARALLEL_SIZE: '2',
                    MAX_BATCH_SIZE: '64'
                }
            })

            assert.strictEqual(configManager.config.serverEnvVars.TENSOR_PARALLEL_SIZE, '8')
            assert.strictEqual(configManager.config.serverEnvVars.MAX_BATCH_SIZE, '64')
        })

        it('should handle combined endpointConfig and icConfig in same config', async () => {
            await configManager.loadConfiguration()

            configManager._applyJsonConfig({
                endpointConfig: {
                    initialInstanceCount: 2,
                    volumeSize: 100
                },
                icConfig: {
                    cpuCount: 4,
                    gpuCount: 1
                }
            })

            assert.strictEqual(configManager.config.endpointInitialInstanceCount, 2)
            assert.strictEqual(configManager.config.endpointVolumeSize, 100)
            assert.strictEqual(configManager.config.icCpuCount, 4)
            assert.strictEqual(configManager.config.icGpuCount, 1)
        })
    })

    describe('Validation layer API shape - getFullConfiguration() (Requirements 8.4)', () => {
        beforeEach(async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'endpoint-initial-instance-count': 2,
                'endpoint-data-capture-percent': 15,
                'endpoint-variant-name': 'primary',
                'endpoint-volume-size': 100,
                'ic-cpu-count': 4,
                'ic-memory-size': 8192,
                'ic-gpu-count': 1,
                'ic-copy-count': 2,
                'ic-model-weight': 0.8,
                'model-env': 'HF_MODEL_ID=test-model',
                'server-env': 'TENSOR_PARALLEL_SIZE=4'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()
        })

        it('should return an object with core, endpointConfig, icConfig, modelEnvVars, serverEnvVars, and manifest', () => {
            const full = configManager.getFullConfiguration()

            assert.ok(full.core, 'should have core collection')
            assert.ok(full.endpointConfig, 'should have endpointConfig collection')
            assert.ok(full.icConfig, 'should have icConfig collection')
            assert.ok(full.modelEnvVars, 'should have modelEnvVars collection')
            assert.ok(full.serverEnvVars, 'should have serverEnvVars collection')
            assert.ok(Array.isArray(full.manifest), 'should have manifest array')
        })

        it('should separate endpoint parameters into endpointConfig', () => {
            const full = configManager.getFullConfiguration()

            assert.strictEqual(full.endpointConfig.initialInstanceCount, 2)
            assert.strictEqual(full.endpointConfig.dataCapturePercent, 15)
            assert.strictEqual(full.endpointConfig.variantName, 'primary')
            assert.strictEqual(full.endpointConfig.volumeSize, 100)
        })

        it('should separate iC parameters into icConfig', () => {
            const full = configManager.getFullConfiguration()

            assert.strictEqual(full.icConfig.cpuCount, 4)
            assert.strictEqual(full.icConfig.memorySize, 8192)
            assert.strictEqual(full.icConfig.gpuCount, 1)
            assert.strictEqual(full.icConfig.copyCount, 2)
            assert.strictEqual(full.icConfig.modelWeight, 0.8)
        })

        it('should include modelEnvVars as a separate collection', () => {
            const full = configManager.getFullConfiguration()

            assert.strictEqual(full.modelEnvVars.HF_MODEL_ID, 'test-model')
        })

        it('should include serverEnvVars as a separate collection', () => {
            const full = configManager.getFullConfiguration()

            assert.strictEqual(full.serverEnvVars.TENSOR_PARALLEL_SIZE, '4')
        })

        it('should not include endpoint/iC/env params in core collection', () => {
            const full = configManager.getFullConfiguration()

            assert.strictEqual(full.core.endpointInitialInstanceCount, undefined)
            assert.strictEqual(full.core.endpointDataCapturePercent, undefined)
            assert.strictEqual(full.core.icCpuCount, undefined)
            assert.strictEqual(full.core.icMemorySize, undefined)
            assert.strictEqual(full.core.modelEnvVars, undefined)
            assert.strictEqual(full.core.serverEnvVars, undefined)
        })

        it('should include source manifest with entries for CLI-provided params', () => {
            const full = configManager.getFullConfiguration()

            const endpointEntry = full.manifest.find(e => e.param === 'endpointInitialInstanceCount')
            assert.ok(endpointEntry, 'should have manifest entry for endpointInitialInstanceCount')
            assert.strictEqual(endpointEntry.value, 2)
            assert.strictEqual(endpointEntry.source, 'cli')

            const modelEnvEntry = full.manifest.find(e => e.param === 'modelEnvVars.HF_MODEL_ID')
            assert.ok(modelEnvEntry, 'should have manifest entry for modelEnvVars.HF_MODEL_ID')
            assert.strictEqual(modelEnvEntry.value, 'test-model')
            assert.strictEqual(modelEnvEntry.source, 'cli')
        })

        it('should omit null endpoint/iC params from their collections', async () => {
            // Create a config manager with no endpoint/iC params
            const emptyMock = createMockGenerator()
            const emptyConfigManager = new ConfigManager(emptyMock)
            await emptyConfigManager.loadConfiguration()

            const full = emptyConfigManager.getFullConfiguration()

            // endpointVolumeSize defaults to null, should not appear
            assert.strictEqual(full.endpointConfig.volumeSize, undefined)
            // icCpuCount defaults to null, should not appear
            assert.strictEqual(full.icConfig.cpuCount, undefined)
        })
    })

    describe('do/config summary output (Requirements 7.6)', () => {
        it('should include endpoint parameters in getFinalConfiguration for template rendering', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'endpoint-initial-instance-count': 3,
                'endpoint-volume-size': 200,
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            assert.strictEqual(finalConfig.endpointInitialInstanceCount, 3)
            assert.strictEqual(finalConfig.endpointVolumeSize, 200)
        })

        it('should include iC parameters in getFinalConfiguration for template rendering', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'ic-cpu-count': 8,
                'ic-memory-size': 16384,
                'ic-gpu-count': 2,
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            assert.strictEqual(finalConfig.icCpuCount, 8)
            assert.strictEqual(finalConfig.icMemorySize, 16384)
            assert.strictEqual(finalConfig.icGpuCount, 2)
        })

        it('should include modelEnvVars in getFinalConfiguration for template rendering', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'model-env': 'HF_MODEL_ID=meta-llama/Llama-2-7b',
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            assert.ok(finalConfig.modelEnvVars)
            assert.strictEqual(finalConfig.modelEnvVars.HF_MODEL_ID, 'meta-llama/Llama-2-7b')
        })

        it('should include serverEnvVars (unprefixed) in getFinalConfiguration', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'server-env': 'TENSOR_PARALLEL_SIZE=4',
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            // serverEnvVars should be stored unprefixed in the config
            assert.ok(finalConfig.serverEnvVars)
            assert.strictEqual(finalConfig.serverEnvVars.TENSOR_PARALLEL_SIZE, '4')
        })

        it('should include default values for endpoint params with defaults', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            // Parameters with defaults should have their default values
            assert.strictEqual(finalConfig.endpointInitialInstanceCount, 1)
            assert.strictEqual(finalConfig.endpointDataCapturePercent, 0)
            assert.strictEqual(finalConfig.endpointVariantName, 'AllTraffic')
            assert.strictEqual(finalConfig.icCopyCount, 1)
            assert.strictEqual(finalConfig.icModelWeight, 1.0)
        })

        it('should leave null-default params as null when not provided', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                'skip-prompts': true,
                'deployment-config': 'transformers-vllm',
                'instance-type': 'ml.g5.xlarge',
                'project-name': 'test-project'
            })
            configManager = new ConfigManager(mockGenerator)
            await configManager.loadConfiguration()

            const finalConfig = configManager.getFinalConfiguration()

            // Parameters with null defaults should remain null
            assert.strictEqual(finalConfig.endpointVolumeSize, null)
            assert.strictEqual(finalConfig.icCpuCount, null)
            assert.strictEqual(finalConfig.icMemorySize, null)
            assert.strictEqual(finalConfig.icGpuCount, null)
        })
    })
})
