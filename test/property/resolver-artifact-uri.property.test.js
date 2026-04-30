// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver artifactUri Extraction Correctness Property-Based Test
 *
 * Property 1: For any JumpStart spec JSON object containing a
 * `hosting_prepacked_artifact_key` or `hosting_artifact_key` field,
 * the `JumpStartPublicResolver._mapToMetadata()` function SHALL return
 * a `ModelMetadata` object whose `artifactUri` field equals
 * `s3://jumpstart-cache-prod-{region}/{key}`. For any spec object
 * missing both artifact key fields, `artifactUri` SHALL be undefined.
 *
 * Feature: model-server-loading-adapter, Property 1: Resolver artifactUri extraction correctness
 * Validates: Requirements 1.1, 1.5
 */

import fc from 'fast-check'
import { describe, it } from 'mocha'
import { strict as assert } from 'node:assert'
import { JumpStartPublicResolver } from '../../servers/model-picker/index.js'

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false }

// ── Test region constant ─────────────────────────────────────────────────────

const TEST_REGION = 'us-west-2'
const EXPECTED_BUCKET = `jumpstart-cache-prod-${TEST_REGION}`

// ── Generators ───────────────────────────────────────────────────────────────

/** Generate a non-empty artifact key string (S3 key path) */
const arbArtifactKey = fc.stringMatching(/^[a-zA-Z0-9/_.-]{1,60}$/)

/** Generate an optional artifact key (null means field absent) */
const arbOptionalKey = fc.option(arbArtifactKey, { nil: undefined })

/** Generate a model ID */
const arbModelId = fc.stringMatching(/^[a-zA-Z0-9-]{1,40}$/)

/** Generate a JumpStart spec object with optional artifact key fields */
const arbJumpStartSpec = fc.record({
    model_id: arbModelId,
    hosting_prepacked_artifact_key: arbOptionalKey,
    hosting_artifact_key: arbOptionalKey,
    framework: fc.option(fc.constantFrom('pytorch', 'tensorflow', 'huggingface')),
    model_type: fc.option(fc.constantFrom('llm', 'embedding', 'vision')),
    inference_task: fc.option(fc.constantFrom('text-generation', 'fill-mask', 'image-classification'))
})

// ── Helper: create resolver instance ─────────────────────────────────────────

function createResolver() {
    return new JumpStartPublicResolver({ region: TEST_REGION })
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter, Property 1: Resolver artifactUri extraction correctness', () => {

    describe('Specs with hosting_prepacked_artifact_key produce correct artifactUri', () => {

        it('when hosting_prepacked_artifact_key is present, artifactUri equals s3://{bucket}/{key}', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.1**
            const resolver = createResolver()

            fc.assert(fc.property(
                arbModelId,
                arbArtifactKey,
                arbOptionalKey,
                (modelId, prepackedKey, artifactKey) => {
                    const spec = {
                        model_id: modelId,
                        hosting_prepacked_artifact_key: prepackedKey,
                        hosting_artifact_key: artifactKey
                    }
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(
                        result.artifactUri,
                        `s3://${EXPECTED_BUCKET}/${prepackedKey}`,
                        `artifactUri should be s3://${EXPECTED_BUCKET}/${prepackedKey}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Specs with only hosting_artifact_key produce correct artifactUri', () => {

        it('when only hosting_artifact_key is present, artifactUri uses that key as fallback', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.1**
            const resolver = createResolver()

            fc.assert(fc.property(
                arbModelId,
                arbArtifactKey,
                (modelId, artifactKey) => {
                    const spec = {
                        model_id: modelId,
                        hosting_artifact_key: artifactKey
                        // hosting_prepacked_artifact_key intentionally absent
                    }
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(
                        result.artifactUri,
                        `s3://${EXPECTED_BUCKET}/${artifactKey}`,
                        `artifactUri should fall back to hosting_artifact_key: s3://${EXPECTED_BUCKET}/${artifactKey}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('hosting_prepacked_artifact_key takes precedence over hosting_artifact_key', () => {

        it('when both keys are present, artifactUri uses hosting_prepacked_artifact_key', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.1**
            const resolver = createResolver()

            fc.assert(fc.property(
                arbModelId,
                arbArtifactKey,
                arbArtifactKey,
                (modelId, prepackedKey, artifactKey) => {
                    fc.pre(prepackedKey !== artifactKey)

                    const spec = {
                        model_id: modelId,
                        hosting_prepacked_artifact_key: prepackedKey,
                        hosting_artifact_key: artifactKey
                    }
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(
                        result.artifactUri,
                        `s3://${EXPECTED_BUCKET}/${prepackedKey}`,
                        'artifactUri should prefer hosting_prepacked_artifact_key over hosting_artifact_key'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Specs missing both artifact keys produce no artifactUri', () => {

        it('when both keys are absent, artifactUri is undefined', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.5**
            const resolver = createResolver()

            fc.assert(fc.property(
                arbModelId,
                (modelId) => {
                    const spec = {
                        model_id: modelId
                        // No hosting_prepacked_artifact_key or hosting_artifact_key
                    }
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(
                        result.artifactUri,
                        undefined,
                        'artifactUri should be undefined when both keys are missing'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Full random spec objects produce correct artifactUri or undefined', () => {

        it('for any random spec, artifactUri is correctly derived or absent', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.1, 1.5**
            const resolver = createResolver()

            fc.assert(fc.property(
                arbJumpStartSpec,
                (spec) => {
                    const modelId = spec.model_id
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(result.provider, 'jumpstart', 'Provider should be jumpstart')

                    const expectedKey = spec.hosting_prepacked_artifact_key || spec.hosting_artifact_key
                    if (expectedKey) {
                        assert.strictEqual(
                            result.artifactUri,
                            `s3://${EXPECTED_BUCKET}/${expectedKey}`,
                            `artifactUri should be s3://${EXPECTED_BUCKET}/${expectedKey}`
                        )
                    } else {
                        assert.strictEqual(
                            result.artifactUri,
                            undefined,
                            'artifactUri should be undefined when both keys are missing'
                        )
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Region is correctly reflected in the bucket name', () => {

        it('artifactUri uses the configured region in the bucket name', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 1.1**
            const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1']

            fc.assert(fc.property(
                fc.constantFrom(...regions),
                arbModelId,
                arbArtifactKey,
                (region, modelId, artifactKey) => {
                    const resolver = new JumpStartPublicResolver({ region })
                    const spec = {
                        model_id: modelId,
                        hosting_prepacked_artifact_key: artifactKey
                    }
                    const result = resolver._mapToMetadata(spec, modelId)

                    assert.ok(result !== null, 'Result should not be null')
                    assert.strictEqual(
                        result.artifactUri,
                        `s3://jumpstart-cache-prod-${region}/${artifactKey}`,
                        `artifactUri should use region ${region} in bucket name`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })
})
