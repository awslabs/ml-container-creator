// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6.1 — do/deploy.d/hyperpod-eks, executed end-to-end in a sandbox with
 * stubbed `aws` / `kubectl` (no live AWS). Covers:
 *
 *   R1.2  prefetchEnabled: false ONLY for LoRA + S3 source; non-LoRA and
 *         Hugging Face-sourced deployments keep prefetch on.
 *   R2.3  VLLM_MAX_LORA_RANK is derived (TUNE_LORA_RANK_* / recorded adapters),
 *         never the old MLCC_LORA_DEFAULTS literal.
 *   R4    rollout capacity: an unchanged IEC skips the rollout logic; a changed
 *         template that cannot schedule stops BEFORE applying (no flag) and prints
 *         the exact command + cost note; --surge-node raises the instance group
 *         by one (copying its fields), applies, waits, and restores the count by
 *         removing the VACATED node (never the serving one), also on failure.
 *         Never scales to zero.
 *   R6    the read-only contract preflight reports and never blocks.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runBash, sandboxEnv, REPO } from '../helpers/additive-sandbox.js';

const VARS = {
    projectName: 'proj', framework: 'transformers', modelName: 'org/model', modelServer: 'vllm',
    hyperPodNamespace: 'default', hyperPodReplicas: 1, instanceType: 'ml.g7.12xlarge',
    awsRegion: 'us-west-2', includeBenchmark: false, fsxVolumeHandle: ''
};
const render = (rel) => {
    const src = join(REPO, 'templates', rel);
    return ejs.render(readFileSync(src, 'utf8'), VARS, { filename: src });
};

// aws stub: a stateful HyperPod cluster with instance group "g7" (count in
// $STATE/count). Every mutating call is logged to $STATE/aws.log.
const AWS_STUB = `#!/bin/bash
S="\${STUB_STATE}"
echo "$*" >> "$S/aws.log"
count=$(cat "$S/count" 2>/dev/null || echo 1)
case "$1 $2" in
  "ecr describe-images") exit 0 ;;
  "eks update-kubeconfig") exit 0 ;;
  "eks describe-addon") echo "arn:aws:iam::1:role/csi" ;;
  "iam simulate-principal-policy")
    echo '{"EvaluationResults":[{"EvalActionName":"s3:GetObject","EvalResourceName":"arn:aws:s3:::core/*","EvalDecision":"allowed"},{"EvalActionName":"s3:ListBucket","EvalResourceName":"arn:aws:s3:::core","EvalDecision":"allowed"}]}' ;;
  "sagemaker describe-endpoint") echo "InService" ;;
  "sagemaker describe-cluster")
    case "$*" in
      *Orchestrator*) echo "arn:aws:eks:us-west-2:1:cluster/hp-eks" ;;
      *InferenceConfig*) echo "{}" ;;
      *)
        fail=""
        [ -f "$S/fail_capacity" ] && fail=',"FailureMessage":"InsufficientCapacity: We currently do not have sufficient ml.g7.12xlarge capacity"'
        cur=$count; [ -f "$S/fail_capacity" ] && cur=1
        echo "{\\"InstanceGroups\\":[{\\"InstanceGroupName\\":\\"g7\\",\\"InstanceType\\":\\"ml.g7.12xlarge\\",\\"CurrentCount\\":$cur,\\"TargetCount\\":$count,\\"ExecutionRole\\":\\"arn:aws:iam::1:role/x\\",\\"LifeCycleConfig\\":{\\"SourceS3Uri\\":\\"s3://lc\\",\\"OnCreate\\":\\"on_create.sh\\"},\\"ThreadsPerCore\\":1,\\"Status\\":\\"InService\\",\\"CurrentImageId\\":\\"default\\",\\"DesiredImageId\\":\\"default\\"$fail}]}" ;;
    esac ;;
  "sagemaker update-cluster")
    n=$(printf '%s' "$*" | python3 -c 'import sys,re; m=re.search(r"\\"InstanceCount\\": (\\d+)", sys.stdin.read()); print(m.group(1) if m else "")')
    echo "$n" > "$S/count"; echo '{"ClusterArn":"arn"}' ;;
  "sagemaker batch-delete-cluster-nodes")
    echo $((count - 1)) > "$S/count"; echo '{"Successful":["i-aaaa1111"]}' ;;
  *) exit 1 ;;
esac
`;

