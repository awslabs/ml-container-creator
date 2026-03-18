// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Value Validation Property-Based Tests
 *
 * Property-based tests verifying that per-server custom value validation
 * functions accept valid inputs and reject invalid inputs according to
 * their defined patterns.
 *
 * Feature: mcp-server-externalization
 */

import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import { CUSTOM_VALIDATORS } from '../../servers/lib/custom-validators.js'

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Custom Value Validation Property-Based Tests', () => {

    // Feature: mcp-server-externalization, Property 10: Custom value validation accepts valid and rejects invalid inputs
    describe('Property 10: Custom value validation accepts valid and rejects invalid inputs', () => {

        /**
         * Validates: Requirements 10.3, 10.4, 10.5, 10.6
         */

        // ── base-image-picker ────────────────────────────────────────────

        describe('base-image-picker', () => {
            const validator = CUSTOM_VALIDATORS['base-image-picker']

            it('accepts valid container image references', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbValidImage = fc.constantFrom(
                    'nginx:latest',
                    'myrepo/myimage:v1',
                    'python:3.12-slim',
                    'ubuntu',
                    'registry.example.com/repo:tag',
                    'vllm/vllm-openai:v0.10.1',
                    'deepjavalibrary/djl-serving:0.31.0',
                    'my-image',
                    'org/repo:v1.2.3',
                    'a',
                    '0start:tag',
                    'repo/sub-repo:tag.1'
                )

                fc.assert(fc.property(
                    arbValidImage,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            result,
                            true,
                            `base-image-picker should accept "${value}" but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects strings not matching image reference pattern', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbInvalidImage = fc.constantFrom(
                    ':notag',
                    '!invalid',
                    '@bad',
                    '#nope',
                    'image:tag:extra',
                    'image::doubletag',
                    '.starts-with-dot',
                    '-starts-with-dash'
                )

                fc.assert(fc.property(
                    arbInvalidImage,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            typeof result,
                            'string',
                            `base-image-picker should reject "${value}" with error message but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects empty strings', function () {
                const result = validator.validate('')
                assert.strictEqual(
                    typeof result,
                    'string',
                    `base-image-picker should reject empty string with error message but got: ${result}`
                )
            })
        })

        // ── instance-recommender ─────────────────────────────────────────

        describe('instance-recommender', () => {
            const validator = CUSTOM_VALIDATORS['instance-recommender']

            it('accepts valid SageMaker instance type patterns', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbValidInstance = fc.tuple(
                    fc.constant('ml.'),
                    fc.stringMatching(/^[a-z0-9]{1,8}$/),
                    fc.constant('.'),
                    fc.stringMatching(/^[a-z0-9]{1,10}$/)
                ).map(parts => parts.join(''))

                fc.assert(fc.property(
                    arbValidInstance,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            result,
                            true,
                            `instance-recommender should accept "${value}" but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects strings not matching ml.<family>.<size> pattern', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbInvalidInstance = fc.oneof(
                    // Missing ml. prefix
                    fc.constantFrom('g5.xlarge', 'm5.large', 'p3.2xlarge'),
                    // Uppercase letters
                    fc.constantFrom('ml.G5.xlarge', 'ml.M5.LARGE', 'ML.g5.xlarge'),
                    // Missing second dot
                    fc.constantFrom('ml.g5', 'ml.m5'),
                    // Extra dots
                    fc.constantFrom('ml.g5.x.large', 'ml.g5.xlarge.extra')
                )

                fc.assert(fc.property(
                    arbInvalidInstance,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            typeof result,
                            'string',
                            `instance-recommender should reject "${value}" with error message but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects empty strings', function () {
                const result = validator.validate('')
                assert.strictEqual(
                    typeof result,
                    'string',
                    `instance-recommender should reject empty string with error message but got: ${result}`
                )
            })
        })

        // ── region-picker ────────────────────────────────────────────────

        describe('region-picker', () => {
            const validator = CUSTOM_VALIDATORS['region-picker']

            it('accepts valid AWS region code patterns', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbValidRegion = fc.tuple(
                    fc.stringMatching(/^[a-z]{2,4}$/),
                    fc.constant('-'),
                    fc.stringMatching(/^[a-z]{1,10}$/),
                    fc.constant('-'),
                    fc.nat({ max: 99 }).map(n => String(n + 1))
                ).map(parts => parts.join(''))

                fc.assert(fc.property(
                    arbValidRegion,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            result,
                            true,
                            `region-picker should accept "${value}" but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects strings not matching region code pattern', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbInvalidRegion = fc.oneof(
                    // Uppercase
                    fc.constantFrom('US-EAST-1', 'Us-West-2', 'EU-WEST-1'),
                    // Missing number
                    fc.constantFrom('us-east-', 'us-east'),
                    // Missing geo
                    fc.constantFrom('us--1', '-east-1'),
                    // Single char prefix (less than 2)
                    fc.constantFrom('u-east-1')
                )

                fc.assert(fc.property(
                    arbInvalidRegion,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            typeof result,
                            'string',
                            `region-picker should reject "${value}" with error message but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects empty strings', function () {
                const result = validator.validate('')
                assert.strictEqual(
                    typeof result,
                    'string',
                    `region-picker should reject empty string with error message but got: ${result}`
                )
            })
        })

        // ── hyperpod-cluster-picker ──────────────────────────────────────

        describe('hyperpod-cluster-picker', () => {
            const validator = CUSTOM_VALIDATORS['hyperpod-cluster-picker']

            it('accepts any non-empty string', function () {
                this.timeout(FAST_PROPERTY_CONFIG.timeout)

                const arbNonEmpty = fc.string({ minLength: 1, maxLength: 100 })
                    .filter(s => s.trim().length > 0)

                fc.assert(fc.property(
                    arbNonEmpty,
                    (value) => {
                        const result = validator.validate(value)
                        assert.strictEqual(
                            result,
                            true,
                            `hyperpod-cluster-picker should accept "${value}" but got: ${result}`
                        )
                        return true
                    }
                ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
            })

            it('rejects empty strings', function () {
                const result = validator.validate('')
                assert.strictEqual(
                    typeof result,
                    'string',
                    `hyperpod-cluster-picker should reject empty string with error message but got: ${result}`
                )
            })
        })
    })
})
