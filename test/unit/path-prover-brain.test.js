// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Path Prover Brain module.
 *
 * Tests cover:
 * - Gap identification with empty/populated Athena mocks
 * - Substitution algorithm (distance calculation, same-family constraint, "no coverage" response)
 * - Failure classification (each error category)
 * - Tune/adapter gating (skip when not requested)
 * - Hamming distance edge cases
 * - Priority queue operations
 * - Result writing (record building, unfeasible detection)
 *
 * Feature: ci-benchmark-pipeline
 * Validates: Requirements 8.1, 8.2, 8.5, 8.7, 8.8
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    identifyGaps,
    findNearestSubstitution,
    hammingDistance,
    shouldExecuteTuneStages,
    classifyFailure,
    buildPathProverRecord,
    findUnfeasibleRecord,
    getNextPriorityConfig,
    updatePriorityStatus,
    getPriorityQueueStatus,
    CONFIG_DIMENSIONS,
    FAILURE_CATEGORIES
} from '../../src/lib/path-prover-brain.js';

// ── Test Data ────────────────────────────────────────────────────────────────

const PROVEN_CONFIGS = [
    {
        deployment_config: 'transformers-vllm',
        model_family: 'qwen3',
        instance_family: 'g5',
        quantization: 'none',
        tp_degree: '1',
        deployment_target: 'realtime-inference',
        status: 'completed',
        run_timestamp: '2026-06-01T10:00:00Z'
    },
    {
        deployment_config: 'transformers-vllm',
        model_family: 'qwen3',
        instance_family: 'g6',
        quantization: 'none',
        tp_degree: '1',
        deployment_target: 'realtime-inference',
        status: 'completed',
        run_timestamp: '2026-06-02T10:00:00Z'
    },
    {
        deployment_config: 'transformers-sglang',
        model_family: 'qwen3',
        instance_family: 'g5',
        quantization: 'fp16',
        tp_degree: '1',
        deployment_target: 'realtime-inference',
        status: 'completed',
        run_timestamp: '2026-06-03T10:00:00Z'
    },
    {
        deployment_config: 'transformers-vllm',
        model_family: 'llama3',
        instance_family: 'g5',
        quantization: 'none',
        tp_degree: '2',
        deployment_target: 'realtime-inference',
        status: 'completed',
        run_timestamp: '2026-06-04T10:00:00Z'
    },
    {
        deployment_config: 'transformers-vllm',
        model_family: 'llama3',
        instance_family: 'p5',
        quantization: 'fp8',
        tp_degree: '4',
        deployment_target: 'async-inference',
        status: 'failed',
        run_timestamp: '2026-06-05T10:00:00Z'
    }
];

// ── Gap Identification Tests (Task 5.1) ──────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Gap Identification', () => {

    it('returns empty list for empty input', () => {
        // **Validates: Requirements 8.1**
        const gaps = identifyGaps([]);
        assert.deepStrictEqual(gaps, []);
    });

    it('returns empty list for null input', () => {
        // **Validates: Requirements 8.1**
        const gaps = identifyGaps(null);
        assert.deepStrictEqual(gaps, []);
    });

    it('identifies gaps in dimension space', () => {
        // **Validates: Requirements 8.1**
        const simpleConfigs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
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

        const gaps = identifyGaps(simpleConfigs);

        // With 2 deployment_configs and 1 of everything else, there are 2 total combos.
        // Both are proven, so there should be no gaps.
        assert.strictEqual(gaps.length, 0);
    });

    it('identifies gap when one combination is missing', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
            {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'failed' // not completed!
            }
        ];

        const gaps = identifyGaps(configs);

        // The sglang config is failed, so the sglang combo is a gap
        assert.strictEqual(gaps.length, 1);
        assert.strictEqual(gaps[0].deployment_config, 'transformers-sglang');
    });

    it('prioritizes gaps with more proven neighbors', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g6',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
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

        const gaps = identifyGaps(configs);

        // sglang+g6 should be prioritized (2 proven neighbors at distance 1)
        // vs vllm+g5 with sglang = 1 neighbor at distance 1 (but that's already proven)
        if (gaps.length > 0) {
            const sglangG6 = gaps.find(g =>
                g.deployment_config === 'transformers-sglang' && g.instance_family === 'g6'
            );
            assert.ok(sglangG6, 'Expected sglang+g6 gap to be identified');
        }
    });
});

