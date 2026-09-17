# Speculative Decoding on HyperPod EKS

Speculative decoding accelerates LLM inference by using a small draft model to propose
candidate tokens, which the target model verifies in parallel. MLCC supports speculative
decoding on HyperPod EKS for both vLLM and SGLang serve images.

---

## How It Works

Set `HP_SPECULATIVE_ALGORITHM` (and related vars) in `do/config` before running `./do/deploy`.
The `InferenceEndpointConfig` CRD template reads these at generation time and emits
**both** engine-specific environment variable sets into `spec.worker.environmentVariables`.
The container reads only the vars for its own engine — vLLM or SGLang — and constructs the
appropriate flags before starting the server.

This means you configure speculative decoding once in `do/config`; the template handles the
engine-specific translation automatically.

---

## Configuration

Set these in `do/config` before deploying:

```bash
# Required
export HP_SPECULATIVE_ALGORITHM="eagle3"   # see Algorithm Reference below
export HP_SPECULATIVE_MODEL="your-org/your-draft-model"   # HF model ID (NOT s3://)

# Optional
export HP_SPECULATIVE_NUM_TOKENS="5"       # speculative token budget per step (default: 5)
export HP_SPECULATIVE_EAGLE_TOPK="8"       # EAGLE top-k (eagle / eagle3 only)
```

Then deploy as normal:

```bash
./do/deploy
```

To disable speculative decoding, leave `HP_SPECULATIVE_ALGORITHM` unset (commented out or
removed from `do/config`). There is no `HP_SPECULATIVE_ENABLED` flag — the algorithm var
being non-empty is the only guard.

---

## Algorithm Reference

| `HP_SPECULATIVE_ALGORITHM` | Description | vLLM method | SGLang algorithm |
|---|---|---|---|
| `draft-model` | Independent draft model (standard) | `draft_model` | `STANDALONE` |
| `eagle` | EAGLE tree attention | `eagle` | `EAGLE` |
| `eagle2` | EAGLE v2 (improved acceptance rate) | `eagle2` | `EAGLE` |
| `eagle3` | EAGLE v3 (latest) | `eagle3` | `EAGLE3` |
| `ngram` | N-gram prompt lookup (no draft model) | `ngram` | `NGRAM` |
| `mtp` | Multi-token prediction | `mtp` | `MTP` |

### EAGLE3 requirement

EAGLE3 **must** have a draft model path set. If `HP_SPECULATIVE_MODEL` is empty with
`HP_SPECULATIVE_ALGORITHM=eagle3`, the serve wrapper exits with an error at container
startup (both vLLM and SGLang). This prevents a silent failure where the target model
is used as its own draft (which causes a crash).

### ngram / mtp

`ngram` and `mtp` do not use a draft model — `HP_SPECULATIVE_MODEL` is ignored for these
algorithms. `ngram` is only supported on vLLM; attempting it on an SGLang image will result
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
| **No S3 draft URIs** | `HP_SPECULATIVE_MODEL` must be a HuggingFace model ID. `s3://` URIs are rejected at container startup with a clear error. Stage to HF Hub or use a local path inside the container image instead. |
| **Draft model must be compatible** | The draft model architecture must match the target model's hidden size and vocabulary. Most published EAGLE/draft models are tied to a specific target model family. |
| **ngram is vLLM-only** | SGLang does not support `ngram` speculative decoding. |
| **HyperPod EKS only** | Speculative decoding via `HP_SPECULATIVE_*` is specific to the HyperPod EKS deployment path. The `realtime-inference` target uses a different inference component configuration. |

---

## Getting a Speculative Recommendation from SMAI

`do/optimize --apply` can write speculative decoding config automatically when the
SageMaker AI Inference Recommendations API returns a `SpeculativeDecodingConfig` in
its results:

```bash
# Run a recommendation job (latency or throughput with --dataset-uri)
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
    `--goal throughput`, pass `--dataset-uri s3://...` to enable speculator training
    (see [Optimization](optimize.md)).

---

## Verifying Speculative Decoding Is Active

After deploying with `HP_SPECULATIVE_ALGORITHM` set, verify the serve flags made it into
the container:

```bash
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

---

## See Also

- [HyperPod EKS Deployment](deployments.md#sagemaker-ai-hyperpod-eks-hyperpod-eks)
- [Optimization (do/optimize)](optimize.md)
- [BL082 Spike: vLLM + SGLang Speculative Decoding](../.kiro/bl082-speculative-decoding-spike.md)
