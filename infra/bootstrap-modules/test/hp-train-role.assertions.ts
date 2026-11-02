// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R3.1, R3.2, OQ-11.4) CDK assertion checks for the HyperPod training role.
 * Synthesizes the training stack in-process with aws-cdk-lib/assertions (offline: no
 * AWS calls, no cdk CLI) and checks:
 *   - the trust policy: pods.eks.amazonaws.com with sts:AssumeRole + sts:TagSession,
 *     conditioned on aws:SourceAccount = this account (EKS Pod Identity);
 *   - the EXACT action / resource set (dataset + model read on the core bucket,
 *     train/tune job-output write on the artifacts bucket, MLflow App tracking);
 *   - no Lambda / Bedrock / KMS / ECR permission and no core-bucket write;
 *   - the HpTrainRoleArnOutput the bootstrap handler maps to profile hpTrainRoleArn.
 * Bucket names are rendered from the single declared sources (core/buckets.json,
 * training/buckets.json) through bucket-declarations, never spelled here.
 * Driven by test/unit/bootstrap-hp-train-role-cdk.test.js. Prints a JSON summary on
 * success; throws on failure.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MlccTrainingStack, BUCKETS as TRAINING_BUCKETS } from '../training/stack';
import CORE_BUCKETS from '../core/buckets.json';
import { bucketDeclaration, renderBucketName } from '../bucket-declarations';

const ACCOUNT = '111111111111';
const REGION = 'us-west-2';
const PROFILE = 'zz-test';
const nameVars = { account: ACCOUNT, region: REGION, profileName: PROFILE };
const core = renderBucketName(CORE_BUCKETS.buckets.ModelsBucketResource, nameVars);
const artifacts = renderBucketName(bucketDeclaration(TRAINING_BUCKETS, 'ArtifactsBucket'), nameVars);

function fail(msg: string): never {
    throw new Error(msg);
}
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [String(v)]);

interface Stmt {
    Sid?: string;
    Effect: string;
    Action: string | string[];
    Resource?: string | string[];
    Principal?: { Service?: string | string[] };
    Condition?: Record<string, Record<string, string | string[]>>;
}

const t = Template.fromStack(new MlccTrainingStack(new cdk.App(), `mlcc-${PROFILE}-training`, {
    env: { account: ACCOUNT, region: REGION }, profileName: PROFILE,
}));

// ── the role + trust ────────────────────────────────────────────────────────
const roles = Object.entries(t.findResources('AWS::IAM::Role'))
    .filter(([, r]) => String((r as { Properties: { RoleName?: string } }).Properties.RoleName || '').startsWith('mlcc-hp-train-role-'));
if (roles.length !== 1) fail(`expected exactly one mlcc-hp-train-role-*, found ${roles.length}`);
const [roleId, role] = roles[0] as [string, { Properties: { RoleName: string; AssumeRolePolicyDocument: { Statement: Stmt[] } } }];
if (role.Properties.RoleName !== `mlcc-hp-train-role-${REGION}`) fail(`role name ${role.Properties.RoleName}`);
const trust = role.Properties.AssumeRolePolicyDocument.Statement;
if (trust.length !== 1) fail(`trust must be one statement, got ${trust.length}`);
const tr = trust[0];
if (tr.Effect !== 'Allow') fail('trust must Allow');
if (JSON.stringify(asList(tr.Principal && tr.Principal.Service)) !== JSON.stringify(['pods.eks.amazonaws.com'])) {
    fail(`trust principal must be pods.eks.amazonaws.com only: ${JSON.stringify(tr.Principal)}`);
}
if (JSON.stringify(asList(tr.Action).sort()) !== JSON.stringify(['sts:AssumeRole', 'sts:TagSession'])) {
    fail(`trust actions must be AssumeRole + TagSession: ${JSON.stringify(tr.Action)}`);
}
const src = tr.Condition && tr.Condition.StringEquals && tr.Condition.StringEquals['aws:SourceAccount'];
if (src !== ACCOUNT) fail(`trust must be conditioned on aws:SourceAccount=${ACCOUNT}: ${JSON.stringify(tr.Condition)}`);

// ── the exact permission set ────────────────────────────────────────────────
const stmts: Stmt[] = [];
for (const p of Object.values(t.findResources('AWS::IAM::Policy'))) {
    const props = (p as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } }).Properties;
    if (props.Roles.some(r => r.Ref === roleId)) stmts.push(...props.PolicyDocument.Statement);
}
const managed = (role.Properties as { ManagedPolicyArns?: unknown[] }).ManagedPolicyArns;
if (managed && managed.length) fail('HpTrainRole must carry no managed policies');
const got = stmts.map(s => ({
    actions: asList(s.Action).sort(),
    resources: asList(s.Resource).sort(),
    condition: s.Condition || null,
    effect: s.Effect,
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const expected = [
    { actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${core}/datasets/*`, `arn:aws:s3:::${core}/models/*`], condition: null },
    { actions: ['s3:ListBucket'], resources: [`arn:aws:s3:::${core}`], condition: { StringLike: { 's3:prefix': ['datasets/*', 'models/*'] } } },
    {
        actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:ListMultipartUploadParts', 's3:PutObject'],
        resources: [`arn:aws:s3:::${artifacts}/*/train/*`, `arn:aws:s3:::${artifacts}/*/tune/*`],
        condition: null,
    },
    { actions: ['s3:ListBucket'], resources: [`arn:aws:s3:::${artifacts}`], condition: { StringLike: { 's3:prefix': ['*/train/*', '*/tune/*'] } } },
    { actions: ['sagemaker-mlflow:*', 'sagemaker:CallMlflowAppApi'], resources: [`arn:aws:sagemaker:${REGION}:${ACCOUNT}:mlflow-app/*`], condition: null },
].map(e => ({ ...e, effect: 'Allow' })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
if (JSON.stringify(got) !== JSON.stringify(expected)) {
    fail(`HpTrainRole permissions drifted:\n got ${JSON.stringify(got, null, 1)}\n want ${JSON.stringify(expected, null, 1)}`);
}
// Belt and braces: no forbidden service anywhere, no write on the core bucket.
for (const s of stmts) {
    for (const a of asList(s.Action)) {
        if (/^(lambda|bedrock|kms|ecr|iam):/.test(a)) fail(`forbidden action ${a}`);
        if (a === 's3:*' || a === '*') fail(`wildcard action ${a}`);
    }
    if (asList(s.Action).some(a => /^s3:(Put|Delete)/.test(a))
        && asList(s.Resource).some(r => r.includes(`:::${core}`))) {
        fail('HpTrainRole must not write the core bucket (promotion stays in the CLI)');
    }
}

// ── the output the bootstrap handler maps to profile hpTrainRoleArn ──────────
t.hasOutput('HpTrainRoleArnOutput', { Export: { Name: `mlcc-${PROFILE}-training-HpTrainRoleArn` } });

console.log(JSON.stringify({ ok: true, roleId, statements: stmts.length }));
