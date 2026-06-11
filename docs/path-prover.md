# Path Prover — Operations Guide

## Overview

The Path Prover is an agent mode that systematically proves untested configuration paths by running the full MCC lifecycle end-to-end. It identifies coverage gaps in the Athena benchmark table, finds nearest proven alternatives, and fills gaps by executing: generate → build → push → deploy → test → [tune → adapter → test] → benchmark → register → clean.

Results are written to Athena with `run_type = 'path_prove'`, distinguishable from regular CI runs (`ci`), optimization trials (`optimization`), and manual benchmarks (`manual`).

---

## When to Use

- **After initial CI stabilizes** — Run Path Prover once your golden-path models pass reliably
- **Before expanding to new instance families** — Prove that g6e or p5 instances work with your model families
- **Before onboarding new deployment configs** — Verify sglang or tensorrt-llm paths before recommending them
- **To fill coverage gaps** — Let the agent identify and prove missing combinations automatically

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Path Prover Brain (src/lib/path-prover-brain.js)               │
│    • identifyGaps() — find unproven dimension combinations      │
│    • findNearestSubstitution() — Hamming distance nearest-match │
│    • classifyFailure() — categorize errors for retry/skip       │
│    • buildPathProverRecord() — create Athena-compatible record  │
├─────────────────────────────────────────────────────────────────┤
│  Step Functions State Machine (path-prover.asl.json)            │
│    Brain → Generate → Build/Push → Deploy/Test → [Tune] →      │
│    Benchmark → WriteResults → Clean → PickNext → End           │
├─────────────────────────────────────────────────────────────────┤
│  Athena Table: mlcc_ci.benchmark_results                        │
│    Results stored with run_type='path_prove'                    │
└─────────────────────────────────────────────────────────────────┘
```

!!! note "Prerequisites"
    Path Prover requires the benchmark infrastructure to be provisioned: `ml-container-creator bootstrap --ci --benchmark-infra`. Without this, Athena writes will fail (no Glue database or table exists).

!!! info "CodeBuild execution model"
    The Step Functions state machine invokes CodeBuild jobs in **fire-and-forget** mode (not synchronous `.sync` integration). The state machine polls for job completion via a wait loop rather than blocking on the CodeBuild API. This prevents Step Functions execution timeouts on long-running stages (e.g., tune jobs that take 1-2 hours).

---

## Configuration Dimensions

The Path Prover operates on a discrete dimension vector:

| Dimension | Examples |
|---|---|
| `deployment_config` | transformers-vllm, transformers-sglang, http-flask |
| `model_family` | qwen3, llama3, deepseek-r1 |
| `instance_family` | g5, g6e, p5 |
| `quantization` | none, fp8, awq, gptq |
| `tp_degree` | 1, 2, 4, 8 |
| `deployment_target` | realtime-inference, async-inference, batch-transform |

---

## Substitution Algorithm

When a user requests a configuration that has no proven path, the Path Prover finds the closest proven alternative using **Hamming distance** (count of dimensions that differ).

**Rules:**
1. Only suggest alternatives with `status = 'completed'` in Athena
2. Never cross the `model_family` boundary — qwen3 suggestions won't include llama3 results
3. Prefer maximum feature overlap (fewest dimension changes)
4. Results ordered by ascending distance, then by recency

**Example:**

```
Requested:  sglang + async-inference + Qwen3-8B + ml.g5.xlarge + fp16 + tp=1

Proven #1:  vllm + async-inference + Qwen3-8B + ml.g5.xlarge + fp16 + tp=1
            Distance: 1 (swapped: deployment_config)

Proven #2:  sglang + realtime-inference + Qwen3-8B + ml.g5.xlarge + fp16 + tp=1
            Distance: 1 (swapped: deployment_target)

Proven #3:  vllm + realtime-inference + Qwen3-8B + ml.g5.xlarge + fp16 + tp=1
            Distance: 2
