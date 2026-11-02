<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-013: Additive-Deploy is Artifact-Kind-Driven and Target-Uniform

## Status

Accepted (v2.0, Wave 6). States the contract the additive-deploy verbs (`do/adapter`, `do/add-ic`, and the
future `do/add-pod`) SHALL converge on. Implemented incrementally by the framing epic (BL170) over BL164,
BL169, BL149; depends on BL164's `artifact_kind` recording. This ADR is the source of truth those items
derive from.

**Wave 6 implementation (accepted).** Axes 1–3 are implemented for `do/adapter` (SMAI and Kubernetes
paths) and `do/add-ic`, all in `templates/do/lib/script-contract.sh`:

- **Axis 1 (source):** one shared resolver, `_resolve_additive_source`, for `--from-weights` /
  `--from-tune` / `--from-train` / `--from-registry` / `--from-hub`, target-uniform. It shells out to the
  existing helpers (`.register_helper.py get-version`, `_download_from_hub`) rather than reimplementing
  them. `--weights` (`do/adapter`) and `--model-data` (`do/add-ic`, `ic_update.py`) remain as deprecated
  aliases of `--from-weights`; `do/register --model-data-url` is unrelated and unchanged.
- **Axis 2 (kind):** `_guard_artifact_kind` reads each verb's accepted kinds from the declared contract
  (`_additive_verb_kinds`); unknown kinds degrade to an advisory content check.
- **Axis 3 (target → mechanism):** `_additive_verb_mechanisms` ∩ `_additive_target_mechanisms`; the legal
  verb×target matrix is derived by `_additive_verb_supported_on`, never hand-listed. `do/adapter
  --from-tune` (and every other source) now hot-loads onto `hyperpod-eks`/`eks` (BL169).
