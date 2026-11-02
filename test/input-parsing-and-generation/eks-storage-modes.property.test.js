// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vanilla-EKS large-model storage modes (render side).
 *
 * The plain-EKS Deployment supports two large-model storage modes alongside the shipped
 * emptyDir (default) and hostPath-NVMe modes: a PVC mount (EBS/FSx CSI,
 * download-to-a-bigger-disk) and an S3-CSI read-only stream — both selected by
 * EKS_MODEL_MOUNT and backed by a NAMESPACED PersistentVolumeClaim
 * (ModelPvc.yaml.ejs). consume-don't-provision (ADR-012): MLCC emits ONLY the
 * PVC; the PV (s3 static) / StorageClass (ebs|fsx) is cluster-provided and
 * validated by the cluster-contract preflight.
 *
 * These tests render Deployment.yaml.ejs + ModelPvc.yaml.ejs via the SHIPPED
 * renderer (the same do/deploy.d/eks invokes), then resolve ${VAR} placeholders
 * with the driver's envsubst shim. kubectl is never invoked. Mirrors the existing
 * eks render-assertion test pattern.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');
const RENDERER = path.join(REPO, 'templates/do/lib/render-eks-manifests.cjs');
const EKS_TPL_DIR = path.join(REPO, 'templates/eks');
const DEPLOY_EKS = readFileSync(path.join(REPO, 'templates/do/deploy.d/eks'), 'utf8');

/** The driver's envsubst shim, re-implemented identically. */
function envsubst(text, env) {
    return text
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_m, k, def) =>
            (env[k] !== undefined && env[k] !== '') ? env[k] : def)
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) =>
            env[k] !== undefined ? env[k] : `\${${k}}`);
}

/** Render one eks template via the shipped renderer, then envsubst. */
function render(name, env) {
    const full = {
        PROJECT_NAME: 'demo', FRAMEWORK: 'transformers', HP_NAMESPACE: 'ml-inference',
        HP_REPLICAS: '1', MODEL_NAME: 'meta-llama/Llama-3.1-70B', MODEL_SERVER: 'vllm',
        HP_GPU_COUNT: '8', ...env
    };
    // Start from a CLEAN env so a stray HP_MODEL_HOSTPATH / EKS_MODEL_MOUNT /
    // HP_EPHEMERAL_STORAGE in the test runner's environment cannot leak into a
    // mode under test (each mode must be hermetic). Then overlay `full`.
    const runEnv = { ...process.env, ...full };
    for (const k of ['HP_MODEL_HOSTPATH', 'EKS_MODEL_MOUNT', 'STAGED_MODEL_PATH',
        'EKS_STORAGE_CLASS', 'EKS_MODEL_PV_NAME', 'HP_EPHEMERAL_STORAGE']) {
        if (!(k in full)) delete runEnv[k];
    }
    const out = execFileSync('node', [RENDERER, path.join(EKS_TPL_DIR, `${name}.yaml.ejs`)],
        { env: runEnv, encoding: 'utf8' });
    return envsubst(out, runEnv);
}

