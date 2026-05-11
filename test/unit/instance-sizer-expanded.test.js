// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for instance-sizer expanded functionality.
 * Tests tag-based search, CUDA filtering, profile ENV overrides, and combined modes.
 *
 * Requirements: 8.1, 8.2, 8.3, 3.10
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { searchInstancesByTag, filterByCudaVersion, handleGetInstanceRecommendation, INSTANCE_CATALOG } from '../../servers/instance-sizer/index.js';

describe('instance-sizer: tag-based search', () => {
    it('returns GPU instances for "gpu" search', () => {
        const results = searchInstancesByTag('gpu', INSTANCE_CATALOG, { limit: 8 });
        assert.ok(results.length > 0, 'should return results for "gpu"');
        for (const name of results) {
            assert.ok(INSTANCE_CATALOG[name].gpus > 0, `${name} should be a GPU instance`);
        }
    });

    it('returns CPU instances for "cpu" search', () => {
        const results = searchInstancesByTag('cpu', INSTANCE_CATALOG, { limit: 8 });
        assert.ok(results.length > 0, 'should return results for "cpu"');
        for (const name of results) {
            assert.ok(INSTANCE_CATALOG[name].gpus === 0, `${name} should be a CPU instance`);
        }
    });

    it('returns multi-GPU instances for "multi-gpu" search', () => {
        const results = searchInstancesByTag('multi-gpu', INSTANCE_CATALOG, { limit: 8 });
        for (const name of results) {
            assert.ok(INSTANCE_CATALOG[name].gpus > 1, `${name} should have multiple GPUs`);
        }
    });

    it('returns empty array for empty search string', () => {
        const results = searchInstancesByTag('', INSTANCE_CATALOG, { limit: 8 });
        assert.ok(Array.isArray(results));
        assert.strictEqual(results.length, 0);
    });

    it('returns empty array for no matching tags', () => {
        const results = searchInstancesByTag('zzzznonexistent', INSTANCE_CATALOG, { limit: 8 });
        assert.strictEqual(results.length, 0);
    });

    it('respects limit parameter', () => {
        const results = searchInstancesByTag('gpu', INSTANCE_CATALOG, { limit: 3 });
        assert.ok(results.length <= 3);
    });
});

describe('instance-sizer: CUDA version filtering', () => {
    it('filters instances by exact CUDA version', () => {
        const filtered = filterByCudaVersion(INSTANCE_CATALOG, '12.1');
        assert.ok(Object.keys(filtered).length > 0, 'should have results for CUDA 12.1');
        for (const [name, meta] of Object.entries(filtered)) {
            const hasCompatible = meta.cudaVersions.some(v => v === '12.1' || v.startsWith('12.'));
            assert.ok(hasCompatible, `${name} should support CUDA 12.x`);
        }
    });

    it('filters instances by major CUDA version', () => {
        const filtered = filterByCudaVersion(INSTANCE_CATALOG, '12');
        for (const [name, meta] of Object.entries(filtered)) {
            const hasCompatible = meta.cudaVersions.some(v => v.startsWith('12'));
            assert.ok(hasCompatible, `${name} should support CUDA 12.x`);
        }
    });

    it('returns empty object for impossible CUDA version', () => {
        const filtered = filterByCudaVersion(INSTANCE_CATALOG, '99.9');
        assert.strictEqual(Object.keys(filtered).length, 0);
    });

    it('excludes instances without cudaVersions field', () => {
        const filtered = filterByCudaVersion(INSTANCE_CATALOG, '12.1');
        for (const [name, meta] of Object.entries(filtered)) {
            assert.ok(Array.isArray(meta.cudaVersions) && meta.cudaVersions.length > 0,
                `${name} must have cudaVersions`);
        }
    });
});

describe('instance-sizer: profile ENV override', () => {
    it('uses VLLM_MAX_MODEL_LEN from profileEnvVars', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            modelName: 'meta-llama/Llama-2-7b-chat-hf',
            limit: 3,
            context: {
                profileEnvVars: {
                    VLLM_MAX_MODEL_LEN: '2048'
                }
            }
        });

        const response = JSON.parse(result.content[0].text);
        assert.ok(response.metadata, 'should have metadata');
        assert.ok(response.values.instanceType, 'should recommend an instance');
    });

    it('uses VLLM_MAX_NUM_SEQS from profileEnvVars', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            modelName: 'meta-llama/Llama-2-7b-chat-hf',
            limit: 3,
            context: {
                profileEnvVars: {
                    VLLM_MAX_NUM_SEQS: '128'
                }
            }
        });

        const response = JSON.parse(result.content[0].text);
        assert.ok(response.metadata, 'should have metadata');
        assert.ok(response.values.instanceType, 'should recommend an instance');
    });
});

describe('instance-sizer: combined VRAM + search', () => {
    it('filters by VRAM first then by search tags', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            modelName: 'meta-llama/Llama-2-7b-chat-hf',
            instanceSearch: 'gpu',
            limit: 8
        });

        const response = JSON.parse(result.content[0].text);
        // All results should be GPU instances
        for (const instanceType of response.choices.instanceType) {
            if (INSTANCE_CATALOG[instanceType]) {
                assert.ok(INSTANCE_CATALOG[instanceType].gpus > 0,
                    `${instanceType} should be a GPU instance`);
            }
        }
    });

    it('tag-only search works without modelName', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            instanceSearch: 'multi-gpu',
            limit: 5
        });

        const response = JSON.parse(result.content[0].text);
        assert.strictEqual(response.metadata.source, 'tag-search');
        for (const instanceType of response.choices.instanceType) {
            if (INSTANCE_CATALOG[instanceType]) {
                assert.ok(INSTANCE_CATALOG[instanceType].gpus > 1,
                    `${instanceType} should have multiple GPUs`);
            }
        }
    });

    it('CUDA filter + search works together', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            instanceSearch: 'gpu',
            cudaVersion: '12.1',
            limit: 5
        });

        const response = JSON.parse(result.content[0].text);
        assert.strictEqual(response.metadata.cudaVersionFilter, '12.1');
    });
});

describe('instance-sizer: edge cases', () => {
    it('returns empty results when CUDA filter eliminates all instances', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            modelName: 'meta-llama/Llama-2-7b-chat-hf',
            cudaVersion: '99.9',
            limit: 5
        });

        const response = JSON.parse(result.content[0].text);
        assert.strictEqual(response.values.instanceType, null);
        assert.ok(response.metadata.warning.includes('No instances support CUDA version'));
    });

    it('returns unfiltered GPU instances when no modelName and no search', async function () {
        this.timeout(10000);
        const result = await handleGetInstanceRecommendation({
            limit: 5
        });

        const response = JSON.parse(result.content[0].text);
        assert.strictEqual(response.metadata.source, 'unfiltered');
    });
});
