<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-011: Per-Technique Tune Descriptor (single source of truth)

## Status

Accepted — implemented (v2.0, BL129, spec `v2-w3-01-bl129`).

**Implementation summary (what shipped).** One descriptor per managed-customization
technique at `templates/code/tune.d/<technique>/manifest.json`, validated by
`manifest.schema.json` (JSON Schema draft 2020-12, `additionalProperties:false`) and the
discovery validator `scripts/validate-tune-manifests.js` (wired into `npm run
validate:tune-manifests`, a CI step, and a husky pre-commit guard). Twin readers mirror
the serve-engine precedent: `src/lib/tune-manifest-reader.js` (Node, generation-time) and
`templates/do/lib/python/tune_manifest.py` (Python, runtime + one-shot CLI). The descriptor
has two provenance-tagged layers:

- **STRUCTURAL** (hand-authored, conformance-tested): `reward_source`; per-PEFT-variant
  `peft`, `artifact_kind` (schema-enforced derivation from `peft`), and `dataset_contract`.
- **SYNCED** (written by `scripts/sync-model-families.js`, never hand-edited): per-variant
  `hyperparameters` + `_synced` per-backend provenance, populated from each recipe's
  `SmtjOverrideParamsS3Uri` override-params object in the SAME Hub traversal that writes
  `config/tune-catalog.json`.

The managed-RL dataset contract rides on the descriptor: the register-side **Producer**
(`tune_producer_rl.py`, via `tune_stage_hf.py`) emits verl's 5-field parquet against the
descriptor's `dataset_contract`, and the `do/tune` **Gate** validates a dataset's format +
required fields against the same contract before provisioning GPUs. The wrong RL guess in
`sync-model-families.getDefaultDatasetSchema()` (`{prompt: array}`) was removed (scoped —
sft/dpo keep their jsonl schema).

## Context

`do/tune` exposes five managed techniques (`sft, dpo, rlvr, rlaif, mtrl`). Each technique's
knowledge — its hyperparameter knobs (and their ranges/enums/widgets/tiers), its reward
kind, its PEFT variants, and the dataset shape its managed trainer requires — was either
hardcoded, scattered, or simply wrong:

- the `do/tune` flag/prompt surface was flat and technique-agnostic (a user tuning RLAIF
  saw knobs that didn't apply and none that did);
- the register-side staging typed the RL `prompt` as a flat string and auto-flattened a
  message list, the OPPOSITE of what verl's `RLHFDataset` wants (a live RLAIF job failure);
- `sync-model-families.getDefaultDatasetSchema()` returned a VERIFIED-WRONG `{prompt:array}`
  for rlvr/rlaif/mtrl — the dataset contract is MLCC structural knowledge, not an API-synced
  guess;
- there was no single place that said "for THIS technique: these knobs, this reward kind,
  this dataset shape" — so the config UI, the producer, and the preflight could each
  disagree, which is exactly the class of failure that produced four sequential ~12-minute
  GPU failures while debugging a live managed-RL dataset.

### The precedent to mirror

The serve-engine manifest system (ADR-004) and the deployment-target descriptor (ADR-008)
already solve this shape: one declarative descriptor per unit, a JSON schema, a
discovery-based CI validator, and twin Node/Python readers — "derive, don't hardcode." A
tuning technique is the same shape in a different domain.

### What is NEW versus serve.d / targets.d

A tuning technique's knob set is not static repo knowledge — AWS publishes it, per recipe,
as a complete UI-ready override-params object in S3 (per knob: default, min/max/step, enum,
control_type, visibility_tier, category, display_name/description/hint). So the tune
descriptor is the first to carry a **SYNCED** layer fed from an external authority, on top
of the hand-authored structural layer. This is the key design difference and the reason for
the two-layer, provenance-tagged model.

## Decision

Make **one descriptor per technique the single source of truth** for the per-technique
contract, with a two-layer model:

1. **STRUCTURAL** fields are hand-authored and conformance-tested (the API does not carry
   them): `reward_source` (drives `reward_model_style`), `peft`→`artifact_kind` (schema
   if/then enforced), and `dataset_contract` (`format`, `schema`, `prompt_shape`,
   `reward_model_style` for verl-5field only, `verified`).
2. **SYNCED** fields are written by `sync-model-families` from the recipe override-params,
   never hand-edited: `hyperparameters` (filtered to real knobs — `category:hyperparameter`
   for the tagged flavor, a plumbing denylist for the leaner MTRL flavor) and `_synced`
   per-backend provenance (`smtj` always; `hp-eks` only when the recipe has it — MTRL is
   SMTJ-only). The sync is additive (preserves structural fields) and idempotent (a re-run
   with an unchanged version is a no-op); a fetch failure never regresses a good descriptor.

Every consumer derives from the descriptor: the `do/tune` config builder (BL128), the
register-side Producer, and the `do/tune` Gate. The technique SET derives from
`KNOWN_TECHNIQUES` (`src/lib/managed-techniques.js`), enforced by a conformance test that
asserts the `tune.d/*` directory set equals it.

### Why the descriptor permits an empty synced layer

A pre-sync, hand-authored descriptor validates with `hyperparameters: {}` / `_synced: {}`
(the schema cannot distinguish pre- from post-sync). The "a synced descriptor carries at
least `smtj`" invariant is asserted by the conformance test, not the schema.

### The managed-RL dataset contract (Producer + Gate)

For the verl techniques (rlvr/rlaif) the `dataset_contract` drives both ends so they cannot
disagree: `do/register dataset --technique rlvr|rlaif` produces verl 5-field parquet
(message-list prompt, nested `reward_model` struct with the descriptor-derived `style`),
written to a channel-pure `datasets/<name>/data/` subprefix so the `_dataset.json` sidecar
is not in the training channel; the `do/tune` preflight reads the same contract's required
fields and fails fast on a violation. MTRL's contract is `verified:false` (its rollout row
shape is not fabricated), so it is format-checked only.

