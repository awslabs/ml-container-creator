<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Module-Header Docblock Convention

> **Why.** This codebase is maintained largely by AI agents. An AI (or human)
> should be able to open **one file** and understand not just *what* it does but
> *how it fits the whole system* — which pattern it implements, who it talks to,
> and where to read the decision behind it — **without** spidering through a
> dozen other files first. The module header is that entrypoint. It is the
> file-level counterpart to the `docs/adr/` decision log and the
> `docs/architecture/` Developer Guide.
>
> See `docs/adr/ADR-002-consolidation-program.md` for the program this
> convention belongs to.

## Scope: which modules need a header

A **pattern-participating module** must carry a conforming header. That means any
module that:

- implements or is an instance of a named pattern (factory, base class,
  strategy, resolver, registry, adapter, plugin, command handler, validator, …),
- is one of several interchangeable siblings (e.g. an MCP picker server, a serve
  engine wrapper, an accelerator validator), or
- sits on a data-flow boundary others depend on (config precedence, template
  writing, codegen output, MCP transport).

Leaf utilities, pure one-off helpers, generated files (`src/lib/generated/**`),
tests, and fixtures do **not** require the full header (though a one-line purpose
comment is still encouraged). The ESLint rule (below) only *warns*, and only for
files under the directories where the pattern lives, so it never nags trivial
modules.

## The four required fields

Every header states, in order:

1. **PATTERN** — the pattern this module implements or participates in, named
   explicitly (e.g. "Factory for MCP picker servers", "Strategy: one accelerator
   validator", "Single source of truth for engine capabilities").
2. **COLLABORATORS** — who calls this module and whom it calls. Name the files
   or module groups, so a reader can navigate outward in one hop.
3. **DATA-FLOW ROLE** — what this module consumes and produces, and where it sits
   in the pipeline (e.g. "consumes `answers`, produces rendered project files";
   "test-only; produces fast-check Arbitrary instances").
4. **See:** — at least one `docs/adr/ADR-NNN-*.md` or `docs/architecture/*.md`
   reference for the decision/explainer behind the pattern.

## Format by language

### JavaScript / TypeScript (`.js`, `.cjs`, `.mjs`, `.ts`)

A block comment near the top of the file (after the copyright header). The rule
looks for the labels `PATTERN`, `COLLABORATORS`, `DATA-FLOW ROLE` (or
`DATA-FLOW`), and `See:`.

```javascript
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve-Layer Manifest Reader (generation-time).
 *
 * PATTERN: Single source of truth reader — resolves per-engine capabilities
 *   from serve.d/<engine>/manifest.json instead of hardcoded literals.
 * COLLABORATORS: called by src/app.js writeProject() and
 *   src/lib/engine-prefix-resolver.js; reads templates/code/serve.d/*/manifest.json.
 * DATA-FLOW ROLE: generation-time. Consumes an engine name, produces the
 *   engine's env_var_prefix / capability data injected into the EJS render context.
 * See: docs/adr/ADR-004-serve-engine-plugin-parity.md,
 *   docs/architecture/serve-engine-plugins.md
 */
```

### Python (`.py`)

A module docstring immediately after the copyright lines, with the same labels.

```python
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Goal planner for the advisory agent.

PATTERN: Planner — turns a natural-language goal into an ordered do/ script plan.
COLLABORATORS: called by agent.py; consumes do/ contract metadata; hands the
    plan to chain_runner.py.
DATA-FLOW ROLE: consumes a goal string + do/ contracts, produces an ordered
    list of PlanStep executed by the ChainRunner.
See: docs/adr/ADR-008-advisory-agent-architecture.md, docs/architecture/agent.md
"""
```

### Bash (`do/` scripts and `*.sh`)

`do/` scripts already carry the `@mlcc-script` contract block (see
`docs/do-script-contract.md`), which is their equivalent self-documenting
header. Shared bash libraries under `templates/do/lib/` use a comment block with
the same four labels:

```bash
#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# PATTERN: Shared helper library sourced by do/ scripts (arg/help parsing).
# COLLABORATORS: sourced by do/build, do/deploy, ... alongside config + profile.sh.
# DATA-FLOW ROLE: pure shell helpers; no state of its own.
# See: docs/architecture/do-scripts.md, docs/adr/ADR-007-do-script-conventions.md
```

## Enforcement

- ESLint rule **`property-test-rules/require-module-header`** (in the local
  `eslint-rules/` plugin) checks JS modules for the four labels.
- It is a **warning** during the consolidation program (Waves 1–8) so migration
  is incremental and never blocks unrelated work. It is promoted to **error** in
  **Wave 9, Task 3** once every pattern-participating module conforms.
- The rule is scoped via `.eslintrc.cjs` overrides to the directories where
  patterns live (initially `servers/lib/**` and `src/lib/**` factories/base
  classes), expanding wave by wave. Python and bash headers are convention-only
  (reviewed, not linted) for now.

## Authoring checklist

- [ ] Copyright + SPDX lines present.
- [ ] `PATTERN:` names the pattern, not just the file.
- [ ] `COLLABORATORS:` names concrete files/module groups (in + out).
- [ ] `DATA-FLOW ROLE:` says what goes in and what comes out.
- [ ] `See:` points to a real ADR or architecture doc that exists.
