# Optimization

The `do/optimize` script runs SageMaker AI Inference Recommendations to find the optimal instance type and model configuration for your workload. It wraps `CreateAIRecommendationJob` and `DescribeAIRecommendationJob`, providing an interactive workflow that feeds results back into your project's `do/config`.

Use `do/optimize` after you've deployed and tested your model to answer: *"What's the best instance for my latency/throughput/cost goal?"*

---

## Prerequisites

| Requirement | Details |
|---|---|
| **MODEL_NAME** | Must be set in `do/config` (HuggingFace model ID or S3 path) |
| **AWS CLI v2** | Required for inference recommendations API |
| **IAM permissions** | `sagemaker:CreateAIRecommendationJob`, `CreateAIWorkloadConfig`, `DescribeAIRecommendationJob` (included in bootstrap role) |
| **Framework** | `transformers` only (uses `VLLM` inference specification) |

---

## Usage

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

---

## What It Does

1. **Creates a workload config** — defines the traffic pattern (concurrency, input/output tokens, streaming) based on your benchmark settings
2. **Creates an AI Recommendation Job** — submits the model + workload + candidate instances to SageMaker AI
3. **Polls for completion** — waits up to 60 minutes (polling every 30s)
4. **Displays ranked results** — shows TTFT, inter-token latency, throughput, and cost for each instance type
5. **Offers interactive choices**:
   - Deploy top recommendation (updates `INSTANCE_TYPE` and `MODEL_PACKAGE_ARN` in `do/config`)
   - Set up instance pools (writes `INSTANCE_POOLS` for heterogeneous deployments)
   - Save for later (stores `OPTIMIZE_MODEL_PACKAGE_ARN` in `do/config`)

---

## Examples

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
