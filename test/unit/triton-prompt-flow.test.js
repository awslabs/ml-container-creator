// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Triton prompt flow
 *
 * Tests:
 * - Triton deployment-configs appear in prompt choices
 * - Backend-specific model format auto-setting
 * - HF token prompt only for triton-vllm and triton-tensorrtllm
 * - No NGC key prompt for any Triton config
 *
 * Feature: triton-integration
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 9.1, 9.2
 */

import { strict as assert } from 'node:assert';
import {
    deploymentConfigPrompts,
    enginePrompts,
    modelFormatPrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts
} from '../../generators/app/lib/prompts.js';
import PromptRunner from '../../generators/app/lib/prompt-runner.js';

describe('Triton Prompt Flow', () => {

    describe('deploymentConfigPrompts - Triton choices (Requirement 3.1)', () => {
        const deploymentConfigPrompt = deploymentConfigPrompts[0];

        it('should have a deployment-config list prompt', () => {
            assert.equal(deploymentConfigPrompt.type, 'list');
            assert.equal(deploymentConfigPrompt.name, 'deploymentConfig');
        });

        it('should include NVIDIA Triton Inference Server separator', () => {
            const separators = deploymentConfigPrompt.choices.filter(c => c.type === 'separator');
            const tritonSeparator = separators.find(s => s.separator.includes('NVIDIA Triton'));
            assert.ok(tritonSeparator, 'Should have NVIDIA Triton Inference Server separator');
        });

        it('should include all 7 Triton deployment-config choices', () => {
            const tritonConfigs = [
                'triton-fil',
                'triton-onnxruntime',
                'triton-tensorflow',
                'triton-pytorch',
                'triton-vllm',
                'triton-tensorrtllm',
                'triton-python'
            ];

            const choices = deploymentConfigPrompt.choices.filter(c => !c.type);
            const values = choices.map(c => c.value);

            for (const config of tritonConfigs) {
                assert.ok(values.includes(config), `Should include ${config}`);
            }
        });

        it('should include http-flask and http-fastapi (not old format)', () => {
            const choices = deploymentConfigPrompt.choices.filter(c => !c.type);
            const values = choices.map(c => c.value);

            assert.ok(values.includes('http-flask'), 'Should include http-flask');
            assert.ok(values.includes('http-fastapi'), 'Should include http-fastapi');

            // Old format should NOT be present
            assert.ok(!values.includes('sklearn-flask'), 'Should NOT include sklearn-flask');
            assert.ok(!values.includes('xgboost-flask'), 'Should NOT include xgboost-flask');
        });
    });

    describe('enginePrompts - http architecture only (Requirement 3.7)', () => {
        const enginePrompt = enginePrompts[0];

        it('should show engine prompt for http architecture', () => {
            const answers = { architecture: 'http' };
            assert.equal(enginePrompt.when(answers), true);
        });

        it('should show engine prompt when deploymentConfig starts with http', () => {
            const answers = { deploymentConfig: 'http-flask' };
            assert.equal(enginePrompt.when(answers), true);
        });

        it('should NOT show engine prompt for triton architecture', () => {
            const answers = { architecture: 'triton' };
            assert.equal(enginePrompt.when(answers), false);
        });

        it('should NOT show engine prompt for transformers architecture', () => {
            const answers = { architecture: 'transformers' };
            assert.equal(enginePrompt.when(answers), false);
        });
    });

    describe('_getTritonAutoModelFormat - Backend-specific auto-setting (Requirements 3.3, 3.4, 3.5)', () => {
        let runner;

        beforeEach(async () => {
            // Create a minimal mock generator
            const mockGenerator = {
                configManager: null,
                registryConfigManager: null,
                options: {},
                baseConfig: {},
                prompt: async () => ({})
            };
            runner = new PromptRunner(mockGenerator);
            // Load catalog data that _getTritonAutoModelFormat depends on
            const { default: RegistryLoader } = await import('../../generators/app/lib/registry-loader.js');
            const registryLoader = new RegistryLoader();
            runner._tritonBackends = await registryLoader.loadTritonBackends();
        });

        it('should auto-set onnx for triton-onnxruntime', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'onnxruntime');
            assert.equal(result, 'onnx');
        });

        it('should auto-set savedmodel for triton-tensorflow', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'tensorflow');
            assert.equal(result, 'savedmodel');
        });

        it('should auto-set torchscript for triton-pytorch', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'pytorch');
            assert.equal(result, 'torchscript');
        });

        it('should NOT auto-set for triton-fil (multiple formats)', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'fil');
            assert.equal(result, null);
        });

        it('should NOT auto-set for triton-python (multiple formats)', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'python');
            assert.equal(result, null);
        });

        it('should NOT auto-set for triton-vllm (uses HF Hub)', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'vllm');
            assert.equal(result, null);
        });

        it('should NOT auto-set for triton-tensorrtllm (uses HF Hub)', () => {
            const result = runner._getTritonAutoModelFormat('triton', 'tensorrtllm');
            assert.equal(result, null);
        });

        it('should return null for non-triton architecture', () => {
            const result = runner._getTritonAutoModelFormat('http', 'flask');
            assert.equal(result, null);
        });

        it('should return null for transformers architecture', () => {
            const result = runner._getTritonAutoModelFormat('transformers', 'vllm');
            assert.equal(result, null);
        });
    });

    describe('modelFormatPrompts - Triton backend-specific choices (Requirements 3.2, 3.6, 3.7)', () => {
        const modelFormatPrompt = modelFormatPrompts[0];

        describe('when function', () => {
            it('should show for triton-fil (multiple format choices)', () => {
                const answers = { architecture: 'triton', backend: 'fil' };
                assert.equal(modelFormatPrompt.when(answers), true);
            });

            it('should show for triton-python (multiple format choices)', () => {
                const answers = { architecture: 'triton', backend: 'python' };
                assert.equal(modelFormatPrompt.when(answers), true);
            });

            it('should NOT show for triton-onnxruntime (auto-set)', () => {
                const answers = { architecture: 'triton', backend: 'onnxruntime' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should NOT show for triton-tensorflow (auto-set)', () => {
                const answers = { architecture: 'triton', backend: 'tensorflow' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should NOT show for triton-pytorch (auto-set)', () => {
                const answers = { architecture: 'triton', backend: 'pytorch' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should NOT show for triton-vllm (uses HF Hub)', () => {
                const answers = { architecture: 'triton', backend: 'vllm' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should NOT show for triton-tensorrtllm (uses HF Hub)', () => {
                const answers = { architecture: 'triton', backend: 'tensorrtllm' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should show for http architecture', () => {
                const answers = { architecture: 'http', backend: 'flask' };
                assert.equal(modelFormatPrompt.when(answers), true);
            });

            it('should NOT show for transformers architecture', () => {
                const answers = { architecture: 'transformers', backend: 'vllm' };
                assert.equal(modelFormatPrompt.when(answers), false);
            });

            it('should derive architecture from deploymentConfig if not set', () => {
                const answers = { deploymentConfig: 'triton-fil' };
                assert.equal(modelFormatPrompt.when(answers), true);
            });
        });

        describe('choices function', () => {
            it('should return FIL format choices for triton-fil', () => {
                const answers = { architecture: 'triton', backend: 'fil' };
                const choices = modelFormatPrompt.choices(answers);
                assert.deepEqual(choices, ['xgboost_json', 'xgboost_ubj', 'lightgbm_txt']);
            });

            it('should return Python format choices for triton-python', () => {
                const answers = { architecture: 'triton', backend: 'python' };
                const choices = modelFormatPrompt.choices(answers);
                assert.deepEqual(choices, ['pkl', 'joblib', 'custom']);
            });

            it('should return empty array for triton-onnxruntime (auto-set)', () => {
                const answers = { architecture: 'triton', backend: 'onnxruntime' };
                const choices = modelFormatPrompt.choices(answers);
                assert.deepEqual(choices, []);
            });

            it('should return http engine-based choices for http architecture', () => {
                const answers = { architecture: 'http', engine: 'sklearn' };
                const choices = modelFormatPrompt.choices(answers);
                assert.deepEqual(choices, ['pkl', 'joblib']);
            });
        });
    });

    describe('hfTokenPrompts - Triton LLM backends only (Requirements 9.1, 9.2)', () => {
        const hfTokenPrompt = hfTokenPrompts[0];

        it('should show for triton-vllm', () => {
            const answers = { architecture: 'triton', backend: 'vllm' };
            assert.equal(hfTokenPrompt.when(answers), true);
        });

        it('should show for triton-tensorrtllm', () => {
            const answers = { architecture: 'triton', backend: 'tensorrtllm' };
            assert.equal(hfTokenPrompt.when(answers), true);
        });

        it('should NOT show for triton-fil', () => {
            const answers = { architecture: 'triton', backend: 'fil' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });

        it('should NOT show for triton-onnxruntime', () => {
            const answers = { architecture: 'triton', backend: 'onnxruntime' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });

        it('should NOT show for triton-tensorflow', () => {
            const answers = { architecture: 'triton', backend: 'tensorflow' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });

        it('should NOT show for triton-pytorch', () => {
            const answers = { architecture: 'triton', backend: 'pytorch' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });

        it('should NOT show for triton-python', () => {
            const answers = { architecture: 'triton', backend: 'python' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });

        it('should show for transformers architecture', () => {
            const answers = { architecture: 'transformers', backend: 'vllm' };
            assert.equal(hfTokenPrompt.when(answers), true);
        });

        it('should derive architecture/backend from deploymentConfig', () => {
            const answers = { deploymentConfig: 'triton-vllm' };
            assert.equal(hfTokenPrompt.when(answers), true);
        });

        it('should NOT show for deploymentConfig triton-fil', () => {
            const answers = { deploymentConfig: 'triton-fil' };
            assert.equal(hfTokenPrompt.when(answers), false);
        });
    });

    describe('ngcApiKeyPrompts - Never for Triton (Requirement 9.2)', () => {
        const ngcApiKeyPrompt = ngcApiKeyPrompts[0];

        it('should NOT show for triton-vllm', () => {
            const answers = { architecture: 'triton', backend: 'vllm' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-tensorrtllm', () => {
            const answers = { architecture: 'triton', backend: 'tensorrtllm' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-fil', () => {
            const answers = { architecture: 'triton', backend: 'fil' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-onnxruntime', () => {
            const answers = { architecture: 'triton', backend: 'onnxruntime' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-tensorflow', () => {
            const answers = { architecture: 'triton', backend: 'tensorflow' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-pytorch', () => {
            const answers = { architecture: 'triton', backend: 'pytorch' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should NOT show for triton-python', () => {
            const answers = { architecture: 'triton', backend: 'python' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });

        it('should show for transformers-tensorrt-llm (non-Triton)', () => {
            const answers = { architecture: 'transformers', backend: 'tensorrt-llm' };
            assert.equal(ngcApiKeyPrompt.when(answers), true);
        });

        it('should derive architecture from deploymentConfig', () => {
            const answers = { deploymentConfig: 'triton-tensorrtllm' };
            assert.equal(ngcApiKeyPrompt.when(answers), false);
        });
    });

    describe('modelName prompt - Triton LLM backends (Requirement 3.6)', () => {
        const modelNamePrompt = modelFormatPrompts[1];

        it('should show for triton-vllm', () => {
            const answers = { architecture: 'triton', backend: 'vllm' };
            assert.equal(modelNamePrompt.when(answers), true);
        });

        it('should show for triton-tensorrtllm', () => {
            const answers = { architecture: 'triton', backend: 'tensorrtllm' };
            assert.equal(modelNamePrompt.when(answers), true);
        });

        it('should NOT show for triton-fil', () => {
            const answers = { architecture: 'triton', backend: 'fil' };
            assert.equal(modelNamePrompt.when(answers), false);
        });

        it('should NOT show for triton-onnxruntime', () => {
            const answers = { architecture: 'triton', backend: 'onnxruntime' };
            assert.equal(modelNamePrompt.when(answers), false);
        });

        it('should NOT show for triton-python', () => {
            const answers = { architecture: 'triton', backend: 'python' };
            assert.equal(modelNamePrompt.when(answers), false);
        });

        it('should show for transformers architecture', () => {
            const answers = { architecture: 'transformers', backend: 'vllm' };
            assert.equal(modelNamePrompt.when(answers), true);
        });
    });
});
