// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deprecated Flag Acceptance Property-Based Tests
 *
 * Feature: lora-benchmark-simplification, Property 5: Deprecated flags accepted without error
 *
 * Validates: Requirements 4.3
 */

import fc from 'fast-check';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** LoRA-capable backends */
const LORA_COMPATIBLE_BACKENDS = ['vllm', 'sglang', 'djl-lmi', 'lmi', 'djl'];

/** All backends to test */
const ALL_BACKENDS = ['vllm', 'sglang', 'djl-lmi', 'lmi', 'djl', 'tensorrt-llm', 'flask'];

// ── Property 5: Deprecated flags accepted without error ──────────────────────

describe('Feature: lora-benchmark-simplification, Property 5: Deprecated flags accepted without error', () => {

    it('for any deprecated flag value, _ensureTemplateVariables does not throw and produces correct output', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 4.3**
         *
         * For any deprecated CLI flag (--enable-lora, --include-benchmark), passing it
         * to the CLI SHALL not produce an error and execution SHALL continue normally.
         *
         * We test this by simulating the effect of deprecated flags being passed:
         * setting enableLora and includeBenchmark to arbitrary values in the answers
         * object, then verifying that _ensureTemplateVariables resolves without error
         * and produces the correct canonical output regardless of the deprecated flag values.
         */
        await fc.assert(fc.asyncProperty(
            fc.option(fc.boolean()),  // enableLora flag value (or null = not passed)
            fc.option(fc.boolean()),  // includeBenchmark flag value (or null = not passed)
            fc.constantFrom(...ALL_BACKENDS),
            async (enableLoraFlag, includeBenchmarkFlag, backend) => {
                const answers = {
                    projectName: 'test',
                    architecture: 'transformers',
                    backend,
                    modelServer: backend,
                    deploymentConfig: `transformers-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference'
                };

                // Simulate deprecated flags being passed with arbitrary values
                if (enableLoraFlag !== null) answers.enableLora = enableLoraFlag;
                if (includeBenchmarkFlag !== null) answers.includeBenchmark = includeBenchmarkFlag;

                // Should never throw regardless of what deprecated flags pass
                await _ensureTemplateVariables(answers, null);

                // Verify correct behavior: resolver overrides deprecated flag values
                const isLoraCapable = LORA_COMPATIBLE_BACKENDS.includes(backend);
                assert.strictEqual(answers.enableLora, isLoraCapable,
                    `enableLora must be ${isLoraCapable} for backend "${backend}" regardless of deprecated flag value ${enableLoraFlag}`);
                assert.strictEqual(answers.includeBenchmark, true,
                    `includeBenchmark must always be true regardless of deprecated flag value ${includeBenchmarkFlag}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });
});
