# Right-Sizing Checks

MLCC decides "does this serving configuration fit?" in one place:
`do/lib/python/right_sizing.py`. The same module runs in three callers, so they
always agree:

| Caller | When | Effect of a `block` |
|---|---|---|
| `./do/deploy` preflight (also `./do/deploy --dry-run`, preflight only) | before any per-target create / apply, every target | stops the deploy (exit 1) unless `--ignore-sizing` |
| `./do/validate` | on demand / in CI | reported as an error (exit 1) |
| `do/adapter`, `do/tune`, `deploy.d/{eks,hyperpod-eks}` | LoRA rank decisions (Wave 6.1) | adapter load refused / rank derived |

The motivating failure: a Gemma-3-12B deploy with a 131,072-token context ran for
25.6 minutes and then failed a generic health check. The real cause (KV cache +
weights larger than GPU memory) was computable in seconds. The preflight now
refuses it up front, with the numbers and the fix.

## Severities and exit codes

Each check returns findings with `check`, `severity`, `message`, `fix` and `data`
(the numbers used, including which source each input came from).

| Severity | Meaning | Module exit |
|---|---|---|
| `block` | the deploy would fail (or the engine refuses to start) | 2 |
| `warn` | close to a limit, or the estimate is uncertain; proceeds | 1 |
| `info` | fits; the numbers are shown | 0 |
| `skip` | an input is missing (offline, gated model, uncatalogued instance); the reason is shown. Never a block: MLCC does not guess | 0 |

`right_sizing.py check [--json] [--checks a,b] [--network]` prints every finding.
Exit codes stay Wave 6.1's: 0 fits, 1 warnings, 2 blocked. `do/validate` maps a
block to its own exit 1.

### Overriding a block: `--ignore-sizing`

```bash
./do/deploy --ignore-sizing
```

`--ignore-sizing` proceeds past a right-sizing block with a warning line. It also
overrides the Wave 6.1 LoRA rank / buffer refusal inside the `eks` and
`hyperpod-eks` drivers. `--force` keeps its own meaning (redeploy a target that is
already deployed) and does **not** bypass right-sizing, so an ordinary redeploy
still runs every check. The flag is parsed by `do/deploy` itself; it is not a
generator parameter.

### Preflight only: `--dry-run`

`./do/deploy --dry-run` runs the same preflight (one shared function in
`do/deploy`) after config resolution and prints its findings with the resolved
configuration. It never creates, applies, or calls `deploy.d/<target>`.

| Preflight result | `--dry-run` exit |
|---|---|
| fits / skip | 0 |
| warn | 0 |
| block | 1 |
| block + `--ignore-sizing` | 0 (warning line printed) |

The repeatable check after a generator or serving-config change:

```bash
mcc regenerate
./do/deploy --dry-run
```

On an already-deployed project, `--dry-run` (with or without `--target` /
`--force`) previews the saved configuration and runs the preflight. It does not
switch focus, write `do/config`, or re-prompt.

## The catalogue

Status key: **8** = implemented in Wave 8, **6.1** = implemented in Wave 6.1,
**planned** = no reliable data yet.

