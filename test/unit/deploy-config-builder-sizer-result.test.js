// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Realtime deploy path (do/deploy -> deploy-config-builder) consumption of
 * the instance-sizer response. Regression for neat-transformer-classifier:
 * an unsized model produced "No MCP recommendations available" with no reason.
 *
 * Behavioral: when the sizer cannot size the model, the builder surfaces the
 * sizer's explicit message and offers NO unsized list as recommendations;
 * a sized response yields single/multi-GPU groups.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { summarizeSizerResult } from '../../src/lib/deploy-config-builder.js';

describe('deploy-config-builder: summarizeSizerResult', () => {
    it('sizingUnavailable -> explicit message, no recommendations even if an unfiltered list is present', () => {
        const msg = 'Cannot size "org/m": ... pass --instance-type <ml.instance> explicitly';
        const out = summarizeSizerResult({
            values: { instanceType: null },
            choices: { instanceType: ['ml.a', 'ml.b'] },
            metadata: {
                sizingUnavailable: true,
                error: msg,
                recommendations: [{ instanceType: 'ml.a', gpuCount: 1 }, { instanceType: 'ml.b', gpuCount: 1 }]
            }
        });
        assert.deepStrictEqual(out.single, []);
        assert.deepStrictEqual(out.multi, []);
        assert.strictEqual(out.sizingMessage, msg);
    });

    it('sized but nothing fits -> the sizer error is surfaced', () => {
        const out = summarizeSizerResult({
            values: { instanceType: null },
            choices: { instanceType: [] },
            metadata: { error: 'No catalog instance has enough GPU memory ... --instance-type' }
        });
        assert.strictEqual(out.single.length + out.multi.length, 0);
        assert.match(out.sizingMessage, /--instance-type/);
    });

    it('sized response -> single-GPU and multi-GPU groups, no sizing message', () => {
        const out = summarizeSizerResult({
            values: { instanceType: 'ml.one' },
            choices: { instanceType: ['ml.one', 'ml.many'] },
            metadata: {
                estimatedVramGb: 20,
                recommendations: [
                    { instanceType: 'ml.one', gpuCount: 1, totalVramGb: 48, utilizationPercent: 42 },
                    { instanceType: 'ml.many', gpuCount: 4, totalVramGb: 96, utilizationPercent: 21 }
                ]
            }
        });
        assert.strictEqual(out.sizingMessage, undefined);
        assert.deepStrictEqual(out.single.map(r => r.value), ['ml.one']);
        assert.deepStrictEqual(out.multi.map(r => r.value), ['ml.many']);
        assert.strictEqual(out.estimatedVram, 20);
    });

    it('MCP unavailable (null) -> empty, no message (caller falls back to manual entry)', () => {
        const out = summarizeSizerResult(null);
        assert.deepStrictEqual(out, { single: [], multi: [] });
    });
});
