!!! info "Two Model Package Groups per project"
    Each project creates **two separate MPGs** in SageMaker:

    | MPG | Created by | Purpose |
    |-----|-----------|---------|
    | `{project-name}` | `do/register` | **Deployment registry** — base model + adapters with full deployment context (container image, instance type, benchmark data, adapter lineage) |
    | `{project-name}-tune-models` | SageMaker `SFTTrainer`/`DPOTrainer` | **Training artifacts** — raw tuning outputs auto-registered by the managed customization service |

    These serve complementary purposes:

    - **Tune MPG** is auto-managed by SageMaker training. You don't control its schema or metadata — it's the training system's record of what was produced.
    - **Deployment MPG** is your explicit, schema-controlled registry. It records what's actually deployed, with full metadata for governance, reproducibility, and post-v1 features (`do/import`, `do/update`).

    Adapters appear in **both** — the tune MPG records the raw artifact, and `do/register` records the deployment with additional context (which endpoint, which instance, benchmark results, parent model linkage).

# Deployment Registry

The deployment registry tracks every configuration you deploy — model, instance, region, parameters, and status. Use it to audit what's running, compare configurations across environments, and feed the CI system with testable configurations.

---

## Quick Start

```bash
# Register a successful deployment
./do/register

# Register base model only (skip adapters)
./do/register --base-only

# Register a dataset from the last tune job
./do/register dataset --from-tune sft

# Register an evaluator
./do/register evaluator my-reward --type lambda --arn arn:aws:lambda:... --technique rlvr

# Register with notes
./do/register --notes "Upgraded to vLLM 0.8.5, 20% latency improvement"

# Register a partial success (e.g., deploy worked but tune failed)
./do/register --status partial --notes "Tune OOM on 32B model"

# Output as JSON (for scripting)
./do/register --json

# Register to CI table (DynamoDB)
./do/register --ci
```

---

## What Gets Captured

Every registration records:

| Field | Source | Example |
|---|---|---|
| **Project name** | `do/config` | `qwen3-4b-vllm` |
| **Deployment config** | `do/config` | `transformers-vllm` |
| **Architecture** | Derived from config | `transformers` |
| **Backend** | Derived from config | `vllm` |
| **Model name** | `do/config` | `Qwen/Qwen3-4B` |
| **Instance type** | `do/config` | `ml.g5.xlarge` |
| **Region** | `do/config` | `us-east-1` |
| **Deployment target** | `do/config` | `realtime-inference` |
| **Base image** | `do/config` | `vllm/vllm-openai:v0.8.5` |
| **IC list** | `do/ic/*.conf` | All inference components + adapters |
| **Parameters** | Environment variables | Engine-specific env vars (secrets redacted) |
| **Status** | `--status` flag | `success`, `partial`, `failed` |
| **Notes** | `--notes` flag | Free-text |
| **Generator version** | npm global install | `0.10.1` |

---

## Flags

| Flag | Description |
|---|---|
| `--status <value>` | One of: `success`, `partial`, `failed` (default: `success`) |
| `--notes "text"` | Free-text annotation |
| `--json` | Output deployment record as JSON to stdout |
| `--ci` | Write to CI DynamoDB table (implies `--json`) |
| `--ci-table <name>` | Override CI table name (default: `mlcc-ci-table`) |
| `--build-strategy <value>` | Record how the image was built (default: `codebuild-submit`) |
| `--project` | Include project-level metadata |
| `--base-only` | Register the base model only — skip adapter registration loop |
| `--exclude <name>` | Skip specific adapters (repeatable or comma-separated) |

---

## Storage Modes

### Local Registry (Default)

Without `--ci`, `do/register` calls `ml-container-creator registry log` which appends to the local registry. Use `ml-container-creator registry` subcommands to query it:

---

## Subcommands

`do/register` supports three subcommands: **model** (default), **dataset**, and **evaluator**.

