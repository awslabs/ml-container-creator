
!!! tip "Need full control over your training code?"
    If you need to customize the training loop, use a different trainer, or bring your own training script, see [Custom Training](custom-training.md) — it provides the same lifecycle integration with full code control.

ML Container Creator includes a `do/tune` command that wraps SageMaker AI Managed Model Customization — a serverless fine-tuning capability that eliminates instance selection and container management. You provide a dataset and technique; SageMaker AI handles infrastructure, optimization, and produces a deployable model artifact that feeds directly back into your project's deployment lifecycle.

## `do/tune` vs `do/train`: the two training surfaces

MLCC splits training across two surfaces by **how much of the loop you own**, not
by technique flavor. Pick the surface first, then the technique.

| | `do/tune` (managed) | `do/train` (super-user) |
|---|---|---|
| **What it wraps** | SageMaker Managed Model Customization (serverless) | `CreateTrainingJob` with your own container + script |
| **Infrastructure** | Managed — no instance selection | You choose the instance type |
| **Training code** | SageMaker's built-in trainers | Your script (ships with editable recipes) |
| **Models** | Supported Model Catalog only | Any HuggingFace model |
| **Supervised techniques** | SFT, DPO | SFT, DPO + any custom technique |
| **Reinforcement learning** | Managed RLVR / RLAIF / MTRL | Self-managed **GRPO** |
| **Reward (for RL)** | A **registered SageMaker evaluator asset** (a Lambda, referenced by ARN) | An **in-process Python callable** you write in the recipe |
| **You edit the training/reward code?** | No | Yes — that is the point |
| **When to choose** | You want a hands-off managed customization | You need to own and modify the training/reward loop |

