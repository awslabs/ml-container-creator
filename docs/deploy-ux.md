# Interactive Deployment UX

Starting with MLCC v1.5, deployment configuration is no longer set at project generation time. Instead, `do/deploy` guides you through a short interactive prompt flow when you deploy for the first time — asking the right questions at the moment you are ready to act, with fresh recommendations from the instance-sizer and cluster-picker MCP servers.

This approach eliminates the friction of making infrastructure decisions before you know your requirements, and makes it trivial to deploy the same project to multiple targets without regenerating.

---

## First deploy: interactive flow

When you run `do/deploy` on a freshly generated project (one whose `do/config` has an empty `DEPLOYMENT_TARGET`), the script launches an interactive prompt sequence:

```
$ ./do/deploy

? Select deployment target:
  ❯ managed-inference  — SageMaker real-time endpoint (IC)
    async-inference    — SageMaker async endpoint (S3 I/O)
    batch-transform    — SageMaker batch transform job
    hyperpod-eks       — HyperPod EKS cluster

? Select instance type: (recommended: ml.g5.4xlarge — 24GB VRAM, fits Llama-3.1-8B)
  ❯ ml.g5.4xlarge  ★ recommended
    ml.g5.12xlarge
    ml.g5.48xlarge
    Enter manually...

? Endpoint strategy:
  ❯ New endpoint
    New endpoint (heterogeneous — multiple instance types with fallback)
    Attach to existing endpoint

Deploying to managed-inference...
✅ Endpoint sharp-gpt-bot-ep: InService
```

Answers are persisted to `do/config` immediately after you confirm, before the deployment starts. This means if the deployment fails halfway through, re-running `do/deploy` reuses your previous answers without re-prompting.

If MCP servers are unreachable (no network, missing credentials), the prompt falls back to manual text input with a warning: `MCP servers unavailable — recommendations disabled.`

---

## Repeat deploy: skip prompts

Once `do/config` has a populated `DEPLOYMENT_TARGET` and the required vars for that target, running `do/deploy` again deploys directly without any prompts:

```bash
./do/deploy           # uses saved DEPLOYMENT_TARGET from do/config
./do/build && ./do/deploy  # rebuild and redeploy
```

---

## Non-interactive (CI/CD): flags

Every interactive prompt has a corresponding CLI flag. If all required flags for a target are provided, the deploy proceeds without any prompts:

```bash
./do/deploy --target managed-inference --instance-type ml.g5.4xlarge
./do/deploy --target hyperpod-eks --instance-type ml.g5.12xlarge
./do/deploy --target batch-transform \
  --instance-type ml.m5.4xlarge \
  --batch-input-path s3://bucket/input/ \
  --batch-output-path s3://bucket/output/
```

Partial flags prompt only for the missing values. For example, `./do/deploy --target async-inference` will still ask for instance type but skip the target selection prompt.

Use `--dry-run` to preview the fully resolved configuration without deploying:

```bash
./do/deploy --target managed-inference --instance-type ml.g5.4xlarge --dry-run
```

---

## Multi-target deployments and focus switching

A single MLCC project can have active deployments on multiple targets simultaneously. `DEPLOYMENT_TARGET` in `do/config` indicates the **active** target — the one that `do/test`, `do/logs`, `do/benchmark`, and other operational scripts route to.

### Deploying to a second target

Simply run `do/deploy --target <new-target>`. If no deployment exists for that target yet, the full prompt flow (or flag flow) runs and creates a new deployment:

```bash
./do/deploy --target hyperpod-eks    # create a HyperPod deployment alongside SMAI
```

### Switching focus between targets

If a deployment already exists for the requested target, `do/deploy --target` switches focus without redeploying:

```bash
./do/deploy --target managed-inference
# Output: ✅ Focused on managed-inference (endpoint: sharp-gpt-bot-ep, InService)
```

All subsequent `do/test`, `do/logs`, and `do/benchmark` calls now route to the managed-inference endpoint. Switch back to HyperPod at any time:

```bash
./do/deploy --target hyperpod-eks
# Output: ✅ Focused on hyperpod-eks (cluster: my-cluster, Running)
```

This makes it easy to benchmark the same model on SMAI vs. HyperPod: deploy to both, then switch focus to run the benchmark against each target in turn.

### Viewing all target states

```bash
./do/deploy --status
```

Output:

```
  managed-inference:  InService (ml.g5.4xlarge, sharp-gpt-bot-ep)
  hyperpod-eks:       Running (ml.g5.12xlarge, 4 GPUs)
  async-inference:    — (not deployed)
  batch-transform:    — (not deployed)

  Active target: managed-inference
```

---

## Per-target configuration reference

`do/config` tracks both the active target and per-target state:

```bash
# Active target
DEPLOYMENT_TARGET="managed-inference"

# Per-target status (refreshed by do/deploy --status)
DEPLOYMENT_TARGET_SMAI_STATUS="InService"
DEPLOYMENT_TARGET_HP_STATUS="Running"
DEPLOYMENT_TARGET_ASYNC_STATUS=""
DEPLOYMENT_TARGET_BATCH_STATUS=""

# Managed / Async Inference vars
INSTANCE_TYPE="ml.g5.4xlarge"
ENDPOINT_NAME="sharp-gpt-bot-ep"
ENDPOINT_STRATEGY="new"

# HyperPod vars (HP_* prefix)
HP_CLUSTER_NAME="my-cluster"
HP_GPU_COUNT="4"
HP_NAMESPACE="default"
HP_REPLICAS="1"

# Async Inference vars (populated at deploy time)
ASYNC_S3_OUTPUT_PATH=""
ASYNC_SNS_TOPIC=""

# Batch Transform vars (populated at deploy time)
BATCH_INPUT_PATH=""
BATCH_OUTPUT_PATH=""
BATCH_SPLIT_TYPE=""
BATCH_STRATEGY=""
```

Vars with empty values are present but inactive — they are populated when you deploy to that target for the first time.

---

## How `--skip-prompts` works

When generating a project with `--skip-prompts`, `do/config` is pre-populated with sensible defaults:

- `DEPLOYMENT_TARGET=managed-inference`
- `INSTANCE_TYPE` auto-sized from the model's parameter count using the instance-sizer heuristic

This ensures a fully deployable project without any interactive input — appropriate for CI/CD pipelines and automated workflows.

---

## Availability

The interactive deployment UX is scheduled for **MLCC v1.5**. In v1.4, `DEPLOYMENT_TARGET` is set in `do/config` at generation time via `--deployment-config` and can be changed at deploy time using `do/deploy --target <mode>` (the target focus switching behavior ships in v1.4 as part of BL062).
