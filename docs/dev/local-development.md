# Local Development

Get from clone to running tests in under 10 minutes.

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| **Node.js** | ≥ 24.11.1 | `node --version` |
| **npm** | ≥ 11.6.2 | `npm --version` |
| **AWS CLI** | v2 | `aws --version` |
| **Docker** | Any recent | `docker --version` |
| **Python** | 3.10+ (for docs only) | `python3 --version` |

!!! tip "Use nvm for Node.js"
    ```bash
    nvm install 24
    nvm use 24
    ```

---

## Quick Setup

```bash
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator
nvm use node
npm install
npm link          # Makes 'ml-container-creator' available globally
npm test          # Verify everything works
```

After `npm link`, you can run the CLI directly:

```bash
ml-container-creator --help
ml-container-creator bootstrap status
```

Or run without global install:

```bash
node bin/cli.js --help
```

---

## Project Structure

```
ml-container-creator/
├── bin/
│   └── cli.js                          # CLI entry point (commander)
├── src/
│   ├── app.js                          # Main generator orchestrator
│   ├── copy-tpl.js                     # EJS template renderer
│   ├── prompt-adapter.js               # @inquirer/prompts adapter
│   └── lib/                            # 76+ modules:
│       ├── cli-handler.js              # Subcommand dispatch (bootstrap, mcp, registry, secrets)
│       ├── config-manager.js           # 8-level configuration precedence
│       ├── prompt-runner.js            # Phased prompt orchestration
│       ├── template-manager.js         # Configuration validation
│       ├── template-engine.js          # EJS rendering helpers
│       ├── template-variable-resolver.js # Template context building
│       ├── deployment-config-resolver.js # "transformers-vllm" → {arch, backend}
│       ├── configuration-manager.js    # Registry-based config matching
│       ├── registry-loader.js          # Catalog JSON → internal shapes
│       ├── mcp-client.js              # MCP server communication
│       ├── mcp-query-runner.js        # Spawn + query MCP servers
│       ├── schema-validation-engine.js # Plugin-based validation
│       ├── parameter-schema-validator.js # Schema-driven param validation
│       ├── bootstrap-command-handler.js # 'bootstrap' subcommand tree
│       ├── secrets-command-handler.js  # 'secrets' subcommand tree
│       └── ...                         # Validators, helpers, handlers
├── templates/
│   ├── Dockerfile                      # Main Dockerfile (EJS, branching by architecture)
│   ├── code/                           # Server code templates (serve, model_handler, etc.)
│   ├── do/                             # Lifecycle scripts (build, push, deploy, test, etc.)
│   ├── triton/                         # Triton-specific templates
│   ├── diffusors/                      # Diffusors-specific templates
│   └── marketplace/                    # Marketplace templates
├── servers/
│   ├── instance-sizer/                 # MCP: Instance recommendation
│   ├── region-picker/                  # MCP: Region filtering
│   ├── base-image-picker/             # MCP: Docker base image selection
│   ├── model-picker/                  # MCP: HuggingFace model discovery
│   ├── hyperpod-cluster-picker/       # MCP: HyperPod EKS cluster discovery
│   ├── e2e-status/                    # MCP: E2E validation status
│   └── lib/                           # Shared catalogs, schemas, utilities
├── config/
│   ├── parameter-schema-v2.json       # Source of truth for all 68 CLI parameters
│   ├── tune-catalog.json              # Fine-tuning model catalog
│   ├── bootstrap-stack.json           # CloudFormation template for bootstrap
│   ├── defaults.json                  # Default values
│   └── presets/                       # Pre-built configuration presets
├── scripts/
│   ├── codegen-cli.js                 # Generates src/lib/generated/cli-options.js
│   ├── codegen-validator.js           # Generates src/lib/generated/validation-rules.js
│   ├── codegen-widget.js             # Generates docs/data/schema-manifest.json
│   ├── codegen-parameter-matrix.js   # Generates src/lib/generated/parameter-matrix.js
│   ├── e2e-runner.js                 # End-to-end test orchestrator
│   ├── validate-*.js                 # Various validation scripts
│   └── sync-*.js                     # Sync scripts (schemas, model families)
├── test/
│   ├── unit/                          # Individual module tests
│   ├── property/                      # fast-check property-based tests
│   ├── input-parsing-and-generation/  # End-to-end generation tests
│   ├── integration/                   # MCP client-server integration
│   └── servers/                       # MCP server tests
├── infra/
│   └── ci-harness/                    # CDK stack for CI infrastructure
├── docs/                              # MkDocs documentation source
└── .github/workflows/                 # CI: test, lint, docs deploy
```

