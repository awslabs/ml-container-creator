# Benchmarking

Measure LLM endpoint performance using SageMaker AI Benchmarking (NVIDIA AIPerf). The `do/benchmark` script creates a workload configuration, launches a benchmark job, polls for completion, and displays results — all in one command.

## Prerequisites

| Requirement | Details |
|---|---|
| Endpoint status | Must be `InService` (run `./do/deploy` first) |
| Architecture | Transformers or Diffusors only (HTTP and Triton not supported) |
| Deployment target | `realtime-inference` only (HyperPod EKS is not supported) |
| Python dependencies | Installed automatically via `npm install` (see `requirements.txt`) |
| AWS credentials | Must be configured for the deployment region |
| Bootstrap | Recommended — provides the IAM role with benchmarking permissions and S3 bucket for results |

## Quick Start

Generate a project with benchmarking enabled:

```bash
ml-container-creator vllm-benchmark-demo \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --deployment-target=realtime-inference \
  --instance-type=ml.g5.2xlarge \
  --include-benchmark \
  --skip-prompts
```

Deploy and benchmark:

```bash
./do/build && ./do/push && ./do/deploy
./do/benchmark --workload multi_turn_chat
```

!!! note "No benchmark configuration in `do/config`"
    All benchmark parameters are resolved at runtime — from the workload-picker MCP server (workload profile) and the bootstrap profile (S3 buckets). The `do/config` file contains only project identity (endpoint name, model, instance type, etc.).

## Usage

```bash
./do/benchmark --workload <name> [--status] [--ic <name>] [--adapter <name>] [--force] [--clean]
```

| Flag | Description |
|---|---|
| `--workload <name>` | **Required.** Workload profile from the workload-picker MCP server |
| `--status` | Check job status; if completed, download results and write to Athena |
| `--ic <name>` | Benchmark a specific inference component (from `do/ic/<name>.conf`) |
| `--adapter <name>` | Benchmark a specific LoRA adapter IC (from `do/adapters/<name>.conf`) |
| `--force` | Create a new benchmark job even if one is already running |
| `--clean` | Delete workload config and benchmark job after displaying results |
| `--no-stale-warning` | Suppress schema registry staleness warning |

### IC Resolution

The benchmark targets a specific inference component:

1. `--adapter <name>` — Uses `ADAPTER_IC_NAME` from `do/adapters/<name>.conf`
2. `--ic <name>` — Uses `IC_DEPLOYED_NAME` from `do/ic/<name>.conf`
3. No flag — Uses the first IC in `do/ic/` alphabetically, or falls back to legacy config

## Workload Profiles

Benchmark parameters are resolved from named **workload profiles** served by the workload-picker MCP server. Each profile defines a realistic traffic pattern:

| Workload | Concurrency | Input Tokens | Output Tokens | Streaming | Description |
|---|---|---|---|---|---|
| `multi_turn_chat` | 10 | 550 | 150 | ✅ | Multi-turn conversational workload |
| `rag_document_qa` | 8 | 2048 | 256 | ✅ | RAG with long context retrieval |
| `agent_tool_calling` | 4 | 800 | 100 | ❌ | Tool-calling agent (structured output) |
| `long_context_scaling` | 2 | 8192 | 512 | ✅ | Long-context stress test |
| `production_traffic_mix` | 16 | 1024 | 200 | ✅ | Simulated production traffic mix |
| `shared_system_prompt` | 12 | 300 | 150 | ✅ | Short requests with shared system prompt |

List available workloads:

```bash
# Via MCP (if workload-picker server is running)
mcc mcp call workload-picker list_workloads

# Or inspect the catalog directly
cat servers/workload-picker/workload-profiles.json
```

### How Resolution Works

When you run `./do/benchmark --workload multi_turn_chat`:

1. **Workload params** — `do/benchmark` queries the workload-picker MCP server for the named profile, which returns concurrency, input/output token counts, streaming mode, and request count
2. **S3 paths** — Read from the bootstrap profile (`~/.ml-container-creator/config.json`): `benchmarkS3Bucket` for raw results, `ciBenchmarkResultsBucket` for Athena Parquet
3. **Job names** — Derived at runtime: `${PROJECT_NAME}-benchmark-${timestamp}`
4. **Project identity** — From `do/config`: `PROJECT_NAME`, `ENDPOINT_NAME`, `HF_MODEL_ID`, `INSTANCE_TYPE`, `AWS_REGION`
5. **Tokenizer** — AIPerf uses `HF_MODEL_ID` (the original HuggingFace model identifier) for client-side tokenization. This is distinct from `MODEL_NAME`, which may be rewritten to an S3 URI after `do/stage` runs.

If the MCP server is unavailable, defaults are applied: concurrency=10, input=550, output=150, streaming=true.

## Metrics

The benchmark reports:

| Metric | Description |
|---|---|
| **Request throughput** (req/s) | Sustained requests per second |
| **Output token throughput** (tokens/s) | Total output tokens generated per second |
| **Request latency** (P50/P90/P99) | End-to-end request latency |
| **TTFT** (P50/P90/P99) | Time to first token (streaming latency) |
| **ITL** (P50/P90/P99) | Inter-token latency (generation speed) |

## Generation-Time Configuration

At project generation, benchmarking is opt-in with a single boolean flag:

```bash
ml-container-creator my-project \
  --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B \
  --instance-type=ml.g5.xlarge \
  --include-benchmark \
  --skip-prompts
```

| Parameter | CLI Flag | Default | Description |
|---|---|---|---|
| `includeBenchmark` | `--include-benchmark` | `false` | Include the `do/benchmark` script in the generated project |

All other benchmark parameters (concurrency, tokens, streaming) are resolved at **runtime** from the workload profile — not baked into the project at generation time.

## Idempotency

