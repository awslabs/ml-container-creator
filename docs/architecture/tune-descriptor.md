<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Per-Technique Tune Descriptor (`tune.d/`)

The **tune descriptor** is the single declarative source of truth for a managed
customization technique's reward kind, PEFT variants, dataset contract, and
hyperparameter knobs. It is the tuning analogue of the serve-engine plugin manifest
(`serve.d/<engine>/manifest.json`, see [serve-engine-plugins.md](serve-engine-plugins.md))
and follows the same ADR-008 principle: **derive, don't hardcode.** Every consumer —
the `do/tune` config UX (BL128), the register-side dataset producer, and the `do/tune`
preflight — reads the descriptor so they cannot drift out of agreement.

Introduced in BL129 (`.kiro/specs/v2-w3-01-bl129`); the decision record is
[ADR-011](../adr/ADR-011-tune-technique-descriptor.md). The settled design rationale +
the live SageMaker JumpStart API probe findings are in
`.kiro/v2-w3-tune-descriptor-design.md`.

## Where it lives

```
templates/code/tune.d/
  manifest.schema.json              # JSON Schema (draft 2020-12), additionalProperties:false
  sft/manifest.json
  dpo/manifest.json
  rlvr/manifest.json
  rlaif/manifest.json
  mtrl/manifest.json
```

The technique set is NOT a hardcoded list — it derives from `KNOWN_TECHNIQUES`
(`src/lib/managed-techniques.js`). A conformance test asserts the set of `tune.d/*`
directories equals `KNOWN_TECHNIQUES`, so no known technique can ship descriptor-less
and no orphan directory can linger.

## Two provenance-tagged layers

