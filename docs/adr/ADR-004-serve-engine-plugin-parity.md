# ADR-004: Serve-Engine Plugin Parity

## Status

Accepted — in progress (Wave 3)

## Context

MLCC serves models through per-engine "serve-layer plugins" under
`templates/code/serve.d/<engine>/`. Each plugin is a pair: a `<engine>.ejs`
wrapper (the runtime shell that launches the engine) and a `manifest.json`
declaring the engine's capabilities as data. The manifest is meant to be the
single source of truth so `do/draft`, `do/deploy`, `.optimize_engine.py`, and
`do/benchmark` read engine knowledge from data instead of hardcoded logic.

The Wave 3 Task 1 audit found the abstraction is **real but only half-honored**:

**Deploy-time already reads the manifest.** `templates/do/lib/python/serve_manifest.py`
is a proper reader exposing `env_var_prefix`, `supported_algorithms`,
`algorithm_map`, `dimension_map`, `metrics_endpoint`, `hot_reload`. Its consumers
are correctly data-driven:
- `do/draft` validates `--algorithm` against `supported_algorithms`.
- `do/deploy.d/hyperpod-eks` reads `env_var_prefix` and translates algorithms via
  `algorithm_map`.
- `.optimize_engine.py` derives config keys from `env_var_prefix` + `dimension_map`.
- `do/benchmark` reads `metrics_endpoint`.

**Generation-time and the vLLM wrapper are not.** The defects:

1. **vLLM is a hidden first-class citizen.** `sglang.ejs` sources its prefix from
   the manifest (`PREFIX="<%= envVarPrefix || 'SGLANG_' %>"`) and emits every
   speculative var name from it. `vllm.ejs` **hardcodes** `PREFIX="VLLM_"` and
   the `VLLM_SPECULATIVE_*` names. So the reference engine doesn't follow the
   reference pattern.

2. **Two sources of truth for the prefix.** `src/lib/engine-prefix-resolver.js`
   keeps `ENGINE_PREFIX_MAP` (vllm→VLLM_, sglang→SGLANG_, tensorrt-llm→TRTLLM_,
   lmi→LMI_, djl→DJL_, vllm-omni→VLLM_OMNI_). For vllm/sglang this **duplicates**
   the manifest's `env_var_prefix`; it can drift. But it is also the **only**
   prefix source for the manifest-less engines — so it cannot simply be deleted.

3. **Half the engines have no manifest.** `vllm` and `sglang` have one;
   `lmi` and `tensorrt-llm` have only a `.ejs`. Consumers therefore special-case
   manifest absence (fallbacks in `.optimize_engine.py`, `hyperpod-eks`,
   `engine-prefix-resolver`). "No manifest" silently means "no declared
   capabilities," which an AI maintainer cannot distinguish from "capabilities
   forgotten."

## Decision

Make the manifest the single source of truth for every engine, and make
capability-absence an explicit data statement rather than an omission.

### 1. Plugin-parity contract

Every `serve.d/<engine>/` directory MUST contain both a `<engine>.ejs` wrapper
and a schema-valid `manifest.json`. Every manifest MUST declare:

| Field | Meaning |
|---|---|
| `engine` | matches the directory name |
| `env_var_prefix` | the env→CLI prefix (e.g. `VLLM_`); the ONE source of truth for the prefix |
| `speculative_decoding` | **new** boolean — whether the engine supports speculative decoding at all |
| `supported_algorithms` | the algorithms it supports (empty `[]` when `speculative_decoding` is false) |
| `algorithm_map` | MLCC-name → engine-specific-name (empty `{}` when unsupported) |
| `hot_reload` | whether the engine hot-reloads |

`metrics_endpoint` and `dimension_map` remain optional (an engine may not expose
metrics or benchmark dimensions).

### 2. Schema change: represent absence explicitly

- Add a required boolean `speculative_decoding`.
- Relax `supported_algorithms` from `minItems: 1` to `minItems: 0`, so an engine
  that does not support speculative decoding declares `supported_algorithms: []`
  and `algorithm_map: {}` — explicit "none," not a missing field.

This is the "capability-absent representation" the wave calls for: consumers
read `speculative_decoding: false` instead of inferring from a missing manifest.

### 3. Add manifests for lmi and tensorrt-llm

- `tensorrt-llm`: `env_var_prefix: "TRTLLM_"`, `speculative_decoding: false`,
  empty algorithms. (Its `.ejs` has no speculative logic.)
- `lmi`: `env_var_prefix: "LMI_"`, `speculative_decoding: false`, empty
  algorithms. (Its `.ejs` defers to the DJL base-image entrypoint via
  serving.properties.)

`validate-serve-manifests.js` then covers 4/4 engines, and a test asserts every
serve.d engine directory has a schema-valid manifest — so no future engine can
ship manifest-less.

### 4. vLLM consumes its own manifest

Refactor `vllm.ejs` to source `PREFIX` from `envVarPrefix` (the manifest) exactly
like `sglang.ejs`, with the same defensive `|| 'VLLM_'` fallback so rendered
output is byte-identical. Its speculative var names come from the manifest prefix
too. vLLM's consolidated `--speculative-config` JSON emission stays as its
declared strategy (vs SGLang's discrete flags) — the *strategy* is per-engine,
but the *prefix and names* are manifest-sourced.

### 5. One prefix source of truth

`engine-prefix-resolver.js` reads `env_var_prefix` from the manifest (via the
serve-manifest reader) instead of `ENGINE_PREFIX_MAP`. Because every engine now
has a manifest, the hardcoded map is removed. `vllm-omni` and `djl` (aliases
without their own serve.d dir) are handled by mapping them to their base engine's
manifest or by an explicit documented alias table, not a parallel prefix map.

## Consequences

- **Positive:** one source of truth per fact (prefix, algorithms, dimensions);
  no hidden first-class engine; capability-absence is declared data; adding an
  engine is "add a `.ejs` + a `manifest.json`," gated by the validator and a
  parity test.
- **Cost:** a schema change (new required field) means the two existing manifests
  must add `speculative_decoding: true`; consumers that fell back on manifest
  absence can be simplified (tracked, not all done in Wave 3).
- **Risk:** the `vllm.ejs` change must keep rendered output byte-identical
  (verified by the existing render tests + the sglang-style fallback).
  Removing `ENGINE_PREFIX_MAP` must preserve the `vllm-omni`/`djl` alias
  behavior — covered by the engine-prefix tests.

## References

- `docs/architecture/serve-engine-plugins.md` — how the plugin system works + the field matrix
- `templates/code/serve.d/manifest.schema.json` — the contract
- `templates/do/lib/python/serve_manifest.py` — the deploy-time reader
- ADR-002 — the consolidation program
