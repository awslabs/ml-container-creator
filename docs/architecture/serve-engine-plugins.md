<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Serve-Engine Plugins

MLCC launches a model server through a per-engine **serve-layer plugin** under
`templates/code/serve.d/<engine>/`. Each plugin is two files:

- **`<engine>.ejs`** — the runtime wrapper (rendered into the generated project's
  `code/serve`) that gathers the engine's env vars and execs the server.
- **`manifest.json`** — the engine's capabilities **as data**: its env-var
  prefix, whether it supports speculative decoding and which algorithms, how MLCC
  algorithm names map to the engine's names, its benchmark dimensions, and its
  metrics endpoint.

The manifest is the **single source of truth**: `do/draft`, `do/deploy`,
`.optimize_engine.py`, and `do/benchmark` all read engine knowledge from it
rather than hardcoding per-engine logic. See
[ADR-004](../adr/ADR-004-serve-engine-plugin-parity.md) for the parity decision.

> **Serve engines, not predictors.** This doc covers the LLM/transformer serving
> engines. The classical-ML HTTP frameworks (sklearn/xgboost/tensorflow served via
> Flask/FastAPI) are a separate, hybrid plugin system — a data descriptor plus a
> `handler.py` of imperative code — documented in
> [Predictor-Framework Plugins](predictor-framework-plugins.md).

## The manifest contract

Schema: `templates/code/serve.d/manifest.schema.json`.

| Field | Required | Meaning |
|---|:---:|---|
| `engine` | ✓ | Engine name; must equal the directory name. |
| `env_var_prefix` | ✓ | Env→CLI prefix (`^[A-Z][A-Z0-9_]*_$`, e.g. `VLLM_`, or `VLLM_OMNI_` for multi-token engines). The ONE source of truth for the prefix. |
| `speculative_decoding` | ✓ | Whether the engine supports speculative decoding at all. `false` = explicitly none. |
| `supported_algorithms` | ✓ | Algorithms the engine supports (empty `[]` when `speculative_decoding` is false). |
| `algorithm_map` | ✓ | MLCC name → engine-specific name/enum (empty `{}` when unsupported). |
| `hot_reload` | ✓ | Whether the engine supports hot reload. |
| `metrics_endpoint` | — | `{path, port, format}` — consumed by the benchmark metrics poller. |
| `dimension_map` | — | Benchmark dimension → engine config-key suffix (combined with `env_var_prefix`). |

`supported_algorithms` allows an empty array and `speculative_decoding` makes
absence explicit — an engine says "I support none," it doesn't stay silent.

## The transformers-architecture engines

(The `vllm-omni` diffusion engine ships the same manifest contract but serves the
`diffusors-vllm-omni` config; it is covered in the vLLM-Omni docs, not this table.)

| Engine | prefix | speculative | algorithms | engine-specific feature | notes |
|---|---|:---:|---|---|---|
| vllm | `VLLM_` | ✓ | eagle3, eagle2, eagle, draft-model, ngram, mtp | — | consolidated `--speculative-config` JSON |
| sglang | `SGLANG_` | ✓ | eagle3, eagle2, eagle, draft-model, mtp (no ngram) | `radix_attention` (RadixAttention; `SGLANG_ENABLE_RADIX_CACHE`) | discrete `--speculative-*` flags |
| tensorrt-llm | `TRTLLM_` | ✓ | eagle3, draft-model, ngram, mtp | — | positional model arg; prefix sourced from manifest. Structured `speculative_config` YAML via `--extra_llm_api_options` (BL125). `dimension_map`: DTYPE / TENSOR_PARALLEL_SIZE / MAX_INPUT_LEN |
| lmi | `OPTION_` | ✗ | — | `rolling_batch_backend` (pluggable backend; `OPTION_ROLLING_BATCH`) | DJL reads `OPTION_*` env vars; defers to base-image entrypoint (serving.properties). `dimension_map`: QUANTIZE / TENSOR_PARALLEL_DEGREE / MAX_MODEL_LEN |
| llama-cpp | `SM_LLAMA_CPP_` | ✗ | — | `gpu_layers`, `threads`, `flash_attn` (`SM_LLAMA_CPP_N_GPU_LAYERS` / `_THREADS` / `_FLASH_ATTN`) | AWS DLC for llama.cpp serves GGUF via `llama-server`; the container OWNS its entrypoint and maps `SM_LLAMA_CPP_*` to args itself (no wrapper translation, like lmi/djl). CPU or GPU image. `dimension_map`: CTX_SIZE |

