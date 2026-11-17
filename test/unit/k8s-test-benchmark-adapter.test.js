// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6.1 R7b / R7c — do/test --adapter and do/benchmark --adapter on the
 * Kubernetes targets, executed in a sandbox with stubbed aws / kubectl / curl.
 *
 *   R7b.1  do/test --adapter <name> sends "model": "<name>" through the same
 *          /invocations path as the base test, after a /v1/models loaded check
 *          (fails clearly when the adapter is not loaded)
 *   R7b.2  --compare-base: same deterministic request (temperature 0) to base and
 *          adapter, reports whether the outputs differ
 *   R7b.3  both k8s targets, both argument orders
 *   R7b.4  Running-phase pod filter, pod/<name> wording (no svc/), busy local
 *          port detected and named (HP_TEST_PORT)
 *   R7c    do/benchmark --adapter on hyperpod-eks refuses (the managed workload
 *          spec has no request model-name field) before any AWS call
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import net from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runBash, sandboxEnv, ACTIVE_STATUS_CONFIG, REPO } from '../helpers/additive-sandbox.js';

const render = (rel, vars = {}) => {
    const src = join(REPO, 'templates', rel);
    return ejs.render(readFileSync(src, 'utf8'), { projectName: 'proj', includeBenchmark: false, deploymentTarget: 'hyperpod-eks', ...vars }, { filename: src });
};

const AWS_STUB = `#!/bin/bash
echo "$*" >> "\${STUB_STATE}/aws.log"
case "$1 $2" in
  "sagemaker describe-cluster") echo "arn:aws:eks:us-west-2:1:cluster/hp-eks" ;;
  "eks update-kubeconfig") exit 0 ;;
  *) exit 1 ;;
esac
`;
const KUBECTL_STUB = `#!/bin/bash
echo "$*" >> "\${STUB_STATE}/kubectl.log"
case "$1" in
  cluster-info) exit 0 ;;
  get) echo "proj-pod-0" ;;
  port-forward) exec sleep 30 ;;
  *) exit 0 ;;
esac
`;
// curl stub: /ping → 200; /v1/models → base + STUB_LOADED adapters;
// /invocations → a chat completion whose content depends on the requested model.
const CURL_STUB = `#!/bin/bash
url=""; data=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) data="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -X|-H|-m) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$url $data" >> "\${STUB_STATE}/curl.log"
case "$url" in
  */ping) body='{}' ;;
  */v1/models)
    ids='{"id":"/opt/ml/model"}'
    for a in \${STUB_LOADED:-}; do ids="$ids,{\\"id\\":\\"$a\\",\\"parent\\":\\"/opt/ml/model\\"}"; done
    body="{\\"data\\":[$ids]}" ;;
  */invocations)
    model=$(printf '%s' "$data" | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"])')
    body="{\\"choices\\":[{\\"message\\":{\\"content\\":\\"answer from $model\\"}}]}" ;;
esac
if [ -n "$fmt" ]; then printf '%s\\n200' "$body"; else printf '%s' "$body"; fi
`;

function cfg(target, extra = []) {
    return [
        ACTIVE_STATUS_CONFIG,
        `export DEPLOYMENT_TARGET="${target}"`, 'export PROJECT_NAME="proj"', 'export AWS_REGION="us-west-2"',
        'export HP_CLUSTER_NAME="hp"', 'export HP_NAMESPACE="default"', 'export FRAMEWORK="transformers"',
        'export MODEL_SERVER="vllm"', 'export MODEL_NAME="s3://core/models/m/"', 'export HP_TEST_PORT="18181"',
        ...extra, ''
    ].join('\n');
}

