// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import CI_BUCKETS from './buckets.json';
import {
    StackBucketDeclarations, bucketDeclaration, declaredBucket, renderBucketName,
} from '../bucket-declarations';

/** The ci stack's bucket declarations (single declared source, R1.2). */
export const BUCKETS: StackBucketDeclarations = CI_BUCKETS;

export interface MlccCiStackProps extends cdk.StackProps {
    profileName: string;
    adoptExistingBuckets?: boolean;
}

/**
 * CI module: DynamoDB table, CodeBuild project, Step Functions orchestrator.
 * Migrated from infra/ci-harness/lib/ci-harness-stack.ts (modular version).
 */
export class MlccCiStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccCiStackProps) {
        super(scope, id, props);

        const { profileName, adoptExistingBuckets } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'ci');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Import cross-stack values from core and benchmark modules
        const coreRoleArn = cdk.Fn.importValue(`mlcc-${profileName}-core-RoleArn`);
        const benchmarkBucket = cdk.Fn.importValue(`mlcc-${profileName}-benchmark-BenchmarkBucket`);

        // ── CodeBuild source bucket — do/submit uploads the project source zip ──
        // Bootstrap-owned; do/ scripts NEVER create buckets. RETAIN so in-flight
        // source archives survive a re-provision. Declared in ./buckets.json; the
        // runner adopts it by reference ONLY while it exists but is not yet a
        // resource of this stack (stack creation; imported right after).
        const sourceBucketName = renderBucketName(
            bucketDeclaration(BUCKETS, 'SourceBucketResource'),
            { account: this.account, region: this.region, profileName },
        );
        const sourceBucket = declaredBucket(this, 'SourceBucketResource', sourceBucketName, adoptExistingBuckets, {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

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
            actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
            resources: [sourceBucket.bucketArn, `${sourceBucket.bucketArn}/*`],
        }));

        codebuildRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
        }));
        // Wave 9 (R7, R11.4): the benchmark writer that CI runs resolves on-demand
        // prices through the Price List API (no resource-level permissions, so
        // '*') and registers / reconciles its Glue partition. Database name comes
        // from the benchmark module's export, not a literal.
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'BenchmarkPriceLookup',
            actions: ['pricing:GetProducts'],
            resources: ['*'],
        }));
        const glueDatabase = cdk.Fn.importValue(`mlcc-${profileName}-benchmark-GlueDatabase`);
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'BenchmarkPartitionRegister',
            actions: ['glue:GetTable', 'glue:GetPartition', 'glue:BatchCreatePartition', 'glue:UpdatePartition'],
            resources: [
                `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
                `arn:${this.partition}:glue:${this.region}:${this.account}:database/${glueDatabase}`,
                `arn:${this.partition}:glue:${this.region}:${this.account}:table/${glueDatabase}/*`,
            ],
        }));

        // CodeBuild project
        const codebuildProject = new codebuild.Project(this, 'CiExecutor', {
            projectName: `mlcc-ci-executor-${profileName}`,
            role: codebuildRole,
            // No source repo — builds are triggered by the CI orchestrator with
            // source/buildspec overrides at runtime. CodeBuild requires a concrete
            // buildSpec when the source is NoSource, so provide a placeholder.
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    build: {
                        commands: ['echo "mlcc CI executor — buildspec provided at runtime by the orchestrator"'],
                    },
                },
            }),
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

        new cdk.CfnOutput(this, 'SourceBucket', {
            value: sourceBucketName,
            exportName: `mlcc-${profileName}-ci-SourceBucket`,
        });
    }
}
