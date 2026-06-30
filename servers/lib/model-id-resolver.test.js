#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the model-id-resolver module.
 * Uses node:assert only — no external test framework.
 * Run: node servers/lib/model-id-resolver.test.js
 */

import assert from 'node:assert';
import {
    resolveModelArchitecture,
    clearModelArchitectureCache,
    getModelArchitectureCacheSize
} from './model-id-resolver.js';

let passed = 0;
let failed = 0;

async function asyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

// ── Helper: mock fetch ───────────────────────────────────────────────────────

function createMockFetch(responseMap) {
    return async (url, _options) => {
        const entry = responseMap[url];
        if (!entry) {
            return { ok: false, status: 404, json: async () => ({}) };
        }
        if (entry.error) {
            throw entry.error;
        }
        return {
            ok: entry.ok !== undefined ? entry.ok : true,
            status: entry.status || 200,
            json: async () => entry.body
        };
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\nmodel-id-resolver: null/undefined/empty modelId\n');

await asyncTest('returns null when modelId is null', async () => {
    clearModelArchitectureCache();
    const result = await resolveModelArchitecture(null);
    assert.strictEqual(result, null);
});

await asyncTest('returns null when modelId is undefined', async () => {
    clearModelArchitectureCache();
    const result = await resolveModelArchitecture(undefined);
    assert.strictEqual(result, null);
});

await asyncTest('returns null when modelId is empty string', async () => {
    clearModelArchitectureCache();
    const result = await resolveModelArchitecture('');
    assert.strictEqual(result, null);
});

await asyncTest('returns null when modelId is whitespace', async () => {
    clearModelArchitectureCache();
    const result = await resolveModelArchitecture('   ');
    assert.strictEqual(result, null);
});

console.log('\nmodel-id-resolver: successful resolution\n');

await asyncTest('resolves known modelId to architecture from config.json', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B/resolve/main/config.json': {
            body: {
                architectures: ['Qwen2ForCausalLM'],
                model_type: 'qwen2'
            }
        }
    });
    const result = await resolveModelArchitecture('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', { fetchFn: mockFetch });
    assert.strictEqual(result, 'Qwen2ForCausalLM');
});

await asyncTest('resolves modelId with multiple architectures (takes first)', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/meta-llama/Llama-3.1-8B/resolve/main/config.json': {
            body: {
                architectures: ['LlamaForCausalLM', 'LlamaForSequenceClassification'],
                model_type: 'llama'
            }
        }
    });
    const result = await resolveModelArchitecture('meta-llama/Llama-3.1-8B', { fetchFn: mockFetch });
    assert.strictEqual(result, 'LlamaForCausalLM');
});

console.log('\nmodel-id-resolver: caching\n');

await asyncTest('caches result — second call does not fetch again', async () => {
    clearModelArchitectureCache();
    let fetchCount = 0;
    const mockFetch = async (_url, _options) => {
        fetchCount++;
        return {
            ok: true,
            status: 200,
            json: async () => ({ architectures: ['Qwen3ForCausalLM'] })
        };
    };

    await resolveModelArchitecture('Qwen/Qwen3-8B', { fetchFn: mockFetch });
    await resolveModelArchitecture('Qwen/Qwen3-8B', { fetchFn: mockFetch });
    assert.strictEqual(fetchCount, 1, 'should only fetch once due to cache');
    assert.strictEqual(getModelArchitectureCacheSize(), 1);
});

await asyncTest('cache stores null for failed lookups (no repeated fetch on failure)', async () => {
    clearModelArchitectureCache();
    let fetchCount = 0;
    const mockFetch = async (_url, _options) => {
        fetchCount++;
        return { ok: false, status: 404, json: async () => ({}) };
    };

    const r1 = await resolveModelArchitecture('nonexistent/model', { fetchFn: mockFetch });
    const r2 = await resolveModelArchitecture('nonexistent/model', { fetchFn: mockFetch });
    assert.strictEqual(r1, null);
    assert.strictEqual(r2, null);
    assert.strictEqual(fetchCount, 1, 'should cache the null result');
});

await asyncTest('clearModelArchitectureCache resets cache', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/test/model/resolve/main/config.json': {
            body: { architectures: ['TestForCausalLM'] }
        }
    });
    await resolveModelArchitecture('test/model', { fetchFn: mockFetch });
    assert.strictEqual(getModelArchitectureCacheSize(), 1);
    clearModelArchitectureCache();
    assert.strictEqual(getModelArchitectureCacheSize(), 0);
});

console.log('\nmodel-id-resolver: error handling / fallback\n');

await asyncTest('returns null on HTTP 404 (model not found)', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/nonexistent/model-xyz/resolve/main/config.json': {
            ok: false,
            status: 404,
            body: {}
        }
    });
    const result = await resolveModelArchitecture('nonexistent/model-xyz', { fetchFn: mockFetch });
    assert.strictEqual(result, null);
});

await asyncTest('returns null on network error', async () => {
    clearModelArchitectureCache();
    const mockFetch = async () => { throw new Error('Network unreachable'); };
    const result = await resolveModelArchitecture('some/model', { fetchFn: mockFetch });
    assert.strictEqual(result, null);
});

await asyncTest('returns null on timeout (abort)', async () => {
    clearModelArchitectureCache();
    const mockFetch = async (url, options) => {
        // Simulate abort by checking signal
        if (options?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        // Simulate a hanging request that will be aborted
        return new Promise((_, reject) => {
            const abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
            if (options?.signal) {
                options.signal.addEventListener('abort', abortHandler);
            }
        });
    };
    const result = await resolveModelArchitecture('slow/model', { fetchFn: mockFetch, timeoutMs: 50 });
    assert.strictEqual(result, null);
});

await asyncTest('returns null when config.json has no architectures field', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/org/no-arch-model/resolve/main/config.json': {
            body: { model_type: 'custom', hidden_size: 768 }
        }
    });
    const result = await resolveModelArchitecture('org/no-arch-model', { fetchFn: mockFetch });
    assert.strictEqual(result, null);
});

await asyncTest('returns null when architectures array is empty', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/org/empty-arch/resolve/main/config.json': {
            body: { architectures: [], model_type: 'custom' }
        }
    });
    const result = await resolveModelArchitecture('org/empty-arch', { fetchFn: mockFetch });
    assert.strictEqual(result, null);
});

await asyncTest('returns null on invalid JSON response', async () => {
    clearModelArchitectureCache();
    const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token'); }
    });
    const result = await resolveModelArchitecture('org/bad-json', { fetchFn: mockFetch });
    assert.strictEqual(result, null);
});

console.log('\nmodel-id-resolver: input trimming\n');

await asyncTest('trims whitespace from modelId', async () => {
    clearModelArchitectureCache();
    const mockFetch = createMockFetch({
        'https://huggingface.co/org/model/resolve/main/config.json': {
            body: { architectures: ['TrimTestArch'] }
        }
    });
    const result = await resolveModelArchitecture('  org/model  ', { fetchFn: mockFetch });
    assert.strictEqual(result, 'TrimTestArch');
});

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
