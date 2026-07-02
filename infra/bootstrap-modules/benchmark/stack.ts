// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

export interface MlccBenchmarkStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * Benchmark module: S3 bucket for benchmark results + Glue database for Athena queries.
 * Handles existing buckets gracefully (adoptExisting pattern).
 */
export class MlccBenchmarkStack extends cdk.Stack {
    public readonly benchmarkBucket: s3.IBucket;
    public readonly glueDatabase: glue.CfnDatabase;

    constructor(scope: Construct, id: string, props: MlccBenchmarkStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'benchmark');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        const bucketName = `mlcc-benchmark-results-${this.account}-${this.region}`;

        // S3 bucket for benchmark results (RETAIN on delete — data is valuable)
        this.benchmarkBucket = new s3.Bucket(this, 'BenchmarkBucket', {
            bucketName,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Glue database for Athena queries over benchmark results
        this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
            catalogId: this.account,
            databaseInput: {
                name: 'mlcc_ci',
                description: 'Benchmark results for ml-container-creator CI pipeline',
            },
        });

        // Outputs
        new cdk.CfnOutput(this, 'BenchmarkBucket', {
            value: bucketName,
            exportName: `mlcc-${profileName}-benchmark-BenchmarkBucket`,
        });

        new cdk.CfnOutput(this, 'GlueDatabase', {
            value: 'mlcc_ci',
            exportName: `mlcc-${profileName}-benchmark-GlueDatabase`,
        });
    }
}