A descriptor has a **STRUCTURAL** layer (hand-authored, conformance-tested — the API
does not carry it) and a **SYNCED** layer (written by `scripts/sync-model-families.js`
from AWS's recipe override-params — never hand-edited).

```jsonc
{
  "technique": "rlaif",                 // STRUCTURAL — matches the dir name
  "reward_source": "judge",             // STRUCTURAL — none|rule|preset|judge|agent_env
  "variants": {
    "lora": {
      "peft": "lora",                   // STRUCTURAL
      "artifact_kind": "lora_adapter",  // STRUCTURAL — DERIVED from peft (schema-enforced)
      "dataset_contract": {             // STRUCTURAL
        "format": "parquet",
        "schema": "verl-5field",
        "prompt_shape": "message-list",
        "reward_model_style": "model",  // verl-5field ONLY (if/then in the schema)
        "verified": true
      },
      "hyperparameters": { /* SYNCED */ },
      "_synced": { "smtj": { "from": "s3://…_v2.2.7.json", "version": "2.2.7" } }
    }
  }
}
```

### STRUCTURAL fields

| Field | Meaning |
|---|---|
| `reward_source` | `none` (sft) · `preset` (dpo) · `rule` (rlvr) · `judge` (rlaif) · `agent_env` (mtrl). Drives `reward_model_style` (rule/preset→`rule`, judge→`model`). |
| `peft` | `lora` or `none` per variant. |
| `artifact_kind` | `lora_adapter` or `full_model`, **derived from `peft`** and schema-enforced (`lora→lora_adapter`, `none→full_model`). Declared here for the later three-way deploy split (BL136/BL137/BL149); BL129 only DECLARES it. |
| `dataset_contract` | The required training-data shape — `format` (jsonl\|parquet), `schema`, `prompt_shape` (string\|message-list), `verified`, and `reward_model_style` (verl-5field only). |

### SYNCED fields

`hyperparameters` is a per-knob map; `_synced` is a per-backend provenance map
(`smtj` / `hp-eks`). Each knob entry always carries `type` and `required`, a `default`
when the source has one, and `min`/`max`/`step`/`enum`/`control`/`tier`/`display_name`/
`description`/`hint` where present. Canonical key names: `control` (from the AWS
override-param `control_type`) and `tier` (from `visibility_tier`).

Both synced blocks are `{}` in a pre-sync, hand-authored descriptor. The schema permits
that; the conformance test asserts the post-sync invariant (a synced descriptor carries
at least `smtj`).

## The sync (`scripts/sync-model-families.js`)

One Hub traversal, two outputs: the same `RecipeCollection` walk that writes
`config/tune-catalog.json` also populates each descriptor's synced layer. Per recipe,
for its SMTJ override-params object:

1. **Fetch** the override-params JSON (injectable `fetchOverrideParams`; default S3
   GetObject). The fetch is network-dependent — the unit tests inject an offline
   fetcher, and a live reachability smoke test is opt-in
   (`MLCC_LIVE_OVERRIDE_PARAMS=1`), not in the default gate.
2. **Filter knobs.** Two flavors:
   - **TAGGED** (sft/dpo/rlvr/rlaif): keep `category: hyperparameter`.
   - **LEANER MTRL** (no `category`): keep everything NOT in the plumbing DENYLIST
     (`data_path`, `model_name_or_path`, `output_path`, `name`). A drift test guards
     the denylist so a new plumbing key can't silently become a surfaced knob.
3. **Map** to the canonical entry shape (`control_type`→`control`,
   `visibility_tier`→`tier`, default `required:false`).
4. **Record** only the backends that exist — MTRL has `HpEksOverrideParamsS3Uri: None`,
   so its `_synced` has `smtj` only.
5. **Additive-merge**, preserving the structural layer; **idempotent** (a re-run with an
   unchanged `version` is a no-op). A fetch failure leaves the existing synced layer
   intact — it never regresses a good descriptor.

## The managed-RL dataset contract (Producer + Gate)

For the verl-based RL techniques (rlvr/rlaif) the descriptor's `dataset_contract`
drives both ends of the round trip:

- **Producer** (`templates/do/lib/python/tune_producer_rl.py`, invoked from
  `tune_stage_hf.py`): `do/register dataset --technique rlvr|rlaif` emits **parquet** in
  verl's 5-field row schema — `data_source`, `prompt` as a chat **message list** (NOT a
  flattened string), `ability`, `reward_model` struct `{style, ground_truth}`,
  `extra_info`. `reward_model.style` is read from the descriptor (rlvr→`rule`,
  rlaif→`model`), never hardcoded. A flat top-level `ground_truth` column is lifted into
  the nested struct (a transform a bare `--column-map` cannot do). The produced parquet
  is asserted conformant at stage time, so a mismatch fails at registration rather than
  deep in a GPU job. The parquet is written to a channel-pure `datasets/<name>/data/`
  subprefix so the `_dataset.json` sidecar is NOT in the training channel.
- **Gate** (`do/tune` preflight + `tune_manifest.py`): the format half (parquet-required,
  sidecar-excluded) plus the field-schema half — it reads `required_dataset_fields` from
  the descriptor and fails fast naming a missing verl field. A technique whose contract
  is `verified:false` (mtrl-rollout) is format-checked only.

## MTRL

MTRL ships REAL in Wave 3: `reward_source: agent_env`, synced hyperparameters
(SMTJ-only — `HpEksOverrideParamsS3Uri` is `None`), and an honest `dataset_contract`
marked `schema: "mtrl-rollout"` / `verified: false` (its rollout row shape is NOT
fabricated). This makes MTRL configurable + discoverable; RUNNING an MTRL job end-to-end
is deferred (BL139).

## Readers

| Side | Reader | Used by |
|---|---|---|
| Node (generation-time) | `src/lib/tune-manifest-reader.js` | the `do/tune` config builder (BL128), the generator |
| Python (runtime) | `templates/do/lib/python/tune_manifest.py` | the `do/tune` dataset preflight (Gate), the Producer |

Both read the same `tune.d/` files; neither branches on the technique name.

