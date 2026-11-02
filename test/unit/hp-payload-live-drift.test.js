// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R13.2) — LIVE drift check: the HP-EKS payload templates the tune catalog
 * points at today still match hp_payload_sites.json. NETWORK-DEPENDENT: listed in
 * scripts/run-node-tests.js NETWORK_DEPENDENT, so it runs only with
 * `node scripts/run-node-tests.js --include-network` (read-only `aws s3 cp` from the
 * AWS-owned jumpstart-cache bucket). The deterministic offline counterpart is
 * test/unit/test_hp_payload.py against the captured fixtures.
 *
 * For every distinct HyperPodPyTorchJob payload (sft / dpo) in config/tune-catalog.json:
 *   - a template in a VERIFIED family (verl) must render with --adapt-shape (every
 *     site found, post-scan clean); a failure means AWS moved a site → re-capture
 *     the fixture and update the site list;
 *   - any other family must be REFUSED honestly ("no verified site list"), never
 *     patched blindly.
 * Skips (with the reason) when the aws CLI or credentials are unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PY = [process.env.MLCC_PYTHON, join(ROOT, '.venv/bin/python'), 'python3']
    .filter(Boolean)
    .find(p => spawnSync(p, ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0);

function pointers() {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'config/tune-catalog.json'), 'utf8'));
    const out = new Map();
    for (const model of Object.values(catalog.models || {})) {
        for (const [technique, t] of Object.entries(model.techniques || {})) {
            if (!['sft', 'dpo'].includes(technique)) continue;
            for (const p of Object.values(t.hpEks || {})) {
                if (p && p.payloadTemplate && p.overrideParams) out.set(p.payloadTemplate, { ...p, technique });
            }
        }
    }
    return [...out.values()];
}

test('catalog HP-EKS payload templates still match the verified site list (live)', (t) => {
    if (!PY) return t.skip('no python3 with PyYAML');
    if (spawnSync('aws', ['--version']).status !== 0) return t.skip('aws CLI not installed');
    if (spawnSync('aws', ['sts', 'get-caller-identity'], { encoding: 'utf8' }).status !== 0) {
        return t.skip('no AWS credentials');
    }
    const list = pointers();
    assert.ok(list.length > 0, 'the tune catalog records hpEks payload pointers (run npm run sync:models)');
    const dir = mkdtempSync(join(tmpdir(), 'w11-live-'));
    let verified = 0;
    try {
        for (const [i, p] of list.entries()) {
            const tmpl = join(dir, `${i}.yaml`);
            const op = join(dir, `${i}.json`);
            for (const [src, dst] of [[p.payloadTemplate, tmpl], [p.overrideParams, op]]) {
                const r = spawnSync('aws', ['s3', 'cp', '--only-show-errors', src, dst], { encoding: 'utf8' });
                assert.strictEqual(r.status, 0, `${src}: ${r.stderr}`);
            }
            const r = spawnSync(PY, [join(ROOT, 'templates/do/lib/python/hp_payload.py'), 'render',
                '--template', tmpl, '--override-params', op, '--group', 'grp', '--group-gpus', '4', '--group-efa', '1',
                '--project', 'p', '--job', 'j', '--namespace', 'default', '--artifacts-bucket', 'a', '--region', 'us-west-2',
                '--dataset-uri', 's3://a/p/tune/j/input/', '--technique', p.technique, '--max-runtime', '600',
                '--set', 'dataset_max_len=1024', '--adapt-shape', '--out', join(dir, `${i}.out.json`)],
            { encoding: 'utf8' });
            if (r.status === 0) {
                verified += 1;
                assert.ok(existsSync(join(dir, `${i}.out.json`)));
            } else {
                assert.match(r.stderr, /no verified site list/,
                    `${p.payloadTemplate}: a verified family no longer matches its sites:\n${r.stderr}`);
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(verified > 0, 'at least one catalog template is in a verified family and renders');
});