describe('Wave 6.1 R7b — do/test --adapter on hyperpod-eks and eks (both argument orders)', function () {
    this.timeout(180000);
    let sb;
    let n = 0;
    before(() => {
        sb = makeSandbox();
        sb.write('do/test', render('do/test'));
        sb.write('do/lib/resolve-instance.sh', '# stub\n', 0o644);
        sb.write('bin/aws', AWS_STUB);
        sb.write('bin/kubectl', KUBECTL_STUB);
        sb.write('bin/curl', CURL_STUB);
    });
    after(() => sb.cleanup());
    const run = (target, args, env = {}) => {
        n += 1;
        const state = join(sb.root, `st${n}`);
        sb.write(`st${n}/.keep`, '', 0o644);
        sb.write('do/config', cfg(target), 0o644);
        const r = runBash(join(sb.doDir, 'test'), args, sandboxEnv(sb, { HOME: sb.root, STUB_STATE: state, ...env }),
            { timeout: 60000 });
        const read = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8') : '');
        return { ...r, curl: read('curl.log'), kubectl: read('kubectl.log') };
    };
    const invoked = (r) => r.curl.split('\n').filter((l) => l.includes('/invocations'))
        .map((l) => JSON.parse(l.slice(l.indexOf(' ') + 1)).model);

    for (const [target, mode] of [['hyperpod-eks', 'hyperpod'], ['eks', 'eks']]) {
        describe(target, () => {
            it(`./do/test --adapter dpo → the request names the adapter (${target})`, () => {
                const r = run(target, ['--adapter', 'dpo'], { STUB_LOADED: 'dpo' });
                assert.strictEqual(r.code, 0, r.stdout + r.stderr);
                assert.deepStrictEqual(invoked(r), ['dpo']);
                assert.match(r.stdout, /Adapter 'dpo' is loaded/);
            });
            it(`./do/test ${mode} --adapter dpo → same (other argument order)`, () => {
                const r = run(target, [mode, '--adapter', 'dpo'], { STUB_LOADED: 'dpo' });
                assert.strictEqual(r.code, 0, r.stdout + r.stderr);
                assert.deepStrictEqual(invoked(r), ['dpo']);
            });
            it('an adapter that is not loaded fails clearly, before any inference request', () => {
                const r = run(target, ['--adapter', 'nope'], { STUB_LOADED: 'dpo' });
                assert.strictEqual(r.code, 1, r.stdout + r.stderr);
                assert.match(r.stdout, /Adapter 'nope' is not loaded/);
                assert.match(r.stdout, /Loaded models: \/opt\/ml\/model, dpo/);
                assert.deepStrictEqual(invoked(r), []);
            });
            it('--compare-base sends base and adapter at temperature 0 and reports the difference', () => {
                const r = run(target, ['--adapter', 'dpo', '--compare-base'], { STUB_LOADED: 'dpo' });
                assert.strictEqual(r.code, 0, r.stdout + r.stderr);
                assert.deepStrictEqual(invoked(r), ['dpo', '/opt/ml/model', 'dpo']);
                const compare = r.curl.split('\n').filter((l) => l.includes('/invocations')).slice(1);
                for (const l of compare) assert.strictEqual(JSON.parse(l.slice(l.indexOf(' ') + 1)).temperature, 0);
                assert.match(r.stdout, /Outputs differ/);
            });
            it('without --adapter the base model is tested unchanged', () => {
                const r = run(target, []);
                assert.strictEqual(r.code, 0, r.stdout + r.stderr);
                assert.deepStrictEqual(invoked(r), ['/opt/ml/model']);
            });
            it('R7b.4: Running-phase pod filter + pod/<name> wording, no svc/', () => {
                const r = run(target, []);
                assert.match(r.kubectl, /get pod -n default -l app=proj --field-selector=status\.phase=Running/);
                assert.match(r.stdout, /Port-forwarding pod\/proj-pod-0/);
                assert.doesNotMatch(r.stdout, /svc\//);
            });
        });
    }

    it('R7b.4: a busy local port is detected and names HP_TEST_PORT', async () => {
        const server = net.createServer(() => {});
        await new Promise((res) => server.listen(18181, '127.0.0.1', res));
        try {
            const r = run('hyperpod-eks', ['--adapter', 'dpo'], { STUB_LOADED: 'dpo' });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /Local port 18181 is already in use/);
            assert.match(r.stdout, /HP_TEST_PORT=/);
            assert.doesNotMatch(r.kubectl, /port-forward/);
        } finally {
            server.close();
        }
    });

    it('--compare-base without --adapter is a usage error', () => {
        const r = run('hyperpod-eks', ['--compare-base']);
        assert.strictEqual(r.code, 1);
        assert.match(r.stdout, /--compare-base requires --adapter/);
    });
});

describe('Wave 6.1 R7c — do/benchmark --adapter on hyperpod-eks refuses instead of mislabeling', function () {
    this.timeout(60000);
    it('exits 3 with the reason, before any AWS call', () => {
        const sb = makeSandbox();
        try {
            sb.write('do/benchmark', render('do/benchmark', { includeBenchmark: true }));
            sb.write('do/lib/resolve-instance.sh', '# stub\n', 0o644);
            sb.write('bin/aws', AWS_STUB);
            sb.write('st/.keep', '', 0o644);
            sb.write('do/config', cfg('hyperpod-eks'), 0o644);
            const r = runBash(join(sb.doDir, 'benchmark'), ['--adapter', 'dpo-w6'],
                sandboxEnv(sb, { HOME: sb.root, STUB_STATE: join(sb.root, 'st') }));
            assert.strictEqual(r.code, 3, r.stdout + r.stderr);
            assert.match(r.stdout, /Contract violation: target/);
            assert.match(r.stdout, /cannot set the request model name/);
            assert.match(r.stdout, /mislabeled 'dpo-w6'/);
            assert.ok(!existsSync(join(sb.root, 'st/aws.log')), 'no AWS call may be made');
        } finally {
            sb.cleanup();
        }
    });
});
