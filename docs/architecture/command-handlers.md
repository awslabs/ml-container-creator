<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Command Handlers & do/config

Each `mcc <command>` subcommand is implemented as a handler class in
`src/lib/<command>-command-handler.js`. `bin/cli.js` is a thin dispatcher: it
registers the Commander subcommand, lazily imports the handler's default export,
constructs it, and calls `handle(...)`. See
[system-overview.md](system-overview.md) for where this sits;
[ADR-005](../adr/ADR-005-command-handler-contract.md) for the contract decision.

## The handler contract

`BaseCommandHandler` (`src/lib/base-command-handler.js`) captures what handlers
genuinely share:

- **`this.GENERATOR_ROOT` / `this.TEMPLATE_DIR`** (also named exports) — the
  generator package root and templates dir, computed once instead of copy-pasted.
- **`fail(message, { exit = true })`** — the standard failure convention:
  `exit: true` hard-exits (fatal), `exit: false` sets `process.exitCode` (soft,
  keep-going). Unifies the two error styles that existed across handlers.
- **`async handle()`** — abstract; throws if a subclass forgets to override it.
  The contract is "there is an async `handle`," **not** a fixed signature.

### What is intentionally NOT uniform

- **`handle(...)` arity varies by command** (see table). This is essential, not
  incidental — each command's inputs differ, and `bin/cli.js` knows each shape at
  its call site. Do not add a translation layer to force uniformity.
- **Constructor options** are per-command bags; the only rule is `super()`.

## The eight handlers

| Command | Handler | `handle` signature | Extends base? |
|---|---|---|:---:|
| `import` | ImportCommandHandler | `handle(endpointArn)` | ✓ |
| `update` | UpdateCommandHandler | `handle()` | ✓ |
| `regenerate` | RegenerateCommandHandler | `handle()` | ✓ |
| `bootstrap` | BootstrapCommandHandler | `handle(args, options)` | — (incremental) |
| `architecture` | ArchitectureCommandHandler | `handle(args, options)` | — |
| `prove` | ProveCommandHandler | `handle(args, options)` | — |
| `mcp` | McpCommandHandler | `handle(args, options)` | — |
| `secrets` | SecretsCommandHandler | `handle(args, options)` | — |

The three that extend the base are the ones that shared the copy-pasted
`GENERATOR_ROOT`/`TEMPLATE_DIR` block. The other five don't need the path block
and may adopt the base incrementally; they are not forced to.

## do/config parsing (shared)

`update`, `regenerate`, and the validate path all read a generated project's
`do/config` shell file. That parsing is a single utility,
[`src/lib/do-config.js`](../adr/ADR-005-command-handler-contract.md):

- **`parseDoConfig(configPath, { resolveShellDefaults })`** — returns a raw
  `KEY → value` map (or `null` if the file is missing). With
  `resolveShellDefaults: true` it resolves `${VAR:-default}` → `default` (the
  validate path needs resolved values; update/regenerate do not).
- **`shellVarsToAnswers(shellVars)`** — maps shell KEYs to camelCase answer keys
  via the canonical frozen `SHELL_VAR_TO_ANSWER` (the superset union of the
  mappings the handlers previously each carried).

Before Wave 4 this logic existed in **four** places (update, regenerate,
validate-runner, and a replica inside a test). It is now one module.

## Adding a command handler

1. Create `src/lib/<command>-command-handler.js` with
   `export default class <Command>CommandHandler extends BaseCommandHandler`.
2. Call `super()` in the constructor; take a command-specific options bag.
3. Implement `async handle(...)` with whatever signature the command needs.
4. Use `this.fail(msg)` / `this.fail(msg, { exit: false })` for errors, and
   `this.GENERATOR_ROOT` / `this.TEMPLATE_DIR` for paths.
5. Register the subcommand in `bin/cli.js` (lazy `import()` + `new ...().handle`).
6. If it reads `do/config`, use `parseDoConfig` / `shellVarsToAnswers` from
   `src/lib/do-config.js` — never re-implement the parser.
