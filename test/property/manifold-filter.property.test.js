// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property P10: Filter Correctness
 *
 * For any filter applied, all returned points match the filter criteria,
 * and no matching point from the original set is excluded.
 *
 * Feature: ci-benchmark-pipeline
 *
 * **Validates: Requirements 9.14**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// --- Inline implementation of filter logic (mirrors coverage-manifold.js) ---

function filterPoints(points, filters) {
    return points.filter(p => {
        if (filters.deployment_config && p.deployment_config !== filters.deployment_config) return false;
        if (filters.model_family && p.model_family !== filters.model_family) return false;
        if (filters.instance_family && p.instance_family !== filters.instance_family) return false;
        return true;
    });
}

// --- Generators ---

const DEPLOYMENT_CONFIGS = [
    'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm',
    'transformers-lmi', 'http-flask', 'http-fastapi', 'triton-python',
    'diffusors-vllm-omni'
];

const MODEL_FAMILIES = ['qwen3', 'llama3', 'deepseek-r1', 'mistral', 'gemma2', 'phi3'];

const INSTANCE_FAMILIES = ['g5', 'g6', 'g6e', 'p5', 'p4d', 'inf2', 'trn2'];

const arbDeploymentConfig = fc.constantFrom(...DEPLOYMENT_CONFIGS);
const arbModelFamily = fc.constantFrom(...MODEL_FAMILIES);
const arbInstanceFamily = fc.constantFrom(...INSTANCE_FAMILIES);

const arbPoint = fc.record({
    x: fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true }),
    y: fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true }),
    status: fc.constantFrom('proven', 'failed', 'unfeasible'),
    configId: fc.stringMatching(/^[0-9a-f]{16}$/),
    deployment_config: arbDeploymentConfig,
    model_family: arbModelFamily,
    instance_family: arbInstanceFamily,
    model_name: fc.constantFrom('Qwen/Qwen3-4B', 'meta-llama/Llama-3.1-8B'),
    instance_type: fc.constantFrom('ml.g5.xlarge', 'ml.g6.xlarge', 'ml.p5.48xlarge'),
    throughput_rps: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
    deployment_target: fc.constantFrom('realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks')
});

const arbFilter = fc.record({
    deployment_config: fc.option(arbDeploymentConfig, { nil: null }),
    model_family: fc.option(arbModelFamily, { nil: null }),
    instance_family: fc.option(arbInstanceFamily, { nil: null })
});

describe('Property P10: Filter Correctness', () => {
    it('all returned points match the filter criteria', () => {
        fc.assert(fc.property(
            fc.array(arbPoint, { minLength: 0, maxLength: 50 }),
            arbFilter,
            (points, filters) => {
                const result = filterPoints(points, filters);

                for (const p of result) {
                    if (filters.deployment_config) {
                        assert.strictEqual(p.deployment_config, filters.deployment_config,
                            `Point deployment_config "${p.deployment_config}" doesn't match filter "${filters.deployment_config}"`);
                    }
                    if (filters.model_family) {
                        assert.strictEqual(p.model_family, filters.model_family,
                            `Point model_family "${p.model_family}" doesn't match filter "${filters.model_family}"`);
                    }
                    if (filters.instance_family) {
                        assert.strictEqual(p.instance_family, filters.instance_family,
                            `Point instance_family "${p.instance_family}" doesn't match filter "${filters.instance_family}"`);
                    }
                }
            }
        ), PROPERTY_CONFIG);
    });

    it('no matching point from the original set is excluded', () => {
        fc.assert(fc.property(
            fc.array(arbPoint, { minLength: 0, maxLength: 50 }),
            arbFilter,
            (points, filters) => {
                const result = filterPoints(points, filters);

                // Check that every point in the original set that matches the filter is in the result
                for (const p of points) {
                    const matches = (
                        (!filters.deployment_config || p.deployment_config === filters.deployment_config) &&
                        (!filters.model_family || p.model_family === filters.model_family) &&
                        (!filters.instance_family || p.instance_family === filters.instance_family)
                    );
                    if (matches) {
                        const found = result.some(r =>
                            r.configId === p.configId &&
                            r.x === p.x && r.y === p.y
                        );
                        assert.ok(found,
                            `Point with configId ${p.configId} matches filter but was excluded`);
                    }
                }
            }
        ), PROPERTY_CONFIG);
    });

    it('result is a subset of the original set', () => {
        fc.assert(fc.property(
            fc.array(arbPoint, { minLength: 0, maxLength: 50 }),
            arbFilter,
            (points, filters) => {
                const result = filterPoints(points, filters);
                assert.ok(result.length <= points.length,
                    `Filtered result (${result.length}) is larger than original (${points.length})`);
            }
        ), PROPERTY_CONFIG);
    });

    it('empty filter returns all points', () => {
        fc.assert(fc.property(
            fc.array(arbPoint, { minLength: 0, maxLength: 50 }),
            (points) => {
                const noFilter = { deployment_config: null, model_family: null, instance_family: null };
                const result = filterPoints(points, noFilter);
                assert.strictEqual(result.length, points.length,
                    `Empty filter should return all ${points.length} points, got ${result.length}`);
            }
        ), PROPERTY_CONFIG);
    });

    it('filter result count equals manual count of matching points', () => {
        fc.assert(fc.property(
            fc.array(arbPoint, { minLength: 0, maxLength: 50 }),
            arbFilter,
            (points, filters) => {
                const result = filterPoints(points, filters);

                // Manually count matching points
                let expectedCount = 0;
                for (const p of points) {
                    const matches = (
                        (!filters.deployment_config || p.deployment_config === filters.deployment_config) &&
                        (!filters.model_family || p.model_family === filters.model_family) &&
                        (!filters.instance_family || p.instance_family === filters.instance_family)
                    );
                    if (matches) expectedCount++;
                }

                assert.strictEqual(result.length, expectedCount,
                    `Filter returned ${result.length} points but expected ${expectedCount}`);
            }
        ), PROPERTY_CONFIG);
    });
});
