// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Drift guard (derive-dont-hardcode rule 4, BL240): the VRAM estimate and the
 * served-context resolution exist twice —
 *   - servers/instance-sizer/lib/vram-estimator.js + lib/served-context.js (MCP sizer)
 *   - templates/do/lib/python/instance_sizer.py (do/deploy built-in fallback)
 * Both must budget KV cache for the SAME served context and produce the same
 * estimate. This test feeds both the same inputs (every serve.d engine, an
 * unknown engine, native contexts above / below / missing, explicit requests)
 * and asserts agreement. It pins no engine default: whatever serve.d and
 * model-servers.json declare, both sides must derive the same value.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    estimateVram,
    BYTES_PER_PARAM,
    OVERHEAD_FACTOR,
    DEFAULT_MAX_SEQUENCE_LENGTH,
    DEFAULT_BATCH_SIZE,
    KV_CACHE_FACTOR,
    BYTES_IN_GB
} from '../../servers/instance-sizer/lib/vram-estimator.js';
import { resolveServedContext, SERVE_D } from '../../servers/instance-sizer/lib/served-context.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_DIR = join(ROOT, 'templates', 'do', 'lib', 'python');

const ENGINES = readdirSync(SERVE_D, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(SERVE_D, e.name, 'manifest.json')))
    .map(e => e.name);

const CONTEXT_CASES = [];
for (const engine of [...ENGINES, 'no-such-engine', null]) {
    for (const maxPositionEmbeddings of [262144, 1024, null]) {
        CONTEXT_CASES.push({ requested: null, maxPositionEmbeddings, engine });
    }
    CONTEXT_CASES.push({ requested: 65536, maxPositionEmbeddings: 262144, engine });
}

const ESTIMATE_CASES = [
    { parameterCount: 4_659_865_088, precision: 'bfloat16', seq: 4096 },
    { parameterCount: 4_659_865_088, precision: 'bfloat16', seq: 262144 },
    { parameterCount: 8_030_261_248, precision: 'float16', seq: null },
    { parameterCount: 70_000_000_000, precision: 'int4', seq: 2048 },
    { parameterCount: 1_000_000_000, precision: 'float32', seq: 131072 },
    { parameterCount: 7_000_000_000, precision: 'unknown-dtype', seq: 8192 }
];

function py(payload) {
    const script = [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(PY_DIR)})`,
        'import instance_sizer as s',
        'p = json.load(sys.stdin)',
        'ctx = [s.resolve_served_context(c["requested"], c["maxPositionEmbeddings"], c["engine"]) for c in p["ctx"]]',
        'est = [s.estimate_vram(c["parameterCount"], c["precision"], c["seq"]) for c in p["est"]]',
        'consts = {"BYTES_PER_PARAM": s.BYTES_PER_PARAM, "OVERHEAD_FACTOR": s.OVERHEAD_FACTOR,',
        '  "DEFAULT_MAX_SEQUENCE_LENGTH": s.DEFAULT_MAX_SEQUENCE_LENGTH, "DEFAULT_BATCH_SIZE": s.DEFAULT_BATCH_SIZE,',
        '  "KV_CACHE_FACTOR": s.KV_CACHE_FACTOR, "BYTES_IN_GB": s.BYTES_IN_GB}',
        'print(json.dumps({"ctx": ctx, "est": est, "consts": consts}))'
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script], {
        input: JSON.stringify(payload),
        encoding: 'utf8'
    }));
}

describe('served context + VRAM estimate: served-context.js/vram-estimator.js <-> instance_sizer.py conformance (BL240)', () => {
    const out = py({ ctx: CONTEXT_CASES, est: ESTIMATE_CASES });

    it('estimator constants agree', () => {
        assert.deepStrictEqual(out.consts, {
            BYTES_PER_PARAM,
            OVERHEAD_FACTOR,
            DEFAULT_MAX_SEQUENCE_LENGTH,
            DEFAULT_BATCH_SIZE,
            KV_CACHE_FACTOR,
            BYTES_IN_GB
        });
    });

    it('covers every serve.d engine', () => {
        assert.ok(ENGINES.length > 0);
        assert.ok(ENGINES.includes('vllm'), 'vllm is a serve.d engine');
    });

    CONTEXT_CASES.forEach((c, i) => {
        it(`served context agrees: engine=${c.engine} native=${c.maxPositionEmbeddings} requested=${c.requested}`, () => {
            const js = resolveServedContext({
                requested: c.requested ?? undefined,
                maxPositionEmbeddings: c.maxPositionEmbeddings,
                engine: c.engine ?? undefined
            });
            assert.deepStrictEqual(out.ctx[i], js);
            // Never budgets more than the native context unless explicitly requested.
            if (!c.requested && c.maxPositionEmbeddings) {
                assert.ok(js.servedContext <= c.maxPositionEmbeddings);
            }
        });
    });

    ESTIMATE_CASES.forEach((c, i) => {
        it(`VRAM estimate agrees: ${c.parameterCount} ${c.precision} seq=${c.seq}`, () => {
            const js = estimateVram({
                parameterCount: c.parameterCount,
                dtype: c.precision,
                maxSequenceLength: c.seq ?? undefined
            });
            assert.ok(Math.abs(out.est[i] - js.vramGb) < 1e-9, `py ${out.est[i]} vs js ${js.vramGb}`);
        });
    });
});