| Check id | Catches | Inputs | Severity policy | Status |
|---|---|---|---|---|
| `context-memory` | weights + KV cache at `max_model_len` (+ LoRA buffer, + draft weights) over usable GPU memory | config.json dims, measured staged weights or estimate, instance GPU memory x GPUs, engine `gpu_memory_utilization`, KV dtype | block over usable; warn in the margin band; sliding-window models block on the window-aware bound and warn on the full-attention bound; quantized / uncertain layouts capped at warn; fixes: largest fitting `MAX_MODEL_LEN` and smallest fitting catalogued instance | 8 |
| `context-limit` | `max_model_len` above what the model supports | config.json `max_position_embeddings` (and other length keys), rope scaling the engine applies | block | 8 |
| `tp-divisibility` | TP degree larger than the GPUs the model gets, or not dividing the attention / KV heads | config.json heads, instance GPUs, pod `HP_GPU_COUNT` / `IC_GPU_COUNT`, engine TP setting | block | 8 |
| `dtype-arch` | bf16 on a pre-Ampere GPU; FP8 on a GPU without native FP8 | instances.json `gpuArchitecture`, model / engine dtype, quantization, KV dtype | bf16 pre-Ampere: block; FP8 on Ampere: warn (weight-only fallback); FP8 pre-Ampere: block; unmapped architecture: skip | 8 |
| `quant-engine` | quantization method the engine does not accept | serve manifest `quantization_methods` | warn; skip when the manifest declares no list (vLLM today) | 8 |
| `arch-engine-version` | model architecture newer than the pinned engine image | config.json `architectures`, `model-arch-support.json`, `BASE_IMAGE` version | block; skip when the architecture is not listed | 8 |
| `spec-draft-memory` | the draft model's weights are not counted | `HP_SPECULATIVE_ALGORITHM` / `HP_SPECULATIVE_MODEL`, draft config.json | info; its weights feed `context-memory` | 8 |
| `vision-weights` | a vision / audio tower is not counted | config.json `vision_config` / `audio_config` | info; counted in the estimate (already inside measured weights) | 8 |
| `ic-packing` | inference-component copies x GPUs per copy beyond the endpoint's GPUs | `do/ic/*.conf` `IC_GPU_COUNT` / `IC_COPY_COUNT`, instance GPUs, `ENDPOINT_INITIAL_INSTANCE_COUNT` | block; skip on targets without ICs | 8 |
| `concurrency-kv` | KV pool too small for `max_num_seqs` x a typical context (throughput, not failure) | engine `max_num_seqs`, benchmark profile tokens, KV capacity | info (reports capacity in tokens, window-aware and full-attention) | 8 |
| `disk-model-size` | weights larger than the model volume | weights, `ENDPOINT_VOLUME_SIZE` (SageMaker), `HP_EPHEMERAL_STORAGE` (eks emptyDir) | block; skip when no volume is configured (instance local disk is not catalogued; eks node capacity is checked live by `deploy.d/eks`) | 8 |
| `quota` | no SageMaker Service Quota for the instance type | Service Quotas API, descriptor `service_quota_usage` | warn; runs in `do/validate` only (network, ~20 s); skip on cluster targets and offline | 8 |
| `lora-rank-fit` | adapter rank above the serving `max_lora_rank` | adapter_config.json `r` / `rank_pattern`, engine rank setting, recorded tune ranks | live limit: block; configured limit: warn; rank above the engine's allowed set: block | 6.1 |
| `lora-buffer-memory` | LoRA buffer for `max_loras` x `max_lora_rank` over 10% of post-weights GPU memory | model dims, LoRA settings, weights, GPU memory | auto-raised rank: block; explicit rank: warn | 6.1 |

Planned (no reliable data today): LoRA target modules vs engine; container CUDA
version vs host driver. Not a deploy-fit check: adapter base-model mismatch (a
best-effort warning in `do/adapter`).

## How `context-memory` estimates

```
KV bytes / token = sum over layers that own a KV cache of 2 x kv_heads x head_dim x kv_dtype_bytes
need            = weights x (1 + OVERHEAD_FACTOR) + KV(max_model_len) + LoRA buffer + draft weights
usable          = TP GPUs x (per-GPU memory x GPU_VISIBLE_MEMORY_FRACTION x gpu_memory_utilization
                             - GPU_RUNTIME_RESERVE_GIB)
```

`usable` is computed in one place (`usable_bytes()`) and feeds every memory
check: `context-memory`, its largest-fitting `MAX_MODEL_LEN` and
smallest-fitting-instance fixes, `concurrency-kv`, and the `lora-buffer-memory`
budget.

- `head_dim` falls back to `hidden_size / num_attention_heads`; multimodal
  models read the language model from `text_config`.
