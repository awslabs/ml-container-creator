<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-010: Kubernetes engine-config injection — minimal injected set + prefix pass-through

## Status

Accepted — proposed (spec: `.kiro/specs/bl-engine-aware-k8s-config/`).

## Context

MLCC serves models through per-engine serve-layer plugins
(`templates/code/serve.d/<engine>/`), with the manifest as the single source of
truth for engine knowledge (ADR-004) and version-gating on top (ADR-009). Each
engine wrapper slurps only its OWN manifest-declared `env_var_prefix`
(`VLLM_`, `SGLANG_`, `TRTLLM_`, `OPTION_`, …), converting `<PREFIX>FOO_BAR` →
`--foo-bar`.

The Kubernetes-style deploy surfaces, however, were authored vLLM-first. The EKS
`ConfigMap` (`templates/eks/ConfigMap.yaml.ejs`), the HyperPod CRD
(`templates/hyperpod/InferenceEndpointConfig.yaml.ejs`), the deploy drivers, and
`config/parameter-schema-v2.json` all emit shared capabilities (model id,
tensor-parallel degree, quantization, LoRA) under **hardcoded `VLLM_*` names**.
For any non-vLLM engine those keys are the wrong prefix, so the wrapper ignores
them and the capability silently never reaches the engine. A live SGLang-on-EKS
deploy surfaced this: tensor-parallel degree and quantization were dropped, and a
LoRA toggle rode a baked image ENV that crashed the server with a bare
`--enable-lora` (see `.kiro/k8s-engine-config-findings.md`).

The naive fix — rename `VLLM_*` to the active engine's prefix at each render
surface — "fixes SGLang" but keeps the deeper design flaw: it treats the set of
configurable capabilities as a **fixed, MLCC-owned vocabulary**. The moment a
power user leverages an advanced SGLang/TRT-LLM flag, or ships their own
`serve.d/<engine>/` plugin, they would again need MLCC's schema and render code
to grow a new blessed entry. That re-creates vLLM's hidden-first-class-citizen
problem one layer down (the ADR-004 defect, applied to config injection).

## Decision

Split engine configuration into **two tiers**, and keep MLCC's privileged
knowledge deliberately minimal.

### Tier 1 — the MLCC-injected set (small, computed, companion-aware)

MLCC injects ONLY the capabilities whose VALUE it computes itself and must place
correctly. As of this ADR that set is exactly:

| Capability | Why MLCC must own it |
|---|---|
| **model** | MLCC resolves the model id / staged S3 path and the source mode |
| **tensor-parallel degree** | MLCC derives it from the selected instance's GPU count (ADR: GPU count is catalog-owned) |
| **LoRA companion contract** | when LoRA is on, MLCC must satisfy each engine's companion requirements (e.g. SGLang `--enable-lora` needs `--max-lora-rank` + `--lora-target-modules`) or NOT emit it — a correctness rule, not a value |

The **per-engine expression** of each (the env-var suffix, value shape, and
companion requirements) is declared by the engine's OWN manifest and resolved
through the serve-manifest readers — never hardcoded in a render surface. The
companion rule lives in exactly one place (the reader's resolve function), so a
capability that would be invalid without companions is omitted rather than emitted
bare, for every engine including custom ones.

#### Which engines declare a `capability_map` (Model A vs Model B)

Tier-1 injection only applies to engines where **MLCC owns the container
entrypoint** and its `code/serve` wrapper translates `<PREFIX>*` env vars into CLI
flags. Call these **Model-A** engines: vLLM, SGLang, TensorRT-LLM. The
`capability_map` exists to feed that translation, so only Model-A engines declare
a non-empty one.

**Model-B** engines — where the AWS Deep Learning Container **owns its own
entrypoint and env-var contract** — do NOT: LMI/DJL (configured by a
`serving.properties` file; DJL Serving is the base-image entrypoint) and llama-cpp
(the DLC reads `SM_LLAMA_CPP_*` and maps them to `llama-server` args itself). For
these, MLCC's wrapper only validates the model source and hands off; it must NOT
translate env→flags or the DLC would double-translate. A Model-B engine therefore
declares `capability_map: {}` — an explicit "MLCC injects no Tier-1 config here."
(Benchmark-tunable vars for these engines still live in `dimension_map`, which is
a separate consumer and unaffected.) A `capability_map` entry on a Model-B engine
would be dead metadata — misleading, never injected — so the rule is: Model-B ⇒
empty `capability_map`.

#### Companion contract: `requires` and `requires_any_of`

An engine declares a capability's companions with either `requires` (a single
AND-group — all listed companions must resolve) or `requires_any_of` (an OR of
AND-groups — the capability emits if AT LEAST ONE inner group fully resolves).
`requires` is sugar for a one-group `requires_any_of`. This OR form exists because
real engines offer alternative companion sets: SGLang `--enable-lora` is valid
with *(`--max-lora-rank` AND `--lora-target-modules`)* **OR** *(`--lora-paths`)*.
The resolver is the single home of this rule and never branches on the engine
name, so a custom plugin's OR-contract is honored identically.

**MLCC-supplied companion defaults.** When MLCC enables a capability (e.g. LoRA)
and the active engine's `capability_map` declares a companion required, MLCC fills
a sensible default for any companion the user did not set — keyed by the capability
name, never the engine name. For **SGLang pure-dynamic LoRA** MLCC supplies
`MAX_LORA_RANK=16` and `LORA_TARGET_MODULES=all` (both overridable via Tier-2
pass-through); vLLM (no required companions) gets none and stays bare. This makes
"LoRA on" a working deploy rather than a silently-omitted one.

