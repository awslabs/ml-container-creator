# Schema-Driven Architecture

ML Container Creator uses a schema-driven architecture where a single JSON file (`config/parameter-schema-v2.json`) is the source of truth for all 68 CLI parameters. Code generators read this schema and produce CLI registration, validation rules, and documentation widget data.

## How It Works

```
config/parameter-schema-v2.json
         │
         ├── codegen-cli.js       → src/lib/generated/cli-options.js
         ├── codegen-validator.js  → src/lib/generated/validation-rules.js
         └── codegen-widget.js    → docs/data/schema-manifest.json
```

`bin/cli.js` imports the generated CLI options and registers them in a loop. The command generator widget on the docs site reads `schema-manifest.json` to render form fields. CI validates everything stays in sync.

## Adding a New Parameter

1. Add an entry to `config/parameter-schema-v2.json`:

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
    "appliesTo": { "deploymentTargets": ["*"], "architectures": ["transformers"] },
    "widget": { "section": "model-server", "inputType": "select" },
    "prompt": { "message": "Quantization method?", "type": "list", "when": "architecture === 'transformers'" },
    "deprecated": false,
    "since": "0.9.0"
}
```

2. Regenerate all downstream files:

```bash
npm run codegen
```

3. Write the template logic that uses the parameter:

```ejs
<%# In templates/code/serve or templates/Dockerfile %>
<% if (quantization && quantization !== 'none') { %>
ENV VLLM_QUANTIZATION=<%= quantization %>
<% } %>
```

4. Commit everything:

```bash
git add config/parameter-schema-v2.json src/lib/generated/ docs/data/
```

## Schema Entry Reference

| Field | Required | Purpose |
|-------|----------|---------|
| `type` | ✅ | `string`, `integer`, `number`, `boolean`, `enum` |
| `description` | ✅ | Human-readable description (used in CLI --help and widget labels) |
| `cliFlag` | ✅ | CLI option flag (e.g. `--quantization`) |
| `cliArgName` | | Argument placeholder (e.g. `<type>`). Omit for boolean flags. |
| `envVar` | | Environment variable name for config loading |
| `templateVar` | | EJS template variable name |
| `configKey` | ✅ | Key in config JSON files |
| `default` | | Default value (null if required) |
| `validation` | | Rules: `enum`, `min`, `max`, `minLength`, `maxLength`, `pattern` |
| `phase` | ✅ | Prompting phase: `project`, `model`, `infrastructure`, `features`, `build`, `auth` |
| `group` | ✅ | Logical group: `project`, `model`, `infrastructure`, `inference-component`, `lora`, `benchmark`, `auth`, `build`, `async`, `batch`, `hyperpod`, `endpoint`, `testing` |
| `appliesTo` | ✅ | `{ deploymentTargets: [...], architectures: [...] }` — use `["*"]` for all |
| `widget` | | Widget config: `{ section, inputType, placeholder?, datalist? }`. Set to `null` to exclude from widget. |
| `prompt` | | Prompt config: `{ message, type, when? }`. Set to `null` for non-interactive params. |
| `deprecated` | ✅ | `true` hides from CLI help |
| `since` | ✅ | Version introduced |

Optional fields:

| Field | Purpose |
|-------|---------|
| `sensitive` | `true` for secrets (won't be echoed in generated commands) |
| `repeatable` | `true` for flags that can be specified multiple times (e.g. `--model-env`) |
| `cliBehavior` | `true` for flags that control CLI behavior, not project config |
| `replacedBy` | For deprecated params, which param replaces it |
| `serverMapping` | `{ envVar?, icConfVar?, booleanFlag? }` — how this maps to server config |

## Commands

| Command | Purpose |
|---------|---------|
| `npm run codegen` | Regenerate all files from schema |
| `npm run codegen:check` | Regenerate + verify parity (CI) |
| `node scripts/validate-schema-v2.js` | Validate schema well-formedness + CLI coverage |

## CI Enforcement

On every PR, CI runs:

1. **`validate-schema-v2.js`** — Fails if a CLI flag exists without a schema entry
2. **`codegen:check`** — Fails if generated files are stale
3. **`sync-command-generator.js --check`** — Fails if widget coverage is incomplete

### What CI catches

| Scenario | Error |
|----------|-------|
| New CLI flag added without schema entry | `❌ CLI flags not in schema: --quantization` |
| Schema changed but codegen not run | `❌ Generated code is stale` |
| New parameter not declared in widget coverage | `❌ CLI option --quantization is not covered or excluded` |

## File Locations

| File | Purpose |
|------|---------|
| `config/parameter-schema-v2.json` | Source of truth (68 parameters) |
| `src/lib/generated/cli-options.js` | Generated CLI option definitions |
| `src/lib/generated/validation-rules.js` | Generated validation functions |
| `docs/data/schema-manifest.json` | Generated widget data |
| `docs/data/widget-coverage.json` | Widget coverage declarations |
| `scripts/codegen-cli.js` | CLI option generator |
| `scripts/codegen-validator.js` | Validation rule generator |
| `scripts/codegen-widget.js` | Widget manifest generator |
| `scripts/codegen-parity.js` | Parity verification |
| `scripts/validate-schema-v2.js` | Schema validation |

## Design Decisions

**Why not use Zod/oclif/citty?** No single library covers the full chain (CLI → prompts → templates → widget → validation). Our codegen scripts are 60-90 lines each and purpose-built for our specific needs. Adopting a library would add a dependency without reducing complexity.

**Why JSON not TypeScript?** The schema is consumed by multiple tools (Node.js scripts, the docs widget in the browser, CI checks). JSON is universally parseable without a build step.

**Why generated code checked into git?** So the project works without running codegen first. `npm install && npm link` gives you a working CLI immediately. The CI check ensures the checked-in generated code is never stale.