---

## Running the Generator Locally

### Interactive mode

```bash
ml-container-creator
```

### Non-interactive (skip all prompts)

```bash
ml-container-creator my-project \
  --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B \
  --instance-type=ml.g5.xlarge \
  --deployment-target=realtime-inference \
  --region=us-east-1 \
  --skip-prompts
```

### Testing code changes without re-linking

If you've already run `npm link`, changes to `src/` and `templates/` take effect immediately — no rebuild needed (it's pure JavaScript, no compilation).

---

## Running Tests

| Command | What It Runs | Speed |
|---|---|---|
| `npm test` | All tests (unit + property + integration) | ~30s |
| `npm run test:fast` | All tests in parallel with reduced property runs | ~10s |
| `npm run test:unit` | Unit tests only | ~5s |
| `npm run test:property` | Property-based tests (fast-check) | ~15s |
| `npm run test:integration` | Generation + parsing tests | ~10s |
| `npm run test:servers` | MCP server standalone tests | ~5s |
| `npm run test:watch` | Watch mode — re-runs on file change | continuous |
| `npm run test:coverage` | Tests + coverage report (nyc) | ~45s |

### Targeted testing

```bash
# Run a specific test file
npx mocha test/unit/bootstrap-subcommands.test.js

# Run tests matching a pattern
npm test -- --grep "CLI Options"
npm test -- --grep "sklearn"
```

### What CI runs

