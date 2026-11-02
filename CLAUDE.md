# ml-container-creator (MLCC) — Claude Code notes

This repo is also worked on by **Kiro, which may be running at the same time**. The shared rules live in the Kiro steering files below and are imported, not copied, so the two tools cannot drift. Where an import disagrees with this file, **this file wins** (the imports have a few stale details, listed under Corrections).

@.kiro/steering.md
@.kiro/steering/derive-dont-hardcode.md

## Kiro coexistence (read first)
- **Treat `.kiro/` as read-only.** Never edit, move or delete anything under `.kiro/` (steering, specs, trackers, `backlog.jsonl`, `tools/`). Kiro owns it and may be mid-edit. If a tracker or spec needs an update, say so and let the user make it.
- Read specs and trackers freely: `.kiro/specs/<name>/` (requirements, design, tasks), `.kiro/backlog.jsonl`, `.kiro/v2.0-tracker.md`.
- Only `.kiro/steering.md` and `.kiro/hyperpod-ops-surface.md` are tracked in git. The rest of `.kiro/` is local-only (gitignored), so it exists only in this checkout.
- Do not create `AGENTS.md`, `.kiro/steering/*` or anything else Kiro would load automatically.
- Run `git status` before editing. If files outside your task are already modified, Kiro is probably working: leave them alone and avoid broad `git add -A`; stage files by name.
- Never run `npm run codegen`, tests or `git` operations that rewrite many files while Kiro may be doing the same. Ask the user if unsure.

## Corrections to the imported steering
- Regenerate code with `npm run codegen` (there is no `npm run generate`).
- The commit gate is `.husky/pre-commit`, not just ESLint. In order: reject hardcoded `numRuns` in staged property tests; `lint-staged`; Python `ast.parse` on staged `.py` (skips EJS templates containing `<%`); codegen parity when schema, codegen scripts or catalogs are staged (plus catalog and tune-manifest validation); `node scripts/sync-command-generator.js --check`; `npm run build` in `infra/bootstrap-modules` when `.ts` files are staged; strip `__pycache__`. Never bypass it with `--no-verify`. `.git/config` points `core.hooksPath` at `.husky/_`, so `.githooks/pre-commit` is a legacy duplicate and not the live gate.
- There are 13 bundled MCP servers in `servers/` (the steering text says 12 and lists 11). They are MLCC's product, not dev tooling.
- Do not infer implementation status from the `package.json` version. Check the tracker and the code. Specs for a release often sit at drafted or hardened long after the minor bump.

## Extra rules not in the steering files
- Flexible Training Plan (`trainingPlanArn`) is NOT a bootstrap-time input. Do not add it as a bootstrap option, SSM value or CDK context. The integration point is undecided (likely `do/deploy --target hyperpod-eks` or a `do/config` variable). **Ask before implementing.**
- MLflow registered model names must not contain `/` (breaks loading, MLflow #8801). Use `--` between family/variant and `__` between sub-components.
- `do/` scripts that call `python3` must call `_require_python_env` (from `lib/script-contract.sh`) after sourcing `script-contract.sh`, so the project venv (`.mlcc/hey-venv`) auto-activates.
- In `deploy.d/hyperpod-eks`, anything exported inside `$(...)` does not reach the parent shell. Set `HP_MODEL_SOURCE` explicitly before `envsubst`.
- Serving on HyperPod is vLLM via the inference operator. Do not add SGLang references.

## Working from specs (Claude Code)
- Use plan mode for any BL item. Read its spec and its row in `.kiro/v2.0-tracker.md` first, then work `tasks.md` in order and report which tasks you finished.
- When a test fails, decide whether the test or the code is wrong using the spec, committed behavior and git history. Do not fix whichever side is easier.
- Never fabricate data to make a test pass. Use a documented skip.

## Claude Code guardrails
- `.claude/settings.json` denies edits to `src/lib/generated/**`, and a `PreToolUse` hook (`.claude/hooks/guard-generated.mjs`) blocks edits inside `# >>> GENERATED ... # <<< END GENERATED` blocks. The hook only covers Edit/Write, so never use `sed -i` or shell redirection on generated files either. Edit the schema or descriptor and run `npm run codegen`.
- `.mcp.json` is Claude-only and loads just `e2e-status` and `agent-knowledge`. Kiro has no MCP config in this setup.
- Ask before `git commit`, `git push`, `npm publish`, `npx cdk`, `aws` and `node scripts/e2e-runner.js`.
