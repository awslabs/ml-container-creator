!!! info "Registration flows through MLflow (the native Model Registry bridge)"
    Model and adapter registration go THROUGH MLflow: `do/register` and `do/tune`
    call `mlflow.register_model`, and SageMaker's native bridge
    (AutoModelRegistrationEnabled on the profile's MLflow App) auto-creates the
    corresponding SageMaker Model Package Group + version. You no longer create the
    group by hand, and there is no separate `{project}-tune-models` group — the tune
    output and your `do/register` records land in ONE catalog per project.

    Identity is **kind-aware**: a `full_model` (base model / full fine-tune) is its
    own MLflow registered model → its own bridge MPG, carrying an inference spec
    (deployable via `do/add-ic` / `do/add-pod`); a `lora_adapter` is linked to its
    base via a native lineage edge with NO inference spec (hot-loaded via
    `do/adapter`). The bridge group is `{registered-model-name}-{hash}`. Every
    version carries an `mlcc.artifact_kind` tag so the additive-deploy verbs gate by
    it (ADR-013): `do/adapter` refuses a `full_model` and points you at `do/add-ic`.

    **Enable + migration:** the bridge needs `UpdateModelPackage` / `CreateAction` /
    `AddAssociation` on the `core` role (BL164) — run
    `ml-container-creator bootstrap update --module core` once (~15 min to
    propagate). Pre-BL164 groups (`{project}`, `{project}-tune-models`) are left in
    place and stay resolvable by ARN; registration is go-forward only.

# Model Registration (MPG)

`do/register` records what you deploy as versioned Model Packages — base model, adapters, deployment context, and lineage — THROUGH the MLflow → SageMaker Model Registry bridge (see the note above). The resulting Model Package is the system of record; use it to audit what's running, govern versions, and feed the CI system with testable configurations.

!!! note "The local deployment registry was removed"
    Earlier versions also wrote a machine-local `registry.json` deployment-history
    file and shipped an `mcc registry` command. Both were removed — SageMaker MPG is
    now the single registration record. `do/register dataset` and
    `do/register evaluator` still use intentionally-local stores (there is no
    SageMaker API equivalent); those are unaffected.

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
| **Generator version** | npm global install | the installed `@aws/ml-container-creator` version |

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

## Where registrations are stored

`do/register` creates versioned Model Packages in the project's SageMaker MPG (`{project-name}`). Query them with the AWS CLI or console, or via the helper:

```bash
python3 ./do/.register_helper.py list-adapters --project-name my-project --region us-west-2
```

With `--ci`, the registration is additionally written to the CI DynamoDB table (`mlcc-ci-table` by default) for the end-to-end test harness.

---

## Subcommands

`do/register` supports three subcommands: **model** (default), **dataset**, and **evaluator**.

### Model Registration (default)

When called without a subcommand (or with `model`), registers the deployed model as a versioned Model Package in SageMaker, then registers all adapters from `do/adapters/*.conf`.

!!! note "ECR image optional"
    MPG registration works even if the container hasn't been pushed to ECR yet. When no valid ECR image URI is available (e.g. before `do/build` + `do/push`), the Model Package is created **without an InferenceSpecification** — metadata (instance type, deployment config, model name) is still captured in `CustomerMetadataProperties`.

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
# Deploy using a specific version ARN from the project's registry
./do/adapter add my-sft --from-registry arn:aws:sagemaker:us-west-2:123456789012:model-package/my-project-c76813/24

# Interactive selection (queries the project's registry for adapter versions)
./do/adapter add --from-registry
```

!!! note "Artifact-kind gate (ADR-013)"
    `--from-registry` resolves the version's `mlcc.artifact_kind` and REFUSES a
    `full_model` — a full fine-tuned model cannot be hot-loaded as a LoRA adapter;
    use `do/add-ic` (realtime) or `do/add-pod` (cluster) for those. An adapter
    version (`lora_adapter`) is accepted. A legacy version with no recorded
    artifact kind falls back to an `adapter_config.json` content check rather than
    being hard-blocked.

    With the MLflow bridge (BL164) there is ONE registry group per project
    (`{registered-model-name}-{hash}`) — the old split between a "deployment MPG"
    and a `{project}-tune-models` MPG is gone. List adapter versions with:
    ```bash
    python3 ./do/.register_helper.py list-adapters \
      --project-name my-project \
      --region us-west-2
    ```

**What `--from-registry` does:**

1. Calls `get-version` with the provided ARN to retrieve the version metadata (incl. `mlcc.artifact_kind`)
2. Runs the artifact-kind gate — refuses a `full_model`, accepts a `lora_adapter`
3. Reads `modelDataUrl` from `CustomerMetadataProperties` (the adapter weights S3 path)
4. Creates/updates `do/adapters/<name>.conf` with the retrieved weights URI
5. Deploys the adapter as an inference component on the running endpoint

**Prerequisites:**

- The adapter must be registered in the project's registry (run `./do/register` first)
- The endpoint must be deployed and InService
- The adapter weights must still exist at the registered S3 path

**Workflow: Register once, deploy anywhere**

```bash
# Project A: tune, stage, register
./do/tune --technique sft --dataset "hf://tatsu-lab/alpaca"
./do/adapter add tuned-sft --from-tune sft
./do/register

# Project B (or same project, fresh deployment): pull from registry
./do/adapter add my-sft --from-registry arn:aws:sagemaker:...:model-package/my-project/24
./do/test --adapter my-sft
./do/benchmark --adapter my-sft
```

This enables adapter portability across deployments, instance types, and even vLLM versions — as long as the base model architecture is compatible.

### Dataset Registration

`do/register dataset` **moves a dataset into the canonical MLCC datasets location**
on the `mlcc-core` bucket and registers it so it can be reused across tuning and
optimization jobs. The canonical destination is:

```
s3://<CORE_BUCKET>/datasets/<name>/
```

When MLflow is configured, a dataset is registered as a **first-class
`mlflow.data` Dataset** in the project's experiment (browsable in the MLflow
Experiment **Datasets** tab), alongside the run-input lineage edge — MLflow is the
**record of truth** (BL167). The **S3 sidecar** beside the data at
`s3://<CORE_BUCKET>/datasets/<name>/_dataset.json` is written first as the durable
**local record** and the fallback when MLflow is unconfigured; it also remains the
**version ledger** (`@v<N>` / semver pinning resolves from it). It replaces the
legacy local `~/.ml-container-creator/datasets.json` index (removed).

!!! note "Record of truth + reconcile (no sync daemon)"
    Registration writes the local sidecar first (always), then MLflow. If the
    MLflow App is briefly **unreachable**, `do/register` warns ("saved locally —
    re-run to reconcile") and still succeeds — it never fails on App downtime. A
    plain **re-run** of `do/register` converges MLflow to the local record (the
    write is idempotent). A **real** error (bad input, permissions) fails loudly.
    There is no background sync — you own reconciliation by re-running.

`CORE_BUCKET` is the `mlcc-core` bucket recorded in your active profile as
`codebuildSourceS3Bucket` (e.g. `mlcc-core-<account>-<region>`), provisioned by
`ml-container-creator bootstrap`.

!!! note "Studio discoverability (native AI Registry)"
    After the sidecar is written, `do/register dataset` **additively** registers
    the dataset in SageMaker's native AI Registry so it appears in **Studio
    Assets** — pointing at the same canonical S3 URI (no copy). This is
    best-effort: if it is skipped (unsupported region, old `sagemaker` SDK, or a
    `benchmark`/evaluator technique) or fails, the sidecar still stands and the
    dataset is fully usable. Studio **visibility** requires a Studio domain:
    provision the `sagemaker-domain` bootstrap module so its `DomainId` is
    captured into your profile and passed as the asset's domain tag. Datasets and
    evaluators live in the AI Registry; **models** live in the Model Package
    Group (never hub-mirrored). See
    [Dataset registry](fine-tuning.md#dataset-registry) in the fine-tuning guide
    for native versioning, technique→member mapping, and lineage details.

Provide **exactly one** input source:

```bash
# 1. Existing S3 dataset — copied to the canonical location, then registered.
#    A single object is copied with `aws s3 cp`; a directory/prefix (trailing
#    slash) is copied with `aws s3 sync`.
./do/register dataset alpaca-sft-1k \
  --s3-uri s3://my-bucket/datasets/train.jsonl \
  --technique sft \
  --row-count 1000

# 2. HuggingFace dataset — staged to the canonical location via the stage-hf
#    Processing Job, then registered. (do/tune no longer stages hf:// itself.)
./do/register dataset guanaco \
  --hf-id timdettmers/openassistant-guanaco \
  --technique sft \
  --row-count 500          # forwarded to staging as --take

# Register from the last tune job (auto-derives name, URI, technique, row count)
./do/register dataset --from-tune sft
./do/register dataset --from-tune dpo

# Register from the last custom training job (do/train output)
./do/register dataset --from-train sft

# List registered datasets (from the S3 sidecars)
./do/register dataset --list
```

| Flag | Description |
|---|---|
| `<name>` | Dataset name (positional, or use `--name`). Also the canonical S3 key: `datasets/<name>/` |
| `--s3-uri <s3://...>` | Existing S3 dataset. Copied to the canonical location (`cp` for an object, `sync` for a prefix). Mutually exclusive with `--hf-id` |
| `--hf-id <org/name>` | HuggingFace dataset ID. Staged to the canonical location via the stage-hf Processing Job. Mutually exclusive with `--s3-uri` |
| `--technique <tech>` | Technique: `sft`, `dpo`, `rlvr`, `rlaif`, `mtrl`, `benchmark` (default: `benchmark`). `sft`/`dpo` register under their own native member; `rlvr`/`rlaif`/`mtrl` under the RLVR member; `benchmark` is sidecar-only |
| `--row-count <n>` | Number of records. With `--hf-id`, passed to staging as `--take` |
| `--format <fmt>` | Format: `jsonl`, `parquet`, `csv` (default: `jsonl`) |
| `--column-schema <json>` | Column schema as JSON string |
| `--description <text>` | Human description shown on the native asset in Studio Assets |
| `--hf-split <split>` | (`--hf-id` only) Dataset split to stage (default: `train`) |
| `--column-map <map>` | (`--hf-id` only) Rename columns, e.g. `prompt=question,completion=answer` |
| `--attribution <text>` | Custom metadata: attribution (recorded under `customMetadata`) |
| `--lineage <text>` | Custom metadata: lineage |
| `--origination <text>` | Custom metadata: origination (e.g. `hf://org/name@rev`) |
| `--application <text>` | Custom metadata: application |
| `--force` | Register a new version even if the content hash is unchanged |
| `--list` | List registered datasets and exit. When MLflow is configured the read source is the shared MLflow catalog scoped to the active project; otherwise the S3 sidecars |
| `--all` | With `--list`: list datasets across every project under the profile, not just the active one |
| `--from-tune [technique]` | Auto-populate `--s3-uri` from the last tune job's persisted state |

!!! note "One source only"
    `--s3-uri` and `--hf-id` are mutually exclusive. Exactly one must be
    provided (or `--from-tune`, which resolves an `s3://` URI). Both paths end
    with the canonical `s3://<CORE_BUCKET>/datasets/<name>/` URI being registered
    and an S3 sidecar written beside it.

!!! note "Idempotent versioning"
    Registering unchanged content (same content hash) without `--force` is a
    no-op — no new sidecar version is created.

!!! note "Shared MLflow catalog, grouped per project"
    When MLflow tracking is configured, the catalog is **shared across the whole
    bootstrap profile** (one serverless MLflow store per profile). Runs are
    grouped into a **per-project experiment** named after your project, so
    `do/register dataset --list` and name resolution default to the active
    project and do not collide across projects. Pass `--all` to list across every
    project under the profile. Datasets registered before this grouping existed
    live in the default experiment and remain visible (reads include both).

    The `do/tune` flow reaches this same shared catalog automatically: the
    profile's MLflow reference is resolved for you at runtime (no manual env var
    to set). If your profile has no MLflow store configured, tuning proceeds
    without MLflow tracking — it never falls back to a local tracking file.

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

!!! note "Reward prompts also land in the MLflow Prompt Registry"
    A reward **prompt** (`do/register prompt`, RLAIF LLM-as-judge) is registered to
    SageMaker's AI Registry (the Studio record + the reference `do/tune` resolves)
    AND **additively** to the MLflow GenAI **Prompt Registry** — versioned,
    browsable in the MLflow Prompts tab (BL167). The MLflow copy follows the same
    local-first/reconcile-on-re-run hybrid. Reward **functions** (code/Lambda) have
    no MLflow home and register only to the AI Registry.

!!! note "Backward Compatibility"
    The older flag-based syntax (`./do/register --dataset --dataset-name ...` and `./do/register --evaluator --evaluator-name ...`) still works but is deprecated in favor of subcommands.

---

To list registered model/adapter versions, query the MPG with the AWS CLI (`aws sagemaker list-model-packages --model-package-group-name <project-name>`) or the `list-adapters` helper shown above.

### CI Table (DynamoDB)

With `--ci`, the record is written to a DynamoDB table (provisioned by the `ci` module — `ml-container-creator bootstrap add-module ci`). Each record gets a deterministic `configId` — a hash of `deploymentConfig:modelName:instanceType:region:deploymentTarget:icCount:adapterCount`.

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
