// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property P8: Path Prover Record Integrity
 *
 * For any Path Prover execution result (success or failure), the Athena
 * record written SHALL have run_type = 'path_prove'. Additionally:
 *   - For any failure classified as non-retryable (oom, code_bug,
 *     model_incompatibility, service_limitation), the record SHALL have
 *     status = 'unfeasible' and a non-empty failure_reason field.
 *   - For any failure, the classification SHALL include:
 *     (a) the lifecycle stage that failed,
 *     (b) an error category from the defined enum,
 *     (c) a boolean retryable field.
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 8.8, 8.9, 8.12**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    buildPathProverRecord,
    classifyFailure,
    FAILURE_CATEGORIES
} from '../../src/lib/path-prover-brain.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(
    'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm',
    'transformers-lmi', 'http-flask', 'http-fastapi'
);

const arbModelFamily = fc.constantFrom(
    'qwen3', 'llama3', 'deepseek-r1', 'mistral', 'gemma2'
);

const arbInstanceFamily = fc.constantFrom(
    'g5', 'g6', 'g6e', 'p4d', 'p5', 'trn2'
);

const arbQuantization = fc.constantFrom('none', 'fp16', 'fp8', 'awq', 'gptq');

const arbTpDegree = fc.constantFrom('1', '2', '4', '8');

const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'
);

const arbConfig = fc.record({
    deployment_config: arbDeploymentConfig,
    model_family: arbModelFamily,
    instance_family: arbInstanceFamily,
    quantization: arbQuantization,
    tp_degree: arbTpDegree,
    deployment_target: arbDeploymentTarget,
    config_id: fc.array(
        fc.constantFrom(...'0123456789abcdef'.split('')),
        { minLength: 16, maxLength: 16 }
    ).map(arr => arr.join('')),
    model_name: fc.constantFrom('Qwen/Qwen3-4B', 'meta-llama/Llama-3.1-8B', 'deepseek-ai/DeepSeek-R1-7B'),
    instance_type: fc.constantFrom('ml.g5.xlarge', 'ml.g6.xlarge', 'ml.p5.48xlarge')
});

const arbStage = fc.constantFrom(
    'generate', 'build', 'push', 'deploy', 'test', 'tune', 'adapter', 'benchmark', 'register', 'clean', 'unknown'
);

const arbCategory = fc.constantFrom(...FAILURE_CATEGORIES);

const arbRetryable = fc.boolean();

const arbClassification = fc.record({
    stage: arbStage,
    category: arbCategory,
    retryable: arbRetryable
});

const NON_RETRYABLE_CATEGORIES = ['oom', 'code_bug', 'model_incompatibility', 'service_limitation'];

const arbNonRetryableClassification = fc.record({
    stage: arbStage,
    category: fc.constantFrom(...NON_RETRYABLE_CATEGORIES),
    retryable: fc.constant(false)
});

const arbRetryableClassification = fc.record({
    stage: arbStage,
    category: fc.constantFrom('capacity', 'timeout'),
    retryable: fc.constant(true)
});

const arbErrorMessage = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :./-_'.split('')),
    { minLength: 5, maxLength: 100 }
).map(arr => arr.join(''));

const arbSuccessResult = arbConfig.map(config => ({
    success: true,
    config,
    metrics: {
        ttft_p50_ms: 45.2,
        throughput_rps: 12.5,
        tokens_per_second: 487.2
    }
}));

