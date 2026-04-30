// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve Script Model Resolution Correctness Property-Based Test
 *
 * Property 2: For any combination of modelSource ∈ {huggingface, s3, jumpstart,
 * jumpstart-hub, registry} and modelServer ∈ {vllm, sglang, tensorrt-llm, lmi, djl},
 * the rendered serve script SHALL:
 * - When modelSource is huggingface: pass modelName directly to the server without downloading.
 * - When modelSource is s3, jumpstart, jumpstart-hub, or registry AND modelServer is
 *   vllm, sglang, or tensorrt-llm: contain S3 download logic that writes to /opt/ml/model
 *   and sets the server's model path to /opt/ml/model.
 * - When modelSource is s3, jumpstart, jumpstart-hub, or registry AND modelServer is
 *   lmi or djl: NOT contain S3 download logic (DJL handles it natively).
 *
 * Feature: model-server-loading-adapter, Property 2: Serve script model resolution correctness
 * Validates: Requirements 3.1, 3.2, 3.4, 4.1, 5.1, 6.1, 11.1, 11.4
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

// ── Load the actual serve template ───────────────────────────────────────────

const SERVE_TEMPLATE_PATH = resolve(__dirname, '../../generators/app/templates/code/serve')
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf-8')

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_SOURCES = ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry']
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']
const DOWNLOAD_SERVERS = ['vllm', 'sglang', 'tensorrt-llm']
const DJL_SERVERS = ['lmi', 'djl']
const NON_HF_SOURCES = ['s3', 'jumpstart', 'jumpstart-hub', 'registry']

// ── Generators ───────────────────────────────────────────────────────────────

const arbModelSource = fc.constantFrom(...MODEL_SOURCES)
const arbModelServer = fc.constantFrom(...MODEL_SERVERS)
const arbModelName = fc.stringMatching(/^[a-zA-Z0-9/_-]{1,40}$/)
const arbArtifactUri = fc.option(
    fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/)
)

// ── Helper: render serve template ────────────────────────────────────────────