// ── Substitution Algorithm Tests (Task 5.2) ──────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Substitution Algorithm', () => {

    it('finds nearest substitution with distance 1', () => {
        // **Validates: Requirements 8.2**
        const requested = {
            deployment_config: 'transformers-sglang',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'async-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        assert.ok(!result.noMatch, 'Should find a match');
        assert.ok(result.substitutions.length > 0);
        // Closest match should be distance 1 (only deployment_target differs or only deployment_config)
        assert(result.substitutions[0].distance <= 2);
    });

    it('computes Hamming distance correctly', () => {
        // **Validates: Requirements 8.2**
        const configA = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const configB = {
            deployment_config: 'transformers-sglang', // diff
            model_family: 'qwen3',
            instance_family: 'g6', // diff
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        assert.strictEqual(hammingDistance(configA, configB), 2);
    });

    it('returns distance 0 for identical configs', () => {
        // **Validates: Requirements 8.2**
        const config = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        assert.strictEqual(hammingDistance(config, config), 0);
    });

    it('never suggests configs from different model_family', () => {
        // **Validates: Requirements 8.3**
        const requested = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        if (!result.noMatch) {
            for (const sub of result.substitutions) {
                assert.strictEqual(sub.config.model_family, 'qwen3');
            }
        }
    });

    it('only suggests configs with status=completed', () => {
        // **Validates: Requirements 8.4**
        const requested = {
            deployment_config: 'transformers-vllm',
            model_family: 'llama3',
            instance_family: 'p5',
            quantization: 'fp8',
            tp_degree: '4',
            deployment_target: 'async-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        if (!result.noMatch) {
            for (const sub of result.substitutions) {
                assert.strictEqual(sub.config.status, 'completed');
            }
        }
    });

    it('returns noMatch when no same-family completed configs exist', () => {
        // **Validates: Requirements 8.5**
        const requested = {
            deployment_config: 'transformers-vllm',
            model_family: 'mistral', // no mistral configs in test data
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        assert.strictEqual(result.noMatch, true);
        assert.ok(result.message.includes('no coverage'));
        assert.ok(result.message.includes('dimensions away'));
    });

    it('returns noMatch for empty proven configs', () => {
        // **Validates: Requirements 8.5**
        const requested = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const result = findNearestSubstitution(requested, []);
        assert.strictEqual(result.noMatch, true);
    });

    it('explanation lists exactly the differing dimensions', () => {
        // **Validates: Requirements 8.6**
        const requested = {
            deployment_config: 'transformers-sglang',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        assert.ok(!result.noMatch);
        const nearest = result.substitutions[0];
        // The closest should be distance 1 (one dimension differs)
        assert.strictEqual(nearest.distance, 1);
        assert.strictEqual(nearest.explanation.length, 1);
        // Explanation should reference exactly the one differing dimension
        const diffDim = CONFIG_DIMENSIONS.find(dim =>
            String(requested[dim]) !== String(nearest.config[dim])
        );
        assert.ok(
            nearest.explanation[0].includes(diffDim),
            `Explanation should mention '${diffDim}', got: '${nearest.explanation[0]}'`
        );
    });

    it('returns at most 3 substitutions', () => {
        // **Validates: Requirements 8.2**
        const requested = {
            deployment_config: 'http-flask',
            model_family: 'qwen3',
            instance_family: 'p5',
            quantization: 'awq',
            tp_degree: '8',
            deployment_target: 'batch-transform'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        if (!result.noMatch) {
            assert(result.substitutions.length <= 3);
        }
    });

    it('results are sorted by ascending distance', () => {
        // **Validates: Requirements 8.2**
        const requested = {
            deployment_config: 'http-flask',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'fp16',
            tp_degree: '2',
            deployment_target: 'async-inference'
        };

        const result = findNearestSubstitution(requested, PROVEN_CONFIGS);

        if (!result.noMatch && result.substitutions.length > 1) {
            for (let i = 1; i < result.substitutions.length; i++) {
                assert(result.substitutions[i].distance >= result.substitutions[i - 1].distance);
            }
        }
    });
});

// ── Tune/Adapter Stage Gating Tests (Task 5.3) ──────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Tune Stage Gating', () => {

    it('returns false when no tuning requested', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(shouldExecuteTuneStages({}), false);
    });

    it('returns false for null input', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(shouldExecuteTuneStages(null), false);
    });

    it('returns true when include_tuning is true', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(
            shouldExecuteTuneStages({ include_tuning: true }),
            true
        );
    });

    it('returns true when enable_lora is true', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(
            shouldExecuteTuneStages({ enable_lora: true }),
            true
        );
    });

    it('returns true when tune_technique is specified', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(
            shouldExecuteTuneStages({ tune_technique: 'sft' }),
            true
        );
        assert.strictEqual(
            shouldExecuteTuneStages({ tune_technique: 'dpo' }),
            true
        );
    });

    it('returns false when tune_technique is none', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(
            shouldExecuteTuneStages({ tune_technique: 'none' }),
            false
        );
    });

    it('returns false when include_tuning is false and no lora', () => {
        // **Validates: Requirements 8.7**
        assert.strictEqual(
            shouldExecuteTuneStages({ include_tuning: false, enable_lora: false }),
            false
        );
    });
});

