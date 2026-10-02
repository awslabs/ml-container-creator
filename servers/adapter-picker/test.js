#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the adapter-picker MCP server.
 *
 * Uses node:assert plus fast-check (property-based). No other framework.
 * All HuggingFace Hub access is mocked via an injected fetchFn, so the suite is
 * deterministic and never touches the live Hub.
 *
 * Run: node servers/adapter-picker/test.js
 */

import assert from 'node:assert';
import fc from 'fast-check';
import {
    classifyAdapter,
    isCompatible,
    rankAdapters,
    searchHfAdapters,
    getAdapterMetadata,
    recommendAdapter
} from './index.js';

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
        console.error(`    ${err.stack || err.message}`);
    }
}

// ── Mock fetch ───────────────────────────────────────────────────────────────

const HF = 'https://huggingface.co';

/**
 * Build a mock fetchFn from a list of candidate adapters.
 *
 * Each candidate: { id, config, downloads?, likes?, task? }
 *   - The search endpoint (…/api/models?…) returns the repo list.
 *   - Each per-repo adapter_config.json URL returns that candidate's `config`
 *     (or 404 when config is null/undefined).
 *
 * Options:
 *   - throwOnAll: when true, every fetch throws (simulates HF unreachable).
 */
function createMockFetch(candidates, opts = {}) {
    const configByUrl = new Map();
    const repos = [];
    for (const c of candidates) {
        repos.push({
            id: c.id,
            downloads: c.downloads ?? 0,
            likes: c.likes ?? 0,
            task: c.task ?? null,
            pipeline_tag: c.pipeline_tag ?? null
        });
        configByUrl.set(`${HF}/${c.id}/resolve/main/adapter_config.json`, c.config);
    }

    return async (url, _options) => {
        if (opts.throwOnAll) {
            throw new Error('Network unreachable');
        }
        if (url.startsWith(`${HF}/api/models`)) {
            return { ok: true, status: 200, json: async () => repos };
        }
        if (configByUrl.has(url)) {
            const cfg = configByUrl.get(url);
            if (cfg === null) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => cfg };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
}

// ── fast-check arbitraries ───────────────────────────────────────────────────

// A realistic-ish HF org/repo id.
const arbHfId = fc
    .tuple(
        fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,20}$/),
        fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,20}$/)
    )
    .map(([org, repo]) => `${org}/${repo}`);

const arbBaseModel = fc.constantFrom(
    'meta-llama/Llama-3.1-8B-Instruct',
    'meta-llama/Llama-3.3-70B-Instruct',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'Qwen/Qwen2.5-7B-Instruct'
);

// ── Property 1 ───────────────────────────────────────────────────────────────
// Feature: v18-w4-02-bl113, Property 1: Search returns only exact-metadata-match adapters, and all of them

await asyncTest('Property 1: search returns exactly the exact-metadata-match set', async () => {
    await fc.assert(
        fc.asyncProperty(
            arbBaseModel,
            fc.array(
                fc.record({
                    id: arbHfId,
                    // kind decides how the candidate declares its base model
                    kind: fc.constantFrom('exact', 'exact-variant', 'substring', 'family', 'missing', 'no-config'),
                    downloads: fc.nat(100000),
                    likes: fc.nat(10000)
                }),
                { minLength: 0, maxLength: 12 }
            ),
            async (requestedBase, specs) => {
                // Ensure unique ids so URL routing is unambiguous.
                const seen = new Set();
                const uniqueSpecs = specs.filter((s) => {
                    if (seen.has(s.id)) return false;
                    seen.add(s.id);
                    return true;
                });

                const candidates = [];
                const expectedExactIds = new Set();

                for (const s of uniqueSpecs) {
                    let config;
                    if (s.kind === 'no-config') {
                        config = null; // 404 → excluded
                    } else if (s.kind === 'missing') {
                        // valid lora config but NO base_model_name_or_path → excluded
                        config = { adapter_type: 'lora', peft_type: 'LORA' };
                    } else if (s.kind === 'substring') {
                        // near-miss: base model is a substring, must NOT match
                        config = {
                            adapter_type: 'lora',
                            base_model_name_or_path: `${requestedBase}-v2`
                        };
                    } else if (s.kind === 'family') {
                        // near-miss: same family, different model, must NOT match
                        config = {
                            adapter_type: 'lora',
                            base_model_name_or_path: requestedBase.replace(/8B|7B|70B/, '13B')
                        };
                    } else {
                        // exact or exact-variant → MUST match
                        const declared =
                            s.kind === 'exact-variant'
                                ? (requestedBase.toUpperCase())
                                : requestedBase;
                        config = { adapter_type: 'lora', base_model_name_or_path: declared };
                        expectedExactIds.add(s.id);
                    }
                    candidates.push({ id: s.id, config, downloads: s.downloads, likes: s.likes });
                }

                const fetchFn = createMockFetch(candidates);
                const result = await searchHfAdapters(requestedBase, undefined, { fetchFn });

                const returnedIds = new Set(result.adapters.map((a) => a.hf_id));

                // Every returned adapter is an exact-match candidate...
                for (const id of returnedIds) {
                    assert.ok(expectedExactIds.has(id), `returned ${id} which is not an exact match`);
                }
                // ...and no exact-match candidate is omitted.
                for (const id of expectedExactIds) {
                    assert.ok(returnedIds.has(id), `exact-match ${id} was omitted`);
                }
                assert.strictEqual(result.count, result.adapters.length);
            }
        ),
        { numRuns: 100 }
    );
});

