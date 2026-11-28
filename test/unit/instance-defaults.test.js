// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * instance-defaults (improvement plan CLI-1): one architecture → default
 * instance-type heuristic, and no second copy of it elsewhere in src/.
 *
 * Asserts behaviour (GPU family for GPU architectures, CPU family for CPU
 * architectures) rather than pinning SKUs, so a deliberate default bump is a
 * one-line change in src/lib/instance-defaults.js.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInstanceTypeFor, HEURISTIC_DEFAULTS } from '../../src/lib/instance-defaults.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isGpu = (t) => /^ml\.(g|p)\d/.test(t);
const isCpu = (t) => /^ml\.(m|c|r|t)\d/.test(t);

describe('instance-defaults', () => {
    it('GPU architectures (and unknown ones) default to a GPU instance', () => {
        for (const a of ['transformers', 'transformer', 'triton', 'diffusors', 'diffusor', undefined, 'something-new']) {
            assert.ok(isGpu(defaultInstanceTypeFor(a)), `${a} → ${defaultInstanceTypeFor(a)}`);
        }
    });

    it('CPU architectures default to a CPU instance', () => {
        for (const a of ['http', 'predictor']) {
            assert.ok(isCpu(defaultInstanceTypeFor(a)), `${a} → ${defaultInstanceTypeFor(a)}`);
        }
    });

    it('singular and plural architecture spellings agree', () => {
        assert.strictEqual(defaultInstanceTypeFor('transformer'), defaultInstanceTypeFor('transformers'));
        assert.strictEqual(defaultInstanceTypeFor('diffusor'), defaultInstanceTypeFor('diffusors'));
    });

    it('no other src/ module re-declares the architecture → instance map', () => {
        const offenders = [];
        const walk = (d) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) {
                    if (e.name !== 'generated' && e.name !== 'agent') walk(p);
                } else if (e.name.endsWith('.js') && e.name !== 'instance-defaults.js') {
                    if (/HEURISTIC_DEFAULTS\s*=\s*\{/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(ROOT.length + 1));
                }
            }
        };
        walk(join(ROOT, 'src'));
        assert.deepStrictEqual(offenders, []);
        assert.ok(Object.isFrozen(HEURISTIC_DEFAULTS));
    });
});