// kubectl stub: node A (hyperpod-i-aaaa1111) hosts the serving pod until the
// manifest is applied; after apply (with 2 nodes) the new pod runs on node B.
const KUBECTL_STUB = `#!/bin/bash
S="\${STUB_STATE}"
echo "$*" >> "$S/kubectl.log"
count=$(cat "$S/count" 2>/dev/null || echo 1)
[ -f "$S/fail_capacity" ] && count=1
node_json() { echo "{\\"metadata\\":{\\"name\\":\\"$1\\",\\"labels\\":{\\"sagemaker.amazonaws.com/instance-group-name\\":\\"g7\\",\\"node.kubernetes.io/instance-type\\":\\"ml.g7.12xlarge\\"}},\\"spec\\":{\\"providerID\\":\\"aws:///usw2-az1/sagemaker/cluster/hyperpod-x-$2\\"},\\"status\\":{\\"allocatable\\":{\\"nvidia.com/gpu\\":\\"2\\"},\\"conditions\\":[{\\"type\\":\\"Ready\\",\\"status\\":\\"True\\"}]}}"; }
pod_on() { echo "{\\"metadata\\":{\\"name\\":\\"proj-x\\",\\"namespace\\":\\"default\\",\\"labels\\":{\\"app\\":\\"proj\\"}},\\"spec\\":{\\"nodeName\\":\\"$1\\",\\"containers\\":[{\\"resources\\":{\\"requests\\":{\\"nvidia.com/gpu\\":\\"2\\"}}}]},\\"status\\":{\\"phase\\":\\"Running\\",\\"conditions\\":[{\\"type\\":\\"Ready\\",\\"status\\":\\"True\\"}]}}"; }
serving_node="hyperpod-i-aaaa1111"
[ -f "$S/applied" ] && [ "$count" -ge 2 ] && serving_node="hyperpod-i-bbbb2222"
case "$1" in
  cluster-info) exit 0 ;;
  create) echo "apiVersion: v1" ;;
  apply)
    if [ "$2" = "-n" ]; then touch "$S/applied"; cat "$5" >> "$S/applied.yaml" 2>/dev/null; fi
    echo "applied" ;;
  diff) exit "\${STUB_DIFF_RC:-1}" ;;
  get)
    case "$2" in
      inferenceendpointconfig)
        case "$*" in
          *status.state*) echo "DeploymentComplete" ;;
          *status.endpoints*) echo "" ;;
          *) [ "\${STUB_IEC_LIVE:-true}" = "true" ] && echo "proj" || exit 1 ;;
        esac ;;
      nodes)
        if [ "$count" -ge 2 ]; then
          echo "{\\"items\\":[$(node_json hyperpod-i-aaaa1111 i-aaaa1111),$(node_json hyperpod-i-bbbb2222 i-bbbb2222)]}"
        else
          echo "{\\"items\\":[$(node_json hyperpod-i-aaaa1111 i-aaaa1111)]}"
        fi ;;
      pods|pod) echo "{\\"items\\":[$(pod_on $serving_node)]}" ;;
      csidriver) echo "csidriver.storage.k8s.io/s3.csi.aws.com" ;;
      sa) echo '{"metadata":{"annotations":{}}}' ;;
      secret) exit 1 ;;
      *) exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

function baseConfig(extra = []) {
    return [
        'export PROJECT_NAME="proj"', 'export DEPLOYMENT_CONFIG="transformers-vllm"', 'export BUILD_TARGET="codebuild"',
        'export DEPLOYMENT_TARGET="hyperpod-eks"', 'export HP_CLUSTER_NAME="hp"', 'export HP_NAMESPACE="default"',
        'export HP_REPLICAS="1"', 'export AWS_REGION="us-west-2"', 'export AWS_ACCOUNT_ID="111122223333"',
        'export MODEL_NAME="org/model"', 'export MODEL_SERVER="vllm"', 'export HP_INSTANCE_TYPE="ml.g7.12xlarge"',
        ...extra, ''
    ].join('\n');
}

describe('Wave 6.1 — hyperpod-eks deploy: prefetch, derived rank, rollout capacity + --surge-node (stubbed)', function () {
    this.timeout(180000);
    let sb;
    before(() => {
        sb = makeSandbox({ pyHelpers: true });
        sb.write('do/deploy.d/hyperpod-eks', render('do/deploy.d/hyperpod-eks'));
        sb.write('hyperpod/InferenceEndpointConfig.yaml', render('hyperpod/InferenceEndpointConfig.yaml.ejs'), 0o644);
        sb.write('do/lib/aws-preflight.sh', '_aws_preflight() { :; }\n', 0o644);
        sb.write('do/manifest', '#!/bin/bash\nexit 0\n');
        sb.write('bin/aws', AWS_STUB);
        sb.write('bin/kubectl', KUBECTL_STUB);
        // Sourced by do/deploy in real life: define _update_config + source the driver.
        sb.write('do/_run_deploy', [
            '#!/bin/bash',
            'set -e',
            'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            'source "${SCRIPT_DIR}/config"',
            '_update_config() { echo "CONFIG $1=$2" >> "${STUB_STATE}/config.log"; }',
            'cd "${SCRIPT_DIR}/.."',
            'source "${SCRIPT_DIR}/deploy.d/hyperpod-eks" "$@"',
            ''
        ].join('\n'));
    });
    after(() => sb.cleanup());

    let n = 0;
    const run = (args, { config = [], env = {}, failCapacity = false } = {}) => {
        n += 1;
        const state = join(sb.root, `state${n}`);
        sb.write(`state${n}/count`, '1\n', 0o644);
        if (failCapacity) sb.write(`state${n}/fail_capacity`, '1\n', 0o644);
        sb.write('do/config', baseConfig(config), 0o644);
        const r = runBash(join(sb.doDir, '_run_deploy'), args,
            sandboxEnv(sb, { HOME: sb.root, STUB_STATE: state, HP_ENDPOINT_POLL_WINDOW: '1', ...env }), { timeout: 60000 });
        const read = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), 'utf8') : '');
        return { ...r, aws: read('aws.log'), kubectl: read('kubectl.log'), applied: read('applied.yaml'), count: read('count').trim() };
    };
    const S3 = 'export STAGED_MODEL_PATH="s3://core/models/m/"';

    describe('R1.2 — prefetchEnabled', () => {
        it('LoRA + S3 source → prefetchEnabled: false (and the cold-start note)', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.applied, /prefetchEnabled: false/);
            assert.match(r.stdout, /Cold start is slower without prefetch/);
        });
        it('non-LoRA + S3 source → prefetch stays on', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="false"', S3], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.applied, /prefetchEnabled: true/);
            assert.doesNotMatch(r.applied, /prefetchEnabled: false/);
        });
        it('LoRA + Hugging Face source → prefetch stays on', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"'], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.applied, /modelSourceType: huggingface/);
            assert.match(r.applied, /prefetchEnabled: true/);
        });
    });

    describe('R2.3 — derived max_lora_rank', () => {
        it('a recorded technique rank (TUNE_LORA_RANK_DPO=64) raises VLLM_MAX_LORA_RANK to 64', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3, 'export TUNE_LORA_RANK_DPO="64"'],
                env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.applied, /- name: VLLM_MAX_LORA_RANK\s+value: "64"/);
            assert.match(r.applied, /- name: VLLM_MAX_LORAS\s+value: "4"/);
        });
        it('an explicit VLLM_MAX_LORA_RANK wins, with a warning when below need', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3, 'export TUNE_LORA_RANK_DPO="64"',
                'export VLLM_MAX_LORA_RANK="32"'], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.applied, /- name: VLLM_MAX_LORA_RANK\s+value: "32"/);
            assert.match(r.stderr, /explicit VLLM_MAX_LORA_RANK=32 is below what recorded adapters need/);
        });
    });

    describe('R6 — contract preflight (read-only, never blocks)', () => {
        it('reports the CSI driver, S3 source and CSI-role access', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /contract preflight \(read-only\)/);
            assert.match(r.stdout, /s3\.csi\.aws\.com CSI driver is installed/);
            assert.match(r.stdout, /S3 CSI role can read s3:\/\/core/);
            assert.match(r.aws, /iam simulate-principal-policy/);
        });
        it('LoRA on an HF source is reported as a warning, not a block', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"'], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /do\/adapter can only deliver/);
        });
    });

    describe('R4 — rollout capacity', () => {
        it('rendered == live IEC: no rollout logic, no capacity probe, applies as usual', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '0' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /No change to the InferenceEndpointConfig/);
            assert.doesNotMatch(r.kubectl, /get nodes/);
            assert.doesNotMatch(r.aws, /update-cluster/);
        });
        it('changed template, single node, no spare GPUs, no flag → stops BEFORE applying with the exact command + cost note', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '1' } });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /rollout cannot schedule/);
            assert.match(r.stdout, /\.\/do\/deploy --target hyperpod-eks --force --surge-node/);
            assert.match(r.stdout, /Cost\/time note/);
            assert.match(r.stdout, /never scales the\s+deployment to zero/);
            assert.strictEqual(r.applied, '', 'nothing may be applied');
            assert.doesNotMatch(r.aws, /update-cluster|batch-delete/);
            assert.doesNotMatch(r.stdout + r.kubectl, /replicas.?0|scale --replicas|delete pod/);
        });
        it('--surge-node: +1 (fields copied), apply, wait, restore by removing the VACATED node', () => {
            const r = run(['--surge-node'], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '1' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            const up = r.aws.split('\n').find((l) => l.includes('update-cluster')) || '';
            assert.match(up, /"InstanceCount": 2/, 'raises the group by exactly one');
            assert.match(up, /"ExecutionRole": "arn:aws:iam::1:role\/x"/, 'copies the group fields');
            assert.match(up, /"LifeCycleConfig"/);
            assert.match(r.applied, /kind: InferenceEndpointConfig/);
            // The old pod's node (A) is removed; the new serving node (B) is kept.
            const del = r.aws.split('\n').find((l) => l.includes('batch-delete-cluster-nodes')) || '';
            assert.match(del, /i-aaaa1111/);
            assert.doesNotMatch(del, /i-bbbb2222/);
            assert.strictEqual(r.count, '1', 'the original count is restored');
            assert.match(r.stdout, /restored to 1 instance/);
            assert.doesNotMatch(r.aws, /"InstanceCount": 0/);
        });
        it('--surge-node + InsufficientCapacity: reported verbatim, nothing applied, count restored', () => {
            const r = run(['--surge-node'], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_DIFF_RC: '1' },
                failCapacity: true });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout + r.stderr, /InsufficientCapacity: We currently do not have sufficient ml\.g7\.12xlarge capacity/);
            assert.strictEqual(r.applied, '', 'nothing may be applied');
            const updates = r.aws.split('\n').filter((l) => l.includes('update-cluster'));
            assert.strictEqual(updates.length, 2, 'raise, then restore');
            assert.match(updates[1], /"InstanceCount": 1/, 'restores the target to the original count');
            assert.strictEqual(r.count, '1');
            assert.doesNotMatch(r.aws, /"InstanceCount": 0/);
        });
        it('first deploy (no live IEC): no capacity logic', () => {
            const r = run([], { config: ['export HP_LORA_ENABLED="true"', S3], env: { STUB_IEC_LIVE: 'false' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.doesNotMatch(r.kubectl, /^diff/m);
            assert.match(r.applied, /kind: InferenceEndpointConfig/);
        });
    });
});