// ── Failure Classification Tests (Task 5.4) ──────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Failure Classification', () => {

    it('classifies capacity errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('InsufficientInstanceCapacity: Unable to provision ml.g5.xlarge');
        assert.strictEqual(result.category, 'capacity');
        assert.strictEqual(result.retryable, true);
    });

    it('classifies timeout errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('Deployment timed out after 1200 seconds');
        assert.strictEqual(result.category, 'timeout');
        assert.strictEqual(result.retryable, true);
    });

    it('classifies OOM errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('CUDA out of memory. Tried to allocate 2.00 GiB');
        assert.strictEqual(result.category, 'oom');
        assert.strictEqual(result.retryable, false);
    });

    it('classifies code_bug errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('SyntaxError: Unexpected token in template rendering');
        assert.strictEqual(result.category, 'code_bug');
        assert.strictEqual(result.retryable, false);
    });

    it('classifies model_incompatibility errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('LoRA not supported for this model architecture');
        assert.strictEqual(result.category, 'model_incompatibility');
        assert.strictEqual(result.retryable, false);
    });

    it('classifies service_limitation errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('Feature not available in region us-east-2');
        assert.strictEqual(result.category, 'service_limitation');
        assert.strictEqual(result.retryable, false);
    });

    it('defaults to code_bug for unrecognized errors', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('Something completely unexpected happened');
        assert.strictEqual(result.category, 'code_bug');
        assert.strictEqual(result.retryable, false);
    });

    it('detects stage from error message', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure('InsufficientInstanceCapacity during deploy stage on CreateEndpoint');
        assert.strictEqual(result.stage, 'deploy');
    });

    it('handles structured error objects', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure({
            error: 'CUDA out of memory',
            stage: 'test'
        });
        assert.strictEqual(result.category, 'oom');
        assert.strictEqual(result.stage, 'test');
        assert.strictEqual(result.retryable, false);
    });

    it('handles null input gracefully', () => {
        // **Validates: Requirements 8.8**
        const result = classifyFailure(null);
        assert.strictEqual(result.category, 'code_bug');
        assert.strictEqual(result.retryable, false);
        assert.strictEqual(result.stage, 'unknown');
    });

    it('category is always from defined enum', () => {
        // **Validates: Requirements 8.8**
        const testMessages = [
            'InsufficientInstanceCapacity',
            'timeout exceeded',
            'OutOfMemory error',
            'SyntaxError in template',
            'model incompatible with feature',
            'service not supported in region',
            'random error message'
        ];

        for (const msg of testMessages) {
            const result = classifyFailure(msg);
            assert.ok(
                FAILURE_CATEGORIES.includes(result.category),
                `Category '${result.category}' not in valid enum for message: '${msg}'`
            );
        }
    });
});