- The contract is expressed as bash-3.2-safe `case` lookup functions (no `declare -A`), because every
  do/ script sources `script-contract.sh` under macOS's stock `/bin/bash` 3.2. Drift is guarded by
  `test/unit/additive-deploy-contract.test.js` (derivation ↔ target descriptors ↔ script headers ↔ the
  real scripts' behavior).

**Deferred:** the axis-3 `pod-apply` mechanism — `do/add-pod` (BL149), `full_model` on
`{hyperpod-eks, eks}` — is deferred to the cluster cohort. Its contract arms are present but commented;
until it lands, a full model on a cluster is refused honestly ("not servable on this target yet") with a
pointer to `realtime-inference` + `do/add-ic`. `do/add-ic --from-registry` landed as part of Wave 6
(it was a stretch item).

## Context

MLCC has (and will have) three "additive" deploy verbs — ways to put a model/adapter onto an
ALREADY-deployed endpoint/cluster, as opposed to `do/deploy` which stands the serving substrate up:

- **`do/adapter`** — hot-load a LoRA adapter.
- **`do/add-ic`** — add a full model as a SageMaker Inference Component.
- **`do/add-pod`** — (deferred, BL149) add a full model as a pod on a HyperPod/EKS cluster.

Each should answer the same two questions the same way: **(1) where does the artifact come from?**
and **(2) is this artifact the right KIND for this verb?** Today they answer inconsistently, and the
inconsistency is scattered across per-script `case` arms (the class of drift ADR-006/007/008 exist
to prevent):

- **Divergent source verbs.** `do/adapter` accepts `--weights` / `--from-hub` / `--from-tune` /
  `--from-train` / `--from-registry` but REFUSES the source verbs on Kubernetes targets
  (`do/adapter:76-85`, the "SMAI-only" `_contract_violation`). `do/add-ic` accepts only
  `--from-tune` / `--model-data` — no `--from-registry` / `--from-hub` at all (`do/add-ic:88-140`).
- **Divergent target lists.** `do/adapter` → `realtime-inference, hyperpod-eks, eks`
  (`do/adapter:11`); `do/add-ic` → `realtime-inference` only (`do/add-ic:11`).
- **Half-wired kind enforcement.** Nothing reliably checks that a `--from-tune` output is the right
  KIND for the verb: a full-model tune output can slip into `do/adapter` (the adapter guard keys off
  one config string on one branch — BL164 investigation claim (c)), and the registry path checks
  nothing. `artifact_kind` is declared on the tune descriptor but recorded nowhere (BL164).

The root issue: **source-resolution** (turn `--from-tune`/`--from-registry`/`--from-hub` into an S3
URI) is conflated with **target-specific loading** (IC plumbing vs vLLM hot-load vs pod apply).
Resolution is target-agnostic — `--from-tune` is just a `do/config` var read; `--from-registry` is a
model-package lookup — but the scripts treat the source verbs as if they were target-coupled.

## Decision

**Additive deploy is governed by one contract: the SOURCE verb resolves an artifact uniformly across
every target; the ARTIFACT_KIND selects which verb is legal; the TARGET selects only the load
mechanism.**

Three orthogonal axes, each owned by one concern — no axis leaks into another:

1. **Source (where the artifact comes from) — target-uniform, and an OPEN `--from-*` family.** Every
   source is a `--from-<x>` verb that resolves to an artifact reference (S3 URI + metadata) by the
   SAME logic regardless of target. The family is EXTENSIBLE BY CONVENTION: adding a source = adding
   one `--from-x` resolver, never a new special case. Current members:
   `--from-weights` (a raw S3 URI — the renamed `--weights`/`--model-data`), `--from-tune`,
   `--from-train`, `--from-registry`, `--from-hub`. A source verb SHALL NOT be refused merely
   because of the deployment target. (`--from-tune` reads `TUNE_*` config vars; `--from-registry`
   reads the model package; neither is target-specific.) NAMING: all source verbs are `--from-*`
   (so `--weights`/`--model-data` are renamed to `--from-weights`; the old names MAY remain as
   deprecated aliases during transition). A resolver returns a uniform `{uri, artifact_kind?,
   metadata}` so the kind gate (axis 2) and the loader (axis 3) consume one shape.

2. **Artifact kind (what the artifact IS) — the gate, an OPEN set.** Every resolvable artifact
   carries an `artifact_kind`, recorded on the registered version (BL164) or derived from the tune
   descriptor / `TUNE_OUTPUT_TYPE_LATEST`. Current kinds: `lora_adapter`, `full_model`; the set is
   EXTENSIBLE (a future kind — e.g. a merged-weights delta, a quantized variant — is added to the
   descriptor's enum, not hardcoded per script). Each additive verb declares the kind(s) it accepts
   and REFUSES the rest with guidance to the correct verb:
   - `do/adapter` accepts `lora_adapter`; refuses `full_model` → "use `do/add-ic` / `do/add-pod`".
   - `do/add-ic` / `do/add-pod` accept `full_model`; refuse `lora_adapter` → "use `do/adapter`".

3. **Target → load MECHANISM — an OPEN, pluggable set (not an enumeration).** The target selects a
   load mechanism and that is the ONLY thing the target changes. The mechanism is a PLUG-POINT, not
   a fixed list: today's mechanisms are SMAI Inference Component (realtime-inference), vLLM LoRA
   hot-load and k8s pod apply (hyperpod-eks / eks); the contract SHALL accommodate future mechanisms
   WITHOUT a rewrite — e.g. an SGLang LoRA hot-apply, or a non-pod target such as ECS (container
   task, no k8s pod). A verb's legal target set is DERIVED from "which targets expose a load
   mechanism for this verb's artifact_kind", not a hand-listed per-verb constant. Adding a target or
   a mechanism = registering it against the contract, not editing every additive script.

Derive, don't hardcode: the per-verb `(accepted artifact_kind, supported load mechanisms)` and each
target's `(available load mechanisms)` SHOULD be a declared contract (a descriptor or a single
shared table — the legal verb×target matrix is DERIVED from the intersection, not hand-maintained),
mirroring ADR-008's deployment-target descriptor — NOT a `case` arm per script. The `--from-*`
source-resolution logic SHOULD be one shared, extensible resolver the verbs call, not per-script
copies.

## Consequences

- **Positive:** `do/adapter --from-tune` works on hyperpod-eks/eks (BL169); `do/add-ic` can gain
  `--from-registry`; adding `do/add-pod` (BL149) is "declare its kind/targets/mechanism", not a
  rewrite. A full model can never be silently hot-loaded as an adapter (the kind gate). One mental
  model for users across every additive verb and target.
- **Extensible by design:** a new SOURCE is one `--from-x` resolver; a new ARTIFACT_KIND is an enum
  entry on the descriptor; a new LOAD MECHANISM (SGLang hot-apply, an ECS no-pod target, …) is a
  registered plug-point — none require touching the additive scripts or the contract itself. The
  verb×target legality is derived from the kind×mechanism intersection, so the matrix stays correct
  as the catalog grows.
- **Naming:** `--weights` / `--model-data` are renamed to `--from-weights` so every source is a
  uniform `--from-*` verb (old flags kept as deprecated aliases during transition).
- **Cost:** a shared source-resolver + a declared per-verb contract; migrating three scripts'
  scattered guards onto it. Bounded by landing BL164's `artifact_kind` recording first.
- **Risk:** the kind gate must degrade safely for legacy artifacts with no recorded `artifact_kind`
  (fall back to the local output-type / `adapter_config.json` check, don't hard-block a legitimate
  legacy artifact).

## Relationship to Wave 5 (examined — must not undermine this future state)

Wave 5 (BL163/BL164/BL166/BL167) is NOT part of this epic, but it must not foreclose it. Examined:

- **BL164 ENABLES this** — it records `artifact_kind` on the registered version and builds the
  adapter deploy guard; ADR-013 generalizes that guard to all additive verbs + targets. BL164's
  kind-aware registration identity (full model = standalone; adapter = linked to base) is exactly
  the `artifact_kind` axis this ADR needs. **Alignment: supportive, no conflict.**
- **BL169** is the first concrete application (adapter `--from-tune` on k8s); it is `blocked_by`
  BL164 and is a natural member of this epic.
- **Risk to watch:** BL164's artifact-kind guard (R3/R4) SHALL be built as a REUSABLE check
  (shared helper), not a `do/adapter`-local arm — otherwise ADR-013 has to re-extract it. Recorded
  as a constraint on BL164's design so Wave 5 does not undermine the epic.

## Amendment (Wave 11, BL149): `do/add-pod` enabled on hyperpod-eks

The deferred `(full_model, {hyperpod-eks, eks}, pod-apply)` tuple landed for **hyperpod-eks
only**: `_additive_verbs` = `adapter add-ic add-pod`; `add-pod` accepts `full_model` and drives
`pod-apply`; hyperpod-eks exposes `vllm-hotload pod-apply`. Plain `eks` keeps `vllm-hotload` only
(plain-eks add-pod is F6, post-2.0), and `_additive_deferred_note full_model` now says so. The
descriptors declare `verbs.add-pod` (true on hyperpod-eks only), drift-tested against the derived
legality in `test/unit/additive-deploy-contract.test.js`. The hand-written refusal literals in
`do/adapter` are replaced by `_additive_kind_guidance <kind> <target>`, derived from the same
block, so the guidance follows the tuple (risk R7).

## References

- ADR-008 — deployment-target descriptor (the derive-don't-hardcode precedent for targets).
- ADR-011 — tune-technique descriptor (`artifact_kind` is declared here, schema-enforced from peft).
- `.kiro/specs/v2-w5-02-bl164/` — artifact_kind recording + adapter guard (the enabler).
- Backlog: BL169 (adapter source verbs on k8s), BL149 (`do/add-pod` + three-way split),
  the additive-deploy framing epic (this ADR's execution plan).