- Layers listed in `num_kv_shared_layers` own no cache. Full-attention layers use
  `global_head_dim` / `num_global_key_value_heads` when declared (Gemma 4). MLA
  models cache `kv_lora_rank + qk_rope_head_dim` once per layer.
- **Sliding-window / hybrid models** (`layer_types`, or `sliding_window` +
  `sliding_window_pattern`) get two bounds. Upper: every layer holds
  `max_model_len`. Lower (window-aware): sliding layers hold the window plus the
  engine's in-flight tokens (`max_num_batched_tokens` x `in_flight_batches` from
  the serve manifest's `sizing_map`; vLLM v0.31 keeps the window plus every
  scheduled-but-unsettled token during chunked prefill). The check blocks when
  the lower bound is over usable memory, and warns when only the upper bound is.
- **KV capacity in tokens** (`concurrency-kv`, and `data.kv_capacity_tokens` on
  `context-memory`) uses vLLM's definition of its `GPU KV cache size: N tokens`
  line: how many `max_model_len` requests fit the KV memory, times
  `max_model_len`.
- **Weights vs vLLM's own figure.** vLLM's `Model loading took X GiB` is measured
  around model load, which also allocates the LoRA buffer, so it is weights +
  LoRA. The estimate keeps the two as separate terms, each counted once. vLLM's
  `weights + non-torch` figure adds NCCL / cuBLAS workspaces that do not scale
  with the model; those are in `GPU_RUNTIME_RESERVE_GIB`.
- **Weights** are the measured `*.safetensors` bytes under `STAGED_MODEL_PATH`
  when the model is staged; otherwise an estimate of parameters x dtype bytes
  using `instance_sizer.py`'s `BYTES_PER_PARAM`. `OVERHEAD_FACTOR` (10%) is
  `instance_sizer`'s framework / CUDA overhead. `data.weights_source` says which.
- `max_model_len` is the engine setting (for example `VLLM_MAX_MODEL_LEN`, or
  `IC_ENV_VLLM_MAX_MODEL_LEN` on SageMaker targets); when unset, the engine
  uses the model's own limit, and so does the estimate.
- `gpu_memory_utilization` is the engine setting, else the engine manifest's
  declared default (`serve.d/<engine>/manifest.json` `sizing_map`), else the
  module default.

## Calibration

Reference deployment: a live vLLM v0.31.0 pod serving `google/gemma-4-E4B-it` on
2 x 32 GB GPUs (TP 2), `max_model_len` 131,072, LoRA `max_loras` 4 /
`max_lora_rank` 64, `gpu_memory_utilization` 0.92, `max_num_batched_tokens`
2048. The recorded log values are in
`test/fixtures/right-sizing/vllm-0.31-gemma-4-e4b-capacity.json`.
`test_right_sizing_w8.py` checks that the estimate stays at or below them and
within 10%.

What vLLM logged per GPU: 31.38 GiB visible (the catalog says 32); 28.87 GiB
requested (31.38 x 0.92); model loading 9.0 GiB (weights + LoRA buffer);
9.33 GiB weights + non-torch; 1.23 GiB peak activation; 0.36 GiB CUDA graphs;
18.3 GiB available for the KV cache; `GPU KV cache size: 2,203,985 tokens`.

| Quantity (per GPU unless noted) | Before | After | vLLM |
|---|---|---|---|
| usable | 29.44 GiB (32 x 0.92) | 26.95 GiB (32 x 0.98 x 0.92 - 1.9) | 28.87 requested, less 1.92 runtime = 26.95 |
| weights + LoRA buffer | 8.92 GiB | 8.92 GiB (unchanged; each counted once) | 9.0 |
| KV memory | 20.5 GiB | 18.03 GiB | 18.3 |
| KV capacity, tokens (window-aware) | 2,689,838 (+22%) | 2,172,668 (-1.4%) | 2,203,985 |

