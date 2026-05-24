// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for benchmark prompt visibility
 *
 * Tests:
 * - 'sagemaker-ai-automated-benchmarking' choice available in testTypes for transformers/diffusors
 * - 'sagemaker-ai-automated-benchmarking' choice NOT available for http/triton architectures
 * - Benchmark sub-prompts shown when includeBenchmark === true
 * - Benchmark sub-prompts hidden when includeBenchmark === false
 *
 * Feature: sagemaker-ai-benchmarking
 * Validates: Requirements 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { strict as assert } from 'node:assert';
import { benchmarkPrompts, modulePrompts } from '../../src/lib/prompts/index.js';

describe('Benchmark Prompt Visibility', () => {

    const subPromptNames = [
        'benchmarkConcurrency',
        'benchmarkInputTokensMean',
        'benchmarkOutputTokensMean',
        'benchmarkStreaming',
        'benchmarkRequestCount',
        'benchmarkS3OutputPath'
    ];

    /**
     * Helper to find a prompt by name in an array
     */
    function findPrompt(prompts, name) {
        return prompts.find(p => p.name === name);
    }

    /**
     * Helper to evaluate a prompt's when function
     */
    function evaluateWhen(prompt, answers) {
        if (!prompt) return false;
        if (typeof prompt.when === 'function') {
            return prompt.when(answers);
        }
        return prompt.when !== false;
    }

    /**
     * Helper to get testTypes choices for given answers
     */
    function getTestTypeChoices(answers) {
        const prompt = findPrompt(modulePrompts, 'testTypes');
        if (typeof prompt.choices === 'function') {
            return prompt.choices(answers);
        }
        return prompt.choices || [];
    }

    describe('benchmarkPrompts exports', () => {
        it('should export exactly 6 benchmark sub-prompts', () => {
            assert.equal(benchmarkPrompts.length, 6);
        });

        it('should contain all expected sub-prompt names', () => {
            const names = benchmarkPrompts.map(p => p.name);
            for (const expected of subPromptNames) {
                assert.ok(names.includes(expected), `Missing prompt: ${expected}`);
            }
        });
    });

    describe('sagemaker-ai-automated-benchmarking in testTypes for transformers (Requirement 1.2)', () => {
        it('should be a choice for architecture=transformers', () => {
            const choices = getTestTypeChoices({ architecture: 'transformers' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should be a choice for deploymentConfig=transformers-vllm', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'transformers-vllm' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should be a choice for deploymentConfig=transformers-sglang', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'transformers-sglang' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should be a choice for deploymentConfig=transformers-tensorrt-llm', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'transformers-tensorrt-llm' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });
    });

    describe('sagemaker-ai-automated-benchmarking in testTypes for diffusors (Requirement 1.2)', () => {
        it('should be a choice for architecture=diffusors', () => {
            const choices = getTestTypeChoices({ architecture: 'diffusors' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should be a choice for deploymentConfig=diffusors-vllm-omni', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'diffusors-vllm-omni' });
            assert.ok(choices.includes('sagemaker-ai-automated-benchmarking'));
        });
    });

    describe('sagemaker-ai-automated-benchmarking NOT in testTypes for http (Requirement 1.2)', () => {
        it('should NOT be a choice for architecture=http', () => {
            const choices = getTestTypeChoices({ architecture: 'http' });
            assert.ok(!choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should NOT be a choice for deploymentConfig=http-flask', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'http-flask' });
            assert.ok(!choices.includes('sagemaker-ai-automated-benchmarking'));
        });
    });

    describe('sagemaker-ai-automated-benchmarking NOT in testTypes for triton (Requirement 1.2)', () => {
        it('should NOT be a choice for architecture=triton', () => {
            const choices = getTestTypeChoices({ architecture: 'triton', backend: 'vllm' });
            assert.ok(!choices.includes('sagemaker-ai-automated-benchmarking'));
        });

        it('should NOT be a choice for deploymentConfig=triton-tensorrtllm', () => {
            const choices = getTestTypeChoices({ deploymentConfig: 'triton-tensorrtllm' });
            assert.ok(!choices.includes('sagemaker-ai-automated-benchmarking'));
        });
    });

    describe('Sub-prompts shown when includeBenchmark === true (Requirements 2.1-2.7)', () => {
        const answers = { includeBenchmark: true };

        for (const name of subPromptNames) {
            it(`${name} when() should return true when includeBenchmark is true`, () => {
                const prompt = findPrompt(benchmarkPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), true);
            });
        }
    });

    describe('Sub-prompts hidden when includeBenchmark === false (Requirements 2.1-2.7)', () => {
        const answers = { includeBenchmark: false };

        for (const name of subPromptNames) {
            it(`${name} when() should return false when includeBenchmark is false`, () => {
                const prompt = findPrompt(benchmarkPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('Sub-prompts hidden when includeBenchmark is undefined', () => {
        const answers = {};

        for (const name of subPromptNames) {
            it(`${name} when() should return false when includeBenchmark is not set`, () => {
                const prompt = findPrompt(benchmarkPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });
});
