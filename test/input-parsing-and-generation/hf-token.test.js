// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HuggingFace Token Feature Tests
 * 
 * Tests for HF token validation.
 * 
 * Feature: huggingface-token-authentication
 * 
 * NOTE: File generation tests are not included here.
 * This file focuses on token validation logic only.
 * 
 * Consolidates:
 * - hf-token-validation.test.js
 * - hf-token-dockerfile.test.js
 * - hf-token-integration.test.js
 * - hf-token-backward-compatibility.test.js
 * - hf-token-security-warning.test.js
 */

import { setupTestHooks } from './test-utils.js';
import { validateHFToken } from './validation-helpers.js';
import assert from 'assert';

describe('HuggingFace Token Feature', () => {
    setupTestHooks('HuggingFace Token Feature');

    describe('Token Validation', () => {
        it('should accept empty tokens', () => {
            assert.strictEqual(validateHFToken(''), true);
            assert.strictEqual(validateHFToken(null), true);
            assert.strictEqual(validateHFToken('   '), true);
        });

        it('should accept $HF_TOKEN reference', () => {
            assert.strictEqual(validateHFToken('$HF_TOKEN'), true);
            assert.strictEqual(validateHFToken('  $HF_TOKEN  '), true);
        });

        it('should accept tokens with hf_ prefix', () => {
            assert.strictEqual(validateHFToken('hf_abc123'), true);
            assert.strictEqual(validateHFToken('hf_XYZ789'), true);
            assert.strictEqual(validateHFToken(`hf_${  'a'.repeat(40)}`), true);
        });

        it('should warn for tokens without hf_ prefix', () => {
            const originalWarn = console.warn;
            let warned = false;
            console.warn = () => { warned = true; };
            
            validateHFToken('invalid_token');
            console.warn = originalWarn;
            
            assert.strictEqual(warned, true);
        });

        it('should not warn for valid tokens', () => {
            const originalWarn = console.warn;
            let warned = false;
            console.warn = () => { warned = true; };
            
            validateHFToken('hf_validtoken123');
            console.warn = originalWarn;
            
            assert.strictEqual(warned, false);
        });
    });
});
