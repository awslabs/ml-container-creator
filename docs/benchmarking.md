# Benchmarking

Measure LLM endpoint performance using SageMaker AI Benchmarking (NVIDIA AIPerf). The `do/benchmark` script creates a workload configuration, launches a benchmark job, polls for completion, and displays results — all in one command.

## Prerequisites

| Requirement | Details |
|---|---|
| Endpoint status | Must be `InService` (run `./do/deploy` first) |
| Architecture | Transformers or Diffusors only (HTTP and Triton not supported) |
| Deployment target | `realtime-inference` only (HyperPod EKS is not supported) |
| AWS credentials | Must be configured for the deployment region |
| Bootstrap | Recommended — provides the IAM role with benchmarking permissions |

## Quick Start

Generate a project with benchmarking enabled:

```bash
ml-container-creator vllm-benchmark-demo \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --deployment-target=realtime-inference \
  --instance-type=ml.g5.2xlarge \
  --include-benchmark \
  --benchmark-concurrency=10 \
  --benchmark-input-tokens=550 \
  --benchmark-output-tokens=150 \
  --benchmark-streaming \
  --skip-prompts
```

Deploy and benchmark:

```bash
./do/build && ./do/push && ./do/deploy
./do/benchmark
```

## Usage

```bash
./do/benchmark [--ic <name>] [--adapter <name>] [--force] [--clean] [--no-stale-warning]
```

| Flag | Description |
|---|---|
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

## Metrics

The benchmark reports:

| Metric | Description |
|---|---|
| **Request throughput** (req/s) | Sustained requests per second |
| **Output token throughput** (tokens/s) | Total output tokens generated per second |
| **Request latency** (P50/P90/P99) | End-to-end request latency |
| **TTFT** (P50/P90/P99) | Time to first token (streaming latency) |
| **ITL** (P50/P90/P99) | Inter-token latency (generation speed) |

## Configuration Parameters

Set at generation time via CLI flags:

| Parameter | CLI Flag | Default | Description |
|---|---|---|---|
| `benchmarkConcurrency` | `--benchmark-concurrency` | `1` | Number of concurrent clients |
| `benchmarkInputTokens` | `--benchmark-input-tokens` | `550` | Input token count per request |
| `benchmarkOutputTokens` | `--benchmark-output-tokens` | `150` | Output token count per request |
| `benchmarkStreaming` | `--benchmark-streaming` | `false` | Enable streaming mode |
| `benchmarkDuration` | `--benchmark-duration` | `120` | Duration in seconds |
| `benchmarkTokenizer` | `--benchmark-tokenizer` | Model default | Custom tokenizer |

These are written to `do/config` and used by `do/benchmark` to create the workload configuration.

## Idempotency

`do/benchmark` is idempotent:

- If a benchmark job is already running, re-running (without `--force`) will resume polling the existing job and display its results when complete.
- Use `--force` to create a new job even if one exists.

## Cleanup

```bash
# Delete workload config and benchmark jobs only
./do/benchmark --clean

# Delete everything (endpoint + benchmark resources)
./do/clean all
```

## Interpreting Results

### Concurrency Tuning

Start with concurrency=1 to measure single-request latency, then increase to find the throughput/latency sweet spot:

| Concurrency | Effect |
|---|---|
| 1 | Baseline latency (no queuing) |
| 5-10 | Typical production load |
| 20-50 | Stress test (find saturation point) |
| 100+ | Overload test (queue buildup) |

### Key Indicators

- **TTFT > 500ms** — Model may need a smaller batch size or faster instance
- **ITL > 50ms** — Generation is slow; consider tensor parallelism or a faster backend
- **Throughput plateau** — You've hit GPU saturation; scale horizontally or upgrade instance

### Comparing Configurations

Run benchmarks across different configurations to find the optimal setup:

```bash
# Generate project with different instance types
ml-container-creator bench-g5-xlarge --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B --instance-type=ml.g5.xlarge --include-benchmark --skip-prompts

ml-container-creator bench-g5-2xlarge --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B --instance-type=ml.g5.2xlarge --include-benchmark --skip-prompts
```

Use `do/register` after each benchmark to record results in the deployment registry for comparison.

## Adapter Benchmarking

Benchmark a specific LoRA adapter to compare against the base model:

```bash
# Benchmark base model
./do/benchmark

# Benchmark adapter
./do/benchmark --adapter my-sft

# Compare results (both recorded in benchmark history)
```

## Integration with CI

In CI pipelines, benchmark results can be registered for regression detection:

```bash
./do/benchmark
./do/register --ci --notes "Nightly benchmark run"
```

See [CI Integration](ci-integration.md) for automated validation workflows.
