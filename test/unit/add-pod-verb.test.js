// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R7, R8; BL149) — do/add-pod on hyperpod-eks, end to end with stubs.
 *
 * The REAL do/add-pod renders its IEC through the REAL deploy driver in
 * render-only mode (MLCC_HP_RENDER_ONLY) and the shared lib/hp-iec-render.sh,
 * with stub `aws` / `kubectl` on PATH. Asserts behavior:
 *   - a LoRA adapter is refused (exit 3) and pointed at do/adapter (derived text);
 *   - --dry-run renders <project>-<name> with app=<project>-<name> (never
 *     app=<project>), the add-pod role label, one replica and modelLocation under
 *     models/mlcc-<project>/<name>, and makes NO cluster write;
 *   - --instance-group pins via nodeAffinity (no instanceType);
 *   - --remove deletes exactly the add-pod IEC and its state file;
 *   - a bad name is refused (exit 2); do/clean sweeps add-pod IECs by label.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';
import { makeSandbox, runBash, sandboxEnv, DO_SRC, REPO } from '../helpers/additive-sandbox.js';

const VARS = {
    projectName: 'proj', framework: 'transformers', modelName: 'org/model', modelServer: 'vllm',
    hyperPodNamespace: 'default', hyperPodReplicas: 2, instanceType: 'ml.g7.12xlarge',
    awsRegion: 'us-west-2', includeBenchmark: false, fsxVolumeHandle: ''
};
const render = (rel) => {
    const src = join(REPO, 'templates', rel);
    return ejs.render(readFileSync(src, 'utf8'), VARS, { filename: src });
};

