# Workflow: evidence first

History shows the same failure classes over and over: parallel copies drifting apart,
errors swallowed silently, `regenerate` overwriting user state, premises about AWS that turned
out wrong, and work marked "done" that was never validated live. These rules exist to stop them.

## Before changing code
- **Verify the premise.** Restate what you believe the current behaviour is, then confirm it in
  the code with `file:line` (and grep counts where it matters). Many old specs had to correct
  their own premise after a probe.
- **Check prior art.** For a backlog item, read its spec in `.kiro/specs/` and its row in
  `.kiro/backlog.jsonl` (read-only). Superseded items carry `supersededBy` metadata, so don't
  revive retired designs (for example the branded AI-registry hub).
- **Split waves by substrate.** Don't mix unrelated subsystems (CLI, do/ runtime, CDK, servers)
  in one change unless the contract between them is what is changing.

## While changing code
- **Fail loudly.** Don't add `2>/dev/null`, `|| true`, `except Exception: pass` or an empty
  fallback (`KEY_MAP = {}`) to code that must succeed. If a failure really is tolerable, say why
  in a comment and still log it.
- **Keep user state.** Anything a `do/` script writes at runtime must survive `mcc regenerate`
  (see `.claude/rules/derive-dont-hardcode.md`, runtime-owned vars).
- **Ship help and docs with the behaviour**, never before it.
- **Add the module header** (`docs/architecture/module-header-convention.md`) to every
  pattern-participating module you create or substantially edit.

## Finishing
- Run the narrowest relevant suites first, then `npm run lint` and `npm test`. Run
  `npm run test:property` when you touch validators, the schema or generation.
- Compare failures against the baseline before calling something a regression. Pre-existing
  environmental flakes are recorded in `docs/dev/test-inventory.md`.
- **Separate "implemented" from "validated live".** If a change needs an AWS run to prove it,
  say so explicitly and list what the owner needs to run. Don't call it done.
- Report which tasks you finished, what you skipped and why, and any test you could not run.
