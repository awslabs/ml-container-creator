// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import CORE_BUCKETS from './buckets.json';
import {
    StackBucketDeclarations, bucketDeclaration, declaredBucket, renderBucketName,
} from '../bucket-declarations';

/** The core stack's bucket declarations (single declared source, R1.2). */
export const BUCKETS: StackBucketDeclarations = CORE_BUCKETS;

export interface MlccCoreStackProps extends cdk.StackProps {
    profileName: string;
    adoptExistingEcr?: boolean;
    adoptExistingBuckets?: boolean;
}

/**
 * Core module: IAM execution role + ECR repository.
 * Account-level singletons shared by all profiles in the same account-region.
 */
export class MlccCoreStack extends cdk.Stack {
    public readonly role: iam.Role;
    public readonly ecrRepository: ecr.IRepository;
    public readonly modelsBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: MlccCoreStackProps) {
        super(scope, id, props);

        const { profileName, adoptExistingEcr, adoptExistingBuckets } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'core');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // ── Models bucket — staged model weights (do/stage → do/submit/deploy) ──
        // Bootstrap-owned; do/ scripts NEVER create buckets. RETAIN — staged
        // weights are large and expensive to re-download. Declared in
        // ./buckets.json; the runner adopts it by reference ONLY while it exists but
        // is not yet a resource of this stack (stack creation; imported right after).
        // Lifecycle (owner decision D1b): versioning + overwrite-on-promote would
        // otherwise keep every old version forever, so noncurrent versions expire
        // after 30 days; abandoned multipart uploads are aborted after 7 days.
        const modelsBucketName = renderBucketName(
            bucketDeclaration(BUCKETS, 'ModelsBucketResource'),
            { account: this.account, region: this.region, profileName },
        );
        this.modelsBucket = declaredBucket(this, 'ModelsBucketResource', modelsBucketName, adoptExistingBuckets, {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            lifecycleRules: [{
                id: 'ExpireNoncurrentVersions',
                noncurrentVersionExpiration: cdk.Duration.days(30),
            }, {
                id: 'AbortIncompleteMultipartUploads',
                abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            }],
        });

        // IAM Role for SageMaker execution
        this.role = new iam.Role(this, 'ExecutionRole', {
            roleName: 'mlcc-sagemaker-execution-role',
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'SageMaker execution role for ml-container-creator projects',
        });

        // ── Execution role policy — full lifecycle permission set ──────────────
        // Mirrors the validated v1.0/v1.1 monolithic role (the retired monolithic bootstrap template).
        // The modular rewrite under-scoped this role; ported in full 2026-07-07 (BL055).

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerEndpoints',
            actions: [
                'sagemaker:CreateEndpoint', 'sagemaker:CreateEndpointConfig', 'sagemaker:CreateModel',
                'sagemaker:CreateInferenceComponent', 'sagemaker:UpdateEndpoint',
                'sagemaker:UpdateEndpointWeightsAndCapacities', 'sagemaker:UpdateInferenceComponent',
                'sagemaker:DeleteEndpoint', 'sagemaker:DeleteEndpointConfig', 'sagemaker:DeleteModel',
                'sagemaker:DeleteInferenceComponent', 'sagemaker:DescribeEndpoint',
                'sagemaker:DescribeEndpointConfig', 'sagemaker:DescribeModel',
                'sagemaker:DescribeInferenceComponent', 'sagemaker:ListInferenceComponents',
                'sagemaker:ListEndpoints', 'sagemaker:InvokeEndpoint', 'sagemaker:InvokeEndpointAsync',
            ],
            resources: ['*'],
        }));

        // AI Benchmark / Recommendation / Workload + Training jobs. The AI Benchmark
        // service runs AIPerf as an internal SageMaker TRAINING job under this role.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerBenchmarking',
            actions: [
                'sagemaker:CreateAIBenchmarkJob', 'sagemaker:DescribeAIBenchmarkJob',
                'sagemaker:ListAIBenchmarkJobs', 'sagemaker:StopAIBenchmarkJob', 'sagemaker:DeleteAIBenchmarkJob',
                'sagemaker:CreateAIRecommendationJob', 'sagemaker:DescribeAIRecommendationJob',
                'sagemaker:ListAIRecommendationJobs', 'sagemaker:StopAIRecommendationJob', 'sagemaker:DeleteAIRecommendationJob',
                'sagemaker:CreateAIWorkloadConfig', 'sagemaker:DescribeAIWorkloadConfig',
                'sagemaker:ListAIWorkloadConfigs', 'sagemaker:DeleteAIWorkloadConfig',
                'sagemaker:CreateTrainingJob', 'sagemaker:DescribeTrainingJob',
                'sagemaker:StopTrainingJob', 'sagemaker:AddTags',
            ],
            resources: ['*'],
        }));

        // Model customization (do/tune, do/train, do/register) + Hub (gated models).
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerModelCustomization',
            actions: [
                'sagemaker:CreateTrainingJob', 'sagemaker:DescribeTrainingJob',
                'sagemaker:ListTrainingJobs', 'sagemaker:StopTrainingJob',
                'sagemaker:CreateModelPackage', 'sagemaker:CreateModelPackageGroup',
                'sagemaker:DescribeModelPackage', 'sagemaker:DescribeModelPackageGroup',
                'sagemaker:ListModelPackages', 'sagemaker:ListHubContents',
                'sagemaker:DescribeHubContent', 'sagemaker:DescribeHub',
                // ai_registry asset WRITE path (BL117 evaluators + BL123 datasets).
                // The high-level ai_registry SDK (DataSet.create / Evaluator.create)
                // writes assets as hub content into its computed hub. The read
                // actions above cover list/resolve; these cover create/update/delete.
                // Without CreateHubContent/ImportHubContent, Evaluator.create fails
                // its launch-gate SimulatePrincipalPolicy check with implicitDeny
                // (surfaced confusingly as an ExpiredToken error).
                'sagemaker:CreateHub', 'sagemaker:CreateHubContent',
                'sagemaker:ImportHubContent', 'sagemaker:CreateHubContentReference',
                'sagemaker:UpdateHubContent', 'sagemaker:DeleteHubContent',
                'sagemaker:ListHubs', 'sagemaker:ListHubContentVersions',
            ],
            resources: ['*'],
        }));

        // MLflow experiment tracking (tune/train).
        // NOTE (BL163): MLCC uses the serverless MLflow *App* (the Ml*App* actions
        // below). The *MlflowTrackingServer* actions are a vestige from the earlier
        // tracking-server design and are no longer exercised by the shared-catalog
        // flow. They are left in place deliberately (defensive, out of scope for
        // BL163) and flagged here for a future IAM-minimization cleanup.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerMLflow',
            actions: [
                'sagemaker:ListMlflowApps', 'sagemaker:ListMlflowTrackingServers',
                'sagemaker:DescribeMlflowTrackingServer', 'sagemaker:CreatePresignedMlflowTrackingServerUrl',
                'sagemaker:DescribeApp', 'sagemaker:ListApps',
                'sagemaker:UpdateMlflowApp', 'sagemaker:DescribeMlflowApp',
                'sagemaker:CreatePresignedMlflowAppUrl', 'sagemaker:CallMlflowAppApi',
                'sagemaker-mlflow:*',
            ],
            resources: ['*'],
        }));

        // MLflow -> Model Registry bridge (BL164 / ADR-013). When the App has
        // AutoModelRegistrationEnabled, mlflow.register_model makes THIS role
        // auto-create a SageMaker Model Package (+ group) and its lineage edges.
        // The bridge needs these three beyond the base MLflow actions above;
        // without them lineage/lifecycle silently degrade (live-verified the role
        // was missing them, BL168 §6). Model-package create/describe already exist
        // elsewhere in this policy.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerModelRegistryBridge',
            actions: [
                'sagemaker:UpdateModelPackage',   // lifecycle (alias -> stage/status)
                'sagemaker:CreateAction',         // lineage: experiment/run -> package
                'sagemaker:AddAssociation',       // lineage edges
            ],
            resources: ['*'],
        }));

        // PassRole — benchmark/training services pass THIS role to the jobs they create.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'PassExecutionRole',
            actions: ['iam:PassRole'],
            resources: [this.role.roleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
        }));

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'ECRPull',
            actions: [
                'ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
            ],
            resources: ['*'],
        }));

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'CloudWatchLogs',
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: ['arn:aws:logs:*:*:*'],
        }));

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'CloudWatchMetrics',
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));

        // VPC networking — required by SageMaker training/processing jobs that
        // run inside a VPC (managed customization jobs always use VPC mode).
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'VpcNetworking',
            actions: [
                'ec2:CreateNetworkInterface', 'ec2:CreateNetworkInterfacePermission',
                'ec2:DeleteNetworkInterface', 'ec2:DeleteNetworkInterfacePermission',
                'ec2:DescribeDhcpOptions', 'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeSecurityGroups', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs',
            ],
            resources: ['*'],
        }));

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'S3ModelAccess',
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:AbortMultipartUpload'],
            resources: [
                'arn:aws:s3:::ml-container-creator-*', 'arn:aws:s3:::ml-container-creator-*/*',
                'arn:aws:s3:::mlcc-*', 'arn:aws:s3:::mlcc-*/*',
                // JumpStart model cache — required for do/tune with JumpStart model IDs
                'arn:aws:s3:::jumpstart-cache-prod-*', 'arn:aws:s3:::jumpstart-cache-prod-*/*',
                // SageMaker-managed staging buckets used during training jobs
                'arn:aws:s3:::sagemaker-*', 'arn:aws:s3:::sagemaker-*/*',
            ],
        }));

        // Secrets Manager — server-side jobs and serving containers resolve the
        // HF token / NGC key themselves. BL212: do/deploy passes only
        // HF_TOKEN_ARN / NGC_API_KEY_ARN in the container Environment and the
        // container (code/serve) calls GetSecretValue as this role at startup.
        // Scoped to the names MLCC creates:
        //   • mlcc/<type>/<label>          — `ml-container-creator secrets create`
        //   • ml-container-creator/...     — do/benchmark's HF token secret
        //   • mlcc-hf-token-<project>      — default name from the generate-time prompt
        // do/lib/secrets.sh warns when a configured secret is outside these
        // (drift-checked by test/unit/test_container_secrets_guard.py).
        const mlccSecretArns = [
            `arn:aws:secretsmanager:*:${this.account}:secret:mlcc/*`,
            `arn:aws:secretsmanager:*:${this.account}:secret:ml-container-creator/*`,
            `arn:aws:secretsmanager:*:${this.account}:secret:mlcc-hf-token-*`,
        ];
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerRead',
            actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            resources: mlccSecretArns,
        }));
        // Customer-managed KMS keys (`secrets create --kms-key-id`): decrypt only
        // when Secrets Manager calls KMS on our behalf for one of the secrets above.
        // Secrets encrypted with the AWS-managed aws/secretsmanager key need no grant.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerKmsDecrypt',
            actions: ['kms:Decrypt'],
            resources: [`arn:aws:kms:*:${this.account}:key/*`],
            conditions: {
                StringLike: {
                    'kms:ViaService': 'secretsmanager.*.amazonaws.com',
                    'kms:EncryptionContext:SecretARN': mlccSecretArns,
                },
            },
        }));

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerWrite',
            actions: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:TagResource'],
            resources: [
                `arn:aws:secretsmanager:*:${this.account}:secret:mlcc/*`,
                `arn:aws:secretsmanager:*:${this.account}:secret:ml-container-creator/*`,
            ],
        }));

        // Async inference completion notifications.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SNSPublish',
            actions: ['sns:Publish'],
            resources: ['*'],
        }));

        // Instance sizing / quota checks + training-plan (reserved capacity) lookups.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'QuotaAndAvailability',
            actions: [
                'service-quotas:GetServiceQuota', 'service-quotas:ListServiceQuotas',
                'sagemaker:ListTrainingPlans', 'sagemaker:DescribeTrainingPlan',
            ],
            resources: ['*'],
        }));

        // Reward-function invocation for RLVR/RLAIF tuning.
        // Reward-function invocation for RLVR tuning. The managed training job
        // (running as this role) invokes the reward Lambda per batch. Cover the
        // two MLCC-managed naming conventions:
        //   • mlcc-*                — MLCC-owned reward Lambdas
        //   • SageMaker-evaluator-* — Lambdas SageMaker creates from a local .py
        //     via `do/register evaluator --from-sample --finalize`
        //     (see _LAMBDA_NAME_PREFIX in register_evaluator.py).
        // A genuinely bring-your-own reward Lambda with an arbitrary name
        // (`do/register evaluator --arn <any-lambda>`) is NOT covered here by
        // design — the shared role must not blanket-grant invoke on every Lambda
        // in the account. Grant invoke on that specific function ARN separately
        // (an inline policy on this role scoped to the one function).
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'LambdaInvokeForReward',
            actions: ['lambda:InvokeFunction'],
            resources: [
                'arn:aws:lambda:*:' + this.account + ':function:mlcc-*',
                'arn:aws:lambda:*:' + this.account + ':function:SageMaker-evaluator-*',
            ],
        }));

        // Bedrock judge-model invocation for RLAIF (LLM-as-judge reward). The
        // managed RLAIF trainer scores completions by calling the configured
        // judge model (e.g. judge_model_id=bedrock/deepseek.v3-v1:0) via
        // bedrock:InvokeModel. Without this the job trains until the first reward
        // call then fails: "not authorized to perform: bedrock:InvokeModel".
        // Scoped to foundation-model and inference-profile ARNs (judge models are
        // Bedrock FMs; some are only reachable via a cross-region inference
        // profile) so RLVR/MTRL (which use Lambda reward fns) are unaffected.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'BedrockInvokeForJudge',
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
                'arn:aws:bedrock:*::foundation-model/*',
                `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
            ],
        }));

        // ECR Repository (RETAIN on delete — images survive teardown). Because
        // the repo is retained, a later re-provision would collide on create.
        // When adoptExistingEcr is set (the runner detected the repo already
        // exists), adopt it by reference instead of recreating it.
        this.ecrRepository = adoptExistingEcr
            ? ecr.Repository.fromRepositoryName(this, 'EcrRepository', 'ml-container-creator')
            : new ecr.Repository(this, 'EcrRepository', {
                repositoryName: 'ml-container-creator',
                imageScanOnPush: true,
                encryption: ecr.RepositoryEncryption.AES_256,
                lifecycleRules: [{
                    description: 'Expire untagged images after 30 days',
                    tagStatus: ecr.TagStatus.UNTAGGED,
                    maxImageAge: cdk.Duration.days(30),
                }],
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });

        // Outputs (cross-stack exports)
        new cdk.CfnOutput(this, 'RoleArn', {
            value: this.role.roleArn,
            exportName: `mlcc-${profileName}-core-RoleArn`,
        });

        new cdk.CfnOutput(this, 'EcrRepositoryName', {
            value: this.ecrRepository.repositoryName,
            exportName: `mlcc-${profileName}-core-EcrRepositoryName`,
        });

        new cdk.CfnOutput(this, 'EcrRepositoryUri', {
            value: this.ecrRepository.repositoryUri,
            exportName: `mlcc-${profileName}-core-EcrRepositoryUri`,
        });

        new cdk.CfnOutput(this, 'ModelsBucket', {
            value: modelsBucketName,
            exportName: `mlcc-${profileName}-core-ModelsBucket`,
        });
    }
}
