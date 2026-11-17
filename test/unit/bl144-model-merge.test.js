// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — picker merge unit tests (task 3 / task 6 merge slice).
 *
 * Covers the pure merge contract (mergeModelChoices) and the _queryMcpForModels
 * orchestration: managed ∪ serving, managed wins on overlap, serving-only has no
 * capability entry, diffusors/non-transformers get no capabilities, and an empty tune
 * catalog degrades to serving-only.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import McpQueryRunner, { mergeModelChoices } from '../../src/lib/mcp-query-runner.js';

describe('mergeModelChoices (BL144 pure merge)', () => {
    it('managed first (badged) then serving-only, order preserved', () => {
        const managed = [
            { hfId: 'org/m1', techniques: ['sft', 'dpo'], family: 'qwen-3', provider: 'alibaba' },
            { hfId: 'org/m2', techniques: ['rlvr'], family: 'llama-3', provider: 'meta' }
        ];
        const serving = ['org/s1', 'org/s2'];

        const { orderedIds, capabilities, meta } = mergeModelChoices(managed, serving);
        assert.deepStrictEqual(orderedIds, ['org/m1', 'org/m2', 'org/s1', 'org/s2']);
        assert.deepStrictEqual(capabilities, {
            'org/m1': ['sft', 'dpo'],
            'org/m2': ['rlvr']
        });
        // meta is populated for managed models only (drives family separators).
        assert.deepStrictEqual(meta, {
            'org/m1': { family: 'qwen-3', provider: 'alibaba' },
            'org/m2': { family: 'llama-3', provider: 'meta' }
        });
        assert.ok(!('org/s1' in meta), 'serving-only model has no meta');
    });

    it('a model in BOTH appears once, as the managed (badged) entry', () => {
        const managed = [{ hfId: 'org/dup', techniques: ['sft'] }];
        const serving = ['org/dup', 'org/only-serving'];

        const { orderedIds, capabilities } = mergeModelChoices(managed, serving);
        assert.deepStrictEqual(orderedIds, ['org/dup', 'org/only-serving']);
        // dup carries capabilities (managed won); serving-only has NO capability entry.
        assert.deepStrictEqual(capabilities, { 'org/dup': ['sft'] });
        assert.ok(!('org/only-serving' in capabilities));
    });

    it('empty managed → serving-only, no capabilities', () => {
        const { orderedIds, capabilities } = mergeModelChoices([], ['org/s1']);
        assert.deepStrictEqual(orderedIds, ['org/s1']);
        assert.deepStrictEqual(capabilities, {});
    });

    it('tolerates non-array / malformed input', () => {
        assert.deepStrictEqual(mergeModelChoices(undefined, undefined), { orderedIds: [], capabilities: {}, meta: {} });
        const { orderedIds } = mergeModelChoices([{ nope: true }], ['org/ok']);
        assert.deepStrictEqual(orderedIds, ['org/ok']);
    });
});

describe('_queryMcpForModels (BL144 orchestration)', () => {
    function makeRunner({ servingIds, architecture }) {
        const runner = {
            configManager: { getMcpServerNames: () => ['model-picker'] }
        };
        const q = new McpQueryRunner(runner);
        // Stub the serving-catalog read so the test is deterministic (the tune-catalog
        // side intentionally reads the real committed catalog — behavioral assertions).
        q._readServingCatalogIds = () => servingIds;
        q._queryMcpForModels(architecture);
        return runner;
    }

    it('transformers: merges real tune catalog with a stubbed serving list', () => {
        const runner = makeRunner({ architecture: 'transformers', servingIds: ['serving/only-model'] });

        assert.ok(Array.isArray(runner._mcpModelChoices));
        assert.ok(runner._mcpModelChoices.length > 1, 'merged list has managed + serving');
        // The stubbed serving-only id surfaces and has NO capability entry.
        assert.ok(runner._mcpModelChoices.includes('serving/only-model'));
        assert.ok(!('serving/only-model' in runner._mcpModelCapabilities));
        // At least one managed model surfaced WITH a technique set.
        const capHfIds = Object.keys(runner._mcpModelCapabilities);
        assert.ok(capHfIds.length > 0, 'managed capabilities present');
        for (const hf of capHfIds) {
            assert.ok(runner._mcpModelChoices.includes(hf), 'every capability hfId is a choice');
            assert.ok(Array.isArray(runner._mcpModelCapabilities[hf]));
        }
    });

    it('diffusors: serving list only, no managed capabilities', () => {
        const runner = makeRunner({ architecture: 'diffusors', servingIds: ['sd/model-a', 'sd/model-b'] });
        assert.deepStrictEqual(runner._mcpModelChoices, ['sd/model-a', 'sd/model-b']);
        assert.deepStrictEqual(runner._mcpModelCapabilities, {});
    });

    it('no model-picker server configured → leaves choices untouched', () => {
        const runner = { configManager: { getMcpServerNames: () => [] } };
        const q = new McpQueryRunner(runner);
        q._readServingCatalogIds = () => ['should/not/matter'];
        q._queryMcpForModels('transformers');
        assert.strictEqual(runner._mcpModelChoices, undefined);
        assert.strictEqual(runner._mcpModelCapabilities, undefined);
    });
});
