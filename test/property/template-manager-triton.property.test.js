// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager Triton Validation Property-Based Tests
 *
 * Property 6: TemplateManager Accepts All Valid Configs
 * Validates: Requirements 7.3, 2.1, 7.1
 *
 * Property 7: GPU Backend Validation Rejects CPU Instances
 * Validates: Requirements 7.2, 11.2
 *
 * Feature: triton-integration
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../src/lib/template-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/** All 14 valid deployment-config strings */
const ALL_VALID_CONFIGS = [
    'http-flask', 'http-fastapi',
    'transformers-vllm', 'transformers-sglang',
    'transformers-tensorrt-llm', 'transformers-lmi', 'transformers-djl',
    'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
    'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python'
];

/** GPU-requiring backends */
const GPU_REQUIRING_BACKENDS = ['triton-vllm', 'triton-tensorrtllm'];

/** CPU-only instance types for testing GPU rejection */
const CPU_ONLY_INSTANCES = ['ml.m5.xlarge', 'ml.c5.xlarge', 'ml.t3.large', 'ml.r5.xlarge'];

/** Base answers that satisfy all non-deploymentConfig validation */
const baseValidAnswers = {
    buildTarget: 'codebuild',
    deploymentTarget: 'managed-inference',
    awsRegion: 'us-east-1',
    awsRoleArn: ''
};

// ── Property 6: TemplateManager Accepts All Valid Configs ────────────────────

describe('TemplateManager Triton Validation Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting TemplateManager Triton Property Tests');
        console.log('📋 Testing: Valid config acceptance and GPU backend rejection');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Total configs: ${ALL_VALID_CONFIGS.length} (${GPU_REQUIRING_BACKENDS.length} GPU-requiring)\n`);
    });

    /**
     * Property 6: TemplateManager Accepts All Valid Configs
     *
     * **Validates: Requirements 7.3, 2.1, 7.1**
     *
     * For all 14 valid deployment-config strings (with GPU instance
     * for GPU-requiring backends), validate() does not throw.
     */
    describe('Property 6: TemplateManager Accepts All Valid Configs', () => {
        it('validate() does not throw for any valid deployment-config with appropriate instance type', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...ALL_VALID_CONFIGS),
                (deploymentConfig) => {
                    const instanceType = GPU_REQUIRING_BACKENDS.includes(deploymentConfig)
                        ? 'ml.g5.xlarge'
                        : 'ml.m5.large';

                    const answers = {
                        ...baseValidAnswers,
                        deploymentConfig,
                        instanceType
                    };

                    const manager = new TemplateManager(answers);
                    manager.validate();

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // ── Property 7: GPU Backend Validation Rejects CPU Instances ─────────────

    /**
     * Property 7: GPU Backend Validation Rejects CPU Instances
     *
     * **Validates: Requirements 7.2, 11.2**
     *
     * For triton-vllm and triton-tensorrtllm with CPU-only instance
     * types, validate() throws.
     */
    describe('Property 7: GPU Backend Validation Rejects CPU Instances', () => {
        it('validate() throws for GPU-requiring backends with CPU-only instance types', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...GPU_REQUIRING_BACKENDS),
                fc.constantFrom(...CPU_ONLY_INSTANCES),
                (deploymentConfig, instanceType) => {
                    const answers = {
                        ...baseValidAnswers,
                        deploymentConfig,
                        instanceType
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /requires a GPU instance type/,
                        `Expected validate() to throw for ${deploymentConfig} with ${instanceType}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
