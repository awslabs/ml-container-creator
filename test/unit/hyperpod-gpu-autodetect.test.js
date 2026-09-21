// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL096 — HyperPod EKS GPU auto-detection.
 *
 * Verifies:
 *  1. detectGpuCount() (src/lib/deploy-config-builder.js) maps instance types to
 *     GPU counts and defaults unknown types to 1.
 *  2. The deploy driver (templates/do/deploy.d/hyperpod-eks) contains a bash
 *     lookup (_hp_detect_gpu_count) whose table stays in sync with GPU_MAP, and
 *     derives HP_CPU_REQUEST / HP_MEM_REQUEST from the resolved GPU count before
 *     envsubst. The bash function is exercised directly to confirm parity.
 */

import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { detectGpuCount, GPU_MAP, resolveHpGpuCount } from '../../src/lib/deploy-config-builder.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = resolve(__dirname, '../../templates/do/deploy.d/hyperpod-eks');

describe('BL096: detectGpuCount (JS)', () => {
    it('maps single-GPU instance types to 1', () => {
        for (const t of ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g6.4xlarge', 'ml.g6.16xlarge']) {
            assert.strictEqual(detectGpuCount(t), '1', `${t} should be 1 GPU`);
        }
    });

    it('maps 4-GPU instance types to 4', () => {
        for (const t of ['ml.g5.12xlarge', 'ml.g5.24xlarge', 'ml.g6.12xlarge', 'ml.g6.24xlarge']) {
            assert.strictEqual(detectGpuCount(t), '4', `${t} should be 4 GPUs`);
        }
    });

    it('maps 8-GPU instance types to 8', () => {
        for (const t of ['ml.g5.48xlarge', 'ml.g6.48xlarge', 'ml.p4d.24xlarge', 'ml.p4de.24xlarge', 'ml.p5.48xlarge']) {
            assert.strictEqual(detectGpuCount(t), '8', `${t} should be 8 GPUs`);
        }
    });

    it('defaults unknown / empty instance types to 1', () => {
        assert.strictEqual(detectGpuCount('ml.c5.large'), '1', 'CPU instance → 1');
        assert.strictEqual(detectGpuCount('ml.totally.unknown'), '1', 'unknown → 1');
        assert.strictEqual(detectGpuCount(''), '1', 'empty → 1');
        assert.strictEqual(detectGpuCount(undefined), '1', 'undefined → 1');
    });

    it('returns a string (config values are stringly typed)', () => {
        assert.strictEqual(typeof detectGpuCount('ml.g5.12xlarge'), 'string');
    });
});

