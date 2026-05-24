# E2E Catalog and Tune Catalog Relationship

This document explains the relationship between `scripts/e2e-catalog.json` and `config/tune-catalog.json`, their respective consumers, and the manual sync requirement between them.

## Overview

The project maintains two catalog files that contain tuning metadata:

| File | Purpose | Primary Consumer |
|------|---------|-----------------|
| `scripts/e2e-catalog.json` | E2E validation configurations (22 golden-path models) | `scripts/e2e-runner.js` |
| `config/tune-catalog.json` | Tuning model registry (model IDs, techniques, dataset schemas) | `do/tune --list-models` |

These catalogs overlap in responsibility: both describe which models support which tuning techniques. The E2E catalog embeds a subset of tune-catalog metadata directly in each entry's `tuneConfig` field so the runner can operate without reading a second file at runtime.

## How `tuneConfig` Fields Are Derived

Each entry in `e2e-catalog.json` includes a `tuneConfig` object:

```json
{
    "id": "rt-qwen3-4b",
    "tuneConfig": {
        "tuneId": "qwen3-4b",
        "technique": "sft",
        "trainingType": "lora",
        "dataset": "s3://mlcc-e2e-datasets/sft-small/train.jsonl"
    }
}
```

These fields are derived from `config/tune-catalog.json`:

| `tuneConfig` field | Source in `tune-catalog.json` |
|--------------------|-------------------------------|
| `tuneId` | Key in `models` object (e.g., `"qwen3-4b"`) |
| `technique` | Key in `models[tuneId].techniques` (e.g., `"sft"`) |
| `trainingType` | Value in `models[tuneId].techniques[technique].trainingTypes` array |
| `dataset` | Not in tune-catalog — specified per-tier in the E2E catalog |

The `tuneConfig` values must be kept in sync with `tune-catalog.json` manually. There is no automated sync mechanism.

## Runtime Behavior

### E2E Runner (`scripts/e2e-runner.js`)

The E2E runner reads tuning metadata **exclusively** from the `tuneConfig` field in `e2e-catalog.json`. It does **not** read `config/tune-catalog.json` at runtime.

When the runner encounters a `tune-sft` lifecycle step, it constructs the tune command from the catalog entry:

```
tune-sft → ./do/tune --technique sft --dataset <tuneConfig.dataset> --training-type <tuneConfig.trainingType>
```

This design means:
- The runner has a single source of truth (the E2E catalog)
- No cross-file reads at runtime
- Faster startup — no need to load and cross-reference a second catalog
- The catalog validator catches mismatches at validation time, not at runtime

### `do/tune --list-models`

The `do/tune --list-models` command continues to read from `config/tune-catalog.json` for its model listing. This behavior is unchanged. The tune command uses the tune-catalog for:

- Listing available models and their supported techniques
- Validating user-provided model IDs and technique combinations
- Looking up dataset format schemas for validation

The tune command does **not** read `e2e-catalog.json`.

## Validation Cross-Reference

The catalog validator (`src/lib/e2e-catalog-validator.js`) performs a cross-reference check at validation time:

1. Reads `config/tune-catalog.json`
2. For each E2E catalog entry with a `tuneConfig`:
   - Verifies `tuneId` exists in the tune-catalog
   - Verifies the specified `technique` is supported for that model
   - Verifies the specified `trainingType` is supported for that model/technique combination

This is a "soft" validation — if `tune-catalog.json` is unreadable, cross-reference checks are skipped silently. Run `node scripts/validate-catalogs.js` to execute these checks.

## Sync Requirement

When adding a new golden-path model or updating tuning support:

1. **Add/update the tune-catalog entry** in `config/tune-catalog.json` — this is the reference catalog for `do/tune --list-models`
2. **Add/update the E2E catalog entry** in `scripts/e2e-catalog.json` — include the `tuneConfig` object with values matching the tune-catalog
3. **Run the validator** to confirm the cross-reference passes: `node scripts/validate-catalogs.js`

If the catalogs drift out of sync, the validator will report errors like:

```
entry "rt-new-model": tuneId "new-model-id" not found in tune-catalog
entry "rt-new-model": technique "sft" not supported for model "new-model-id"
```

## Why Two Catalogs?

The tune-catalog serves a broader purpose than E2E testing — it's the user-facing registry for `do/tune --list-models` and contains metadata (dataset schemas, display names, provider info) that the E2E runner doesn't need. Merging them fully would couple the user-facing tune command to E2E test infrastructure.

The E2E catalog embeds only the subset of tune metadata needed to construct tune commands, keeping the runner self-contained while the tune-catalog remains the authoritative reference for the tune CLI.
