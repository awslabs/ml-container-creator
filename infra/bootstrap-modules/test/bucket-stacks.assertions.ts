// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * CDK assertion checks for the bucket-owning bootstrap stacks (bucket consolidation
 * R1.1-R1.4, R1.6). Synthesizes core / training / benchmark / ci in-process with
 * aws-cdk-lib/assertions — no AWS calls, no cdk CLI.
 *
 * Driven by test/unit/bootstrap-bucket-stacks-cdk.test.js, which runs this file via
 * ts-node and passes the bucket names rendered by bucket-declarations.cjs in
 * MLCC_EXPECTED_BUCKETS (JSON: { "<stack>/<logicalId>": "<name>" }), so this check
 * also proves the TypeScript and CommonJS renderers of buckets.json agree.
 * Exits non-zero (assertion error) on any failure; prints a JSON summary on success.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MlccCoreStack } from '../core/stack';
import { MlccTrainingStack } from '../training/stack';
import { MlccBenchmarkStack } from '../benchmark/stack';
import { MlccCiStack } from '../ci/stack';

const ACCOUNT = '111111111111';
const REGION = 'us-west-2';
const PROFILE = 'zz-test';
const env = { account: ACCOUNT, region: REGION };
const expected: Record<string, string> = JSON.parse(process.env.MLCC_EXPECTED_BUCKETS || '{}');

function fail(msg: string): never {
    throw new Error(msg);
}

function expectedName(key: string): string {
    return expected[key] || fail(`MLCC_EXPECTED_BUCKETS has no entry for ${key}`);
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }>;

function bucketsOf(t: Template): Resources {
    return t.findResources('AWS::S3::Bucket') as Resources;
}

/** Every bucket is RETAIN on delete and on replace (import requires a DeletionPolicy). */
function assertAllRetained(stack: string, t: Template): void {
    for (const [id, res] of Object.entries(bucketsOf(t))) {
        if (res.DeletionPolicy !== 'Retain' || res.UpdateReplacePolicy !== 'Retain') {
            fail(`${stack}/${id}: expected DeletionPolicy+UpdateReplacePolicy Retain, got ${res.DeletionPolicy}/${res.UpdateReplacePolicy}`);
        }
    }
}

function bucketLogicalIdByName(t: Template, name: string): string {
    const hit = Object.entries(bucketsOf(t)).find(([, r]) => (r.Properties || {}).BucketName === name);
    return hit ? hit[0] : fail(`no AWS::S3::Bucket named ${name}`);
}

const summary: Record<string, unknown> = {};

