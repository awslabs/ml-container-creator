<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# System Overview

ml-container-creator is a CLI **project generator**: it turns a user's
configuration (flags, env, config files, interactive prompts, MCP-sourced
values) into a generated SageMaker BYOC project — a directory of EJS-rendered
templates plus a `do/` lifecycle-script suite. Around that core sit management
subcommands (bootstrap, prove, import, update, regenerate, secrets, mcp), a set
of MCP "picker" servers, and a Python advisory agent (`mcc hey`).

This page is the map. For decisions behind the current shape, see
[ADR-002](../adr/ADR-002-consolidation-program.md); for the file-level
entrypoint convention, see [module-header-convention.md](module-header-convention.md).

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ CLI SHELL                bin/cli.js                                    │
│  • Commander program; root action = "generate"                        │
│  • subcommands dispatch to src/lib/*-command-handler.js               │
│  • options registered from the code-generated cli-options.js          │
└───────────────┬────────────────────────────────────────────────────────┘
                │ run(projectName, options)
┌───────────────▼──────────────────────────────────────────────────────┐
│ CONFIG / INTENT          src/app.js run()  +  src/lib/config-manager.js│
│  • ConfigManager merges sources by precedence (bootstrap < pkg.json <  │
│    config file < env < CLI args < CLI opts), governed by the           │
│    code-generated parameterMatrix                                      │
│  • PromptRunner (+ McpQueryRunner → ConfigMcpClient → McpClient) fills  │
│    interactive / MCP-sourced values                                    │
│  • template-variable-resolver enriches defaults                        │
│  OUTPUT: a normalized `answers` object                                 │
└───────────────┬────────────────────────────────────────────────────────┘
                │ writeProject(templateDir, destDir, answers, ...)
┌───────────────▼──────────────────────────────────────────────────────┐
│ WRITING / TEMPLATE       src/app.js writeProject()  +  src/copy-tpl.js  │
│  • TemplateManager validates answers                                   │
│  • copyTpl walks templates/ and EJS-renders (drops .ejs)               │
│  • architecture routing (http/transformers/triton/diffusors/           │
│    marketplace) deletes/overlays files                                 │
│  • serve-engine wrappers rendered from templates/code/serve.d/*        │
│  OUTPUT: generated project dir + .mlcc-generation-params.json          │
└──────────────────────────────────────────────────────────────────────┘

        ┌──────────────────────────────┐   ┌──────────────────────────────┐
        │ CODEGEN BOUNDARY             │   │ MCP BOUNDARY                  │
        │ config/parameter-schema-v2   │   │ config/mcp.json + servers/*    │
        │   .json  ── scripts/codegen- │   │ reached only via McpClient     │
        │   *.js ──▶ src/lib/generated/│   │ over stdio (child processes)   │
        │ (cli-options, parameter-     │   │ picker servers return           │
        │  matrix, validation-rules)   │   │ { values, choices }            │
        └──────────────────────────────┘   └──────────────────────────────┘
```

## The boundaries that matter

### Codegen boundary — the schema is the source of truth
`config/parameter-schema-v2.json` defines every parameter. `scripts/codegen-*.js`
generate `src/lib/generated/{cli-options,parameter-matrix,validation-rules}.js`
(marked `DO NOT EDIT`). The CLI shell consumes `cli-options.js`; `ConfigManager`
consumes `parameter-matrix.js`. **Consequence for maintainers:** to add or change
a parameter, edit the schema and re-run `npm run codegen` — never hand-edit the
generated files. (The consolidation program extends this "derive, don't
duplicate" principle to test arbitraries and, in Wave 3, to serve-engine
capabilities.)

### Config precedence — one merge, many sources
`ConfigManager` (CLI parameter-precedence engine) is distinct from
`ConfigurationManager` (the registry/framework-matching subsystem) — a
name collision Wave 4 resolves. `ConfigManager` delegates to `ConfigLoader`,
`ConfigValidator`, and `ConfigMcpClient`; that is an intentional split of one
class across files, not duplication.

### Writing boundary — `answers` in, project out
Everything upstream produces a single normalized `answers` object;
`writeProject` is the only thing that turns it into files. `update` and
`regenerate` re-enter `writeProject` with `onlyFiles`/`skipTemplates` for partial
regeneration, reading back `.mlcc-generation-params.json` (the state boundary).

### MCP boundary — servers are child processes
The 15 picker servers under `servers/` are independent processes reached only
through `src/lib/mcp-client.js` over stdio. They return `{ values, choices }`.
Today each server re-implements the same scaffold; Wave 2 introduces a shared
`createPickerServer` factory.

### Serve-engine plugins — capabilities as data
`templates/code/serve.d/<engine>/manifest.json` is meant to be the single source
of truth for an engine's env-var prefix, supported speculative-decoding
algorithms, and metrics endpoint. Today the contract is only half-honored (vLLM
hardcodes what the manifest should supply; `lmi`/`tensorrt-llm` lack manifests).
Wave 3 finishes this abstraction.

## Where to read next

- Adding/using a parameter → codegen boundary above +
  `dev/schema-driven-architecture.md`.
- Adding an MCP server → `mcp-servers.md` (Wave 2).
- Adding a serve engine → `serve-engine-plugins.md` (Wave 3).
- The wave-by-wave plan and its rationale →
  [ADR-002](../adr/ADR-002-consolidation-program.md).
