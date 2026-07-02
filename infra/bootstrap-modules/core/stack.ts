// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface MlccCoreStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * Core module: IAM execution role + ECR repository.
 * Account-level singletons shared by all profiles in the same account-region.
 */
export class MlccCoreStack extends cdk.Stack {
    public readonly role: iam.Role;
    public readonly ecrRepository: ecr.Repository;

    constructor(scope: Construct, id: string, props: MlccCoreStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'core');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // IAM Role for SageMaker execution
        this.role = new iam.Role(this, 'ExecutionRole', {
            roleName: 'mlcc-sagemaker-execution-role',
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'SageMaker execution role for ml-container-creator projects',
        });

        this.role.addToPolicy(new iam.PolicyStatement({
            sid: 'SageMakerEndpoints',
            actions: [
                'sagemaker:CreateEndpoint', 'sagemaker:CreateEndpointConfig', 'sagemaker:CreateModel',
                'sagemaker:CreateInferenceComponent', 'sagemaker:UpdateEndpoint',
                'sagemaker:DeleteEndpoint', 'sagemaker:DeleteEndpointConfig', 'sagemaker:DeleteModel',
                'sagemaker:DeleteInferenceComponent', 'sagemaker:DescribeEndpoint',
                'sagemaker:DescribeEndpointConfig', 'sagemaker:DescribeModel',
                'sagemaker:DescribeInferenceComponent', 'sagemaker:InvokeEndpoint',
                'sagemaker:ListInferenceComponents',
            ],
            resources: ['*'],
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
            sid: 'S3ModelAccess',
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:AbortMultipartUpload'],
            resources: ['arn:aws:s3:::ml-container-creator-*', 'arn:aws:s3:::ml-container-creator-*/*'],
        }));

        // ECR Repository
        this.ecrRepository = new ecr.Repository(this, 'EcrRepository', {
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
    }
}