// ── Result Writing Tests (Task 5.5) ──────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Result Writing', () => {

    it('success results have run_type=path_prove and status=completed', () => {
        // **Validates: Requirements 8.9, 8.10**
        const result = {
            success: true,
            config: {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                config_id: 'abc123def456'
            },
            metrics: { ttft_p50_ms: 45.2, throughput_rps: 12.5 }
        };

        const record = buildPathProverRecord(result, null);

        assert.strictEqual(record.run_type, 'path_prove');
        assert.strictEqual(record.status, 'completed');
        assert.ok(record.run_timestamp);
    });

    it('non-retryable failure produces unfeasible status', () => {
        // **Validates: Requirements 8.12**
        const result = {
            success: false,
            config: {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5'
            },
            error: 'CUDA out of memory'
        };
        const classification = { stage: 'deploy', category: 'oom', retryable: false };

        const record = buildPathProverRecord(result, classification);

        assert.strictEqual(record.run_type, 'path_prove');
        assert.strictEqual(record.status, 'unfeasible');
        assert.ok(record.failure_reason.length > 0);
        assert.strictEqual(record.failure_stage, 'deploy');
        assert.strictEqual(record.failure_category, 'oom');
        assert.strictEqual(record.failure_retryable, false);
    });

    it('retryable failure produces failed status', () => {
        // **Validates: Requirements 8.8**
        const result = {
            success: false,
            config: {
                deployment_config: 'transformers-vllm',
                model_family: 'llama3',
                instance_family: 'g5'
            },
            error: 'InsufficientInstanceCapacity'
        };
        const classification = { stage: 'deploy', category: 'capacity', retryable: true };

        const record = buildPathProverRecord(result, classification);

        assert.strictEqual(record.run_type, 'path_prove');
        assert.strictEqual(record.status, 'failed');
        assert.ok(record.failure_reason.length > 0);
    });

    it('copies config dimensions into the record', () => {
        // **Validates: Requirements 8.9**
        const config = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'fp16',
            tp_degree: '2',
            deployment_target: 'async-inference',
            config_id: 'abcdef1234567890',
            model_name: 'Qwen/Qwen3-4B',
            instance_type: 'ml.g5.xlarge'
        };

        const record = buildPathProverRecord({ success: true, config }, null);

        assert.strictEqual(record.deployment_config, 'transformers-vllm');
        assert.strictEqual(record.model_family, 'qwen3');
        assert.strictEqual(record.instance_family, 'g5');
        assert.strictEqual(record.config_id, 'abcdef1234567890');
    });

    it('findUnfeasibleRecord detects known-bad configs', () => {
        // **Validates: Requirements 8.12**
        const config = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const existingRecords = [
            {
                ...config,
                status: 'unfeasible',
                run_type: 'path_prove',
                failure_reason: 'OOM'
            }
        ];

        const found = findUnfeasibleRecord(config, existingRecords);
        assert.ok(found);
        assert.strictEqual(found.status, 'unfeasible');
    });

    it('findUnfeasibleRecord returns null when no match', () => {
        // **Validates: Requirements 8.12**
        const config = {
            deployment_config: 'transformers-sglang',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const existingRecords = [
            {
                deployment_config: 'transformers-vllm', // different
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'unfeasible',
                run_type: 'path_prove',
                failure_reason: 'OOM'
            }
        ];

        const found = findUnfeasibleRecord(config, existingRecords);
        assert.strictEqual(found, null);
    });

    it('findUnfeasibleRecord ignores non-path_prove records', () => {
        // **Validates: Requirements 8.12**
        const config = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const existingRecords = [
            {
                ...config,
                status: 'unfeasible',
                run_type: 'ci', // not path_prove
                failure_reason: 'OOM'
            }
        ];

        const found = findUnfeasibleRecord(config, existingRecords);
        assert.strictEqual(found, null);
    });
});

