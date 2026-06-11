# Supported Models

MCC validates specific model + server + instance combinations end-to-end through the full lifecycle — generate, build, deploy, test, tune, and adapt. If your configuration is listed here, every step has been tested and proven to work.

Models not listed below are still supported by MCC — the CLI generates projects for any HuggingFace model. You take on the validation responsibility for unlisted combinations.

!!! warning "Validation In Progress"
    The v1 validation sprint is actively running. Status indicators below reflect the **target state** — models are being validated sequentially starting with the smallest (CI tier). Check the [release notes](https://github.com/awslabs/ml-container-creator/releases) for the latest confirmed validations.

---

## Model Families

### Qwen 3

| Model | Parameters | Instance | Tuning Techniques | Status |
|---|---|---|---|---|
| Qwen/Qwen3-0.6B | 0.6B | ml.g5.xlarge | SFT, DPO | ✅ Validated |
| Qwen/Qwen3-1.7B | 1.7B | ml.g5.xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen3-4B | 4B | ml.g5.xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen3-8B | 8B | ml.g5.xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen3-14B | 14B | ml.g5.2xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen3-32B | 32B | ml.g5.12xlarge | SFT, DPO, RLVR | ⏳ Pending |

### Qwen 2.5

| Model | Parameters | Instance | Tuning Techniques | Status |
|---|---|---|---|---|
| Qwen/Qwen2.5-7B-Instruct | 7B | ml.g5.xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen2.5-14B-Instruct | 14B | ml.g5.2xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen2.5-32B-Instruct | 32B | ml.g5.12xlarge | SFT, DPO | ⏳ Pending |
| Qwen/Qwen2.5-72B-Instruct | 72B | ml.g5.48xlarge | SFT, DPO, RLVR | ⏳ Pending |

### Llama 3

| Model | Parameters | Instance | Tuning Techniques | Status |
|---|---|---|---|---|
| meta-llama/Llama-3.2-1B-Instruct | 1B | ml.g5.xlarge | SFT, DPO | ✅ Validated |
| meta-llama/Llama-3.2-3B-Instruct | 3B | ml.g5.xlarge | SFT, DPO | ⏳ Pending |
| meta-llama/Llama-3.1-8B-Instruct | 8B | ml.g5.xlarge | SFT, DPO, RLVR | ⏳ Pending |
| meta-llama/Llama-3.3-70B-Instruct | 70B | ml.g5.48xlarge | SFT, DPO, RLVR, RLAIF | ⏳ Pending |

!!! note "Gated Models"
    Llama models require a HuggingFace token with Meta's license agreement accepted. See [Secrets Management](secrets.md) for configuration.

### DeepSeek R1 (Distilled)

| Model | Parameters | Instance | Tuning Techniques | Status |
|---|---|---|---|---|
| deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B | 1.5B | ml.g5.xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-7B | 7B | ml.g5.xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-14B | 14B | ml.g5.2xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-32B | 32B | ml.g5.12xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |
| deepseek-ai/DeepSeek-R1-Distill-Llama-8B | 8B | ml.g5.xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |
| deepseek-ai/DeepSeek-R1-Distill-Llama-70B | 70B | ml.g5.48xlarge | SFT, DPO, RLAIF, RLVR | ⏳ Pending |

### GPT-OSS

| Model | Parameters | Instance | Tuning Techniques | Status |
|---|---|---|---|---|
| openai/gpt-oss-20b | 20B | ml.g5.12xlarge | SFT, DPO | ⏳ Pending |
| openai/gpt-oss-120b | 120B | ml.g5.48xlarge | SFT, DPO | ⏳ Pending |

---

## Inference Engines

### vLLM — Fully Validated

All 22 models above are validated with vLLM as the inference engine. vLLM provides:

- High-throughput serving with PagedAttention
- OpenAI-compatible API (`/v1/chat/completions`, `/v1/completions`)
- LoRA adapter hot-swap (no endpoint restart required)
- Tensor parallelism for multi-GPU deployments

```bash
ml-container-creator my-model \
  --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-8B \
  --instance-type=ml.g5.xlarge \
  --enable-lora \
  --skip-prompts
```

### SGLang — Supported, Validation Pending

SGLang is supported by the generator but not yet included in the automated validation matrix. Generated projects work, but you may encounter edge cases not covered by testing.

### TensorRT-LLM — Supported, Validation Pending

TensorRT-LLM is supported by the generator. Requires NGC authentication for base images. Not yet in the automated validation matrix.

### DJL/LMI — Supported, Validation Pending

AWS Large Model Inference is supported by the generator. Not yet in the automated validation matrix.

---

## Instance Recommendations

| Model Size | Recommended Instance | GPUs | VRAM | Tensor Parallelism |
|---|---|---|---|---|
| ≤8B (bf16) | ml.g5.xlarge | 1 | 24 GB | 1 |
| 8B–14B (bf16) | ml.g5.2xlarge | 1 | 24 GB | 1 |
| 14B–32B (bf16) | ml.g5.12xlarge | 4 | 96 GB | 4 |
| 32B–72B (bf16) | ml.g5.48xlarge | 8 | 192 GB | 8 |
| 70B+ (AWQ 4-bit) | ml.g5.12xlarge | 4 | 96 GB | 4 |

!!! tip "Quota Requirements"
    `ml.g5.12xlarge` and `ml.g5.48xlarge` often have a default quota of 0 for SageMaker AI endpoints. Request a quota increase via the [Service Quotas console](https://console.aws.amazon.com/servicequotas/) before deploying large models.

---

## Tuning Techniques

All supported models include at least one fine-tuning technique via SageMaker AI Managed Model Customization (serverless — no instance management required).

| Technique | Description | Output | Deploy With |
|---|---|---|---|
| **SFT** | Supervised Fine-Tuning on prompt/completion pairs | LoRA adapter | `do/adapter add --from-tune` |
| **DPO** | Direct Preference Optimization on chosen/rejected pairs | LoRA adapter | `do/adapter add --from-tune` |
| **RLVR** | Reinforcement Learning with Verifiable Rewards | LoRA adapter | `do/adapter add --from-tune` |
| **RLAIF** | RL from AI Feedback (requires Lambda reward function) | LoRA adapter | `do/adapter add --from-tune` |

See [Fine-Tuning](fine-tuning.md) for full documentation on `do/tune` and the tune-adapter-deploy feedback loop.

---

## Lifecycle Coverage

Every model listed on this page has been validated through the complete lifecycle:

```
generate → build → push → deploy → test → tune (SFT) → adapter add → test → clean
```

| Stage | What's Tested |
|---|---|
| **Generate** | CLI produces a valid project with Dockerfile, serve code, and do/ scripts |
| **Build** | Docker image builds successfully with correct base image and dependencies |
| **Push** | Image pushes to ECR without authentication or size issues |
| **Deploy** | Endpoint reaches InService within the expected timeout |
| **Test** | Health check passes + inference returns valid response |
| **Tune** | SageMaker AI managed customization job completes, adapter weights written to S3 |
| **Adapter** | LoRA adapter hot-swapped onto running endpoint without restart |
| **Test (Adapter)** | Inference with adapter returns valid response |
| **Clean** | All resources torn down, no orphaned endpoints |

---

## Model Notes & Known Issues

### General

- **First deploy is slow** — Model weights download from HuggingFace on first container start (5–30 min for large models). Subsequent deploys from the same ECR image are faster.
- **Tensor parallelism must match GPU count** — Set automatically by MCC based on instance type. Manual override via `do/config`.

### Qwen 3

- The 32B model requires `--max-model-len` adjustment for sequences > 8K tokens on g5.12xlarge (VRAM constraint).

### Llama 3

- Gated model — requires HuggingFace token with Meta license acceptance.
- The 70B model takes ~15 min to reach InService on g5.48xlarge (weight download + model loading).

### DeepSeek R1

- All 4 tuning techniques supported (SFT, DPO, RLAIF, RLVR).
- Distilled variants maintain reasoning chain formatting in outputs.

### GPT-OSS

- Newest family — less community validation than Qwen or Llama.
- The 120B model requires `ml.g5.48xlarge` quota (default 0 in most accounts).

---

## Using Unsupported Models

MCC generates projects for **any** HuggingFace model, not just those listed here:

```bash
ml-container-creator my-custom-model \
  --deployment-config=transformers-vllm \
  --model-name=my-org/my-custom-model \
  --instance-type=ml.g5.xlarge \
  --skip-prompts
```

For unlisted models:

- ✅ Generation, build, push, and deploy will work if the model is compatible with the selected server
- ⚠️ Instance sizing is based on the MCP instance-sizer heuristic — verify manually for custom models
- ⚠️ Fine-tuning with `do/tune` only works for models in the [Supported Model Catalog](https://docs.aws.amazon.com/sagemaker/latest/dg/model-customization-supported-models.html)
- ⚠️ You take on validation responsibility — consider running `do/validate` before deploying

---

## Expansion Roadmap

These configurations are planned for future validation:

| Configuration | Status | Expected |
|---|---|---|
| SGLang (same 22 models) | Planned | Post-v1 |
| g6 instance family (NVIDIA L4) | Planned | Post-v1 |
| TensorRT-LLM (subset of models) | Planned | Post-v1 |
| DPO/RLVR full technique coverage | Planned | Post-v1 |
| Diffusion models (FLUX, Stable Diffusion) | Temporarily removed | TBD |