The **engine-specific feature** column is the deviation each engine offers that
the others don't (or implement differently) — declared in the manifest's
`engine_features` map (ADR-004 §c). vLLM and TensorRT-LLM declare none; that
absence *is* the signal that RadixAttention / pluggable backend / the llama.cpp
CPU-GPU-split knobs are not shared capabilities.

llama.cpp is the second **container-owns-entrypoint** engine (after lmi/djl): its
`.ejs` wrapper validates the GGUF source and hands off rather than translating
env vars into `--flags`, and the generated Dockerfile does not override the DLC
`ENTRYPOINT`. The `SM_LLAMA_CPP_` prefix is deliberate — it is literally what the
AWS DLC reads, so a `--server-env` value is passed through to the container
unchanged rather than stripped-and-retranslated.

## Consumer matrix (engine × field × who reads it)

| Field | Read by | When |
|---|---|---|
| `env_var_prefix` | `serve-manifest-reader.js` → `app.js` `templateVars.envVarPrefix` → the `.ejs` wrapper `PREFIX`; `serve_manifest.py env_var_prefix` → `hyperpod-eks` (`ENGINE_ENV_PREFIX`) + `.optimize_engine.py` (`_dimension_config_key`); `engine-prefix-resolver.js` (server-env prefixing) | generate + deploy |
| `supported_algorithms` | `do/draft` (validate `--algorithm`, `--help` text) | pre-deploy |
| `algorithm_map` | `do/deploy.d/hyperpod-eks` `_spec_enum()` (MLCC → engine enum) | deploy |
| `dimension_map` | `.optimize_engine.py` `_dimension_config_key()` | benchmark/optimize |
| `metrics_endpoint` | `do/benchmark` phase-2 poller | benchmark |
| `speculative_decoding` | `do/draft` (fast reject when false) | pre-deploy |
| `min_version` / `version_features` (BL129, optional) | `serve_manifest.py` / `serve-manifest-reader.js` `effective_supported_algorithms` → `do/draft` + `hyperpod-eks` (version-gated `--algorithm` validation); `serve-manifest-catalog-version-drift.test.js` (reachability guard vs. catalog `framework_version`) | pre-deploy + deploy + CI/commit |
| `engine_features` (ADR-004 §c, optional) | `serve-manifest-reader.js` `engineFeature`/`engineFeatures` + `serve_manifest.py` `engine_feature`/`engine_features` (generic readers, no engine-name branching). The generator uses `resolveEngineFeatureVars()` to turn a user's `--engine-feature NAME=VALUE` (or the engine-gated interactive prompt) into the feature's real env var, validate it against the manifest, and emit it into `orderedEnvVars` → `do/config`. | generate + deploy |
| `engine` | `validate-serve-manifests.js` (dir-name match) | CI/commit |

The reader on the Node side is `src/lib/serve-manifest-reader.js`; on the Python
side, `templates/do/lib/python/serve_manifest.py`. Both read the same manifests
(`app.js` copies them to the generated project's `.mlcc/serve.d/` at generation
time), so the prefix/algorithms have one source of truth across generate and
deploy.

## Adding a serve engine

> For the full extend / version / add / wire / author workflow, see the
> [Serve-Engine Plugin Authoring Guide](serve-engine-plugin-authoring.md). The
> quick version:

1. Create `templates/code/serve.d/<engine>/manifest.json` conforming to the
   schema (declare `env_var_prefix`, `speculative_decoding`,
   `supported_algorithms`, `algorithm_map`, `hot_reload`).
2. Create `templates/code/serve.d/<engine>/<engine>.ejs`. Source the prefix from
   the manifest: `PREFIX="<%= envVarPrefix || '<ENGINE>_' %>"` (do not hardcode a
   bare literal — follow `sglang.ejs`/`vllm.ejs`).
3. Register the engine in the top-level `templates/code/serve` dispatch and, if
   it's a `deploymentConfig` value, in `config/parameter-schema-v2.json`.
4. `scripts/validate-serve-manifests.js` and the parity test will now gate it.

## Gotchas

- The `<engine>.ejs` prefix MUST use the `<%= envVarPrefix || 'FALLBACK_' %>`
  form so rendered output is byte-identical whether or not the render context
  supplies `envVarPrefix`.
- `vllm-omni` and `djl` are engine aliases without their own `serve.d` directory;
  their prefixes are handled by an explicit alias mapping, not a parallel map.
