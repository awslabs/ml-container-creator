// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R1.2, R4, OQ-11.5) — do/train's runtime compute backend.
 *
 * Runs the REAL rendered do/train in a sandbox project (real script-contract.sh,
 * target descriptors, hyperpod_ops.py / hp_job.py / target_manifest.py, the train
 * helpers) with stub `kubectl` / `aws` on PATH. Asserts behavior, not SKUs:
 *   - a backend the target's compute_backends does not offer is refused (exit 3)
 *     naming the allowed set — derived from the descriptor, never a target literal;
 *   - hyperpod-eks without --backend stays on SMTJ (OQ-11.5);
 *   - --backend hp-eks --dry-run renders a single-node HyperPodPyTorchJob pinned to
 *     the picked group with the node's allocatable GPUs and no EFA;
 *   - a missing pod-identity association stops with exit 4 and the exact create
 *     command, before any cluster write;
 *   - the gen-time EJS target fork (and its batch/v1 Job) is gone.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import ejs from 'ejs';
import { makeSandbox, runBash, sandboxEnv, DO_SRC, REPO } from '../helpers/additive-sandbox.js';
import { allDescriptors, computeBackends } from '../../src/lib/target-manifest-reader.js';

const TRAIN_SRC = readFileSync(join(DO_SRC, 'train'), 'utf8');
// do/train parses config.yaml with PyYAML (or yq): use a python that has it.
const PYTHON = [process.env.MLCC_PYTHON, join(REPO, '.venv/bin/python'), 'python3']
    .filter(Boolean)
    .find(p => spawnSync(p, ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0);
const ROLE = 'arn:aws:iam::111111111111:role/mlcc-hp-train-role-us-west-2';

function node(name, group, gpus) {
    return {
        metadata: { name, labels: { 'sagemaker.amazonaws.com/instance-group-name': group, 'node.kubernetes.io/instance-type': 'ml.zz.x' } },
        spec: {},
        status: { allocatable: { 'nvidia.com/gpu': String(gpus), 'vpc.amazonaws.com/efa': '1' }, conditions: [{ type: 'Ready', status: 'True' }] }
    };
}

function setup({ target, associations = [{ associationId: 'a-1' }] }) {
    const sb = makeSandbox({ pyHelpers: true });
    if (PYTHON !== 'python3') sb.write('bin/python3', `#!/bin/sh\nexec "${PYTHON}" "$@"\n`);
    writeFileSync(join(sb.doDir, 'train'), ejs.render(TRAIN_SRC, { projectName: 'proj' }), { mode: 0o755 });
    for (const lib of ['s3-layout.sh', 'resolve-instance.sh', 'feedback.sh']) {
        if (existsSync(join(DO_SRC, 'lib', lib))) cpSync(join(DO_SRC, 'lib', lib), join(sb.doDir, 'lib', lib));
    }
    cpSync(join(DO_SRC, 'lib/python'), join(sb.doDir, 'lib/python'), { recursive: true });
    for (const helper of ['.train_helper.py', '.train_build_request.py']) {
        cpSync(join(DO_SRC, helper), join(sb.doDir, helper));
    }
    cpSync(join(DO_SRC, 'training/custom'), join(sb.doDir, 'training/custom'), { recursive: true });
    cpSync(join(DO_SRC, 'training/manifest.schema.json'), join(sb.doDir, 'training/manifest.schema.json'));
    sb.write('do/training/config.yaml', [
        'technique: custom',
        'image: "111111111111.dkr.ecr.us-west-2.amazonaws.com/x:proj-latest"',
        'script: "s3://zz-artifacts/scripts/train.py"',
        'instance_type: "ml.g5.xlarge"',
        'dataset: "s3://zz-core/datasets/d/v1/"',
        'max_runtime_seconds: 3600',
        'launcher: "accelerate"',
        ''
    ].join('\n'), 0o644);
    sb.write('do/config', [
        `export DEPLOYMENT_TARGET="${target}"`,
        'export PROJECT_NAME="proj"',
        'export AWS_REGION="us-west-2"',
        'export HP_CLUSTER_NAME="zz-hp"',
        'export HP_NAMESPACE="default"',
        'export _PROFILE_provisionedModules="core,training"',
        'export ARTIFACTS_S3_BUCKET="zz-artifacts"',
        'export CORE_S3_BUCKET="zz-core"',
        'export ROLE_ARN="arn:aws:iam::111111111111:role/mlcc-exec"',
        `export MLCC_HP_TRAIN_ROLE_ARN="${ROLE}"`,
        ''
    ].join('\n'), 0o644);
    const fx = join(sb.root, 'fx');
    sb.write('fx/nodes.json', JSON.stringify({ items: [node('n-b', 'grp-b', 4), node('n-a', 'grp-a', 4)] }), 0o644);
    sb.write('fx/pods.json', JSON.stringify({ items: [] }), 0o644);
    sb.write('fx/assoc.json', JSON.stringify({ associations }), 0o644);
    const log = join(sb.root, 'calls.log');
    sb.write('bin/kubectl', [
        '#!/bin/bash',
        `echo "kubectl $*" >> "${log}"`,
        'case "$1 $2" in',
        '  "get crd") echo "customresourcedefinition.apiextensions.k8s.io/hyperpodpytorchjobs.sagemaker.amazonaws.com" ;;',
        '  "get deployments") echo \'{"items":[{"metadata":{"name":"hp-training-operator-controller"},"status":{"conditions":[{"type":"Available","status":"True"}]}}]}\' ;;',
        '  "get pvc") echo \'{"status":{"phase":"Bound"}}\' ;;',
        `  "get nodes") cat "${fx}/nodes.json" ;;`,
        `  "get pods") cat "${fx}/pods.json" ;;`,
        '  *) exit 1 ;;',
        'esac'
    ].join('\n'));
    sb.write('bin/aws', [
        '#!/bin/bash',
        `echo "aws $*" >> "${log}"`,
        'case "$1 $2" in',
        '  "sagemaker describe-cluster") echo "arn:aws:eks:us-west-2:111111111111:cluster/zz-eks" ;;',
        `  "eks list-pod-identity-associations") cat "${fx}/assoc.json" ;;`,
        `  "eks describe-pod-identity-association") echo '{"association":{"roleArn":"${ROLE}"}}' ;;`,
        '  "iam simulate-principal-policy") echo \'{"EvaluationResults":[{"EvalDecision":"allowed"}]}\' ;;',
        '  *) exit 1 ;;',
        'esac'
    ].join('\n'));
    const run = (args) => {
        const env = sandboxEnv(sb, { HOME: sb.root, MLFLOW_TRACKING_URI: '' });
        const r = runBash(join(sb.doDir, 'train'), args, env, { timeout: 60000 });
        const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
        return { ...r, calls };
    };
    return { sb, run };
}

describe('Wave 11 — do/train compute backend (R1.2 / R4 / OQ-11.5)', function () {
    this.timeout(120000);
    before(function () {
        if (!PYTHON) this.skip(); // no python3 with PyYAML (CI installs requirements.txt)
    });
    const sandboxes = [];
    after(() => sandboxes.forEach(s => s.cleanup()));
    const mk = (opts) => { const s = setup(opts); sandboxes.push(s.sb); return s; };

    it('the gen-time hyperpod-eks EJS fork and its batch/v1 Job are gone', () => {
        assert.ok(!/deploymentTarget\s*===/.test(TRAIN_SRC), 'no gen-time target branch in do/train');
        assert.ok(!/kind:\s*Job\b/.test(TRAIN_SRC), 'no batch/v1 Job manifest in do/train');
        assert.match(TRAIN_SRC, /target_manifest\.py" compute_backends/, 'the backend list is read from the descriptor');
    });

    for (const d of allDescriptors().filter(x => x.family !== 'sagemaker-job')) {
        const offered = computeBackends(d.target);
        const refused = ['smtj', 'hp-eks'].filter(b => !offered.includes(b));
        for (const b of refused) {
            it(`${d.target}: --backend ${b} is refused with exit 3 naming the allowed set`, () => {
                const { run } = mk({ target: d.target });
                const r = run(['--backend', b, '--dry-run']);
                assert.strictEqual(r.code, 3, r.stdout + r.stderr);
                assert.match(r.stdout, /Contract violation: backend/);
                offered.forEach(o => assert.ok(r.stdout.includes(o), `must name allowed backend ${o}`));
            });
        }
    }

    it('an unknown backend is refused on hyperpod-eks too', () => {
        const { run } = mk({ target: 'hyperpod-eks' });
        const r = run(['--backend', 'bogus', '--dry-run']);
        assert.strictEqual(r.code, 3);
        computeBackends('hyperpod-eks').forEach(o => assert.ok(r.stdout.includes(o)));
    });

    it('hyperpod-eks without --backend stays on SMTJ (OQ-11.5): CreateTrainingJob dry run, no cluster call', () => {
        const { run } = mk({ target: 'hyperpod-eks' });
        const r = run(['--dry-run']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /CreateTrainingJob request/);
        assert.ok(!/kubectl/.test(r.calls), `SMTJ must not touch the cluster:\n${r.calls}`);
    });

    it('--backend hp-eks --dry-run renders a pinned single-node HPPJ with allocatable GPUs and no EFA', () => {
        const { run } = mk({ target: 'hyperpod-eks' });
        const r = run(['--backend', 'hp-eks', '--dry-run']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const json = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
        const doc = JSON.parse(json);
        const hppj = doc.items.find(i => i.kind === 'HyperPodPyTorchJob');
        const cm = doc.items.find(i => i.kind === 'ConfigMap');
        assert.ok(hppj && cm, 'HPPJ + plugin ConfigMap');
        const pod = hppj.spec.replicaSpecs[0].template.spec;
        // name-sorted first group with a whole free node, derived from the stub nodes
        assert.deepStrictEqual(pod.nodeSelector, { 'sagemaker.amazonaws.com/instance-group-name': 'grp-a' });
        const main = pod.containers.find(c => c.name === 'mlcc-train');
        assert.deepStrictEqual(main.resources.limits, { 'nvidia.com/gpu': 4 });
        assert.ok(!JSON.stringify(hppj).includes('vpc.amazonaws.com/efa'), 'single node: no EFA request');
        assert.strictEqual(pod.serviceAccountName, 'mlcc-train-sa');
        assert.strictEqual(hppj.spec.runPolicy.activeDeadlineSeconds, 3600);
        assert.strictEqual(hppj.metadata.labels['mlcc.aws/project-name'], 'proj');
        assert.ok(!/kubectl (apply|create|delete)/.test(r.calls), `dry run makes no cluster write:\n${r.calls}`);
    });

    it('--gpus is honored and validated', () => {
        const { run } = mk({ target: 'hyperpod-eks' });
        const r = run(['--backend', 'hp-eks', '--dry-run', '--gpus', '2']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /"nvidia.com\/gpu": 2/);
        assert.strictEqual(run(['--backend', 'hp-eks', '--dry-run', '--gpus', 'two']).code, 2);
    });

    it('a missing pod-identity association stops with exit 4 and the exact create command', () => {
        const { run } = mk({ target: 'hyperpod-eks', associations: [] });
        const r = run(['--backend', 'hp-eks']);
        assert.strictEqual(r.code, 4, r.stdout + r.stderr);
        assert.ok(r.stderr.includes('aws eks create-pod-identity-association --cluster-name zz-eks --namespace default '
            + `--service-account mlcc-train-sa --role-arn ${ROLE} --region us-west-2`), r.stderr);
        assert.ok(!/kubectl (apply|create)/.test(r.calls), 'nothing written to the cluster');
    });

    it('the rendered do/train parses under bash -n for every target', () => {
        for (const d of allDescriptors()) {
            const s = makeSandbox();
            sandboxes.push(s);
            const p = s.write('do/train', ejs.render(TRAIN_SRC, { projectName: 'p', deploymentTarget: d.target }));
            const r = runBash('-n', [p], sandboxEnv(s));
            assert.strictEqual(r.code, 0, `${d.target}: ${r.stderr}`);
        }
        assert.ok(REPO);
    });
});
