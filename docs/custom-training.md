# Custom Training (`do/train`)

ML Container Creator includes a `do/train` command for **unmanaged, user-customized training** — the counterpart to `do/tune`. While `do/tune` uses SageMaker Managed Model Customization (hands-off, serverless), `do/train` gives you full control over the training logic while maintaining the same lifecycle integration with adapters, benchmarks, and the model registry.

!!! tip "When to use `do/train` vs `do/tune`"
    | | `do/tune` | `do/train` |
    |---|---|---|
    | **Infrastructure** | Managed (serverless) | You choose instance type |
    | **Training code** | SageMaker's built-in trainers | Your code (with boilerplate templates) |
    | **Customization** | Hyperparameters only | Full training loop control |
    | **Techniques** | SFT, DPO, RLAIF, RLVR | SFT, DPO, GRPO + any custom technique |
    | **Reinforcement learning** | Managed (RLAIF/RLVR) — reward is a registered evaluator asset (ARN) | Self-managed (GRPO) — reward is an in-process Python callable you write |
    | **Lifecycle** | Full (adapter → benchmark → register) | Full (same hooks, `TRAIN_*` namespace) |
    | **Comparison** | Can compare results side-by-side via `do/benchmark` | Same |

---

## Prerequisites

| Requirement | Details |
|---|---|
| Bootstrapped account | `ml-container-creator bootstrap` for IAM role + S3 buckets |
| AWS credentials | Configured via `aws configure` or environment variables |
| Python 3.10+ | With `sagemaker>=3.0.0`, `trl`, `peft`, `accelerate` (auto-installed via `requirements.txt`) |
| Built + pushed image | `./do/build && ./do/push` (your training container) |

---

## Quick Start

```bash
# SFT training with a HuggingFace dataset
./do/train --technique sft --dataset "hf://tatsu-lab/alpaca --take 500"

# DPO training with a registered dataset
./do/train --technique dpo --dataset "orca-dpo-pairs"

# Interactive mode — guided config generation
./do/train --interactive

# Check status of a running job
./do/train --status

# Resume after Ctrl+C
./do/train
```

---

## Technique Templates

`do/train` ships with boilerplate training scripts for common techniques. Each technique lives in `training/<technique>/` and can be customized freely:

```
training/
├── config.yaml              ← shared config (technique, model, dataset, hyperparams)
├── sft/
│   ├── train.py             ← TRL SFTTrainer + PEFT LoRA
│   ├── accelerate_config.yaml
│   └── defaults.yaml
├── dpo/
│   ├── train.py             ← TRL DPOTrainer + PEFT LoRA
│   ├── accelerate_config.yaml
│   └── defaults.yaml
├── grpo/
│   ├── train.py             ← TRL GRPOTrainer + PEFT LoRA
│   ├── reward_example.py    ← in-process reward functions (edit this)
│   ├── accelerate_config.yaml
│   ├── defaults.yaml
│   └── README.md
└── custom/
    └── train.py             ← Your own training logic (skeleton)
```

### SFT (Supervised Fine-Tuning)

```bash
./do/train --technique sft --dataset "hf://tatsu-lab/alpaca"
```

