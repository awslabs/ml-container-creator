-- Athena DDL for benchmark_results table
-- Generated from get_parquet_schema() in templates/do/.benchmark_writer.py
-- Partitioned by model/instance/target (Hive-style S3 layout)
--
-- S3 Layout: s3://{bucket}/results/model={model}/instance={instance}/target={target}/
-- Compression: Snappy
-- Format: Parquet (via pyarrow)

CREATE EXTERNAL TABLE IF NOT EXISTS mlcc_ci.benchmark_results (
    -- Identity
    project_name                STRING,

    -- Model + Serving Config (queryable columns)
    model_name                  STRING,
    model_family                STRING      COMMENT 'Derived from model_name (e.g., qwen3, llama3, deepseek-r1)',
    instance_type               STRING,
    deployment_config           STRING,
    deployment_target           STRING,
    quantization                STRING,
    tensor_parallel_degree      INT,

    -- Hardware metadata (resolved from servers/lib/catalogs/instances.json at write time)
    instance_family             STRING      COMMENT 'Derived from instance_type (e.g., g5, g6e, p5)',
    gpu_count                   INT         COMMENT 'Number of GPUs on instance; NULL if instance not in catalog',
    gpu_type                    STRING      COMMENT 'GPU model name (e.g., NVIDIA A10G); NULL if instance not in catalog',
    gpu_memory_gb               DOUBLE      COMMENT 'Per-GPU memory in GB; NULL if instance not in catalog',

    -- Configuration dimensions (top-level for queryability)
    max_model_len               INT         COMMENT 'Maximum context length (KV cache allocation cap); NULL if not set',
    enable_lora                 BOOLEAN     COMMENT 'Whether LoRA adapter is enabled',
    kv_cache_dtype              STRING      COMMENT 'KV cache data type (auto, fp16, fp8, int8); NULL if not set',

    -- Full serving config (extensible JSON blob)
    serving_config              STRING      COMMENT 'JSON blob with all serving configuration parameters',

    -- Workload
    workload                    STRING,
    concurrency                 INT,
    input_tokens_mean           INT,
    output_tokens_mean          INT,
    streaming                   BOOLEAN,
    duration_seconds            INT,

    -- Rich Metrics: Throughput
    request_throughput_rps      DOUBLE,
    total_token_throughput_tps  DOUBLE,
    output_token_throughput_tps DOUBLE,
    request_count               DOUBLE,

    -- Rich Metrics: TTFT (Time To First Token)
    ttft_avg_ms                 DOUBLE,
    ttft_p50_ms                 DOUBLE,
    ttft_p90_ms                 DOUBLE,
    ttft_p99_ms                 DOUBLE,

    -- Rich Metrics: ITL (Inter-Token Latency)
    itl_avg_ms                  DOUBLE,
    itl_p50_ms                  DOUBLE,
    itl_p90_ms                  DOUBLE,
    itl_p99_ms                  DOUBLE,

    -- Rich Metrics: End-to-End Latency
    e2e_latency_avg_ms          DOUBLE,
    e2e_latency_p50_ms          DOUBLE,
    e2e_latency_p90_ms          DOUBLE,
    e2e_latency_p99_ms          DOUBLE,

    -- Rich Metrics: Prefill and Output Token Throughput
    prefill_tps_avg             DOUBLE,
    prefill_tps_p50             DOUBLE,
    output_token_tps_avg        DOUBLE,
    output_token_tps_p50        DOUBLE,
    output_token_tps_p90        DOUBLE,

    -- Rich Metrics: Time To Second Token
    ttst_p50_ms                 DOUBLE,
    ttst_p90_ms                 DOUBLE,

    -- Rich Metrics: Sequence Lengths
    output_sequence_length_avg  DOUBLE,
    input_sequence_length_avg   DOUBLE,

    -- Rich Metrics: Error Rate and Cost
    error_rate                  DOUBLE,
    cost_per_1m_tokens          DOUBLE      COMMENT 'Estimated USD cost per 1M output tokens; NULL if instance pricing unknown',
    benchmark_duration_sec      DOUBLE,

    -- Run Metadata
    run_type                    STRING,
    benchmark_job_name          STRING,
    mcc_version                 STRING,
    run_timestamp               STRING      COMMENT 'ISO 8601 UTC timestamp of the benchmark run',
    region                      STRING,
    adapter_name                STRING      COMMENT 'LoRA adapter name; empty string if base model'
)
PARTITIONED BY (
    model   STRING  COMMENT 'Model name with / replaced by _ (e.g., Qwen_Qwen3-4B)',
    instance STRING COMMENT 'SageMaker instance type (e.g., ml.g5.xlarge)',
    target  STRING  COMMENT 'Deployment target (e.g., realtime-inference)'
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
STORED AS INPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat'
         OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat'
LOCATION 's3://${BENCHMARK_BUCKET}/results/'
TBLPROPERTIES (
    'classification' = 'parquet',
    'parquet.compression' = 'SNAPPY',
    'has_encrypted_data' = 'false'
);

-- After writing new data, either:
-- 1. register_partition() in .benchmark_writer.py does this automatically via Glue API
-- 2. Or run MSCK REPAIR TABLE as a fallback:
-- MSCK REPAIR TABLE mlcc_ci.benchmark_results;

-- Example queries:
--
-- Cost-efficiency leaderboard by model family:
-- SELECT model_family, instance_type, gpu_count, gpu_type,
--        AVG(cost_per_1m_tokens) as avg_cost,
--        AVG(request_throughput_rps) as avg_throughput
-- FROM mlcc_ci.benchmark_results
-- WHERE cost_per_1m_tokens IS NOT NULL
-- GROUP BY model_family, instance_type, gpu_count, gpu_type
-- ORDER BY avg_cost ASC;
--
-- Hardware utilization analysis:
-- SELECT instance_family, gpu_count, gpu_memory_gb,
--        quantization, tensor_parallel_degree,
--        AVG(output_token_throughput_tps) as avg_output_tps,
--        AVG(ttft_p50_ms) as avg_ttft_p50
-- FROM mlcc_ci.benchmark_results
-- WHERE gpu_count IS NOT NULL
-- GROUP BY instance_family, gpu_count, gpu_memory_gb, quantization, tensor_parallel_degree;
