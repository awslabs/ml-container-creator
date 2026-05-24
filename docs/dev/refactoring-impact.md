# Refactoring Impact — Schema-Driven Architecture

> Tracking document for the v0.9.0 release notes. Quantifies the structural improvements made to ML Container Creator's codebase for maintainability, extensibility, and AI-assisted development.

## Summary

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Largest source file | 2,650 lines (prompt-runner.js) | 1,169 lines (prompt-runner.js) | -56% |
| CLI option definitions | 68 hand-written .addOption() calls | 7-line loop + generated file | -98% boilerplate |
| Validation rules | Hardcoded switch statement (140 lines) | 43 auto-generated from schema | Schema-driven |
| Parameter matrix | 726-line hand-written method | Generated from schema (7-line method) | -99% |
| config-manager.js | 2,496 lines | 858 lines | -66% |
| Template max file size | 1,766 lines (deploy) | 726 lines (managed-inference.ejs) | -59% |
| EJS conditionals in deploy | 54 | 0 in dispatcher, ~10 per target file | -80% per file |
| EJS conditionals in serve | 17 | 3 (dispatcher only) | -82% |
| Parameter sources of truth | 7 independent locations | 1 (parameter-schema-v2.json) | Single source |
| Time to add a new CLI parameter | Touch 7 files | Edit 1 file + `npm run codegen` | -86% effort |
| CI drift detection | None | 4-layer (schema → codegen → template → widget) | Full coverage |
| Test suite (CI) | 16 min | ~12 min | -25% |

## What Was Done

### Schema-Driven Architecture (Phase 1-2)

- **Created `config/parameter-schema-v2.json`** — 698 lines, 68 parameters, 100% CLI coverage
- **Built 3 code generators:**
  - `codegen-cli.js` → generates CLI option registration (467 lines)
  - `codegen-validator.js` → generates 43 validation functions (202 lines)
  - `codegen-widget.js` → generates docs widget manifest
- **CI enforcement:** Schema validation + codegen parity check + widget coverage check on every PR

### CLI Swap (Phase 3)

- **`bin/cli.js`:** Replaced 68 hand-written `.addOption()` calls with a 7-line loop importing generated options
- **Help formatter:** Replaced 40-line hardcoded flag-to-section mapping with schema-derived `helpGroups`
- **Result:** Adding a CLI flag now requires only a schema entry + `npm run codegen`

### Validation Swap (Phase 3)

- **`config-manager.js`:** Imports generated validation rules as first-pass check
- **43 parameters** now get automatic type/range/pattern/enum validation from schema
- **Context-dependent validations** (model format depends on engine, etc.) remain hand-written

### Serve Template Split (Phase 3b)

- **Before:** 1 file, 300 lines, 15 EJS conditionals interleaving 4 server implementations
- **After:** 183-line common header + 4 focused partials:
  - `serve.d/vllm.ejs` (48 lines)
  - `serve.d/sglang.ejs` (47 lines)
  - `serve.d/tensorrt-llm.ejs` (53 lines)
  - `serve.d/lmi.ejs` (19 lines)
- **Plugin extensibility:** Custom servers just need a `serve.d/{name}.ejs` file

### Deploy Template Split (Phase 3b)

- **Before:** 1 file, 1,766 lines, 54 EJS conditionals
- **After:** 1-line dispatcher + 4 target files:
  - `deploy.d/managed-inference.ejs` (726 lines)
  - `deploy.d/async-inference.ejs` (501 lines)
  - `deploy.d/batch-transform.ejs` (529 lines)
  - `deploy.d/hyperpod-eks.ejs` (339 lines)
- **Max file reduced:** 1,766 → 726 lines (-59%)

### Clean Template Split (Phase 3b)

- **Before:** 1 file, 1,387 lines, 50 EJS conditionals
- **After:** 1-line dispatcher + 4 target files:
  - `clean.d/managed-inference.ejs` (1,043 lines)
  - `clean.d/async-inference.ejs` (508 lines)
  - `clean.d/batch-transform.ejs` (512 lines)
  - `clean.d/hyperpod-eks.ejs` (481 lines)
- **Max file reduced:** 1,387 → 1,043 lines (-25%)

### Dockerfile Template (Deferred)

- **322 lines, 127 EJS conditionals** — high density but short file
- Deferred: already fits in AI context window, ROI of splitting is low

### Source Code Decomposition (Phase 3c)

- **`prompt-runner.js`** (2,650 → 1,169): Extracted `mcp-query-runner.js` (768), `secrets-prompt-runner.js` (247), `cuda-resolver.js` (140), `marketplace-flow.js` (276)
- **`config-manager.js`** (2,496 → 858): Extracted `config-loader.js` (401), `config-mcp-client.js` (118), `config-validator.js` (624). Parameter matrix replaced with schema-generated import.
- **`bootstrap-command-handler.js`** (1,921 → 899): Extracted `bootstrap-provisioners.js` (421), `bootstrap-profile-manager.js` (634)
- **`src/app.js`** (1,288 → 900): Extracted `template-variable-resolver.js` (398)
- **`prompts.js`** (1,451 → split): `model-prompts.js` (552), `infrastructure-prompts.js` (690), `feature-prompts.js` (172), `project-prompts.js` (70)

### Parameter Matrix Replacement

- **Before:** 726-line hand-written `_getParameterMatrix()` method duplicating schema data
- **After:** `scripts/codegen-parameter-matrix.js` generates `src/lib/generated/parameter-matrix.js` from schema
- **config-manager.js** reduced from 1,512 → 858 lines
- **Result:** Adding a parameter to the schema automatically updates the matrix — no manual sync needed

## Command Generator Widget

- **Interactive docs page** at `/command-generator/` — generates full deployment scripts
- **Features:** Model selection (from catalog), server version, instance type, LoRA adapters, benchmarking, multi-IC, custom env vars
- **Auto-synced** with CLI via `docs/data/schema-manifest.json` (generated from schema)
- **CI enforced:** `widget-coverage.json` declares what's rendered vs excluded

## Developer Experience Improvements

| Before | After |
|--------|-------|
| Add CLI flag → edit 7 files | Add schema entry → `npm run codegen` |
| Modify validation → find switch case in 2,479-line file | Edit schema `validation` field → regenerate |
| Add server support → edit 300-line serve template | Create `serve.d/{server}.ejs` (50 lines) |
| Widget out of sync with CLI | CI fails if widget doesn't cover new params |
| No way to know if a parameter is fully wired | `validate-schema-v2.js` reports coverage |

## Files Created

| File | Purpose |
|------|---------|
| `config/parameter-schema-v2.json` | Single source of truth (68 params) |
| `scripts/codegen-cli.js` | CLI option generator |
| `scripts/codegen-validator.js` | Validation rule generator |
| `scripts/codegen-widget.js` | Widget manifest generator |
| `scripts/codegen-parity.js` | Parity verification |
| `scripts/validate-schema-v2.js` | Schema coverage validation |
| `src/lib/generated/cli-options.js` | Generated CLI options |
| `src/lib/generated/validation-rules.js` | Generated validators |
| `docs/data/schema-manifest.json` | Generated widget data |
| `docs/data/widget-coverage.json` | Widget coverage declarations |
| `docs/js/command-generator.js` | Interactive widget |
| `docs/command-generator.md` | Widget page |
| `docs/dev/schema-driven-architecture.md` | Developer docs |
| `templates/code/serve.d/*.ejs` | Server-specific partials (4 files) |
| `.kiro/specs/schema-driven-architecture/requirements.md` | Full architecture spec |