function renderServe(modelSource, modelServer, modelName, artifactUri) {
    return ejs.render(SERVE_TEMPLATE, {
        modelSource,
        modelServer,
        modelName: modelName || 'test-model',
        artifactUri: artifactUri || '',
        modelLoadStrategy: 'runtime'
    })
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter, Property 2: Serve script model resolution correctness', () => {

    describe('HuggingFace source passes model name directly without downloading', () => {

        it('for any modelServer with modelSource=huggingface, the rendered script does not define download_model_from_s3 function', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 11.1, 11.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderServe('huggingface', modelServer, modelName, null)
                    // The download_model_from_s3 function definition should NOT be present
                    assert.ok(
                        !rendered.includes('download_model_from_s3()'),
                        `HuggingFace source must NOT define download_model_from_s3() function for ${modelServer}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for download-capable servers with modelSource=huggingface, resolve_model echoes the model var directly', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 11.1**
            fc.assert(fc.property(
                fc.constantFrom(...DOWNLOAD_SERVERS),
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderServe('huggingface', modelServer, modelName, null)
                    // The resolve_model function should have a huggingface case that echoes the model var
                    assert.ok(
                        rendered.includes('resolve_model'),
                        `HuggingFace source must contain resolve_model function for ${modelServer}`
                    )
                    // The huggingface case should echo the model var directly (no download)
                    assert.ok(
                        rendered.includes('echo "${!_MODEL_VAR}"'),
                        `HuggingFace source must echo model var directly for ${modelServer}`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Non-HF sources with download-capable servers contain S3 download logic', () => {

        it('for any non-HF source with vllm/sglang/tensorrt-llm, the rendered script contains download_model_from_s3 and /opt/ml/model', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 3.1, 3.2, 4.1, 5.1, 6.1**
            fc.assert(fc.property(
                fc.constantFrom(...NON_HF_SOURCES),
                fc.constantFrom(...DOWNLOAD_SERVERS),
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, modelServer, modelName, artifactUri)

                    assert.ok(
                        rendered.includes('download_model_from_s3'),
                        `${modelSource}+${modelServer} must contain download_model_from_s3`
                    )
                    assert.ok(
                        rendered.includes('/opt/ml/model'),
                        `${modelSource}+${modelServer} must reference /opt/ml/model`
                    )
                    assert.ok(
                        rendered.includes('LOCAL_MODEL_PATH="/opt/ml/model"'),
                        `${modelSource}+${modelServer} must set LOCAL_MODEL_PATH to /opt/ml/model`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for any non-HF source with vllm/sglang/tensorrt-llm, resolve_model sets model path to /opt/ml/model after download', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 3.2, 4.1, 5.1, 6.1**
            fc.assert(fc.property(
                fc.constantFrom(...NON_HF_SOURCES),
                fc.constantFrom(...DOWNLOAD_SERVERS),
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, modelServer, modelName, artifactUri)

                    // The resolve_model function should call download_model_from_s3 and echo LOCAL_MODEL_PATH
                    assert.ok(
                        rendered.includes('download_model_from_s3 "$MODEL_ARTIFACT_URI" "$LOCAL_MODEL_PATH"'),
                        `${modelSource}+${modelServer} must call download_model_from_s3 with artifact URI and local path`
                    )
                    // After download, it echoes the local model path
                    assert.ok(
                        rendered.includes('echo "$LOCAL_MODEL_PATH"'),
                        `${modelSource}+${modelServer} must echo LOCAL_MODEL_PATH after download`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Non-HF sources with DJL/LMI servers do NOT contain S3 download logic', () => {

        it('for any non-HF source with lmi/djl, the rendered script does NOT contain download_model_from_s3', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 3.4, 6.1**
            fc.assert(fc.property(
                fc.constantFrom(...NON_HF_SOURCES),
                fc.constantFrom(...DJL_SERVERS),
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, modelServer, modelName, artifactUri)

                    assert.ok(
                        !rendered.includes('download_model_from_s3'),
                        `${modelSource}+${modelServer} must NOT contain download_model_from_s3 (DJL handles S3 natively)`
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for any non-HF source with lmi/djl, the rendered script exits early with serving.properties check', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            // **Validates: Requirements 3.4**
            fc.assert(fc.property(
                fc.constantFrom(...NON_HF_SOURCES),
                fc.constantFrom(...DJL_SERVERS),
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, modelServer, modelName, artifactUri)

                    assert.ok(
                        rendered.includes('serving.properties'),
                        `${modelSource}+${modelServer} must reference serving.properties`
                    )
                    assert.ok(
                        rendered.includes('exit 0'),
                        `${modelSource}+${modelServer} must exit 0 (DJL handles serving)`
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
                    // Should not throw
                    const rendered = renderServe(modelSource, modelServer, modelName, artifactUri)
                    assert.ok(typeof rendered === 'string' && rendered.length > 0,
                        'Rendered output must be a non-empty string')
                    assert.ok(rendered.includes('#!/bin/bash'),
                        'Rendered output must start with bash shebang')
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })

    describe('Server-specific model variable is set correctly for download-capable servers', () => {

        it('vllm sets _MODEL_VAR to VLLM_MODEL', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            fc.assert(fc.property(
                arbModelSource,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, 'vllm', modelName, artifactUri)
                    assert.ok(
                        rendered.includes('_MODEL_VAR="VLLM_MODEL"'),
                        'vllm must set _MODEL_VAR to VLLM_MODEL'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('sglang sets _MODEL_VAR to SGLANG_MODEL_PATH', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            fc.assert(fc.property(
                arbModelSource,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, 'sglang', modelName, artifactUri)
                    assert.ok(
                        rendered.includes('_MODEL_VAR="SGLANG_MODEL_PATH"'),
                        'sglang must set _MODEL_VAR to SGLANG_MODEL_PATH'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('tensorrt-llm sets _MODEL_VAR to TRTLLM_MODEL', function () {
            this.timeout(PROPERTY_CONFIG.timeout)
            fc.assert(fc.property(
                arbModelSource,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelName, artifactUri) => {
                    const rendered = renderServe(modelSource, 'tensorrt-llm', modelName, artifactUri)
                    assert.ok(
                        rendered.includes('_MODEL_VAR="TRTLLM_MODEL"'),
                        'tensorrt-llm must set _MODEL_VAR to TRTLLM_MODEL'
                    )
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })
})