## Config UX — technique-aware `do/tune` (BL128)

`do/tune`'s hyperparameter surface is driven by the descriptor's synced `hyperparameters`
block: the user is offered exactly the selected technique's knobs — with their defaults,
ranges, choice-lists, input widgets, and progressive-disclosure tiers — instead of a fixed
flag set. Shipped in BL128 (`.kiro/specs/v2-w3-02-bl128`).

**Descriptor-source-agnostic core.** `templates/do/lib/python/tune_config_builder.py` has a
core `build_config(hyperparameters, supplied, *, interactive, include_advanced, prompter)`
that takes a `hyperparameters` map + supplied values and returns `{resolved, errors}`. It
knows nothing about `tune.d/`, technique names, `_synced`, or `reward_source` — only the
shared `$defs/hyperparameter` entry shape. A thin `build_from_tune_descriptor` adapter (same
module) is the ONLY `tune.d`-aware entry; it reads `tune_manifest.read_hyperparameters` and
calls the core. This is deliberate: the user-authored `do/train` plugin UX (BL154) supplies
its own descriptor source (with its own runtime validation / trust boundary) and reuses the
same core instead of forking it.

**What the core does** (each a BL128 requirement): derives an effective `control`/`tier` for a
knob that omits them (MTRL's leaner schema — `enum`→dropdown, numeric→number_input, else
text_input; default tier `primary`); progressive disclosure (prompt `primary` always,
`advanced` only on opt-in, never `tertiary`); validates every value against
`type`/`min`/`max`/`step`/`enum`/`required`; and resolves precedence
`descriptor default < config file < interactive answer / flag` (user value wins).

**Surfaces** (all three derive from the descriptor — a drift test asserts they agree):

- **Interactive** — `do/tune` prompts via `questionary` (modeled on `deploy_prompts.py`):
  `dropdown`→`questionary.select` over the `enum`, numeric/text→`questionary.text` pre-filled
  with the default. Wired in the `.tune_helper.py build-config` subcommand.
- **Flags** — `--set KNOB=VALUE` (repeatable), keyed by the descriptor's canonical knob name;
  a knob the technique does not declare is rejected naming the valid set. The five legacy
  flags (`--epochs`/`--learning-rate`/`--max-seq-length`/`--lora-rank`/`--batch-size`) remain
  as validated aliases onto the same map. `--advanced` opts into the advanced tier;
  `--non-interactive` (or no TTY) applies defaults with the same validation.
- **Submission** — the resolved `{knob: value}` map flows to `.tune_helper.py submit` as a
  single `--hyperparameters <json>` blob that `tune_submit.py` merges into the trainer's
  hyperparameters (the canonical knob names match the SDK option names by construction, so no
  translation table — the old hand-maintained per-flag map was removed).

All validation happens in sub-second preflight (unknown knob, out-of-range value, required
knob with no value) — before the SageMaker job is submitted.

## Validation

`scripts/validate-tune-manifests.js` (mirrors `validate-serve-manifests.js`) discovers
every `tune.d/<technique>/manifest.json`, validates each against the schema, and
cross-checks the `technique` field against the directory name. It runs as:

- `npm run validate:tune-manifests`
- a blocking CI step (`.github/workflows/ci.yml`)
- a pre-commit guard (husky) when a `tune.d/` file is staged

## Adding / changing a technique

1. Add the technique to `KNOWN_TECHNIQUES` (`src/lib/managed-techniques.js`).
2. Create `templates/code/tune.d/<technique>/manifest.json` with the STRUCTURAL layer
   (leave `hyperparameters` / `_synced` as `{}`).
3. Run `npm run validate:tune-manifests` and the conformance test
   (`test/unit/tune-manifest-conformance.test.js`).
4. Run `sync-model-families` to populate the synced layer (or let the next scheduled
   sync do it).

Never hand-edit the `hyperparameters` / `_synced` blocks — they are sync-owned.
