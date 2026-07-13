# Generator Architecture

The generator is a standalone Node.js CLI built with [Commander.js](https://github.com/tj/commander.js/). The entry point is `bin/cli.js`, which parses options and delegates to `src/app.js`. Business logic modules live in `generators/app/lib/`.

## Entry Point Flow

```
bin/cli.js          → Commander option parsing, subcommand routing
  └─ src/app.js     → Orchestrates the four generation phases
       └─ generators/app/lib/  → Business logic modules
```

### `bin/cli.js`

Defines all CLI options, subcommands (`bootstrap`, `mcp`, `registry`, `configure`), and calls `run()` from `src/app.js` as the default action.

### `src/app.js`

The `run(projectName, options)` function orchestrates the full generation workflow. It also exports `writeProject()` and `postGenerate()` for use in tests and programmatic invocations.

### `src/copy-tpl.js`

EJS template copying utility. Walks the template directory, renders each file through EJS, and writes to the destination — respecting ignore patterns.

### `src/prompt-adapter.js`

Bridges the prompt definitions (which use Inquirer.js-compatible prompt objects) to `@inquirer/prompts` for interactive input collection.

## Generation Phases

### Phase 1: Initializing

Loads configuration from all sources and initializes the registry system.

1. Commander options are converted from camelCase to kebab-case for `ConfigManager` compatibility.
2. `ConfigManager.loadConfiguration()` merges values from 8 sources in precedence order: CLI options, CLI arguments, environment variables, CLI config file, custom config file (`config/mcp.json`), package.json section, MCP servers, and generator defaults. It also queries configured MCP servers via `McpClient`.
3. `ConfigurationManager` loads the three registries through `RegistryLoader`, which reads catalog JSON files from `servers/*/catalogs/` and transforms them into internal data shapes.
4. `ValidationEngine` is initialized with accelerator validators (CUDA, Neuron, ROCm, CPU) for later use.

### Phase 2: Prompting

If `--skip-prompts` is set, `ConfigManager.getFinalConfiguration()` returns the merged config directly. Otherwise:

1. `PromptRunner.run()` executes prompts in phases: Infrastructure (region, deployment target, instance type, HyperPod/async/batch settings, build target), Core ML (deployment config, engine, model format, model name, base image, HF token), Modules (sample model, testing), and Project (name, directory).
2. Prompt definitions live in `prompts.js`. Each prompt group is an exported array. The deployment config prompt presents a flat list of 15 `architecture-backend` values (e.g., `transformers-vllm`, `triton-fil`). `DeploymentConfigResolver.decompose()` splits these into `architecture` and `backend` fields.
3. `PromptRunner` queries MCP servers for instance type and region choices before presenting those prompts, merging MCP-provided choices into the prompt options.
4. Prompt answers are merged with the base config via `ConfigManager.getFinalConfiguration(promptAnswers)`.

### Phase 3: Writing

1. `TemplateManager.validate()` checks that the deployment config, build target, deployment target, instance type, and region are all within supported values. It also enforces GPU requirements for GPU-only backends.
2. `CommentGenerator` produces Dockerfile comments (accelerator info, validation status, troubleshooting).
3. All templates are copied with `copyTpl()`, processing EJS variables. A small set of ignore patterns excludes architecture-specific subdirectories (`triton/`, `diffusors/`, `hyperpod/`) that are handled separately.
4. A four-way `switch` on `architecture` (http, transformers, triton, diffusors) deletes files that don't belong to the selected architecture and, for triton and diffusors, copies architecture-specific templates (Dockerfile, model repository, serve scripts).
5. Shell scripts in `do/` and `deploy/` get `chmod 755`.

### Phase 4: Post-generate

Runs `train_abalone.py` if a sample model was requested (http and eligible triton backends only). Sets executable permissions on generated scripts.

## Key Modules

| Module | Location | Purpose |
|--------|----------|---------|
| `config-manager.js` | `generators/app/lib/` | 8-level configuration precedence, MCP integration, parameter matrix |
| `prompt-runner.js` | `generators/app/lib/` | Phased prompt execution, MCP choice injection, catalog data loading |
| `prompts.js` | `generators/app/lib/` | All prompt definitions, instance type registry from catalog, project name generation |
| `template-manager.js` | `generators/app/lib/` | Validates deployment config, build target, deployment target, instance type, region, GPU requirements |
| `configuration-manager.js` | `generators/app/lib/` | Orchestrates registry loading, framework/model matching, HuggingFace enrichment, env var validation |
| `registry-loader.js` | `generators/app/lib/` | Adapter layer: reads catalog JSON from `servers/*/catalogs/` and transforms into internal shapes |
| `deployment-config-resolver.js` | `generators/app/lib/` | Decomposes `transformers-vllm` into `{architecture: 'transformers', backend: 'vllm'}` |
| `mcp-client.js` | `generators/app/lib/` | Spawns MCP server processes, performs handshake, calls `get_ml_config` tool |
| `validation-engine.js` | `generators/app/lib/` | Validates accelerator compatibility (framework requirements vs. instance capabilities) |
| `deployment-registry.js` | `generators/app/lib/` | CRUD operations for the local deployment registry (`~/.mcc-registry/`) |
| `copy-tpl.js` | `src/` | EJS template rendering and file copying with glob ignore patterns |
| `prompt-adapter.js` | `src/` | Bridges prompt definitions to `@inquirer/prompts` |

## Configuration Flow

The configuration precedence system is documented in the [Configuration](../configuration.md) user guide. From a code perspective, the flow is:

1. `ConfigManager` constructor builds a parameter matrix defining which parameters are accepted from which sources.
2. `loadConfiguration()` applies sources in reverse precedence order (lowest first), so higher-precedence sources overwrite lower ones.
3. MCP servers are queried during loading. `McpClient` spawns each configured server as a child process, performs the MCP handshake, and calls the `get_ml_config` tool. Returned values and choices are stored separately — values merge into the config, choices are injected into prompt options.
4. `getFinalConfiguration(promptAnswers)` merges prompt answers (lowest precedence) with the accumulated config and applies `DeploymentConfigResolver` to decompose the `deploymentConfig` string into `architecture` and `backend`.
5. `_ensureTemplateVariables()` in `src/app.js` fills in defaults for any missing fields, merges environment variables from catalog sources with a five-layer precedence (catalog defaults, framework profile, model entry, model profile, CLI overrides), and enriches transformer models with HuggingFace data.

## Subcommands

The CLI registers subcommands via Commander:

| Subcommand | Handler | Purpose |
|---|---|---|
| `bootstrap [action]` | `src/lib/` (Phase 2) | One-time AWS infrastructure setup |
| `mcp <action>` | `src/lib/` (Phase 2) | Query configured MCP servers |
| `registry <action>` | `src/lib/` (Phase 2) | Deployment registry operations |
| `configure` | `src/lib/` (Phase 2) | Generate config file |

## Testing

Tests invoke `writeProject()` directly with a prepared answers object and a temporary destination directory. This avoids interactive prompts and allows deterministic validation of generated output.

```javascript
import { writeProject } from '../src/app.js'

const destDir = path.join(os.tmpdir(), 'test-output')
await writeProject(TEMPLATE_DIR, destDir, answers)
// Assert on generated files
```

## Further Reading

- [Template System](template-system.md) — EJS templates, do/ script branching, Dockerfile conditionals
- [MCP Server Development](mcp-server-development.md) — Adding catalog entries, creating new servers
- [Registries and Catalogs](registries-and-catalogs.md) — Catalog JSON format and data flow
- [Configuration](../configuration.md) — User-facing configuration reference

## `.mlcc-generation-params.json` Lifecycle

The `.mlcc-generation-params.json` file captures the full generation inputs for later use by `mcc regenerate`.

### When it's written

`writeProject()` writes this file at the end of every successful generation call, unless:
- `options.noGenerationParams === true` (used by `mcc import` — imported projects have different provenance)
- `options.onlyFiles` is set (used by `mcc update` — partial regeneration should not overwrite saved params)

### Contents

```json
{
  "generatorVersion": "1.3.0",
  "generatedAt": "2026-07-13T14:30:00Z",
  "answers": { ... },
  "bootstrapProfile": "default",
  "catalogVersions": { "modelServersVersion": "...", "modelsVersion": "..." }
}
```

### Sensitive value redaction

Values for `hfToken` and `ngcToken` (plaintext secrets) are replaced with `"[REDACTED]"`. ARN references (`hfTokenArn`, `ngcTokenArn`) are preserved — they point to Secrets Manager and are not themselves secret.

### Read by `mcc regenerate`

The regenerate command reads this file as the primary source of generation parameters. It merges with live overrides from `do/config` and `do/ic/*.conf` (live values take precedence), then runs `writeProject()` with the merged answers.

### Gitignored

The generated `.gitignore` template includes `.mlcc-generation-params.json` — this file is local project state and should not be committed. Different developers may have different values (tokens, regions, profiles).

### New command handler modules

Three new handler modules in `src/lib/` implement the lifecycle commands:

| Module | Command | Purpose |
|--------|---------|---------|
| `import-command-handler.js` | `mcc import` | Endpoint introspection → `writeProject()` |
| `update-command-handler.js` | `mcc update` | Field changes → selective `writeProject()` |
| `regenerate-command-handler.js` | `mcc regenerate` | Saved params → full `writeProject()` |

All three use `writeProject()` from `src/app.js` with the new `options` parameter to control file selection and generation params behavior.
