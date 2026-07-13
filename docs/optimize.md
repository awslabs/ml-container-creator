# Optimization

`do/optimize` queries your own benchmark history to recommend proven configurations for your model and instance. It reads `do/config` and `do/ic/default.conf`, queries the Athena benchmark table for configurations that have outperformed your current settings, and shows ranked recommendations with confidence scores. An optional Bedrock analysis explains the tradeoffs in plain language.

For situations with no benchmark history (new instance type, new model), `do/optimize --goal` invokes SageMaker AI Inference Recommendations, which runs live benchmarks and returns results.

---

## Athena Recommendations

The primary optimization path queries your existing benchmark data in Athena. No live benchmarking required — results appear immediately if benchmark data exists for your model and instance.

### Quick start

```bash
# See recommendations (dry-run by default)
./do/optimize

# Apply recommended changes to do/ic/default.conf
./do/optimize --apply

# Optimize for latency instead of throughput
./do/optimize --metric ttft_p90_ms

# Raw JSON output for scripting
./do/optimize --json | jq '.recommendations[0]'
```

### How it works

1. Reads current config from `do/config` and `do/ic/default.conf` (quantization, tensor parallelism, max_model_len, kv_cache_dtype)
2. Queries Athena `mlcc_ci.benchmark_results` for records matching your model and instance
3. Falls back to model family, then instance family if no exact match
4. Ranks configuration changes by expected improvement on the target metric
5. Displays a recommendation table with confidence levels (HIGH ≥5 runs, MEDIUM 2–4, LOW 1 run or family match)
6. Optionally calls Bedrock for a plain-language analysis of tradeoffs

### Flags

| Flag | Description |
|------|-------------|
| `--apply` | Write recommended changes to `do/ic/default.conf` (creates `.bak` backup) |
| `--json` | Output raw recommendation JSON for scripting |
| `--metric <name>` | Target metric: `output_token_throughput_tps` (default), `ttft_p90_ms`, `itl_p90_ms`, `cost_per_1m_tokens` |
| `--no-bedrock` | Skip Bedrock analysis (faster, no cost) |

### Confidence levels

| Level | Criteria |
|-------|---------|
| HIGH | ≥5 matching benchmark runs with consistent results (CV < 0.15) |
| MEDIUM | 2–4 runs, or coefficient of variation ≥ 0.15 |
| LOW | 1 run, or extrapolated from similar model family / instance family |

### No benchmark data

If no Athena records exist for your model and instance, `do/optimize` prints "No recommendations available" and exits 0. Run `./do/benchmark --workload multi_turn_chat` first to generate baseline data, then re-run `do/optimize`.

---

## SageMaker AI Inference Recommendations

!!! info "When to use this path"
    `--goal` invokes the SageMaker AI Inference Recommendations API, which runs live benchmarks on candidate instances. Use this when you have no prior benchmark history for a configuration. Requires a registered model package ARN and takes 15–60 minutes. Cost depends on candidate instances.

### Prerequisites

| Requirement | Details |
|---|---|
| **MODEL_NAME** | Must be set in `do/config` (HuggingFace model ID or S3 path) |
| **AWS CLI v2** | Required for inference recommendations API |
| **IAM permissions** | `sagemaker:CreateAIRecommendationJob`, `CreateAIWorkloadConfig`, `DescribeAIRecommendationJob` (included in bootstrap role) |
| **Framework** | `transformers` only (uses `VLLM` inference specification) |

### Usage

```bash
./do/optimize --goal <cost|latency|throughput> [--instances type1,type2] [--force]
```

### Flags

| Flag | Required | Description |
|---|---|---|
| `--goal` | Yes | Optimization goal: `cost`, `latency`, or `throughput` |
| `--instances` | No | Comma-separated instance types to evaluate (max 3) |
| `--force` | No | Create a new job even if one already exists |

### Instance Resolution

If `--instances` is not provided, `do/optimize` resolves instance types from (in priority order):

1. `INSTANCE_POOLS` in `do/config` (extracts instance types from JSON)
2. `INSTANCE_TYPE` in `do/config`
3. Live endpoint query (for external endpoints)

### What It Does

