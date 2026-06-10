# Schema-Driven Architecture

ML Container Creator uses a schema-driven architecture where a single JSON file (`config/parameter-schema-v2.json`) is the source of truth for all 68 CLI parameters. Four code generators read this schema and produce CLI registration, validation rules, a parameter loading matrix, and documentation widget data.

No parameter can exist without a schema entry. No schema entry can drift from generated code. CI enforces this invariant on every PR.

---

## How It Works

```
config/parameter-schema-v2.json (source of truth)
         │
         ├── codegen-cli.js              → src/lib/generated/cli-options.js
         ├── codegen-validator.js         → src/lib/generated/validation-rules.js
         ├── codegen-parameter-matrix.js  → src/lib/generated/parameter-matrix.js
         └── codegen-widget.js           → docs/data/schema-manifest.json
```

### Generated Outputs

| Script | Output | Consumer |
|--------|--------|----------|
| `codegen-cli.js` | `src/lib/generated/cli-options.js` | `bin/cli.js` — registers all CLI options in a loop |
| `codegen-validator.js` | `src/lib/generated/validation-rules.js` | `ConfigManager` — validates parameter values at runtime |
| `codegen-parameter-matrix.js` | `src/lib/generated/parameter-matrix.js` | `ConfigManager` — defines how each param loads from CLI, env vars, config files, MCP |
| `codegen-widget.js` | `docs/data/schema-manifest.json` | Command Generator page — renders interactive form fields |

### How CLI Options Are Consumed

`bin/cli.js` imports the generated `cliOptions` array and registers each entry with Commander.js:

```javascript
import { cliOptions, helpGroups } from '../src/lib/generated/cli-options.js';

for (const opt of cliOptions) {
    if (opt.hidden) continue;
    const option = new Option(opt.flag, opt.description);
    if (opt.choices) option.choices(opt.choices);
    if (opt.repeatable) option.argParser(collect);
    program.addOption(option);
}
```

This means adding a parameter to the schema automatically adds it to the CLI — no manual Commander registration needed.

---

## Adding a New Parameter

### Step 1: Add the Schema Entry

Edit `config/parameter-schema-v2.json` and add your parameter to the `parameters` object:

```json
"quantization": {
    "type": "enum",
    "description": "Model quantization method",
    "cliFlag": "--quantization",
    "cliArgName": "type",
    "envVar": "ML_QUANTIZATION",
    "templateVar": "quantization",
    "configKey": "quantization",
    "default": null,
    "validation": { "enum": ["awq", "gptq", "fp8", "none"] },
    "phase": "model",
    "group": "model",
    "appliesTo": {
        "deploymentTargets": ["*"],
        "architectures": ["transformers"]
    },
    "widget": {
        "section": "model-server",
        "inputType": "select"
    },
    "prompt": {
        "message": "Quantization method?",
        "type": "list",
        "when": "architecture === 'transformers'"
    },
    "deprecated": false,
    "since": "0.11.0"
}
```

### Step 2: Regenerate All Downstream Files

```bash
npm run codegen
```

This runs all four codegen scripts in sequence:
1. `codegen-cli.js` — updates CLI option definitions
2. `codegen-validator.js` — updates validation functions
3. `codegen-widget.js` — updates the docs widget manifest
4. `codegen-parameter-matrix.js` — updates the config loading matrix

### Step 3: Write Template Logic

Use the parameter in EJS templates. The variable name is whatever you set in `templateVar`:

```ejs
<%# In templates/Dockerfile or templates/code/serve %>
<% if (quantization && quantization !== 'none') { %>
ENV VLLM_QUANTIZATION=<%= quantization %>
<% } %>
```

For `do/` scripts, the parameter is exported as an environment variable in `do/config`:

```bash
# templates/do/config (EJS template)
export QUANTIZATION="<%= quantization %>"
```

### Step 4: Add Validation (if needed)

The `validation` field in the schema drives automatic validation:
- `enum` → value must be in the list
- `min`/`max` → numeric range
- `minLength`/`maxLength` → string length
- `pattern` → regex match

If your parameter needs cross-cutting validation (e.g., "quantization requires a GPU instance"), that lives in the [Validation System](validation-system.md).

### Step 5: Run Tests

```bash
npm test                       # Unit + integration
npm run test:property          # Property-based validation tests
node scripts/validate-schema-v2.js   # Schema well-formedness
```

The property-based tests automatically pick up new schema entries and verify validation correctness.

### Step 6: Commit Everything