`do/benchmark` tracks its state in `do/config` and is designed for interrupted workflows:

- The benchmark job name is persisted to `do/config` after creation.
- Use `--force` to create a new job even if one exists.

### Interrupting a Running Benchmark

You can safely **Ctrl+C** during the polling loop. The benchmark job continues running on SageMaker — only the local monitoring is interrupted:

```
⚠️  Interrupted — job continues running in background
   Job: qwen3-06b-test-benchmark-20260619-105120

   Check status:      ./do/benchmark --status
```

### Checking Status & Completing Athena Writes

After interrupting (or if you want to check a job's progress), use `--status`:

```bash
./do/benchmark --status
```

This will:

1. Query the tracked benchmark job's status
2. If **Completed**: download results from S3 (if not already local) and write to Athena
3. If **InProgress**: display current status and remind you to check again later
4. If **Failed**: display the failure reason

This is the recommended workflow for long-running benchmarks:

```bash
./do/benchmark --workload multi_turn_chat   # Start the job, Ctrl+C when you want
./do/benchmark --status                     # Check later; auto-resolves on completion
```

## Cleanup

```bash
# Delete workload config and benchmark jobs only
./do/benchmark --clean

# Delete everything (endpoint + benchmark resources)
./do/clean all
```

## Interpreting Results

### Concurrency Tuning

Use different workload profiles to test varying concurrency levels, or override with multiple runs:

| Concurrency | Effect |
|---|---|
| 1–4 | Baseline latency (agent/tool-calling patterns) |
| 8–12 | Typical production load (chat, RAG) |
| 16–32 | High-throughput stress test |
| 64+ | Overload test (queue buildup) |

### Key Indicators

- **TTFT > 500ms** — Model may need a smaller batch size or faster instance
- **ITL > 50ms** — Generation is slow; consider tensor parallelism or a faster backend
- **Throughput plateau** — You've hit GPU saturation; scale horizontally or upgrade instance

### Comparing Configurations

Run the same workload across different configurations to find the optimal setup:

```bash
# Same model, different instance types
cd bench-g5-xlarge && ./do/benchmark --workload production_traffic_mix
cd bench-g5-2xlarge && ./do/benchmark --workload production_traffic_mix
```

Use `do/register` after each benchmark to record results in the deployment registry for comparison.

## Adapter Benchmarking

Benchmark a specific LoRA adapter to compare against the base model:

```bash
# Benchmark base model
./do/benchmark --workload multi_turn_chat

# Benchmark adapter
./do/benchmark --workload multi_turn_chat --adapter my-sft

# Compare results (both recorded in benchmark history)
```

## Results Persistence

When benchmark infrastructure is provisioned (`bootstrap --benchmark-infra`), results are automatically:

1. **Written to S3** as aggregate JSON (`profile_export_aiperf.json`) in the benchmark S3 bucket
2. **Converted to Parquet** and written to the CI benchmark results bucket (partitioned by model/instance/target)
3. **Registered in Athena** for SQL-based analysis across all runs

The S3 buckets are resolved from the bootstrap profile config:

| Profile Key | Purpose |
|---|---|
| `benchmarkS3Bucket` | Raw benchmark outputs (`s3://{bucket}/{project}/`) |
| `ciBenchmarkResultsBucket` | Athena-queryable Parquet results |

If these keys are not set (benchmark infra not provisioned), results are displayed locally only — no S3 writes occur.

## Integration with CI

In CI pipelines, benchmark results can be registered for regression detection:

```bash
./do/benchmark --workload production_traffic_mix
./do/register --ci --notes "Nightly benchmark run"
```

See [CI Integration](ci-integration.md) for automated validation workflows and the two-stage pipeline.


## Pre-staging Large Models (`do/stage`)

For models >30B parameters, downloading from HuggingFace at deploy time can cause 30-60 minute startup delays or timeout failures. Pre-stage weights to your MCC S3 bucket first:

```bash
./do/stage              # Default: SageMaker Processing Job (no local disk usage)
./do/stage --local      # Download locally then sync to S3 (legacy behavior)
```

This downloads model weights from HuggingFace and uploads to `s3://{bucket}/{project}/models/{model-slug}/` (the model name is sanitized — `/` is replaced with `-` for safe S3 paths). Subsequent deploys load from S3 (seconds instead of minutes).

After staging, `MODEL_NAME` in `do/config` is updated to the S3 URI. The original HuggingFace identifier is preserved as `HF_MODEL_ID` — this is used by `do/benchmark` for tokenizer resolution and by the benchmark writer for Athena partition paths.
The script is idempotent — if weights are already staged, it skips the download.

For models >500GB, use `--submit` to run as a SageMaker Processing Job with 2TB attached storage:

```bash
./do/stage --submit
```

!!! tip "S3 Model URIs"
    You can also generate a project directly with an S3 model URI: `--model-name s3://bucket/models/my-model/`. This skips HuggingFace entirely — useful when weights are pre-staged in a shared team bucket.

## Deploying on Reserved Capacity (FTP)

If you have a Flexible Training Plan (FTP) or capacity reservation, pass the ARN at generation time:

```bash
ml-container-creator my-benchmark-project \
  --model-name s3://my-bucket/models/gemma-4-31b/ \
  --instance-type ml.p6-b200.48xlarge \
  --capacity-reservation-arn "arn:aws:sagemaker:us-east-2:ACCOUNT:training-plan/tp-XXX" \
  --include-benchmark \
  --skip-prompts
```

The endpoint will deploy exclusively on reserved capacity. FTPs are time-bound — ensure your reservation window covers the full benchmark duration (deployment + warm-up + all concurrency levels).

The instance-picker and endpoint-sizer MCP servers are FTP-aware — during interactive generation, they surface available capacity reservations in your account/region.
