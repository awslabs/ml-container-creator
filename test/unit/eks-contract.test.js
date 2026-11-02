// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vanilla-EKS cluster-contract preflight (templates/do/lib/eks-contract.sh).
 *
 * The lib is a SOURCED helper (ADR-007 pattern, like aws-preflight.sh): it
 * defines _eks_contract_preflight + its per-element functions and does nothing
 * at source time. These tests exercise it the way the deploy driver does — by
 * sourcing it in a bash shell with stubbed `kubectl`/`aws`/`python3` on PATH —
 * plus source-level assertions that do/deploy.d/eks wires the gate (mirroring
 * the bl103/bl111 eks source-assertion tests).
 *
 * consume-don't-provision (ADR-012): the lib is READ-ONLY. A dedicated case
 * asserts the command stubs logged only describe/get/list verbs — never a
 * create/apply/install (and never provisioning a PV/StorageClass).
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');
const LIB = path.join(REPO, 'templates/do/lib/eks-contract.sh');
const DEPLOY_EKS = readFileSync(path.join(REPO, 'templates/do/deploy.d/eks'), 'utf8');

/**
 * Run the contract lib in an isolated sandbox.
 *
 * @param {object} opts
 *   env      — environment for the element (STAGED_MODEL_PATH, EKS_MODEL_MOUNT, …)
 *   stubs    — { kubectl, aws, python3 } → each a bash body for the stub script.
 *              A stub appends its argv to $CMDLOG before producing output.
 *   call     — the function to invoke (default: _eks_contract_preflight)
 * @returns { status, stdout, cmdlog }  — status is the process exit code.
 */
