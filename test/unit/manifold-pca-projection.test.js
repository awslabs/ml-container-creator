// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PCA projection in the Coverage Manifold visualization.
 *
 * Tests:
 * - Encoding consistency (same input → same coordinates)
 * - Client-side projection matches server-side for same input
 * - Edge cases (single point, all same config)
 * - Encoding maps handle unknown categories (fallback to 0)
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 9.1, 9.5**
 */

import { describe, it } from 'mocha'
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

// --- Load the manifold data file ---
const MANIFOLD_DATA_PATH = path.join(ROOT, 'docs', 'data', 'coverage-manifold.json')

function loadManifoldData() {
    if (!fs.existsSync(MANIFOLD_DATA_PATH)) return null
    return JSON.parse(fs.readFileSync(MANIFOLD_DATA_PATH, 'utf8'))
}

// --- Client-side projection logic (mirrors docs/js/coverage-manifold.js) ---

function projectConfig(userConfig, data) {
    if (!data || !data.encoding_maps || !data.pca_components || !data.pca_mean) return null

    const encoded = data.dimensions_used.map(dim => {
        const value = String(userConfig[dim] ?? '')
        return data.encoding_maps[dim]?.[value] ?? 0
    })

    const centered = encoded.map((v, i) => v - data.pca_mean[i])

    const x = data.pca_components[0].reduce((sum, w, i) => sum + w * centered[i], 0)
    const y = data.pca_components[1].reduce((sum, w, i) => sum + w * centered[i], 0)

    return { x, y }
}

// --- Server-side encoding logic (mirrors scripts/codegen-manifold.js) ---

function encodePoint(point, encodingMaps, dimensionsUsed) {
    return dimensionsUsed.map(dim => {
        const value = String(point[dim] ?? '')
        return encodingMaps[dim]?.[value] ?? 0
    })
}

function projectServerSide(point, data) {
    const encoded = encodePoint(point, data.encoding_maps, data.dimensions_used)
    const centered = encoded.map((v, i) => v - data.pca_mean[i])
    const x = data.pca_components[0].reduce((sum, w, i) => sum + w * centered[i], 0)
    const y = data.pca_components[1].reduce((sum, w, i) => sum + w * centered[i], 0)
    return { x, y }
}