const AWS_STUB = `#!/bin/bash
echo "aws $*" >> "\${STUB_LOG}"
case "$1 $2" in
  "s3 ls") case "$*" in *adapter_config.json*) [ -n "\${STUB_ADAPTER:-}" ] && echo "x adapter_config.json" || exit 1 ;; *) exit 0 ;; esac ;;
  "eks update-kubeconfig") exit 0 ;;
  "eks describe-addon") echo "arn:aws:iam::1:role/csi" ;;
  "iam simulate-principal-policy")
    echo '{"EvaluationResults":[{"EvalActionName":"s3:GetObject","EvalResourceName":"arn:aws:s3:::zz-core/*","EvalDecision":"allowed"},{"EvalActionName":"s3:ListBucket","EvalResourceName":"arn:aws:s3:::zz-core","EvalDecision":"allowed"}]}' ;;
  "sagemaker describe-cluster")
    case "$*" in *Orchestrator*) echo "arn:aws:eks:us-west-2:1:cluster/hp-eks" ;; *) echo "{}" ;; esac ;;
  "sagemaker describe-endpoint") echo "InService" ;;
  *) exit 0 ;;
esac
`;
const KUBECTL_STUB = `#!/bin/bash
echo "kubectl $*" >> "\${STUB_LOG}"
node='{"metadata":{"name":"n-a","labels":{"sagemaker.amazonaws.com/instance-group-name":"grp-a","node.kubernetes.io/instance-type":"ml.g7.12xlarge"}},"spec":{},"status":{"allocatable":{"nvidia.com/gpu":"2"},"conditions":[{"type":"Ready","status":"True"}]}}'
case "$1" in
  cluster-info) exit 0 ;;
  get)
    case "$2" in
      nodes) echo "{\\"items\\":[$node]}" ;;
      pods) echo '{"items":[]}' ;;
      csidriver) echo "csidriver.storage.k8s.io/s3.csi.aws.com" ;;
      sa) echo '{"metadata":{"annotations":{}}}' ;;
      inferenceendpointconfig) echo "" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

describe('Wave 11 — do/add-pod (BL149, R7/R8)', function () {
    this.timeout(180000);
    let sb;
    let log;
    before(() => {
        sb = makeSandbox({ pyHelpers: true, scripts: ['add-pod'] });
        cpSync(join(DO_SRC, 'lib/python'), join(sb.doDir, 'lib/python'), { recursive: true });
        sb.write('do/deploy.d/hyperpod-eks', render('do/deploy.d/hyperpod-eks'));
        sb.write('do/clean.d/hyperpod-eks', render('do/clean.d/hyperpod-eks'));
        sb.write('hyperpod/InferenceEndpointConfig.yaml', render('hyperpod/InferenceEndpointConfig.yaml.ejs'), 0o644);
        sb.write('do/lib/aws-preflight.sh', '_aws_preflight() { :; }\n', 0o644);
        sb.write('do/manifest', '#!/bin/bash\nexit 0\n');
        sb.write('bin/aws', AWS_STUB);
        sb.write('bin/kubectl', KUBECTL_STUB);
        log = join(sb.root, 'calls.log');
    });
    after(() => sb.cleanup());

    const run = (args, extraConfig = [], env = {}) => {
        sb.write('do/config', [
            'export PROJECT_NAME="proj"', 'export DEPLOYMENT_TARGET="hyperpod-eks"', 'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
            'export DEPLOYMENT_CONFIG="transformers-vllm"', 'export BUILD_TARGET="codebuild"', 'export HP_CLUSTER_NAME="hp"', 'export HP_NAMESPACE="default"',
            'export HP_REPLICAS="2"', 'export AWS_REGION="us-west-2"', 'export AWS_ACCOUNT_ID="111122223333"',
            'export MODEL_NAME="org/model"', 'export MODEL_SERVER="vllm"', 'export HP_INSTANCE_TYPE="ml.g7.12xlarge"',
            'export CORE_S3_BUCKET="zz-core"', 'export ECR_REPOSITORY="1.dkr.ecr.us-west-2.amazonaws.com/x"', 'export IMAGE_TAG="t"',
            ...extraConfig, ''
        ].join('\n'), 0o644);
        sb.write('calls.log', '', 0o644);
        const r = runBash(join(sb.doDir, 'add-pod'), args,
            sandboxEnv(sb, { HOME: sb.root, STUB_LOG: log, AWS_EC2_METADATA_DISABLED: 'true', ...env }), { timeout: 120000 });
        return { ...r, calls: readFileSync(log, 'utf8') };
    };
    const CANON = 's3://zz-core/models/mlcc-proj/ft1/';

    it('refuses a LoRA adapter (exit 3) and points at do/adapter (derived guidance)', () => {
        const r = run(['ft1', '--from-tune'], ['export TUNE_OUTPUT_PATH_LATEST="s3://zz-art/proj/tune/j/"', 'export TUNE_OUTPUT_TYPE_LATEST="adapter"']);
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /Contract violation: artifact-kind/);
        assert.match(r.stdout, /do\/adapter add <name>/);
        assert.ok(!/kubectl (apply|delete)/.test(r.calls));
    });

    it('a raw S3 source holding adapter_config.json is refused too', () => {
        const r = run(['ft1', '--from-weights', CANON], [], { STUB_ADAPTER: '1' });
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /LoRA adapter/);
    });

    it('--dry-run renders <project>-<name> as its own IEC and writes nothing to the cluster', () => {
        const r = run(['ft1', '--from-weights', CANON, '--dry-run']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const iec = r.stdout.slice(r.stdout.indexOf('apiVersion:'));
        assert.match(iec, /^ {2}name: proj-ft1$/m);
        assert.match(iec, /^ {2}endpointName: "proj-ft1"$/m);
        assert.match(iec, /^ {4}app: proj-ft1$/m);
        assert.ok(!/^ {4}app: proj$/m.test(iec), 'never app=<project>');
        assert.match(iec, /^ {4}mlcc\.aws\/role: "add-pod"$/m);
        assert.match(iec, /^ {4}mlcc\.aws\/project-name: "proj"$/m);
        assert.match(iec, /^ {2}replicas: 1$/m);
        assert.match(iec, /modelLocation: models\/mlcc-proj\/ft1$/m);
        assert.ok(!/kubectl (apply|create|delete)/.test(r.calls), `no cluster write:\n${r.calls}`);
        assert.ok(!existsSync(join(sb.doDir, 'pods/ft1.conf')), 'a dry run records no state');
    });

    it('--instance-group pins the pod with nodeAffinity instead of instanceType', () => {
        const r = run(['ft1', '--from-weights', CANON, '--dry-run', '--instance-group', 'grp-a']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const iec = r.stdout.slice(r.stdout.indexOf('apiVersion:'));
        assert.ok(!/^ {2}instanceType:/m.test(iec));
        assert.match(iec, /values: \["grp-a"\]/);
    });

    it('refuses a name that is not a DNS-1123 label (exit 2)', () => {
        assert.strictEqual(run(['Bad_Name', '--from-weights', CANON, '--dry-run']).code, 2);
    });

    it('--remove deletes exactly the add-pod IEC and its state file', () => {
        sb.write('do/pods/ft1.conf', 'export POD_IEC_NAME="proj-ft1"\nexport POD_STATUS="Running"\n', 0o644);
        const r = run(['--remove', 'ft1']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.calls, /kubectl delete inferenceendpointconfig proj-ft1 -n default/);
        assert.ok(!/delete inferenceendpointconfig proj /.test(r.calls), 'the base IEC is never touched');
        assert.ok(!existsSync(join(sb.doDir, 'pods/ft1.conf')));
    });

    it('do/clean sweeps add-pod IECs and MLCC HyperPodPyTorchJobs by label', () => {
        const clean = readFileSync(join(sb.doDir, 'clean.d/hyperpod-eks'), 'utf8');
        assert.ok(clean.includes('mlcc.aws/project-name=${PROJECT_NAME},mlcc.aws/role=add-pod'));
        assert.match(clean, /kubectl delete inferenceendpointconfig -n "\$\{HP_NAMESPACE\}" -l "\$\{_ap_sel\}"/);
        assert.match(clean, /kubectl delete hyperpodpytorchjob -n "\$\{HP_NAMESPACE\}" -l "\$\{_job_sel\}"/);
        assert.ok(!/-l "?app=\$\{PROJECT_NAME\}/.test(clean), 'never sweeps by app=<project>');
    });

    it('the rendered do/add-pod parses under bash -n', () => {
        assert.strictEqual(runBash('-n', [join(sb.doDir, 'add-pod')], sandboxEnv(sb)).code, 0);
    });
});