function runContract({ env = {}, stubs = {}, call = '_eks_contract_preflight' } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'eks-contract-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const cmdlog = path.join(dir, 'cmdlog');
    writeFileSync(cmdlog, '');

    // Default stubs: a well-formed, conformant cluster. Individual cases override.
    const defaults = {
        kubectl: 'echo "stub kubectl: unexpected args: $*" >&2; exit 1',
        aws: 'echo "stub aws: unexpected args: $*" >&2; exit 1',
        // Real python3 is available on CI; only stub when a case needs to.
        python3: null
    };
    const effective = { ...defaults, ...stubs };

    for (const [name, body] of Object.entries(effective)) {
        if (body === null) continue;
        const p = path.join(bin, name);
        writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "${cmdlog}"\n${body}\n`);
        chmodSync(p, 0o755);
    }

    const script = `
set -u
source "${LIB}"
${call}
`;
    const runEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CMDLOG: cmdlog,
        // Clear anything that would leak from the host.
        STAGED_MODEL_PATH: '',
        EKS_MODEL_MOUNT: '',
        EKS_INFERENCE_ROLE_ARN: '',
        _PROFILE_eksInferenceRoleArn: '',
        EKS_STORAGE_CLASS: '',
        EKS_CLUSTER_NAME: 'test-eks',
        HP_CLUSTER_NAME: 'test-eks',
        HP_NAMESPACE: 'default',
        AWS_REGION: 'us-east-1',
        ...env
    };

    let status = 0;
    let stdout = '';
    try {
        stdout = execFileSync('bash', ['-c', script], { env: runEnv, encoding: 'utf8', timeout: 10000 });
    } catch (err) {
        status = (err.status === null || err.status === undefined) ? 1 : err.status;
        stdout = (err.stdout || '') + (err.stderr || '');
    }
    const logText = readFileSync(cmdlog, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return { status, stdout, cmdlog: logText };
}

// Absolute path to the real python3, resolved once. The lib uses embedded
// python matchers; when a case needs them AND wants command logging, we stub
// python3 to log then exec the REAL interpreter. The absolute path is essential:
// the sandbox puts its bin/ first on PATH, so `env python3` would re-resolve to
// the stub itself (infinite recursion). Bake the real path in instead.
const REAL_PYTHON3 = (() => {
    // Resolve against the INHERITED PATH (not a login shell): a login shell can
    // prepend /usr/bin, whose python3 on macOS is a developer-tools shim that
    // stalls. The inherited PATH puts the working interpreter (e.g. homebrew)
    // first — the same one these tests otherwise use.
    try {
        return execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
    } catch {
        return 'python3';
    }
})();

// A stub for `python3` that logs the invocation then execs the REAL interpreter
// (by absolute path, bypassing PATH so it cannot re-enter the stub).
function realPython3LoggingStub() {
    return `echo "python3 $*" >> "$CMDLOG"\nexec "${REAL_PYTHON3}" "$@"`;
}

describe('vanilla-EKS cluster-contract preflight', () => {

    // ── Identity element (Req 2) ──────────────────────────────────────────────
    describe('identity element', () => {
        it('HF-source (no STAGED_MODEL_PATH) → skip, exit 0', () => {
            const r = runContract({ call: '_eks_contract_identity' });
            assert.strictEqual(r.status, 0);
            assert.match(r.stdout, /HuggingFace-source deploy, no AWS identity needed/);
        });

        it('S3 + no role → fail (exit 4) naming the eksctl remediation', () => {
            const r = runContract({
                call: '_eks_contract_identity',
                env: { STAGED_MODEL_PATH: 's3://bkt/models/llama/' }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /no EKS inference role is set/);
            assert.match(r.stdout, /eksctl create iamserviceaccount/);
        });

        it('S3 + role + associated IAM OIDC provider (IRSA) → pass', () => {
            const r = runContract({
                call: '_eks_contract_identity',
                env: {
                    STAGED_MODEL_PATH: 's3://bkt/models/llama/',
                    EKS_INFERENCE_ROLE_ARN: 'arn:aws:iam::111122223333:role/mlcc-eks-inf'
                },
                stubs: {
                    aws: `
case "$*" in
  *"describe-cluster"*) echo "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *"list-open-id-connect-providers"*) echo "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *) echo "None" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /IRSA/);
        });

        it('S3 + role + UNassociated OIDC (and no Pod Identity) → fail (exit 4) listing both remediations', () => {
            const r = runContract({
                call: '_eks_contract_identity',
                env: {
                    STAGED_MODEL_PATH: 's3://bkt/models/llama/',
                    EKS_INFERENCE_ROLE_ARN: 'arn:aws:iam::111122223333:role/mlcc-eks-inf'
                },
                stubs: {
                    aws: `
case "$*" in
  *"describe-cluster"*) echo "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *"list-open-id-connect-providers"*) echo "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/DIFFERENT" ;;
  *"list-pod-identity-associations"*) echo "None" ;;
  *) echo "None" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /associate-iam-oidc-provider/);
            assert.match(r.stdout, /create-pod-identity-association/);
        });

        it('S3 + role + EKS Pod Identity association (no IRSA) → pass (OQ-2)', () => {
            const r = runContract({
                call: '_eks_contract_identity',
                env: {
                    STAGED_MODEL_PATH: 's3://bkt/models/llama/',
                    EKS_INFERENCE_ROLE_ARN: 'arn:aws:iam::111122223333:role/mlcc-eks-inf'
                },
                stubs: {
                    aws: `
case "$*" in
  *"describe-cluster"*) echo "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *"list-open-id-connect-providers"*) echo "None" ;;
  *"list-pod-identity-associations"*) echo "a-abc123def456" ;;
  *) echo "None" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /Pod Identity/);
        });
    });

    // ── CSI driver element (Req 3) ────────────────────────────────────────────
    describe('CSI driver element', () => {
        it('EKS_MODEL_MOUNT unset → skip, exit 0', () => {
            const r = runContract({ call: '_eks_contract_storage_csi' });
            assert.strictEqual(r.status, 0);
            assert.strictEqual(r.stdout.trim(), '');
        });

        it('mount=s3 + driver present + matching static PV → pass', () => {
            const r = runContract({
                call: '_eks_contract_storage_csi',
                env: { EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://bkt/models/llama/' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/s3.csi.aws.com" ;;
  *"get pv"*) cat <<'JSON'
{"items":[{"spec":{"csi":{"driver":"s3.csi.aws.com","volumeAttributes":{"bucketName":"bkt"},"mountOptions":["prefix models/llama/"]}}}]}
JSON
    ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /static S3-CSI PV found/);
        });

        it('mount=s3 + driver absent → fail (exit 4) naming the driver', () => {
            const r = runContract({
                call: '_eks_contract_storage_csi',
                env: { EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://bkt/models/llama/' },
                stubs: {
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/ebs.csi.aws.com" ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /s3\.csi\.aws\.com CSI driver is not installed/);
        });

        it('mount=s3 + driver present + PV prefix mismatch → fail (exit 4), pre-create remediation', () => {
            const r = runContract({
                call: '_eks_contract_storage_csi',
                env: { EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://bkt/models/llama/' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/s3.csi.aws.com" ;;
  *"get pv"*) cat <<'JSON'
{"items":[{"spec":{"csi":{"driver":"s3.csi.aws.com","volumeAttributes":{"bucketName":"bkt"},"mountOptions":["prefix other/dataset/"]}}}]}
JSON
    ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /no cluster-provided static S3-CSI PersistentVolume matches/);
            assert.match(r.stdout, /cluster must pre-create the static PV/);
        });

        it('mount=ebs + driver present + StorageClass present → pass', () => {
            const r = runContract({
                call: '_eks_contract_storage_csi',
                env: { EKS_MODEL_MOUNT: 'ebs', EKS_STORAGE_CLASS: 'gp3' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/ebs.csi.aws.com" ;;
  *"get storageclass"*) cat <<'JSON'
{"items":[{"metadata":{"name":"gp3"}}]}
JSON
    ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /StorageClass present: gp3/);
        });

        it('mount=ebs + driver present + named StorageClass absent → fail (exit 4)', () => {
            const r = runContract({
                call: '_eks_contract_storage_csi',
                env: { EKS_MODEL_MOUNT: 'ebs', EKS_STORAGE_CLASS: 'gp3' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/ebs.csi.aws.com" ;;
  *"get storageclass"*) cat <<'JSON'
{"items":[{"metadata":{"name":"gp2"}}]}
JSON
    ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /StorageClass 'gp3' \(EKS_STORAGE_CLASS\) does not exist/);
        });
    });

    // ── Origin-agnostic (Req 1.3) ─────────────────────────────────────────────
    describe('origin-agnostic', () => {
        it('identical pass with and without a "bootstrapped" marker env var', () => {
            const base = {
                call: '_eks_contract_identity',
                env: {
                    STAGED_MODEL_PATH: 's3://bkt/models/llama/',
                    EKS_INFERENCE_ROLE_ARN: 'arn:aws:iam::111122223333:role/mlcc-eks-inf'
                },
                stubs: {
                    aws: `
case "$*" in
  *"describe-cluster"*) echo "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *"list-open-id-connect-providers"*) echo "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *) echo "None" ;;
esac`
                }
            };
            const byo = runContract(base);
            const bootstrapped = runContract({
                ...base,
                env: { ...base.env, _PROFILE_bootstrapModule: 'eks' }
            });
            assert.strictEqual(byo.status, 0, byo.stdout);
            assert.strictEqual(bootstrapped.status, 0, bootstrapped.stdout);
        });
    });

    // ── Read-only (Req 5.3, ADR-012) ──────────────────────────────────────────
    describe('read-only (consume-don\'t-provision)', () => {
        it('the lib issues only describe/get/list — never create/apply/install', () => {
            const r = runContract({
                env: {
                    STAGED_MODEL_PATH: 's3://bkt/models/llama/',
                    EKS_INFERENCE_ROLE_ARN: 'arn:aws:iam::111122223333:role/mlcc-eks-inf',
                    EKS_MODEL_MOUNT: 's3'
                },
                stubs: {
                    python3: realPython3LoggingStub(),
                    aws: `
case "$*" in
  *"describe-cluster"*) echo "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *"list-open-id-connect-providers"*) echo "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC123" ;;
  *) echo "None" ;;
esac`,
                    kubectl: `
case "$*" in
  *"get csidriver"*) echo "csidriver.storage.k8s.io/s3.csi.aws.com" ;;
  *"get pv"*) cat <<'JSON'
{"items":[{"spec":{"csi":{"driver":"s3.csi.aws.com","volumeAttributes":{"bucketName":"bkt"},"mountOptions":["prefix models/llama/"]}}}]}
JSON
    ;;
  *) echo "" ;;
esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            const mutating = /\b(create|apply|install|delete|annotate|patch|replace|put-role-policy|attach-role-policy)\b/;
            for (const line of r.cmdlog.trim().split('\n').filter(Boolean)) {
                assert.ok(!mutating.test(line),
                    `contract lib must not issue a mutating verb; saw: ${line}`);
            }
        });
    });

    // ── Gate wiring in deploy.d/eks (source assertions) ───────────────────────
    describe('gate wiring', () => {
        it('deploy.d/eks sources the contract lib', () => {
            assert.ok(DEPLOY_EKS.includes('source "${SCRIPT_DIR}/lib/eks-contract.sh"'),
                'deploy.d/eks must source lib/eks-contract.sh');
        });

        it('deploy.d/eks calls _eks_contract_preflight AFTER connectivity verify and BEFORE the SA block + apply', () => {
            const gate = DEPLOY_EKS.indexOf('_eks_contract_preflight');
            const connectivity = DEPLOY_EKS.indexOf('Connected to cluster');
            const saBlock = DEPLOY_EKS.indexOf('Ensuring ServiceAccount');
            const apply = DEPLOY_EKS.indexOf('kubectl apply');
            assert.ok(gate > 0, 'gate call must exist');
            assert.ok(connectivity > 0 && gate > connectivity,
                'gate must run AFTER the connectivity verify');
            assert.ok(saBlock > gate, 'gate must run BEFORE the ServiceAccount block');
            assert.ok(apply > gate, 'gate must run BEFORE the manifest apply');
        });

        it('the old conditional-warn IRSA block is removed (no "No EKS inference IRSA role set — but this deploy uses an S3-staged model")', () => {
            assert.ok(!DEPLOY_EKS.includes('but this deploy uses an S3-staged model'),
                'the warn-style identity branch must be gone (moved into the gate)');
        });

        it('deploy.d/eks calls the ephemeral-storage capacity check AFTER HP_GPU_COUNT resolution and BEFORE the manifest render/apply', () => {
            const gpuResolve = DEPLOY_EKS.indexOf('GPU count (auto-detected)');
            const capacity = DEPLOY_EKS.indexOf('_eks_storage_capacity_preflight');
            // The MANIFEST apply is the render loop, marked by the renderer invocation
            // (not the earlier ServiceAccount `kubectl apply`).
            const manifestRender = DEPLOY_EKS.indexOf('Rendering Kubernetes manifests');
            assert.ok(capacity > 0, 'capacity check must be wired');
            assert.ok(capacity > gpuResolve, 'capacity check must run AFTER HP_GPU_COUNT resolution');
            assert.ok(manifestRender > capacity, 'capacity check must run BEFORE the manifest render/apply');
        });
    });

    // ── Ephemeral-storage capacity fail-fast (emptyDir path, OQ-3) ──────────────
    describe('ephemeral-storage capacity (emptyDir path)', () => {
        const nodesJson = (gib) =>
            `{"items":[{"status":{"allocatable":{"ephemeral-storage":"${gib}Gi","nvidia.com/gpu":"8"}}}]}`;

        it('emptyDir + largest GPU node too small → fail (exit 4) with remediations', () => {
            const r = runContract({
                call: '_eks_storage_capacity_preflight',
                env: { HP_GPU_COUNT: '8' }, // footprint 160Gi
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `case "$*" in *"get nodes"*) echo '${nodesJson(89)}' ;; *) echo "" ;; esac`
                }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /no GPU node can fit the model/);
            assert.match(r.stdout, /EKS_MODEL_MOUNT=/);
        });

        it('emptyDir + a GPU node large enough → pass', () => {
            const r = runContract({
                call: '_eks_storage_capacity_preflight',
                env: { HP_GPU_COUNT: '8' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: `case "$*" in *"get nodes"*) echo '${nodesJson(500)}' ;; *) echo "" ;; esac`
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /fits the model footprint/);
        });

        it('indeterminate node list → warn + proceed (fail-open, OQ-3)', () => {
            const r = runContract({
                call: '_eks_storage_capacity_preflight',
                env: { HP_GPU_COUNT: '8' },
                stubs: {
                    python3: realPython3LoggingStub(),
                    kubectl: 'case "$*" in *"get nodes"*) echo \'{"items":[]}\' ;; *) echo "" ;; esac'
                }
            });
            assert.strictEqual(r.status, 0, r.stdout);
            assert.match(r.stdout, /Could not determine GPU-node ephemeral-storage/);
        });

        it('hostPath path → skip (no node query)', () => {
            const r = runContract({
                call: '_eks_storage_capacity_preflight',
                env: { HP_GPU_COUNT: '8', HP_MODEL_HOSTPATH: '/opt/dlami/nvme' }
            });
            assert.strictEqual(r.status, 0);
            assert.strictEqual(r.stdout.trim(), '');
        });

        it('CSI-mount path → skip (no node query)', () => {
            const r = runContract({
                call: '_eks_storage_capacity_preflight',
                env: { HP_GPU_COUNT: '8', EKS_MODEL_MOUNT: 'ebs' }
            });
            assert.strictEqual(r.status, 0);
            assert.strictEqual(r.stdout.trim(), '');
        });
    });

    // ── Mount-mode guards (wrapper-engine-only) ───────────────────────────────
    describe('mount-mode guards', () => {
        it('EKS_MODEL_MOUNT=s3 without a staged model → fail (exit 4), do/stage guidance', () => {
            const r = runContract({
                call: '_eks_mount_guards',
                env: { EKS_MODEL_MOUNT: 's3', MODEL_SERVER: 'vllm' }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /requires a staged model/);
            assert.match(r.stdout, /do\/stage/);
        });

        it('EKS_MODEL_MOUNT=s3 with a staged model + wrapper engine → pass', () => {
            const r = runContract({
                call: '_eks_mount_guards',
                env: { EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://b/p/', MODEL_SERVER: 'sglang' }
            });
            assert.strictEqual(r.status, 0, r.stdout);
        });

        it('EKS_MODEL_MOUNT + a Model-B engine (lmi) → fail (exit 4), wrapper-only guidance', () => {
            const r = runContract({
                call: '_eks_mount_guards',
                env: { EKS_MODEL_MOUNT: 'ebs', MODEL_SERVER: 'lmi' }
            });
            assert.strictEqual(r.status, 4);
            assert.match(r.stdout, /supported only for the wrapper engines/);
        });

        it('EKS_MODEL_MOUNT unset → skip (exit 0)', () => {
            const r = runContract({ call: '_eks_mount_guards', env: { MODEL_SERVER: 'lmi' } });
            assert.strictEqual(r.status, 0);
            assert.strictEqual(r.stdout.trim(), '');
        });
    });
});