/** The deploy-env for a storage mode. */
function modeEnv(mode) {
    switch (mode) {
    case 'emptyDir': return {};
    case 'hostPath': return { HP_MODEL_HOSTPATH: '/opt/dlami/nvme' };
    case 's3': return { EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://bkt/models/llama/' };
    case 'ebs': return { EKS_MODEL_MOUNT: 'ebs', EKS_STORAGE_CLASS: 'gp3' };
    case 'fsx': return { EKS_MODEL_MOUNT: 'fsx', EKS_STORAGE_CLASS: 'fsx-sc' };
    default: throw new Error(`unknown mode ${mode}`);
    }
}

const MODES = ['emptyDir', 'hostPath', 's3', 'ebs', 'fsx'];

function modelStoreVolume(deploymentYaml) {
    const doc = yaml.load(deploymentYaml);
    const vols = doc.spec.template.spec.volumes;
    return vols.find((v) => v.name === 'model-store');
}

describe('vanilla-EKS storage modes (render)', () => {

    describe('one storage mode by precedence', () => {
        it('each mode emits EXACTLY ONE model-store volume of the expected kind', () => {
            for (const mode of MODES) {
                const v = modelStoreVolume(render('Deployment', modeEnv(mode)));
                assert.ok(v, `${mode}: a model-store volume must exist`);
                const keys = Object.keys(v).filter((k) => k !== 'name');
                assert.strictEqual(keys.length, 1, `${mode}: exactly one volume source, got ${keys}`);
                const expected = {
                    emptyDir: 'emptyDir', hostPath: 'hostPath',
                    s3: 'persistentVolumeClaim', ebs: 'persistentVolumeClaim', fsx: 'persistentVolumeClaim'
                }[mode];
                assert.strictEqual(keys[0], expected, `${mode}: expected ${expected}`);
            }
        });

        it('precedence: hostPath wins over a mount wins over emptyDir', () => {
            // hostPath + mount both set → hostPath wins.
            const v1 = modelStoreVolume(render('Deployment',
                { HP_MODEL_HOSTPATH: '/opt/dlami/nvme', EKS_MODEL_MOUNT: 's3', STAGED_MODEL_PATH: 's3://b/p/' }));
            assert.ok(v1.hostPath, 'hostPath must win over a mount');
            // mount only → PVC (wins over the default emptyDir).
            const v2 = modelStoreVolume(render('Deployment', { EKS_MODEL_MOUNT: 'ebs' }));
            assert.ok(v2.persistentVolumeClaim, 'a mount must win over emptyDir');
        });

        it('the Deployment references the namespaced PVC claim by <project>-model-store', () => {
            for (const mode of ['s3', 'ebs', 'fsx']) {
                const v = modelStoreVolume(render('Deployment', modeEnv(mode)));
                assert.strictEqual(v.persistentVolumeClaim.claimName, 'demo-model-store');
            }
        });
    });

    describe('ephemeral-storage only on emptyDir', () => {
        it('ephemeral-storage request/limit present IFF emptyDir', () => {
            for (const mode of MODES) {
                const doc = yaml.load(render('Deployment', modeEnv(mode)));
                const req = doc.spec.template.spec.containers[0].resources.requests;
                const lim = doc.spec.template.spec.containers[0].resources.limits;
                const expected = mode === 'emptyDir';
                assert.strictEqual('ephemeral-storage' in req, expected,
                    `${mode}: ephemeral-storage request presence`);
                assert.strictEqual('ephemeral-storage' in lim, expected,
                    `${mode}: ephemeral-storage limit presence`);
            }
        });
    });

    describe('dshm preserved across all modes', () => {
        it('every mode keeps the RAM-backed /dev/shm (dshm) mount', () => {
            for (const mode of MODES) {
                const doc = yaml.load(render('Deployment', modeEnv(mode)));
                const spec = doc.spec.template.spec;
                const dshm = spec.volumes.find((v) => v.name === 'dshm');
                assert.ok(dshm && dshm.emptyDir && dshm.emptyDir.medium === 'Memory',
                    `${mode}: dshm RAM volume must be preserved`);
                const mount = spec.containers[0].volumeMounts.find((m) => m.mountPath === '/dev/shm');
                assert.ok(mount && mount.name === 'dshm', `${mode}: /dev/shm mount preserved`);
            }
        });
    });

    describe('PVC emission (OQ-2 — PVC only, never PV/StorageClass)', () => {
        it('EKS_MODEL_MOUNT unset → ModelPvc renders nothing (no kind)', () => {
            const out = render('ModelPvc', {});
            assert.ok(!/^kind:/m.test(out), 'no PVC on the emptyDir/hostPath path');
            assert.ok(!/kind:\s*PersistentVolumeClaim/.test(out));
        });

        it('each mount mode emits a NAMESPACED PVC and NEVER a PV or StorageClass object', () => {
            for (const mode of ['s3', 'ebs', 'fsx']) {
                const out = render('ModelPvc', modeEnv(mode));
                const doc = yaml.load(out);
                assert.strictEqual(doc.kind, 'PersistentVolumeClaim', `${mode}: must be a PVC`);
                assert.strictEqual(doc.metadata.namespace, 'ml-inference', `${mode}: PVC is namespaced`);
                assert.strictEqual(doc.metadata.name, 'demo-model-store');
                // MLCC must NEVER emit cluster-scoped PV / StorageClass (ADR-012).
                assert.ok(!/kind:\s*PersistentVolume\b/.test(out), `${mode}: must not emit a PersistentVolume`);
                assert.ok(!/kind:\s*StorageClass\b/.test(out), `${mode}: must not emit a StorageClass`);
            }
        });

        it('s3 PVC is ReadOnlyMany binding a cluster-provided PV (empty storageClassName)', () => {
            const doc = yaml.load(render('ModelPvc', modeEnv('s3')));
            assert.deepStrictEqual(doc.spec.accessModes, ['ReadOnlyMany']);
            assert.strictEqual(doc.spec.storageClassName, '',
                's3 binds a static PV via an empty storageClassName (no dynamic provisioning)');
        });

        it('ebs/fsx PVC is ReadWriteOnce referencing the cluster StorageClass', () => {
            const ebs = yaml.load(render('ModelPvc', modeEnv('ebs')));
            assert.deepStrictEqual(ebs.spec.accessModes, ['ReadWriteOnce']);
            assert.strictEqual(ebs.spec.storageClassName, 'gp3');
            const fsx = yaml.load(render('ModelPvc', modeEnv('fsx')));
            assert.strictEqual(fsx.spec.storageClassName, 'fsx-sc');
        });

        it('s3 PVC can bind a named PV via EKS_MODEL_PV_NAME (volumeName)', () => {
            const doc = yaml.load(render('ModelPvc',
                { ...modeEnv('s3'), EKS_MODEL_PV_NAME: 'mlcc-llama-pv' }));
            assert.strictEqual(doc.spec.volumeName, 'mlcc-llama-pv');
        });
    });

    describe('download-path invariants (Req 2.3 / 3.3)', () => {
        it('all modes still mount the model at the BYOC path /opt/ml/model', () => {
            for (const mode of MODES) {
                const doc = yaml.load(render('Deployment', modeEnv(mode)));
                const mount = doc.spec.template.spec.containers[0].volumeMounts
                    .find((m) => m.name === 'model-store');
                assert.strictEqual(mount.mountPath, '/opt/ml/model', `${mode}: model-store mounts at /opt/ml/model`);
            }
        });

        it('the driver sets MODEL_SOURCE from STAGED_MODEL_PATH (s3 stream relies on pre-mounted detection)', () => {
            // code/serve's wrapper-engine pre-mounted detection (/opt/ml/model
            // non-empty → skip download) is what makes the s3 stream a no-download
            // path; the driver still resolves MODEL_SOURCE=s3 for a staged model.
            assert.ok(/HP_MODEL_SOURCE="s3"/.test(DEPLOY_EKS),
                'driver resolves MODEL_SOURCE=s3 for a staged model');
        });
    });

    describe('no-regression (emptyDir + hostPath unchanged)', () => {
        it('emptyDir still requests ephemeral-storage and uses a bounded emptyDir', () => {
            const doc = yaml.load(render('Deployment', modeEnv('emptyDir')));
            const spec = doc.spec.template.spec;
            assert.ok(spec.volumes.find((v) => v.name === 'model-store').emptyDir);
            assert.ok(spec.containers[0].resources.requests['ephemeral-storage']);
        });
        it('hostPath still mounts the NVMe base/<project> and requests NO ephemeral-storage', () => {
            const doc = yaml.load(render('Deployment', modeEnv('hostPath')));
            const spec = doc.spec.template.spec;
            assert.strictEqual(spec.volumes.find((v) => v.name === 'model-store').hostPath.path,
                '/opt/dlami/nvme/demo');
            assert.ok(!spec.containers[0].resources.requests['ephemeral-storage']);
        });
    });
});
