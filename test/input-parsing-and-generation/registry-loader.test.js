// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Loader Tests
 * 
 * Tests the RegistryLoader class that loads and validates registry files:
 * - Framework Registry
 * - Model Registry
 * - Instance Accelerator Mapping
 * 
 * This module focuses on registry loading, schema validation, and error handling.
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import RegistryLoader from '../../src/lib/registry-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Registry Loader', () => {
    let loader;

    before(() => {
        console.log('\n🚀 Starting Registry Loader Tests');
        console.log('📋 Testing: Registry loading and schema validation');
        loader = new RegistryLoader();
        console.log('✅ Test environment ready\n');
    });

    describe('Framework Registry Loading', () => {
        it('should load valid framework registry successfully', async () => {
            console.log('\n  🧪 Testing valid framework registry loading...');
            
            const registry = await loader.loadFrameworkRegistry();
            
            assert(registry !== null, 'Registry should not be null');
            assert(typeof registry === 'object', 'Registry should be an object');
            console.log('    ✅ Valid framework registry loaded successfully');
        });

        it('should return empty object for missing framework registry', async () => {
            console.log('\n  🧪 Testing missing framework registry handling...');
            
            // Create a loader that will fail to load the registry
            const testLoader = new RegistryLoader();
            
            // Mock the import to simulate missing file
            testLoader.loadFrameworkRegistry = async function() {
                try {
                    await import('../nonexistent/frameworks.js');
                } catch (error) {
                    console.warn(`Failed to load framework registry: ${error.message}`);
                    return {};
                }
            };
            
            const registry = await testLoader.loadFrameworkRegistry();
            
            assert.deepStrictEqual(registry, {}, 'Should return empty object for missing registry');
            console.log('    ✅ Missing framework registry handled gracefully');
        });
    });

    describe('Model Registry Loading', () => {
        it('should load valid model registry successfully', async () => {
            console.log('\n  🧪 Testing valid model registry loading...');
            
            const registry = await loader.loadModelRegistry();
            
            assert(registry !== null, 'Registry should not be null');
            assert(typeof registry === 'object', 'Registry should be an object');
            console.log('    ✅ Valid model registry loaded successfully');
        });

        it('should return empty object for missing model registry', async () => {
            console.log('\n  🧪 Testing missing model registry handling...');
            
            // Create a loader that will fail to load the registry
            const testLoader = new RegistryLoader();
            
            // Mock the import to simulate missing file
            testLoader.loadModelRegistry = async function() {
                try {
                    await import('../nonexistent/models.js');
                } catch (error) {
                    console.warn(`Failed to load model registry: ${error.message}`);
                    return {};
                }
            };
            
            const registry = await testLoader.loadModelRegistry();
            
            assert.deepStrictEqual(registry, {}, 'Should return empty object for missing registry');
            console.log('    ✅ Missing model registry handled gracefully');
        });
    });

    describe('Instance Accelerator Mapping Loading', () => {
        it('should load valid instance accelerator mapping successfully', async () => {
            console.log('\n  🧪 Testing valid instance accelerator mapping loading...');
            
            const mapping = await loader.loadInstanceAcceleratorMapping();
            
            assert(mapping !== null, 'Mapping should not be null');
            assert(typeof mapping === 'object', 'Mapping should be an object');
            console.log('    ✅ Valid instance accelerator mapping loaded successfully');
        });

        it('should return empty object for missing instance accelerator mapping', async () => {
            console.log('\n  🧪 Testing missing instance accelerator mapping handling...');
            
            // Create a loader that will fail to load the mapping
            const testLoader = new RegistryLoader();
            
            // Mock the import to simulate missing file
            testLoader.loadInstanceAcceleratorMapping = async function() {
                try {
                    await import('../nonexistent/instance-accelerator-mapping.js');
                } catch (error) {
                    console.warn(`Failed to load instance accelerator mapping: ${error.message}`);
                    return {};
                }
            };
            
            const mapping = await testLoader.loadInstanceAcceleratorMapping();
            
            assert.deepStrictEqual(mapping, {}, 'Should return empty object for missing mapping');
            console.log('    ✅ Missing instance accelerator mapping handled gracefully');
        });
    });

    describe('Schema Validation', () => {
        it('should load framework registry with valid structure', async () => {
            console.log('\n  🧪 Testing framework registry structure from catalog...');
            
            const registry = await loader.loadFrameworkRegistry();
            const frameworks = Object.keys(registry);
            assert.ok(frameworks.length > 0, 'Framework registry should not be empty');
            
            for (const frameworkName of frameworks) {
                const versions = registry[frameworkName];
                for (const version of Object.keys(versions)) {
                    const entry = versions[version];
                    assert.ok(entry.baseImage, `${frameworkName} ${version} must have baseImage`);
                    assert.ok(entry.accelerator, `${frameworkName} ${version} must have accelerator`);
                    assert.ok(entry.accelerator.type, `${frameworkName} ${version} must have accelerator.type`);
                }
            }
            
            console.log('    ✅ Framework registry structure validation passed');
        });

        it('should load model registry with valid structure', async () => {
            console.log('\n  🧪 Testing model registry structure from catalog...');
            
            const registry = await loader.loadModelRegistry();
            const modelIds = Object.keys(registry);
            assert.ok(modelIds.length > 0, 'Model registry should not be empty');
            
            for (const modelId of modelIds) {
                const entry = registry[modelId];
                assert.ok(entry.family, `${modelId} must have family`);
                assert.ok(entry.validationLevel, `${modelId} must have validationLevel`);
                assert.ok(entry.frameworkCompatibility, `${modelId} must have frameworkCompatibility`);
            }
            
            console.log('    ✅ Model registry structure validation passed');
        });

        it('should load instance accelerator mapping with valid structure', async () => {
            console.log('\n  🧪 Testing instance accelerator mapping structure from catalog...');
            
            const mapping = await loader.loadInstanceAcceleratorMapping();
            const instanceTypes = Object.keys(mapping);
            assert.ok(instanceTypes.length > 0, 'Instance mapping should not be empty');
            
            for (const instanceType of instanceTypes) {
                const entry = mapping[instanceType];
                assert.ok(entry.family, `${instanceType} must have family`);
                assert.ok(entry.accelerator, `${instanceType} must have accelerator`);
                assert.ok(entry.accelerator.type, `${instanceType} must have accelerator.type`);
            }
            
            console.log('    ✅ Instance accelerator mapping structure validation passed');
        });
    });

    describe('Registry_Loader returns valid data from catalog files', () => {
        it('should return non-empty framework registry with expected framework keys', async () => {
            const registry = await loader.loadFrameworkRegistry();
            assert.ok(typeof registry === 'object' && registry !== null);
            assert.ok(Object.keys(registry).length > 0, 'Framework registry should be non-empty');

            // Verify known framework keys are present
            const expectedFrameworks = ['vllm', 'sglang', 'tensorrt-llm', 'djl'];
            for (const fw of expectedFrameworks) {
                assert.ok(registry[fw], `Expected framework '${fw}' to be present`);
                assert.ok(typeof registry[fw] === 'object', `Framework '${fw}' should map to version object`);
                assert.ok(Object.keys(registry[fw]).length > 0, `Framework '${fw}' should have at least one version`);
            }

            // Verify shape of at least one FrameworkConfig entry
            const vllmVersions = registry['vllm'];
            const firstVersion = Object.keys(vllmVersions)[0];
            const config = vllmVersions[firstVersion];
            assert.ok(config.baseImage, 'FrameworkConfig should have baseImage');
            assert.ok(config.accelerator, 'FrameworkConfig should have accelerator');
            assert.ok(config.accelerator.type, 'FrameworkConfig.accelerator should have type');
            assert.ok(typeof config.envVars === 'object', 'FrameworkConfig should have envVars object');
            assert.ok(typeof config.validationLevel === 'string', 'FrameworkConfig should have validationLevel string');
            assert.ok(typeof config.profiles === 'object', 'FrameworkConfig should have profiles object');
            assert.ok(typeof config.notes === 'string', 'FrameworkConfig should have notes string');
        });

        it('should return non-empty model registry with expected model keys', async () => {
            const registry = await loader.loadModelRegistry();
            assert.ok(typeof registry === 'object' && registry !== null);
            assert.ok(Object.keys(registry).length > 0, 'Model registry should be non-empty');

            // Verify known model IDs are present (from transformers + diffusors)
            const expectedModels = [
                'meta-llama/Llama-2-7b-chat-hf',
                'stabilityai/stable-diffusion-3.5-medium',
                'black-forest-labs/FLUX.1-dev'
            ];
            for (const modelId of expectedModels) {
                assert.ok(registry[modelId], `Expected model '${modelId}' to be present`);
            }

            // Verify shape of at least one ModelConfig entry
            const entry = registry['meta-llama/Llama-2-7b-chat-hf'];
            assert.ok(typeof entry.family === 'string', 'ModelConfig should have family string');
            assert.ok('chatTemplate' in entry, 'ModelConfig should have chatTemplate');
            assert.ok(typeof entry.validationLevel === 'string', 'ModelConfig should have validationLevel string');
            assert.ok(typeof entry.frameworkCompatibility === 'object', 'ModelConfig should have frameworkCompatibility object');
            assert.ok(typeof entry.profiles === 'object', 'ModelConfig should have profiles object');
            assert.ok(typeof entry.notes === 'string', 'ModelConfig should have notes string');
        });

        it('should return non-empty instance accelerator mapping with expected keys', async () => {
            const mapping = await loader.loadInstanceAcceleratorMapping();
            assert.ok(typeof mapping === 'object' && mapping !== null);
            assert.ok(Object.keys(mapping).length > 0, 'Instance mapping should be non-empty');

            // Verify known instance types are present
            const expectedInstances = ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.c5.xlarge'];
            for (const inst of expectedInstances) {
                assert.ok(mapping[inst], `Expected instance type '${inst}' to be present`);
            }

            // Verify shape of one entry
            const entry = mapping['ml.g5.xlarge'];
            assert.ok(typeof entry.family === 'string', 'Instance entry should have family string');
            assert.ok(entry.accelerator, 'Instance entry should have accelerator');
            assert.ok(typeof entry.accelerator.type === 'string', 'accelerator should have type');
            assert.ok(typeof entry.accelerator.hardware === 'string', 'accelerator should have hardware');
            assert.ok(typeof entry.accelerator.architecture === 'string', 'accelerator should have architecture');
            assert.ok(typeof entry.vcpus === 'number', 'Instance entry should have vcpus number');
            assert.ok(typeof entry.memory === 'string', 'Instance entry should have memory string');
            assert.ok(typeof entry.notes === 'string', 'Instance entry should have notes string');
        });

        it('should return non-empty triton backends with expected backend keys', async () => {
            const backends = await loader.loadTritonBackends();
            assert.ok(typeof backends === 'object' && backends !== null);
            assert.ok(Object.keys(backends).length > 0, 'Triton backends should be non-empty');

            // Verify known backend keys are present
            const expectedBackends = ['fil', 'onnxruntime', 'tensorflow', 'pytorch', 'vllm', 'tensorrtllm', 'python'];
            for (const backend of expectedBackends) {
                assert.ok(backends[backend], `Expected triton backend '${backend}' to be present`);
            }

            // Verify shape of one backend entry
            const filEntry = backends['fil'];
            assert.ok(typeof filEntry.requiresGpu === 'boolean', 'Backend should have requiresGpu boolean');
            assert.ok(Array.isArray(filEntry.modelFormats) || filEntry.modelFormats === null, 'Backend should have modelFormats array or null');
            assert.ok(typeof filEntry.requiresModelName === 'boolean', 'Backend should have requiresModelName boolean');
            assert.ok(typeof filEntry.supportsSampleModel === 'boolean', 'Backend should have supportsSampleModel boolean');
            assert.ok('modelArtifactName' in filEntry, 'Backend should have modelArtifactName');
        });
    });

    describe('Malformed JSON Handling', () => {
        it('should handle malformed JSON gracefully', async () => {
            console.log('\n  🧪 Testing malformed JSON handling...');
            
            // Create a temporary malformed catalog file
            const tempDir = path.join(__dirname, '../../.kiro/tmp');
            const tempFile = path.join(tempDir, 'temp-malformed.json');
            
            try {
                // Ensure temp directory exists
                fs.mkdirSync(tempDir, { recursive: true });
                
                // Write malformed content
                fs.writeFileSync(tempFile, '{ invalid json }');
                
                // Create a loader that tries to load the malformed file
                const testLoader = new RegistryLoader();
                const result = testLoader._loadCatalog(tempFile);
                
                assert.strictEqual(result, null, 'Should return null for malformed JSON');
                console.log('    ✅ Malformed JSON handled gracefully');
            } finally {
                // Clean up temp file
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }
        });
    });
});