const arbFailureResult = fc.tuple(arbConfig, arbErrorMessage).map(([config, error]) => ({
    success: false,
    config,
    error
}));

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline, Property P8: Path Prover Record Integrity', () => {

    /**
     * **Validates: Requirements 8.9**
     *
     * All Path Prover results have run_type = 'path_prove'.
     */
    it('all records have run_type = path_prove (success case)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbSuccessResult,
            (result) => {
                const record = buildPathProverRecord(result, null);
                assert.strictEqual(
                    record.run_type, 'path_prove',
                    `Expected run_type='path_prove', got '${record.run_type}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('all records have run_type = path_prove (failure case)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailureResult,
            arbClassification,
            (result, classification) => {
                const record = buildPathProverRecord(result, classification);
                assert.strictEqual(
                    record.run_type, 'path_prove',
                    `Expected run_type='path_prove', got '${record.run_type}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.12**
     *
     * Non-retryable failures have status = 'unfeasible' with non-empty failure_reason.
     */
    it('non-retryable failures produce status=unfeasible with non-empty failure_reason', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailureResult,
            arbNonRetryableClassification,
            (result, classification) => {
                const record = buildPathProverRecord(result, classification);

                assert.strictEqual(
                    record.status, 'unfeasible',
                    `Expected status='unfeasible' for non-retryable failure, got '${record.status}'`
                );
                assert.ok(
                    record.failure_reason && record.failure_reason.length > 0,
                    `failure_reason must be non-empty for unfeasible records, got: '${record.failure_reason}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.8**
     *
     * All failure classifications include stage, category, and retryable.
     */
    it('failure records include stage, category, and retryable from classification', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailureResult,
            arbClassification,
            (result, classification) => {
                const record = buildPathProverRecord(result, classification);

                assert.ok(
                    record.failure_stage !== undefined && record.failure_stage !== null,
                    `failure_stage must be present, got: ${record.failure_stage}`
                );
                assert.ok(
                    record.failure_category !== undefined && record.failure_category !== null,
                    `failure_category must be present, got: ${record.failure_category}`
                );
                assert.ok(
                    typeof record.failure_retryable === 'boolean',
                    `failure_retryable must be boolean, got: ${typeof record.failure_retryable}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.8**
     *
     * Failure category is always from the defined enum.
     */
    it('failure_category is always from the defined FAILURE_CATEGORIES enum', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailureResult,
            arbClassification,
            (result, classification) => {
                const record = buildPathProverRecord(result, classification);

                assert.ok(
                    FAILURE_CATEGORIES.includes(record.failure_category),
                    `failure_category '${record.failure_category}' not in ${JSON.stringify(FAILURE_CATEGORIES)}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.9**
     *
     * Success records have status='completed'.
     */
    it('successful proves produce status=completed', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbSuccessResult,
            (result) => {
                const record = buildPathProverRecord(result, null);
                assert.strictEqual(
                    record.status, 'completed',
                    `Expected status='completed' for success, got '${record.status}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.8, 8.12**
     *
     * Retryable failures have status='failed' (not 'unfeasible').
     */
    it('retryable failures produce status=failed (not unfeasible)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailureResult,
            arbRetryableClassification,
            (result, classification) => {
                const record = buildPathProverRecord(result, classification);

                assert.strictEqual(
                    record.status, 'failed',
                    `Expected status='failed' for retryable failure, got '${record.status}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.8**
     *
     * The classifyFailure function always returns a valid classification
     * with stage, category (from enum), and boolean retryable.
     */
    it('classifyFailure always returns valid classification structure', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbErrorMessage,
            (errorMsg) => {
                const classification = classifyFailure(errorMsg);

                assert.ok(
                    typeof classification.stage === 'string' && classification.stage.length > 0,
                    `stage must be non-empty string, got: '${classification.stage}'`
                );
                assert.ok(
                    FAILURE_CATEGORIES.includes(classification.category),
                    `category '${classification.category}' not in defined enum`
                );
                assert.ok(
                    typeof classification.retryable === 'boolean',
                    `retryable must be boolean, got: ${typeof classification.retryable}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * **Validates: Requirements 8.9**
     *
     * All records have a run_timestamp field.
     */
    it('all records include a run_timestamp', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.oneof(arbSuccessResult, arbFailureResult),
            arbClassification,
            (result, classification) => {
                const cls = result.success ? null : classification;
                const record = buildPathProverRecord(result, cls);

                assert.ok(
                    record.run_timestamp && record.run_timestamp.length > 0,
                    'run_timestamp must be non-empty'
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
