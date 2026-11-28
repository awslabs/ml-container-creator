---
paths:
  - "bin/**"
  - "src/*.js"
  - "src/lib/**"
  - "scripts/**"
  - "config/**"
---
# CLI core (generator, handlers, validation, codegen)

Node 24+, ES modules throughout (`"type": "module"`). CommonJS appears only where a tool
requires it: `.eslintrc.cjs`, `eslint-rules/*.cjs`, `infra/bootstrap-modules/*.cjs`, and
`templates/do/lib/render-eks-manifests.cjs`.

## Layout
- `bin/cli.js`: Commander wiring only. Root-command options come from
  `src/lib/generated/cli-options.js`. Subcommand handlers load lazily via `import()`.
  New subcommand logic goes in a `src/lib/<name>-command-handler.js`, not inline in `bin/cli.js`.
- `src/app.js`: the generation lifecycle: initialize (load + validate config), prompt,
  resolve template variables, write the project, post-generate.
- Configuration precedence, highest first: CLI options, CLI args, env vars, `--config` file,
  `config/mcp.json`, the `package.json` section, the bootstrap profile, schema defaults, then
  prompts. Implemented in `src/lib/config-manager.js`. Every value records its source.
- Command handlers follow ADR-005 (`docs/architecture/command-handlers.md`). Extend
  `src/lib/base-command-handler.js`, use its `GENERATOR_ROOT` / `TEMPLATE_DIR`, and don't
  recompute the repo root.

## Errors and exit codes
- A failed command **must exit non-zero**. Don't `console.log` a warning and `return` from a
  failure path. That exits 0 and CI reads it as success.
- Library modules (`src/lib/**` other than handlers) **throw**. They don't call
  `process.exit`. Handlers and `bin/cli.js` turn errors into messages and exit codes
  (`BaseCommandHandler.fail()`).
- User-facing messages start with an emoji prefix (❌ error, ⚠️ warning, ✅ success, 🚀 action).

## Validation
- ADR-006 is the single validation framework to extend: `src/lib/validators/base-validator.js`,
  `src/lib/schema-validation-engine.js`, one finding vocabulary
  (`docs/architecture/validation.md`). Don't add a new validator layer or a second CUDA,
  accelerator or CPU/GPU check. Find the existing one and extend it.
- The same misconfiguration must produce the same severity everywhere (warning vs error).

## Schema and codegen
- `config/parameter-schema-v2.json` is the single source for parameters. Valid phases:
  `project`, `model`, `infrastructure`, `features`, `build`, `auth`.
- After editing the schema or any `scripts/codegen-*.js`, run `npm run codegen`. Commit the
  regenerated output with the change, and check that a second run produces no diff.
- `scripts/sync-command-generator.js --check` must pass. It keeps the docs command generator
  in sync with the CLI.

## Style
- 4-space indent, single quotes, strict `eqeqeq` (no `!= null`), JSDoc on exported functions.
- Prefix unused parameters with `_`.
- Prefer pure functions. Keep side effects in top-level orchestration.
- Pattern-participating modules carry the header docblock
  (`docs/architecture/module-header-convention.md`).
- Reuse existing helpers before writing one. For example,
  `src/lib/deployment-config-resolver.js` exists for deployment-config parsing; don't call
  `deploymentConfig.split('-')`.