Default hyperparameters (from `training/sft/defaults.yaml`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `lora_r` | 16 | LoRA rank |
| `lora_alpha` | 32 | LoRA alpha scaling |
| `learning_rate` | 2e-4 | Learning rate |
| `epochs` | 3 | Training epochs |
| `batch_size` | 4 | Per-device batch size |
| `max_seq_length` | 2048 | Max sequence length |
| `gradient_accumulation_steps` | 4 | Gradient accumulation |

### DPO (Direct Preference Optimization)

```bash
./do/train --technique dpo --dataset "s3://my-bucket/preferences.jsonl"
```

DPO requires a preference dataset with `prompt`, `chosen`, and `rejected` columns.

Default hyperparameters (from `training/dpo/defaults.yaml`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `beta` | 0.1 | KL penalty coefficient |
| `learning_rate` | 5e-7 | Learning rate (lower than SFT) |
| `epochs` | 1 | Training epochs |
| `batch_size` | 2 | Per-device batch size |
| `max_length` | 1024 | Max combined sequence length |
| `chosen_field` | "chosen" | Column name for preferred response |
| `rejected_field` | "rejected" | Column name for dispreferred response |

### GRPO (Group Relative Policy Optimization)

```bash
./do/train --technique grpo --dataset "hf://trl-lib/tldr"
```

GRPO is **self-managed reinforcement learning**: it samples several completions
per prompt, scores each with your **in-process reward function(s)**, and updates
the policy from the group-relative advantage (the sampled group is its own
baseline — no separate value/critic model). It needs a **prompt dataset** (a
`prompt` column of strings; GRPO generates its own completions), not
prompt/completion or chosen/rejected pairs.

!!! warning "Two different things both called a 'reward function'"
    GRPO's reward is an **in-process Python callable** you write in
    `training/grpo/reward_example.py` — it runs inside the training job, with no
    managed service in the loop. This is the opposite of the managed RL path on
    `do/tune` (BL117), whose reward is a **separately-registered SageMaker
    evaluator asset** (a Lambda, referenced by ARN). Same term, different
    mechanism: pick `do/train --technique grpo` when you want to **own and edit
    the reward code**; pick `do/tune` when you want SageMaker to run a managed
    RLVR/RLAIF/MTRL customization against a registered evaluator.

**The reward-function contract** (edit `training/grpo/reward_example.py`):

```python
def my_reward(completions, prompts=None, **kwargs) -> list[float]:
    # one float per completion, higher = better; same order as `completions`
    return [score(c) for c in completions]
```

- `completions` — the sampled completions (strings for a plain prompt dataset).
- `prompts` — the prompts they were sampled from (optional).
- `**kwargs` — every other dataset column by name (e.g. a `solution` column →
  `kwargs["solution"]`). **Required** in the signature even if unused.

List your reward callables in `REWARD_FUNCS`; GRPO sums them. The shipped
`length_reward` + `format_reward` are placeholders to show the contract — replace
them. Editing the recipe is the intended super-user workflow, like `custom/`.

Default hyperparameters (from `training/grpo/defaults.yaml`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `num_generations` | 8 | Completions sampled per prompt (the "group"; ≥ 2) |
| `beta` | 0.04 | KL coefficient against the reference policy |
| `max_completion_length` | 256 | Max new tokens per sampled completion |
| `max_prompt_length` | 512 | Prompts longer than this are left-truncated |
| `learning_rate` | 1e-6 | Learning rate |
| `epochs` | 1 | Training epochs |
| `batch_size` | 1 | Per-device prompt batch size |
| `prompt_field` | "prompt" | Dataset column holding the prompt text |

!!! warning "GRPO needs an adequate GPU instance"
    GRPO runs on-policy generation **and** training in the same job and holds a
    reference policy for the KL term — do **not** run it on CPU or an
    under-provisioned instance. A single `ml.g5.xlarge` (1× A10G, 24 GB) is the
    floor for a small (≤ 3B) policy with LoRA and short completions; larger
    policies, longer completions, or a bigger `num_generations` group want a
    multi-GPU instance such as `ml.g5.12xlarge`. Set the instance in
    `training/config.yaml`.

### Custom

```bash
./do/train --technique custom
```

Edit `training/custom/train.py` with your own logic. The skeleton demonstrates the SageMaker training contract (data channels, model output, checkpoints).

---

## Interactive Mode

```bash
./do/train --interactive
```

Guides you through:
1. **Technique selection** — SFT, DPO, or custom
2. **Model ID** — base model for fine-tuning
3. **Dataset** — from registry, HuggingFace, or S3
4. **Instance type** — with optional instance-sizer recommendations
5. **Technique-specific settings** — LoRA rank, beta, column mappings, etc.
6. **Common hyperparameters** — epochs, learning rate, batch size

On completion, writes `training/config.yaml`. Use `--interactive --run` to also submit immediately.

---

## Dataset Resolution

`do/train` supports the same dataset sources as `do/tune`:

| Source | Example | Behavior |
|--------|---------|----------|
| HuggingFace | `hf://tatsu-lab/alpaca` | Staged to S3 via Processing Job |
| S3 | `s3://bucket/data/train.jsonl` | Used directly as training channel |
| Registry name | `alpaca-sft-1k` | Resolved from the dataset registry (S3 sidecar via `do/register dataset`) |
| Version-pinned | `alpaca-sft-1k@v2` | Specific version from registry |

```bash
# List registered datasets
./do/train --list-datasets

# Use a specific version
./do/train --technique sft --dataset "my-dataset@v2"
```

---

## Configuration

### `training/config.yaml`

The primary configuration file for custom training:

```yaml
# Technique selection
technique: sft

# Model (overridden by HF_MODEL_ID from do/config)
model: Qwen/Qwen3-4B

# Instance configuration
instance_type: ml.g5.xlarge
instance_count: 1

# Dataset (can also be set via --dataset flag)
dataset: ""

# Output path (auto-derived from profile if empty)
output_path: ""

# Hyperparameters (merged with technique defaults)
hyperparameters:
  epochs: "3"
  learning_rate: "2e-4"
  lora_r: "16"
```

### Hyperparameter Precedence

```
CLI flags (--learning-rate 1e-5)
    ↓ overrides
training/config.yaml hyperparameters
    ↓ overrides
training/<technique>/defaults.yaml
```

---

## Lifecycle Integration

### Output Variables (`TRAIN_*` namespace)

On completion, `do/train` writes to `do/config`:

| Variable | Example | Purpose |
|----------|---------|---------|
| `TRAIN_OUTPUT_PATH_LATEST` | `s3://bucket/training-output/job-name/` | Latest training artifact path |
| `TRAIN_ADAPTER_PATH_SFT` | `s3://bucket/training-output/job-name/` | Technique-specific adapter path |
| `TRAIN_TECHNIQUE` | `sft` | Technique used |
| `TRAIN_DATASET_S3_URI_SFT` | `s3://bucket/datasets/alpaca/` | Dataset provenance |
| `TRAIN_JOB_NAME` | `project-train-sft-20260629` | SageMaker job name |

!!! info "Separate from `do/tune` output"
    `do/train` uses `TRAIN_*` variables while `do/tune` uses `TUNE_*`. Both can coexist in `do/config`, enabling side-by-side comparison of managed vs unmanaged training on the same model and dataset.

### Adapter Staging

```bash
# Stage adapter from custom training output
./do/adapter --from-train sft

# Stage adapter from managed tuning output (for comparison)
./do/adapter --from-tune sft
```

Adapter confs created by `--from-train` include `ADAPTER_SOURCE="train"` to distinguish from managed adapters.

### Auto-Registration

By default, `do/train` auto-registers the dataset on completion (same as `do/tune`). Use `--no-register` to skip:

```bash
./do/train --technique sft --dataset "hf://tatsu-lab/alpaca" --no-register
```

### Comparison Workflow

```bash
# Managed SFT
./do/tune --technique sft --dataset "hf://tatsu-lab/alpaca --take 500"
./do/adapter --from-tune sft

# Unmanaged SFT (same model, same data, your training code)
./do/train --technique sft --dataset "hf://tatsu-lab/alpaca --take 500"
./do/adapter --from-train sft

# Deploy both
./do/test --adapter tuned-sft        # managed
./do/test --adapter sft-custom       # unmanaged

# Benchmark both → compare in Athena
./do/benchmark --adapter tuned-sft
./do/benchmark --adapter sft-custom
```

---

## Flags Reference

| Flag | Description |
|---|---|
| `--technique <name>` | Training technique: `sft`, `dpo`, `custom` (default: from config.yaml) |
| `--dataset <uri>` | Dataset: `hf://...`, `s3://...`, or registry name |
| `--interactive` / `-i` | Guided config builder |
| `--interactive --run` | Build config and submit immediately |
| `--status` | Check status of tracked training job |
| `--force` | Start a new job even if one is running |
| `--dry-run` | Print job config without submitting |
| `--no-wait` | Submit and exit (don't poll for completion) |
| `--no-register` | Skip auto-registration on completion |
| `--resume [job-name]` | Resume from a previous job's checkpoint |
| `--list-datasets` | Show registered datasets |
| `--learning-rate <val>` | Override learning rate |
| `--epochs <n>` | Override epochs |
| `--batch-size <n>` | Override batch size |
| `--lora-r <n>` | Override LoRA rank |

---

## Adding a Custom Technique

To add your own training technique:

1. Create a directory: `training/my-technique/`
2. Add `train.py` — your training script (see `training/custom/train.py` for the contract)
3. Optionally add:
   - `defaults.yaml` — default hyperparameters
   - `accelerate_config.yaml` — distributed training config
   - `prompts.json` — interactive mode questions
4. Run: `./do/train --technique my-technique`

No changes to `do/train` are needed — it discovers techniques by scanning `training/*/train.py`.

### Training Script Contract

Your `train.py` must:
- Read data from `$DATA_DIR` (or `$SM_CHANNEL_TRAINING` on SageMaker)
- Read hyperparameters from `$SM_HPS` (JSON) or individual `$SM_HP_*` env vars
- Write model artifacts to `$OUTPUT_DIR` (or `$SM_MODEL_DIR`)
- Save checkpoints to `$CHECKPOINT_DIR` (or `$SM_CHECKPOINT_DIR`)
- Exit 0 on success, non-zero on failure

!!! tip "Pod-Ready Design"
    Training scripts use env-var path resolution with no SageMaker-specific imports. They work identically inside a SageMaker Training Job or a HyperPod EKS pod — only the orchestration wrapper differs.

---

## Distributed Training

For multi-GPU training (models >7B), set `instance_type` to a multi-GPU instance and accelerate handles the rest:

```yaml
# training/config.yaml
instance_type: ml.g5.12xlarge   # 4× A10G
instance_count: 1
```

Training scripts use `accelerate launch` as the entry point. The `accelerate_config.yaml` per technique configures FSDP sharding:

```yaml
# training/sft/accelerate_config.yaml
compute_environment: LOCAL_MACHINE
distributed_type: FSDP
fsdp_config:
  fsdp_sharding_strategy: FULL_SHARD
  fsdp_auto_wrap_policy: TRANSFORMER_BASED_WRAP
mixed_precision: bf16
```

SageMaker auto-detects multi-GPU and injects `WORLD_SIZE`, `RANK`, `LOCAL_RANK` — accelerate uses these to configure distributed training without code changes.

### Spot Training

```yaml
# training/config.yaml
spot: true
max_wait_seconds: 86400
checkpoint_s3_uri: s3://my-bucket/checkpoints/
```

Checkpoints are saved periodically and synced to S3. On spot interruption, `--resume` continues from the last checkpoint.

---

## Troubleshooting

### "Training job failed" with no error in logs

Training jobs that OOM during model loading may crash before the Python logger flushes. Check:
1. Instance has enough GPU memory for the model + LoRA + optimizer states
2. For 7B+ models, use ml.g5.12xlarge (4× A10G) with FSDP

### CUDA driver compatibility

If you see `CUDA compat: driver X < Y, adding compat libs` followed by silence, the base image requires a newer driver than the instance provides. Downgrade the base image version — see [CI Integration](ci-integration.md) for the golden path model/image compatibility matrix.

### Hyperparameters passed as strings

SageMaker passes all hyperparameters as strings. Training scripts must cast them:
```python
epochs = int(os.environ.get("SM_HP_EPOCHS", "3"))
learning_rate = float(os.environ.get("SM_HP_LEARNING_RATE", "2e-4"))
```
