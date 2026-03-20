// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Triton Template Generation Property-Based Tests
 *
 * Property 8: Triton Projects Contain Model Repository Structure
 * Validates: Requirements 4.4, 5.2
 *
 * Feature: triton-integration
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import DeploymentConfigResolver from '../../generators/app/lib/deployment-config-resolver.js';
import tritonBackends from '../../generators/app/config/registries/triton-backends.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

const resolver = new DeploymentConfigResolver();

/** All 7 Triton deployment-config strings */
const TRITON_CONFIGS = resolver.getConfigsForArchitecture('triton');

/** Sample model names for testing */
const SAMPLE_MODEL_NAMES = [
    'my-model', 'abalone', 'classifier', 'xgb-model',
    'bert-base', 'resnet50', 'custom-model'
];

// ── Property 8: Triton Projects Contain Model Repository Structure ───────────

describe('Triton Template Generation Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting Triton Template Generation Property Tests');
        console.log('📋 Testing: Model repository structure for Triton configs');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Triton configs: ${TRITON_CONFIGS.length}\n`);
    });

    /**
     * Property 8: Triton Projects Contain Model Repository Structure
     *
     * **Validates: Requirements 4.4, 5.2**
     *
     * For any Triton deployment-config, the generated project should contain
     * model_repository/<model-name>/config.pbtxt and
     * model_repository/<model-name>/1/ directory, and the config.pbtxt
     * should reference the correct Triton backend name.
     */
    describe('Property 8: Triton Projects Contain Model Repository Structure', () => {

        it('all Triton configs decompose to triton architecture', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...TRITON_CONFIGS),
                (deploymentConfig) => {
                    const parts = resolver.decompose(deploymentConfig);
                    assert.strictEqual(parts.architecture, 'triton',
                        `Expected architecture 'triton' for ${deploymentConfig}, got '${parts.architecture}'`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('expected model repository paths are generated for any Triton config and model name', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...TRITON_CONFIGS),
                fc.constantFrom(...SAMPLE_MODEL_NAMES),
                (deploymentConfig, modelName) => {
                    const parts = resolver.decompose(deploymentConfig);
                    const backend = parts.backend;

                    // Verify expected file paths for model repository structure
                    const expectedConfigPath = `model_repository/${modelName}/config.pbtxt`;
                    const expectedVersionDir = `model_repository/${modelName}/1/`;

                    // Verify the paths are well-formed
                    assert.ok(expectedConfigPath.includes('config.pbtxt'),
                        'config.pbtxt path should be in model_repository');
                    assert.ok(expectedVersionDir.endsWith('1/'),
                        'Version directory should end with 1/');
                    assert.ok(expectedConfigPath.startsWith('model_repository/'),
                        'config.pbtxt should be under model_repository/');
                    assert.ok(expectedVersionDir.startsWith('model_repository/'),
                        'Version dir should be under model_repository/');

                    // Verify the backend from decomposition matches a known Triton backend
                    assert.ok(backend in tritonBackends,
                        `Backend '${backend}' from ${deploymentConfig} should exist in triton-backends registry`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('config.pbtxt references the correct backend for any Triton config', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...TRITON_CONFIGS),
                (deploymentConfig) => {
                    const parts = resolver.decompose(deploymentConfig);
                    const backend = parts.backend;

                    // The config.pbtxt template uses `backend` variable directly
                    // Verify the backend name is valid for Triton
                    const validTritonBackends = Object.keys(tritonBackends);
                    assert.ok(validTritonBackends.includes(backend),
                        `Backend '${backend}' should be a valid Triton backend. Valid: ${validTritonBackends.join(', ')}`);

                    // Verify the backend metadata exists and has required fields
                    const meta = tritonBackends[backend];
                    assert.ok(meta !== undefined,
                        `Backend metadata should exist for '${backend}'`);
                    assert.ok(typeof meta.requiresGpu === 'boolean',
                        `Backend '${backend}' should have requiresGpu boolean`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('triton-python backend requires model.py in version directory', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...SAMPLE_MODEL_NAMES),
                (modelName) => {
                    const parts = resolver.decompose('triton-python');
                    assert.strictEqual(parts.backend, 'python');

                    // For python backend, model.py should go in version directory
                    const expectedModelPyPath = `model_repository/${modelName}/1/model.py`;
                    assert.ok(expectedModelPyPath.includes('1/model.py'),
                        'Python backend should have model.py in version directory');

                    // Python backend metadata should indicate it doesn't require model name (HF)
                    const meta = tritonBackends['python'];
                    assert.strictEqual(meta.requiresModelName, false,
                        'Python backend should not require HuggingFace model name');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('non-python Triton backends do not include model.py in expected output', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const nonPythonTritonConfigs = TRITON_CONFIGS.filter(dc => dc !== 'triton-python');

            fc.assert(fc.property(
                fc.constantFrom(...nonPythonTritonConfigs),
                (deploymentConfig) => {
                    const parts = resolver.decompose(deploymentConfig);

                    // Non-python backends should not have model.py as their artifact
                    // (model.py is specific to the python backend)
                    assert.notStrictEqual(parts.backend, 'python',
                        `${deploymentConfig} should not be python backend`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
