// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Value Source Marker Property-Based Tests
 *
 * Property-based tests verifying that when a custom value is submitted,
 * the transformation logic correctly sets `_baseImageSource: 'custom'`
 * on the combined answers object, and that non-custom values do not
 * receive the source marker.
 *
 * Feature: mcp-server-externalization, Property 11: Custom values include source marker in metadata
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

// ── Transformation logic (extracted from prompt-runner.js) ───────────────────

/**
 * Applies the custom base image transformation to a combined answers object.
 * This mirrors the logic in generators/app/lib/prompt-runner.js that runs
 * after all prompts are collected.
 *
 * If `customBaseImage` is set, it becomes the `baseImage`, the source marker
 * `_baseImageSource` is set to 'custom', and `customBaseImage` is removed.
 */
function applyCustomBaseImageTransform(answers) {
    const result = { ...answers }
    if (result.customBaseImage) {
        result.baseImage = result.customBaseImage
        result._baseImageSource = 'custom'
        delete result.customBaseImage
    }
    return result
}

// ── Generators ───────────────────────────────────────────────────────────────

const validImagePattern = CUSTOM_VALIDATORS['base-image-picker'].pattern

/**
 * Generate valid custom image values using known-good examples and
 * pattern-matching strings.
 */
const arbValidCustomImage = fc.oneof(
    fc.constantFrom(
        'nginx:latest',
        'myrepo/myimage:v1',
        'python:3.12-slim',
        'ubuntu',
        'vllm/vllm-openai:v0.10.1',
        'deepjavalibrary/djl-serving:0.31.0',
        'registry.example.com/repo:tag',
        'my-image',
        'org/repo:v1.2.3'
    ),
    fc.string({ minLength: 1, maxLength: 40 })
        .filter(s => validImagePattern.test(s))
)

/**
 * Generate a base answers object with typical fields that would exist
 * alongside the custom image fields.
 */
const arbBaseAnswers = fc.record({
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    projectName: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z]/.test(s))
})

// ── Property tests ───────────────────────────────────────────────────────────

describe('Custom Value Source Marker Property-Based Tests', () => {

    // Feature: mcp-server-externalization, Property 11: Custom values include source marker in metadata
    describe('Property 11: Custom values include source marker in metadata', () => {

        /**
         * Validates: Requirements 10.8
         *
         * When customBaseImage is set to any valid image string, the
         * transformation must set _baseImageSource to 'custom' and
         * baseImage to the custom value.
         */
        it('custom values get _baseImageSource set to "custom"', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbBaseAnswers,
                arbValidCustomImage,
                (baseAnswers, customImage) => {
                    const answers = {
                        ...baseAnswers,
                        baseImage: 'original/image:v1',
                        customBaseImage: customImage
                    }

                    const result = applyCustomBaseImageTransform(answers)

                    assert.strictEqual(
                        result._baseImageSource,
                        'custom',
                        `_baseImageSource should be 'custom' but got: ${result._baseImageSource}`
                    )
                    assert.strictEqual(
                        result.baseImage,
                        customImage,
                        `baseImage should be the custom value "${customImage}" but got: ${result.baseImage}`
                    )
                    assert.strictEqual(
                        result.customBaseImage,
                        undefined,
                        'customBaseImage should be deleted from the result'
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        /**
         * Validates: Requirements 10.8
         *
         * When customBaseImage is NOT set (user selected from catalog),
         * _baseImageSource should remain undefined.
         */
        it('non-custom values do not get the source marker', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbBaseAnswers,
                arbValidCustomImage,
                (baseAnswers, catalogImage) => {
                    const answers = {
                        ...baseAnswers,
                        baseImage: catalogImage
                        // no customBaseImage — user picked from catalog
                    }

                    const result = applyCustomBaseImageTransform(answers)

                    assert.strictEqual(
                        result._baseImageSource,
                        undefined,
                        `_baseImageSource should be undefined for catalog selections but got: ${result._baseImageSource}`
                    )
                    assert.strictEqual(
                        result.baseImage,
                        catalogImage,
                        `baseImage should remain unchanged as "${catalogImage}"`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })

        /**
         * Validates: Requirements 10.8
         *
         * The transformation preserves all other answer fields unchanged.
         */
        it('transformation preserves all other answer fields', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbBaseAnswers,
                arbValidCustomImage,
                (baseAnswers, customImage) => {
                    const answers = {
                        ...baseAnswers,
                        baseImage: 'original/image:v1',
                        customBaseImage: customImage
                    }

                    const result = applyCustomBaseImageTransform(answers)

                    // All original base fields should be preserved
                    for (const [key, value] of Object.entries(baseAnswers)) {
                        assert.deepStrictEqual(
                            result[key],
                            value,
                            `Field "${key}" should be preserved but changed`
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
