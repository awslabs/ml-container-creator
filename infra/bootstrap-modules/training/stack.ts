// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import TRAINING_BUCKETS from './buckets.json';
import CORE_BUCKETS from '../core/buckets.json';
import {
    StackBucketDeclarations, bucketDeclaration, declaredBucket, renderBucketName,
} from '../bucket-declarations';

/** The training stack's bucket declarations (single declared source, R1.2). */
export const BUCKETS: StackBucketDeclarations = TRAINING_BUCKETS;

export interface MlccTrainingStackProps extends cdk.StackProps {
    profileName: string;
    adoptExistingBuckets?: boolean;
    adoptExistingAdaptersBucket?: boolean;
    adoptExistingArtifactsBucket?: boolean;
}

/**
 * Training module: the per-project artifacts bucket (tune/train/optimize output and
 * the MLflow App artifact store), the legacy training + adapters buckets, and the
 * dual-trust reward-Lambda role.
 *
 * Every bucket is declared in ./buckets.json and is a CloudFormation resource of
 * this stack (RETAIN). The runner adopts a bucket by reference ONLY when it exists
 * and is not yet a resource of this stack (while the stack is created); the runner
 * imports it in the same run, after which the stack owns it and no deploy ever
 * orphans it.
 */
export class MlccTrainingStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccTrainingStackProps) {
        super(scope, id, props);