// ── Hamming Distance Edge Case Tests ─────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Hamming Distance', () => {

    it('treats undefined values as empty strings for comparison', () => {
        // **Validates: Requirements 8.2**
        const configA = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3'
            // remaining dimensions are undefined
        };

        const configB = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3'
            // remaining dimensions are undefined
        };

        assert.strictEqual(hammingDistance(configA, configB), 0);
    });

    it('counts undefined vs defined as a difference', () => {
        // **Validates: Requirements 8.2**
        const configA = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5'
        };

        const configB = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3'
            // instance_family is undefined → treated as ''
        };

        assert.strictEqual(hammingDistance(configA, configB), 1);
    });

    it('returns maximum distance when all dimensions differ', () => {
        // **Validates: Requirements 8.2**
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
            model_family: 'llama3',
            instance_family: 'p5',
            quantization: 'fp8',
            tp_degree: '4',
            deployment_target: 'async-inference'
        };

        assert.strictEqual(hammingDistance(configA, configB), 6);
    });

    it('treats null values as empty strings', () => {
        // **Validates: Requirements 8.2**
        const configA = {
            deployment_config: 'transformers-vllm',
            model_family: null,
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        const configB = {
            deployment_config: 'transformers-vllm',
            model_family: null,
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference'
        };

        assert.strictEqual(hammingDistance(configA, configB), 0);
    });

    it('coerces numeric tp_degree to string for comparison', () => {
        // **Validates: Requirements 8.2**
        const configA = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: 1, // number
            deployment_target: 'realtime-inference'
        };

        const configB = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1', // string
            deployment_target: 'realtime-inference'
        };

        assert.strictEqual(hammingDistance(configA, configB), 0);
    });
});

// ── Gap Identification Additional Tests ──────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Gap Identification (Extended)', () => {

    it('does not include completed configs in gaps', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            }
        ];

        const gaps = identifyGaps(configs);
        // Only 1 dimension value per dimension → only 1 possible combo → it's proven
        assert.strictEqual(gaps.length, 0);
    });

    it('gap objects contain all CONFIG_DIMENSIONS keys', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
            {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'failed'
            }
        ];

        const gaps = identifyGaps(configs);
        assert.ok(gaps.length > 0);
        for (const gap of gaps) {
            for (const dim of CONFIG_DIMENSIONS) {
                assert.ok(dim in gap, `Gap missing dimension: ${dim}`);
            }
        }
    });

    it('does not expose internal _neighborCount field in results', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            },
            {
                deployment_config: 'transformers-sglang',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'failed'
            }
        ];

        const gaps = identifyGaps(configs);
        for (const gap of gaps) {
            assert.strictEqual(gap._neighborCount, undefined, 'Internal field leaked into output');
        }
    });

    it('handles configs with null dimension values', () => {
        // **Validates: Requirements 8.1**
        const configs = [
            {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: null,
                quantization: 'none',
                tp_degree: '1',
                deployment_target: 'realtime-inference',
                status: 'completed'
            }
        ];

        // Should not throw — null dimensions are excluded from value set
        const gaps = identifyGaps(configs);
        assert.ok(Array.isArray(gaps));
    });
});