1. **Creates a workload config** — defines the traffic pattern (concurrency, input/output tokens, streaming) based on your benchmark settings
2. **Creates an AI Recommendation Job** — submits the model + workload + candidate instances to SageMaker AI
3. **Polls for completion** — waits up to 60 minutes (polling every 30s)
4. **Displays ranked results** — shows TTFT, inter-token latency, throughput, and cost for each instance type
5. **Offers interactive choices**:
   - Deploy top recommendation (updates `INSTANCE_TYPE` and `MODEL_PACKAGE_ARN` in `do/config`)
   - Set up instance pools (writes `INSTANCE_POOLS` for heterogeneous deployments)
   - Save for later (stores `OPTIMIZE_MODEL_PACKAGE_ARN` in `do/config`)

### Examples

```bash
# Optimize for throughput using the instance type already in do/config
./do/optimize --goal throughput

# Compare specific instance types for cost
./do/optimize --goal cost --instances ml.g6e.48xlarge,ml.p5.48xlarge

# Re-run optimization (creates new job, ignores previous)
./do/optimize --goal latency --force
```

---

## Idempotency

`do/optimize` is idempotent. If `OPTIMIZE_JOB_NAME` is already set in `do/config` and the job is still running, re-running without `--force` will resume waiting for the existing job rather than creating a duplicate.

---

## Workload Parameters

The workload config is derived from your benchmark settings:

| Parameter | Source | Default |
|---|---|---|
| Concurrency | `BENCHMARK_CONCURRENCY` | 1 |
| Input tokens | `BENCHMARK_INPUT_TOKENS_MEAN` | 256 |
| Output tokens | `BENCHMARK_OUTPUT_TOKENS_MEAN` | 256 |
| Streaming | Always enabled | `true` |

To get accurate recommendations, set your benchmark parameters to match your production traffic pattern before running `do/optimize`.

---

## Output

Results are displayed in a formatted table:

```
╔══════════════════════════════════════════════════════════════════════════╗
║              SageMaker AI Inference Recommendations                     ║
╠══════════════════════════════════════════════════════════════════════════╣
║  Job: my-project-optimize-20260608-091500
║  Goal: throughput
║  Model: Qwen/Qwen3-4B
╠══════════════════════════════════════════════════════════════════════════╣
║
║  #1 ← TOP
║  Instance Type:    ml.g6e.48xlarge
║  TTFT (ms):        45
║  ITL (ms):         8
║  Throughput:       1250
║  Cost:             $4.85/hr
║
║  #2
║  Instance Type:    ml.g5.xlarge
║  TTFT (ms):        120
║  ITL (ms):         15
║  Throughput:       450
║  Cost:             $1.41/hr
╚══════════════════════════════════════════════════════════════════════════╝
```

---

## Config Variables Written

After completion, `do/optimize` may write these variables to `do/config`:

| Variable | When | Purpose |
|---|---|---|
| `OPTIMIZE_JOB_NAME` | Always (on job creation) | Idempotency — tracks the active job |
| `OPTIMIZE_MODEL_PACKAGE_ARN` | On "deploy" or "save" | Model package from recommendations |
| `OPTIMIZE_INFERENCE_SPEC` | On "deploy" | Inference specification name |
| `INSTANCE_TYPE` | On "deploy" | Updated to the recommended instance |
| `INSTANCE_POOLS` | On "set up pools" | JSON array of prioritized instance types |

---

## Lifecycle Integration

```bash
# Typical workflow
./do/build && ./do/push && ./do/deploy    # Deploy initial model
./do/test                                  # Verify it works
./do/optimize --goal throughput            # Find optimal instance
./do/deploy                                # Re-deploy with optimized config
./do/benchmark                             # Confirm performance improvement
```

---

## Troubleshooting

**"CreateAIRecommendationJob is not available in this region"**
: Inference Recommendations is not available in all regions. Try `us-east-1` or `us-west-2`.

**Job fails immediately**
: Check that the model name/path is valid and accessible. HuggingFace models must be public or have auth configured.

**"Max 3 instance types supported"**
: The API limits candidate instances to 3 per job. Run multiple jobs to compare more.

**Job takes too long**
: Recommendations typically complete in 10–30 minutes. Jobs hitting the 60-minute timeout may indicate an issue with instance availability.