## Options considered

- **A — hardcode per technique (status quo).** Rejected: this is the scatter the live
  managed-RL debugging exposed; the config UI, producer, and preflight drift.
- **B — descriptor as SoT, two readers, synced + structural layers (chosen).** Mirrors
  ADR-004/ADR-008; adds the synced layer for the AWS-published knob metadata.
- **C — sync into the existing `tune-catalog.json` instead of a new descriptor.** Rejected:
  the catalog is a MODEL index (which models, which techniques); the per-technique knob/
  dataset contract is a different axis, and overloading the catalog would entangle the two
  sync outputs and the two schemas. Keeping `tune.d/` separate lets the one traversal emit
  two clean outputs.

## Consequences

- **Positive:** adding or changing a technique is "edit one descriptor (structural) + run
  the sync (synced)"; the config UI, producer, and preflight cannot disagree by
  construction; the wrong RL dataset guess is gone; MTRL ships configurable + discoverable
  without being runnable; `artifact_kind` is declared for the later three-way deploy split
  (BL136/BL137/BL149) without being prematurely propagated.
- **Reusability (shipped):** the `do/tune` config builder reads the descriptor's
  `$defs/hyperparameter` entry shape through a descriptor-source-AGNOSTIC core
  (`tune_config_builder.build_config`) with a thin `tune.d` adapter, so the user-authored
  `do/train` plugin UX (BL154) can reuse the same core rather than forking — ADR-008's
  one-derivation-many-consumers applied one level up, with a user-authored (untrusted,
  runtime-validated) descriptor source. See the Config UX section in
  `docs/architecture/tune-descriptor.md`.
- **Cost:** a new descriptor format + schema + validator + two readers + the sync extension
  + the Producer/Gate; a new dev dependency (`@aws-sdk/client-s3`) for the override-params
  fetch (maintainer-side only, in `devDependencies`).
- **Risk:** low — the tune descriptor is new generator/catalog surface, not on the deploy/
  teardown hot path; the sync's override-params fetch is injectable so the default test gate
  is fully offline, with an opt-in live reachability smoke test.

## References

- ADR-004 — serve-engine plugin parity (the manifest precedent this mirrors)
- ADR-008 — deployment-target descriptor (the second descriptor precedent)
- `docs/architecture/tune-descriptor.md` — the subsystem explainer (contract, sync, readers,
  Producer/Gate, authoring)
- `docs/fine-tuning.md` — the user-facing managed-RL dataset format + technique guide
- `.kiro/specs/v2-w3-01-bl129/` — requirements / design / tasks
- `.kiro/v2-w3-tune-descriptor-design.md` — the settled pre-spec design + live API probe
