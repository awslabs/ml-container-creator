// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface MlccTrainingStackProps extends cdk.StackProps {
    profileName: string;
    adoptExistingBuckets?: boolean;
    adoptExistingAdaptersBucket?: boolean;
}

/**
 * Training module: S3 bucket for training data + training execution role.
 */
export class MlccTrainingStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccTrainingStackProps) {
        super(scope, id, props);

        const { profileName, adoptExistingBuckets, adoptExistingAdaptersBucket } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'training');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        const bucketName = `mlcc-training-${this.account}-${this.region}`;
        const adaptersBucketName = `mlcc-training-adapters-${this.account}-${this.region}`;

        // Training data bucket (RETAIN on delete — data is valuable). When the
        // bucket already exists from a prior provision (retained on teardown),
        // adopt it by reference instead of colliding on create.
        const trainingBucket = adoptExistingBuckets
            ? s3.Bucket.fromBucketName(this, 'TrainingBucket', bucketName)
            : new s3.Bucket(this, 'TrainingBucket', {
                bucketName,
                versioned: true,
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            });

        // Adapters bucket — LoRA adapter staging for do/adapter. Separate bucket
        // (distinct lifecycle: small, long-lived, re-deployed) but owned by the
        // same training module/stack. RETAIN — adapters are valuable deploy artifacts.
        const adaptersBucket = adoptExistingAdaptersBucket
            ? s3.Bucket.fromBucketName(this, 'AdaptersBucket', adaptersBucketName)
            : new s3.Bucket(this, 'AdaptersBucket', {
                bucketName: adaptersBucketName,
                versioned: true,
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            });

        const trainingRole = new iam.Role(this, 'TrainingRole', {
            roleName: `mlcc-training-role-${this.region}`,
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'SageMaker training execution role for mlcc',
        });

        trainingRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
            resources: [
                trainingBucket.bucketArn, `${trainingBucket.bucketArn}/*`,
                adaptersBucket.bucketArn, `${adaptersBucket.bucketArn}/*`,
            ],
        }));

        trainingRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: ['arn:aws:logs:*:*:*'],
        }));

        // ── Launch-gate IAM (BL123) ─────────────────────────────────────────────
        // The 11 actions a SageMaker training-type workload needs to LAUNCH — the
        // minimum delta the BL122 spike's IamRoleResolver flagged for the native
        // ai_registry DataSet/Evaluator create path (which runs a training-type
        // workload) and the managed-RL customization jobs: EC2 VPC/ENI setup,
        // CloudWatch metric emission, and the ECR auth token. These are
        // service-scoped at launch time, so resource '*' is required (ENI/VPC
        // describe + GetAuthorizationToken take no narrower ARN).
        //
        // BL123 is the SOLE writer of this block. BL117 CONSUMES it and MUST NOT
        // add a second copy — extend THIS statement if the full runtime set grows
        // (the spike flagged the launch gate as not-yet-exhaustive). A runtime
        // AccessDenied here surfaces as a permission error from the create call;
        // the actionable guidance is to re-run `ml-container-creator bootstrap`
        // (or add-module training) to refresh this role.
        trainingRole.addToPolicy(new iam.PolicyStatement({
            sid: 'MlccLaunchGate',
            actions: [
                // CloudWatch metrics the training container publishes.
                'cloudwatch:PutMetricData',
                // ECR auth token for pulling the training/DLC image.
                'ecr:GetAuthorizationToken',
                // EC2 VPC/ENI setup for a VPC-attached training job.
                'ec2:CreateNetworkInterface',
                'ec2:CreateNetworkInterfacePermission',
                'ec2:DeleteNetworkInterface',
                'ec2:DeleteNetworkInterfacePermission',
                'ec2:DescribeDhcpOptions',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeSubnets',
                'ec2:DescribeVpcs',
            ],
            resources: ['*'],
        }));

        // Outputs
        new cdk.CfnOutput(this, 'TrainingBucketOutput', {
            value: bucketName,
            exportName: `mlcc-${profileName}-training-TrainingBucket`,
        });

        new cdk.CfnOutput(this, 'AdaptersBucketOutput', {
            value: adaptersBucketName,
            exportName: `mlcc-${profileName}-training-AdaptersBucket`,
        });

        new cdk.CfnOutput(this, 'TrainingRoleArnOutput', {
            value: trainingRole.roleArn,
            exportName: `mlcc-${profileName}-training-TrainingRoleArn`,
        });
    }
}
