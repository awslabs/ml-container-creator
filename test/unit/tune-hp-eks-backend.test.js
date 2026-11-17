// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R1.2, R9.1, R9.2; OQ-11.3) — do/tune --backend hp-eks gates. F4 (held
 * until the F0b re-probe is recorded).
 *
 * Runs the REAL rendered do/tune in a sandbox (real script-contract.sh, target and
 * tune descriptors, tune catalog, readers) with stub `aws` / `kubectl`. The gates
 * run before any dataset or cluster call, and are DERIVED: the allowed backends from
 * compute_backends, the workload kind from the synced tune descriptor
 * (_synced["hp-eks"].workload_kind), never a per-technique literal:
 *   - a RayJob recipe (RLVR / RLAIF) is refused (exit 3) naming KubeRay;
 *   - a technique with no HP-EKS payload (MTRL) is refused (exit 3);
 *   - --backend hp-eks on a target without it is refused naming the allowed set;
 *   - --adapt-shape / --render-only without --backend hp-eks is a usage error.
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';
import { makeSandbox, runBash, sandboxEnv, DO_SRC, REPO } from '../helpers/additive-sandbox.js';

const TUNE_SRC = readFileSync(join(DO_SRC, 'tune'), 'utf8');
const KINDS = {};
for (const t of ['sft', 'dpo', 'rlvr', 'rlaif', 'mtrl']) {
    const d = JSON.parse(readFileSync(join(REPO, 'templates/code/tune.d', t, 'manifest.json'), 'utf8'));
    const hp = (d.variants.lora && d.variants.lora._synced && d.variants.lora._synced['hp-eks']) || null;
    KINDS[t] = hp ? (hp.workload_kind || 'unknown') : '';
}
// A catalog model that advertises every technique (derived, not pinned).
const CATALOG = JSON.parse(readFileSync(join(REPO, 'config/tune-catalog.json'), 'utf8'));
const MODEL = Object.entries(CATALOG.models).find(([, m]) =>
    ['sft', 'rlvr', 'rlaif'].every(t => m.techniques && m.techniques[t]))?.[0];
const modelFor = t => Object.entries(CATALOG.models).find(([, m]) => m.techniques && m.techniques[t])?.[0];

describe('Wave 11 — do/tune --backend hp-eks gates (F4)', function () {
    this.timeout(120000);
    const boxes = [];
    after(() => boxes.forEach(b => b.cleanup()));

    function run(target, args, model = MODEL) {
        const sb = makeSandbox({ pyHelpers: true });
        boxes.push(sb);
        writeFileSync(join(sb.doDir, 'tune'), ejs.render(TUNE_SRC, { projectName: 'proj' }), { mode: 0o755 });
        cpSync(join(DO_SRC, 'lib/python'), join(sb.doDir, 'lib/python'), { recursive: true });
        cpSync(join(REPO, 'templates/code/tune.d'), join(sb.root, '.mlcc/tune.d'), { recursive: true });
        sb.write('do/config', [
            `export DEPLOYMENT_TARGET="${target}"`, 'export PROJECT_NAME="proj"', 'export AWS_REGION="us-west-2"',
            'export TUNE_SUPPORTED="true"', `export TUNE_MODEL_ID="${model}"`, 'export HP_CLUSTER_NAME="hp"',
            'export ARTIFACTS_S3_BUCKET="zz-art"', 'export STAGED_MODEL_PATH="s3://zz-core/models/org/m/"',
            'export MCC_NO_STALE_WARNING="true"', 'export _PROFILE_provisionedModules="core,training"', ''
        ].join('\n'), 0o644);
        const log = join(sb.root, 'calls.log');
        sb.write('bin/aws', `#!/bin/bash\necho "aws $*" >> "${log}"\nexit 1\n`);
        sb.write('bin/kubectl', `#!/bin/bash\necho "kubectl $*" >> "${log}"\nexit 1\n`);
        sb.write('calls.log', '', 0o644);
        const r = runBash(join(sb.doDir, 'tune'), args, sandboxEnv(sb, { HOME: sb.root }), { timeout: 60000 });
        return { ...r, calls: readFileSync(log, 'utf8') };
    }

    it('fixture sanity: the synced descriptors carry the hp-eks workload kinds', () => {
        assert.ok(MODEL, 'a catalog model advertises sft + rlvr + rlaif');
        assert.ok(Object.values(KINDS).includes('HyperPodPyTorchJob'));
    });

    for (const t of ['sft', 'dpo', 'rlvr', 'rlaif', 'mtrl']) {
        it(`${t}: the hp-eks gate follows the synced workload kind (${KINDS[t] || 'no payload'})`, function () {
            if (!modelFor(t)) this.skip(); // no catalog model advertises this technique
            const r = run('hyperpod-eks', ['--technique', t, '--dataset', 's3://zz-core/datasets/d/v1/x.jsonl', '--backend', 'hp-eks'], modelFor(t));
            const out = r.stdout + r.stderr;
            if (KINDS[t] === 'RayJob') {
                assert.strictEqual(r.code, 3, out);
                assert.match(r.stdout, /KubeRay/);
                assert.match(r.stdout, /post-2\.0/);
            } else if (KINDS[t] === '') {
                assert.strictEqual(r.code, 3, out);
                assert.match(r.stdout, /AWS publishes no HP-EKS payload/);
            } else {
                assert.ok(!/Contract violation: backend/.test(r.stdout), `an HPPJ recipe passes the gate:\n${out}`);
            }
            assert.ok(!/kubectl (apply|create)/.test(r.calls), 'a refusal makes no cluster write');
        });
    }

    it('--backend hp-eks on a target without it is refused naming the allowed set', () => {
        const r = run('realtime-inference', ['--technique', 'sft', '--dataset', 's3://zz-core/datasets/d/v1/x.jsonl', '--backend', 'hp-eks']);
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /Contract violation: backend/);
        assert.match(r.stdout, /smtj/);
    });

    it('--adapt-shape without --backend hp-eks is a usage error (exit 2)', () => {
        const r = run('hyperpod-eks', ['--technique', 'sft', '--dataset', 's3://zz-core/datasets/d/v1/x.jsonl', '--adapt-shape']);
        assert.strictEqual(r.code, 2, r.stdout + r.stderr);
    });

    it('the rendered do/tune parses under bash -n', () => {
        const sb = makeSandbox();
        boxes.push(sb);
        const p = sb.write('do/tune', ejs.render(TUNE_SRC, { projectName: 'p' }));
        assert.strictEqual(runBash('-n', [p], sandboxEnv(sb)).code, 0);
    });
});
