// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager Diffusors GPU Enforcement Property-Based Tests
 *
 * Property 3: GPU Enforcement for Diffusors
 * Validates: Requirements 3.1, 3.2
 *
 * Feature: vllm-omni-diffusors
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../generators/app/lib/template-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/** CPU-only instance type family prefixes */
const CPU_FAMILY_PREFIXES = ['ml.m', 'ml.c', 'ml.t', 'ml.r'];

/** Instance sizes used for generating CPU-only instance types */
const INSTANCE_SIZES = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge'];

/**
 * Family generation numbers — digits only, matching the CPU_ONLY_INSTANCE_PATTERNS
 * regex /^ml\.[mctr][0-9]+\./ in template-manager.js
 */
const FAMILY_GENERATIONS = ['4', '5', '6', '7'];

/** GPU instance types that should pass validation */
const GPU_INSTANCES = [
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge', 'ml.g4dn.4xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge',
    'ml.p3.2xlarge', 'ml.p3.8xlarge',
    'ml.p4d.24xlarge'
];

/** Base answers that satisfy all non-deploymentConfig validation */
const baseValidAnswers = {
    buildTarget: 'codebuild',
    deploymentTarget: 'managed-inference',
    awsRegion: 'us-east-1',
    awsRoleArn: ''
};

/**
 * fast-check arbitrary that generates CPU-only instance type strings
 * matching ml.m*, ml.c*, ml.t*, or ml.r* patterns.
 */
const cpuOnlyInstanceArb = fc.tuple(
    fc.constantFrom(...CPU_FAMILY_PREFIXES),
    fc.constantFrom(...FAMILY_GENERATIONS),
    fc.constantFrom(...INSTANCE_SIZES)
).map(([prefix, gen, size]) => `${prefix}${gen}.${size}`);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TemplateManager Diffusors GPU Enforcement Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting TemplateManager Diffusors GPU Enforcement Property Tests');
        console.log('📋 Testing: GPU enforcement for diffusors-vllm-omni deployment config');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property\n`);
    });

    /**
     * Property 3: GPU Enforcement for Diffusors
     *
     * **Validates: Requirements 3.1, 3.2**
     *
     * For diffusors-vllm-omni combined with any CPU-only instance type
     * (matching ml.m*, ml.c*, ml.t*, or ml.r*), TemplateManager.validate()
     * rejects the configuration. For GPU instance types, validation passes.
     */
    describe('Property 3: GPU Enforcement for Diffusors', () => {

        it('validate() throws for diffusors-vllm-omni with any CPU-only instance type', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                cpuOnlyInstanceArb,
                (instanceType) => {
                    const answers = {
                        ...baseValidAnswers,
                        deploymentConfig: 'diffusors-vllm-omni',
                        instanceType
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /requires a GPU instance type/,
                        `Expected validate() to throw for diffusors-vllm-omni with ${instanceType}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('validate() passes for diffusors-vllm-omni with GPU instance types', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...GPU_INSTANCES),
                (instanceType) => {
                    const answers = {
                        ...baseValidAnswers,
                        deploymentConfig: 'diffusors-vllm-omni',
                        instanceType
                    };

                    const manager = new TemplateManager(answers);
                    manager.validate(); // should not throw

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