**SGLang LoRA is pure-dynamic only** (no startup `--lora-paths` seeding): the
server starts LoRA-enabled with rank + target-modules; adapters load/unload at
runtime via SGLang's `/load_lora_adapter` and `/unload_lora_adapter` endpoints.
SGLang's manifest declares the single dynamic group; the `requires_any_of` schema
remains for engines/plugins that accept the `--lora-paths` alternative. SGLang
`min_version` is `0.5.0` (the `sglang serve` CLI and enable-lora-without-paths).
See `.kiro/sglang-lora-dynamic-findings.md`.

#### Value shape: `valued` vs `boolean`, and omit-when-unset

Each capability declares a `value_type` because the two shapes are NOT
interchangeable at the engine CLI, and getting this wrong crashes servers:

- **`boolean`** — a presence-only flag. When enabled the resolver emits
  `KEY=true`, and the wrapper forwards the bare `--flag` with no argument (the
  literal `"true"` is intentionally dropped). `VLLM_ENABLE_LORA=true` →
  `--enable-lora`. Preserving this flag-only shape for the right capabilities is
  mandatory: forwarding a value where none is accepted is as broken as omitting a
  required one.
- **`valued`** — a flag that takes an argument. Emitted as `KEY=<value>` only
  when MLCC has a concrete value; **omitted entirely when unset**. This is a
  correctness fix, not a cosmetic one: emitting a defaulted-but-empty/sentinel
  value (e.g. `QUANTIZATION=none`) made engines reject startup. An absent valued
  capability is strictly safer than a present-but-empty one, so the resolver never
  emits a valued capability it cannot give a real value.

A corollary of deriving each engine's keys from its OWN manifest: a render emits
ONLY the active engine's capability keys. A vLLM deploy carries no `SGLANG_*`
key and vice versa — the previous surfaces leaked both engines' keys into every
pod, which is how a foreign-prefix flag could reach the wrong wrapper.

This set is intentionally minimal and is expected to change rarely. **Any change
to it (adding/removing an MLCC-injected capability) MUST update this ADR** —
that is the trigger to revisit the boundary.

### Tier 2 — prefix pass-through for everything else (plugin-agnostic)

Every other engine flag — `batch_size`, advanced SGLang/TRT-LLM knobs, a custom
plugin's bespoke options — is NOT enumerated by MLCC. It flows through the
existing engine-prefix pass-through: a value set under the engine's manifest
prefix (via `--server-env` / `do/config` / `ENGINE_ENV_PREFIX`) is forwarded
verbatim into the pod env, and the wrapper's generic `<PREFIX>…` → `--flag`
conversion turns it into the right flag. The K8s render surfaces (EKS ConfigMap,
HyperPod CRD) MUST use this same transparent pass-through so Tier-2 config reaches
the pod with **zero MLCC-side enumeration**.

So "let users set `batch_size`" needs **no code change**: a user sets
`SGLANG_BATCH_SIZE` (or `VLLM_...`, or `MYENGINE_...`) and it is forwarded. If a
knob later proves common enough that MLCC should compute a default for it, THAT is
the moment it graduates to Tier 1 — recorded here.

### Plugin-first invariant (the acceptance bar)

A brand-new `serve.d/<engine>/` plugin — a user's own engine with its own prefix,
its own Tier-1 capability expressions, and its own companion requirements declared
in its manifest — MUST deploy correctly to EKS and HyperPod with **zero edits to
any MLCC-owned file**: no `manifest.schema.json` capability-vocabulary change, no
render-surface `case` arm, no `parameter-schema-v2.json` entry. The schema governs
the SHAPE of a manifest's config declaration, not a closed list of allowed
capabilities. A conformance test enforces this.

## Consequences

- **Positive:** engines are true peers — built-in or user-supplied. vLLM stops
  being privileged at the config-injection layer (completing ADR-004's intent for
  the K8s surfaces). Tier-2 config is unbounded and free; the long tail of engine
  flags costs MLCC nothing. The companion-correctness rule is centralized, so no
  engine can emit a server-crashing bare flag.
- **Cost:** the EKS ConfigMap, HyperPod CRD, deploy drivers, and both readers must
  derive Tier-1 names from the manifest; the schema `serverMapping` stops pinning
  `VLLM_`. vLLM renders must stay byte-identical (its suffixes equal today's
  hardcoded names by construction) — verified by render tests.
- **Risk / boundary erosion:** the Tier-1 set is a judgment call. The guardrail is
  procedural: this ADR is the registry of what MLCC injects, and the "update this
  ADR" rule on Tier-1 changes is the review gate that keeps the set from quietly
  growing back toward a vLLM-shaped everything-enumerated design.

## References

- ADR-004 — serve-engine plugin parity (manifest = single source of truth; no
  hidden first-class engine). This ADR applies that principle to K8s config
  injection.
- ADR-008 — deployment-target descriptor (derive-don't-hardcode precedent).
- ADR-009 — serve-engine capability versioning.
- `.kiro/k8s-engine-config-findings.md` — the investigation + per-capability ×
  per-engine evidence.
- `.kiro/specs/bl-engine-aware-k8s-config/` — the implementing spec.
- `src/lib/engine-prefix-resolver.js`, `serveEngineRuntimeVarsUnion` — the
  existing prefix pass-through this ADR builds on.
