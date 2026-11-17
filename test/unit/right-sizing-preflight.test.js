// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 8 (R3.1 / R4.1 / R10.2) — the right-sizing preflight in do/deploy, the
 * --ignore-sizing override (OQ-8.7), the k8s drivers no longer re-reporting
 * findings, and the registry <-> docs/architecture/right-sizing.md drift guard.
 *
 * The behavioral tests run the REAL templates/do/deploy under /bin/bash (bash
 * 3.2 on macOS) in a sandbox project with the real right_sizing.py, a stub
 * deploy.d/<target> driver that records it ran, and stub aws / kubectl that
 * log every call — so "blocked" provably means "nothing created or applied".
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, sandboxEnv, runBash, REPO, DO_SRC } from '../helpers/additive-sandbox.js';

const PY = process.env.MLCC_PYTHON || 'python3';
const GIB = 1024 ** 3;

function registeredChecks() {
    const r = spawnSync(PY, ['-c', 'import json, right_sizing; print(json.dumps(list(right_sizing.CHECKS)))'],
        { cwd: join(DO_SRC, 'lib/python'), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

/** Smallest and largest single-GPU catalogued instances (no frozen SKUs). */
function singleGpuInstances() {
    const cat = JSON.parse(readFileSync(join(REPO, 'servers/lib/catalogs/instances.json'), 'utf8')).catalog;
    const one = Object.entries(cat).filter(([, e]) => e.gpus === 1 && e.gpuMemoryGb)
        .sort((a, b) => a[1].gpuMemoryGb - b[1].gpuMemoryGb);
    return { small: one[0], big: one[one.length - 1] };
}

const DENSE = {
    architectures: ['LlamaForCausalLM'], model_type: 'llama', hidden_size: 4096, intermediate_size: 14336,
    num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, max_position_embeddings: 8192,
    vocab_size: 128256, tie_word_embeddings: false, torch_dtype: 'bfloat16'
};

describe('Wave 8 — right-sizing catalogue doc lists every registered check (R4.1 drift)', () => {
    it('every right_sizing.CHECKS id appears in docs/architecture/right-sizing.md', () => {
        const doc = readFileSync(join(REPO, 'docs/architecture/right-sizing.md'), 'utf8');
        const ids = registeredChecks();
        assert.ok(ids.length >= 14, `expected the 6.1 + Wave 8 checks, got ${ids}`);
        for (const id of ids) {
            assert.ok(new RegExp(`^\\| \`${id}\` \\|`, 'm').test(doc), `catalogue row missing for ${id}`);
        }
    });
    it('the doc is in the mkdocs nav', () => {
        assert.match(readFileSync(join(REPO, 'mkdocs.yml'), 'utf8'), /architecture\/right-sizing\.md/);
    });
});

describe('Wave 8 — k8s drivers ask only for the rank value after the preflight (no re-reporting)', () => {
    for (const drv of ['eks', 'hyperpod-eks']) {
        const src = readFileSync(join(DO_SRC, 'deploy.d', drv), 'utf8');
        it(`deploy.d/${drv} passes --quiet when MLCC_SIZING_PREFLIGHT_DONE=1`, () => {
            assert.match(src, /MLCC_SIZING_PREFLIGHT_DONE:-0\}" = "1" \] && _[A-Z]+_RANK_QUIET="--quiet"/);
            assert.match(src, /right_sizing\.py" effective-lora-rank \$\{_[A-Z]+_RANK_QUIET\}/);
        });
        it(`deploy.d/${drv} honors --ignore-sizing (MLCC_IGNORE_SIZING) on the rank refusal`, () => {
            assert.match(src, /MLCC_IGNORE_SIZING:-0\}" = "1" \]; then\n\s+echo "⚠️ {2}--ignore-sizing: proceeding/);
        });
    }
    it('do/deploy exports the preflight marker and the override for the drivers', () => {
        const dep = readFileSync(join(DO_SRC, 'deploy'), 'utf8');
        assert.match(dep, /export MLCC_SIZING_PREFLIGHT_DONE=1/);
        assert.match(dep, /export MLCC_IGNORE_SIZING=1/);
        // --force never feeds the sizing decision
        const pre = dep.slice(dep.indexOf('Right-sizing preflight (Wave 8'), dep.indexOf('# Dispatch to target-specific'));
        assert.ok(pre.length > 0 && !/--force/.test(pre.replace(/--force does NOT bypass it/, '')),
            'the preflight block must not consult --force');
    });
});

describe('Wave 8 — do/deploy right-sizing preflight (behavioral, bash 3.2)', function () {
    this.timeout(60000);
    let sb;
    const { small, big } = singleGpuInstances();

    function setup(target, instanceType, extra = '') {
        sb = makeSandbox({ scripts: ['deploy'], pyHelpers: true });
        for (const py of ['deploy_schema.py']) {
            sb.write(`do/lib/python/${py}`, readFileSync(join(DO_SRC, 'lib/python', py)), 0o644);
        }
        sb.write('.mlcc/instances.json', readFileSync(join(REPO, 'servers/lib/catalogs/instances.json')), 0o644);
        const model = join(sb.root, 'model');
        mkdirSync(model, { recursive: true });
        sb.write('model/config.json', JSON.stringify(DENSE), 0o644);
        // Sparse weights file: as large as the smallest single-GPU instance's memory.
        const fd = openSync(join(model, 'model.safetensors'), 'w');
        ftruncateSync(fd, Math.round(small[1].gpuMemoryGb * GIB));
        closeSync(fd);
        const statusVar = target === 'eks' ? 'DEPLOYMENT_TARGET_EKS_STATUS' : 'DEPLOYMENT_TARGET_SMAI_STATUS';
        sb.write('do/config', [
            'export PROJECT_NAME="sizing-test"',
            `export DEPLOYMENT_TARGET="${target}"`,
            'export MODEL_SERVER="vllm"',
            `export INSTANCE_TYPE="${instanceType}"`,
            `export HP_INSTANCE_TYPE="${instanceType}"`,
            `export SMAI_INSTANCE_TYPE="${instanceType}"`,
            'export HP_CLUSTER_NAME="c"',
            'export HP_GPU_COUNT="1"',
            'export HP_LORA_ENABLED="false"',
            'export ENABLE_LORA="false"',
            `export STAGED_MODEL_PATH="${model}"`,
            `export ${statusVar}=""`,
            extra,
            ''
        ].join('\n'), 0o644);
        sb.write(`do/deploy.d/${target}`, '#!/bin/bash\necho "DRIVER_RAN ignore=${MLCC_IGNORE_SIZING:-0} done=${MLCC_SIZING_PREFLIGHT_DONE:-0}" >> "${SCRIPT_DIR}/../driver.log"\n');
        for (const tool of ['aws', 'kubectl']) {
            sb.write(`bin/${tool}`, `#!/bin/bash\necho "${tool} $*" >> "${sb.root}/calls.log"\nexit 0\n`);
        }
    }
    const driverRan = () => existsSync(join(sb.root, 'driver.log')) ? readFileSync(join(sb.root, 'driver.log'), 'utf8') : '';
    const calls = () => existsSync(join(sb.root, 'calls.log')) ? readFileSync(join(sb.root, 'calls.log'), 'utf8') : '';
    const deploy = (args) => runBash(join(sb.doDir, 'deploy'), args, sandboxEnv(sb, { HOME: sb.root }), { timeout: 50000 });

    after(() => sb && sb.cleanup());

    it('a block stops before the driver and before any AWS / kubectl call (exit 1, findings shown)', () => {
        setup('eks', small[0]);
        const r = deploy([]);
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /\[context-memory\].*over usable memory/);
        assert.match(r.stdout, /Fix: /);
        assert.match(r.stderr, /Right-sizing blocked this deploy/);
        assert.match(r.stderr, /--ignore-sizing/);
        assert.strictEqual(driverRan(), '', 'deploy.d driver must not run');
        assert.strictEqual(calls(), '', 'no aws / kubectl call before the block');
        sb.cleanup();
    });

    it('--force alone still blocks (it is not a sizing override)', () => {
        setup('eks', small[0]);
        const r = deploy(['--force']);
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        assert.strictEqual(driverRan(), '');
        sb.cleanup();
    });

    it('--ignore-sizing proceeds with a warning line and tells the driver', () => {
        setup('eks', small[0]);
        const r = deploy(['--ignore-sizing']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /--ignore-sizing: proceeding despite the right-sizing block/);
        assert.match(driverRan(), /DRIVER_RAN ignore=1 done=1/);
        sb.cleanup();
    });

    it('a configuration that fits proceeds to the driver', () => {
        setup('eks', big[0], 'export VLLM_MAX_MODEL_LEN="1024"');
        const r = deploy([]);
        assert.notStrictEqual(r.code, 1, r.stdout + r.stderr);
        assert.match(driverRan(), /DRIVER_RAN ignore=0 done=1/);
        sb.cleanup();
    });

    // ── BL204: --dry-run is the preflight-only check (same function, nothing created) ──
    const cfg = () => readFileSync(join(sb.doDir, 'config'), 'utf8');

    it('--dry-run on an oversized config prints the block and exits 1, with zero driver / aws / kubectl calls', () => {
        setup('eks', small[0]);
        const before = cfg();
        const r = deploy(['--dry-run']);
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /Dry Run/);
        assert.match(r.stdout, /Resolved configuration:/);
        assert.match(r.stdout, /Right-sizing preflight \(eks, /);
        assert.match(r.stdout, /\[context-memory\].*over usable memory/);
        assert.match(r.stderr, /Right-sizing blocked this deploy/);
        assert.strictEqual(driverRan(), '', 'deploy.d driver must not run under --dry-run');
        assert.strictEqual(calls(), '', 'no aws / kubectl call under --dry-run');
        assert.strictEqual(cfg(), before, '--dry-run must not write do/config');
        sb.cleanup();
    });

    it('--dry-run --ignore-sizing exits 0 with the warning line and still dispatches nothing', () => {
        setup('eks', small[0]);
        const r = deploy(['--dry-run', '--ignore-sizing']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /--ignore-sizing: proceeding despite the right-sizing block/);
        assert.match(r.stdout, /No changes made \(dry run\)/);
        assert.strictEqual(driverRan(), '');
        assert.strictEqual(calls(), '');
        sb.cleanup();
    });

    it('--dry-run on a fitting config exits 0, prints "fits", and keeps the dry-run output', () => {
        setup('eks', big[0], 'export VLLM_MAX_MODEL_LEN="1024"');
        const r = deploy(['--dry-run']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Right-sizing: fits\./);
        assert.match(r.stdout, new RegExp(`INSTANCE_TYPE=${big[0].replace(/\./g, '\\.')}`));
        assert.match(r.stdout, /Would execute:\n {2}source .*deploy\.d\/eks/);
        assert.match(r.stdout, /No changes made \(dry run\)/);
        assert.ok(r.stdout.indexOf('Resolved configuration:') < r.stdout.indexOf('Right-sizing preflight'),
            'preflight findings follow the resolved config');
        assert.strictEqual(driverRan(), '');
        assert.strictEqual(calls(), '');
        sb.cleanup();
    });

    for (const extraArgs of [[], ['--force']]) {
        it(`--dry-run --target on an already-deployed target ${extraArgs.join(' ') || '(no --force)'} runs the preflight instead of the "already deployed" short-circuit`, () => {
            setup('eks', small[0], 'export DEPLOYMENT_TARGET_EKS_STATUS="Running"');
            const before = cfg();
            const r = deploy(['--dry-run', '--target', 'eks', ...extraArgs]);
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /eks is already deployed \(Running\); --dry-run previews its saved configuration/);
            assert.doesNotMatch(r.stdout, /Focused on eks/);
            assert.match(r.stdout, /\[context-memory\].*over usable memory/);
            assert.strictEqual(driverRan(), '');
            assert.strictEqual(calls(), '');
            assert.strictEqual(cfg(), before, 'no focus switch / INSTANCE_TYPE clear under --dry-run');
            sb.cleanup();
        });
    }

    it('without --dry-run, an already-deployed --target still short-circuits (unchanged)', () => {
        setup('eks', small[0], 'export DEPLOYMENT_TARGET_EKS_STATUS="Running"');
        const r = deploy(['--target', 'eks']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Focused on eks/);
        assert.doesNotMatch(r.stdout, /Right-sizing preflight/);
        assert.strictEqual(driverRan(), '');
        sb.cleanup();
    });

    it('a non-GPU (uncatalogued) instance is skipped, not blocked', () => {
        setup('realtime-inference', 'ml.m5.xlarge');
        const r = deploy([]);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /skipped: instance ml\.m5\.xlarge is not in the instance catalog/);
        assert.match(driverRan(), /DRIVER_RAN/);
        sb.cleanup();
    });
});