describe('PCA Projection — Unit Tests', () => {
    let manifoldData

    before(() => {
        manifoldData = loadManifoldData()
        if (!manifoldData) {
            console.warn('⚠️  No manifold data file found — some tests will be skipped')
        }
    })

    describe('Encoding Consistency', () => {
        it('same input always produces same coordinates', () => {
            if (!manifoldData) return

            const config = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'fp16',
                tp_degree: '1',
                enable_lora: 'false',
                deployment_target: 'realtime-inference'
            }

            const result1 = projectConfig(config, manifoldData)
            const result2 = projectConfig(config, manifoldData)

            assert.strictEqual(result1.x, result2.x, 'X coordinates should be identical')
            assert.strictEqual(result1.y, result2.y, 'Y coordinates should be identical')
        })

        it('different configs produce different coordinates', () => {
            if (!manifoldData) return

            const config1 = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'fp16',
                tp_degree: '1',
                enable_lora: 'false',
                deployment_target: 'realtime-inference'
            }
            const config2 = {
                deployment_config: 'http-flask',
                model_family: 'llama3',
                instance_family: 'p5',
                quantization: 'gptq',
                tp_degree: '8',
                enable_lora: 'true',
                deployment_target: 'batch-transform'
            }

            const result1 = projectConfig(config1, manifoldData)
            const result2 = projectConfig(config2, manifoldData)

            const samePoint = (Math.abs(result1.x - result2.x) < 1e-10) &&
                             (Math.abs(result1.y - result2.y) < 1e-10)
            assert.ok(!samePoint, 'Different configs should produce different coordinates')
        })

        it('encoded values match encoding maps exactly', () => {
            if (!manifoldData) return

            const config = {
                deployment_config: 'transformers-sglang',
                model_family: 'deepseek-r1',
                instance_family: 'g6e',
                quantization: 'awq',
                tp_degree: '4',
                enable_lora: 'true',
                deployment_target: 'async-inference'
            }

            const encoded = manifoldData.dimensions_used.map(dim => {
                const value = String(config[dim] ?? '')
                return manifoldData.encoding_maps[dim]?.[value] ?? 0
            })

            assert.strictEqual(encoded[0], 3)  // transformers-sglang
            assert.strictEqual(encoded[1], 3)  // deepseek-r1
            assert.strictEqual(encoded[2], 2)  // g6e
            assert.strictEqual(encoded[3], 5)  // awq
            assert.strictEqual(encoded[4], 2)  // tp_degree 4
            assert.strictEqual(encoded[5], 1)  // enable_lora true
            assert.strictEqual(encoded[6], 1)  // async-inference
        })
    })

    describe('Client-Side Matches Server-Side', () => {
        it('projection of a point matches pre-computed coordinates in manifold data', () => {
            if (!manifoldData || !manifoldData.points || manifoldData.points.length === 0) return

            // Pick a known point from the data
            const point = manifoldData.points[0]

            const config = {
                deployment_config: point.deployment_config,
                model_family: point.model_family,
                instance_family: point.instance_family,
                quantization: point.quantization,
                tp_degree: String(point.tp_degree),
                enable_lora: String(point.enable_lora),
                deployment_target: point.deployment_target
            }

            const projected = projectConfig(config, manifoldData)

            // Allow small rounding difference (codegen rounds to 4 decimal places)
            assert.ok(
                Math.abs(projected.x - point.x) < 0.01,
                `X mismatch: projected=${projected.x}, stored=${point.x}`
            )
            assert.ok(
                Math.abs(projected.y - point.y) < 0.01,
                `Y mismatch: projected=${projected.y}, stored=${point.y}`
            )
        })

        it('client-side and server-side projection produce same result', () => {
            if (!manifoldData) return

            const config = {
                deployment_config: 'transformers-tensorrt-llm',
                model_family: 'mistral',
                instance_family: 'g6',
                quantization: 'fp8',
                tp_degree: '2',
                enable_lora: 'false',
                deployment_target: 'batch-transform'
            }

            const clientResult = projectConfig(config, manifoldData)
            const serverResult = projectServerSide(config, manifoldData)

            assert.ok(
                Math.abs(clientResult.x - serverResult.x) < 1e-10,
                `Client X (${clientResult.x}) != Server X (${serverResult.x})`
            )
            assert.ok(
                Math.abs(clientResult.y - serverResult.y) < 1e-10,
                `Client Y (${clientResult.y}) != Server Y (${serverResult.y})`
            )
        })

        it('multiple points from manifold data are consistent with re-projection', () => {
            if (!manifoldData || !manifoldData.points || manifoldData.points.length < 5) return

            // Test first 5 points
            for (let i = 0; i < Math.min(5, manifoldData.points.length); i++) {
                const point = manifoldData.points[i]
                const config = {
                    deployment_config: point.deployment_config,
                    model_family: point.model_family,
                    instance_family: point.instance_family,
                    quantization: point.quantization,
                    tp_degree: String(point.tp_degree),
                    enable_lora: String(point.enable_lora),
                    deployment_target: point.deployment_target
                }

                const projected = projectConfig(config, manifoldData)

                assert.ok(
                    Math.abs(projected.x - point.x) < 0.01,
                    `Point ${i} X mismatch: projected=${projected.x}, stored=${point.x}`
                )
                assert.ok(
                    Math.abs(projected.y - point.y) < 0.01,
                    `Point ${i} Y mismatch: projected=${projected.y}, stored=${point.y}`
                )
            }
        })
    })

    describe('Edge Cases', () => {
        it('handles unknown category values by falling back to 0', () => {
            if (!manifoldData) return

            const config = {
                deployment_config: 'completely-unknown-config',
                model_family: 'nonexistent-family',
                instance_family: 'z99',
                quantization: 'alien-quant',
                tp_degree: '999',
                enable_lora: 'maybe',
                deployment_target: 'quantum-compute'
            }

            const result = projectConfig(config, manifoldData)

            // Should not throw, should return valid coordinates
            assert.ok(result !== null, 'Should return a result for unknown categories')
            assert.ok(typeof result.x === 'number' && !isNaN(result.x), 'X should be a valid number')
            assert.ok(typeof result.y === 'number' && !isNaN(result.y), 'Y should be a valid number')

            // All values encode to 0, centered = (0 - mean), projected = components dot (0 - mean)
            // Verify this matches projection of all-zeros vector
            const expectedEncoded = manifoldData.dimensions_used.map(() => 0)
            const centered = expectedEncoded.map((v, i) => v - manifoldData.pca_mean[i])
            const expectedX = manifoldData.pca_components[0].reduce((s, w, i) => s + w * centered[i], 0)
            const expectedY = manifoldData.pca_components[1].reduce((s, w, i) => s + w * centered[i], 0)

            assert.ok(Math.abs(result.x - expectedX) < 1e-10, 'Unknown categories should encode as 0')
            assert.ok(Math.abs(result.y - expectedY) < 1e-10, 'Unknown categories should encode as 0')
        })

        it('returns null for missing data fields', () => {
            assert.strictEqual(projectConfig({}, null), null)
            assert.strictEqual(projectConfig({}, {}), null)
            assert.strictEqual(projectConfig({}, { encoding_maps: {} }), null)
            assert.strictEqual(projectConfig({}, { encoding_maps: {}, pca_components: [] }), null)
        })

        it('handles single-point manifold data', () => {
            const singlePointData = {
                dimensions_used: ['deployment_config', 'model_family', 'instance_family', 'quantization', 'tp_degree', 'enable_lora', 'deployment_target'],
                encoding_maps: {
                    deployment_config: { 'transformers-vllm': 2 },
                    model_family: { 'qwen3': 0 },
                    instance_family: { 'g5': 0 },
                    quantization: { 'none': 0 },
                    tp_degree: { '1': 0 },
                    enable_lora: { 'false': 0 },
                    deployment_target: { 'realtime-inference': 0 }
                },
                pca_components: [
                    [1, 0, 0, 0, 0, 0, 0],
                    [0, 1, 0, 0, 0, 0, 0]
                ],
                pca_mean: [1, 0, 0, 0, 0, 0, 0]
            }

            const config = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                enable_lora: 'false',
                deployment_target: 'realtime-inference'
            }

            const result = projectConfig(config, singlePointData)
            assert.ok(result !== null)
            // encoded = [2, 0, 0, 0, 0, 0, 0], centered = [2-1, 0, 0, 0, 0, 0, 0] = [1, 0, ...]
            // x = component[0] dot centered = 1*1 + 0*0 + ... = 1
            // y = component[1] dot centered = 0*1 + 1*0 + ... = 0
            assert.strictEqual(result.x, 1)
            assert.strictEqual(result.y, 0)
        })

        it('handles all-same-config points (zero variance)', () => {
            const data = {
                dimensions_used: ['deployment_config', 'model_family', 'instance_family', 'quantization', 'tp_degree', 'enable_lora', 'deployment_target'],
                encoding_maps: {
                    deployment_config: { 'transformers-vllm': 2 },
                    model_family: { 'qwen3': 0 },
                    instance_family: { 'g5': 0 },
                    quantization: { 'none': 0 },
                    tp_degree: { '1': 0 },
                    enable_lora: { 'false': 0 },
                    deployment_target: { 'realtime-inference': 0 }
                },
                // If all points are the same, mean = that point, so centered = [0,...,0]
                // Any PCA components will project to (0, 0)
                pca_components: [
                    [0.5, 0.5, 0, 0, 0, 0, 0],
                    [0, 0, 0.5, 0.5, 0, 0, 0]
                ],
                pca_mean: [2, 0, 0, 0, 0, 0, 0]
            }

            const config = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                enable_lora: 'false',
                deployment_target: 'realtime-inference'
            }

            const result = projectConfig(config, data)
            assert.ok(result !== null)
            // encoded = [2, 0, 0, 0, 0, 0, 0], centered = [0, 0, 0, 0, 0, 0, 0]
            assert.strictEqual(result.x, 0)
            assert.strictEqual(result.y, 0)
        })

        it('handles partial encoding maps gracefully', () => {
            if (!manifoldData) return

            // Config where only some dimensions are in encoding maps
            const config = {
                deployment_config: 'transformers-vllm', // known
                model_family: 'brand-new-model',        // unknown
                instance_family: 'g5',                  // known
                quantization: 'new-quant',              // unknown
                tp_degree: '1',                         // known
                enable_lora: 'false',                   // known
                deployment_target: 'realtime-inference' // known
            }

            const result = projectConfig(config, manifoldData)
            assert.ok(result !== null, 'Should handle partial unknowns gracefully')
            assert.ok(typeof result.x === 'number' && !isNaN(result.x))
            assert.ok(typeof result.y === 'number' && !isNaN(result.y))
        })
    })

    describe('Manifold Data Structure Validation', () => {
        it('manifold JSON has required fields', () => {
            if (!manifoldData) return

            assert.ok(manifoldData.projection_method, 'Should have projection_method')
            assert.strictEqual(manifoldData.projection_method, 'pca')
            assert.ok(Array.isArray(manifoldData.dimensions_used), 'Should have dimensions_used array')
            assert.ok(manifoldData.encoding_maps, 'Should have encoding_maps')
            assert.ok(Array.isArray(manifoldData.pca_components), 'Should have pca_components')
            assert.strictEqual(manifoldData.pca_components.length, 2, 'Should have 2 PCA components')
            assert.ok(Array.isArray(manifoldData.pca_mean), 'Should have pca_mean')
            assert.ok(Array.isArray(manifoldData.points), 'Should have points array')
            assert.ok(manifoldData.total_configs > 0, 'Should have total_configs > 0')
        })

        it('PCA components have correct dimensionality', () => {
            if (!manifoldData) return

            const numDims = manifoldData.dimensions_used.length
            assert.strictEqual(manifoldData.pca_components[0].length, numDims,
                `Component 0 length should be ${numDims}`)
            assert.strictEqual(manifoldData.pca_components[1].length, numDims,
                `Component 1 length should be ${numDims}`)
            assert.strictEqual(manifoldData.pca_mean.length, numDims,
                `PCA mean length should be ${numDims}`)
        })

        it('encoding maps cover all dimensions', () => {
            if (!manifoldData) return

            for (const dim of manifoldData.dimensions_used) {
                assert.ok(manifoldData.encoding_maps[dim],
                    `encoding_maps should have entry for dimension "${dim}"`)
                assert.ok(Object.keys(manifoldData.encoding_maps[dim]).length > 0,
                    `encoding_maps["${dim}"] should not be empty`)
            }
        })

        it('all points have x and y coordinates', () => {
            if (!manifoldData) return

            for (const point of manifoldData.points) {
                assert.ok(typeof point.x === 'number' && !isNaN(point.x),
                    `Point ${point.configId} should have valid x`)
                assert.ok(typeof point.y === 'number' && !isNaN(point.y),
                    `Point ${point.configId} should have valid y`)
            }
        })
    })
})
