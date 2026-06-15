// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LoRA & Benchmark Defaults Property-Based Tests
 *
 * Feature: lora-benchmark-simplification, Property 1: LoRA always enabled for compatible backends
 * Feature: lora-benchmark-simplification, Property 2: LoRA excluded for incompatible backends
 * Feature: lora-benchmark-simplification, Property 3: Benchmark always generated
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 2.2
 */

import fc from 'fast-check';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Backends that support LoRA (should always get enableLora=true) */
const LORA_COMPATIBLE_BACKENDS = ['vllm', 'sglang', 'djl-lmi', 'lmi', 'djl'];

/** Backends that do NOT support LoRA (should always get enableLora=false) */
const LORA_INCOMPATIBLE_BACKENDS = [
    'tensorrt-llm', 'flask', 'fastapi', 'fil', 'onnxruntime',
    'tensorflow', 'pytorch', 'python', 'vllm-omni'
];

/** Architectures used in generation */
const ARCHITECTURES = ['transformers', 'diffusors', 'triton', 'http'];

/** Test type selections a user might make */
const TEST_TYPE_OPTIONS = ['local-model-cli', 'local-model-server', 'hosted-model-endpoint', ''];

// ── Property 1: LoRA always enabled for compatible backends ──────────────────

describe('Feature: lora-benchmark-simplification, Property 1: LoRA always enabled for compatible backends', () => {

    it('for any LoRA-compatible backend, enableLora is always true after resolution', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 1.1, 1.2**
         */
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...LORA_COMPATIBLE_BACKENDS),
            fc.constantFrom(...ARCHITECTURES),
            fc.constantFrom('test-project', 'my-model-server', 'llm-inference'),
            async (backend, architecture, projectName) => {
                const answers = {
                    projectName,
                    architecture,
                    backend,
                    modelServer: backend,
                    deploymentConfig: `${architecture}-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference'
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.enableLora, true,
                    `enableLora must be true for backend "${backend}" but got ${answers.enableLora}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });

    it('for any LoRA-compatible backend, maxLoras defaults to 30 and maxLoraRank defaults to 64', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 1.1, 1.2**
         */
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...LORA_COMPATIBLE_BACKENDS),
            async (backend) => {
                const answers = {
                    projectName: 'test-project',
                    architecture: 'transformers',
                    backend,
                    modelServer: backend,
                    deploymentConfig: `transformers-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference'
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.maxLoras, 30,
                    `maxLoras must default to 30 for backend "${backend}" but got ${answers.maxLoras}`);
                assert.strictEqual(answers.maxLoraRank, 64,
                    `maxLoraRank must default to 64 for backend "${backend}" but got ${answers.maxLoraRank}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });
});

// ── Property 2: LoRA excluded for incompatible backends ──────────────────────

describe('Feature: lora-benchmark-simplification, Property 2: LoRA excluded for incompatible backends', () => {

    it('for any LoRA-incompatible backend, enableLora is always false after resolution', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 1.5**
         */
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...LORA_INCOMPATIBLE_BACKENDS),
            fc.constantFrom(...ARCHITECTURES),
            async (backend, architecture) => {
                const answers = {
                    projectName: 'test-project',
                    architecture,
                    backend,
                    modelServer: backend,
                    deploymentConfig: `${architecture}-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference'
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.enableLora, false,
                    `enableLora must be false for incompatible backend "${backend}" but got ${answers.enableLora}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });

    it('for any LoRA-incompatible backend, enableLora remains false even if previously set to true', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 1.5**
         */
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...LORA_INCOMPATIBLE_BACKENDS),
            async (backend) => {
                const answers = {
                    projectName: 'test-project',
                    architecture: 'transformers',
                    backend,
                    modelServer: backend,
                    deploymentConfig: `transformers-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference',
                    enableLora: true // explicitly set to true — resolver should override
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.enableLora, false,
                    `enableLora must be overridden to false for incompatible backend "${backend}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });
});

// ── Property 3: Benchmark always generated ───────────────────────────────────

describe('Feature: lora-benchmark-simplification, Property 3: Benchmark always generated', () => {

    it('for any combination of testTypes, includeBenchmark is always true', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 2.2**
         */
        await fc.assert(fc.asyncProperty(
            fc.subarray(TEST_TYPE_OPTIONS),
            fc.constantFrom(...LORA_COMPATIBLE_BACKENDS, ...LORA_INCOMPATIBLE_BACKENDS),
            fc.constantFrom(...ARCHITECTURES),
            async (testTypes, backend, architecture) => {
                const answers = {
                    projectName: 'test-project',
                    architecture,
                    backend,
                    modelServer: backend,
                    deploymentConfig: `${architecture}-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference',
                    testTypes: testTypes.filter(t => t !== '')
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.includeBenchmark, true,
                    `includeBenchmark must always be true regardless of testTypes ${JSON.stringify(testTypes)}, but got ${answers.includeBenchmark}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });

    it('for any backend and architecture, includeBenchmark is true even when explicitly set to false', { timeout: 30000 }, async () => {
        /**
         * **Validates: Requirements 2.2**
         */
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...LORA_COMPATIBLE_BACKENDS, ...LORA_INCOMPATIBLE_BACKENDS),
            fc.constantFrom(...ARCHITECTURES),
            async (backend, architecture) => {
                const answers = {
                    projectName: 'test-project',
                    architecture,
                    backend,
                    modelServer: backend,
                    deploymentConfig: `${architecture}-${backend}`,
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.g5.xlarge',
                    deploymentTarget: 'realtime-inference',
                    includeBenchmark: false // explicitly set to false — resolver should override
                };

                await _ensureTemplateVariables(answers, null);

                assert.strictEqual(answers.includeBenchmark, true,
                    `includeBenchmark must be overridden to true for backend "${backend}", architecture "${architecture}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns });
    });
});
