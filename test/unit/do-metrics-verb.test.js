// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 9 (R12, OQ-9.9) — the do/metrics verb, run for real under /bin/bash
 * (bash 3.2 on macOS) in a sandbox project with the real Python helpers and
 * descriptors, a stub `aws`, and NO AWS credentials (so the default gate never
 * touches the network). Asserts:
 *   - --help / usage errors (bad --window → exit 2, nothing called);
 *   - applicability comes from targets.d verbs.metrics: a target without a
 *     store prints the skip notice with the reason and exits 0 (R12.4);
 *   - a realtime readout prints every R12.1 line, "no data" when the store has
 *     no samples, plus the console-path dashboard pointer (no unverified URL).
 */
import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, sandboxEnv, runBash, DO_SRC, ACTIVE_STATUS_CONFIG } from '../helpers/additive-sandbox.js';
import { allDescriptors } from '../../src/lib/target-manifest-reader.js';

describe('Wave 9 — do/metrics verb (behavioral, bash 3.2)', function () {
    this.timeout(60000);
    let sb;
    afterEach(() => sb && sb.cleanup());

    function setup(configLines) {
        sb = makeSandbox({ scripts: ['metrics'], pyHelpers: true });
        for (const py of ['gpu_metrics.py', 'endpoint_metrics.py']) {
            sb.write(`do/lib/python/${py}`, readFileSync(join(DO_SRC, 'lib/python', py)), 0o644);
        }
        sb.write('do/lib/aws-preflight.sh', readFileSync(join(DO_SRC, 'lib/aws-preflight.sh')), 0o644);
        sb.write('do/config', [...configLines, ''].join('\n'), 0o644);
        // Stub aws: sts succeeds (preflight), everything is logged.
        sb.write('bin/aws', `#!/bin/bash\necho "aws $*" >> "${sb.root}/calls.log"\n`
            + 'case "$1" in sts) echo \'{"Account":"000000000000"}\';; esac\nexit 0\n');
    }
    const env = () => sandboxEnv(sb, {
        HOME: join(sb.root, 'home'),
        AWS_SHARED_CREDENTIALS_FILE: join(sb.root, 'no-credentials'),
        AWS_CONFIG_FILE: join(sb.root, 'no-config'),
        AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
        AWS_EC2_METADATA_DISABLED: 'true', AWS_REGION: 'us-west-2'
    });
    const metrics = (args) => runBash(join(sb.doDir, 'metrics'), args, env(), { timeout: 50000 });
    const calls = () => (existsSync(join(sb.root, 'calls.log')) ? readFileSync(join(sb.root, 'calls.log'), 'utf8') : '');

    it('--help prints usage and exits 0 without a config', () => {
        setup([]);
        const r = metrics(['--help']);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.match(r.stdout, /Usage: \.\/do\/metrics \[--window <minutes>\]/);
    });

    for (const bad of [['--window', '0'], ['--window', '1441'], ['--window', 'abc'], ['--window'], ['--bogus']]) {
        it(`usage error ${JSON.stringify(bad)} → exit 2, nothing called`, () => {
            setup(['export DEPLOYMENT_TARGET="realtime-inference"']);
            const r = metrics(bad);
            assert.strictEqual(r.code, 2, r.stdout + r.stderr);
            assert.match(r.stderr, /Usage: \.\/do\/metrics/);
            assert.strictEqual(calls(), '');
        });
    }

    // Every target whose descriptor says verbs.metrics=false gets the skip notice.
    for (const d of allDescriptors().filter((x) => !(x.verbs && x.verbs.metrics))) {
        it(`${d.target}: skip notice with the reason, exit 0 (derived from verbs.metrics)`, () => {
            setup([`export DEPLOYMENT_TARGET="${d.target}"`]);
            const r = metrics(['--window', '5']);
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, new RegExp(`skipped — ${d.target} has no AWS-native metrics store`));
            assert.ok(!/aws /.test(calls()), 'no AWS call for a target without a store');
        });
    }

    it('--target overrides DEPLOYMENT_TARGET', () => {
        setup(['export DEPLOYMENT_TARGET="realtime-inference"']);
        const r = metrics(['--target', 'eks']);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.match(r.stdout, /skipped — eks/);
    });

    it('a target WITH a store still requires an active deployment (exit 3)', () => {
        setup(['export DEPLOYMENT_TARGET="realtime-inference"', 'export ENDPOINT_NAME="ep-1"']);
        const r = metrics([]);
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /deployment-active/);
        assert.ok(!/aws /.test(calls()));
    });

    it('realtime readout prints every line, "no data" when absent, and the console dashboard path', () => {
        setup([ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="realtime-inference"', 'export PROJECT_NAME="p"',
            'export ENDPOINT_NAME="ep-1"', 'export INFERENCE_COMPONENT_NAME="ic-1"',
            'export MODEL_SERVER="vllm"', 'export AWS_REGION="us-west-2"']);
        const r = metrics(['--window', '5']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        for (const label of ['TTFT (server) p50', 'TTFT (server) p99', 'E2E latency (server) p50',
            'E2E latency (server) p99', 'Queue waiting avg', 'Queue waiting max', 'Running avg',
            'KV cache avg', 'KV cache max', 'GPU util avg', 'Per-copy concurrency avg']) {
            assert.match(r.stdout, new RegExp(`${label.replace(/[()]/g, '\\$&')}\\s+no data`), label);
        }
        assert.match(r.stdout, /Dashboard: CloudWatch console → Insights → SageMaker AI \(us-west-2, endpoint ep-1\)/);
        assert.ok(!/https?:\/\/[^ ]*console/.test(r.stdout), 'no unverified console deep link');
        assert.match(calls(), /aws sts get-caller-identity/);
    });

    it('--json emits a parseable readout', () => {
        setup([ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="realtime-inference"', 'export PROJECT_NAME="p"',
            'export ENDPOINT_NAME="ep-1"', 'export MODEL_SERVER="vllm"', 'export AWS_REGION="us-west-2"']);
        const r = metrics(['--window=3', '--json']);
        assert.strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.window_minutes, 3);
        assert.strictEqual(out.store, 'cloudwatch-promql');
        assert.ok(out.lines.every((l) => l.value === null), 'no credentials → every value is null, never 0');
    });
});
