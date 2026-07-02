// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MlccCiStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * CI module: DynamoDB table, CodeBuild project, Step Functions orchestrator.
 * Migrated from infra/ci-harness/lib/ci-harness-stack.ts (modular version).
 */
export class MlccCiStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccCiStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'ci');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Import cross-stack values from core and benchmark modules
        const coreRoleArn = cdk.Fn.importValue(`mlcc-${profileName}-core-RoleArn`);
        const benchmarkBucket = cdk.Fn.importValue(`mlcc-${profileName}-benchmark-BenchmarkBucket`);

        // CloudWatch Log Group
        const logGroup = new logs.LogGroup(this, 'CiLogGroup', {
            logGroupName: `mlcc-ci-${profileName}`,
            retention: logs.RetentionDays.THREE_MONTHS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // DynamoDB CI Table
        const ciTable = new dynamodb.Table(this, 'CiTable', {
            tableName: `mlcc-ci-table-${profileName}`,
            partitionKey: { name: 'configId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        ciTable.addGlobalSecondaryIndex({
            indexName: 'testStatus-lastTestTimestamp-index',
            partitionKey: { name: 'testStatus', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'lastTestTimestamp', type: dynamodb.AttributeType.STRING },
        });

        // CodeBuild executor role
        const codebuildRole = new iam.Role(this, 'CodeBuildRole', {
            roleName: `mlcc-ci-codebuild-${profileName}-${this.region}`,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });

        codebuildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:Query'],
            resources: [ciTable.tableArn, `${ciTable.tableArn}/index/*`],
        }));

        codebuildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
            resources: [`arn:aws:s3:::${benchmarkBucket}`, `arn:aws:s3:::${benchmarkBucket}/*`],
        }));

        codebuildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
        }));

        // CodeBuild project
        const codebuildProject = new codebuild.Project(this, 'CiExecutor', {
            projectName: `mlcc-ci-executor-${profileName}`,
            role: codebuildRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                computeType: codebuild.ComputeType.MEDIUM,
            },
            timeout: cdk.Duration.minutes(90),
            logging: { cloudWatch: { logGroup } },
        });

        // Outputs
        new cdk.CfnOutput(this, 'CodeBuildProject', {
            value: codebuildProject.projectName,
            exportName: `mlcc-${profileName}-ci-CodeBuildProject`,
        });

        new cdk.CfnOutput(this, 'CiTableName', {
            value: ciTable.tableName,
            exportName: `mlcc-${profileName}-ci-CiTableName`,
        });
    }
}
