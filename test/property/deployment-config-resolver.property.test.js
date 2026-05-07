// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DeploymentConfigResolver Property-Based Tests
 *
 * Verifies universal correctness properties of the DeploymentConfigResolver
 * component: round-trip identity, architecture consistency, isValid correctness,
 * old format rejection, and getConfigsForArchitecture consistency.
 *
 * Feature: triton-integration, vllm-omni-diffusors
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import DeploymentConfigResolver from '../../src/lib/deployment-config-resolver.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

describe('DeploymentConfigResolver Property-Based Tests', () => {

    let resolver;
    let allConfigs;
    let tritonConfigs;
    let diffusorsConfigs;
    let validArchitectures;

    before(() => {
        resolver = new DeploymentConfigResolver();
        allConfigs = resolver.getAllConfigs();
        tritonConfigs = allConfigs.filter(dc => dc.startsWith('triton-'));
        diffusorsConfigs = allConfigs.filter(dc => dc.startsWith('diffusors-'));
        validArchitectures = ['http', 'transformers', 'triton', 'diffusors'];

        console.log('\n🚀 Starting DeploymentConfigResolver Property Tests');
        console.log('📋 Testing: Universal correctness properties for deployment-config resolution');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Total configs: ${allConfigs.length} (${tritonConfigs.length} triton, ${diffusorsConfigs.length} diffusors)\n`);
    });

    /**
     * Property 1: Decompose/Compose Round-Trip Identity
     *
     * Validates: Requirements 1.1, 1.2
     *
     * For all 15 valid deployment-config strings,
     * compose(decompose(dc)) === dc
     */
    describe('Property 1: Decompose/Compose Round-Trip Identity', () => {
        it('compose(decompose(dc)) === dc for all valid deployment-config strings', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...allConfigs),
                (dc) => {
                    const parts = resolver.decompose(dc);
                    const roundTripped = resolver.compose(parts);

                    assert.strictEqual(
                        roundTripped,
                        dc,
                        `Round-trip failed for '${dc}': compose(decompose('${dc}')) === '${roundTripped}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    /**
     * Property 2: Validity Consistency
     *
     * Validates: Requirements 1.5, 1.6
     *
     * isValid(dc) === true iff decompose(dc) does not throw.
     * Also verifies diffusors-vllm-omni is valid and unsupported
     * diffusors configs like diffusors-comfyui are invalid.
     */
    describe('Property 2: Validity Consistency', () => {
        it('isValid(dc) === true iff decompose(dc) does not throw for valid configs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...allConfigs),
                (dc) => {
                    const valid = resolver.isValid(dc);
                    let decomposeSucceeded;
                    try {
                        resolver.decompose(dc);
                        decomposeSucceeded = true;
                    } catch {
                        decomposeSucceeded = false;
                    }

                    assert.strictEqual(
                        valid,
                        decomposeSucceeded,
                        `Consistency violation for '${dc}': isValid=${valid}, decompose succeeded=${decomposeSucceeded}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('isValid(s) === false implies decompose(s) throws for arbitrary strings', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 50 }),
                (s) => {
                    const valid = resolver.isValid(s);
                    let decomposeSucceeded;
                    try {
                        resolver.decompose(s);
                        decomposeSucceeded = true;
                    } catch {
                        decomposeSucceeded = false;
                    }

                    assert.strictEqual(
                        valid,
                        decomposeSucceeded,
                        `Consistency violation for '${s}': isValid=${valid}, decompose succeeded=${decomposeSucceeded}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('diffusors-vllm-omni is valid and decomposes without error', () => {
            assert.strictEqual(resolver.isValid('diffusors-vllm-omni'), true);
            const parts = resolver.decompose('diffusors-vllm-omni');
            assert.strictEqual(parts.architecture, 'diffusors');
            assert.strictEqual(parts.backend, 'vllm-omni');
            assert.strictEqual(parts.engine, null);
        });

        it('unsupported diffusors configs like diffusors-comfyui are invalid', () => {
            const unsupportedDiffusors = [
                'diffusors-comfyui',
                'diffusors-diffusers',
                'diffusors-automatic1111',
                'diffusors-invokeai'
            ];

            for (const dc of unsupportedDiffusors) {
                assert.strictEqual(
                    resolver.isValid(dc),
                    false,
                    `Expected isValid('${dc}') to be false`
                );
                assert.throws(
                    () => resolver.decompose(dc),
                    /Unsupported deployment-config/,
                    `Expected decompose('${dc}') to throw`
                );
            }
        });
    });

    /**
     * Property 2b: Architecture Consistency for Triton Configs
     *
     * Validates: Requirements 2.2, 1.1
     *
     * For all 7 triton-* configs, decompose(dc).architecture === 'triton'
     */
    describe('Property 2: Architecture Consistency for Triton Configs', () => {
        it('decompose(dc).architecture === "triton" for all triton-* configs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...tritonConfigs),
                (dc) => {
                    const parts = resolver.decompose(dc);

                    assert.strictEqual(
                        parts.architecture,
                        'triton',
                        `Architecture mismatch for '${dc}': expected 'triton', got '${parts.architecture}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    /**
     * Property 3: isValid Correctness
     *
     * Validates: Requirements 1.6, 1.7, 2.4
     *
     * isValid(s) returns true iff s is one of the 15 valid configs;
     * false for everything else including old-format strings.
     */
    describe('Property 3: isValid Correctness', () => {
        it('isValid returns true for all 15 valid configs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...allConfigs),
                (dc) => {
                    assert.strictEqual(
                        resolver.isValid(dc),
                        true,
                        `Expected isValid('${dc}') to be true`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('isValid returns false for arbitrary non-canonical strings', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const validSet = new Set(allConfigs);

            fc.assert(fc.property(
                fc.string({ minLength: 0, maxLength: 50 }),
                (s) => {
                    if (validSet.has(s)) {
                        // If fast-check happens to generate a valid config, isValid should be true
                        assert.strictEqual(resolver.isValid(s), true);
                    } else {
                        assert.strictEqual(
                            resolver.isValid(s),
                            false,
                            `Expected isValid('${s}') to be false for non-canonical string`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    /**
     * Property 4: Old Format Rejection
     *
     * Validates: Requirement 1.7
     *
     * For all 6 old-format strings, isValid(dc) returns false.
     */
    describe('Property 4: Old Format Rejection', () => {
        it('isValid returns false for all old-format deployment-config strings', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const oldFormatConfigs = [
                'sklearn-flask',
                'sklearn-fastapi',
                'xgboost-flask',
                'xgboost-fastapi',
                'tensorflow-flask',
                'tensorflow-fastapi'
            ];

            fc.assert(fc.property(
                fc.constantFrom(...oldFormatConfigs),
                (dc) => {
                    assert.strictEqual(
                        resolver.isValid(dc),
                        false,
                        `Expected isValid('${dc}') to be false for old-format config`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    /**
     * Property 5: getConfigsForArchitecture Consistency
     *
     * Validates: Requirement 1.5
     *
     * For any valid architecture a and any config dc returned by
     * getConfigsForArchitecture(a), decompose(dc).architecture === a
     */
    describe('Property 5: getConfigsForArchitecture Consistency', () => {
        it('every config returned by getConfigsForArchitecture(a) decomposes to architecture a', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...validArchitectures),
                (architecture) => {
                    const configs = resolver.getConfigsForArchitecture(architecture);

                    for (const dc of configs) {
                        const parts = resolver.decompose(dc);
                        assert.strictEqual(
                            parts.architecture,
                            architecture,
                            `getConfigsForArchitecture('${architecture}') returned '${dc}' but decompose gives architecture '${parts.architecture}'`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
