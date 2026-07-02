// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface MlccTrainingStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * Training module: S3 bucket for training data + training execution role.
 */
export class MlccTrainingStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccTrainingStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'training');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        const bucketName = `mlcc-training-${this.account}-${this.region}`;

        // Training data bucket
        const trainingBucket = new s3.Bucket(this, 'TrainingBucket', {
            bucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Training execution role (inherits from core role via cross-stack import)
        const coreRoleArn = cdk.Fn.importValue(`mlcc-${profileName}-core-RoleArn`);

        const trainingRole = new iam.Role(this, 'TrainingRole', {
            roleName: `mlcc-training-role-${this.region}`,
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'SageMaker training execution role for mlcc',
        });

        trainingRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
            resources: [trainingBucket.bucketArn, `${trainingBucket.bucketArn}/*`],
        }));

        trainingRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: ['arn:aws:logs:*:*:*'],
        }));

        // Outputs
        new cdk.CfnOutput(this, 'TrainingBucket', {
            value: bucketName,
            exportName: `mlcc-${profileName}-training-TrainingBucket`,
        });

        new cdk.CfnOutput(this, 'TrainingRoleArn', {
            value: trainingRole.roleArn,
            exportName: `mlcc-${profileName}-training-TrainingRoleArn`,
        });
    }
}