// ── training: create mode ─────────────────────────────────────────────────────
{
    const app = new cdk.App();
    const stack = new MlccTrainingStack(app, `mlcc-${PROFILE}-training`, { env, profileName: PROFILE });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 3);
    assertAllRetained('training', t);
    const artifacts = expectedName('training/ArtifactsBucket');
    const artifactsId = bucketLogicalIdByName(t, artifacts);
    const art = bucketsOf(t)[artifactsId].Properties || {};
    // D2: versioning OFF — no VersioningConfiguration at all.
    if (art.VersioningConfiguration !== undefined) fail(`ArtifactsBucket must not be versioned, got ${JSON.stringify(art.VersioningConfiguration)}`);
    // D1: lifecycle = abort incomplete multipart uploads (7 days) ONLY.
    t.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: artifacts,
        LifecycleConfiguration: {
            Rules: [{ Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }],
        },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    });
    const rules = ((art.LifecycleConfiguration as { Rules: unknown[] }) || { Rules: [] }).Rules;
    if (rules.length !== 1) fail(`ArtifactsBucket must have exactly one lifecycle rule, got ${rules.length}`);
    t.hasOutput('ArtifactsBucketOutput', { Value: artifacts, Export: { Name: `mlcc-${PROFILE}-training-ArtifactsBucket` } });
    // Bucket consolidation R3.9: the reward-Lambda role reads the core bucket's
    // evaluators/ prefix (new reward-code backups live there).
    const core = expectedName('core/ModelsBucketResource');
    t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: Match.arrayWith([
                Match.objectLike({ Sid: 'ReadCoreEvaluators', Action: 's3:GetObject', Resource: `arn:aws:s3:::${core}/evaluators/*` }),
                Match.objectLike({
                    Sid: 'ListCoreEvaluators', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${core}`,
                    Condition: { StringLike: { 's3:prefix': ['evaluators/*'] } },
                }),
            ]),
        },
    });
    // Legacy buckets keep their stable logical IDs and outputs.
    const trainingId = bucketLogicalIdByName(t, expectedName('training/TrainingBucket'));
    const adaptersId = bucketLogicalIdByName(t, expectedName('training/AdaptersBucket'));
    t.hasOutput('TrainingBucketOutput', { Value: expectedName('training/TrainingBucket') });
    t.hasOutput('AdaptersBucketOutput', { Value: expectedName('training/AdaptersBucket') });
    // D4: the never-assumed training role is gone.
    const roles = t.findResources('AWS::IAM::Role');
    for (const [id, r] of Object.entries(roles)) {
        const rn = String(((r as { Properties?: { RoleName?: unknown } }).Properties || {}).RoleName || '');
        if (rn.startsWith('mlcc-training-role')) fail(`training role ${id} (${rn}) must be deleted`);
    }
    if (Object.keys(t.toJSON().Outputs || {}).includes('TrainingRoleArnOutput')) fail('TrainingRoleArnOutput must be removed');
    t.hasOutput('RewardLambdaRoleArnOutput', Match.anyValue());
    summary.training = { artifactsId, trainingId, adaptersId };
}

// ── training: adopt mode (pre-import) — no bucket resources, outputs intact ────
{
    const app = new cdk.App();
    const stack = new MlccTrainingStack(app, `mlcc-${PROFILE}-training`, {
        env, profileName: PROFILE,
        adoptExistingBuckets: true, adoptExistingAdaptersBucket: true, adoptExistingArtifactsBucket: true,
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 0);
    t.hasOutput('ArtifactsBucketOutput', { Value: expectedName('training/ArtifactsBucket') });
}

// ── core: models bucket lifecycle (D1b) ───────────────────────────────────────
{
    const app = new cdk.App();
    const stack = new MlccCoreStack(app, `mlcc-${PROFILE}-core`, { env, profileName: PROFILE, adoptExistingEcr: true });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 1);
    assertAllRetained('core', t);
    const name = expectedName('core/ModelsBucketResource');
    t.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: name,
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: {
            Rules: Match.arrayEquals([
                { Id: 'ExpireNoncurrentVersions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
                { Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
            ]),
        },
    });
    t.hasOutput('ModelsBucket', { Value: name, Export: { Name: `mlcc-${PROFILE}-core-ModelsBucket` } });
    // Secrets read scope (formerly pinned against the retired monolithic template).
    t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: Match.arrayWith([Match.objectLike({
                Sid: 'SecretsManagerRead',
                Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
                // BL212: containers resolve *_ARN at startup with this role, so it must
                // also read the default generate-time secret names (mlcc-hf-token-<project>).
                Resource: [
                    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:mlcc/*`,
                    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:ml-container-creator/*`,
                    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:mlcc-hf-token-*`,
                ],
            })]),
        },
    });
    summary.core = { modelsId: bucketLogicalIdByName(t, name) };

    const adoptApp = new cdk.App();
    const adopted = Template.fromStack(new MlccCoreStack(adoptApp, `mlcc-${PROFILE}-core`, {
        env, profileName: PROFILE, adoptExistingEcr: true, adoptExistingBuckets: true,
    }));
    adopted.resourceCountIs('AWS::S3::Bucket', 0);
    adopted.hasOutput('ModelsBucket', { Value: name });
}

// ── benchmark + ci: owned, retained, names from the declaration ───────────────
{
    const app = new cdk.App();
    const bench = Template.fromStack(new MlccBenchmarkStack(app, `mlcc-${PROFILE}-benchmark`, { env, profileName: PROFILE }));
    bench.resourceCountIs('AWS::S3::Bucket', 1);
    assertAllRetained('benchmark', bench);
    const bname = expectedName('benchmark/BenchmarkBucket');
    bench.hasOutput('BenchmarkBucketOutput', { Value: bname, Export: { Name: `mlcc-${PROFILE}-benchmark-BenchmarkBucket` } });
    const ci = Template.fromStack(new MlccCiStack(new cdk.App(), `mlcc-${PROFILE}-ci`, { env, profileName: PROFILE }));
    ci.resourceCountIs('AWS::S3::Bucket', 1);
    assertAllRetained('ci', ci);
    const cname = expectedName('ci/SourceBucketResource');
    ci.hasOutput('SourceBucket', { Value: cname });
    summary.benchmark = { benchmarkId: bucketLogicalIdByName(bench, bname) };
    summary.ci = { sourceId: bucketLogicalIdByName(ci, cname) };
}

console.log(JSON.stringify({ ok: true, logicalIds: summary }));
