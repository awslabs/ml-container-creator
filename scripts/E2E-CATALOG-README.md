# E2E Catalog Sync Requirement

## Adding a New Golden-Path Model

When adding a new model to the E2E golden-path validation, you must update **both** catalogs:

1. **`scripts/e2e-catalog.json`** — Add an entry with `tuneConfig` specifying the tuneId, technique, trainingType, and dataset
2. **`config/tune-catalog.json`** — Add a model entry with the same tuneId, supported techniques, and training types

The E2E runner reads tuning metadata from `e2e-catalog.json` only. The `do/tune --list-models` command reads from `config/tune-catalog.json` only. Both must be kept in sync manually.

## Validation

After updating either catalog, run the validator to confirm consistency:

```bash
node scripts/validate-catalogs.js
```

The validator cross-references `tuneConfig.tuneId`, `technique`, and `trainingType` against `config/tune-catalog.json` and reports mismatches.

## Quick Reference

| File | Consumer | Purpose |
|------|----------|---------|
| `scripts/e2e-catalog.json` | `scripts/e2e-runner.js` | E2E lifecycle execution (22 golden-path models) |
| `config/tune-catalog.json` | `do/tune --list-models` | User-facing model listing and tune validation |

For full details, see [docs/dev/catalog-relationship.md](../docs/dev/catalog-relationship.md).