// ── Property 2 ───────────────────────────────────────────────────────────────
// Feature: v18-w4-02-bl113, Property 2: Metadata faithfully reports adapter_type and base model

await asyncTest('Property 2: metadata echoes adapter_type and base_model_name_or_path', async () => {
    await fc.assert(
        fc.asyncProperty(
            arbHfId,
            fc.record({
                adapter_type: fc.constantFrom('lora', 'prompt_tuning', 'prefix_tuning', 'ia3', 'dora'),
                base_model_name_or_path: arbBaseModel,
                r: fc.integer({ min: 1, max: 256 }),
                lora_alpha: fc.integer({ min: 1, max: 512 })
            }),
            async (hfId, config) => {
                const fetchFn = createMockFetch([{ id: hfId, config }]);
                const meta = await getAdapterMetadata(hfId, { fetchFn });
                assert.ok(meta, 'metadata should be present');
                assert.strictEqual(meta.adapter_type, config.adapter_type);
                assert.strictEqual(meta.base_model_name_or_path, config.base_model_name_or_path);
            }
        ),
        { numRuns: 100 }
    );
});

// ── Property 3 ───────────────────────────────────────────────────────────────
// Feature: v18-w4-02-bl113, Property 3: Classification faithfully reports the detected adapter type

await asyncTest('Property 3: classification follows DoRA→QLoRA→LoRA precedence and passes through other types', async () => {
    await fc.assert(
        fc.property(
            fc.record({
                use_dora: fc.boolean(),
                quantized: fc.boolean(),
                declaredType: fc.constantFrom('lora', 'prompt_tuning', 'prefix_tuning', 'ia3', 'llama_adapter', '')
            }),
            ({ use_dora, quantized, declaredType }) => {
                const config = {};
                if (use_dora) config.use_dora = true;
                if (quantized) config.quant_method = 'bitsandbytes';
                if (declaredType) config.adapter_type = declaredType;

                const result = classifyAdapter(config);

                if (use_dora) {
                    assert.strictEqual(result, 'DoRA');
                } else if (quantized) {
                    assert.strictEqual(result, 'QLoRA');
                } else if (declaredType === 'lora') {
                    assert.strictEqual(result, 'LoRA');
                } else if (declaredType) {
                    // Other declared types are reported faithfully, never coerced.
                    assert.strictEqual(result, declaredType);
                    assert.ok(!['LoRA', 'DoRA', 'QLoRA'].includes(result));
                } else {
                    // No type info at all.
                    assert.strictEqual(result, 'unknown');
                }
            }
        ),
        { numRuns: 100 }
    );
});

// ── Property 4 ───────────────────────────────────────────────────────────────
// Feature: v18-w4-02-bl113, Property 4: Recommendation is the top-ranked compatible adapter

await asyncTest('Property 4: recommendation is a compatible adapter equal to rankAdapters(compatible)[0]', async () => {
    await fc.assert(
        fc.asyncProperty(
            arbBaseModel,
            fc.option(fc.constantFrom('chat', 'code', 'summarization'), { nil: undefined }),
            fc.array(
                fc.record({
                    id: arbHfId,
                    compatible: fc.boolean(),
                    downloads: fc.nat(100000),
                    likes: fc.nat(10000),
                    task: fc.option(fc.constantFrom('chat', 'code', 'summarization'), { nil: null })
                }),
                { minLength: 1, maxLength: 12 }
            ),
            async (requestedBase, task, specs) => {
                const seen = new Set();
                const uniqueSpecs = specs.filter((s) => {
                    if (seen.has(s.id)) return false;
                    seen.add(s.id);
                    return true;
                });

                const candidates = uniqueSpecs.map((s) => ({
                    id: s.id,
                    downloads: s.downloads,
                    likes: s.likes,
                    task: s.task,
                    config: {
                        adapter_type: 'lora',
                        base_model_name_or_path: s.compatible ? requestedBase : `other/${s.id}-base`
                    }
                }));

                const fetchFn = createMockFetch(candidates);
                const rec = await recommendAdapter(requestedBase, task, { fetchFn });

                const { adapters } = await searchHfAdapters(requestedBase, task, { fetchFn });

                if (adapters.length === 0) {
                    assert.strictEqual(rec, null);
                    return;
                }

                assert.ok(rec, 'recommendation should be present when compatible adapters exist');
                // Recommendation is compatible with the requested base model.
                assert.ok(
                    isCompatible({ base_model_name_or_path: rec.base_model_name_or_path }, requestedBase),
                    'recommended adapter must be compatible'
                );
                // Recommendation equals the top of the ranked compatible set.
                const expectedTop = rankAdapters(adapters, task)[0];
                assert.strictEqual(rec.hf_id, expectedTop.hf_id);
            }
        ),
        { numRuns: 100 }
    );
});

