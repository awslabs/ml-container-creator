// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

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
        // weights are large and expensive to re-download. Adopt-if-exists so a
        // re-provision against a retained bucket doesn't collide on create.
        const modelsBucketName = `mlcc-models-${this.account}-${this.region}`;
        this.modelsBucket = adoptExistingBuckets
            ? s3.Bucket.fromBucketName(this, 'ModelsBucketResource', modelsBucketName)
            : new s3.Bucket(this, 'ModelsBucketResource', {
                bucketName: modelsBucketName,
                versioned: true,
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            });

        // IAM Role for SageMaker execution
        this.role = new iam.Role(this, 'ExecutionRole', {
            roleName: 'mlcc-sagemaker-execution-role',
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'SageMaker execution role for ml-container-creator projects',
        });

        // ── Execution role policy — full lifecycle permission set ──────────────
        // Mirrors the validated v1.0/v1.1 monolithic role (config/bootstrap-stack.json).
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
            ],
            resources: ['*'],
        }));

        // MLflow experiment tracking (tune/train).
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
            ],
        }));

        // Secrets Manager — server-side jobs resolve the HF token themselves.
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerRead',
            actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            resources: [
                `arn:aws:secretsmanager:*:${this.account}:secret:mlcc/*`,
                `arn:aws:secretsmanager:*:${this.account}:secret:ml-container-creator/*`,
            ],
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
        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'LambdaInvokeForReward',
            actions: ['lambda:InvokeFunction'],
            resources: ['arn:aws:lambda:*:' + this.account + ':function:mlcc-*'],
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