describe('BL096: deploy driver bash GPU lookup', () => {
    let driver;

    before(() => {
        driver = readFileSync(DRIVER_PATH, 'utf8');
    });

    it('defines _hp_detect_gpu_count and derives CPU/memory before envsubst', () => {
        assert.ok(driver.includes('_hp_detect_gpu_count'),
            'driver must define a bash GPU lookup');
        assert.ok(driver.includes('export HP_GPU_COUNT='),
            'driver must export HP_GPU_COUNT');
        assert.ok(driver.includes('export HP_CPU_REQUEST="$(( HP_GPU_COUNT * 4 ))"'),
            'driver must derive CPU cores as gpu*4');
        assert.ok(driver.includes('export HP_MEM_REQUEST="$(( HP_GPU_COUNT * 16 ))Gi"'),
            'driver must derive memory as gpu*16 Gi');
        // The derivation must precede the substitution pass.
        const gpuIdx = driver.indexOf('export HP_GPU_COUNT=');
        const subIdx = driver.indexOf('RENDERED=$(envsubst < "${manifest}")');
        assert.ok(gpuIdx > 0 && subIdx > gpuIdx,
            'GPU/CPU/mem must be exported before the substitution pass');
    });

    it('bash lookup table matches the JS GPU_MAP for every known instance type', function () {
        // Exercise the bash function directly so the two tables cannot drift.
        this.timeout(20000);
        // Extract the function body and call it once per known suffix.
        const suffixes = Object.keys(GPU_MAP);
        const calls = suffixes.map(s => `_hp_detect_gpu_count "ml.${s}"`).join('; ');
        // Pull the function definition out of the driver so we don't execute the
        // whole (side-effecting) script.
        const start = driver.indexOf('_hp_detect_gpu_count() {');
        const end = driver.indexOf('\n}', start) + 2;
        assert.ok(start > 0 && end > start, 'must locate _hp_detect_gpu_count definition');
        const fnDef = driver.slice(start, end);
        const script = `set -eu\n${fnDef}\n${calls}`;
        const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
            .trim().split('\n');
        assert.strictEqual(out.length, suffixes.length, 'one result per instance type');
        suffixes.forEach((s, i) => {
            assert.strictEqual(out[i], String(GPU_MAP[s]),
                `bash lookup for ml.${s} (${out[i]}) must equal GPU_MAP (${GPU_MAP[s]})`);
        });
    });

    it('bash lookup defaults unknown instance types to 1', () => {
        const start = driver.indexOf('_hp_detect_gpu_count() {');
        const end = driver.indexOf('\n}', start) + 2;
        const fnDef = driver.slice(start, end);
        const script = `set -eu\n${fnDef}\n_hp_detect_gpu_count "ml.c5.large"; _hp_detect_gpu_count ""`;
        const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
            .trim().split('\n');
        assert.deepStrictEqual(out, ['1', '1'], 'unknown and empty → 1');
    });
});

describe('BL096: resolveHpGpuCount — re-detect on instance-group change', () => {
    it('re-detects and rewrites when a new instance group is selected (group changed)', () => {
        // User previously deployed on a 1-GPU group (HP_GPU_COUNT=1) and now
        // picks a 4-GPU group via --reconfigure. The stale value must be replaced.
        const r = resolveHpGpuCount({
            selectedInstanceType: 'ml.g5.12xlarge',
            configInstanceType: 'ml.g5.xlarge',
            existingGpuCount: '1'
        });
        assert.strictEqual(r.gpuCount, '4', 'must re-detect 4 for the new group');
        assert.strictEqual(r.reDetected, true);
        assert.strictEqual(r.changedFrom, '1', 'must report the previous stale value');
    });

    it('re-detects even when HP_GPU_COUNT is already set and unchanged', () => {
        // Does NOT skip just because HP_GPU_COUNT exists (the BL096 fix).
        const r = resolveHpGpuCount({
            selectedInstanceType: 'ml.g6.24xlarge',
            configInstanceType: '',
            existingGpuCount: '4'
        });
        assert.strictEqual(r.gpuCount, '4');
        assert.strictEqual(r.reDetected, true);
        assert.strictEqual(r.changedFrom, null, 'no change reported when value is the same');
    });

    it('auto-detects from config instance type when no HP_GPU_COUNT and no new selection', () => {
        const r = resolveHpGpuCount({
            selectedInstanceType: undefined,
            configInstanceType: 'ml.p5.48xlarge',
            existingGpuCount: undefined
        });
        assert.strictEqual(r.gpuCount, '8');
        assert.strictEqual(r.reDetected, false);
    });

    it('leaves an existing HP_GPU_COUNT untouched when no new selection was made', () => {
        const r = resolveHpGpuCount({
            selectedInstanceType: undefined,
            configInstanceType: 'ml.g5.xlarge',
            existingGpuCount: '4'
        });
        assert.strictEqual(r.gpuCount, null, 'null → caller writes nothing');
        assert.strictEqual(r.reDetected, false);
    });

    it('a selected instance group always wins over a stale config value', () => {
        const r = resolveHpGpuCount({
            selectedInstanceType: 'ml.g6.xlarge',   // 1 GPU
            configInstanceType: 'ml.p5.48xlarge',    // 8 GPU (stale)
            existingGpuCount: '8'
        });
        assert.strictEqual(r.gpuCount, '1');
        assert.strictEqual(r.changedFrom, '8');
    });
});