!!! info "GRPO is on `do/train`, not `do/tune`"
    GRPO (Group Relative Policy Optimization) is **self-managed** reinforcement
    learning: the reward is an in-process Python callable you author in the recipe
    (`training/grpo/reward_example.py`), with no managed evaluator service in the
    loop. See [Custom Training → GRPO](custom-training.md#grpo-group-relative-policy-optimization).
    The managed RL path on `do/tune` is the opposite: its reward is a
    separately-registered evaluator asset (an ARN). Both are called a "reward
    function"; they are different mechanisms.

## Prerequisites

| Requirement | Details |
|---|---|
| Deployed endpoint | Endpoint must be `InService` (run `./do/deploy` first) |
| AWS credentials | Configured via `aws configure` or environment variables |
| Framework | `transformers` only |
| Deployment target | Any target except `batch-transform` |
| Bootstrapped account | Run `ml-container-creator bootstrap` to provision IAM permissions and tune S3 bucket |
| Python SDK | `sagemaker-core>=1.0.0` — install via `uv pip install -r requirements.txt` |

!!! note "Supported Models Only"
    `do/tune` works with models in the Supported Model Catalog. If your model isn't supported, the script will tell you which models are available and suggest `do/train` for custom training workflows.

## The Tune-Adapter-Deploy Feedback Loop

The fine-tuning workflow follows an iterative loop: prepare your dataset, tune the model, deploy the result, test it, and iterate until you're satisfied with quality.

```mermaid
graph LR
    A[Prepare<br>dataset] --> B[do/tune<br>auto-deploys] --> D[do/test] --> E{Quality<br>OK?}
    E -->|No| A
    E -->|Yes| F[Production]
```

### Step-by-step flow

1. **Prepare your dataset** — Format training data as JSONL matching the expected schema for your technique (see [Dataset Formats](#dataset-formats) below)

2. **Run `do/tune`** — Submit a managed customization job:
   ```bash
   ./do/tune --technique sft --dataset s3://my-bucket/train.jsonl
   ```

3. **Adapter automatically deployed** — When `do/tune` completes a LoRA job, it automatically:
   1. Stages adapter weights to S3 via a Processing Job
   2. Deploys the adapter as an inference component on your endpoint
   3. Registers the adapter through the MLflow → Model Registry bridge (as a `lora_adapter`, linked to its base) — see [Deployment Registry](deployment-registry.md)

   The auto-deployed adapter is named `tuned-<technique>-<dataset-slug>` (e.g. `tuned-sft-alpaca`).

   !!! tip "Skip auto-deployment"
       Pass `--no-register` to skip this automatic flow and manage adapters manually:
       ```bash
       ./do/tune --technique sft --dataset ... --no-register
       # Then deploy manually when ready:
       ./do/adapter add my-adapter --from-tune sft
       ```

   For **full merged model** output (`--training-type full-rank`), there is no auto-deploy.
   Run manually after the job completes:
   ```bash
   ./do/add-ic tuned-v1 --from-tune
   ```

4. **Test the result** — Verify the fine-tuned model behaves as expected:
   ```bash
   ./do/test
   ```

5. **Iterate** — If quality isn't satisfactory, adjust your dataset or hyperparameters and re-run `do/tune`. Each technique tracks its own state independently, so you can experiment with SFT and DPO in parallel without interference.

## How Output Feeds Into Deployment

When `do/tune` completes, it stores the output artifact path in `do/config` and detects the output type based on the training type used:

| Training Type | Output Type | Config Variable | Deployment Command |
|---|---|---|---|
| `lora` (default) | LoRA adapter weights | `TUNE_ADAPTER_PATH_<TECHNIQUE>` | `do/adapter add --from-tune` |
| `full-rank` | Full merged model | `TUNE_MODEL_PATH_<TECHNIQUE>` | `do/add-ic --from-tune` |

The `--from-tune` flag reads the output path from `do/config` automatically — no need to copy S3 URIs manually.

When a tune completes, `do/tune` **promotes** the servable output from the artifacts bucket to its canonical home in the core bucket (adapters: `models/<org>/<base>/.mlcc-adapters/<project>/<name>/v<hash12>/`; full models: `models/mlcc-<project>/<name>/`) with a manifest, and records that URI in `TUNE_ADAPTER_PATH_<TECHNIQUE>` / `TUNE_MODEL_PATH_<TECHNIQUE>`. The raw job output stays in `TUNE_OUTPUT_PATH_<TECHNIQUE>`. `do/adapter add` loads the canonical version on every target. A source that isn't canonical yet is promoted first, with a server-side S3 copy that uses your credentials. For projects tuned before this change, backfill with `./do/adapter promote <name> --from-tune <technique> --update-config`. See [S3 buckets & layout](architecture/s3-layout.md).

Adapter versions are content-addressed: `v<hash12>` is the first 12 hex digits of the adapter's content hash.

- **Same files, same version.** Re-promoting or re-adding identical files is `unchanged`, and nothing is copied.
- **New files, new version.** New content gets a new version directory, and older versions are never rewritten.
- **`update` on realtime-inference.** `./do/adapter update <name>` points the adapter inference component at the new version's `ArtifactUrl`. When the content is unchanged, it sends no `UpdateInferenceComponent` call.
- **`update` on hyperpod-eks / eks.** It unloads and reloads `<name>` from the new version's path on every pod.
- **Rollback.** Run `./do/adapter update <name> --from-weights <previous version URI>`. The previous URI is printed by `update` and recorded in `do/adapters/<name>.conf`.
- **Pre-versioning adapters.** Adapter prefixes promoted before versioning existed, and hand copies, keep working as-is.

### Adapter output (LoRA)

```bash
# Use the latest tune output (any technique)
./do/adapter add tuned-sft --from-tune

# Use a specific technique's output
./do/adapter add tuned-sft --from-tune sft

# Or pass the S3 path explicitly (--weights still works as a deprecated alias)
./do/adapter add tuned-sft --from-weights s3://<artifacts-bucket>/<project>/tune/sft/<job>/output/model/checkpoints/hf/

# Backfill an adapter tuned before canonical promotion existed
./do/adapter promote tuned-sft --from-tune sft --update-config
```

!!! tip "Post-tune deploy-fit (rank/alpha)"
    When a LoRA tune completes, `do/tune` surfaces the adapter's effective rank and
    alpha (read from its `adapter_config.json`) and compares the rank with the
    EFFECTIVE serving `max_lora_rank` — the value the next deploy applies (an explicit
    `VLLM_MAX_LORA_RANK`, else derived from the recorded adapters and the engine
    default). Above it, the note says the next `./do/deploy` raises the limit
    automatically (or, with an explicit value, that you must raise it); redeploy before
    hot-loading. The note never blocks the tune or lowers its rank. See
    [LoRA delivery and rank fit on Kubernetes](architecture/k8s-lora-delivery.md).

### Full model output

```bash
# Deploy as a new inference component
./do/add-ic tuned-v1 --from-tune

# Or pass the S3 path explicitly (--model-data still works as a deprecated alias)
./do/add-ic tuned-v1 --from-weights s3://<artifacts-bucket>/<project>/tune/sft/<job>/output/model/checkpoints/hf_merged/

# Or a registered full-model version
./do/add-ic tuned-v1 --from-registry arn:aws:sagemaker:us-east-1:123456789012:model-package/my-project/3

# Swap the current base IC's artifact in place
./do/add-ic default --update --from-weights s3://<artifacts-bucket>/<project>/tune/sft/<job>/output/model/checkpoints/hf_merged/
```

### One `--from-*` family on every target

Both additive verbs take the same source flags (`--from-weights <s3-uri>`,
`--from-tune [technique]`, `--from-train [technique]`, `--from-registry <arn>`,
and, for `do/adapter`, `--from-hub <repo>`) and resolve them the same way on
every deployment target ([ADR-013](adr/ADR-013-additive-deploy-artifact-kind-contract.md)).
The target only picks the load mechanism:

| Target | `do/adapter` (LoRA adapter) | `do/add-ic` (full model) |
|---|---|---|
| `realtime-inference` | adapter Inference Component | Inference Component |
| `hyperpod-eks` / `eks` | vLLM hot-load into the running pod | not supported yet (see below) |

On a cluster, a tuned LoRA hot-loads straight from the tune output. There is no
hand-copied S3 URI and no new pod:

```bash
./do/adapter add tuned-sft --from-tune        # hyperpod-eks / eks
./do/adapter list
./do/adapter remove tuned-sft
```

The artifact kind decides which verb is legal. `do/adapter` refuses a full
fine-tuned model and `do/add-ic` refuses a LoRA adapter, each pointing at the
other verb. A full model on `hyperpod-eks`/`eks` is refused honestly as "not
servable on this target yet": the cluster full-model verb (`do/add-pod`) is
deferred, so deploy full models on `realtime-inference` with `do/add-ic`. When a
source has no recorded kind (a raw `--from-weights` URI, a Hub repo, or an older
registry version), nothing is blocked; the verb runs an advisory
`adapter_config.json` check and proceeds.

!!! note "Deprecated flags"
    `do/adapter --weights` and `do/add-ic --model-data` are deprecated aliases of
    `--from-weights`. They keep working and print a one-line notice. Switch to
    `--from-weights` at your convenience. `do/register --model-data-url` is a
    different flag and is unchanged.

### Multiple techniques

Each technique's output is tracked independently. You can tune with SFT, then tune with DPO, and deploy either result:

```bash
# Tune with SFT
./do/tune --technique sft --dataset s3://my-bucket/sft-data.jsonl

# Tune with DPO (doesn't affect SFT output)
./do/tune --technique dpo --dataset s3://my-bucket/dpo-data.jsonl

# Deploy the SFT adapter
./do/adapter add tuned-sft --from-tune sft

# Or deploy the DPO adapter instead
./do/adapter add tuned-dpo --from-tune dpo
```

## Supported Models

The following model families support managed customization via `do/tune`:

| Provider | Model Family | Sizes | Techniques |
|---|---|---|---|
| Alibaba | Qwen 2.5 | 7B, 14B, 32B, 72B | SFT, DPO, RLAIF, RLVR |
| Alibaba | Qwen 3 | 0.6B, 1.7B, 4B, 8B, 14B, 32B | SFT, DPO, RLAIF, RLVR |
| Alibaba | Qwen 3.5 (VLM) | 4B, 9B, 27B | SFT, RLAIF, RLVR |
| Alibaba | Qwen 3.6 (VLM) | 27B | SFT, RLAIF, RLVR |
| DeepSeek | R1 Distill (Llama) | 8B, 70B | SFT, DPO, RLAIF, RLVR |
| DeepSeek | R1 Distill (Qwen) | 1.5B, 7B, 14B, 32B | SFT, DPO, RLAIF, RLVR |
| Meta | Llama 3.1 Instruct | 8B | SFT, DPO, RLAIF, RLVR |
| Meta | Llama 3.2 Instruct | 1B, 3B | SFT, DPO, RLAIF, RLVR |
| Meta | Llama 3.3 Instruct | 70B | SFT, DPO, RLAIF, RLVR |
| OpenAI | GPT-OSS | 20B, 120B | SFT, DPO, RLAIF, RLVR |

**26 models total** across 10 families. VLM (Vision-Language) models support SFT, RLAIF, and RLVR but not DPO.

View the full catalog at any time:

```bash
./do/tune --list-models
```

### Unsupported model behavior

If your configured model is not in the Supported Model Catalog, `do/tune` exits with a clear message:

```text
❌ Model "my-custom-model-7b" is not yet supported for managed customization.

   Supported model families:
   • Alibaba Qwen 2.5 / Qwen 3 / Qwen 3.5 (VLM) / Qwen 3.6 (VLM)
   • DeepSeek R1 Distill
   • Meta Llama 3.1 / 3.2 / 3.3
   • OpenAI GPT-OSS

   For custom training workflows, use do/train.
```

The script validates your model at runtime against the catalog, so catalog updates take effect without regenerating your project.

## Dataset Management

### Listing datasets

!!! warning "`do/tune --list-datasets` is deprecated"
    Dataset management is now centralized under `do/register dataset` (BL092).
    `do/tune --list-datasets` prints a pointer and exits — it no longer lists
    datasets. Use `do/register dataset --list` instead.

```bash
# List registered datasets (from the S3 sidecar registry)
./do/register dataset --list
```

Datasets are indexed by an **S3 sidecar** — a JSON metadata object stored beside
the data in the MLCC Core bucket at `s3://<CORE_BUCKET>/datasets/<name>/_dataset.json`.
The sidecar is the source of truth for versioning, content hashes, and `@v<N>`
pinning. Because it lives in S3 (not on your laptop), the registry is durable and
shared across machines and teammates who use the same Core bucket.

!!! note "Local registry removed"
    Earlier versions cached dataset metadata in `~/.ml-container-creator/datasets.json`.
    That local index has been removed (hard cutover) — a pre-existing file is
    ignored. All dataset metadata now lives in the S3 sidecar.

### Row count

When you register a dataset without specifying `--row-count`, MCC automatically counts rows by streaming the S3 file:

- **jsonl / ndjson** — counts newlines
- **csv / tsv** — counts newlines minus 1 (header)
- **parquet** — reads footer metadata (no full file read)

Row count is non-fatal — if the format is unsupported or S3 access fails, registration proceeds with `row_count: null`.

### Technique guardrail

If you try to use a dataset registered for a different technique (e.g., an SFT dataset for DPO tuning), `do/tune` warns you:

```
⚠️  Dataset 'my-sft-dataset' was registered for technique 'sft'
    but you're using --technique dpo. Proceeding anyway.
```

The warning is non-blocking — tuning proceeds. In automated (`MLCC_AUTO_MODE=1`) environments, the mismatch causes an auto-decline with exit code 4 to prevent silent data mismatches in CI pipelines.

## Techniques

`do/tune` supports five managed customization techniques. Each requires a different
dataset format, and the three reinforcement-fine-tuning (RFT) techniques also require
a registered **evaluator** — see [Managed RL evaluators](#managed-rl-evaluators-rlvr-rlaif-mtrl).

| Technique | Use Case | Inputs (register these first) |
|---|---|---|
| **SFT** | Teach the model a specific style or task | Dataset only — prompt/completion pairs |
| **DPO** | Align the model with human preferences | Dataset only — prompt with chosen/rejected responses |
| **RLVR** | Align using code-based verification | Parquet prompt dataset (verl 5-field) **+** a reward **function** (`do/register evaluator`) |
| **RLAIF** | Align using an AI judge | Parquet prompt dataset (verl 5-field) **+** a reward **prompt** (`do/register prompt`) |
| **MTRL** _(deferred — not yet runnable)_ | Multi-turn reinforcement learning | Plain-`prompt` dataset **+** a `CustomAgentLambda` via `--agent-env` (no model supports MTRL yet) |

SFT and DPO need a dataset only. **RLVR and RLAIF** need **two** separately-registered
inputs — a prompt dataset AND an evaluator — and `do/tune` fails before submission if
either is missing, naming the one to register. **MTRL** is different: it needs a prompt
dataset AND an agent (`--agent-env`), not an evaluator — and it is not yet runnable (no
catalog model supports it). The validated managed-RL techniques are RLVR and RLAIF.

Not all models support all techniques. Check what's available for your model:

```bash
./do/tune --list-models
```

### Training types

Each model+technique combination supports one or both training types:

- **`lora`** (default) — Produces lightweight LoRA adapter weights. Faster to train, smaller artifacts, deployed via `do/adapter add`.
- **`full-rank`** — Produces a full merged model. Longer training, larger artifacts, deployed via `do/add-ic`.

```bash
# LoRA adapter (default)
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl

# Full-rank fine-tuning
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl --training-type full-rank
```

## Dataset Formats

The required format differs by technique family:

- **SFT / DPO** — **JSONL** (one JSON object per line). `do/tune` validates the first
  10 lines before submitting.
- **RLVR / RLAIF** — **Parquet** in verl's 5-field schema (see
  [Managed RL dataset format](#managed-rl-dataset-format-rlvr--rlaif) below). The
  managed RL trainer's loader is parquet-only; a JSONL file fails in-container with
  `ArrowInvalid: Parquet magic bytes not found`. `do/tune` enforces parquet for these
  techniques in preflight and skips the JSONL line-check.
- **MTRL** — a plain `prompt` column (parquet/jsonl) passed through to your agent
  unparsed. MTRL is **not yet runnable** — see [MTRL](#mtrl-multi-turn-rl-deferred).

The expected per-field schema also depends on the model family (some expect a Converse
format); the Supported Model Catalog encodes it, and a validation error shows the
expected schema.

### SFT (Supervised Fine-Tuning)

Each line contains a prompt and the desired completion:

```jsonl
{"prompt": "What is the capital of France?", "completion": "The capital of France is Paris."}
{"prompt": "Summarize photosynthesis in one sentence.", "completion": "Photosynthesis converts sunlight, water, and CO2 into glucose and oxygen."}
{"prompt": "Write a haiku about coding.", "completion": "Bugs in the midnight\nStack traces illuminate\nCoffee grows colder"}
```

**Required keys**: `prompt` (string), `completion` (string)

### DPO (Direct Preference Optimization)

Each line contains a prompt with a preferred ("chosen") and dispreferred ("rejected") response:

```jsonl
{"prompt": "Explain quantum computing", "chosen": "Quantum computing leverages quantum mechanical phenomena like superposition and entanglement to process information. Unlike classical bits that are 0 or 1, quantum bits (qubits) can exist in multiple states simultaneously.", "rejected": "Computers are really fast these days."}
{"prompt": "What causes rain?", "chosen": "Rain forms when water vapor in the atmosphere condenses into droplets heavy enough to fall due to gravity.", "rejected": "The sky cries sometimes."}
```

**Required keys**: `prompt` (string), `chosen` (string), `rejected` (string)

### Managed RL dataset format (RLVR / RLAIF)

!!! important "RLVR/RLAIF datasets are parquet, and do NOT carry the reward"
    Unlike SFT/DPO, the managed RL techniques use **Parquet** (not JSONL) and the
    **reward is a separate registered evaluator** (an ARN), not a field in the dataset.
    The dataset is a prompt corpus; the reward is wired via `--evaluator-name` /
    `--reward-function` / `--reward-prompt`.

The managed RL trainer (verl's `RLHFDataset`) requires parquet with **five fields per
row** (verl's documented GSM8K prep format):

| Field | Type | Notes |
|---|---|---|
| `data_source` | string | Dataset origin id (indexes the reward function) |
| `prompt` | **list of chat messages** `[{"role","content"}]` | NOT a flattened string |
| `ability` | string | Task category (e.g. `"math"`) |
| `reward_model` | **struct** `{"style": "rule", "ground_truth": "<str>"}` | NOT a flat string. A missing `reward_model` fails with "Missing required field: 'reward_model'" |
| `extra_info` | struct | e.g. `{"split","index"}` — recorded, not used by training |

RLVR and RLAIF use the **same** dataset schema — they differ only in the reward asset
and in `reward_model.style` (RLVR = `rule`, RLAIF = `model`, set automatically from the
technique).

**You usually don't hand-build this.** `do/register dataset --technique rlvr|rlaif`
runs a Producer that transforms a source dataset into the verl 5-field parquet for you:
it keeps `prompt` as a chat message list, and **lifts a flat top-level ground-truth
column** (`ground_truth` / `answer` / `solution` / …) into the nested `reward_model`
struct with the right `style`. The produced parquet is validated at registration time,
so a shape error fails there — not deep in a GPU job.

```bash
# Produce verl 5-field parquet from a HuggingFace dataset (prompt + a ground-truth column)
./do/register dataset gsm8k-rlvr --hf-id openai/gsm8k --technique rlvr
```

If you prefer to build it yourself with pyarrow, the row shape is:

```python
import pyarrow as pa, pyarrow.parquet as pq
rows = {
    "data_source": ["gsm8k"],
    "prompt": [[{"role": "user", "content": "Question: ... Answer:"}]],
    "ability": ["math"],
    "reward_model": [{"style": "rule", "ground_truth": "42"}],
    "extra_info": [{"split": "train", "index": 0}],
}
pq.write_table(pa.table(rows), "train-00000-of-00001.parquet")
```

!!! warning "The channel prefix must contain ONLY parquet"
    SageMaker mounts the whole dataset S3 prefix as the training channel. Any
    non-parquet file in it — notably the registry's `_dataset.json` sidecar — is read
    as parquet and fails the job. Stage RL datasets so the prefix holds only the
    parquet data file(s). The Producer stages RL parquet under a channel-pure
    `datasets/<name>/data/` subprefix (the `_dataset.json` sidecar sits one level up,
    outside the channel). `do/tune` enforces this in preflight: it fails loud if the
    dataset is not parquet AND — the field-schema check — if the parquet is missing a
    required verl field (e.g. `reward_model`), naming the field, all before provisioning
    GPUs.

Run RLVR / RLAIF by resolving a registered evaluator (see
[Managed RL evaluators](#managed-rl-evaluators-rlvr-rlaif-mtrl)):

```bash
# RLVR — verifiable reward (a Lambda)
./do/tune --technique rlvr --dataset <parquet-prefix-or-name> --evaluator-name math-reward

# RLAIF — LLM-as-judge (a reward prompt)
./do/tune --technique rlaif --dataset <parquet-prefix-or-name> --evaluator-name clarity-judge
```

`do/tune` resolves the evaluator name to its **hub-content evaluator ARN** and passes
that to the trainer. You can bypass the registry with `--reward-function <arn>` (RLVR)
or `--reward-prompt <arn>` (RLAIF), but pass the **hub-content evaluator ARN**, not a
bare Lambda ARN or a name — the SDK requires that form.

### MTRL (multi-turn RL) — deferred

MTRL trains an agent across multiple turns. Its reward lives **inside a
`CustomAgentLambda` you author** (not a reward function/prompt), and its dataset is a
plain `prompt` column passed through unparsed. `do/tune` wires `--agent-env` for it,
but MTRL is **not yet runnable**: no model in the Supported Model Catalog advertises
MTRL recipes, and the agent-authoring path isn't shipped. Use RLVR or RLAIF for managed
RL today.

## Managed RL evaluators (RLVR, RLAIF, MTRL)

The RFT techniques score each generated response with an **evaluator** — a native
SageMaker AI Registry asset. There are two evaluator types, registered with two
verbs, and each technique uses one:

| Technique | Reward mechanism | Register with | Source |
|---|---|---|---|
| RLVR | reward **function** (code) | `do/register evaluator` | a Lambda (ARN) |
| RLAIF | reward **prompt** (LLM-as-judge) | `do/register prompt` | an S3 prompt file |
| MTRL _(deferred)_ | an **agent** (not an evaluator) | author a `CustomAgentLambda`, pass `--agent-env` | your agent Lambda |

Together with the dataset verb, that is the **three register verbs** of the RL
workflow: `do/register dataset` (the prompt corpus), `do/register evaluator` (a
code reward function), and `do/register prompt` (a reward prompt). Datasets and
evaluators are separate assets in separate registries; `do/tune` resolves both.

List what you have registered with `--list` on either evaluator verb:

```bash
./do/register evaluator --list   # registered reward functions (RLVR)
./do/register prompt --list      # registered reward prompts (RLAIF)
```

### Register a reward function (RLVR / MTRL)

The lead path is **bring-your-own-Lambda** — reference an existing reward Lambda
by ARN. SageMaker stores a reference; it provisions nothing and needs no extra
role:

```bash
# Register an existing Lambda as a reward-function evaluator
./do/register evaluator math-reward --arn arn:aws:lambda:us-west-2:123456789012:function:math-reward --technique rlvr

# Then tune, resolving the evaluator by name (RLVR needs BOTH a dataset and this)
./do/tune --technique rlvr --dataset math-prompts --evaluator-name math-reward
```

Don't have a Lambda yet? Start from an editable sample, then register the edited
file:

```bash
./do/register evaluator math-reward --from-sample          # writes do/evaluators/math-reward.py — edit it
./do/register evaluator math-reward --from-sample --finalize   # register the edited reward function
```

**ARN vs `--from-sample` tradeoff:** the ARN path provisions no Lambda and needs
no extra role — prefer it. `--from-sample --finalize` makes SageMaker create and
own a managed Lambda, which requires a **dual-trust reward-Lambda role** (trusted
by both `sagemaker.amazonaws.com` and `lambda.amazonaws.com`, plus `iam:PassRole`)
— NOT the plain training role. Set `MLCC_REWARD_LAMBDA_ROLE_ARN` to that role
before `--finalize`, or the create fails with a Lambda trust error.

#### Reward-function contract

The managed container invokes the Lambda **per batch**: the `event` is a **list of
sample records**, and the Lambda must return a **list of score objects**, one per
record, each with `aggregate_reward_score` (float) and the record's `id`:

```python
def handler(event, context=None):
    # event is a LIST of records (one batch). Each record carries the prompt,
    # the model's output, and the ground truth (field names vary — normalize them).
    scores = []
    for idx, rec in enumerate(event):
        rid = rec.get("id", idx)
        reward = 1.0  # ← your real scoring here (0.0–1.0 conventional)
        scores.append({"aggregate_reward_score": reward, "id": rid})
    return scores
```

!!! warning "Return a LIST, not a single dict"
    A single `{"reward": 1.0}` dict is **rejected** by the managed RLVR container
    (*"Lambda response must be a list of score objects ... like
    [{\"aggregate_reward_score\": 0.5, \"id\": 0}]"*). The shipped
    `register_evaluator_sample.py` sample currently uses the old single-dict shape —
    update it to the per-batch list contract above.

A reward function must never raise — a crash fails the whole RL step, so catch
errors and floor that record to `0.0`.

!!! note "Reward Lambda IAM"
    The execution role needs `lambda:InvokeFunction` on the reward Lambda. The shipped
    policy scopes to `function:mlcc-*`, so a bring-your-own reward Lambda with a
    different name needs an explicit grant for its ARN. (RLAIF additionally needs
    `bedrock:InvokeModel` for the judge model — provisioned in the core bootstrap.)

!!! info "Two different 'reward functions' in v1.9"
    This BL117 reward function is a **registered Lambda evaluator asset** consumed
    by managed RFT on `do/tune`. It is NOT the same as the GRPO reward in
    [Custom Training](custom-training.md#grpo-group-relative-policy-optimization),
    which is an **in-process Python callable** in your `do/train` recipe. Same
    term, different mechanism — this page describes the managed Lambda-evaluator
    kind.

### Register a reward prompt (RLAIF)

A reward prompt is an LLM-as-judge template registered as a native
`REWARD_PROMPT` evaluator (no Lambda, no dual-trust role):

```bash
# Easiest: pass a LOCAL file — it is auto-uploaded to the canonical core-bucket
# location (s3://<CORE_BUCKET>/reward-prompts/<name>.<ext>) and then registered.
./do/register prompt clarity-judge --prompt-file ./clarity-judge.txt

# Or register an already-staged S3 file directly:
./do/register prompt clarity-judge --prompt s3://my-bucket/reward-prompts/clarity-judge.txt

# Then tune (RLAIF needs BOTH a dataset and this reward prompt)
./do/tune --technique rlaif --dataset clarity-prompts --evaluator-name clarity-judge
```

`--prompt-file` and `--prompt` are mutually exclusive; `--prompt-file` needs a
provisioned mlcc-core bucket (`ml-container-creator bootstrap`) to upload into.

#### Reward-prompt contract

The prompt file is a text/Jinja template scored by an LLM judge. It references the
ground truth and the model's output with placeholders, e.g.:

```
Score 0.0–1.0 how well the response answers the question.

### Context
{{ ground_truth }}

### Model Response
{{ model_output }}
```

### Model-specific formats

Some model families may expect a different format (e.g., Converse format). The Supported Model Catalog encodes the expected schema per model family and technique. If your model requires a non-default format, the validation error message will show the expected schema.

### Dataset sources

Datasets can be provided from two sources:

```bash
# From S3
./do/tune --technique sft --dataset s3://my-bucket/path/to/train.jsonl

# By registered name (stage + register once via do/register dataset)
./do/tune --technique sft --dataset my-dataset
```

!!! warning "`do/tune --dataset hf://...` is no longer supported"
    HuggingFace staging has moved to `do/register dataset` (BL092). `do/tune`
    with an `hf://` reference hard-errors with migration guidance. Stage and
    register the dataset once, then tune by name:

    ```bash
    # 1. Stage + register the HuggingFace dataset (once)
    ./do/register dataset my-dataset --hf-id my-org/my-dataset --technique sft

    # 2. Tune by name
    ./do/tune --technique sft --dataset my-dataset
    ```

    Column-map, `?file=` selection, `--take`, and split resolution are all
    supported by `do/register dataset` (the QoL helpers are shared). If the
    dataset requires authentication, set `HF_TOKEN` or configure it via
    `do/secrets`.

### Dataset registry

MCC indexes datasets with an **S3 sidecar** for reproducible tuning workflows.

#### Architecture

| Tier | Location | Purpose |
|------|----------|---------|
| **S3 sidecar** (source of truth) | `s3://<CORE_BUCKET>/datasets/<name>/_dataset.json` | Version tracking, content hashes, custom metadata, name resolution |
| **Native AI Registry** (discoverability) | SageMaker's own AI Registry hub, tagged with your Studio domain | Studio Assets visibility, native semver, ML Lineage edges |

The sidecar is populated automatically by `do/register dataset` and is the
source of truth for versioning and `@v<N>` pinning. It sits beside the dataset
bytes (which land at `s3://<CORE_BUCKET>/datasets/<name>/`), so the registry is
durable and shared across machines. It is written **first** and never depends on
anything else succeeding.

After the sidecar is written, `do/register dataset` **additively** registers the
same dataset in SageMaker's native AI Registry so it shows up in **Studio
Assets** — pointing at the same S3 URI (no copy). This step is best-effort: if it
is skipped or fails (see below), the sidecar still stands and the dataset is
fully usable; it just won't appear in Studio until the native registration
succeeds.

##### Studio discoverability (the domain tag)

Native assets become visible in Studio Assets only when they are tagged with a
Studio **domain id**. MLCC passes that tag automatically when the
`sagemaker-domain` bootstrap module is provisioned (its `DomainId` is captured
into your active profile at bootstrap time). Without a provisioned domain the
dataset is still registered natively, but it is not tagged into Studio Assets —
`do/register dataset` prints a note telling you to provision the
`sagemaker-domain` module to enable Studio visibility.

##### Native versioning vs the sidecar `@vN`

The two version schemes do not conflict and you never reconcile them by hand:

- The **sidecar `@vN`** (ordinal + semver) is MLCC's canonical, pin-able display
  version — it is what `do/tune --dataset name@v2` resolves against.
- The **native AI Registry semver** auto-increments internally each time you
  re-register the same name. It is a registry-internal detail; you don't pin
  against it.

##### Technique labels and native members

`--technique` accepts `sft`, `dpo`, `rlvr`, `rlaif`, `mtrl`, and `benchmark`.
Each dataset-driven label maps to a native `CustomizationTechnique` member:
`sft`→SFT, `dpo`→DPO, and `rlvr`/`rlaif`/`mtrl` all land on the **RLVR** member
(their training input is a prompt corpus of the same shape; the intended
technique is recorded in the sidecar so `do/tune` resolves it correctly).
`benchmark` is **sidecar-only** — it is an AIPerf BYOD benchmark corpus, not a
customization input, so it is not registered natively. Reward prompts and reward
functions are **evaluators, not datasets**: `do/register dataset` rejects them
and points you at `do/register prompt` / `do/register evaluator`.

##### Region and SDK requirements

Native registration and ML Lineage are region-gated to `us-east-1`,
`us-west-2`, `ap-northeast-1`, and `eu-west-1`, and need a recent `sagemaker`
SDK. Outside a supported region, or on an SDK that doesn't expose
`sagemaker.ai_registry`, the native step is skipped with a clear message (an
upgrade hint for the SDK case) — the sidecar and the MLflow→Model-Registry path
are unaffected.

##### Lineage: how datasets, models, and derivatives connect

MLCC turns the metadata it already records into native **ML Lineage** edges, so
Studio's lineage graph connects your assets without you ever calling
`AddAssociation` yourself. Two edges are drawn, both best-effort and idempotent:

- **dataset → model**: the training dataset is logged as an input on the MLflow
  run that produced the model, so Studio links the dataset to the model it
  trained. This is driven only by the dataset S3 URI, so it covers both the
  `do/tune` adapter path and the `do/train` GRPO path.
- **base → derivative**: when you register an adapter or draft with
  `do/register`, MLCC adds a `DerivedFrom` edge from the base model to the new
  derivative, driven by the `mlcc.family` linkage it already resolves.

SageMaker creates the underlying lineage artifacts asynchronously, so an edge
may be skipped on the first call if the artifact isn't materialized yet; the
family linkage is still recorded in the model metadata, and a later re-register
draws the edge. Live Studio/lineage rendering is validated against a real
account.

!!! note "Console Import Not Supported"
    The SageMaker Studio console's dataset import UI has a known schema validation
    bug (injects internal session properties). Always register datasets via
    `do/register dataset` or the SDK — not the console. `do/register dataset`
    lands the dataset in the native AI Registry for you, so you get Studio
    discoverability without touching the console import UI.

#### Using registered datasets

```bash
# List all registered datasets
./do/register dataset --list

# Use a registered dataset by name
./do/tune --technique sft --dataset alpaca-sft

# Pin a specific version for reproducibility
./do/tune --technique sft --dataset alpaca-sft@v1
```

The `--list` flag shows a table of available datasets:

```
📦 Registered datasets:

  NAME                     TECHNIQUE  LATEST     ROWS     S3 URI
  ----                     ---------  ------     ----     ------
  alpaca-sft               sft        1.0.0      1000     s3://mlcc-core-.../datasets/alpaca-sft/
  orca-dpo-pairs           dpo        1.1.0 (2v) 2500     s3://mlcc-core-.../datasets/orca-dpo-pairs/
```

#### Registration workflow

Register datasets explicitly with `do/register dataset`:

```bash
# From an existing S3 dataset — copied to s3://<CORE_BUCKET>/datasets/my-custom-data/
./do/register dataset my-custom-data \
  --s3-uri s3://my-bucket/datasets/custom.jsonl \
  --technique sft \
  --row-count 5000

# From HuggingFace — staged to s3://<CORE_BUCKET>/datasets/guanaco/ then registered
./do/register dataset guanaco \
  --hf-id timdettmers/openassistant-guanaco \
  --technique sft
```

You can also register the dataset used in the most recent tune job:

```bash
./do/register dataset --from-tune sft
```

The `--from-tune` flag auto-derives the dataset name (salted slug), S3 URI,
technique, and row count from the most recent tune job.

##### Custom metadata

Attach attribution, lineage, origination, and application metadata; these are
recorded under `customMetadata` in the S3 sidecar (unset fields are omitted). Use
`--description` for a human-readable summary that is also shown on the native
asset in Studio Assets (the asset's title is the dataset name — there is no
separate title field):

```bash
./do/register dataset my-dataset \
  --s3-uri s3://my-bucket/data.jsonl --technique sft \
  --description "Open-Orca throughput calibration set" \
  --attribution "Acme Research" \
  --lineage "derived from open-orca v2, filtered" \
  --origination "hf://Open-Orca/OpenOrca@main" \
  --application "throughput-calibration"
```

!!! note "Canonical datasets location"
    `do/register dataset` moves the dataset into the canonical MLCC location on
    the `mlcc-core` bucket (`s3://<CORE_BUCKET>/datasets/<name>/`) before
    registering it — `--s3-uri` datasets are copied there, and `--hf-id`
    datasets are staged there. See
    [Deployment Registry](deployment-registry.md#dataset-registration) for the
    full flag reference.

#### Versioning

Datasets are versioned automatically using content hashes (S3 ETags):

| Action | Result |
|--------|--------|
| First `do/register dataset X --s3-uri ...` | Creates v1.0.0 with content hash |
| Same S3 content, same name | Skipped — "Dataset unchanged (v1)" |
| Different S3 content, same name | Creates v1.1.0 (content hash differs) |
| `--force` flag | Always creates new version regardless of hash |

Pin a specific version to ensure reproducibility across tune runs:

```bash
# Always use the original 1000-row version, even if a newer version exists
./do/tune --technique sft --dataset alpaca-sft@v1

# List all versions of a dataset
python3 do/.register_helper.py list-dataset-versions --name alpaca-sft --core-bucket <CORE_BUCKET>
```

!!! note "Versions live in the sidecar"
    Each registration appends a version entry to the dataset's S3 sidecar
    (`datasets/<name>/_dataset.json`). Registering unchanged content (same
    content hash) without `--force` is idempotent — no new version is created.

See [Deployment Registry](deployment-registry.md) for full `do/register dataset` documentation.

### File selection for multi-file datasets

!!! note "These HuggingFace conveniences now run under `do/register dataset`"
    File selection (`?file=`), column-map, `--take`, split resolution, and
    schema-divergence detection moved from `do/tune` to `do/register dataset`
    (BL092). The syntax below is identical — apply it when staging a HuggingFace
    dataset with `do/register dataset <name> --hf-id <org/name> ...`, then tune
    by the registered name. The examples that show `do/tune --dataset hf://...`
    illustrate the shared syntax; run them via `do/register dataset` instead.

Some HuggingFace datasets contain multiple files under the same split with different schemas. For example, `nvidia/When2Call` has files for tool-calling and general conversation — with different columns in each.

Without a file filter, the pipeline detects this mismatch and fails with a clear error showing each file's columns:

```text
❌ Schema divergence detected across files in nvidia/When2Call.

  📄 call_train_00000.parquet
     Columns: chosen, prompt, rejected
  📄 general_train_00000.parquet
     Columns: completion, prompt

  Files have different column sets. Use ?file=<pattern> to select compatible files:
    ./do/tune --technique dpo --dataset "hf://nvidia/When2Call?file=*call*"
```

Append `?file=<pattern>` to your `hf://` URI to filter:

!!! warning "Always quote URIs containing `?` or `*`"
    Bash interprets `?` as a single-character glob and `*` as a wildcard. Without quotes, your shell may expand these before `do/tune` sees them — causing silent argument corruption or "no matches found" errors.

```bash
# Glob pattern (fnmatch semantics)
./do/tune --technique dpo --dataset "hf://nvidia/When2Call?file=*call*"

# Substring match (no glob metacharacters)
./do/tune --technique sft --dataset "hf://my-org/my-dataset/train?file=sft_data"

# Specific file pattern
./do/tune --technique dpo --dataset "hf://my-org/my-dataset?file=train-0000?-*"
```

**Pattern matching rules:**

- If the pattern contains `*`, `?`, or `[` → glob match (fnmatch) against the full filename
- If the pattern is a plain string → substring match against the file's basename
- If no files match → the error lists all available files to help you choose

When only one file matches (or the dataset has a single file), schema divergence checking is skipped entirely.

### Auto-flatten (chat-format columns)

Many HuggingFace DPO datasets store `chosen`/`rejected` as chat-format message dicts rather than the flat strings SageMaker AI expects:

```json
{"prompt": "Explain AI", "chosen": {"role": "assistant", "content": "AI is..."}, "rejected": {"role": "assistant", "content": "Computers are fast"}}
```

The staging pipeline **automatically detects and flattens** these columns. No manual preprocessing needed:

```bash
# This just works — chat-format columns are flattened automatically
./do/tune --technique dpo --dataset "hf://nvidia/When2Call?file=*call*"
```

**What gets flattened:**

| Input Format | Strategy | Output |
|---|---|---|
| Single dict: `{"role": "assistant", "content": "text"}` | Extract `content` | `"text"` |
| Single-element list: `[{"role": "user", "content": "hi"}]` | Extract content | `"hi"` |
| Multi-message, same role | Concatenate with newlines | `"A\nB"` |
| Multi-message, mixed roles | Role-prefixed pairs | `"user: Q\nassistant: A"` |

**When it triggers:**

- Only on columns whose expected schema type is `"string"` (DPO: `chosen`, `rejected`; SFT: `completion`)
- RLAIF/RLVR `prompt` columns (type `"array"`) are **never** flattened — they legitimately contain message arrays
- Detection uses the first record only; the same strategy is applied uniformly to all records

**User feedback:**

When auto-flatten converts columns, you'll see:

```text
ℹ️  Auto-converted column 'chosen' from chat-format to string
    Format: extracted content field
ℹ️  Auto-converted column 'rejected' from chat-format to string
    Format: extracted content field
```

**Disabling auto-flatten:**

If you need to preserve the original column structure (e.g., for debugging or custom preprocessing):

```bash
./do/tune --technique dpo --dataset hf://my-org/my-dataset --no-transform
```

With `--no-transform` active, the pipeline still detects chat-format columns and logs what it found, but halts with an actionable error instead of converting:

```text
❌ Column 'chosen' contains chat-format data (detected: single_dict) but --no-transform is active.

   Remove --no-transform to enable automatic conversion:
   ./do/tune --technique dpo --dataset hf://my-org/my-dataset
```

!!! note "Pipeline ordering"
    The full staging pipeline runs in this order: **download** → **column rename** (`--column-map`) → **detect chat-format** → **flatten** → **type validation** → **write JSONL** → **upload to S3**. Column rename always happens before flatten, so `--column-map` and auto-flatten compose correctly.

## Running on HyperPod EKS (`--backend hp-eks`)

On a `hyperpod-eks` project, `do/tune --backend hp-eks` runs AWS's own HyperPod EKS recipe for
the model (the Hub `HpEksPayloadTemplateS3Uri`, recorded in the tune catalog) as a single-node
HyperPodPyTorchJob on your cluster. SageMaker training jobs stay the default.

- **Techniques.** SFT and DPO only (their recipes are HyperPodPyTorchJobs). RLVR and RLAIF recipes
  are RayJobs: they need KubeRay installed by the cluster owner and are post-2.0, so they're
  refused with that reason. MTRL has no HP-EKS recipe at all.
- **Prerequisites.** The same cluster contract and training identity as
  [`do/train --backend hp-eks`](custom-training.md#hyperpod-eks-backend-backend-hp-eks), plus a
  Bound `fsx-claim` PVC (the AWS recipes require it) and the base model staged to S3
  (`./do/stage`).
- **Always-on fixes.** MLCC renders the template itself (an unfilled placeholder is fatal) and
  fixes what doesn't run as published on the current operator and image: the reserved
  `JOB_NAME` env, a `SCRIPT_PATH` missing from the image, the config `.yaml` suffix, the per-job
  log path, the instance-group `nodeSelector`, the ServiceAccount, `runPolicy`, scratch and the
  S3 hand-off. Every patched site asserts its original value first; a moved site stops the run
  with `template drift at <site>`.
- **Data.** SFT `prompt`/`completion` rows are converted to the recipe's `messages` column; DPO
  keeps `prompt`/`chosen`/`rejected`. Other formats are refused, never guessed.

!!! warning "`--adapt-shape` is EXPERIMENTAL"
    Every AWS HP-EKS recipe is written for 8 GPUs and 32 EFA interfaces (p4d / p5). On a smaller
    instance group the run stops (exit 4) unless you pass `--adapt-shape`, which rewrites the
    recipe's GPU and EFA counts to the group's allocatable, sets the per-GPU token budget to
    `dataset_max_len` (override with `--set max_token_len_per_gpu=N`) and
    `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`. AWS does not support this shape; memory
    headroom on 24 GB GPUs is about 1 GB for 8B-class models, and MLCC refuses when the bf16
    weights exceed 90% of per-GPU memory.

```bash
./do/tune --technique sft --dataset <name> --backend hp-eks --adapt-shape
./do/tune --technique sft --dataset <name> --backend hp-eks --adapt-shape --dry-run      # print only
./do/tune --technique sft --dataset <name> --backend hp-eks --adapt-shape --render-only  # stage data + write the manifest
./do/tune --technique sft --status
```

On success the adapter (or full model) found under `s3://<artifacts>/<project>/tune/<job>/output/`
is promoted and the `TUNE_*` variables are written exactly as for a SageMaker training job.

## `do/tune` vs `do/train`

ML Container Creator offers two paths for model customization:

| | `do/tune` (Managed Serverless) | `do/train` (Bespoke Training) |
|---|---|---|
| **Status** | Available now | Available now |
| **Infrastructure** | Fully managed by SageMaker AI | You choose instance types and containers |
| **Supported models** | Models in the Supported Model Catalog | Any model |
| **Techniques** | SFT, DPO, RLAIF, RLVR | Any training script |
| **Configuration** | Minimal — dataset + technique | Full control over training code |
| **When to use** | Your model is supported and you want the fastest path | You need custom training logic or an unsupported model |

**Recommendation**: Start with `do/tune` if your model is in the Supported Model Catalog. It's the fastest path from dataset to deployed adapter with zero infrastructure management. Use `do/train` when you need custom training logic or your model isn't supported — see [Custom Training](custom-training.md).

## CLI Reference

### Synopsis

```bash
./do/tune --technique <technique> --dataset <source> [options]
./do/tune --status
./do/tune --list-models
./do/tune --help
```

### Required flags

| Flag | Values | Description |
|---|---|---|
| `--technique` | `sft`, `dpo`, `rlaif`, `rlvr` | Customization technique to apply |
| `--dataset` | S3 URI (`s3://bucket/path.jsonl`) or a registered dataset name (optionally `@v<N>`-pinned) | Training dataset location. `hf://` references are not accepted here — stage them with `do/register dataset --hf-id` first. |

### Training type

| Flag | Values | Default | Description |
|---|---|---|---|
| `--training-type` | `lora`, `full-rank` | `lora` | Whether to produce LoRA adapter weights or a full merged model |

### Hyperparameters — technique-aware

`do/tune`'s hyperparameters are **technique-aware**: the knobs you can set, their defaults,
ranges, and choice-lists come from the selected technique's tune descriptor
(`templates/code/tune.d/<technique>/manifest.json`, synced from SageMaker's recipe
override-params — see [Per-technique tune descriptor](architecture/tune-descriptor.md)).
Run `do/tune` interactively and it prompts for the technique's `primary` knobs (pre-filled
with their defaults, dropdowns for enum knobs); pass `--advanced` to also be prompted for the
`advanced` knobs.

| Flag | Type | Description |
|---|---|---|
| `--set KNOB=VALUE` | repeatable | Set any knob the selected technique's descriptor declares, keyed by its canonical name (e.g. `--set learning_rate=1e-5 --set global_batch_size=256`). A knob the technique does not declare is rejected, naming the valid set. Values are validated against the descriptor (range / enum / type) in sub-second preflight — before the job is submitted. |
| `--advanced` | flag | Also prompt for `advanced`-tier knobs interactively (otherwise they take their descriptor default). |
| `--non-interactive` | flag | Apply descriptor defaults without prompting (same validation). Also the automatic behavior when there is no TTY. |

**Legacy flags (kept as aliases):** the previous fixed flags still work and map onto the same
descriptor knobs, so existing scripts keep running:

| Legacy flag | Equivalent `--set` | 
|---|---|
| `--epochs <n>` | `--set max_epochs=<n>` |
| `--learning-rate <f>` | `--set learning_rate=<f>` |
| `--max-seq-length <n>` | `--set dataset_max_len=<n>` |
| `--lora-rank <n>` | `--set lora_rank=<n>` |
| `--batch-size <n>` | `--set global_batch_size=<n>` |

Each alias is validated against the selected technique's descriptor exactly like a `--set`.

### Dataset options

| Flag | Type | Description |
|---|---|---|
| `--column-map` | string | Rename source columns to target columns (e.g., `"input:prompt,output:completion"`) |
| `--no-transform` | flag | Disable auto-flatten — halt with error if chat-format data is detected |

### Evaluator flags (RLVR/RLAIF only)

| Flag | Type | Description |
|---|---|---|
| `--reward-function` | Lambda ARN | ARN of the reward function Lambda (RLVR) |
| `--reward-prompt` | S3 URI | S3 path to reward prompt file (RLAIF) |

### Model and infrastructure overrides

| Flag | Type | Description |
|---|---|---|
| `--model` | HuggingFace model ID | Override the model to customize (defaults to `MODEL_ID` from `do/config`) |
| `--output-bucket` | S3 bucket name | Override the output bucket (defaults to the profile's artifacts bucket, `ARTIFACTS_S3_BUCKET`) |
| `--role` | IAM role ARN | Override the execution role |

### Job control

| Flag | Description |
|---|---|
| `--force` | Force a new job even if a previous job exists for this technique |
| `--no-wait` | Submit the job and exit immediately without polling |
| `--status` | Show status of all tracked tune jobs |
| `--dry-run` | Validate inputs and show what would be submitted without creating a job |
| `--list-models` | Print the Supported Model Catalog and exit |
| `--help` | Show usage information |

## Examples

### Basic SFT with S3 dataset

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl
```

### DPO with Hugging Face dataset and custom learning rate

```bash
./do/tune --technique dpo --dataset hf://my-org/preference-data --learning-rate 1e-5
```

### DPO with multi-file dataset (file selection + auto-flatten)

```bash
./do/tune --technique dpo --dataset "hf://nvidia/When2Call?file=*call*"
```

### Full-rank fine-tuning

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl --training-type full-rank
```

### Override model (tune a different model than what's deployed)

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl \
  --model meta-llama/Llama-3.3-70B-Instruct
```

### RLVR with reward function

```bash
./do/tune --technique rlvr \
  --dataset s3://my-bucket/prompts.jsonl \
  --reward-function arn:aws:lambda:us-east-1:123456789012:function:my-reward
```

### Dry run (validate without submitting)

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl --dry-run
```

### Force re-run after a failed job

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl --force
```

## Idempotency

Re-running `do/tune` with the same technique resumes or reports on the existing job rather than creating a duplicate:

- **Job in progress** — Polls and displays progress until completion
- **Job completed** — Displays results and next-step commands
- **Job failed** — Displays the failure reason and suggests `--force` to retry

Use `--force` to explicitly start a new job, overriding the previous one for that technique.

## MLflow Integration

When an MLflow tracking server is configured in your SageMaker AI domain, customization jobs automatically log training metrics, hyperparameters, and model artifacts to MLflow. The script displays the MLflow experiment URL after job submission.

If no MLflow server is configured, the script proceeds without tracking and prints a note suggesting MLflow setup for experiment comparison.

## Future: Bedrock Custom Model Import

The output artifacts from managed customization are compatible with [Amazon Bedrock Custom Model Import](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html). This deployment path — importing your fine-tuned model into Bedrock for serverless inference — is planned for a future release. The current workflow deploys via SageMaker AI endpoints using `do/adapter add` or `do/add-ic`.

## Troubleshooting

### "Model not yet supported"

Your configured model isn't in the Supported Model Catalog. Run `./do/tune --list-models` to see available models, or use `--model` to override with a supported model ID.

### Dataset validation fails

For **SFT/DPO**, `do/tune` validates the first 10 JSONL lines. Check that:

- The file is valid JSONL (one JSON object per line)
- Each line contains the required keys for your technique (SFT: `prompt`/`completion`;
  DPO: `prompt`/`chosen`/`rejected`)

The error message shows the first malformed line and the expected format.

For **RLVR/RLAIF**, the dataset must be **parquet** in the verl 5-field schema (see
[Managed RL dataset format](#managed-rl-dataset-format-rlvr--rlaif)). Common failures,
all caught in preflight or early in the job:

- `do/tune` refuses a non-parquet RL dataset before submitting (fail-loud guard).
- In-container `ArrowInvalid: Parquet magic bytes not found` → the channel prefix
  contains a non-parquet file (often the `_dataset.json` sidecar). Keep the prefix
  parquet-only.
- `Missing required field: 'reward_model'` → the row is missing the `reward_model`
  struct (a flat `ground_truth` column is not accepted — it must be nested under
  `reward_model`).

### "Schema divergence detected across files"

Your HuggingFace dataset has files with different column sets. Use `?file=<pattern>` to select only the files matching your technique's schema. The error message shows each file's columns and suggests a pattern.

### "Column contains chat-format data but --no-transform is active"

You passed `--no-transform` but the dataset has chat-format columns that need flattening. Remove `--no-transform` to enable automatic conversion, or preprocess the data manually.

### "Technique not supported for this model"

Not all models support all techniques. Run `./do/tune --list-models` to see which techniques are available for your model.

### Job fails with AccessDenied

Run `ml-container-creator bootstrap` to provision the required IAM permissions. The bootstrap stack adds SageMaker AI training, model package, and MLflow permissions.

### Python SDK not installed

The `do/tune` script requires `sagemaker>=3.0.0` and several other Python packages. These are installed automatically when you run `npm install`. If you manage Python environments manually:

```bash
pip install -r requirements.txt
```

See [`requirements.txt`](https://github.com/awslabs/ml-container-creator/blob/main/requirements.txt) for the full list.
### Job failed — how to retry

When a job fails, the script displays the failure reason. Fix the underlying issue and re-run with `--force`:

```bash
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl --force
```
