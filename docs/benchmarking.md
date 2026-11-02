# Benchmarking

Measure LLM endpoint performance using NVIDIA AIPerf. On the SageMaker-endpoint targets (`realtime-inference` / `hyperpod-eks`) `do/benchmark` drives the SageMaker AI Benchmarking service, which runs AIPerf server-side. On the plain `eks` target it runs the SAME tool — AIPerf — locally against the port-forwarded pod (see [Plain EKS](#plain-eks-local-aiperf)). Either way the `do/benchmark` script resolves a workload configuration, runs the load, and displays results — all in one command.

## Prerequisites

| Requirement | Details |
|---|---|
| Endpoint status | Must be `InService` (run `./do/deploy` first). Not applicable to `eks`, which has no SageMaker endpoint — it port-forwards the serving pod instead. |
| Architecture | Transformers or Diffusors only (HTTP and Triton not supported) |
| Deployment target | `realtime-inference` and `hyperpod-eks` (HyperPod EKS requires `ENDPOINT_NAME` written by `do/deploy` — set automatically after successful deployment). `eks` runs local AIPerf against the pod and needs `pip install aiperf` (see [Plain EKS](#plain-eks-local-aiperf)). |
| Python dependencies | Installed automatically via `npm install` (see `requirements.txt`). The `eks` path additionally needs `aiperf` (`pip install aiperf`). |
| AWS credentials | Must be configured for the deployment region |
| Bootstrap | Recommended — provides the IAM role with benchmarking permissions and S3 bucket for results |

## Quick Start

Generate a project with benchmarking enabled:

```bash
ml-container-creator vllm-benchmark-demo \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --instance-type=ml.g5.2xlarge \
  --skip-prompts
```

Deploy and benchmark:

```bash
./do/build && ./do/push && ./do/deploy
./do/benchmark --workload multi-turn-chat
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
| `--compare-baseline` | Compare latest results against historical best in Athena |
| `--recommend` | Show Athena-backed config recommendations for current model/instance |
| `--apply` | (with `--recommend`) Write recommended changes to `do/ic/default.conf` |
| `--metric <name>` | (with `--recommend`) Metric to optimize (default: `output_token_throughput_tps`) |
| `--no-bedrock` | (with `--recommend`) Skip Bedrock AI analysis even if available |
| `--threshold <metric:pct>` | Set regression threshold per metric (repeatable, e.g. `throughput:5`) |
| `--json` | Output comparison/recommendation results as JSON (for CI integration) |

### IC Resolution

The benchmark targets a specific inference component:

1. `--adapter <name>` — Uses `ADAPTER_IC_NAME` from `do/adapters/<name>.conf`
2. `--ic <name>` — Uses `IC_DEPLOYED_NAME` from `do/ic/<name>.conf`
3. No flag — Uses the first IC in `do/ic/` alphabetically, or falls back to legacy config

## Workload Profiles

Benchmark parameters are resolved from named **workload profiles** served by the workload-picker MCP server. Each profile defines a realistic traffic pattern:

| Workload | Concurrency | Input Tokens | Output Tokens | Streaming | Description |
|---|---|---|---|---|---|
| `multi-turn-chat` | 10 | 550 | 150 | ✅ | Multi-turn conversational workload |
| `rag-document-qa` | 8 | 2048 | 256 | ✅ | RAG with long context retrieval |
| `agent-tool-calling` | 4 | 800 | 100 | ❌ | Tool-calling agent (structured output) |
| `long-context-scaling` | 2 | 8192 | 512 | ✅ | Long-context stress test |
| `production-traffic-mix` | 16 | 1024 | 200 | ✅ | Simulated production traffic mix |
| `shared-system-prompt` | 12 | 300 | 150 | ✅ | Short requests with shared system prompt |

List available workloads:

Ask any MCP client connected to the bundled `workload-picker` server to call its `list_workloads` tool, or read the catalog directly:

```bash
cat servers/workload-picker/catalogs/workload-profiles.json
```

Running `./do/benchmark` with no `--workload` / `--dataset` also prints the available workload names.

### How Resolution Works

When you run `./do/benchmark --workload multi-turn-chat`:

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

## Regression Detection

`--compare-baseline` compares your most recent benchmark run against the best historical result for the same configuration in Athena.

```bash
# Compare against historical best (10% threshold on all metrics)
./do/benchmark --compare-baseline

# Tighter threshold on throughput, looser on latency
./do/benchmark --compare-baseline --threshold throughput:5 --threshold ttft:20

# JSON output for CI pipelines (exit code 1 on regression)
./do/benchmark --compare-baseline --json
```

### How it works

1. Finds the most recent local benchmark result (`benchmarks/<project>-benchmark-*/output/profile_export.jsonl`)
2. Queries Athena for the best historical result matching model + instance + quantization + tensor parallel
3. Compares on four metrics with configurable thresholds

### Threshold syntax

`--threshold <metric>:<pct>` is repeatable. `<metric>` accepts full names or aliases:

| Alias | Full name |
|-------|----------|
| `throughput` | `output_token_throughput_tps` |
| `ttft` | `ttft_p90_ms` |
| `itl` | `itl_p90_ms` |
| `latency` | `e2e_latency_p90_ms` |

Default when no `--threshold` is specified: all four metrics at 10%.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No regression detected (or no baseline found) |
| 1 | At least one metric exceeded the regression threshold |

!!! note "Known limitation: `gpu_utilization_avg` column"
    `--compare-baseline` queries Athena for extended GPU metrics (utilization, KV cache,
    prefix cache hit rate). These columns are added to the Athena schema as part of the
    enhanced benchmark metrics work (v1.7). On existing tables provisioned before v1.7,
    the query will emit a `⚠️ Athena query FAILED: COLUMN_NOT_FOUND: gpu_utilization_avg`
    caution but will continue — the comparison falls back to the four core metrics only.
    This is cosmetic and does not block the regression check. Run `mcc bootstrap update`
    to migrate the Athena schema.

### CI integration

```yaml
# Example: run after every deployment, fail on regression
- name: Benchmark regression check
  run: |
    ./do/benchmark --workload multi-turn-chat
    ./do/benchmark --compare-baseline --threshold throughput:5 --json
```

---

## GPU & Engine Metrics

Beyond the client-side AIPerf numbers (throughput, latency, TTFT, ITL), every
benchmark row carries GPU utilization, KV-cache usage, queue depth and prefix-cache
hit rate for the **measured load window**, read from the AWS-native metrics store of
the deployment target. Collection is non-fatal: a signal with no samples is `NULL`
in Athena (never `0`), and a metrics failure never fails the benchmark.

Where the numbers come from is declared, not hardcoded:

- the store, label selector and dashboard: `observability` in
  `templates/do/targets.d/<target>/manifest.json`;
- the engine metric names: `metric_signals` in
  `templates/code/serve.d/<engine>/manifest.json` (vLLM and SGLang today; other
  engines get the DCGM GPU signals only).

| Target | Store | How MLCC reads it | `metrics_source` |
|---|---|---|---|
| `realtime-inference` | SageMaker AI detailed observability (CloudWatch) | PromQL at `https://monitoring.<region>.amazonaws.com/api/v1/query`, SigV4 `monitoring` | `cloudwatch_only` |
| `hyperpod-eks` | HyperPod observability add-on → Amazon Managed Service for Prometheus | PromQL at the add-on's AMP workspace, SigV4 `aps`, all pods | `amp` |
| `hyperpod-eks` (no add-on / no series) | — | opt-in port-forward `/metrics` scrape (fallback) | `engine_metrics_only` |
| `eks` | — | opt-in port-forward `/metrics` scrape | `engine_metrics_only` |
| any | both a store and the scrape contributed | | `both` |
| any | nothing collected | | `none` |

### The run window

Every query is evaluated at the end of the window that load actually ran, per
concurrency level:

1. `start_time` / `end_time` from that level's AIPerf `profile_export_aiperf.json`
   (AIPerf writes them as UTC ISO timestamps);
2. else `DescribeAIBenchmarkJob` `StartTime` / `EndTime` (wider: includes job
   provisioning);
3. else the time `do/benchmark` created and saw the job finish.

A concurrency sweep keeps each level's AIPerf aggregate, child job name and scrape
sidecars, so every row gets its own window, `benchmark_job_name` and signals.
`./do/benchmark --status` (completing a job that was interrupted) gets the same
window from the downloaded results or the job's times. Gauges are averaged (and
maxed) over the window; queue depth is summed across series; prefix-cache hit rate and
speculative-decoding acceptance are `increase(hits) / increase(queries)` over the
window, never lifetime counters. The PromQL range limit caps a window at 24 h.

### realtime-inference

SageMaker AI detailed observability publishes the container's Prometheus metrics and
per-GPU DCGM metrics to CloudWatch under their **raw names** (`vllm:kv_cache_usage_perc`,
`vllm:num_requests_waiting`, `vllm:prefix_cache_hits_total`, `DCGM_FI_DEV_GPU_UTIL`, ...),
labelled with `aws.sagemaker.endpoint.name`, `aws.sagemaker.variant.name` and
`aws.sagemaker.inference_component.name`. MLCC selects them with
`{__name__="vllm:...", 'aws.sagemaker.endpoint.name'="<endpoint>", ...}`.

`MetricsConfig.EnableDetailedObservability`
[defaults to true](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_MetricsConfig.html)
for endpoint configs created after June 17, 2026, so a fresh `./do/deploy` needs no
extra setting. Older endpoint configs default to false; redeploy to get a new config:

```bash
aws sagemaker describe-endpoint-config --endpoint-config-name <config-name> \
    --query 'MetricsConfig.EnableDetailedObservability'
./do/deploy   # only if the query above prints false or None
```

Account-level OTel enrichment (`aws cloudwatch start-otel-enrichment`) is **not**
needed: the detailed-observability series flow with it stopped. It only mirrors
classic-only metrics into OTel.

The default `MetricPublishFrequencyInSeconds` is 60 s, so a run shorter than a few
minutes has few samples per signal. Use a workload with at least ~3 minutes of load
when you want these columns populated.

!!! note "BYOC metrics path"
    For custom (BYOC) containers, SageMaker scrapes Prometheus metrics at the default path
    `/metrics` on port 8080 ([MetricsConfig](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_MetricsConfig.html),
    [getting started](https://docs.aws.amazon.com/sagemaker/latest/dg/monitoring-detailed-observability-getting-started.html)).
    The MLCC vLLM, SGLang and llama.cpp containers serve metrics there, so MLCC sets no
    extra metrics configuration. If a container uses a different path, set
    `ContainerMetricsConfig: {MetricsEndpoints: [{MetricsEndpointPath: "/custom"}]}` on the
    container spec (the inference component's `Specification.Container`, or the model's
    `ContainerDefinition`). `CreateEndpointConfig` has no `ContainerMetricsConfig` option,
    and the port is always 8080.

### hyperpod-eks

When the `amazon-sagemaker-hyperpod-observability` EKS add-on is installed, MLCC reads
the AMP workspace named in the add-on configuration (`ampWorkspace.prometheusEndpoint`)
after the run. vLLM series are selected by `resource_name="<PROJECT_NAME>"` and
`namespace`; DCGM series by `container="<PROJECT_NAME>"`. This covers **every pod of the
deployment**; histograms there are classic (`_bucket` + `le`). It needs no port-forward
and no opt-in.

Without the add-on (or when it has no series for the run), the engine scrape is the
fallback. Enable it in `do/config`:

```bash
export HP_BENCHMARK_METRICS_ENABLED=true
```

### Engine `/metrics` scrape (fallback; `eks`, `hyperpod-eks`)

With `HP_BENCHMARK_METRICS_ENABLED=true`, `do/benchmark` port-forwards **every Running
pod** of the deployment (up to 8) and samples the engine's metrics endpoint (path and
port from the serve manifest's `metrics_endpoint`) every 5 s for the whole run. Each pod
writes its own sidecar, `benchmarks/<job>/gpu_metrics-c<level>-<pod>.json`; the writer
merges them per level (queue depth summed across pods, utilization averaged). The scrape
has no GPU series, so `gpu_*` columns stay `NULL` on scrape-only rows.
`benchmarks/.last_gpu_metrics.json` is a display copy for `./do/benchmark --gpu-metrics`
only; it is never written to Athena.

### Other benchmark columns the writer fills

| Column | Source |
|---|---|
| `error_rate` | AIPerf `request_error_rate` (a percent in AIPerf; stored as 0–1), else errored records / total records from `profile_export.jsonl`. `0.0` for an all-success run, `NULL` when unknown. |
| `gpu_count`, `gpu_type`, `gpu_memory_gb` | the instance catalog the generator copies to `.mlcc/instances.json` |
| `benchmark_job_name` | the managed benchmark job (per level in a sweep), so `--set-baseline` / `--compare-baseline` can find the row |

### IAM actions

| Action | Used for |
|---|---|
| `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` | realtime PromQL queries and the per-copy concurrency readout |
| `aps:QueryMetrics` | HyperPod AMP queries |
| `sagemaker:DescribeCluster`, `eks:DescribeAddon` | finding the AMP workspace |
| `sagemaker:DescribeAIBenchmarkJob` | the run window fallback and the endpoint / IC behind a job |
| `grafana:ListWorkspaces` | the HyperPod dashboard pointer (`do/metrics`, `do/status`) |

All of these are read-only. A missing permission leaves the affected columns `NULL`
with one warning per run.

### Live readout: `do/metrics`

`./do/metrics` prints the same signals for a deployed endpoint over the last N minutes,
plus a pointer to the native dashboard:

```bash
./do/metrics                 # last 15 minutes
./do/metrics --window 60     # last hour (1-1440)
./do/metrics --json          # machine-readable
```

It shows server-side TTFT and end-to-end latency p50/p99, queue waiting avg/max,
running avg, KV-cache avg/max, GPU utilization avg and, on `realtime-inference`,
per-copy concurrency (CloudWatch `ConcurrentRequestsPerCopy`). A signal with no samples
prints `no data`. The dashboard pointer is the CloudWatch console path (Insights →
SageMaker AI) for `realtime-inference`, and the Amazon Managed Grafana workspace URL for
`hyperpod-eks` when the add-on names one that exists (else the AMP workspace id). Targets
without a store (`eks`, `async-inference`, `batch-transform`) print a skip notice and
exit 0. `./do/status` shows the same dashboard pointer as one line, and inference
component copies as `current/desired`.

### Athena columns

| Column | Type | Description |
|---|---|---|
| `gpu_utilization_avg` | DOUBLE | Average GPU compute utilization (%) over the run window |
| `gpu_utilization_max` | DOUBLE | Peak GPU compute utilization (%) |
| `gpu_memory_util_avg` | DOUBLE | Average GPU memory copy utilization (%) |
| `gpu_memory_used_avg_gb` | DOUBLE | Average GPU framebuffer used (GiB; DCGM reports MiB) |
| `kv_cache_util_avg` | DOUBLE | Average KV cache utilization (0–1) |
| `kv_cache_util_max` | DOUBLE | Peak KV cache utilization (0–1) |
| `prefix_cache_hit_rate` | DOUBLE | Prefix cache hits / queries over the run window (0–1) |
| `queue_depth_waiting_avg` | DOUBLE | Average number of waiting requests (all pods) |
| `queue_depth_waiting_max` | DOUBLE | Peak number of waiting requests |
| `queue_depth_running_avg` | DOUBLE | Average number of running requests (all pods) |
| `metrics_source` | STRING | `cloudwatch_only` / `amp` / `engine_metrics_only` / `both` / `none` |

These columns are `NULL` for benchmark runs on pre-v1.7 tables and for runs where no
source returned samples. Run `mcc bootstrap update` to migrate an existing Athena
table — the CDK stack update adds the columns via Glue `UpdateTable` (idempotent).

---

## Cost per 1M tokens, pricing and the Bedrock comparison (Wave 9)

### How the cost is computed

```
cost_per_1m_tokens = price_usd_per_hour × instance_count × 1,000,000 / (3600 × output_token_throughput_tps)
```

Output tokens only. Each concurrency level gets its own figure, because the throughput is measured per level. The column is `NULL` (with a printed reason) when the price, the instance count or the throughput is missing. MLCC never substitutes an estimate.

| Input | Source |
|---|---|
| `price_usd_per_hour` | On-demand USD/hour from the price resolver (`do/lib/python/pricing.py`), see below |
| `instance_count` | realtime-inference: the endpoint's `CurrentInstanceCount` at write time (`DescribeEndpoint`); the whole endpoint is billed, even when one IC uses part of it. hyperpod-eks / eks: nodes occupied = ceil(`HP_REPLICAS` × `HP_GPU_COUNT` / GPUs per instance). `HP_GPU_COUNT=auto` means one whole instance per replica |
| `output_token_throughput_tps` | AIPerf, measured at that level's concurrency |

The Price List service, the `component` and the instance-count basis come from each target's descriptor (`templates/do/targets.d/<target>/manifest.json` → `pricing`). They are not branches in code:

| Target | Price List service | `component` |
|---|---|---|
| realtime-inference | AmazonSageMaker | `Hosting` |
| hyperpod-eks | AmazonSageMaker | `Cluster` (HyperPod; differs from `Hosting` for some families, e.g. p5) |
| eks | AmazonEC2 | — (Linux, Shared tenancy, no pre-installed software, `capacitystatus=Used`) |
| async-inference | AmazonSageMaker | `AsyncInf` (benchmark not supported) |
| batch-transform | AmazonSageMaker | `BatchTransform` (benchmark not supported) |

### Where prices come from

The resolver returns `{usd_per_hour, source, as_of, component, region}` for one (instance, region, target) and tries these sources in order:

1. **Project cache** `.mlcc/pricing-cache.json`, used when the entry is at most 24 hours old (`price_source = pricing-api-cache`).
2. **AWS Price List API** `GetProducts` through the `us-east-1` Price List endpoint, on-demand terms only (`price_source = pricing-api`).
3. **Snapshot** `.mlcc/pricing-snapshot.json`, copied into the project at generate time (`price_source = snapshot`). The snapshot is produced only by `npm run sync:pricing` (`pricing.py snapshot`) against the live API. Every entry records its source and retrieval date.
4. **NULL**, with the reasons from steps 2 and 3.

A lookup that does not return **exactly one** on-demand USD price is a miss. Zero matches, several distinct prices, or an unexpected unit all count as a miss; MLCC never picks one of several. Savings Plans, reserved and spot prices are not used. `--dry-run` writes skip the live API (cache and snapshot only).

### What the output says

Every printed cost carries the concurrency it was measured at, the price inputs and the caveat:

```
$12.10 / 1M output tokens @ concurrency 2 (measured) · ml.g7.12xlarge ×1 Cluster $8.9104/h, pricing-api 2026-10-26
Assumes sustained utilization during billed hours; idle and scale-to-zero time are not included (BL202 / Wave 10).
```

When a write covers two or more concurrency levels, the summary adds a **peak sustained** line: the cost at the level with the highest output tokens/s, labeled with that level's concurrency. `./do/benchmark --peak --metric cost` uses the same label and caveat. Low-concurrency figures are much higher than what the same hardware costs at full load, so compare levels rather than quoting a single number.

### Bedrock comparison

MLCC shows a Bedrock on-demand figure next to its own cost **only** when the model has a verified Bedrock equivalent:

- `servers/lib/catalogs/bedrock-equivalents.json` (copied to `.mlcc/`) maps an exact HuggingFace model id to a Bedrock model id and its Price List model name. Entries are added only by `pricing.py verify-bedrock`. That command calls `bedrock:ListFoundationModels` in each region and records the date and the regions where the model is listed with `ON_DEMAND`. MLCC never matches by name similarity.
- Input and output token prices come from the same resolver (`AmazonBedrock`, feature `On-demand Inference`) for the **run's region**. MLCC never substitutes another region's price.
- Comparable figure (per 1M output tokens, at the run's measured input:output ratio): `output_price + input_price × (input_sequence_length_avg / output_sequence_length_avg)`.
- Otherwise the line reads `no Bedrock equivalent (<reason>)`. The reason is one of: no verified mapping, not verified in the region, no on-demand price in the region, or adapter run. Adapter (LoRA) runs never compare.

The figure gets the same concurrency label and the same caveat. It is stored in `bedrock_model_id` and `bedrock_cost_per_1m_tokens`.

### Athena columns added in Wave 9

| Column(s) | Type | Description |
|---|---|---|
| `run_name` | STRING | Already in the Glue table; now written by the writer and listed in the DDL |
| `effective_concurrency_{avg,p90}` | DOUBLE | AIPerf time-weighted concurrency over the full window (BL128) |
| `effective_total_tps_*`, `effective_decode_tps_*`, `effective_prefill_tps_*` | DOUBLE | AIPerf effective throughput, tokens/s (avg, p90) |
| `active_decode_tps_*`, `active_prefill_tps_*` | DOUBLE | AIPerf active throughput (only while that phase has work in flight) |
| `tokens_in_flight_{avg,p90}` | DOUBLE | AIPerf tokens in flight |
| `effective_latency_{avg,p90}_ms` | DOUBLE | AIPerf effective latency (accounts for coordinated omission) |
| `aiperf_version` | STRING | AIPerf version that produced the run |
| `spec_decode_acceptance_rate` | DOUBLE | Speculative-decoding acceptance rate, when collected |
| `price_usd_per_hour`, `price_source`, `price_as_of`, `price_component`, `instance_count` | mixed | The inputs behind `cost_per_1m_tokens` |
| `bedrock_model_id`, `bedrock_cost_per_1m_tokens` | STRING / DOUBLE | Bedrock comparison (NULL when there is no equivalent) |

The AIPerf aggregates come from each level's `profile_export_aiperf.json`. A sweep keeps it as `results-concurrency-<L>.json` next to the per-level JSONL, and the eks path keeps it next to `profile_export.jsonl`. A missing file or key gives `NULL`. Per-request parsing and `--list` / `--peak` / `--compare-baseline` are unchanged.

### Rolling out the schema change

The Glue table is owned by CloudFormation (`BenchmarkResultsTable` in `infra/bootstrap-modules/benchmark/stack.ts`). CloudFormation re-evaluates the full column list every time the template is submitted. An out-of-band `ALTER TABLE ADD COLUMNS` would be reverted on the next bootstrap, so the only rollout is:

```bash
ml-container-creator bootstrap update --module benchmark --dry-run   # read-only: shows the column diff
ml-container-creator bootstrap update --module benchmark
```

This is an in-place update of the table (the table keeps its logical ID, database and name). Existing Parquet files read `NULL` for the new columns, and nothing is rewritten. On each write the writer also checks whether an existing partition's column list matches the table's, and updates the partition when it does not (`glue:UpdatePartition`), so older partitions show the new columns too. Until the update runs, the writer still writes the new columns, but Athena will not show them.

A drift test (`test/unit/test_benchmark_schema_drift.py`) keeps the writer's `PARQUET_COLUMNS`, `stack.ts` and `docs/athena-benchmark-ddl.sql` identical.

### IAM

| Action | Used by | When missing |
|---|---|---|
| `pricing:GetProducts` | writer (cost), `pricing.py snapshot` | falls back to the snapshot, else `NULL` cost with a warning naming the action |
| `sagemaker:DescribeEndpoint` | writer (realtime `instance_count`) | `NULL` count → `NULL` cost |
| `glue:GetPartition`, `glue:UpdatePartition` | writer (partition column reconcile) | warning; the row is still written |
| `bedrock:ListFoundationModels` | `pricing.py verify-bedrock` (maintainers only) | mapping cannot be added |

The bootstrapped CI CodeBuild role (`infra/bootstrap-modules/ci`) gets `pricing:GetProducts` and the Glue partition actions in this wave.

---

## Plain EKS (local AIPerf)

The plain `eks` target has no SageMaker endpoint, so it cannot call the SageMaker AI
Benchmarking service. Instead it runs the SAME load generator that service runs —
NVIDIA **AIPerf** — **locally** against the port-forwarded serving pod, and emits the
same per-request `profile_export.jsonl`. Because the artifacts are byte-compatible, the
concurrency sweep, aggregator, `.benchmark_writer.py`, analytics verbs, Athena upload,
and Phase-2 GPU metrics all work unchanged — `eks` benchmarks are directly comparable to
`realtime-inference` / `hyperpod-eks` runs. This works against the wrapper engines (vLLM /
SGLang / TensorRT-LLM), whose pods serve the OpenAI `/v1/chat/completions` route AIPerf
drives.

**Prerequisite.** Install AIPerf into the active Python env the `do/` scripts use:

```bash
pip install aiperf
```

If `aiperf` is not on `PATH`, `do/benchmark` **fails loud** with this guidance rather
than silently degrading — there is no fallback to a blank request loop.

**Same flags as the other targets.** `eks` honors `--workload`, `--dataset`, and the
`BENCHMARK_CONCURRENCY_LEVELS` sweep exactly as the SageMaker-endpoint targets:

```bash
# named workload profile (multi-level sweep), GPU/engine metrics on
HP_BENCHMARK_METRICS_ENABLED=true ./do/benchmark --workload multi-turn-chat
# bring-your-own dataset (resolved from the registry, downloaded, replayed)
./do/benchmark --dataset my-traffic@v2
```

The serving port is derived from the engine manifest (`serve.d/<engine>/manifest.json`),
not hardcoded. BYOD datasets are resolved with the same `resolve-dataset` helper the
service path uses, downloaded client-side, and replayed one request per JSONL line
(`--input-file`); synthetic token-length means are omitted (mutually exclusive, same rule
as the service path).

**Same Athena table + analytics.** Results are written through the shared
`.benchmark_writer.py` with `deployment_target=eks`, so they land in the SAME benchmark
results table. The read-only analytics verbs work on `eks` runs identically:

```bash
./do/benchmark --list              # all runs across configs/targets
./do/benchmark --compare-baseline  # latest run vs best historical for this config
./do/benchmark --peak              # best historical record for this config
```

`--recommend` shows recommendations on `eks`, but `--recommend --apply` is **not**
supported — it would write `do/ic/default.conf`, a realtime-inference Inference-Component
artifact that does not apply to a plain-EKS Deployment. On `eks` it prints the
recommendations and a clear message to edit `do/config` / the eks manifest by hand.

**GPU & engine metrics (opt-in).** `eks` has no AWS-native metrics store, so set
`HP_BENCHMARK_METRICS_ENABLED=true` to scrape the engine's Prometheus endpoint on every
Running pod during the run and merge the engine columns into the Athena record (see "Engine `/metrics` scrape" under GPU & Engine Metrics above). The poller
resolves the cluster via `aws eks update-kubeconfig` for a plain-EKS cluster (not the
HyperPod `describe-cluster` API), and such a row is labeled `engine_metrics_only` in
`metrics_source`. `./do/metrics` prints a skip notice on `eks`.

---

## Config Recommendations

`--recommend` queries your existing benchmark data in Athena to suggest proven optimal serving configurations. No live benchmarking required — results appear immediately if benchmark data exists for your model and instance.

!!! note "Moved from `do/optimize`"
    This feature was previously part of `do/optimize`. Since v1.4, Athena-backed recommendations live in `do/benchmark --recommend`, while `do/optimize` focuses exclusively on the SageMaker AI Inference Recommendations API.

### Quick start

```bash
# See recommendations (dry-run by default)
./do/benchmark --recommend

# Apply recommended changes to do/ic/default.conf
./do/benchmark --recommend --apply

# Optimize for latency instead of throughput
./do/benchmark --recommend --metric ttft_p90_ms

# Raw JSON output for scripting
./do/benchmark --recommend --json | jq '.recommendations[0]'
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

If no Athena records exist for your model and instance, `--recommend` prints "No recommendations available" and exits 0. Run `./do/benchmark --workload multi-turn-chat` first to generate baseline data, then re-run `--recommend`.

### Deploy integration

`do/deploy --optimize` calls `do/benchmark --recommend --apply` automatically before deploying:

```bash
# One-command optimize-and-deploy
./do/deploy --optimize
```

---

## Generation-Time Configuration

At project generation, benchmarking is opt-in with a single boolean flag:

```bash
ml-container-creator my-project \
  --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B \
  --instance-type=ml.g5.xlarge \
  --skip-prompts
```

| Parameter | CLI Flag | Default | Description |
|---|---|---|---|
| `includeBenchmark` | `--include-benchmark` | `true` | Include the `do/benchmark` script in the generated project. Disable with `--include-benchmark=false` |

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
./do/benchmark --workload multi-turn-chat   # Start the job, Ctrl+C when you want
./do/benchmark --status                     # Check later; auto-resolves on completion
```

### Adapter Benchmarks

To benchmark a LoRA adapter instead of the base model, pass `--adapter`:

```bash
./do/benchmark --adapter my-adapter --workload multi-turn-chat
```

This routes requests through the adapter's inference component and records `adapter_name` in the Athena results. Works identically for adapters from any source — `do/tune` (managed), `do/train` (custom), or `--from-registry` (imported).

To differentiate adapter vs base model runs in queries:

```sql
SELECT * FROM mlcc_ci.benchmark_results
WHERE model_name = 'meta-llama_Llama-3.2-1B-Instruct'
  AND adapter_name = 'my-adapter';
```

!!! important
    When using `--status` to complete an adapter benchmark, you must pass `--adapter` again:
    `./do/benchmark --status --adapter my-adapter`

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
cd bench-g5-xlarge && ./do/benchmark --workload production-traffic-mix
cd bench-g5-2xlarge && ./do/benchmark --workload production-traffic-mix
```

Use `do/register` after each benchmark to record results in the deployment registry for comparison.

## Adapter Benchmarking

Benchmark a specific LoRA adapter to compare against the base model:

```bash
# Benchmark base model
./do/benchmark --workload multi-turn-chat

# Benchmark adapter
./do/benchmark --workload multi-turn-chat --adapter my-sft

# Compare results (both recorded in benchmark history)
```

## Results Persistence

When the benchmark module is provisioned (`bootstrap add-module benchmark`), results are automatically:

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
./do/benchmark --workload production-traffic-mix
./do/register --ci --notes "Nightly benchmark run"
```

See [CI Integration](ci-integration.md) for automated validation workflows and the two-stage pipeline.


## Pre-staging Large Models (`do/stage`)

For models >30B parameters, downloading from HuggingFace at deploy time can cause 30-60 minute startup delays or timeout failures. Pre-stage weights to your MCC S3 bucket first:

```bash
./do/stage                              # Default: Processing Job on ml.m5.xlarge
./do/stage --instance-type ml.m5.4xlarge   # Larger instance for 15B-70B models
./do/stage --local                      # Download locally then sync to S3 (legacy)
```

This downloads model weights from HuggingFace and uploads to `s3://{bucket}/{project}/models/{model-slug}/` (the model name is sanitized — `/` is replaced with `-` for safe S3 paths). Subsequent deploys load from S3 (seconds instead of minutes).

!!! warning "Instance sizing for large models"
    The default `ml.m5.xlarge` (16 GB RAM) is sufficient for models up to ~15B parameters.
    Larger models require more memory for the download/checkpointing process:

    | Model Size | Recommended Instance |
    |-----------|---------------------|
    | ≤15B | `ml.m5.xlarge` (default) |
    | 15B–70B | `ml.m5.4xlarge` (64 GB RAM) |
    | 70B+ | `ml.m5.12xlarge` (192 GB RAM) |

After staging, `MODEL_NAME` in `do/config` is updated to the S3 URI. The original HuggingFace identifier is preserved as `HF_MODEL_ID` — this is used by `do/benchmark` for tokenizer resolution and by the benchmark writer for Athena partition paths.
The script is idempotent — if weights are already staged, it skips the download.

!!! tip "S3 Model URIs"
    You can also generate a project directly with an S3 model URI: `--model-name s3://bucket/models/my-model/`. This skips HuggingFace entirely — useful when weights are pre-staged in a shared team bucket.

## Deploying on Reserved Capacity (FTP)

If you have a Flexible Training Plan (FTP) or capacity reservation, pass the ARN at generation time:

```bash
ml-container-creator my-benchmark-project \
  --model-name s3://my-bucket/models/gemma-4-31b/ \
  --instance-type ml.p6-b200.48xlarge \
  --capacity-reservation-arn "arn:aws:sagemaker:us-east-2:ACCOUNT:training-plan/tp-XXX" \
  --skip-prompts
```

The endpoint will deploy exclusively on reserved capacity. FTPs are time-bound — ensure your reservation window covers the full benchmark duration (deployment + warm-up + all concurrency levels).

The instance-picker and endpoint-sizer MCP servers are FTP-aware — during interactive generation, they surface available capacity reservations in your account/region.
