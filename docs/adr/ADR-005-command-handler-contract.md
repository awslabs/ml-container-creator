# ADR-005: Command-Handler Contract

## Status

Accepted — in progress (Wave 4)

## Context

Each `mcc <command>` subcommand (bootstrap, architecture, import, update,
regenerate, prove, mcp, secrets) is implemented as a class in
`src/lib/<command>-command-handler.js`, lazily imported and invoked by
`bin/cli.js`. The eight handlers grew independently and share a *loose* shape but
have no common base:

- All are `export default class XCommandHandler` with an `async handle(...)`.
- **Three of them** (import, update, regenerate) copy-paste the identical module
  header block computing `GENERATOR_ROOT` / `TEMPLATE_DIR`:
  ```js
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const GENERATOR_ROOT = resolve(__dirname, '../..');
  const TEMPLATE_DIR = join(GENERATOR_ROOT, 'templates');
  ```
- The `handle` signatures **legitimately diverge**: `import` takes
  `handle(endpointArn)`, `update`/`regenerate` take `handle()`,
  bootstrap/mcp/prove/secrets/architecture take `handle(args, options)`.
- Error/exit conventions **inconsistently** split: some handlers hard-exit
  (`process.exit(1)`), others set `process.exitCode = 1` and continue.

For an AI maintainer, "8 classes that are almost the same but not quite" is hard
to reason about: which parts are essential vs incidental? The `GENERATOR_ROOT`
block is pure incidental duplication; the `handle` variance is essential.

## Decision

Introduce a lightweight `BaseCommandHandler` (`src/lib/base-command-handler.js`)
that captures **only what is genuinely shared**, and explicitly document what is
intentionally NOT uniform.

### What the base provides
- **`GENERATOR_ROOT` / `TEMPLATE_DIR`** — computed once in the base (all handlers
  live in `src/lib/`, so the paths are identical) and exposed both as instance
  properties (`this.GENERATOR_ROOT`) and as named exports for handlers that use
  them as module-level constants. This deletes the copy-pasted block.
- **`fail(message, { exit = true })`** — the standard failure convention: print
  and stop. `exit: true` (default) hard-exits (matching import/update/regenerate
  fatal failures); `exit: false` sets `process.exitCode` (for handlers that do
  cleanup after a soft failure, like prove/secrets). This gives the two existing
  error styles a single, named, documented home without forcing a rewrite.
- **`handle()`** — an abstract method that throws
  `"<Handler> must implement async handle(...)"` if a subclass forgets to
  override it. The contract is "there is an async `handle`," not a fixed
  signature.

### What is intentionally NOT uniform (documented divergence)
- **`handle(...)` signature.** Each command's inputs differ by nature. Forcing a
  single `(args, options)` shape would add a translation layer with no benefit.
  `bin/cli.js` already knows each command's shape at its call site. The base's
  abstract `handle()` documents the *existence* of the method, not its arity.
- **Constructor options.** Each handler takes its own `{ ... }` options bag
  (`{ dryRun, region }` for import; `{ dryRun, force, noRegister, allTargets }`
  for regenerate; …). These are command-specific and stay per-handler; the only
  rule is calling `super()`.

### Scope
Wave 4 migrates the three handlers that shared the `GENERATOR_ROOT` block —
**import, update, regenerate** — onto `BaseCommandHandler` (extend + `super()`,
import the shared paths). The other five (bootstrap, architecture, mcp, prove,
secrets) may adopt it incrementally; they are not forced to, because they do not
share the path block and their divergence is legitimate. A test asserts the
migrated handlers extend the base and expose `handle`.

## Consequences

- **Positive:** the copy-pasted `GENERATOR_ROOT`/`TEMPLATE_DIR` block is gone
  (one source of truth); error/exit handling has a named convention; the "is
  there a handle()?" contract is enforced. An AI reading a handler sees `extends
  BaseCommandHandler` and knows exactly what is shared.
- **Cost:** three handlers change (behavior-preserving); `bin/cli.js` dispatch is
  unchanged (it still does `new Handler(opts).handle(...)`).
- **Risk:** low — the base only adds shared paths + a fail helper + an abstract
  method; it does not intercept `handle`. The divergent signatures are preserved
  exactly, so no call site changes.

## References

- `src/lib/base-command-handler.js` — the base class
- `docs/architecture/command-handlers.md` — the handler map + which extend the base
- `src/lib/do-config.js` — the shared do/config parser (Wave 4 Task 1)
- ADR-002 — the consolidation program
