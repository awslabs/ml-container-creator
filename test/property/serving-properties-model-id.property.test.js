// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serving.properties model_id Correctness Property-Based Test
 *
 * Property 3: For any combination of modelSource and artifactUri, the rendered
 * serving.properties SHALL set option.model_id as follows:
 * - When modelSource is huggingface or unset: option.model_id equals modelName.
 * - When modelSource is s3, jumpstart, jumpstart-hub, or registry AND artifactUri
 *   is non-empty: option.model_id equals artifactUri.
 * - When modelSource is jumpstart AND artifactUri is empty: option.model_id is
 *   commented out with an explanatory note.
 *
 * Feature: model-server-loading-adapter, Property 3: Serving.properties model_id correctness
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4
 */

import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'node:assert'
import ejs from 'ejs'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false }

// ── Load the actual serving.properties template ──────────────────────────────

const SERVING_PROPS_TEMPLATE_PATH = resolve(__dirname, '../../generators/app/templates/code/serving.properties')
const SERVING_PROPS_TEMPLATE = readFileSync(SERVING_PROPS_TEMPLATE_PATH, 'utf-8')

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_SOURCES = ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry']
const DJL_SERVERS = ['lmi', 'djl']
const NON_HF_SOURCES = ['s3', 'jumpstart', 'jumpstart-hub', 'registry']

// ── Generators ───────────────────────────────────────────────────────────────

const arbModelSource = fc.constantFrom(...MODEL_SOURCES)
const arbModelServer = fc.constantFrom(...DJL_SERVERS)
const arbArtifactUri = fc.option(
    fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/)
)
const arbModelName = fc.stringMatching(/^[a-zA-Z0-9/_-]{1,40}$/)

// ── Helper: render serving.properties template ───────────────────────────────

function renderServingProperties(modelSource, modelServer, modelName, artifactUri) {
    return ejs.render(SERVING_PROPS_TEMPLATE, {
        modelSource,
        modelServer,
        modelName: modelName || 'test-model',
        artifactUri: artifactUri || '',
        hfToken: '',
        chatTemplate: '',
        orderedEnvVars: []
    })
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter, Property 3: Serving.properties model_id correctness', () => {

    describe('HuggingFace source sets option.model_id to modelName', () => {

        it('for any DJL server with modelSource=huggingface, option.model_id equals modelName', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelServer, modelName, artifactUri) => {
                    const rendered = renderServingProperties('huggingface', modelServer, modelName, artifactUri)
                    assert.ok(
                        rendered.includes(`option.model_id=${modelName}`),
                        `HuggingFace source must set option.model_id=${modelName} for ${modelServer}, got:\n${rendered}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for any DJL server with modelSource unset, option.model_id equals modelName', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderServingProperties('', modelServer, modelName, null)
                    assert.ok(
                        rendered.includes(`option.model_id=${modelName}`),
                        `Unset modelSource must set option.model_id=${modelName} for ${modelServer}, got:\n${rendered}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Non-HF sources with non-empty artifactUri set option.model_id to artifactUri', () => {

        it('for any non-HF source with a valid artifactUri, option.model_id equals artifactUri', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 7.1, 7.2**
            fc.assert(fc.property(
                fc.constantFrom(...NON_HF_SOURCES),
                arbModelServer,
                arbModelName,
                fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/),
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServingProperties(modelSource, modelServer, modelName, artifactUri)
                    assert.ok(
                        rendered.includes(`option.model_id=${artifactUri}`),
                        `${modelSource} with artifactUri must set option.model_id=${artifactUri} for ${modelServer}, got:\n${rendered}`
                    )
                    // Extract the actual model_id value from the rendered output
                    const modelIdLine = rendered.split('\n').find(l => l.trim().startsWith('option.model_id='))
                    const actualValue = modelIdLine ? modelIdLine.trim().replace('option.model_id=', '') : ''
                    assert.strictEqual(
                        actualValue, artifactUri,
                        `${modelSource} with artifactUri must set option.model_id to artifactUri, not modelName for ${modelServer}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('JumpStart without artifactUri comments out option.model_id', () => {

        it('for jumpstart with empty artifactUri, option.model_id is commented out', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 7.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderServingProperties('jumpstart', modelServer, modelName, null)
                    // Should contain the commented-out model_id
                    assert.ok(
                        rendered.includes('# option.model_id=/opt/ml/model'),
                        `jumpstart without artifactUri must comment out option.model_id for ${modelServer}, got:\n${rendered}`
                    )
                    // Should contain explanatory note
                    assert.ok(
                        rendered.includes('Model will be loaded from /opt/ml/model'),
                        `jumpstart without artifactUri must include explanatory note for ${modelServer}`
                    )
                    // Should NOT have an active option.model_id line
                    const activeModelIdLines = rendered.split('\n').filter(
                        line => line.trim().startsWith('option.model_id=')
                    )
                    assert.strictEqual(
                        activeModelIdLines.length, 0,
                        `jumpstart without artifactUri must NOT have active option.model_id for ${modelServer}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('All modelSource × modelServer combinations render without error', () => {

        it('for any valid (modelSource, modelServer, modelName, artifactUri) tuple, the template renders successfully', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServingProperties(modelSource, modelServer, modelName, artifactUri)
                    assert.ok(
                        typeof rendered === 'string' && rendered.length > 0,
                        'Rendered output must be a non-empty string'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Exactly one model_id strategy is applied per render', () => {

        it('for any inputs, rendered output contains exactly one model_id declaration (active or commented)', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServingProperties(modelSource, modelServer, modelName, artifactUri)
                    const lines = rendered.split('\n')

                    // Count active option.model_id= lines
                    const activeLines = lines.filter(l => l.trim().startsWith('option.model_id='))
                    // Count commented option.model_id lines (the specific pattern)
                    const commentedLines = lines.filter(l => l.trim() === '# option.model_id=/opt/ml/model')

                    const totalDeclarations = activeLines.length + commentedLines.length
                    assert.ok(
                        totalDeclarations === 1,
                        `Expected exactly 1 model_id declaration, found ${activeLines.length} active + ${commentedLines.length} commented for ${modelSource}/${modelServer}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })
})