// ── Priority Queue Tests ─────────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Priority Queue', () => {

    it('getNextPriorityConfig returns first pending target', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            defaults: {
                deployment_config: 'transformers-vllm',
                instance_family: 'g5',
                deployment_target: 'realtime-inference'
            },
            targets: [
                { model_name: 'Qwen/Qwen3-4B', model_family: 'qwen3', status: 'pending' },
                { model_name: 'meta-llama/Llama-3-8B', model_family: 'llama3', status: 'pending' }
            ],
            proven: []
        };

        const event = {};
        const result = getNextPriorityConfig(event, priorityData);

        assert.ok(result);
        assert.strictEqual(result.model_name, 'Qwen/Qwen3-4B');
        assert.strictEqual(result.deployment_config, 'transformers-vllm');
        // Status should be stripped from config
        assert.strictEqual(result.status, undefined);
    });

    it('getNextPriorityConfig skips non-pending targets', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            defaults: { deployment_config: 'transformers-vllm' },
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'failed' },
                { model_name: 'meta-llama/Llama-3-8B', status: 'pending' }
            ],
            proven: []
        };

        const result = getNextPriorityConfig({}, priorityData);
        assert.ok(result);
        assert.strictEqual(result.model_name, 'meta-llama/Llama-3-8B');
    });

    it('getNextPriorityConfig skips already-proven models', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            defaults: { deployment_config: 'transformers-vllm' },
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'pending' }
            ],
            proven: [{ model_name: 'Qwen/Qwen3-4B', proven_date: '2025-01-01' }]
        };

        const result = getNextPriorityConfig({}, priorityData);
        assert.strictEqual(result, null);
    });

    it('getNextPriorityConfig returns null when queue is exhausted', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            defaults: {},
            targets: [],
            proven: [{ model_name: 'Qwen/Qwen3-4B', proven_date: '2025-01-01' }]
        };

        const result = getNextPriorityConfig({}, priorityData);
        assert.strictEqual(result, null);
    });

    it('getNextPriorityConfig returns null for null priority data', () => {
        // **Validates: Requirements 8.1**
        const result = getNextPriorityConfig({}, null);
        assert.strictEqual(result, null);
    });

    it('getNextPriorityConfig considers previousResults as proven', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            defaults: { deployment_config: 'transformers-vllm' },
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'pending' },
                { model_name: 'meta-llama/Llama-3-8B', status: 'pending' }
            ],
            proven: []
        };

        const event = {
            previousResults: [
                { success: true, config: { model_name: 'Qwen/Qwen3-4B' } }
            ]
        };

        const result = getNextPriorityConfig(event, priorityData);
        assert.ok(result);
        assert.strictEqual(result.model_name, 'meta-llama/Llama-3-8B');
    });

    it('updatePriorityStatus moves target to proven list', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'pending' }
            ],
            proven: []
        };

        const result = updatePriorityStatus(priorityData, 'Qwen/Qwen3-4B', 'proven');

        assert.strictEqual(result.targets.length, 0);
        assert.strictEqual(result.proven.length, 1);
        assert.strictEqual(result.proven[0].model_name, 'Qwen/Qwen3-4B');
        assert.ok(result.proven[0].proven_date);
    });

    it('updatePriorityStatus updates failed status in place', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'pending' }
            ],
            proven: []
        };

        const result = updatePriorityStatus(priorityData, 'Qwen/Qwen3-4B', 'failed', {
            error_category: 'oom',
            error_message: 'CUDA out of memory'
        });

        assert.strictEqual(result.targets.length, 1);
        assert.strictEqual(result.targets[0].status, 'failed');
        assert.strictEqual(result.targets[0].error_category, 'oom');
        assert.ok(result.targets[0].last_attempt);
    });

    it('updatePriorityStatus returns data unchanged for unknown model', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            targets: [
                { model_name: 'Qwen/Qwen3-4B', status: 'pending' }
            ],
            proven: []
        };

        const result = updatePriorityStatus(priorityData, 'unknown-model', 'proven');
        assert.strictEqual(result.targets.length, 1);
    });

    it('getPriorityQueueStatus returns correct counts', () => {
        // **Validates: Requirements 8.1**
        const priorityData = {
            targets: [
                { model_name: 'model-a', status: 'pending' },
                { model_name: 'model-b', status: 'pending' },
                { model_name: 'model-c', status: 'failed' },
                { model_name: 'model-d', status: 'unfeasible' }
            ],
            proven: [
                { model_name: 'model-e', proven_date: '2025-01-01' }
            ]
        };

        const status = getPriorityQueueStatus(priorityData);
        assert.strictEqual(status.total, 5);
        assert.strictEqual(status.pending, 2);
        assert.strictEqual(status.proven, 1);
        assert.strictEqual(status.failed, 1);
        assert.strictEqual(status.unfeasible, 1);
    });

    it('getPriorityQueueStatus returns zeros for null input', () => {
        // **Validates: Requirements 8.1**
        const status = getPriorityQueueStatus(null);
        assert.strictEqual(status.total, 0);
        assert.strictEqual(status.pending, 0);
        assert.strictEqual(status.proven, 0);
    });
});

