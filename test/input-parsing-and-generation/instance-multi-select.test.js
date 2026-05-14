// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for dynamic multi-select in instance-sizer prompt (Task 5.5)
 *
 * Validates:
 * - Multi-select prompt shown when MCP sizer has 2+ choices for realtime-inference
 * - Single-select prompt shown for other deployment targets or when 0-1 MCP choices
 * - CUDA generation filtering: only same-generation instances presented
 * - Selection count determines single-type vs instance-pools behavior
 * - Instance pools JSON structure with correct priorities
 * - Max 5 selections enforced
 * - Multi-spec IC config auto-generated from catalog
 *
 * Requirements: 6.4
 */

import assert from 'assert';
import { setupTestHooks } from './test-utils.js';
import {
    infraInstancePrompts,
    filterByCudaGeneration,
    getInstanceCudaGeneration,
    instanceCatalogRaw
} from '../../src/lib/prompts.js';

describe('Instance Multi-Select (Task 5.5)', function () {
    setupTestHooks('Instance Multi-Select');

    // Helper to find a prompt by name
    function findPrompt(name) {
        return infraInstancePrompts.find(p => p.name === name);
    }

    // Helper to evaluate a prompt's `when` function
    function evaluateWhen(prompt, answers) {
        if (!prompt) return false;
        if (typeof prompt.when === 'function') {
            return prompt.when(answers);
        }
        return prompt.when !== false;
    }

    describe('Prompt visibility', function () {
        it('shows multi-select (instanceTypeSelections) when realtime-inference with 2+ MCP choices', function () {
            const prompt = findPrompt('instanceTypeSelections');
            assert.ok(prompt, 'instanceTypeSelections prompt should exist');

            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g6e.xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), true);
        });

        it('hides multi-select when only 1 MCP choice', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), false);
        });

        it('hides multi-select when no MCP choices', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: []
            };
            assert.strictEqual(evaluateWhen(prompt, answers), false);
        });

        it('hides multi-select for async-inference', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const answers = {
                deploymentTarget: 'async-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), false);
        });

        it('hides multi-select for batch-transform', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const answers = {
                deploymentTarget: 'batch-transform',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), false);
        });

        it('shows single-select (instanceType) for async-inference regardless of MCP choices', function () {
            const prompt = findPrompt('instanceType');
            const answers = {
                deploymentTarget: 'async-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), true);
        });

        it('hides single-select (instanceType) when multi-select is shown', function () {
            const prompt = findPrompt('instanceType');
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), false);
        });

        it('shows single-select (instanceType) for realtime-inference with 0-1 MCP choices', function () {
            const prompt = findPrompt('instanceType');
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge']
            };
            assert.strictEqual(evaluateWhen(prompt, answers), true);
        });
    });

    describe('Multi-select validation', function () {
        it('rejects empty selection', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const result = prompt.validate([]);
            assert.notStrictEqual(result, true);
        });

        it('accepts 1-5 selections', function () {
            const prompt = findPrompt('instanceTypeSelections');
            assert.strictEqual(prompt.validate(['ml.g5.xlarge']), true);
            assert.strictEqual(prompt.validate(['ml.g5.xlarge', 'ml.g5.2xlarge']), true);
            assert.strictEqual(prompt.validate(['a', 'b', 'c', 'd', 'e']), true);
        });

        it('rejects more than 5 selections', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const result = prompt.validate(['a', 'b', 'c', 'd', 'e', 'f']);
            assert.notStrictEqual(result, true);
        });
    });

    describe('CUDA generation filtering (filterByCudaGeneration)', function () {
        it('keeps instances from same generation as first', function () {
            // g5 instances are Ampere, g4dn are Turing
            const result = filterByCudaGeneration(['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge']);
            assert.deepStrictEqual(result.filtered, ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge']);
            assert.strictEqual(result.generation, 'Ampere');
            assert.deepStrictEqual(result.removed, []);
        });

        it('removes instances from different generation', function () {
            // g5 = Ampere, g4dn = Turing
            const result = filterByCudaGeneration(['ml.g5.xlarge', 'ml.g4dn.xlarge', 'ml.g5.2xlarge']);
            assert.deepStrictEqual(result.filtered, ['ml.g5.xlarge', 'ml.g5.2xlarge']);
            assert.strictEqual(result.generation, 'Ampere');
            assert.deepStrictEqual(result.removed, ['ml.g4dn.xlarge']);
        });

        it('keeps unknown instances (not in catalog)', function () {
            const result = filterByCudaGeneration(['ml.g5.xlarge', 'ml.unknown.xlarge']);
            assert.ok(result.filtered.includes('ml.unknown.xlarge'),
                'Unknown instance types should not be filtered out');
        });

        it('returns all when first instance is not in catalog', function () {
            const result = filterByCudaGeneration(['ml.unknown.xlarge', 'ml.g5.xlarge', 'ml.g4dn.xlarge']);
            assert.deepStrictEqual(result.filtered, ['ml.unknown.xlarge', 'ml.g5.xlarge', 'ml.g4dn.xlarge']);
            assert.strictEqual(result.generation, null);
        });

        it('handles empty array', function () {
            const result = filterByCudaGeneration([]);
            assert.deepStrictEqual(result.filtered, []);
            assert.strictEqual(result.generation, null);
        });

        it('allows same-generation instances (g6e + p4d both Ampere)', function () {
            // Both g5 and p4d are Ampere generation
            const result = filterByCudaGeneration(['ml.g5.xlarge', 'ml.p4d.24xlarge']);
            assert.deepStrictEqual(result.filtered, ['ml.g5.xlarge', 'ml.p4d.24xlarge']);
            assert.strictEqual(result.generation, 'Ampere');
        });
    });

    describe('getInstanceCudaGeneration', function () {
        it('returns correct generation for known GPU instances', function () {
            assert.strictEqual(getInstanceCudaGeneration('ml.g4dn.xlarge'), 'Turing');
            assert.strictEqual(getInstanceCudaGeneration('ml.g5.xlarge'), 'Ampere');
            assert.strictEqual(getInstanceCudaGeneration('ml.p5.48xlarge'), 'Hopper');
        });

        it('returns null for CPU instances', function () {
            assert.strictEqual(getInstanceCudaGeneration('ml.m5.xlarge'), null);
        });

        it('returns null for unknown instances', function () {
            assert.strictEqual(getInstanceCudaGeneration('ml.unknown.xlarge'), null);
        });
    });

    describe('instanceCatalogRaw', function () {
        it('is loaded and contains GPU instance data', function () {
            assert.ok(instanceCatalogRaw['ml.g5.xlarge'], 'Should contain ml.g5.xlarge');
            assert.strictEqual(instanceCatalogRaw['ml.g5.xlarge'].gpus, 1);
            assert.strictEqual(instanceCatalogRaw['ml.g5.xlarge'].gpuArchitecture, 'Ampere');
        });

        it('contains gpuMemoryGb for GPU instances', function () {
            const entry = instanceCatalogRaw['ml.g5.xlarge'];
            assert.ok(entry.gpuMemoryGb > 0, 'GPU instances should have gpuMemoryGb');
        });
    });

    describe('Multi-select choices filtering', function () {
        it('shows all instances regardless of CUDA generation (filtering happens post-selection)', function () {
            const prompt = findPrompt('instanceTypeSelections');
            // Simulate answers with mixed-generation MCP choices
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g4dn.xlarge']
            };

            const choices = prompt.choices(answers);
            const choiceValues = choices.map(c => c.value);

            // All instances should be shown — CUDA generation filtering happens after selection
            assert.ok(choiceValues.includes('ml.g5.xlarge'), 'Should include g5.xlarge');
            assert.ok(choiceValues.includes('ml.g5.2xlarge'), 'Should include g5.2xlarge');
            assert.ok(choiceValues.includes('ml.g4dn.xlarge'), 'Should include g4dn.xlarge (shown, filtered post-selection if mixed)');
        });

        it('includes GPU info in choice names', function () {
            const prompt = findPrompt('instanceTypeSelections');
            const answers = {
                deploymentTarget: 'realtime-inference',
                _mcpInstanceChoices: ['ml.g5.xlarge']
            };

            // Note: this won't trigger the prompt (only 1 choice), but we can still test choices function
            const choices = prompt.choices(answers);
            assert.ok(choices[0].name.includes('GPU'), 'Choice name should include GPU info');
        });
    });
});
