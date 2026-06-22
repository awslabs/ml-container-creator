// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for LoRA adapter prompt visibility
 *
 * Tests:
 * - enableLora prompt shown for transformers + vllm/sglang/djl-lmi
 * - enableLora prompt hidden for non-transformers architectures
 * - enableLora prompt hidden for unsupported model servers (flask, fastapi)
 * - maxLoras and maxLoraRank sub-prompts shown when enableLora === true
 * - maxLoras and maxLoraRank sub-prompts hidden when enableLora === false
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 1.1, 1.2, 1.4
 */

import { strict as assert } from 'node:assert';
import { loraPrompts } from '../../src/lib/prompts/index.js';

describe('LoRA Prompt Visibility', () => {

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

    describe('loraPrompts exports', () => {
        it('should export exactly 3 LoRA prompts', () => {
            assert.equal(loraPrompts.length, 3);
        });

        it('should contain enableLora, maxLoras, and maxLoraRank prompts', () => {
            const names = loraPrompts.map(p => p.name);
            assert.ok(names.includes('enableLora'), 'Missing prompt: enableLora');
            assert.ok(names.includes('maxLoras'), 'Missing prompt: maxLoras');
            assert.ok(names.includes('maxLoraRank'), 'Missing prompt: maxLoraRank');
        });
    });

    describe('enableLora prompt shown for transformers + vllm (Requirement 1.2)', () => {
        it('should show for architecture=transformers, backend=vllm', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'vllm' });
            assert.equal(result, true);
        });

        it('should show for deploymentConfig=transformers-vllm', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'transformers-vllm' });
            assert.equal(result, true);
        });
    });

    describe('enableLora prompt shown for transformers + sglang (Requirement 1.2)', () => {
        it('should show for architecture=transformers, backend=sglang', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'sglang' });
            assert.equal(result, true);
        });

        it('should show for deploymentConfig=transformers-sglang', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'transformers-sglang' });
            assert.equal(result, true);
        });
    });

    describe('enableLora prompt shown for transformers + djl-lmi/lmi/djl (Requirement 1.2)', () => {
        it('should show for architecture=transformers, backend=djl-lmi', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'djl-lmi' });
            assert.equal(result, true);
        });

        it('should show for architecture=transformers, backend=lmi', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'lmi' });
            assert.equal(result, true);
        });

        it('should show for architecture=transformers, backend=djl', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'djl' });
            assert.equal(result, true);
        });

        it('should show for deploymentConfig=transformers-lmi', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'transformers-lmi' });
            assert.equal(result, true);
        });

        it('should show for deploymentConfig=transformers-djl', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'transformers-djl' });
            assert.equal(result, true);
        });
    });

    describe('enableLora prompt hidden for non-transformers architectures (Requirement 1.2)', () => {
        it('should NOT show for architecture=http', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'http', backend: 'flask' });
            assert.equal(result, false);
        });

        it('should NOT show for deploymentConfig=http-flask', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'http-flask' });
            assert.equal(result, false);
        });

        it('should NOT show for deploymentConfig=http-fastapi', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'http-fastapi' });
            assert.equal(result, false);
        });

        it('should NOT show for architecture=triton', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'triton', backend: 'vllm' });
            assert.equal(result, false);
        });

        it('should NOT show for architecture=diffusors', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'diffusors', backend: 'vllm-omni' });
            assert.equal(result, false);
        });
    });

    describe('enableLora prompt hidden for unsupported model servers (Requirement 1.2)', () => {
        it('should NOT show for transformers + tensorrt-llm', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { architecture: 'transformers', backend: 'tensorrt-llm' });
            assert.equal(result, false);
        });

        it('should NOT show for deploymentConfig=transformers-tensorrt-llm', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            const result = evaluateWhen(prompt, { deploymentConfig: 'transformers-tensorrt-llm' });
            assert.equal(result, false);
        });
    });

    describe('maxLoras sub-prompt shown when enableLora === true (Requirement 1.4)', () => {
        it('should show maxLoras when enableLora is true', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoras');
            const result = evaluateWhen(prompt, { enableLora: true });
            assert.equal(result, true);
        });

        it('should have default value of 30', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoras');
            assert.equal(prompt.default, 30);
        });
    });

    describe('maxLoraRank sub-prompt shown when enableLora === true (Requirement 1.4)', () => {
        it('should show maxLoraRank when enableLora is true', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoraRank');
            const result = evaluateWhen(prompt, { enableLora: true });
            assert.equal(result, true);
        });

        it('should have default value of 64', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoraRank');
            assert.equal(prompt.default, 64);
        });
    });

    describe('Sub-prompts hidden when enableLora === false (Requirement 1.4)', () => {
        it('should NOT show maxLoras when enableLora is false', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoras');
            const result = evaluateWhen(prompt, { enableLora: false });
            assert.equal(result, false);
        });

        it('should NOT show maxLoraRank when enableLora is false', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoraRank');
            const result = evaluateWhen(prompt, { enableLora: false });
            assert.equal(result, false);
        });
    });

    describe('Sub-prompts hidden when enableLora is undefined', () => {
        it('should NOT show maxLoras when enableLora is not set', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoras');
            const result = evaluateWhen(prompt, {});
            assert.equal(result, false);
        });

        it('should NOT show maxLoraRank when enableLora is not set', () => {
            const prompt = findPrompt(loraPrompts, 'maxLoraRank');
            const result = evaluateWhen(prompt, {});
            assert.equal(result, false);
        });
    });

    describe('enableLora prompt defaults to true (Requirement 2.1)', () => {
        it('should default to true', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            assert.equal(prompt.default, true);
        });

        it('should be a confirm type prompt', () => {
            const prompt = findPrompt(loraPrompts, 'enableLora');
            assert.equal(prompt.type, 'confirm');
        });
    });
});
