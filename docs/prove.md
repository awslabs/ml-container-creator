# Prove

`mcc prove` runs the full `do/` lifecycle end-to-end for a configuration and records the result in DynamoDB. Use it to validate that a new model, instance type, or serving configuration actually works before adding it to the catalog — and to expand the catalog with proven results.

!!! info "Prove vs Path Prover"
    `mcc prove` is the local, on-demand CLI tool for interactive exploration. The [Path Prover](path-prover.md) is the scheduled cloud system (Step Functions + CodeBuild) that systematically fills coverage gaps overnight. Both write to the same DynamoDB table with different `run_type` values.

## Prerequisites

| Requirement | Details |
|---|---|
| Bootstrapped account | Run `ml-container-creator bootstrap` with the benchmark module: `bootstrap add-module benchmark` |
| AWS credentials | Configured via `aws configure` or environment variables with permissions for SageMaker, ECR, S3, and DynamoDB |
| Node.js 18+ | Required for the MCC CLI |
| Docker | Required for `build` and `push` stages |
| Python 3.10+ | Required if `tune` or `adapter` stages are included |

## Quick Start

Create a `prove.json` config, run it, and inspect results:

```bash
# 1. Create a prove config (interactive wizard)
mcc prove --interactive

# 2. Or write one manually
cat > prove.json << 'EOF'
{
  "schema_version": "1",
  "base": {
    "model_name": "Qwen/Qwen3-4B",
    "deployment_config": "transformers-vllm",
    "instance_type": "ml.g5.xlarge"
  },
  "stages": ["generate", "build", "push", "deploy", "test", "benchmark", "clean"],
  "timeout_minutes": 90,
  "budget_usd": 50
}
EOF

# 3. Run the prove pipeline
mcc prove prove.json

# 4. Check results
mcc prove report
```