```

When no proven alternative exists within the same model family, the response is:
```
"no coverage — nearest proven config is N dimensions away"
```

---

## Gap Identification

The brain queries Athena for all proven configs, extracts unique values for each dimension, and computes the cartesian product. Combinations with no matching proven record are gaps.

Gaps are prioritized by **neighbor count** — gaps with more proven neighbors (distance=1) are proved first, since they are more likely to succeed and provide more incremental coverage.

---

## Failure Classification

When a prove run fails, the Path Prover classifies the error:

| Category | Retryable | Signal | Action |
|---|---|---|---|
| `capacity` | Yes | `InsufficientInstanceCapacity` | Retry after 1h or try next instance |
| `timeout` | Yes | Deploy/benchmark exceeded timeout | Retry with longer timeout |
| `oom` | No | CUDA OOM, killed by memory | Mark unfeasible — instance too small |
| `code_bug` | No | Template error, script crash | Mark unfeasible pending fix |
| `model_incompatibility` | No | LoRA not supported, wrong architecture | Mark unfeasible |
| `service_limitation` | No | Region/API restriction | Mark unfeasible |

**Non-retryable failures** write a record with `status = 'unfeasible'` and a populated `failure_reason`, preventing repeated attempts on the same known-bad configuration.

---

## Tune/Adapter Gating

The tune and adapter stages only execute when the prove request explicitly includes fine-tuning:
- The gap involves a tune technique (e.g., SFT with LoRA)
- The user requested adapter serving validation

If the prove request is inference-only, tune stages are skipped entirely.

---

## Budget Controls

Each Path Prover execution accepts budget parameters:

| Parameter | Default | Description |
|---|---|---|
| `MAX_PROVES_PER_RUN` | 10 | Maximum configs to prove in one execution |
| `MAX_COST_PER_RUN` | 50 (USD) | Estimated cost ceiling |

The brain tracks cumulative cost (instance-hours × $/hr from the instance catalog) and terminates early when the next prove would exceed the budget.

---

## Trigger Modes

### Scheduled (EventBridge)

An EventBridge rule triggers Path Prover on a schedule (disabled by default):

```bash
# Enable the schedule via CDK parameter
cdk deploy MlccCiHarnessStack -c CreatePathProver=true -c PathProverSchedule="rate(1 day)"
```

### Manual

Trigger via CLI or API:

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:111111111111:stateMachine:mlcc-path-prover \
  --input '{"MAX_PROVES_PER_RUN": 5, "MAX_COST_PER_RUN": 25}'
```

---

## Monitoring

### Check Path Prover Results

Query Athena for all path_prove runs:

```sql
SELECT config_id, model_family, instance_family, deployment_config, status
FROM mlcc_ci.benchmark_results
WHERE run_type = 'path_prove'
ORDER BY run_timestamp DESC
LIMIT 20;
```

### Check Unfeasible Configs

```sql
SELECT config_id, model_family, instance_family, deployment_config, failure_reason
FROM mlcc_ci.benchmark_results
WHERE status = 'unfeasible'
ORDER BY run_timestamp DESC;
```

### Coverage Summary

```sql
SELECT model_family, instance_family, COUNT(*) as proven_count
FROM mlcc_ci.benchmark_results
WHERE status = 'completed'
GROUP BY model_family, instance_family
ORDER BY proven_count DESC;
```

---

## Troubleshooting

**Path Prover keeps retrying the same config:**
Check if the failure is classified as retryable (`capacity` or `timeout`). For persistent capacity issues, either wait for availability or mark the config as unfeasible manually.

**"No coverage" for a model family:**
The requested model family has no proven configs at all. Prove at least one config in that family manually via the CI runner first, then Path Prover can expand from there.

**Tune stages running unexpectedly:**
Verify the prove request does not include fine-tuning parameters. Tune stages only execute when explicitly requested.

**Budget exceeded before completing all gaps:**
Increase `MAX_COST_PER_RUN` or run multiple executions. The brain picks up where it left off based on the current Athena state.

---

## Related

- [CI Integration](ci-integration.md) — Two-stage pipeline and E2E validation
- [Coverage Manifold](coverage-manifold.md) — Visualization of the configuration space
- [Bootstrap](bootstrap.md) — Infrastructure provisioning including Athena/Glue
