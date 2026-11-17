// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * CDK assertion checks for the eks module's S3 CSI fixes (Wave 6.1 R5).
 * Synthesizes the eks-cluster stack in-process with aws-cdk-lib/assertions — no AWS
 * calls, no cdk CLI. Driven by test/unit/bootstrap-eks-s3csi-cdk.test.js, which
 * passes the bucket names rendered by bucket-declarations.cjs in MLCC_EXPECTED_NAMES
 * (JSON: { core, training, adapters, tls }), so the TS stack and the CJS renderer
 * are proven to agree.
 *
 *   R5.1  AWS::EKS::Addon aws-mountpoint-s3-csi-driver has ServiceAccountRoleArn =
 *         the S3CsiRole ARN; its addonVersion is unchanged (v1→v2 is a later change).
 *   R5.2  S3CsiRole's policy grants s3:GetObject / s3:ListBucket / s3:GetBucketLocation
 *         on the core models bucket and the training + adapters buckets, and its TLS
 *         statement names MLCC's real TLS bucket (no 'hyperpod-tls-*' pattern left).
 *   R5.3  (in-place) the add-on keeps its logical ID and no replacement-forcing
 *         property (AddonName / ClusterName) changes; the role keeps its name.
 * Prints a JSON summary on success; throws (non-zero exit) on any failure.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MlccEksClusterStack } from '../eks/stacks/eks-cluster-stack';

const ACCOUNT = '111111111111';
const REGION = 'us-west-2';
const PROFILE = 'zz-test';
const names: Record<string, string> = JSON.parse(process.env.MLCC_EXPECTED_NAMES || '{}');

function fail(msg: string): never {
    throw new Error(msg);
}
function need(key: string): string {
    return names[key] || fail(`MLCC_EXPECTED_NAMES has no '${key}'`);
}

type Res = { Type: string; Properties?: Record<string, any> };

const app = new cdk.App();
const stack = new MlccEksClusterStack(app, `mlcc-${PROFILE}-eks-cluster`, {
    env: { account: ACCOUNT, region: REGION }, profileName: PROFILE,
});
const t = Template.fromStack(stack);
const resources = t.toJSON().Resources as Record<string, Res>;

// ── R5.1 add-on ↔ role attachment ─────────────────────────────────────────────
const addons = Object.entries(resources).filter(([, r]) =>
    r.Type === 'AWS::EKS::Addon' && (r.Properties || {}).AddonName === 'aws-mountpoint-s3-csi-driver');
if (addons.length !== 1) fail(`expected exactly one S3 CSI add-on, found ${addons.length}`);
const [addonId, addon] = addons[0];
if (!addonId.startsWith('S3CsiDriverAddon')) fail(`S3 CSI add-on logical ID changed: ${addonId}`);
if ((addon.Properties || {}).AddonVersion !== 'v1.14.1-eksbuild.1') {
    fail(`S3 CSI add-on version changed: ${(addon.Properties || {}).AddonVersion} (the v1→v2 bump is out of scope)`);
}
const saRole = (addon.Properties || {}).ServiceAccountRoleArn;
const roles = Object.entries(resources).filter(([, r]) =>
    r.Type === 'AWS::IAM::Role' && (r.Properties || {}).RoleName === `mlcc-${PROFILE}-s3-csi-role`);
if (roles.length !== 1) fail(`expected one S3CsiRole, found ${roles.length}`);
const [roleId] = roles[0];
if (!saRole || JSON.stringify(saRole) !== JSON.stringify({ 'Fn::GetAtt': [roleId, 'Arn'] })) {
    fail(`S3 CSI add-on ServiceAccountRoleArn must be the S3CsiRole ARN, got ${JSON.stringify(saRole)}`);
}

// ── R5.2 policy grants ────────────────────────────────────────────────────────
const policies = Object.values(resources).filter(r =>
    r.Type === 'AWS::IAM::Policy'
    && ((r.Properties || {}).Roles || []).some((x: unknown) => JSON.stringify(x) === JSON.stringify({ Ref: roleId })));
const statements = policies.flatMap(p => ((p.Properties || {}).PolicyDocument || {}).Statement || []);
const resourcesOf = (s: any): string[] => ([] as unknown[]).concat(s.Resource || []).map(x => String(x));
const actionsOf = (s: any): string[] => ([] as unknown[]).concat(s.Action || []).map(x => String(x));
const readActions = ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'];
for (const key of ['core', 'training', 'adapters']) {
    const bucket = need(key);
    for (const arn of [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`]) {
        const st = statements.find(s => resourcesOf(s).includes(arn));
        if (!st) fail(`S3CsiRole has no statement on ${arn}`);
        for (const a of readActions) {
            if (!actionsOf(st).includes(a)) fail(`S3CsiRole lacks ${a} on ${arn}`);
        }
    }
}
const tls = need('tls');
const tlsStmt = statements.find(s => resourcesOf(s).includes(`arn:aws:s3:::${tls}/*`));
if (!tlsStmt) fail(`S3CsiRole has no statement on the MLCC TLS bucket ${tls}`);
const stalePattern = statements.flatMap(resourcesOf).filter(r => r.includes(':::hyperpod-tls-*'));
if (stalePattern.length) fail(`S3CsiRole still uses the non-matching pattern: ${stalePattern.join(', ')}`);

console.log(JSON.stringify({
    ok: true,
    addonLogicalId: addonId,
    roleLogicalId: roleId,
    serviceAccountRoleArn: saRole,
    grantedBuckets: ['core', 'training', 'adapters', 'tls'].map(need),
}));