The CI pipeline (`npm run test:ci`) runs:
1. Unit + integration + generation + server tests (in parallel)
2. Property-based tests (sequential — they're CPU-intensive)
3. `npm run lint`
4. `node scripts/validate-servers.js`
5. `node scripts/validate-namespaces.js`
6. `node scripts/sync-command-generator.js --check`
7. `node scripts/validate-schema-v2.js`

---

## Running Codegen

The codegen pipeline reads `config/parameter-schema-v2.json` and generates downstream files:

```bash
npm run codegen
```

This runs 4 scripts:

| Script | Reads | Produces |
|---|---|---|
| `codegen-cli.js` | `parameter-schema-v2.json` | `src/lib/generated/cli-options.js` (CLI flag registrations) |
| `codegen-validator.js` | `parameter-schema-v2.json` | `src/lib/generated/validation-rules.js` (runtime validation) |
| `codegen-widget.js` | `parameter-schema-v2.json` | `docs/data/schema-manifest.json` (Command Generator widget) |
| `codegen-parameter-matrix.js` | `parameter-schema-v2.json` | `src/lib/generated/parameter-matrix.js` (parameter applicability) |

!!! warning "Always run codegen after changing parameter-schema-v2.json"
    If generated files are stale, CI will fail. The freshness check is:
    ```bash
    npm run codegen
    git diff --exit-code -- src/lib/generated/ docs/data/
    ```

---

## Running Docs Locally

```bash
# Install docs dependencies (one-time)
pip install mkdocs mkdocs-material

# Start live-reload server at http://127.0.0.1:8000
npm run docs:serve
# or: mkdocs serve

# Build static site (checks for broken links with --strict)
npm run docs:build
# or: mkdocs build --strict
```

!!! tip "Run codegen first"
    The Command Generator page depends on `docs/data/schema-manifest.json`. Run `npm run codegen` before `mkdocs serve` if you've changed the parameter schema.

---

## Environment Variables for Development

| Variable | Purpose | Default |
|---|---|---|
| `VALIDATE_ENV_VARS=false` | Disables env var validation in tests (required) | Set by all test scripts |
| `PROPERTY_NUM_RUNS=10` | Reduces property-test iterations for faster feedback | 100 |
| `AWS_PROFILE` | AWS profile for integration testing (bootstrap, deploy) | `default` |
| `AWS_REGION` | Default region for tests that hit AWS | `us-east-1` |
| `HF_TOKEN` | HuggingFace token (only for gated model tests) | — |

---

## Debugging

### Debugging the generator

```bash
# Node.js inspector
node --inspect bin/cli.js my-project --skip-prompts --deployment-config=http-flask

# Then open chrome://inspect in Chrome
```

### Debugging MCP servers

MCP servers run as child processes over stdio. To test one standalone:

```bash
cd servers/instance-sizer
node test.js
```

Or invoke a server directly with the MCP CLI:

```bash
ml-container-creator mcp query instance-sizer '{"framework": "transformers", "modelSizeGb": 8}'
```

### Debugging template rendering

Add console.log in `src/app.js` during the writing phase, or use `--dry-run` (if available) to see what would be generated without writing files.

### Debugging test failures

```bash
# Verbose output
npm run test:verbose

# Single file with full stack traces
npx mocha test/unit/config-manager-unit.test.js --reporter spec --timeout 60000
```

---

## Common Development Workflows

### "I want to add a new CLI parameter"

1. Edit `config/parameter-schema-v2.json`
2. Run `npm run codegen`
3. Add template logic in `templates/` that uses the new parameter
4. Add tests
5. See [Schema-Driven Architecture](schema-driven-architecture.md) for the full guide

### "I want to add a new deployment configuration"

1. Add to deployment config choices in `src/lib/prompts.js`
2. Add validation in `src/lib/template-manager.js`
3. Add case statements in `templates/do/build`, `deploy`, `test`, `clean`
4. Add base image entry in `servers/base-image-picker/catalogs/model-servers.json`
5. See [Template System](template-system.md) for the full guide

### "I want to add or modify an MCP server"

1. Create/edit `servers/<name>/index.js`
2. Define tools using `@modelcontextprotocol/sdk`
3. Add catalog data in `servers/<name>/catalogs/`
4. Write `servers/<name>/test.js`
5. See [MCP Server Development](mcp-server-development.md) for the full guide

### "I want to fix a bug in do/ scripts"

1. Templates are in `templates/do/<script-name>` (EJS)
2. Edit the template — changes take effect on next `ml-container-creator` invocation
3. Test by generating a project and running the script:
   ```bash
   ml-container-creator test-project --deployment-config=transformers-vllm --skip-prompts
   cd test-project
   ./do/build
   ```
4. For template logic bugs, add a test in `test/input-parsing-and-generation/`

### "I want to add a model to the tune catalog"

1. Edit `config/tune-catalog.json`
2. Run `node scripts/validate-catalog-enums.js` to validate
3. Add a test case if introducing new techniques or constraints

---

## PR Checklist

Before submitting a PR, verify:

- [ ] `npm run lint` passes (or `npm run lint:fix` to auto-fix)
- [ ] `npm test` passes
- [ ] If you changed `config/parameter-schema-v2.json`: ran `npm run codegen` and committed generated files
- [ ] If you changed MCP server catalogs: `node scripts/validate-servers.js` passes
- [ ] If you changed namespaces: `node scripts/validate-namespaces.js` passes
- [ ] If you changed docs: `mkdocs build --strict` passes (no broken links)
- [ ] New code has corresponding tests (unit or property)
- [ ] Commit messages follow conventional format

CI will run all of the above automatically on your PR.

---

## Useful npm Scripts Reference

| Script | Purpose |
|---|---|
| `npm test` | Run all tests |
| `npm run test:fast` | Fast parallel test run |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Tests + coverage |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint auto-fix |
| `npm run codegen` | Regenerate all files from parameter schema |
| `npm run validate` | Lint + all tests (pre-push gate) |
| `npm run validate:catalogs` | Validate catalog enum consistency |
| `npm run docs:serve` | Local docs server |
| `npm run docs:build` | Build static docs |
| `npm run dev` | npm link + run generator |
| `npm run clean` | Remove test output directories |
