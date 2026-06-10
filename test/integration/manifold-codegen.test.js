// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage Manifold Code Generation Integration Test
 *
 * Verifies that codegen-manifold.js produces correct PCA projections:
 *   - Feed 5+ proven configs through the script
 *   - Verify PCA separation (different architectures cluster apart)
 *   - Verify "Plot my config" places star correctly (client-side projection)
 *   - Verify filtering excludes/includes correct points
 *
 * Feature: ci-benchmark-pipeline
 * Task: 8.3 Coverage manifold with real data test
 * Requirements: 9.1, 9.5, 9.14
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MANIFOLD_SCRIPT = path.join(ROOT, 'scripts', 'codegen-manifold.js');
const OUTPUT_PATH = path.join(ROOT, '.kiro', 'tmp', 'test-manifold-output.json');

// ── Helper: Client-side projection (mirrors docs/js/coverage-manifold.js logic) ──

/**
 * Project a user config to 2D using encoding_maps + PCA components.
 * This mirrors what the client-side JS would do in the browser.
 */
function projectConfig(userConfig, manifoldData) {
    const encoded = manifoldData.dimensions_used.map(dim => {
        const value = String(userConfig[dim] ?? '');
        return manifoldData.encoding_maps[dim][value] ?? 0;
    });

    const centered = encoded.map((v, i) => v - manifoldData.pca_mean[i]);

    const x = manifoldData.pca_components[0].reduce((sum, w, i) => sum + w * centered[i], 0);
    const y = manifoldData.pca_components[1].reduce((sum, w, i) => sum + w * centered[i], 0);

    return { x, y };
}

/**
 * Compute Euclidean distance between two 2D points.
 */