```bash
git add config/parameter-schema-v2.json \
        src/lib/generated/ \
        docs/data/schema-manifest.json
```

!!! warning "Always commit generated files"
    Generated files are checked into git so the project works without running codegen first. `npm install && npm link` gives a working CLI immediately. CI will fail if generated files are stale.

---

## Schema Entry Reference

### Required Fields

| Field | Type | Purpose |
|-------|------|---------|
| `type` | string | `string`, `integer`, `number`, `boolean`, `enum` |
| `description` | string | Human-readable description (used in `--help` and widget labels) |
| `cliFlag` | string | CLI option flag (e.g., `--quantization`) |
| `configKey` | string | Key in config JSON files and internal config objects |
| `phase` | string | Prompting phase: `project`, `model`, `infrastructure`, `features`, `build`, `auth` |
| `group` | string | Logical group (see below) |
| `appliesTo` | object | Conditional applicability (see below) |
| `deprecated` | boolean | `true` hides from CLI `--help` output |
| `since` | string | Version the parameter was introduced |

### Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `cliArgName` | string | Placeholder shown in help (e.g., `<type>`). Omit for boolean flags. |
| `envVar` | string | Environment variable for config loading (e.g., `ML_QUANTIZATION`) |
| `templateVar` | string | EJS template variable name |
| `default` | any | Default value (`null` if required) |
| `validation` | object | Rules: `enum`, `min`, `max`, `minLength`, `maxLength`, `pattern` |
| `widget` | object/null | `{ section, inputType, placeholder?, datalist? }`. `null` to exclude from widget. |
| `prompt` | object/null | `{ message, type, when? }`. `null` for non-interactive params. |
| `sensitive` | boolean | `true` for secrets — won't be echoed in generated commands |
| `repeatable` | boolean | `true` for flags that can be specified multiple times (e.g., `--model-env`) |
| `cliBehavior` | boolean | `true` for flags that control CLI behavior, not project config |
| `replacedBy` | string | For deprecated params, which param replaces it |
| `serverMapping` | object | `{ envVar?, icConfVar?, booleanFlag? }` — how this maps to server runtime config |

### Groups

Groups organize parameters logically for help output and widget sections:

| Group | Parameters | Example |
|-------|-----------|---------|
| `project` | Project identity | `projectName`, `deploymentConfig`, `deploymentTarget` |
| `model` | Model configuration | `modelName`, `modelFormat`, `modelEnv` |
| `infrastructure` | AWS resources | `instanceType`, `region`, `roleArn` |
| `inference-component` | IC sizing | `icGpuCount`, `icMemorySize`, `icCpuCount`, `icCopyCount` |
| `endpoint` | Endpoint config | `endpointInitialInstanceCount`, `endpointVolumeSize` |
| `lora` | LoRA adapter settings | `enableLora`, `maxLoras`, `loraModules` |
| `benchmark` | Benchmarking params | `benchmarkConcurrency`, `benchmarkDuration` |
| `auth` | Authentication | `hfToken`, `secretsArn` |
| `build` | Build settings | `buildTarget`, `baseImage` |
| `async` | Async inference | `asyncS3OutputPath`, `asyncSnsSuccessTopic` |
| `batch` | Batch transform | `batchInputPath`, `batchOutputPath`, `batchStrategy` |
| `hyperpod` | HyperPod EKS | `hyperpodCluster`, `hyperpodNamespace` |
| `testing` | Test settings | `cliReadTimeout`, `testPayload` |

### appliesTo — Conditional Parameters

The `appliesTo` field controls when a parameter is relevant:

```json
"appliesTo": {
    "deploymentTargets": ["realtime-inference", "async-inference"],
    "architectures": ["transformers", "diffusors"]
}
```

- `["*"]` means the parameter applies to all targets/architectures
- Specific values mean the parameter is only shown in prompts, validated, and rendered in the widget when the user's configuration matches

The parameter matrix generator uses `appliesTo` to determine which parameters are prompted, and the widget uses it to show/hide form fields dynamically.

---

## The Parameter Matrix

The parameter matrix (`src/lib/generated/parameter-matrix.js`) defines the loading precedence for each parameter:

```javascript
export const parameterMatrix = {
    "modelName": {
        "cliOption": "model-name",       // CLI flag (sans --)
        "envVar": "ML_MODEL_NAME",       // Environment variable
        "configFile": true,              // Can be set in config JSON
        "packageJson": false,            // Can be set in package.json
        "mcp": true,                     // Can be populated by MCP servers
        "promptable": true,              // Shown in interactive prompts
        "required": false,               // Hard requirement
        "default": null,                 // Default if unset
        "valueSpace": "unbounded"        // "bounded" (enum) or "unbounded" (free text)
    }
}
```