## prove.json Format

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | Yes | Schema version — currently `"1"` |
| `base.model_name` | string | Yes | HuggingFace model ID (e.g., `Qwen/Qwen3-4B`) |
| `base.deployment_config` | string | Yes | Deployment configuration (e.g., `transformers-vllm`, `transformers-sglang`) |
| `base.instance_type` | string | Yes | SageMaker instance type (e.g., `ml.g5.xlarge`) |
| `base.max_model_len` | number | No | Maximum model context length |
| `base.quantization` | string | No | Quantization method (`fp8`, `awq`, `gptq`, or omit for none) |
| `base.enable_lora` | boolean | No | Enable LoRA adapter serving |
| `sweep` | object | No | Sweep axes for Cartesian product expansion (see [Sweep Mode](#sweep-mode)) |
| `stages` | string[] | Yes | Ordered lifecycle stages to execute |
| `timeout_minutes` | number | No | Overall timeout in minutes (default: 90) |
| `budget_usd` | number | No | Budget ceiling in USD (default: 50) |

Valid stages: `generate`, `stage`, `build`, `push`, `deploy`, `test`, `tune`, `adapter`, `test-adapter`, `benchmark`, `register`, `clean`.

## Sweep Mode

The `sweep` field expands to the Cartesian product of all axes, merged with `base`. Each combination runs as an independent prove pipeline.

```json
{
  "schema_version": "1",
  "base": {
    "model_name": "Qwen/Qwen3-4B",
    "deployment_config": "transformers-vllm"
  },
  "sweep": {
    "instance_type": ["ml.g5.xlarge", "ml.g5.2xlarge", "ml.g6e.xlarge"],
    "quantization": ["none", "fp8"]
  },
  "stages": ["generate", "build", "push", "deploy", "test", "benchmark", "clean"],
  "timeout_minutes": 90,
  "budget_usd": 100
}
```

This produces 3 × 2 = **6 configurations**, each proved independently.

!!! warning "Cost Warning"
    Sweep mode multiplies cost by the number of combinations. A 6-config sweep with deploy + benchmark stages can cost $30–$60+. Use `--dry-run` to preview expansions before committing.

Control parallelism with `--concurrency`:

```bash
# Run up to 3 configs simultaneously
mcc prove prove.json --concurrency 3
```

## Resumable Runs

Each prove run writes progress to `.mlcc/.prove-state.json` inside the workspace directory (`~/.mlcc/prove/<config-hash>/project/`). If a run is interrupted or fails:

- **Idempotent stages** (`generate`, `stage`) check for prior success and skip automatically on re-run
- **All stages** record their status via `.prove-state.json` — passed stages are not re-executed
- **Re-run the same config** to resume from the last failure point

```bash
# First run fails at deploy stage
mcc prove prove.json
# ❌ deploy failed: InsufficientInstanceCapacity

# Fix the issue (wait for capacity) and re-run — skips generate/build/push
mcc prove prove.json
```

The `stage` step has additional idempotency: it checks for `.mlcc/staged-assets.json` with a valid `staged_uri` before re-uploading model weights.

## Commands

| Command | Description |
|---|---|
| `mcc prove <config.json>` | Run a prove config file end-to-end |
| `mcc prove --interactive` | Build and run a prove config via interactive wizard |
| `mcc prove report` | Query DynamoDB for prove results and print summary table |
| `mcc prove sync` | Promote proven results to catalogs (see [Catalog Sync](#catalog-sync-prove-sync)) |
| `mcc prove status` | Show local prove workspace state (stages completed, last run time) |

### CLI Overrides

Override `prove.json` fields from the command line:

```bash
mcc prove prove.json --model Qwen/Qwen3-8B --instance-type ml.g5.2xlarge --stages generate,build,push,deploy,test,clean
```

| Flag | Description |
|---|---|
| `--model <name>` | Override `base.model_name` |
| `--deployment-config <config>` | Override `base.deployment_config` |
| `--instance-type <type>` | Override `base.instance_type` |
| `--stages <csv>` | Override stages (comma-separated) |
| `--concurrency <n>` | Run up to N configs in parallel (default: 1) |
| `--dry-run` | Print expansion and exit without executing |
| `--no-clean` | Skip the `clean` stage (leave resources for debugging) |
| `--verbose` | Stream stage stdout/stderr in real time |

## Catalog Sync (`prove sync`)

`prove sync` promotes passing prove results from DynamoDB into the local catalogs, making proven configurations available for recommendations by MCP servers (instance-sizer, model-picker).

```bash
# Preview what would be promoted
mcc prove sync --dry-run

# Promote passing results
mcc prove sync
```

Promotion rules:

- Only results with `status = 'pass'` (all stages completed) are eligible
- One passing run is sufficient for auto-promotion
- `--dry-run` shows the diff without writing catalog files

## Budget Controls

| Control | Scope | Description |
|---|---|---|
| `budget_usd` (in prove.json) | Per prove run | Maximum estimated cost for the entire prove execution. The pipeline tracks cumulative instance-hours and stops before exceeding this ceiling. |
| `--budget <usd>` | CLI override | Override the `budget_usd` field from the command line |
| `MAX_COST_PER_RUN` | Path Prover | Budget ceiling for the cloud Path Prover (default: $50) — not used by local `mcc prove` |

Cost is estimated from instance-hours using pricing data in the instance catalog. Actual AWS billing may differ due to data transfer, S3 storage, and other ancillary costs.

## Output & Results

### DynamoDB Records

Each prove run writes a record to the CI results DynamoDB table with:

| Field | Description |
|---|---|
| `configId` | `prove-<config-hash>` — deterministic 16-char SHA-256 hash of the config |
| `testStatus` | `pass` or `fail` |
| `steps` | Array of step results with name, status, duration, and error (if any) |
| `duration` | Total wall-clock time in milliseconds |
| `lastTestTimestamp` | ISO 8601 timestamp of run completion |

### Querying Results

```bash
# CLI report
mcc prove report
```

For advanced queries, use Athena SQL against the `mlcc_ci.benchmark_results` table:

```sql
SELECT config_id, model_family, instance_family, deployment_config, status, run_timestamp
FROM mlcc_ci.benchmark_results
WHERE run_type = 'prove'
ORDER BY run_timestamp DESC
LIMIT 20;
```

### Local Workspace

Prove workspaces live at `~/.mlcc/prove/<config-hash>/project/`. Each workspace contains the generated project, state files, and build artifacts. Use `mcc prove status` to inspect workspace state.

## Related

- [Path Prover](path-prover.md) — Scheduled cloud system for systematic coverage expansion
- [CI Integration](ci-integration.md) — Two-stage pipeline and E2E validation
- [Benchmarking](benchmarking.md) — Performance measurement and comparison
- [Bootstrap](bootstrap.md) — Infrastructure provisioning including DynamoDB and Athena