// ── Example / edge-case tests (mocked HF) ────────────────────────────────────

console.log('\nadapter-picker: example & edge cases\n');

await asyncTest('search: exact match returned, near-miss family excluded', async () => {
    const base = 'meta-llama/Llama-3.1-8B-Instruct';
    const fetchFn = createMockFetch([
        { id: 'org/llama31-8b-chat-lora', downloads: 1234, likes: 56, task: 'chat',
            config: { adapter_type: 'lora', base_model_name_or_path: base } },
        { id: 'org/llama31-70b-lora', downloads: 999, likes: 10,
            config: { adapter_type: 'lora', base_model_name_or_path: 'meta-llama/Llama-3.3-70B-Instruct' } }
    ]);
    const result = await searchHfAdapters(base, 'chat', { fetchFn });
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.adapters[0].hf_id, 'org/llama31-8b-chat-lora');
    assert.strictEqual(result.adapters[0].classification, 'LoRA');
});

await asyncTest('search: zero compatible candidates → count:0 (not an error)', async () => {
    const fetchFn = createMockFetch([
        { id: 'org/other-lora',
            config: { adapter_type: 'lora', base_model_name_or_path: 'some/other-model' } }
    ]);
    const result = await searchHfAdapters('meta-llama/Llama-3.1-8B-Instruct', undefined, { fetchFn });
    assert.strictEqual(result.count, 0);
    assert.deepStrictEqual(result.adapters, []);
});

await asyncTest('get_adapter_metadata: classifies LoRA / DoRA / QLoRA / passthrough', async () => {
    const base = 'meta-llama/Llama-3.1-8B-Instruct';
    const cases = [
        [{ adapter_type: 'lora', base_model_name_or_path: base, r: 16, lora_alpha: 32 }, 'LoRA'],
        [{ adapter_type: 'lora', use_dora: true, base_model_name_or_path: base }, 'DoRA'],
        [{ adapter_type: 'lora', quant_method: 'bitsandbytes', base_model_name_or_path: base }, 'QLoRA'],
        [{ adapter_type: 'prompt_tuning', base_model_name_or_path: base }, 'prompt_tuning']
    ];
    let i = 0;
    for (const [config, expected] of cases) {
        const hfId = `org/adapter-${i++}`;
        const fetchFn = createMockFetch([{ id: hfId, config }]);
        const meta = await getAdapterMetadata(hfId, { fetchFn });
        assert.ok(meta, `metadata present for ${expected}`);
        assert.strictEqual(meta.classification, expected);
        assert.strictEqual(meta.base_model_name_or_path, base);
    }
});

await asyncTest('get_adapter_metadata: repo with no adapter_config.json → null (tool reports error)', async () => {
    const fetchFn = createMockFetch([{ id: 'org/not-an-adapter', config: null }]);
    const meta = await getAdapterMetadata('org/not-an-adapter', { fetchFn });
    assert.strictEqual(meta, null);
});

await asyncTest('recommend_adapter: prefers task match, then popularity', async () => {
    const base = 'meta-llama/Llama-3.1-8B-Instruct';
    const fetchFn = createMockFetch([
        { id: 'org/chat-lora', downloads: 100, likes: 5, task: 'chat',
            config: { adapter_type: 'lora', base_model_name_or_path: base } },
        { id: 'org/popular-code-lora', downloads: 100000, likes: 9000, task: 'code',
            config: { adapter_type: 'lora', use_dora: true, base_model_name_or_path: base } }
    ]);
    const rec = await recommendAdapter(base, 'chat', { fetchFn });
    assert.ok(rec, 'should return a recommendation');
    assert.strictEqual(rec.hf_id, 'org/chat-lora', 'task match should win over popularity');
    assert.strictEqual(rec.all_options.length, 2);
});

await asyncTest('recommend_adapter: no compatible candidates → null (tool reports error)', async () => {
    const fetchFn = createMockFetch([
        { id: 'org/wrong-base',
            config: { adapter_type: 'lora', base_model_name_or_path: 'unrelated/model' } }
    ]);
    const rec = await recommendAdapter('meta-llama/Llama-3.1-8B-Instruct', undefined, { fetchFn });
    assert.strictEqual(rec, null);
});

await asyncTest('HF unreachable: search empty, metadata & recommend null', async () => {
    const base = 'meta-llama/Llama-3.1-8B-Instruct';
    const fetchFn = createMockFetch([], { throwOnAll: true });
    const search = await searchHfAdapters(base, undefined, { fetchFn });
    assert.strictEqual(search.count, 0);
    const meta = await getAdapterMetadata('org/anything', { fetchFn });
    assert.strictEqual(meta, null);
    const rec = await recommendAdapter(base, undefined, { fetchFn });
    assert.strictEqual(rec, null);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