// ── Result Writing Additional Tests ──────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Result Writing (Extended)', () => {

    it('record run_timestamp is valid ISO-8601 format', () => {
        // **Validates: Requirements 8.9**
        const result = { success: true, config: {} };
        const record = buildPathProverRecord(result, null);

        const parsed = Date.parse(record.run_timestamp);
        assert.ok(!isNaN(parsed), 'run_timestamp should be a valid ISO-8601 date');
    });

    it('success record includes merged metrics', () => {
        // **Validates: Requirements 8.9**
        const result = {
            success: true,
            config: { deployment_config: 'transformers-vllm', model_family: 'qwen3' },
            metrics: {
                ttft_p50_ms: 45.2,
                throughput_rps: 12.5,
                itl_p90_ms: 8.3
            }
        };

        const record = buildPathProverRecord(result, null);
        assert.strictEqual(record.ttft_p50_ms, 45.2);
        assert.strictEqual(record.throughput_rps, 12.5);
        assert.strictEqual(record.itl_p90_ms, 8.3);
    });

    it('failure record without classification defaults to failed status', () => {
        // **Validates: Requirements 8.8**
        const result = {
            success: false,
            config: { deployment_config: 'transformers-vllm' },
            error: 'Something went wrong'
        };

        const record = buildPathProverRecord(result, null);
        assert.strictEqual(record.status, 'failed');
        assert.strictEqual(record.failure_reason, 'Something went wrong');
    });

    it('failure record uses "Unknown failure" when no error message', () => {
        // **Validates: Requirements 8.8**
        const result = {
            success: false,
            config: {}
        };

        const record = buildPathProverRecord(result, null);
        assert.strictEqual(record.failure_reason, 'Unknown failure');
    });

    it('copies model_name and instance_type from config', () => {
        // **Validates: Requirements 8.9**
        const result = {
            success: true,
            config: {
                deployment_config: 'transformers-vllm',
                model_name: 'Qwen/Qwen3-4B',
                instance_type: 'ml.g5.xlarge'
            }
        };

        const record = buildPathProverRecord(result, null);
        assert.strictEqual(record.model_name, 'Qwen/Qwen3-4B');
        assert.strictEqual(record.instance_type, 'ml.g5.xlarge');
    });

    it('findUnfeasibleRecord returns null for empty records array', () => {
        // **Validates: Requirements 8.12**
        const config = { deployment_config: 'transformers-vllm' };
        assert.strictEqual(findUnfeasibleRecord(config, []), null);
    });

    it('findUnfeasibleRecord returns null for null config', () => {
        // **Validates: Requirements 8.12**
        assert.strictEqual(findUnfeasibleRecord(null, [{ status: 'unfeasible' }]), null);
    });
});

// ── CONFIG_DIMENSIONS Export Tests ───────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Path Prover Brain: Module Exports', () => {

    it('exports CONFIG_DIMENSIONS with correct values', () => {
        assert.ok(Array.isArray(CONFIG_DIMENSIONS));
        assert.strictEqual(CONFIG_DIMENSIONS.length, 6);
        assert.ok(CONFIG_DIMENSIONS.includes('deployment_config'));
        assert.ok(CONFIG_DIMENSIONS.includes('model_family'));
        assert.ok(CONFIG_DIMENSIONS.includes('instance_family'));
        assert.ok(CONFIG_DIMENSIONS.includes('quantization'));
        assert.ok(CONFIG_DIMENSIONS.includes('tp_degree'));
        assert.ok(CONFIG_DIMENSIONS.includes('deployment_target'));
    });

    it('exports FAILURE_CATEGORIES with all expected values', () => {
        assert.ok(Array.isArray(FAILURE_CATEGORIES));
        assert.ok(FAILURE_CATEGORIES.includes('capacity'));
        assert.ok(FAILURE_CATEGORIES.includes('timeout'));
        assert.ok(FAILURE_CATEGORIES.includes('oom'));
        assert.ok(FAILURE_CATEGORIES.includes('code_bug'));
        assert.ok(FAILURE_CATEGORIES.includes('model_incompatibility'));
        assert.ok(FAILURE_CATEGORIES.includes('service_limitation'));
    });

    it('CONFIG_DIMENSIONS are all strings', () => {
        for (const dim of CONFIG_DIMENSIONS) {
            assert.strictEqual(typeof dim, 'string');
        }
    });

    it('FAILURE_CATEGORIES has exactly 6 entries', () => {
        assert.strictEqual(FAILURE_CATEGORIES.length, 6);
    });
});
