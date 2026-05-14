// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for endpoint-picker prompt definitions.
 *
 * Verifies:
 * - useExistingEndpoint prompt only shown for realtime-inference
 * - existingEndpointName prompt only shown when user selects "yes"
 * - customExistingEndpointName prompt only shown when user selects "custom"
 * - Prompt choices include MCP endpoint choices when available
 *
 * Validates: Requirements 3.3, 4.3, 4.4
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import { infraExistingEndpointPrompts } from '../../src/lib/prompts.js';

describe('Endpoint Picker Prompt Definitions', () => {
    before(() => {
        console.log('\n🚀 Starting Endpoint Picker Prompt Definition Tests');
        console.log('📋 Testing: Requirements 3.3, 4.3, 4.4');
        console.log('🔧 Configuration: Prompt definition validation\n');
    });

    it('should export infraExistingEndpointPrompts with 3 prompts', () => {
        assert.ok(Array.isArray(infraExistingEndpointPrompts), 'infraExistingEndpointPrompts must be an array');
        assert.strictEqual(infraExistingEndpointPrompts.length, 3, 'Must have 3 prompts (useExisting, endpointName, customName)');
    });

    describe('useExistingEndpoint prompt', () => {
        const prompt = infraExistingEndpointPrompts[0];

        it('should have correct name and type', () => {
            assert.strictEqual(prompt.name, 'useExistingEndpoint');
            assert.strictEqual(prompt.type, 'list');
        });

        it('should only show for realtime-inference deployment target', () => {
            assert.ok(prompt.when({ deploymentTarget: 'realtime-inference' }),
                'Should show for realtime-inference');
            assert.ok(!prompt.when({ deploymentTarget: 'async-inference' }),
                'Should NOT show for async-inference');
            assert.ok(!prompt.when({ deploymentTarget: 'batch-transform' }),
                'Should NOT show for batch-transform');
            assert.ok(!prompt.when({ deploymentTarget: 'hyperpod-eks' }),
                'Should NOT show for hyperpod-eks');
        });

        it('should default to "no" (create new endpoint)', () => {
            assert.strictEqual(prompt.default, 'no');
        });

        it('should have Yes and No choices', () => {
            assert.strictEqual(prompt.choices.length, 2);
            assert.strictEqual(prompt.choices[0].value, 'no');
            assert.strictEqual(prompt.choices[1].value, 'yes');
        });
    });

    describe('existingEndpointName prompt', () => {
        const prompt = infraExistingEndpointPrompts[1];

        it('should have correct name and type', () => {
            assert.strictEqual(prompt.name, 'existingEndpointName');
            assert.strictEqual(prompt.type, 'list');
        });

        it('should only show when user selects "yes" for useExistingEndpoint', () => {
            assert.ok(prompt.when({ useExistingEndpoint: 'yes' }),
                'Should show when useExistingEndpoint is yes');
            assert.ok(!prompt.when({ useExistingEndpoint: 'no' }),
                'Should NOT show when useExistingEndpoint is no');
        });

        it('should include MCP endpoint choices when available', () => {
            const mcpChoices = [
                { name: 'ep-1 (ml.g5.2xlarge, 4 GPUs free)', value: 'ep-1' },
                { name: 'ep-2 (ml.g6e.48xlarge, 6 GPUs free)', value: 'ep-2' }
            ];
            const choices = prompt.choices({ _mcpEndpointChoices: mcpChoices });
            assert.strictEqual(choices.length, 3, 'Should have MCP choices + Custom option');
            assert.strictEqual(choices[0].value, 'ep-1');
            assert.strictEqual(choices[1].value, 'ep-2');
            assert.strictEqual(choices[2].value, 'custom');
        });

        it('should show manual entry when no MCP choices available', () => {
            const choices = prompt.choices({ _mcpEndpointChoices: [] });
            assert.strictEqual(choices.length, 1);
            assert.strictEqual(choices[0].value, 'custom');
        });

        it('should show manual entry when _mcpEndpointChoices is undefined', () => {
            const choices = prompt.choices({});
            assert.strictEqual(choices.length, 1);
            assert.strictEqual(choices[0].value, 'custom');
        });
    });

    describe('customExistingEndpointName prompt', () => {
        const prompt = infraExistingEndpointPrompts[2];

        it('should have correct name and type', () => {
            assert.strictEqual(prompt.name, 'customExistingEndpointName');
            assert.strictEqual(prompt.type, 'input');
        });

        it('should only show when user selects "custom" endpoint', () => {
            assert.ok(prompt.when({ useExistingEndpoint: 'yes', existingEndpointName: 'custom' }),
                'Should show when endpoint is custom');
            assert.ok(!prompt.when({ useExistingEndpoint: 'yes', existingEndpointName: 'ep-1' }),
                'Should NOT show when a real endpoint is selected');
            assert.ok(!prompt.when({ useExistingEndpoint: 'no', existingEndpointName: 'custom' }),
                'Should NOT show when useExistingEndpoint is no');
        });

        it('should validate non-empty input', () => {
            assert.notStrictEqual(prompt.validate(''), true, 'Empty string should fail validation');
            assert.notStrictEqual(prompt.validate('   '), true, 'Whitespace should fail validation');
            assert.strictEqual(prompt.validate('my-endpoint-name'), true, 'Valid name should pass');
        });
    });
});
