// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';
import BENCHMARK_BUCKETS from './buckets.json';
import {
    StackBucketDeclarations, bucketDeclaration, declaredBucket, renderBucketName,
} from '../bucket-declarations';

/** The benchmark stack's bucket declarations (single declared source, R1.2). */
export const BUCKETS: StackBucketDeclarations = BENCHMARK_BUCKETS;

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

        const bucketName = renderBucketName(
            bucketDeclaration(BUCKETS, 'BenchmarkBucket'),
            { account: this.account, region: this.region, profileName },
        );

        // S3 bucket for benchmark results (RETAIN on delete — data is valuable).
        // Declared in ./buckets.json. The runner adopts it by reference ONLY while it
        // exists but is not yet a resource of this stack, i.e. while the stack is
        // first created (the runner imports it in the same run); a bucket this stack
        // owns is always kept as a resource.
        this.benchmarkBucket = declaredBucket(this, 'BenchmarkBucket', bucketName, adoptExistingBuckets, {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
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
                        { name: 'cost_per_1m_tokens', type: 'double', comment: 'USD per 1M output tokens = price_usd_per_hour x instance_count x 1e6 / (3600 x output tok/s) at the measured concurrency; NULL when price or throughput is missing' },
                        { name: 'benchmark_duration_sec', type: 'double' },
                        { name: 'run_type', type: 'string' },
                        { name: 'benchmark_job_name', type: 'string' },
                        { name: 'run_name', type: 'string', comment: 'Human-readable run identifier: petname_workload_maxconcurrency (e.g. coral-hawk_sample_2)' },
                        { name: 'mcc_version', type: 'string' },
                        { name: 'run_timestamp', type: 'string', comment: 'ISO 8601 UTC timestamp of the benchmark run' },
                        { name: 'region', type: 'string' },
                        { name: 'adapter_name', type: 'string', comment: 'LoRA adapter name; empty string if base model' },
                        { name: 'gpu_utilization_avg', type: 'double', comment: 'Average GPU compute utilization (0-100) over benchmark window; Phase 1 CloudWatch OTel' },
                        { name: 'gpu_utilization_max', type: 'double', comment: 'Peak GPU compute utilization (0-100); Phase 1 CloudWatch OTel' },
                        { name: 'gpu_memory_util_avg', type: 'double', comment: 'Average GPU memory copy utilization (0-100); Phase 1 CloudWatch OTel' },
                        // BL101 R5: writer emits these two columns but the DDL previously omitted
                        // them. NOTE (migration): this CfnTable owns the full TableInput, so
                        // CloudFormation re-evaluates the column list on every template submit and
                        // would revert an out-of-band ALTER TABLE. Roll columns out ONLY by editing
                        // this list and running `bootstrap update` of the benchmark module.
                        { name: 'gpu_memory_used_avg_gb', type: 'double', comment: 'Avg GPU memory used (GB); Phase 1 CloudWatch OTel' },
                        { name: 'queue_depth_waiting_max', type: 'double', comment: 'Peak waiting-request queue depth; Phase 2 engine metrics' },
                        { name: 'kv_cache_util_avg', type: 'double', comment: 'Average KV cache utilization (0-1); Phase 1 OTel (KVCacheUtilization) or Phase 2 engine metrics' },
                        { name: 'kv_cache_util_max', type: 'double', comment: 'Peak KV cache utilization (0-1)' },
                        { name: 'prefix_cache_hit_rate', type: 'double', comment: 'Prefix/prompt cache hit ratio (0-1); Phase 2 engine /metrics only — not available via CloudWatch' },
                        { name: 'queue_depth_waiting_avg', type: 'double', comment: 'Average number of waiting requests; Phase 1 OTel (QueueDepth) or Phase 2 engine metrics' },
                        { name: 'queue_depth_running_avg', type: 'double', comment: 'Average number of actively running requests; Phase 2 engine metrics only' },
                        { name: 'metrics_source', type: 'string', comment: 'Provenance of GPU/engine metrics: cloudwatch | engine_metrics | both | none' },
                        // ── Wave 9 (append-only; must match PARQUET_COLUMNS in
                        // templates/do/.benchmark_writer.py and docs/athena-benchmark-ddl.sql —
                        // test/unit/test_benchmark_schema_drift.py). Old Parquet files read NULL.
                        // BL128 curated AIPerf time-weighted aggregates (profile_export_aiperf.json)
                        { name: 'effective_concurrency_avg', type: 'double', comment: 'AIPerf effective (time-weighted) concurrency, avg' },
                        { name: 'effective_concurrency_p90', type: 'double', comment: 'AIPerf effective concurrency, p90' },
                        { name: 'effective_total_tps_avg', type: 'double', comment: 'AIPerf effective total throughput tokens/s, avg' },
                        { name: 'effective_total_tps_p90', type: 'double', comment: 'AIPerf effective total throughput tokens/s, p90' },
                        { name: 'effective_decode_tps_avg', type: 'double', comment: 'AIPerf effective decode throughput tokens/s, avg' },
                        { name: 'effective_decode_tps_p90', type: 'double', comment: 'AIPerf effective decode throughput tokens/s, p90' },
                        { name: 'effective_prefill_tps_avg', type: 'double', comment: 'AIPerf effective prefill throughput tokens/s, avg' },
                        { name: 'effective_prefill_tps_p90', type: 'double', comment: 'AIPerf effective prefill throughput tokens/s, p90' },
                        { name: 'active_decode_tps_avg', type: 'double', comment: 'AIPerf active (decode in flight) throughput tokens/s, avg' },
                        { name: 'active_decode_tps_p90', type: 'double', comment: 'AIPerf active decode throughput tokens/s, p90' },
                        { name: 'active_prefill_tps_avg', type: 'double', comment: 'AIPerf active (prefill in flight) throughput tokens/s, avg' },
                        { name: 'active_prefill_tps_p90', type: 'double', comment: 'AIPerf active prefill throughput tokens/s, p90' },
                        { name: 'tokens_in_flight_avg', type: 'double', comment: 'AIPerf tokens in flight, avg' },
                        { name: 'tokens_in_flight_p90', type: 'double', comment: 'AIPerf tokens in flight, p90' },
                        { name: 'effective_latency_avg_ms', type: 'double', comment: 'AIPerf effective (coordinated-omission-aware) latency ms, avg' },
                        { name: 'effective_latency_p90_ms', type: 'double', comment: 'AIPerf effective latency ms, p90' },
                        { name: 'aiperf_version', type: 'string', comment: 'AIPerf version that produced the run (profile_export_aiperf.json)' },
                        { name: 'spec_decode_acceptance_rate', type: 'double', comment: 'Speculative-decoding acceptance rate 0-1 over the run window; NULL when not enabled' },
                        // Cost inputs (auditable) + Bedrock comparison
                        { name: 'price_usd_per_hour', type: 'double', comment: 'On-demand USD/hour used for cost_per_1m_tokens' },
                        { name: 'price_source', type: 'string', comment: 'pricing-api | pricing-api-cache | snapshot (API-generated); NULL when unresolved' },
                        { name: 'price_as_of', type: 'string', comment: 'ISO 8601 UTC retrieval time of the price' },
                        { name: 'price_component', type: 'string', comment: 'Price List component (Hosting | AsyncInf | BatchTransform | Cluster) or AmazonEC2' },
                        { name: 'instance_count', type: 'int', comment: 'Billed instances: endpoint CurrentInstanceCount, or nodes occupied by replicas' },
                        { name: 'bedrock_model_id', type: 'string', comment: 'Live-verified Bedrock equivalent; NULL when none' },
                        { name: 'bedrock_cost_per_1m_tokens', type: 'double', comment: 'Bedrock on-demand USD per 1M output tokens at the measured input:output ratio' },
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
