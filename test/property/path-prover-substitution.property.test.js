// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property P7: Substitution Algorithm Correctness
 *
 * For any requested configuration vector and set of proven configurations
 * (status=completed) in Athena, the substitution algorithm SHALL return
 * results that:
 *   (a) are ordered by ascending Hamming distance from the requested config,
 *   (b) only include configs with status = 'completed',
 *   (c) never include configs from a different model_family than the requested config,
 *   (d) for each result, the explanation SHALL list exactly the dimensions
 *       that differ between the requested and suggested config.
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 8.2, 8.3, 8.4, 8.6**
 */

import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import {
    findNearestSubstitution,
    hammingDistance,
    CONFIG_DIMENSIONS
} from '../../src/lib/path-prover-brain.js'

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    verbose: false
}

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(
    'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm',
    'transformers-lmi', 'http-flask', 'http-fastapi', 'triton-python'
)

const arbModelFamily = fc.constantFrom(
    'qwen3', 'llama3', 'deepseek-r1', 'mistral', 'gemma2', 'phi3'
)

const arbInstanceFamily = fc.constantFrom(
    'g5', 'g6', 'g6e', 'p4d', 'p5', 'trn2', 'inf2'
)

const arbQuantization = fc.constantFrom(
    'none', 'fp16', 'fp8', 'awq', 'gptq', 'int8', 'int4'
)

const arbTpDegree = fc.constantFrom('1', '2', '4', '8')

const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'
)

const arbStatus = fc.constantFrom('completed', 'failed', 'unfeasible')

function arbConfigVector() {
    return fc.record({
        deployment_config: arbDeploymentConfig,
        model_family: arbModelFamily,
        instance_family: arbInstanceFamily,
        quantization: arbQuantization,
        tp_degree: arbTpDegree,
        deployment_target: arbDeploymentTarget
    })
}

function arbProvenConfig() {
    return fc.record({
        deployment_config: arbDeploymentConfig,
        model_family: arbModelFamily,
        instance_family: arbInstanceFamily,
        quantization: arbQuantization,
        tp_degree: arbTpDegree,
        deployment_target: arbDeploymentTarget,
        status: arbStatus,
        run_timestamp: fc.integer({ min: 1704067200000, max: 1798761600000 })
            .map(ts => new Date(ts).toISOString())
    })
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline, Property P7: Substitution Algorithm Correctness', () => {

    /**
     * **Validates: Requirements 8.2**
     *
     * Results are ordered by ascending Hamming distance.
     */
    it('substitution results are ordered by ascending Hamming distance', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 20 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return // No substitutions to check

                const { substitutions } = result
                for (let i = 1; i < substitutions.length; i++) {
                    assert(
                        substitutions[i].distance >= substitutions[i - 1].distance,
                        `Results not sorted: distance[${i - 1}]=${substitutions[i - 1].distance} > distance[${i}]=${substitutions[i].distance}`
                    )
                }
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.4**
     *
     * Only configs with status='completed' are included in results.
     */
    it('only includes configs with status completed', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 20 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return

                for (const sub of result.substitutions) {
                    assert.strictEqual(
                        sub.config.status, 'completed',
                        `Substitution includes non-completed config with status='${sub.config.status}'`
                    )
                }
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.3**
     *
     * Never cross model_family boundary — all results have the same
     * model_family as the requested config.
     */
    it('never crosses model_family boundary', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 20 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return

                for (const sub of result.substitutions) {
                    assert.strictEqual(
                        sub.config.model_family, requested.model_family,
                        `Substitution crossed model_family boundary: ` +
                        `requested='${requested.model_family}', got='${sub.config.model_family}'`
                    )
                }
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.6**
     *
     * Explanation lists exactly the dimensions that differ between
     * requested and suggested config.
     */
    it('explanation lists exactly the differing dimensions', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 20 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return

                for (const sub of result.substitutions) {
                    // Count actual differences
                    const actualDiffs = []
                    for (const dim of CONFIG_DIMENSIONS) {
                        if (String(requested[dim] ?? '') !== String(sub.config[dim] ?? '')) {
                            actualDiffs.push(dim)
                        }
                    }

                    // Explanation should have exactly as many entries as actual differences
                    assert.strictEqual(
                        sub.explanation.length, actualDiffs.length,
                        `Explanation has ${sub.explanation.length} entries but ` +
                        `there are ${actualDiffs.length} actual differences. ` +
                        `Explanation: ${JSON.stringify(sub.explanation)}, ` +
                        `Actual diffs: ${JSON.stringify(actualDiffs)}`
                    )

                    // Each differing dimension should appear in the explanation
                    for (const dim of actualDiffs) {
                        const found = sub.explanation.some(e => e.includes(dim))
                        assert(
                            found,
                            `Dimension '${dim}' differs but not found in explanation: ${JSON.stringify(sub.explanation)}`
                        )
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.2, 8.3**
     *
     * Distance in results matches actual Hamming distance computation.
     */
    it('reported distance matches actual Hamming distance', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 20 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return

                for (const sub of result.substitutions) {
                    const actualDistance = hammingDistance(requested, sub.config)
                    assert.strictEqual(
                        sub.distance, actualDistance,
                        `Reported distance ${sub.distance} != actual ${actualDistance}`
                    )
                }
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.5**
     *
     * When no proven alternative exists within the same model family,
     * returns noMatch with appropriate message.
     */
    it('returns noMatch when no completed configs in same model_family', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 10 }),
            (requested, provenConfigs) => {
                // Force all configs to a different model_family
                const differentFamily = provenConfigs.map(c => ({
                    ...c,
                    model_family: requested.model_family === 'qwen3' ? 'llama3' : 'qwen3',
                    status: 'completed'
                }))

                const result = findNearestSubstitution(requested, differentFamily)

                assert.strictEqual(result.noMatch, true, 'Should return noMatch when no same-family configs')
                assert.ok(
                    result.message.includes('no coverage'),
                    `Message should mention 'no coverage', got: '${result.message}'`
                )
                assert.ok(
                    result.message.includes('dimensions away'),
                    `Message should mention distance, got: '${result.message}'`
                )
            }
        ), FAST_PROPERTY_CONFIG)
    })

    /**
     * **Validates: Requirements 8.2**
     *
     * At most 3 substitutions are returned.
     */
    it('returns at most 3 substitutions', function () {
        this.timeout(30000)

        fc.assert(fc.property(
            arbConfigVector(),
            fc.array(arbProvenConfig(), { minLength: 1, maxLength: 30 }),
            (requested, provenConfigs) => {
                const result = findNearestSubstitution(requested, provenConfigs)

                if (result.noMatch) return

                assert(
                    result.substitutions.length <= 3,
                    `Expected at most 3 substitutions, got ${result.substitutions.length}`
                )
            }
        ), FAST_PROPERTY_CONFIG)
    })
})
