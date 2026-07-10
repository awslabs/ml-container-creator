// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

export interface MlccBenchmarkStackProps extends cdk.StackProps {
    profileName: string;
    adoptExistingBuckets?: boolean;
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

        const { profileName, adoptExistingBuckets } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'benchmark');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        const bucketName = `mlcc-benchmark-results-${this.account}-${this.region}`;

        // S3 bucket for benchmark results (RETAIN on delete — data is valuable).
        // Because the bucket is retained on teardown, a later re-provision would
        // collide with the existing bucket. When adoptExistingBuckets is set
        // (the runner detected the bucket already exists via head-bucket), adopt
        // it by reference instead of creating it.
        this.benchmarkBucket = adoptExistingBuckets
            ? s3.Bucket.fromBucketName(this, 'BenchmarkBucket', bucketName)
            : new s3.Bucket(this, 'BenchmarkBucket', {
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

        // Glue table for benchmark results (Parquet, Hive-partitioned)
        new glue.CfnTable(this, 'BenchmarkResultsTable', {
            catalogId: this.account,
            databaseName: 'mlcc_ci',
            tableInput: {
                name: 'benchmark_results',
                description: 'Benchmark results for ml-container-creator projects',
                tableType: 'EXTERNAL_TABLE',
                parameters: {
                    'classification': 'parquet',
                    'parquet.compression': 'SNAPPY',
                    'has_encrypted_data': 'false',
                },
                storageDescriptor: {
                    location: `s3://${bucketName}/results/`,
                    inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                    },
                    columns: [
                        { name: 'project_name', type: 'string' },
                        { name: 'model_name', type: 'string' },
                        { name: 'model_family', type: 'string', comment: 'Derived from model_name (e.g., qwen3, llama3, deepseek-r1)' },
                        { name: 'instance_type', type: 'string' },
                        { name: 'deployment_config', type: 'string' },
                        { name: 'deployment_target', type: 'string' },
                        { name: 'quantization', type: 'string' },
                        { name: 'tensor_parallel_degree', type: 'int' },
                        { name: 'instance_family', type: 'string', comment: 'Derived from instance_type (e.g., g5, g6e, p5)' },
                        { name: 'gpu_count', type: 'int', comment: 'Number of GPUs on instance' },
                        { name: 'gpu_type', type: 'string', comment: 'GPU model name (e.g., NVIDIA A10G)' },
                        { name: 'gpu_memory_gb', type: 'double', comment: 'Per-GPU memory in GB' },
                        { name: 'max_model_len', type: 'int', comment: 'Maximum context length (KV cache allocation cap)' },
                        { name: 'enable_lora', type: 'boolean', comment: 'Whether LoRA adapter is enabled' },
                        { name: 'kv_cache_dtype', type: 'string', comment: 'KV cache data type (auto, fp16, fp8, int8)' },
                        { name: 'serving_config', type: 'string', comment: 'JSON blob with all serving configuration parameters' },
                        { name: 'workload', type: 'string' },
                        { name: 'concurrency', type: 'int' },
                        { name: 'input_tokens_mean', type: 'int' },
                        { name: 'output_tokens_mean', type: 'int' },
                        { name: 'streaming', type: 'boolean' },
                        { name: 'duration_seconds', type: 'int' },
                        { name: 'request_throughput_rps', type: 'double' },
                        { name: 'total_token_throughput_tps', type: 'double' },
                        { name: 'output_token_throughput_tps', type: 'double' },
                        { name: 'request_count', type: 'double' },
                        { name: 'ttft_avg_ms', type: 'double' },
                        { name: 'ttft_p50_ms', type: 'double' },
                        { name: 'ttft_p90_ms', type: 'double' },
                        { name: 'ttft_p99_ms', type: 'double' },
                        { name: 'itl_avg_ms', type: 'double' },
                        { name: 'itl_p50_ms', type: 'double' },
                        { name: 'itl_p90_ms', type: 'double' },
                        { name: 'itl_p99_ms', type: 'double' },
                        { name: 'e2e_latency_avg_ms', type: 'double' },
                        { name: 'e2e_latency_p50_ms', type: 'double' },
                        { name: 'e2e_latency_p90_ms', type: 'double' },
                        { name: 'e2e_latency_p99_ms', type: 'double' },
                        { name: 'prefill_tps_avg', type: 'double' },
                        { name: 'prefill_tps_p50', type: 'double' },
                        { name: 'output_token_tps_avg', type: 'double' },
                        { name: 'output_token_tps_p50', type: 'double' },
                        { name: 'output_token_tps_p90', type: 'double' },
                        { name: 'ttst_p50_ms', type: 'double' },
                        { name: 'ttst_p90_ms', type: 'double' },
                        { name: 'output_sequence_length_avg', type: 'double' },
                        { name: 'input_sequence_length_avg', type: 'double' },
                        { name: 'error_rate', type: 'double' },
                        { name: 'cost_per_1m_tokens', type: 'double', comment: 'Estimated USD cost per 1M output tokens' },
                        { name: 'benchmark_duration_sec', type: 'double' },
                        { name: 'run_type', type: 'string' },
                        { name: 'benchmark_job_name', type: 'string' },
                        { name: 'mcc_version', type: 'string' },
                        { name: 'run_timestamp', type: 'string', comment: 'ISO 8601 UTC timestamp of the benchmark run' },
                        { name: 'region', type: 'string' },
                        { name: 'adapter_name', type: 'string', comment: 'LoRA adapter name; empty string if base model' },
                    ],
                },
                partitionKeys: [
                    { name: 'model', type: 'string', comment: 'Model name with / replaced by _' },
                    { name: 'instance', type: 'string', comment: 'SageMaker instance type' },
                    { name: 'target', type: 'string', comment: 'Deployment target (e.g., realtime-inference)' },
                ],
            },
        }).addDependency(this.glueDatabase);

        // Outputs
        new cdk.CfnOutput(this, 'BenchmarkBucketOutput', {
            value: bucketName,
            exportName: `mlcc-${profileName}-benchmark-BenchmarkBucket`,
        });

        new cdk.CfnOutput(this, 'GlueDatabaseOutput', {
            value: 'mlcc_ci',
            exportName: `mlcc-${profileName}-benchmark-GlueDatabase`,
        });
    }
}