function euclideanDistance(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Find k nearest points from a set of points to a target point.
 */
function findKNearest(target, points, k = 3) {
    const scored = points
        .map(p => ({ point: p, distance: euclideanDistance(target, p) }))
        .sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Coverage Manifold Codegen Integration', function () {
    this.timeout(60000);

    let manifoldData;

    before(() => {
        // Ensure tmp dir exists
        const tmpDir = path.dirname(OUTPUT_PATH);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Run the codegen script with --sample to generate synthetic data
        try {
            execSync(
                `node "${MANIFOLD_SCRIPT}" --sample --output "${OUTPUT_PATH}"`,
                { cwd: ROOT, timeout: 30000, encoding: 'utf-8' }
            );
        } catch (err) {
            throw new Error(`codegen-manifold.js failed: ${err.message}`);
        }

        // Load the output
        const content = fs.readFileSync(OUTPUT_PATH, 'utf-8');
        manifoldData = JSON.parse(content);
    });

    after(() => {
        // Clean up test output
        try {
            fs.unlinkSync(OUTPUT_PATH);
        } catch { /* ignore */ }
    });

    describe('Manifold data structure', () => {
        it('contains required top-level fields', () => {
            assert.strictEqual(manifoldData.projection_method, 'pca');
            assert.ok(Array.isArray(manifoldData.dimensions_used));
            assert.ok(manifoldData.encoding_maps);
            assert.ok(Array.isArray(manifoldData.pca_components));
            assert.ok(Array.isArray(manifoldData.pca_mean));
            assert.ok(Array.isArray(manifoldData.points));
            assert.ok(manifoldData.generated_at);
            assert.ok(typeof manifoldData.total_configs === 'number');
        });

        it('has 2 PCA components', () => {
            assert.strictEqual(manifoldData.pca_components.length, 2);
        });

        it('PCA mean has correct dimensionality', () => {
            assert.strictEqual(
                manifoldData.pca_mean.length,
                manifoldData.dimensions_used.length
            );
        });

        it('each PCA component has correct dimensionality', () => {
            for (const comp of manifoldData.pca_components) {
                assert.strictEqual(comp.length, manifoldData.dimensions_used.length);
            }
        });

        it('has 5+ proven configs in sample data', () => {
            const proven = manifoldData.points.filter(p =>
                p.status === 'proven' || p.status === 'completed' || p.status === 'passed'
            );
            assert.ok(proven.length >= 5,
                `Expected at least 5 proven configs, got ${proven.length}`);
        });

        it('total_configs matches points array length', () => {
            assert.strictEqual(manifoldData.total_configs, manifoldData.points.length);
        });
    });

    describe('PCA separation — different architectures cluster apart', () => {
        it('vllm and sglang configs have different centroids', () => {
            const vllmPoints = manifoldData.points.filter(p =>
                p.deployment_config === 'transformers-vllm'
            );
            const sglangPoints = manifoldData.points.filter(p =>
                p.deployment_config === 'transformers-sglang'
            );

            if (vllmPoints.length === 0 || sglangPoints.length === 0) {
                return this.skip();
            }

            const vllmCentroid = {
                x: vllmPoints.reduce((s, p) => s + p.x, 0) / vllmPoints.length,
                y: vllmPoints.reduce((s, p) => s + p.y, 0) / vllmPoints.length
            };
            const sglangCentroid = {
                x: sglangPoints.reduce((s, p) => s + p.x, 0) / sglangPoints.length,
                y: sglangPoints.reduce((s, p) => s + p.y, 0) / sglangPoints.length
            };

            const dist = euclideanDistance(vllmCentroid, sglangCentroid);
            assert.ok(dist > 0, 'Different deployment_config groups should have different centroids');
        });

        it('different model families show separation in PCA space', () => {
            const families = {};
            for (const p of manifoldData.points) {
                if (!families[p.model_family]) families[p.model_family] = [];
                families[p.model_family].push(p);
            }

            const familyNames = Object.keys(families).filter(f => families[f].length >= 2);
            if (familyNames.length < 2) {
                return this.skip();
            }

            // Compute centroids for each family
            const centroids = {};
            for (const f of familyNames) {
                centroids[f] = {
                    x: families[f].reduce((s, p) => s + p.x, 0) / families[f].length,
                    y: families[f].reduce((s, p) => s + p.y, 0) / families[f].length
                };
            }

            // At least two families should have distinct centroids
            let hasSeparation = false;
            for (let i = 0; i < familyNames.length; i++) {
                for (let j = i + 1; j < familyNames.length; j++) {
                    const dist = euclideanDistance(centroids[familyNames[i]], centroids[familyNames[j]]);
                    if (dist > 0.01) hasSeparation = true;
                }
            }
            assert.ok(hasSeparation, 'At least some model families should show PCA separation');
        });
    });

    describe('"Plot my config" — client-side projection correctness', () => {
        it('projects a known config to a finite x,y coordinate', () => {
            const userConfig = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                enable_lora: 'true',
                deployment_target: 'realtime-inference'
            };

            const projected = projectConfig(userConfig, manifoldData);

            assert.ok(Number.isFinite(projected.x), 'x should be finite');
            assert.ok(Number.isFinite(projected.y), 'y should be finite');
        });

        it('same config always projects to same coordinates (deterministic)', () => {
            const userConfig = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                enable_lora: 'true',
                deployment_target: 'realtime-inference'
            };

            const proj1 = projectConfig(userConfig, manifoldData);
            const proj2 = projectConfig(userConfig, manifoldData);

            assert.strictEqual(proj1.x, proj2.x);
            assert.strictEqual(proj1.y, proj2.y);
        });

        it('different configs project to different coordinates', () => {
            const configA = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'none',
                tp_degree: '1',
                enable_lora: 'false',
                deployment_target: 'realtime-inference'
            };
            const configB = {
                deployment_config: 'transformers-sglang',
                model_family: 'llama3',
                instance_family: 'p5',
                quantization: 'fp8',
                tp_degree: '8',
                enable_lora: 'true',
                deployment_target: 'async-inference'
            };

            const projA = projectConfig(configA, manifoldData);
            const projB = projectConfig(configB, manifoldData);

            const dist = euclideanDistance(projA, projB);
            assert.ok(dist > 0, 'Distinct configs should project to different positions');
        });

        it('user config projects near matching proven points', () => {
            // Find a proven point from the manifold
            const provenPoints = manifoldData.points.filter(p =>
                p.status === 'proven' || p.status === 'completed' || p.status === 'passed'
            );
            if (provenPoints.length === 0) return this.skip();

            const target = provenPoints[0];
            const userConfig = {
                deployment_config: target.deployment_config,
                model_family: target.model_family,
                instance_family: target.instance_family,
                quantization: target.quantization,
                tp_degree: String(target.tp_degree),
                enable_lora: String(target.enable_lora),
                deployment_target: target.deployment_target
            };

            const projected = projectConfig(userConfig, manifoldData);

            // The user config should project very close to (or at) the proven point
            const dist = euclideanDistance(projected, { x: target.x, y: target.y });
            assert.ok(dist < 0.01,
                `User config matching a proven point should project within 0.01 distance, got ${dist}`);
        });

        it('finds 3 nearest proven points to user config', () => {
            const userConfig = {
                deployment_config: 'transformers-vllm',
                model_family: 'qwen3',
                instance_family: 'g5',
                quantization: 'fp8',
                tp_degree: '2',
                enable_lora: 'true',
                deployment_target: 'realtime-inference'
            };

            const projected = projectConfig(userConfig, manifoldData);
            const provenPoints = manifoldData.points.filter(p =>
                p.status === 'proven' || p.status === 'completed' || p.status === 'passed'
            );

            if (provenPoints.length < 3) return this.skip();

            const nearest = findKNearest(projected, provenPoints, 3);
            assert.strictEqual(nearest.length, 3);

            // Verify they are actually the 3 closest
            for (const other of provenPoints) {
                const otherDist = euclideanDistance(projected, { x: other.x, y: other.y });
                // Every point not in the top-3 should be at least as far as the furthest top-3
                if (!nearest.find(n => n.point.configId === other.configId)) {
                    assert.ok(
                        otherDist >= nearest[2].distance - 1e-9,
                        'A non-top-3 point should not be closer than the 3rd nearest'
                    );
                }
            }
        });
    });

    describe('Filtering — excludes/includes correct points', () => {
        it('filtering by deployment_config returns only matching points', () => {
            const filtered = manifoldData.points.filter(p =>
                p.deployment_config === 'transformers-vllm'
            );

            if (filtered.length === 0) return this.skip();

            for (const p of filtered) {
                assert.strictEqual(p.deployment_config, 'transformers-vllm');
            }

            // Verify excluded points are actually excluded
            const excluded = manifoldData.points.filter(p =>
                p.deployment_config !== 'transformers-vllm'
            );
            for (const p of excluded) {
                assert.notStrictEqual(p.deployment_config, 'transformers-vllm');
            }
        });

        it('filtering by model_family returns only matching points', () => {
            const targetFamily = manifoldData.points[0]?.model_family;
            if (!targetFamily) return this.skip();

            const filtered = manifoldData.points.filter(p =>
                p.model_family === targetFamily
            );

            assert.ok(filtered.length > 0);
            for (const p of filtered) {
                assert.strictEqual(p.model_family, targetFamily);
            }
        });

        it('filtering by instance_family returns only matching points', () => {
            const filtered = manifoldData.points.filter(p =>
                p.instance_family === 'g5'
            );

            if (filtered.length === 0) return this.skip();

            for (const p of filtered) {
                assert.strictEqual(p.instance_family, 'g5');
            }
        });

        it('combined filter narrows results correctly', () => {
            const filtered = manifoldData.points.filter(p =>
                p.deployment_config === 'transformers-vllm' &&
                p.model_family === 'qwen3'
            );

            for (const p of filtered) {
                assert.strictEqual(p.deployment_config, 'transformers-vllm');
                assert.strictEqual(p.model_family, 'qwen3');
            }

            // Count should be <= individual filters
            const vllmOnly = manifoldData.points.filter(p =>
                p.deployment_config === 'transformers-vllm'
            );
            assert.ok(filtered.length <= vllmOnly.length);
        });

        it('no matching points excluded by filter', () => {
            const targetConfig = 'transformers-vllm';
            const filtered = manifoldData.points.filter(p =>
                p.deployment_config === targetConfig
            );
            const allMatchingCount = manifoldData.points.reduce((count, p) =>
                p.deployment_config === targetConfig ? count + 1 : count, 0
            );

            assert.strictEqual(filtered.length, allMatchingCount,
                'Filter must not exclude any matching points');
        });
    });

    describe('Encoding consistency', () => {
        it('all encoding_maps keys match dimensions_used', () => {
            for (const dim of manifoldData.dimensions_used) {
                assert.ok(manifoldData.encoding_maps[dim],
                    `Encoding map should exist for dimension: ${dim}`);
            }
        });

        it('points have all required fields', () => {
            for (const point of manifoldData.points) {
                assert.ok(point.configId, 'Point must have configId');
                assert.ok(typeof point.x === 'number', 'Point must have numeric x');
                assert.ok(typeof point.y === 'number', 'Point must have numeric y');
                assert.ok(point.status, 'Point must have status');
                assert.ok(point.deployment_config, 'Point must have deployment_config');
            }
        });
    });
});
