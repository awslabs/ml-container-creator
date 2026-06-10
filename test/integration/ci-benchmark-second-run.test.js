// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Second-Run Integration Test (With One Proven Point)
 *
 * Verifies the substitution and nearest-neighbor logic when one proven config
 * already exists in Athena:
 *   - One proven config in Athena (e.g., transformers-vllm + qwen3 + g5)
 *   - Request a different config → verify substitution logic fires
 *   - Verify nearest-neighbor calculation returns correct result
 *   - Verify "no coverage" response when model_family differs
 *
 * Feature: ci-benchmark-pipeline
 * Task: 8.2 Second-run test
 * Requirements: 8.2, 8.3, 8.5
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import {
    findNearestSubstitution,
    hammingDistance,
    identifyGaps,
    CONFIG_DIMENSIONS
} from '../../src/lib/path-prover-brain.js';

// ── Test Data ────────────────────────────────────────────────────────────────

/**
 * The single proven config that exists in Athena after a successful first run.
 */
const PROVEN_CONFIG = {
    deployment_config: 'transformers-vllm',
    model_family: 'qwen3',
    instance_family: 'g5',
    quantization: 'none',
    tp_degree: '1',
    deployment_target: 'realtime-inference',
    status: 'completed',
    run_type: 'path_prove',
    run_timestamp: '2026-06-09T14:30:22Z',
    model_name: 'Qwen/Qwen3-4B',
    instance_type: 'ml.g5.xlarge',
    throughput_rps: 12.5,
    ttft_p50_ms: 45.2
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CI Benchmark Second-Run Integration', function () {
    this.timeout(30000);

    let provenConfigs;

    beforeEach(() => {
        provenConfigs = [PROVEN_CONFIG];
    });

    describe('Substitution logic fires for different config (same model_family)', () => {
        it('finds substitution when only deployment_config differs', () => {
            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions, 'Should find substitutions');
            assert.strictEqual(result.substitutions.length, 1);
            assert.strictEqual(result.substitutions[0].distance, 1);
            assert.strictEqual(result.substitutions[0].config.deployment_config, 'transformers-vllm');
        });

        it('finds substitution when instance_family differs', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g6e',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            assert.strictEqual(result.substitutions[0].distance, 1);
            assert.strictEqual(result.substitutions[0].config.instance_family, 'g5');
        });

        it('finds substitution when quantization differs', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'fp8',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            assert.strictEqual(result.substitutions[0].distance, 1);
        });

        it('finds substitution with distance 2 when two dimensions differ', () => {
            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g6e',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            assert.strictEqual(result.substitutions[0].distance, 2);
        });

        it('finds substitution with distance 3 when three dimensions differ', () => {
            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g6e',
                quantization: 'fp8',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            assert.strictEqual(result.substitutions[0].distance, 3);
        });
    });

    describe('Nearest-neighbor calculation correctness', () => {
        it('returns distance 0 for exact match', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            assert.strictEqual(result.substitutions[0].distance, 0);
        });

        it('Hamming distance counts only differing dimensions', () => {
            const configA = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };
            const configB = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g6e',
                quantization: 'fp8',
                tp_degree: '4',
                deployment_target: 'async-inference'
            };

            const distance = hammingDistance(configA, configB);
            assert.strictEqual(distance, 5, 'Should differ on 5 dimensions');
        });

        it('results are ordered by ascending distance', () => {
            // Add more proven configs at various distances
            const moreProven = [
                PROVEN_CONFIG,
                {
                    ...PROVEN_CONFIG,
                    deployment_config: 'transformers-sglang',
                    status: 'completed'
                },
                {
                    ...PROVEN_CONFIG,
                    deployment_config: 'transformers-sglang',
                    instance_family: 'g6e',
                    status: 'completed'
                }
            ];

            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g6e',
                quantization: 'fp8',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, moreProven);

            assert.ok(result.substitutions);
            assert.ok(result.substitutions.length >= 2);
            // Verify ascending order
            for (let i = 1; i < result.substitutions.length; i++) {
                assert.ok(
                    result.substitutions[i].distance >= result.substitutions[i - 1].distance,
                    'Results must be ordered by ascending distance'
                );
            }
        });

        it('explanation lists the differing dimensions', () => {
            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.substitutions);
            const explanation = result.substitutions[0].explanation;
            assert.ok(Array.isArray(explanation), 'Explanation should be an array');
            assert.ok(explanation.length > 0, 'Should explain at least one dimension change');
            // The explanation should mention deployment_config
            const hasDeploymentConfig = explanation.some(e =>
                e.toLowerCase().includes('deployment_config')
            );
            assert.ok(hasDeploymentConfig, 'Explanation should mention deployment_config difference');
        });
    });

    describe('"No coverage" response when model_family differs', () => {
        it('returns noMatch when requested model_family has no proven configs', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'llama3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.strictEqual(result.noMatch, true);
            assert.ok(result.message.includes('no coverage'));
        });

        it('noMatch message includes dimension distance for cross-family', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'llama3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.ok(result.message.includes('dimensions away'),
                'Message should indicate how far the nearest config is');
        });

        it('returns noMatch for completely unrelated model_family', () => {
            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'deepseek-r1',
                instance_family: 'p5',
                quantization: 'fp8',
                tp_degree: '8',
                deployment_target: 'async-inference'
            };

            const result = findNearestSubstitution(requested, provenConfigs);

            assert.strictEqual(result.noMatch, true);
        });

        it('never suggests a config from a different model_family', () => {
            // Add a proven config with different model_family
            const crossFamilyProven = [
                PROVEN_CONFIG,
                {
                    deployment_config: 'transformers-vllm',
                    model_family: 'llama3',
                    instance_family: 'g5',
                    quantization: 'none',
                    tp_degree: '1',
                    deployment_target: 'realtime-inference',
                    status: 'completed'
                }
            ];

            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'llama3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, crossFamilyProven);

            assert.ok(result.substitutions);
            // All suggestions must be from llama3 family
            for (const sub of result.substitutions) {
                assert.strictEqual(sub.config.model_family, 'llama3',
                    'Substitution must never cross model_family boundary');
            }
        });
    });

    describe('Gap identification with one proven point', () => {
        it('identifies gaps based on proven config dimension values', () => {
            // With a single proven point, gaps come from the observed dimension values
            const gaps = identifyGaps(provenConfigs);

            // With only one proven config, there are no gaps (all dimensions only have 1 value)
            // Gaps require at least 2 values in some dimension to generate combinations
            assert.deepStrictEqual(gaps, []);
        });

        it('identifies gaps when multiple dimension values are present', () => {
            const multipleProven = [
                PROVEN_CONFIG,
                {
                    deployment_config: 'transformers-sglang',
                    model_family: 'qwen3',
                    instance_family: 'g5',
                    quantization: 'none',
                    tp_degree: '1',
                    deployment_target: 'realtime-inference',
                    status: 'completed'
                }
            ];

            const gaps = identifyGaps(multipleProven);
            // With 2 deployment_configs and 1 of each other dimension, the cartesian
            // product is 2 combinations — both are already proven, so 0 gaps
            assert.deepStrictEqual(gaps, []);
        });

        it('identifies actual gaps when dimension space expands', () => {
            const multipleProven = [
                PROVEN_CONFIG,
                {
                    deployment_config: 'transformers-sglang',
                    model_family: 'qwen3',
                    instance_family: 'g6e',
                    quantization: 'none',
                    tp_degree: '1',
                    deployment_target: 'realtime-inference',
                    status: 'completed'
                }
            ];

            const gaps = identifyGaps(multipleProven);
            // Now we have 2 deployment_configs × 2 instance_families = 4 combinations
            // 2 are proven, so 2 are gaps:
            //   transformers-vllm + g6e  and  transformers-sglang + g5
            assert.ok(gaps.length > 0, 'Should identify gaps when combinations are unproven');
        });
    });

    describe('Only completed configs are used for substitution', () => {
        it('failed configs are excluded from substitution candidates', () => {
            const mixedConfigs = [
                { ...PROVEN_CONFIG, status: 'failed' },
                {
                    deployment_config: 'transformers-sglang',
                    model_family: 'qwen3',
                    instance_family: 'g5',
                    quantization: 'none',
                    tp_degree: '1',
                    deployment_target: 'realtime-inference',
                    status: 'completed'
                }
            ];

            const requested = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, mixedConfigs);

            assert.ok(result.substitutions);
            // Should only return the sglang config (completed), not the vllm (failed)
            assert.strictEqual(result.substitutions[0].config.deployment_config, 'transformers-sglang');
        });

        it('unfeasible configs are excluded from substitution candidates', () => {
            const unfeasibleConfigs = [
                { ...PROVEN_CONFIG, status: 'unfeasible' }
            ];

            const requested = {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference'
            };

            const result = findNearestSubstitution(requested, unfeasibleConfigs);

            assert.strictEqual(result.noMatch, true,
                'Unfeasible configs should not be suggested as substitutions');
        });
    });
});
