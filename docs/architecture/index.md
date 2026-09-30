<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Architecture Corpus

This directory is the **Developer Guide substrate**: a set of per-subsystem
explainers that, together with the decision log in
[`docs/adr/`](../adr/ADR-002-consolidation-program.md), let a
new maintainer (human or AI) understand how ml-container-creator fits together —
starting from one file's header and navigating outward in a few hops.

It is built incrementally by the consolidation program
([ADR-002](../adr/ADR-002-consolidation-program.md)). Each wave that reshapes a
subsystem adds or updates the matching explainer here and records the decision as
an ADR. Wave 8 stitches these into a navigable Developer Guide.

## How the pieces relate

- **ADRs** (`docs/adr/ADR-NNN-*.md`) record *decisions*: the why, the
  alternatives, the consequences. They are dated and immutable once accepted.
- **Architecture explainers** (`docs/architecture/*.md`) describe *how a
  subsystem works today*. They are living documents, kept in sync with the code.
- **Module headers** (see [module-header-convention.md](module-header-convention.md))
  are the file-level entrypoint: each pattern-participating module names its
  pattern, collaborators, data-flow role, and a `See:` link into this corpus.

## Contents

### Conventions
- [Module-Header Docblock Convention](module-header-convention.md) — the
  self-documenting-file standard and its ESLint enforcement.

### System
- [System Overview](system-overview.md) — the layer map: CLI shell → config/
  intent → writing/template → codegen boundary → MCP boundary.

### Subsystems (added as waves land)
- [MCP picker servers](mcp-servers.md) — *Wave 2*
- [Serve-engine plugins](serve-engine-plugins.md) — *Wave 3*
    - [Authoring guide](serve-engine-plugin-authoring.md) — extend/version/add engine plugins
- [Command handlers & do/config](command-handlers.md) — *Wave 4*
- [Validation framework](validation.md) — *Wave 5*
- [`do/` scripts](do-scripts.md) — *Wave 6*
    - [Adding a deployment target](deployment-target-authoring.md) — the target authoring guide
    - [Per-script Wave 6 changelog](do-scripts-wave6-changelog.md) — what changed, per script
- Advisory agent — *Wave 7* (`agent.md`)

## Decision log

See the ADR log:

- [ADR-001](../adr/ADR-001-import-contract-metadata-schema.md) — Import metadata
  contract (pre-program).
- [ADR-002](../adr/ADR-002-consolidation-program.md) — Consolidation &
  self-documenting re-architecture program (this program).
- [ADR-003](../adr/ADR-003-mcp-picker-server-factory.md) — MCP picker-server
  factory (Wave 2).
- [ADR-004](../adr/ADR-004-serve-engine-plugin-parity.md) — Serve-engine plugin
  parity (Wave 3).
- [ADR-005](../adr/ADR-005-command-handler-contract.md) — Command-handler
  contract (Wave 4).
- [ADR-006](../adr/ADR-006-unified-validation-framework.md) — Unified validation
  framework (Wave 5).
- [ADR-007](../adr/ADR-007-do-script-contract-enforcement.md) — `do/` script
  contract enforcement (Wave 6).
- [ADR-008](../adr/ADR-008-deployment-target-descriptor.md) — deployment-target
  descriptor / single source of truth (Wave 8).
