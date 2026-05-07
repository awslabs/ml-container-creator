// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for batch transform prompt visibility
 *
 * Tests:
 * - Batch prompts appear when deploymentTarget === 'batch-transform'
 * - Batch prompts are hidden for managed-inference, async-inference, and hyperpod-eks
 * - HyperPod prompts are hidden when deploymentTarget === 'batch-transform'
 * - Async prompts are hidden when deploymentTarget === 'batch-transform'
 *
 * Feature: batch-transform-endpoint
 * Validates: Requirements 2.10, 2.11
 */

import { strict as assert } from 'node:assert';
import {
    infraBatchTransformPrompts,
    infraHyperPodPrompts,
    infraAsyncPrompts
} from '../../src/lib/prompts.js';

describe('Batch Transform Prompt Visibility', () => {

    const batchPromptNames = [
        'batchInputPath',
        'batchOutputPath',
        'batchInstanceCount',
        'batchSplitType',
        'batchStrategy',
        'batchJoinSource',
        'batchMaxConcurrentTransforms',
        'batchMaxPayloadInMB'
    ];

    const hyperPodPromptNames = [
        'hyperPodCluster',
        'hyperPodNamespace',
        'hyperPodReplicas',
        'fsxVolumeHandle'
    ];

    const asyncPromptNames = [
        'asyncS3OutputPath',
        'asyncSnsSuccessTopic',
        'asyncSnsErrorTopic',
        'asyncMaxConcurrentInvocations'
    ];

    function findPrompt(prompts, name) {
        return prompts.find(p => p.name === name);
    }

    function evaluateWhen(prompt, answers) {
        if (!prompt) return false;
        if (typeof prompt.when === 'function') {
            return prompt.when(answers);
        }
        return prompt.when !== false;
    }

    describe('infraBatchTransformPrompts exports', () => {
        it('should export exactly 8 batch prompts', () => {
            assert.equal(infraBatchTransformPrompts.length, 8);
        });

        it('should contain all expected prompt names', () => {
            const names = infraBatchTransformPrompts.map(p => p.name);
            for (const expected of batchPromptNames) {
                assert.ok(names.includes(expected), `Missing prompt: ${expected}`);
            }
        });
    });

    describe('Batch prompts shown for batch-transform (Requirement 2.10)', () => {
        const answers = { deploymentTarget: 'batch-transform' };

        for (const name of batchPromptNames) {
            it(`${name} when() should return true for batch-transform`, () => {
                const prompt = findPrompt(infraBatchTransformPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), true);
            });
        }
    });

    describe('Batch prompts hidden for managed-inference (Requirement 2.10)', () => {
        const answers = { deploymentTarget: 'managed-inference' };

        for (const name of batchPromptNames) {
            it(`${name} when() should return false for managed-inference`, () => {
                const prompt = findPrompt(infraBatchTransformPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('Batch prompts hidden for async-inference (Requirement 2.10)', () => {
        const answers = { deploymentTarget: 'async-inference' };

        for (const name of batchPromptNames) {
            it(`${name} when() should return false for async-inference`, () => {
                const prompt = findPrompt(infraBatchTransformPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('Batch prompts hidden for hyperpod-eks (Requirement 2.10)', () => {
        const answers = { deploymentTarget: 'hyperpod-eks' };

        for (const name of batchPromptNames) {
            it(`${name} when() should return false for hyperpod-eks`, () => {
                const prompt = findPrompt(infraBatchTransformPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('HyperPod prompts hidden for batch-transform (Requirement 2.10)', () => {
        const answers = { deploymentTarget: 'batch-transform' };

        for (const name of hyperPodPromptNames) {
            it(`${name} when() should return false for batch-transform`, () => {
                const prompt = findPrompt(infraHyperPodPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });

    describe('Async prompts hidden for batch-transform (Requirement 2.11)', () => {
        const answers = { deploymentTarget: 'batch-transform' };

        for (const name of asyncPromptNames) {
            it(`${name} when() should return false for batch-transform`, () => {
                const prompt = findPrompt(infraAsyncPrompts, name);
                assert.ok(prompt, `Prompt ${name} must exist`);
                assert.equal(evaluateWhen(prompt, answers), false);
            });
        }
    });
});
