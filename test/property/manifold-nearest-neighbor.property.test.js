// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property P9: Nearest-Neighbor Correctness
 *
 * For any user config point and set of proven points, the 3 nearest neighbors
 * returned have the smallest Euclidean distance in 2D projected space — no other
 * point has a smaller distance.
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 9.6**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// --- Inline implementation of nearest-neighbor logic (mirrors coverage-manifold.js) ---

function findNearestProven(point, points, k = 3) {
    const proven = points.filter(p =>
        p.status === 'proven' || p.status === 'passed' || p.status === 'completed'
    );
    if (proven.length === 0) return [];

    const withDist = proven.map(p => ({
        point: p,
        distance: Math.sqrt((p.x - point.x) ** 2 + (p.y - point.y) ** 2)
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    return withDist.slice(0, k);
}

function euclidean(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// --- Generators ---

const arbCoord = fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true });

const arbStatus = fc.constantFrom('proven', 'passed', 'completed', 'failed', 'unfeasible');

const arbPoint = fc.record({
    x: arbCoord,
    y: arbCoord,
    status: arbStatus,
    configId: fc.stringMatching(/^[0-9a-f]{16}$/),
    throughput_rps: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
    deployment_config: fc.constantFrom('transformers-vllm', 'transformers-sglang', 'http-flask'),
    model_name: fc.constantFrom('Qwen/Qwen3-4B', 'meta-llama/Llama-3.1-8B'),
    instance_type: fc.constantFrom('ml.g5.xlarge', 'ml.g6.xlarge'),
    deployment_target: fc.constantFrom('realtime-inference', 'async-inference')
});

const arbUserPoint = fc.record({
    x: arbCoord,
    y: arbCoord
});

describe('Property P9: Nearest-Neighbor Correctness', () => {
    it('the k nearest proven points have the smallest Euclidean distances', () => {
        fc.assert(fc.property(
            arbUserPoint,
            fc.array(arbPoint, { minLength: 1, maxLength: 50 }),
            (userPoint, points) => {
                const k = 3;
                const result = findNearestProven(userPoint, points, k);

                // Get all proven points for ground truth comparison
                const allProven = points.filter(p =>
                    p.status === 'proven' || p.status === 'passed' || p.status === 'completed'
                );

                if (allProven.length === 0) {
                    // No proven points → empty result
                    assert.strictEqual(result.length, 0);
                    return;
                }

                // Result size should be min(k, proven count)
                assert.strictEqual(result.length, Math.min(k, allProven.length));

                // All returned points must be proven
                for (const r of result) {
                    assert.ok(
                        r.point.status === 'proven' ||
                        r.point.status === 'passed' ||
                        r.point.status === 'completed',
                        `Returned point has non-proven status: ${r.point.status}`
                    );
                }

                // Result must be sorted by ascending distance
                for (let i = 1; i < result.length; i++) {
                    assert.ok(
                        result[i].distance >= result[i - 1].distance - 1e-10,
                        `Results not sorted: distance[${i - 1}]=${result[i - 1].distance} > distance[${i}]=${result[i].distance}`
                    );
                }

                // No excluded proven point has a smaller distance than the farthest returned point
                if (result.length > 0) {
                    const maxReturnedDist = result[result.length - 1].distance;

                    for (const p of allProven) {
                        const dist = euclidean(userPoint, p);
                        const isInResult = result.some(r =>
                            r.point.x === p.x && r.point.y === p.y
                        );
                        if (!isInResult) {
                            assert.ok(
                                dist >= maxReturnedDist - 1e-10,
                                `Excluded proven point at distance ${dist} is closer than farthest result at ${maxReturnedDist}`
                            );
                        }
                    }
                }
            }
        ), PROPERTY_CONFIG);
    });

    it('result contains exactly k elements when enough proven points exist', () => {
        fc.assert(fc.property(
            arbUserPoint,
            fc.array(
                fc.record({
                    x: arbCoord,
                    y: arbCoord,
                    status: fc.constant('proven'),
                    configId: fc.stringMatching(/^[0-9a-f]{16}$/),
                    throughput_rps: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
                    deployment_config: fc.constant('transformers-vllm'),
                    model_name: fc.constant('Qwen/Qwen3-4B'),
                    instance_type: fc.constant('ml.g5.xlarge'),
                    deployment_target: fc.constant('realtime-inference')
                }),
                { minLength: 3, maxLength: 30 }
            ),
            (userPoint, provenPoints) => {
                const result = findNearestProven(userPoint, provenPoints, 3);
                assert.strictEqual(result.length, 3, 'Should return exactly 3 points when >= 3 proven points exist');
            }
        ), PROPERTY_CONFIG);
    });

    it('distances in result are correct Euclidean distances', () => {
        fc.assert(fc.property(
            arbUserPoint,
            fc.array(arbPoint, { minLength: 1, maxLength: 30 }),
            (userPoint, points) => {
                const result = findNearestProven(userPoint, points, 3);

                for (const r of result) {
                    const expectedDist = euclidean(userPoint, r.point);
                    assert.ok(
                        Math.abs(r.distance - expectedDist) < 1e-10,
                        `Distance mismatch: got ${r.distance}, expected ${expectedDist}`
                    );
                }
            }
        ), PROPERTY_CONFIG);
    });
});