### Model Registration (default)

When called without a subcommand (or with `model`), registers the deployed model as a versioned Model Package in SageMaker, then registers all adapters from `do/adapters/*.conf`.

!!! note "ECR image optional"
    MPG registration works even if the container hasn't been pushed to ECR yet. When no valid ECR image URI is available (e.g. before `do/build` + `do/push`), the Model Package is created **without an InferenceSpecification** — metadata (instance type, deployment config, model name) is still captured in `CustomerMetadataProperties`. The local registry always records the full entry regardless.

    If MPG registration fails for any reason, `do/register` continues with a warning:
    ```
    ⚠️  MPG registration failed (non-fatal) — local registry is the primary record
    ```

```bash
# Register base model + all adapters
./do/register

# Register base model only
./do/register --base-only

# Register all adapters except a specific one
./do/register --exclude llama-factory

# Exclude multiple adapters
./do/register --exclude "llama-factory,experimental-v1"
```

Each adapter in `do/adapters/*.conf` is registered as a linked ModelPackage version with `isAdapter=true` and `parentModelVersionArn` pointing to the base model version.

### Deploying from Registry

Use `do/adapter add --from-registry` to pull a previously registered adapter back into a project and deploy it as an inference component:

```bash
# Deploy using a specific version ARN from the deployment MPG
./do/adapter add my-sft --from-registry arn:aws:sagemaker:us-west-2:123456789012:model-package/my-project/24

# Interactive selection (queries the deployment MPG for adapter versions)
./do/adapter add --from-registry
```

!!! warning "Use the deployment MPG, not the tune MPG"
    `--from-registry` expects an ARN from the **deployment MPG** (`{project-name}`), not the tune MPG (`{project-name}-tune-models`). The tune MPG is auto-managed by SageMaker and doesn't contain the metadata needed for deployment (adapter S3 URI, technique, parent model linkage).

    To find available adapter versions in the deployment MPG:
    ```bash
    # List registered adapters
    python3 ./do/.register_helper.py list-adapters \
      --project-name my-project \
      --region us-west-2
    ```

**What `--from-registry` does:**

1. Calls `get-version` with the provided ARN to retrieve adapter metadata
2. Reads `modelDataUrl` from `CustomerMetadataProperties` (the adapter weights S3 path)
3. Creates/updates `do/adapters/<name>.conf` with the retrieved weights URI
4. Deploys the adapter as an inference component on the running endpoint

**Prerequisites:**

- The adapter must be registered in the **deployment MPG** (run `./do/register` first)
- The endpoint must be deployed and InService
- The adapter weights must still exist at the registered S3 path

**Workflow: Register once, deploy anywhere**

```bash
# Project A: tune, stage, register
./do/tune --technique sft --dataset "hf://tatsu-lab/alpaca"
./do/adapter --from-tune sft
./do/register

# Project B (or same project, fresh deployment): pull from registry
./do/adapter add my-sft --from-registry arn:aws:sagemaker:...:model-package/my-project/24
./do/test --adapter my-sft
./do/benchmark --adapter my-sft
```

This enables adapter portability across deployments, instance types, and even vLLM versions — as long as the base model architecture is compatible.

### Dataset Registration

Register a training dataset to the SageMaker AI Registry (with local JSON fallback):

```bash
# Register from the last tune job (auto-derives name, URI, technique, row count)
./do/register dataset --from-tune sft
./do/register dataset --from-tune dpo

# Register from the last custom training job (do/train output)
./do/register dataset --from-train sft

# With a custom name override
./do/register dataset my-custom-name --from-tune sft

# Fully explicit registration
./do/register dataset alpaca-sft-1k \
  --s3-uri s3://my-bucket/datasets/train.jsonl \
  --technique sft \
  --format jsonl \
  --row-count 1000
```

