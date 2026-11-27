# Derive, don't hardcode

Per-target and per-engine knowledge lives in **one declarative source**, and every consumer
derives from it (ADR-008). When behaviour varies by deployment target, serving engine, tune
technique or predictor framework, edit the source and let the derivation flow. A hand-added
`case` arm or literal list is how these contracts drift apart — the bug class ADR-006/007/008
exist to prevent.

## Rules
1. **Never hand-edit generated output.** That covers `src/lib/generated/**` and the
   `# >>> GENERATED … # <<< END GENERATED` regions in `templates/do/` scripts, which
   `scripts/codegen-target-guard.js` and `scripts/codegen-deploy-flags.js` write from the
   descriptors. Edit the descriptor or schema, run `npm run codegen`, and check that a
   second run is a no-op.
2. **Never hardcode a per-target or per-engine list.** Derive it instead:
   - Status var → answer key: `statusVarToAnswerKey()` in `src/lib/target-manifest-reader.js`.
   - Runtime-owned vars that `regenerate` preserves: `RUNTIME_OWNED_VARS` in
     `src/lib/regenerate-command-handler.js` spreads `runtimeOwnedVarsUnion()` (per target)
     and `serveEngineRuntimeVarsUnion()` (per engine). Add a var to the descriptor's
     `runtime_owned_vars` or the engine's `dimension_map`. `SHARED_RUNTIME_VARS` is only for
     genuinely cross-cutting vars (BENCHMARK_ / OPTIMIZE_ / MLFLOW_ job state).
   - `templates/do/lib/python/deploy_schema.py` derives `SCHEMAS`, `STATUS_VARS` and
     `TARGET_ALIASES` from the descriptors at import. Its `_FALLBACK_*` literals must mirror them.
   - Deployment-config family: use `src/lib/deployment-config-resolver.js` instead of
     `deploymentConfig.split('-')[0]`.
3. **Adding a deployment target:** write one descriptor, `deploy.d/<t>` and `clean.d/<t>`, then
   run `npm run codegen`. The target list itself is derived (`listTargets()` in
   `src/lib/target-manifest-reader.js`). The full checklist is in
   `docs/architecture/deployment-target-authoring.md`. New serve engines:
   `docs/architecture/serve-engine-plugin-authoring.md`. New tune techniques:
   `docs/architecture/tune-descriptor.md`.
4. **A duplicate you can't remove must be conformance-checked, not silent.** Add a drift test
   in the same commit, and make sure a CI script actually runs it. A check that matches nothing,
   or never runs, is worse than none (it reads as coverage). Patterns to copy:
   `test/unit/target-descriptor-conformance.test.js`, `test/unit/deploy-flag-forwarding.test.js`,
   `test/unit/no-literal-bucket-names.test.js`.
5. **Deploy flags come from `answer_params`.** Each target descriptor's `answer_params` array is
   the single source for deploy flags and answer keys. `CLI_FLAG_TO_VARS`
   (`src/lib/deploy-config-builder.js`), `flag_to_answer_key` and `_ANSWER_KEY_TO_VAR`
   (via `templates/do/lib/python/deploy_answers.py`), the `do/deploy` `KEY_MAP` and the
   arg-parse arms (`scripts/codegen-deploy-flags.js`) all derive from it. To add a deploy
   flag, add an `answer_params` entry and run `npm run codegen`. Don't add a table entry by
   hand. `test/unit/deploy-flag-forwarding.test.js` enforces this.
6. **One default, one place.** Defaults such as instance type per architecture or model IDs
   belong in the schema or one config file. If you find a second copy, consolidate it rather
   than adding a third.

## Lint trap
Never write the two characters `*/` inside a JS block comment. Env-var globs like
`VLLM_*/HP_*` end the comment early and break eslint. Write `VLLM_ and HP_` instead.