        const {
            profileName, adoptExistingBuckets, adoptExistingAdaptersBucket, adoptExistingArtifactsBucket,
        } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'training');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        const nameVars = { account: this.account, region: this.region, profileName };
        const bucketName = renderBucketName(bucketDeclaration(BUCKETS, 'TrainingBucket'), nameVars);
        const adaptersBucketName = renderBucketName(bucketDeclaration(BUCKETS, 'AdaptersBucket'), nameVars);
        const artifactsBucketName = renderBucketName(bucketDeclaration(BUCKETS, 'ArtifactsBucket'), nameVars);

        // Artifacts bucket — per-project raw job output (<project>/tune|train|optimize/)
        // and the MLflow App artifact store. Physical name is the pre-existing store
        // (owner decision D7); RETAIN. Versioning stays OFF (D2): it holds hundreds of
        // GiB of overwritten checkpoint state and versioning can only be suspended,
        // never removed. Lifecycle = abort incomplete multipart uploads only (D1) —
        // nothing that could delete resume state or recorded artifacts.
        declaredBucket(this, 'ArtifactsBucket', artifactsBucketName, adoptExistingArtifactsBucket, {
            versioned: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [{
                id: 'AbortIncompleteMultipartUploads',
                abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            }],
        });

        // Training data bucket — LEGACY (frozen): kept and owned so recorded URIs and
        // the reward-evaluator code backups stay valid. RETAIN.
        const trainingBucket = declaredBucket(this, 'TrainingBucket', bucketName, adoptExistingBuckets, {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Adapters bucket — LoRA adapter staging for do/adapter (SageMaker IC path).
        // Separate bucket owned by the same stack. RETAIN — adapters are valuable
        // deploy artifacts.
        declaredBucket(this, 'AdaptersBucket', adaptersBucketName, adoptExistingAdaptersBucket, {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // NOTE (owner decision D4): the former `mlcc-training-role-<region>` execution
        // role was removed. No runtime path assumed it — every SageMaker job MLCC
        // launches (tune, train, stage, optimize, benchmark, MLflow) runs as the core
        // execution role (ROLE_ARN), which already carries the launch-gate
        // permissions (core/stack.ts VpcNetworking / ECRPull / CloudWatchMetrics) and
        // the reward-Lambda PassRole below.

        // ── Reward-Lambda role (RLVR/MTRL verifiable-reward evaluators) ─────────
        // `do/register evaluator --from-sample --finalize` has SageMaker CREATE and
        // OWN a managed Lambda from the user's reward function. That requires a role
        // with DUAL trust — assumable by BOTH sagemaker.amazonaws.com (SageMaker
        // creates the function on the user's behalf) AND lambda.amazonaws.com (the
        // function assumes it at invoke time). This role is the
        // single source of truth for that path; its ARN is exported and threaded to
        // the runtime as MLCC_REWARD_LAMBDA_ROLE_ARN (consumed by register_evaluator).
        const rewardLambdaRole = new iam.Role(this, 'RewardLambdaRole', {
            roleName: `mlcc-reward-lambda-role-${this.region}`,
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('lambda.amazonaws.com'),
                new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            ),
            description:
                'Dual-trust (sagemaker + lambda) role for RLVR/MTRL reward-function '
                + 'Lambdas created via do/register evaluator --finalize',
        });

        // Basic Lambda execution: write its own CloudWatch logs.
        rewardLambdaRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AWSLambdaBasicExecutionRole',
            ),
        );

        // Read the reward-function code backup the SDK stages during --finalize
        // (it writes the .py to the training bucket under evaluators/<name>). No
        // write — the create path only reads it back; the ZIP is built in-memory.
        rewardLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [trainingBucket.bucketArn, `${trainingBucket.bucketArn}/*`],
        }));

        // Bucket consolidation R3.9: new reward-code backups go to the CORE bucket
        // under evaluators/<name>/ (do/lib/python/s3_layout.py evaluator_key). Read
        // only that prefix; the core bucket name is rendered from its single
        // declaration (core/buckets.json), never spelled here.
        const coreBucketName = renderBucketName(CORE_BUCKETS.buckets.ModelsBucketResource, nameVars);
        rewardLambdaRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ReadCoreEvaluators',
            actions: ['s3:GetObject'],
            resources: [`arn:aws:s3:::${coreBucketName}/evaluators/*`],
        }));
        rewardLambdaRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ListCoreEvaluators',
            actions: ['s3:ListBucket'],
            resources: [`arn:aws:s3:::${coreBucketName}`],
            conditions: { StringLike: { 's3:prefix': ['evaluators/*'] } },
        }));

        // (The former `MlccPassRewardLambdaRole` statement lived on the deleted,
        // never-assumed training role, so removing it changes no effective permission.
        // The reward Lambda is created by `do/register evaluator --finalize` with the
        // caller's own credentials.)

        // ── HyperPod EKS training role (Wave 11 R3, OQ-11.4) ─────────────────────
        // `do/train --backend hp-eks` / `do/tune --backend hp-eks` run a
        // HyperPodPyTorchJob under the ServiceAccount `mlcc-train-sa`. HyperPod pods
        // get NO AWS credentials otherwise (F0 probe: IMDS closed, no association),
        // so this role is the job's only identity. MLCC never creates the EKS Pod
        // Identity association (ADR-012: cluster config is the owner's); it prints
        // the one `aws eks create-pod-identity-association` command and the cluster
        // contract verifies it before every hp-eks submit.
        // ONE role per bootstrap profile (owner decision): the artifacts write is
        // scoped to the per-project job-output subtrees (<project>/train/... and
        // <project>/tune/...), not to one project, because IAM cannot bind a
        // per-profile role to a single project without per-project roles.
        // Least privilege: no Lambda, Bedrock, KMS (SSE-S3 buckets), ECR (the image
        // pull is node-side) or core-bucket write (promotion stays in the CLI).
        const hpTrainRole = new iam.Role(this, 'HpTrainRole', {
            roleName: `mlcc-hp-train-role-${this.region}`,
            // Pod Identity needs sts:TagSession alongside sts:AssumeRole.
            assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com')
                .withSessionTags()
                .withConditions({ StringEquals: { 'aws:SourceAccount': this.account } }),
            description:
                'EKS Pod Identity role for MLCC HyperPod training jobs (ServiceAccount '
                + 'mlcc-train-sa): dataset/model read, train/tune artifact write, MLflow',
        });
        const artifactsArn = `arn:aws:s3:::${artifactsBucketName}`;
        const hpTrainPolicy = new iam.Policy(this, 'HpTrainPolicy', {
            statements: [
                new iam.PolicyStatement({
                    sid: 'ReadCoreDatasetsAndModels',
                    actions: ['s3:GetObject'],
                    resources: [`arn:aws:s3:::${coreBucketName}/datasets/*`, `arn:aws:s3:::${coreBucketName}/models/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListCoreDatasetsAndModels',
                    actions: ['s3:ListBucket'],
                    resources: [`arn:aws:s3:::${coreBucketName}`],
                    conditions: { StringLike: { 's3:prefix': ['datasets/*', 'models/*'] } },
                }),
                new iam.PolicyStatement({
                    sid: 'WriteTrainTuneArtifacts',
                    actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
                    resources: [`${artifactsArn}/*/train/*`, `${artifactsArn}/*/tune/*`],
                }),
                new iam.PolicyStatement({
                    sid: 'ListTrainTuneArtifacts',
                    actions: ['s3:ListBucket'],
                    resources: [artifactsArn],
                    conditions: { StringLike: { 's3:prefix': ['*/train/*', '*/tune/*'] } },
                }),
                // The MLflow App is created by provision-mlflow AFTER this stack, so
                // its id is unknown here: scope to this account/region's apps.
                new iam.PolicyStatement({
                    sid: 'MlflowTracking',
                    actions: ['sagemaker-mlflow:*', 'sagemaker:CallMlflowAppApi'],
                    resources: [`arn:aws:sagemaker:${this.region}:${this.account}:mlflow-app/*`],
                }),
            ],
        });
        hpTrainPolicy.attachToRole(hpTrainRole);
        // Outputs
        new cdk.CfnOutput(this, 'TrainingBucketOutput', {
            value: bucketName,
            exportName: `mlcc-${profileName}-training-TrainingBucket`,
        });

        new cdk.CfnOutput(this, 'AdaptersBucketOutput', {
            value: adaptersBucketName,
            exportName: `mlcc-${profileName}-training-AdaptersBucket`,
        });

        // Artifacts bucket name → moduleOutputs.training.ArtifactsBucket →
        // profile artifactsS3Bucket → ARTIFACTS_S3_BUCKET (do/lib/profile.sh). The
        // ONLY way consumers (do/tune, do/train, do/optimize, provision-mlflow) learn it.
        new cdk.CfnOutput(this, 'ArtifactsBucketOutput', {
            value: artifactsBucketName,
            exportName: `mlcc-${profileName}-training-ArtifactsBucket`,
        });


        new cdk.CfnOutput(this, 'RewardLambdaRoleArnOutput', {
            value: rewardLambdaRole.roleArn,
            exportName: `mlcc-${profileName}-training-RewardLambdaRoleArn`,
        });
        // HpTrainRole ARN → moduleOutputs.training.HpTrainRoleArn → profile
        // hpTrainRoleArn → MLCC_HP_TRAIN_ROLE_ARN (do/lib/profile.sh).
        new cdk.CfnOutput(this, 'HpTrainRoleArnOutput', {
            value: hpTrainRole.roleArn,
            exportName: `mlcc-${profileName}-training-HpTrainRoleArn`,
        });
    }
}
