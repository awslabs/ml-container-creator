# Optimization

`do/optimize` runs SageMaker AI Inference Recommendations to find optimal instance types and model configurations for your workload. It wraps `CreateAIRecommendationJob` / `DescribeAIRecommendationJob`.

For Athena-backed config recommendations based on your own benchmark history (no live API needed), use [`do/benchmark --recommend`](benchmarking.md#config-recommendations).

---

## Prerequisites

| Requirement | Details |
|---|---|
| **MODEL_NAME** | Must be set in `do/config` (HuggingFace model ID or S3 path) |
| **AWS CLI v2** | Required for inference recommendations API |
| **IAM permissions** | `sagemaker:CreateAIRecommendationJob`, `CreateAIWorkloadConfig`, `DescribeAIRecommendationJob` (included in bootstrap role) |
| **Framework** | `transformers` only (uses `VLLM` inference specification) |

## Usage

```bash
./do/optimize --goal <cost|latency|throughput> [--instances type1,type2] [--force]
./do/optimize --list
./do/optimize --apply <arn|top>
```

## Flags

| Flag | Required | Description |
|---|---|---|
| `--goal` | Yes (for a new job) | Optimization goal: `cost`, `latency`, or `throughput` |
| `--instances` | No | Comma-separated instance types to evaluate (max 3). Not valid with `--goal cost` (see note below) |
| `--force` | No | Create a new job even if one already exists |
| `--list` | No | List completed recommendation results (ranked) without creating a new job |
| `--apply <arn\|top>` | No | Apply a recommendation to `do/config`: pass `top` for the #1 ranked result, or a specific model package ARN |

!!! note "`--goal cost` does not accept `--instances`"
    When optimizing for `cost`, the API constraint means SageMaker picks the instances itself —
    you cannot supply `--instances`. Passing both is rejected. Use `--goal latency` or
    `--goal throughput` if you want to constrain the candidate instance list.

!!! note "`--goal throughput` runs without speculative decoding"
    `--goal throughput` currently runs with `--no-optimize-model` because speculative decoding
    requires a calibration dataset that is not yet wired in. Dataset-driven throughput
    optimization via `--dataset-uri` is planned for a future release.

## Instance Resolution

If `--instances` is not provided, `do/optimize` resolves instance types from (in priority order):

1. `INSTANCE_POOLS` in `do/config` (extracts instance types from JSON)
2. `INSTANCE_TYPE` in `do/config`
3. Live endpoint query (for external endpoints)

## Model Source Resolution

`do/optimize` resolves the model source in this order:

1. **`STAGED_MODEL_PATH`** (an `s3://` URI) → used directly as `S3.S3Uri`
2. Otherwise → the job **fails with a clear error** pointing you to run `do/stage` (to pre-stage
   weights to S3) or `do/benchmark --recommend` (for Athena-backed recommendations that don't
   require a staged model)

For the HyperPod EKS target specifically, `STAGED_MODEL_PATH` is the model source
(**not** `MODEL_NAME`) — see [HyperPod EKS Target](#hyperpod-eks-target) below.

## What It Does

1. **Creates a workload config** — defines the traffic pattern (concurrency, input/output tokens, streaming) based on your benchmark settings
2. **Creates an AI Recommendation Job** — submits the model + workload + candidate instances to SageMaker AI
3. **Polls for completion** — waits up to 60 minutes (polling every 30s)
4. **Displays ranked results** — shows TTFT, inter-token latency, throughput, and cost for each instance type
5. **Offers an interactive menu** — after results are displayed you can choose to deploy the top
   recommendation, set up instance pools, or save results for later. Results are persisted so you
   can revisit them anytime with `--list` and apply one with `--apply <arn|top>` in a separate
   invocation (no need to re-run the job).

## Examples

```bash
# Optimize for throughput using the instance type already in do/config
./do/optimize --goal throughput

# Compare specific instance types for latency
./do/optimize --goal latency --instances ml.g6e.48xlarge,ml.p5.48xlarge

# Optimize for cost (SageMaker picks instances — do NOT pass --instances)
./do/optimize --goal cost

# Re-run optimization (creates new job, ignores previous)
./do/optimize --goal latency --force

# List completed recommendation results (ranked) without creating a job
./do/optimize --list

# Apply the top-ranked recommendation to do/config
./do/optimize --apply top

# Apply a specific recommendation by model package ARN
./do/optimize --apply arn:aws:sagemaker:us-east-1:123456789012:model-package/my-pkg/1
```

---

## Listing and Applying Results

Recommendation results are persisted after a job completes, so listing and applying are
decoupled from running the job.

### `--list`

Shows the ranked results from the most recent completed recommendation job — the same table
produced at the end of a run — without submitting a new job. Use it to review recommendations
before deciding what to apply.

```bash
./do/optimize --list
```

### `--apply top`

Applies the **#1 ranked** recommendation. This writes `OPTIMIZE_MODEL_PACKAGE_ARN` (and, for
realtime targets, updates `INSTANCE_TYPE`) to `do/config`.

```bash
./do/optimize --apply top
```

### `--apply <arn>`

Applies a **specific** recommendation identified by its model package ARN (as shown in `--list`
output). Useful when the top result isn't the one you want (e.g., you prefer a cheaper instance
that ranked #2).

```bash
./do/optimize --apply arn:aws:sagemaker:us-east-1:123456789012:model-package/my-pkg/1
```

In all cases `--apply` writes `OPTIMIZE_MODEL_PACKAGE_ARN` to `do/config`. What that ARN is used
for next depends on the deployment target — see [HyperPod EKS Target](#hyperpod-eks-target).

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
| `OPTIMIZE_MODEL_PACKAGE_ARN` | On "deploy", "save", or `--apply` | Model package from recommendations |
| `OPTIMIZE_INFERENCE_SPEC` | On "deploy" | Inference specification name |
| `INSTANCE_TYPE` | On "deploy" | Updated to the recommended instance |
| `INSTANCE_POOLS` | On "set up pools" | JSON array of prioritized instance types |

---

## HyperPod EKS Target

`do/optimize` **is** supported when the deployment target is HyperPod EKS. Two things differ
from the realtime path:

- **Model source** — the model source is `STAGED_MODEL_PATH` (the `s3://` staged weights),
  **not** `MODEL_NAME`. Run `do/stage` first if weights aren't staged yet.
- **Applying results** — `--apply` writes `OPTIMIZE_MODEL_PACKAGE_ARN` to `do/config`, but
  **deployment on HyperPod requires BL088** (the `InferenceEndpointConfig` migration), which is
  **planned for v1.7**. Until then you can obtain and store the recommendation, but the HyperPod
  deploy path cannot consume it yet.

---

## Lifecycle Integration

```bash
# Typical workflow
./do/build && ./do/push && ./do/deploy    # Deploy initial model
./do/test                                  # Verify it works
./do/optimize --goal throughput            # Run the recommendation job
./do/optimize --list                       # Review ranked results
./do/optimize --apply top                  # Apply the top recommendation to do/config
./do/deploy                                # Re-deploy with optimized config
./do/benchmark                             # Confirm performance improvement
```

---

## Troubleshooting

**"CreateAIRecommendationJob is not available in this region"**
: Inference Recommendations is not available in all regions. Try `us-east-1` or `us-west-2`.

**Job fails immediately**
: Check that the model name/path is valid and accessible. HuggingFace models must be public or have auth configured.

**"No staged model found" / model source error**
: `do/optimize` needs a staged S3 model. Run `do/stage` to pre-stage weights, or use `do/benchmark --recommend` for Athena-backed recommendations that don't require a staged model.

**"Max 3 instance types supported"**
: The API limits candidate instances to 3 per job. Run multiple jobs to compare more.

**"--instances is not valid with --goal cost"**
: Cost optimization lets SageMaker choose instances. Drop `--instances`, or switch to `--goal latency` / `--goal throughput` to constrain the candidate list.

**Job takes too long**
: Recommendations typically complete in 10–30 minutes. Jobs hitting the 60-minute timeout may indicate an issue with instance availability.