| Flag | Description |
|---|---|
| `<name>` | Dataset name (positional, or use `--name`) |
| `--s3-uri <uri>` | S3 URI of the dataset file (required unless `--from-tune`) |
| `--format <fmt>` | Format: `jsonl`, `parquet`, `csv` (default: `jsonl`) |
| `--technique <tech>` | Technique: `sft`, `dpo`, `rlaif`, `rlvr` (default: `sft`) |
| `--row-count <n>` | Number of records |
| `--column-schema <json>` | Column schema as JSON string |
| `--from-tune [technique]` | Auto-populate from the last tune job's persisted state |

### Evaluator Registration

Register a reward function (RLVR) or preference model (RLAIF):

```bash
./do/register evaluator my-reward-fn \
  --type lambda \
  --arn arn:aws:lambda:us-west-2:123456789012:function:my-reward \
  --technique rlvr \
  --description "Custom reward function for code quality"
```

| Flag | Description |
|---|---|
| `<name>` | Evaluator name (positional, or use `--name`) |
| `--type <type>` | Type: `lambda` or `model` (required) |
| `--arn <arn>` | Lambda ARN or model S3 URI (required) |
| `--technique <tech>` | Technique: `rlvr` or `rlaif` (required) |
| `--description <text>` | Optional description |

!!! note "Backward Compatibility"
    The older flag-based syntax (`./do/register --dataset --dataset-name ...` and `./do/register --evaluator --evaluator-name ...`) still works but is deprecated in favor of subcommands.

---

```bash
# List all registered deployments
ml-container-creator registry list

# Filter by deployment config
ml-container-creator registry list --deployment-config=transformers-vllm

# Show details for a specific entry
ml-container-creator registry show <id>
```

### CI Table (DynamoDB)

With `--ci`, the record is written to a DynamoDB table (provisioned by `ml-container-creator bootstrap --ci`). Each record gets a deterministic `configId` — a hash of `deploymentConfig:modelName:instanceType:region:deploymentTarget:icCount:adapterCount`.

If the configId already exists, the record is updated and `testStatus` is reset to `untested` — signaling the CI harness to re-validate.

```bash
# Register to CI table
./do/register --ci

# Use a custom table name
./do/register --ci --ci-table my-custom-table
```

!!! note "CI Infrastructure Required"
    The CI table must exist before `--ci` works. Run `ml-container-creator bootstrap` with CI enabled to provision it. See [Bootstrap](bootstrap.md) for details.

---

## Multi-IC and Adapter Tracking

For realtime-inference projects, the registry captures all inference components from `do/ic/*.conf` and all adapters from `do/adapters/*.conf`:

```json
{
  "icList": [
    {"name": "default", "image": "qwen3-4b-latest", "gpuCount": 1, "copyCount": 1},
    {"name": "tuned-sft", "isAdapter": true, "baseIcName": "default", "artifactUrl": "s3://..."}
  ]
}
```

In CI mode, only the first IC (alphabetically) is included to keep validation costs down.

---

## Parameter Capture

The registry captures environment variables relevant to each architecture:

- **Transformers/Diffusors** — Engine-prefixed vars (`VLLM_*`, `SGLANG_*`, etc.) + `HF_MODEL_ID`
- **HTTP** — All non-system env vars from `do/config`
- **Triton** — `config.pbtxt` content + `TRITON_MODEL_REPOSITORY`

Sensitive values (`HF_TOKEN`, `AWS_SECRET_ACCESS_KEY`, anything containing `SECRET` or `TOKEN`) are automatically redacted to `***REDACTED***`.

---

## Typical Workflow

```bash
# 1. Deploy
./do/build && ./do/push && ./do/deploy

# 2. Test
./do/test

# 3. Register (after confirming it works)
./do/register --notes "Initial deployment, inference validated"

# 4. Later: upgrade base image, re-deploy, re-register
./do/register --notes "vLLM 0.8.5 upgrade"
```

For CI pipelines, registration happens automatically as part of `do/ci`.
