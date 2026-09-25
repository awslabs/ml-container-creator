# Speculative Decoding on HyperPod EKS

Speculative decoding accelerates LLM inference by using a small draft model to propose
candidate tokens, which the target model verifies in parallel. MLCC supports speculative
decoding on HyperPod EKS for both vLLM and SGLang serve images.

The recommended way to configure it is the **`do/draft`** command, which manages the
`HP_SPECULATIVE_*` configuration for you, validates engine/algorithm compatibility, and
can redeploy in one step. Manual `HP_SPECULATIVE_*` editing is still supported and is
documented under [Advanced / manual configuration](#advanced--manual-configuration).

!!! note "realtime-inference uses a different path"
    `do/draft` targets **HyperPod EKS only** (`DEPLOYMENT_TARGET=hyperpod-eks`). For the
    `realtime-inference` target, speculative decoding is configured through the SageMaker AI
    Inference Recommendations flow — run `do/optimize --apply <arn>`, which maps the
    returned `SpeculativeDecodingConfig` into `HP_SPECULATIVE_*`. See
    [Getting a speculative recommendation from SMAI](#getting-a-speculative-recommendation-from-smai).

---

## Quick Start with `do/draft`

`do/draft` is a deployment-centric script (available after a project is deployed to
HyperPod EKS). It reads and writes the `HP_SPECULATIVE_*` vars in `do/config` so you never
have to edit them by hand.

```bash
# 1. Browse the catalog of known draft models
./do/draft list

# 2. Configure a draft model (defaults: --algorithm eagle3, --num-tokens 5)
./do/draft set thoughtworks/Llama-3.1-8B-Instruct-Eagle3

# 3. Check what's configured
./do/draft status

# 4. Apply it (a redeploy is required — see below)
./do/deploy

# ...or configure and redeploy in a single step
./do/draft set thoughtworks/Llama-3.1-8B-Instruct-Eagle3 --deploy

# 5. Turn speculative decoding back off
./do/draft remove
./do/deploy
```

### Commands

| Command | Description |
|---|---|
| `set <hf-id> [options]` | Configure a speculative decoding draft model. |
| `remove` | Clear the speculative decoding configuration (redeploy to apply). |
| `status` | Show the current draft model configuration. |
| `list [filters]` | Browse the catalog of known draft models. |

### `set` options

| Option | Default | Description |
|---|---|---|
| `--algorithm <alg>` | `eagle3` | `eagle3`, `eagle2`, `eagle`, `draft-model`, `ngram`, or `mtp`. |
| `--num-tokens <N>` | `5` | Speculative tokens proposed per step (`HP_SPECULATIVE_NUM_TOKENS`). |
| `--draft-tp <N>` | — | Tensor-parallel degree for the draft model (`HP_SPECULATIVE_DRAFT_TP`). |
| `--eagle-topk <N>` | — | EAGLE top-k candidates (SGLang only; `eagle`/`eagle3`). |
| `--deploy` | off | Clean and redeploy immediately after updating config (see below). |

The `set` subcommand writes these vars to `do/config`:
`HP_SPECULATIVE_ALGORITHM`, `HP_SPECULATIVE_MODEL`, `HP_SPECULATIVE_NUM_TOKENS`, and,
when supplied, `HP_SPECULATIVE_DRAFT_TP` and `HP_SPECULATIVE_EAGLE_TOPK`.

!!! important "HF model IDs only"
    The draft model must be a HuggingFace model ID (e.g.
    `thoughtworks/Llama-3.1-8B-Instruct-Eagle3`). `s3://` draft URIs are **rejected** —
    stage to HF Hub or bake the weights into the container image instead.

### The `--deploy` flag (and why it cleans first)

Speculative decoding is a **server startup flag**, not a hot-loadable setting. vLLM and
SGLang read the speculative configuration once when the server process starts and build
their engine arguments from it — there is no way to attach a draft model to a running
server. Any change therefore requires the serving container to restart, which means a
redeploy.

`--deploy` automates that restart, but it does **not** do a plain `do/deploy`. It runs:

```bash
./do/clean hyperpod --force    # tear down the existing deployment first
./do/deploy                    # then bring it back up with the new draft config
```

The clean step is **required on single-node HyperPod EKS**. If you redeploy over a running
deployment, the old pod is still holding the node's GPU(s) while the new pod tries to
schedule and claim the same GPU(s). Neither can proceed — the new pod stays `Pending`
waiting for GPUs the old pod won't release until the new one is `Ready` — a resource
deadlock. Cleaning first releases the GPUs so the new deployment can schedule cleanly.

If you configure without `--deploy`, `do/draft` reminds you to run `./do/deploy` yourself.
On single-node clusters, prefer `--deploy` (or `do/clean hyperpod --force` before
`do/deploy`) to avoid the deadlock.

### Browsing the catalog: `do/draft list`

`do/draft list` prints the known draft models from the MLCC catalog, including each
model's algorithm, its target model, and which engines support it:

```bash
# List everything (default limit 20)
./do/draft list

# Filter by target model (partial match)
./do/draft list --target meta-llama/Llama-3.1-8B-Instruct

# Filter by algorithm
./do/draft list --algorithm eagle3

# Raise the limit
./do/draft list --limit 50
```

| Filter | Description |
|---|---|
| `--target <partial>` | Match draft models whose target model contains this substring. |
| `--algorithm <alg>` | Match only entries using this algorithm. |
| `--limit <N>` | Maximum entries to display (default 20). |

The catalog is read from `.mlcc/draft-models.json`, which is copied into your project at
`mcc generate` time from the generator's `servers/lib/catalogs/draft-models.json` (the
command falls back to the source tree if the project-local copy is missing). If a newly
added model doesn't appear, run `mcc regenerate` to refresh the copy. The same catalog
also powers the [`draft-model-picker` MCP server](mcp-configuration.md#draft-model-picker),
so you can ask an MCP-connected agent for a recommendation.

---

## Engine Compatibility

Not every algorithm is supported by every engine. `do/draft` validates this before writing
config and errors (or, for LMI, warns and prompts) if the combination is unsupported.

| Algorithm | vLLM | SGLang | Draft model required? |
|---|:---:|:---:|:---:|
| `eagle3` | ✅ | ✅ | yes |
| `eagle2` | ✅ | ✅ | yes |
| `eagle` | ✅ | ✅ | yes |
| `draft-model` | ✅ | ✅ | yes |
| `mtp` | ✅ | ✅ | no |
| `ngram` | ✅ | ❌ | no |
| `medusa` | ✅ | ❌ | yes |

**Engine guard behavior in `do/draft set`:**

| `MODEL_SERVER` | Behavior |
|---|---|
| `vllm` | All algorithms allowed. |
| `sglang` | `ngram` and `medusa` are rejected (vLLM-only); all others allowed. |
| `lmi` | Warns that LMI uses `serving.properties` (`option.speculative_draft_model`) rather than `HP_SPECULATIVE_*`, then prompts for confirmation. |
| other | Hard error — speculative decoding requires `vllm` or `sglang`. |

`ngram` and `medusa` are **vLLM-only**. `ngram` (prompt lookup) and `mtp` (multi-token
prediction) do not use a draft model, so the HF ID you pass is recorded but ignored by
those algorithms.

---

## How It Works

`do/draft set` writes `HP_SPECULATIVE_*` into `do/config`. At deploy time, the
`InferenceEndpointConfig` CRD template reads these vars and emits **both** engine-specific
environment variable sets into `spec.worker.environmentVariables`. The container reads only
the vars for its own engine — vLLM or SGLang — and constructs the appropriate startup flags
before launching the server.

This means you configure speculative decoding once (via `do/draft` or by hand); the
template handles the engine-specific translation automatically.

---

## Algorithm Reference

| Algorithm | Description | vLLM method | SGLang algorithm |
|---|---|---|---|
| `draft-model` | Independent draft model (standard) | `draft_model` | `STANDALONE` |
| `eagle` | EAGLE tree attention | `eagle` | `EAGLE` |
| `eagle2` | EAGLE v2 (improved acceptance rate) | `eagle2` | `EAGLE` |
| `eagle3` | EAGLE v3 (latest) | `eagle3` | `EAGLE3` |
| `ngram` | N-gram prompt lookup (no draft model) | `ngram` | *(unsupported)* |
| `mtp` | Multi-token prediction (no draft model) | `mtp` | `MTP` |

### EAGLE3 requirement

EAGLE3 **must** have a draft model path set. If `HP_SPECULATIVE_MODEL` is empty with
`HP_SPECULATIVE_ALGORITHM=eagle3`, the serve wrapper exits with an error at container
startup (both vLLM and SGLang). This prevents a silent failure where the target model
is used as its own draft (which causes a crash). `do/draft set` enforces the same guard
before writing config.

### ngram / mtp

`ngram` and `mtp` do not use a draft model — `HP_SPECULATIVE_MODEL` is ignored for these
algorithms. `ngram` is only supported on vLLM; attempting it on an SGLang image results
in an unknown-algorithm error.

---

## Engine-Specific Behavior

### vLLM

The serve wrapper builds a `--speculative-config` JSON argument:

```json
{
  "method": "eagle3",
  "model": "your-org/your-draft-model",
  "num_speculative_tokens": 5
}
```

Note that vLLM method names use **underscores** (`draft_model`, `eagle3`) — the hyphenated
user-facing names are mapped at template generation time.

### SGLang

The serve wrapper builds discrete flags:

```bash
--speculative-algorithm EAGLE3
--speculative-draft-model-path your-org/your-draft-model
--speculative-num-steps 5
--speculative-eagle-topk 8    # eagle / eagle3 only
```

SGLang algorithm names use **UPPERCASE** (`EAGLE3`, `STANDALONE`, `NGRAM`, etc.) — again
mapped automatically from the user-facing `HP_SPECULATIVE_ALGORITHM` value.

---

## Constraints

| Constraint | Detail |
|---|---|
| **No S3 draft URIs** | `HP_SPECULATIVE_MODEL` must be a HuggingFace model ID. `s3://` URIs are rejected by `do/draft set` and at container startup with a clear error. Stage to HF Hub or use a local path inside the container image instead. |
| **Draft model must be compatible** | The draft model architecture must match the target model's hidden size and vocabulary. Most published EAGLE/draft models are tied to a specific target model family (see the catalog's `target_model` / `target_arch`). |
| **ngram / medusa are vLLM-only** | SGLang does not support `ngram` or `medusa` speculative decoding. |
| **Startup flag, not hot-loadable** | Any change requires a serving-container restart. On single-node HyperPod EKS this means clean + redeploy to avoid a GPU resource deadlock (see [`--deploy`](#the---deploy-flag-and-why-it-cleans-first)). |
| **HyperPod EKS only** | `do/draft` and the `HP_SPECULATIVE_*` path are specific to the HyperPod EKS deployment target. The `realtime-inference` target uses `do/optimize --apply` instead. |

---

## Advanced / manual configuration

You can set the `HP_SPECULATIVE_*` vars directly in `do/config` instead of using
`do/draft`. This is what `do/draft` writes under the hood; both paths are equivalent.

Set these in `do/config` before deploying:

```bash
# Required
export HP_SPECULATIVE_ALGORITHM="eagle3"   # see Algorithm Reference above
export HP_SPECULATIVE_MODEL="your-org/your-draft-model"   # HF model ID (NOT s3://)

# Optional
export HP_SPECULATIVE_NUM_TOKENS="5"       # speculative token budget per step (default: 5)
export HP_SPECULATIVE_DRAFT_TP="1"         # tensor-parallel degree for the draft model
export HP_SPECULATIVE_EAGLE_TOPK="8"       # EAGLE top-k (eagle / eagle3 only)
```

Then deploy as normal:

```bash
./do/deploy
```

To disable speculative decoding, leave `HP_SPECULATIVE_ALGORITHM` unset (commented out or
removed from `do/config`), or run `./do/draft remove`. There is no `HP_SPECULATIVE_ENABLED`
flag — the algorithm var being non-empty is the only guard.

!!! note "Manual edits still require a redeploy (and a clean on single-node)"
    Because speculative decoding is a startup flag, hand-editing `do/config` still requires
    a serving-container restart. On single-node HyperPod EKS, run
    `./do/clean hyperpod --force` before `./do/deploy` (this is exactly what
    `do/draft set --deploy` does) to avoid the GPU deadlock described above.

---

## Getting a Speculative Recommendation from SMAI

For the `realtime-inference` target, `do/optimize --apply` can write speculative decoding
config automatically when the SageMaker AI Inference Recommendations API returns a
`SpeculativeDecodingConfig` in its results:

```bash
# Run a recommendation job (latency or throughput with --dataset)
./do/optimize --goal latency

# Apply the top result — writes HP_SPECULATIVE_* if the API recommended it
./do/optimize --apply top
```

When applied, these vars are written to `do/config`:

| Variable | Source |
|---|---|
| `HP_SPECULATIVE_ALGORITHM` | Inferred from `OptimizationName` (`eagle3` / `eagle` / `draft-model`) |
| `HP_SPECULATIVE_MODEL` | `DraftModelArn` (HF model ID extracted when derivable, else full ARN) |
| `HP_SPECULATIVE_NUM_TOKENS` | `NumSpeculativeTokens` from the recommendation |

!!! note "Speculative recommendations require larger models"
    The SMAI API only returns `SpeculativeDecodingConfig` for models where a compatible
    marketplace draft model exists. Models ≤3B parameters typically don't qualify. For
    `--goal throughput`, pass `--dataset s3://...` (or a registered name / `hf://` reference)
    to enable speculator training (see [Optimization](optimize.md)).

---

## Verifying Speculative Decoding Is Active

After deploying with a draft model configured, verify the serve flags made it into the
container:

```bash
# Check the current config as MLCC sees it
./do/draft status

# Check the generated InferenceEndpointConfig
kubectl get inferenceendpointconfig <project-name> -n <namespace> -o yaml \
  | grep -A 30 environmentVariables

# Check the running container's env
kubectl exec -n <namespace> <pod-name> -- env | grep SPECULATIVE
```

For vLLM, the server logs on startup will include:

```
INFO: Speculative decoding is enabled with method: eagle3
```

For SGLang, look for:

```
Speculative algorithm: EAGLE3
```

Then measure the speedup:

```bash
./do/benchmark --workload sample
./do/benchmark --compare-baseline
```

---

## See Also

- [HyperPod EKS Deployment](deployments.md#sagemaker-ai-hyperpod-eks-hyperpod-eks)
- [MCP Servers — draft-model-picker](mcp-configuration.md#draft-model-picker)
- [Optimization (do/optimize)](optimize.md)
