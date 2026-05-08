// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for async prompt visibility
 *
 * Tests:
 * - Async prompts appear when deploymentTarget === 'async-inference'
 * - Async prompts are hidden for realtime-inference and hyperpod-eks
 * - HyperPod prompts are hidden when deploymentTarget === 'async-inference'
 *
 * Feature: async-inference-endpoint
 * Validates: Requirements 2.5, 2.6
 */

import { strict as assert } from 'node:assert';
import {
    infraAsyncPrompts,
    infraHyperPodPrompts
} from '../../src/lib/prompts.js';

describe('Async Prompt Visibility', () => {

    const asyncPromptNames = [
        'asyncS3OutputPath',
        'asyncSnsSuccessTopic',
        'asyncSnsErrorTopic',
        'asyncMaxConcurrentInvocations'
    ];

    const hyperPodPromptNames = [
        'hyperPodCluster',
        'hyperPodNamespace',
        'hyperPodReplicas',
        'fsxVolumeHandle'
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

    describe('infraAsyncPrompts exports', () => {
        it('should export exactly 4 async prompts', () => {
            assert.equal(infraAsyncPrompts.length, 4);
        });

        it('should contain all expected prompt names', () => {
            const names = infraAsyncPrompts.map(p => p.name);
            for (const expected of asyncPromptNames) {
                assert.ok(names.includes(expected), `Missing prompt: ${expected}`);
            }
        });
    });

    describe('Async prompts shown for async-inference (Requirement 2.5)', () => {
        const answers = { deploymentTarget: 'async-inference' };

        for (const name of asyncPromptNames) {
            it(`${name} when() should return true for async-inference`, () => {
                const prompt = findPrompt(infraAsyncPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), true);
            });
        }
    });

    describe('Async prompts hidden for realtime-inference (Requirement 2.6)', () => {
        const answers = { deploymentTarget: 'realtime-inference' };

        for (const name of asyncPromptNames) {
            it(`${name} when() should return false for realtime-inference`, () => {
                const prompt = findPrompt(infraAsyncPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('Async prompts hidden for hyperpod-eks (Requirement 2.6)', () => {
        const answers = { deploymentTarget: 'hyperpod-eks' };

        for (const name of asyncPromptNames) {
            it(`${name} when() should return false for hyperpod-eks`, () => {
                const prompt = findPrompt(infraAsyncPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('HyperPod prompts hidden for async-inference (Requirement 2.6)', () => {
        const answers = { deploymentTarget: 'async-inference' };

        for (const name of hyperPodPromptNames) {
            it(`${name} when() should return false for async-inference`, () => {
                const prompt = findPrompt(infraHyperPodPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });
});
