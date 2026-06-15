// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Always Generated Property-Based Tests
 *
 * Feature: lora-benchmark-simplification, Property 4: Test always generated for transformers/diffusors
 *
 * Validates: Requirements 3.1
 */

import fc from 'fast-check';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modulePrompts } from '../../src/lib/prompts/feature-prompts.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Backends used with transformers architecture */
const TRANSFORMERS_BACKENDS = ['vllm', 'sglang', 'lmi', 'djl', 'vllm-omni'];

/** Backends used with diffusors architecture */
// eslint-disable-next-line no-unused-vars -- reserved for Property 5 (non-skip architectures show testTypes prompt)
const DIFFUSORS_BACKENDS = ['vllm-omni'];

/** Non-transformers/diffusors architectures that SHOULD show the testTypes prompt */
// eslint-disable-next-line no-unused-vars -- reserved for Property 5
const NON_SKIP_ARCHITECTURES = ['triton', 'http'];

/** Backends for triton */
// eslint-disable-next-line no-unused-vars -- reserved for Property 5
const TRITON_BACKENDS = ['flask', 'fastapi', 'fil', 'onnxruntime', 'python'];

/** Backends for http */
// eslint-disable-next-line no-unused-vars -- reserved for Property 5
const HTTP_BACKENDS = ['flask', 'fastapi'];

// ── Property 4: Test always generated for transformers/diffusors ─────────────

describe('Feature: lora-benchmark-simplification, Property 4: Test always generated for transformers/diffusors', () => {

    it('for transformers/diffusors architectures, testTypes prompt is skipped (when returns false)', { timeout: 30000 }, () => {
        /**
         * **Validates: Requirements 3.1**
         */
        fc.assert(fc.property(
            fc.constantFrom('transformers', 'diffusors'),
            fc.constantFrom(...TRANSFORMERS_BACKENDS),
            (architecture, backend) => {
                const testTypesPrompt = modulePrompts[1]; // second prompt in array
                const result = testTypesPrompt.when({ architecture, backend, deploymentConfig: `${architecture}-${backend}` });
                assert.strictEqual(result, false, `testTypes prompt should be skipped for ${architecture}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });

    it('for non-transformers/diffusors architectures, testTypes prompt is shown (when returns true)', { timeout: 30000 }, () => {
        /**
         * **Validates: Requirements 3.1**
         */
        fc.assert(fc.property(
            fc.constantFrom('triton', 'http'),
            fc.constantFrom('flask', 'fastapi', 'fil', 'onnxruntime', 'python'),
            (architecture, backend) => {
                const testTypesPrompt = modulePrompts[1];
                const result = testTypesPrompt.when({ architecture, backend, deploymentConfig: `${architecture}-${backend}` });
                assert.strictEqual(result, true, `testTypes prompt should be shown for ${architecture}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });
});
