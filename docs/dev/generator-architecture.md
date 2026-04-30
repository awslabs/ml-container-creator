# Generator Architecture

The generator is a [Yeoman](https://yeoman.io/) generator that runs through four lifecycle phases. The entry point is `generators/app/index.js`, which delegates to specialized modules in `generators/app/lib/`.

## Lifecycle Phases

### Phase 1: `initializing()`

Loads configuration from all sources and initializes the registry system.

1. `CliHandler` checks for subcommands (`mcp`, `registry`, `help`, `configure`). If one matches, it executes and sets `_helpShown` to skip remaining phases.
2. `ConfigManager.loadConfiguration()` merges values from 8 sources in precedence order: CLI options, CLI arguments, environment variables, CLI config file, custom config file (`config/mcp.json`), package.json section, MCP servers, and generator defaults. It also queries configured MCP servers via `McpClient`.
3. `ConfigurationManager` loads the three registries through `RegistryLoader`, which reads catalog JSON files from `servers/*/catalogs/` and transforms them into internal data shapes.
4. `ValidationEngine` is initialized with accelerator validators (CUDA, Neuron, ROCm, CPU) for later use.

### Phase 2: `prompting()`

If `--skip-prompts` is set, `ConfigManager.getFinalConfiguration()` returns the merged config directly. Otherwise:

1. `PromptRunner.run()` executes prompts in phases: Infrastructure (region, deployment target, instance type, HyperPod/async/batch settings, build target), Core ML (deployment config, engine, model format, model name, base image, HF token), Modules (sample model, testing), and Project (name, directory).
2. Prompt definitions live in `prompts.js`. Each prompt group is an exported array. The deployment config prompt presents a flat list of 15 `architecture-backend` values (e.g., `transformers-vllm`, `triton-fil`). `DeploymentConfigResolver.decompose()` splits these into `architecture` and `backend` fields.
3. `PromptRunner` queries MCP servers for instance type and region choices before presenting those prompts, merging MCP-provided choices into the prompt options.
4. Prompt answers are merged with the base config via `ConfigManager.getFinalConfiguration(promptAnswers)`.

### Phase 3: `writing()`

1. `TemplateManager.validate()` checks that the deployment config, build target, deployment target, instance type, and region are all within supported values. It also enforces GPU requirements for GPU-only backends.
2. `CommentGenerator` produces Dockerfile comments (accelerator info, validation status, troubleshooting).
3. All templates are copied with `fs.copyTpl()`, processing EJS variables. A small set of ignore patterns excludes architecture-specific subdirectories (`triton/`, `diffusors/`, `hyperpod/`) that are handled separately.
4. A four-way `switch` on `architecture` (http, transformers, triton, diffusors) deletes files that don't belong to the selected architecture and, for triton and diffusors, copies architecture-specific templates (Dockerfile, model repository, serve scripts).
5. Shell scripts in `do/` and `deploy/` get `chmod 755`.

### Phase 4: `end()`

Runs `train_abalone.py` if a sample model was requested (http and eligible triton backends only). Sets executable permissions on generated scripts.

## Key Modules

| Module | Purpose |
|--------|---------|
| `config-manager.js` | 8-level configuration precedence, MCP integration, parameter matrix |
| `prompt-runner.js` | Phased prompt execution, MCP choice injection, catalog data loading |
| `prompts.js` | All prompt definitions, instance type registry from catalog, project name generation |
| `template-manager.js` | Validates deployment config, build target, deployment target, instance type, region, GPU requirements, HyperPod config, async/batch config |
| `configuration-manager.js` | Orchestrates registry loading, framework/model matching, HuggingFace enrichment, env var validation |
| `registry-loader.js` | Adapter layer: reads catalog JSON from `servers/*/catalogs/` and transforms into internal shapes |
| `deployment-config-resolver.js` | Decomposes `transformers-vllm` into `{architecture: 'transformers', backend: 'vllm'}` |
| `mcp-client.js` | Spawns MCP server processes, performs handshake, calls `get_ml_config` tool |
| `validation-engine.js` | Validates accelerator compatibility (framework requirements vs. instance capabilities) |
| `deployment-registry.js` | CRUD operations for the local deployment registry (`~/.mcc-registry/`) |

## Configuration Flow

The configuration precedence system is documented in the [Configuration](../configuration.md) user guide. From a code perspective, the flow is:

1. `ConfigManager` constructor builds a parameter matrix defining which parameters are accepted from which sources.
2. `loadConfiguration()` applies sources in reverse precedence order (lowest first), so higher-precedence sources overwrite lower ones.
3. MCP servers are queried during loading. `McpClient` spawns each configured server as a child process, performs the MCP handshake, and calls the `get_ml_config` tool. Returned values and choices are stored separately -- values merge into the config, choices are injected into prompt options.
4. `getFinalConfiguration(promptAnswers)` merges prompt answers (lowest precedence) with the accumulated config and applies `DeploymentConfigResolver` to decompose the `deploymentConfig` string into `architecture` and `backend`.
5. `_ensureTemplateVariables()` in `index.js` fills in defaults for any missing fields, merges environment variables from catalog sources with a five-layer precedence (catalog defaults, framework profile, model entry, model profile, CLI overrides), and enriches transformer models with HuggingFace data.