Where the gap closed (tokens vs vLLM): the visible fraction alone gives +17%,
plus the runtime reserve +6%, plus sliding layers holding the in-flight tokens
-1.4%. With a 1.6 GiB reserve (activation + CUDA graphs, leaving out
non-torch) the estimate is +0.2%, slightly over vLLM, which is why non-torch
memory is part of the reserve.

The constants are physical quantities read from the log, not fitted to the
token count. The activation peak grows with `max_num_batched_tokens`, so raise
`MLCC_SIZING_GPU_RUNTIME_RESERVE_GIB` for much larger scheduler batches.

## Thresholds

Each threshold is a named constant in the module, overridable per run with an
environment variable:

| Constant | Default | Env override | Meaning |
|---|---|---|---|
| `BLOCK_OVER` | 1.00 | `MLCC_SIZING_BLOCK_OVER` | block when need > usable x this |
| `WARN_FROM` | 0.90 | `MLCC_SIZING_WARN_FROM` | warn when need >= usable x this |
| `DEFAULT_GPU_MEMORY_UTILIZATION` | 0.9 | `MLCC_SIZING_DEFAULT_GPU_MEMORY_UTILIZATION` | used only when the engine manifest declares no default |
| `LORA_BUFFER_BUDGET_FRACTION` | 0.10 | `MLCC_SIZING_LORA_BUDGET_FRACTION` | LoRA buffer cap, fraction of post-weights usable GPU memory |
| `FETCH_TIMEOUT_S` | 10 | `MLCC_SIZING_FETCH_TIMEOUT` | seconds to wait for a Hugging Face config.json |
| `GPU_VISIBLE_MEMORY_FRACTION` | 0.98 | `MLCC_SIZING_GPU_VISIBLE_FRACTION` | share of the catalogued per-GPU memory the driver exposes (31.38 / 32 measured) |
| `GPU_RUNTIME_RESERVE_GIB` | 1.9 | `MLCC_SIZING_GPU_RUNTIME_RESERVE_GIB` | per-GPU runtime memory outside weights, LoRA and KV: activation peak 1.23 + CUDA graphs 0.36 + non-torch 0.33 GiB (measured) |

## Where each input comes from

Nothing per-target or per-engine is hardcoded in the module (ADR-008):

- Engine setting names: `serve.d/<engine>/manifest.json` `env_var_prefix` +
  `dimension_map` (max_model_len, kv_cache_dtype, quantization, TP) + `sizing_map`
  (gpu_memory_utilization, max_num_seqs, max_num_batched_tokens with its
  per-GPU-memory default tiers and `in_flight_batches`, dtype, TP default) +
  `capability_map` (LoRA). `quantization_methods` is optional.
- Target facts: `targets.d/<target>/manifest.json` `serving_config_source`
  (`sagemaker-ic` targets read `IC_ENV_<var>` first), `verbs.add-ic` (the model
  runs on `IC_GPU_COUNT` GPUs and `ic-packing` applies), `service_quota_usage`,
  and `cluster_contract` (used by `do/validate`).
- Instance facts: `.mlcc/instances.json` (`gpus`, `gpuMemoryGb`,
  `gpuArchitecture`).
- Model facts: the staged `config.json` (else Hugging Face, with `HF_TOKEN`,
  cached in `.mlcc/sizing-cache/`).
- Architecture floor: `.mlcc/model-arch-support.json`.

## Adding a check

1. Write `@register("my-check") def check_my_check(ctx) -> list[Finding]` in
   `right_sizing.py`. Read only `ctx`; if an input is missing, return a `skip`
   finding naming it.
2. If it needs a new input, add it to `SizingContext` and fill it in
   `context_from_env()` from a declared source.
3. Add unit tests (pass / fail / skip) under `test/unit/`.
4. Add a row to the catalogue above. `test/unit/right-sizing-doc.test.js`
   fails if a registered check id is missing here.

No caller changes are needed: `do/deploy` and `do/validate` run every registered
check.