`ConfigManager` reads this matrix to load parameters in precedence order:
1. CLI flags (highest priority)
2. Environment variables
3. Config file (`mcc.config.json`)
4. MCP server responses
5. Interactive prompts
6. Defaults (lowest priority)

---

## Widget Integration

The Command Generator page on the docs site uses `docs/data/schema-manifest.json` to render an interactive form. The widget:

1. Reads the manifest at page load
2. Groups parameters by `widget.section`
3. Renders the appropriate input type (`text`, `select`, `number`, `checkbox`)
4. Shows/hides fields based on `appliesTo` rules (reacts to deployment config selection)
5. Builds the complete `ml-container-creator` command string from form state

To exclude a parameter from the widget (e.g., internal flags), set `"widget": null` in the schema.

Widget coverage is tracked in `docs/data/widget-coverage.json`. Every parameter must be either included in the widget or explicitly excluded. CI enforces this.

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run codegen` | Regenerate all 4 output files from schema |
| `npm run codegen:check` | Regenerate + verify parity (for CI) |
| `node scripts/validate-schema-v2.js` | Validate schema well-formedness + CLI coverage |
| `node scripts/sync-command-generator.js --check` | Verify widget coverage is complete |
| `node scripts/schema-template-coverage.js --strict` | Verify all parameters are used in templates |

---

## CI Enforcement

On every PR, CI runs three schema-related checks (in `.github/workflows/ci.yml`):

1. **`sync-command-generator.js --check`** — Fails if a CLI flag isn't covered by the widget
2. **`validate-schema-v2.js`** — Fails if a CLI flag exists without a schema entry
3. **`schema-template-coverage.js --strict`** — Fails if a parameter isn't used in any template

The docs workflow (`.github/workflows/docs.yml`) also runs `npm run codegen` before `mkdocs build` to ensure the widget manifest is fresh.

### What CI Catches

| Scenario | Error |
|----------|-------|
| New CLI flag added without schema entry | `❌ CLI flags not in schema: --quantization` |
| Schema changed but codegen not run | `❌ Generated code is stale` (codegen:check) |
| New parameter not in widget coverage | `❌ CLI option --quantization is not covered or excluded` |
| New parameter not used in any template | `❌ templateVar 'quantization' has no template usage` |

---

## File Locations

| File | Purpose |
|------|---------|
| `config/parameter-schema-v2.json` | Source of truth (68 parameters) |
| `src/lib/generated/cli-options.js` | Generated CLI option definitions |
| `src/lib/generated/validation-rules.js` | Generated validation functions |
| `src/lib/generated/parameter-matrix.js` | Generated config loading matrix |
| `docs/data/schema-manifest.json` | Generated widget data for Command Generator |
| `docs/data/widget-coverage.json` | Widget coverage declarations |
| `scripts/codegen-cli.js` | CLI option generator |
| `scripts/codegen-validator.js` | Validation rule generator |
| `scripts/codegen-parameter-matrix.js` | Parameter matrix generator |
| `scripts/codegen-widget.js` | Widget manifest generator |
| `scripts/codegen-parity.js` | Parity verification (used by `codegen:check`) |
| `scripts/validate-schema-v2.js` | Schema validation (CLI coverage) |
| `scripts/sync-command-generator.js` | Widget coverage enforcement |
| `scripts/schema-template-coverage.js` | Template usage enforcement |
| `src/lib/parameter-schema-validator.js` | Runtime parameter validation (endpoint/IC constraints) |

---

## Design Decisions

**Why not use Zod/oclif/citty?**
No single library covers the full chain (CLI → prompts → templates → widget → validation). Our codegen scripts are 60–90 lines each and purpose-built for MCC's specific needs. Adopting a library would add a dependency without reducing complexity.

**Why JSON not TypeScript?**
The schema is consumed by multiple tools (Node.js scripts, the docs widget in the browser, CI checks). JSON is universally parseable without a build step.

**Why generated code checked into git?**
So the project works without running codegen first. `npm install && npm link` gives you a working CLI immediately. The CI checks ensure the checked-in generated code is never stale.

**Why a parameter matrix?**
Before the matrix, `ConfigManager` had a hand-written 726-line `_getParameterMatrix()` method that duplicated schema information. The codegen approach eliminated that duplication — now the schema is the only place parameter metadata is defined.
