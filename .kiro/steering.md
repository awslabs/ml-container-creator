# Steering — Development Conventions & Architecture

## Language & Runtime

- **Node.js >=24.11** with ES modules (`"type": "module"` in package.json)
- All source uses `import`/`export` syntax (no CommonJS except `infra/bootstrap-modules/module-runner.cjs`)
- Generated templates use EJS (`.ejs` extensions for server templates, bare files for do/ scripts)
- Python helpers in `templates/do/` (`.tune_helper.py`, `.benchmark_writer.py`, etc.) use Python 3.9+ stdlib + boto3
- CDK stacks in `infra/bootstrap-modules/` are TypeScript (compiled by `cdk` CLI via ts-node, never imported by Node)

## Python SDK Policy

- **SageMaker Python SDK v3** is the preferred interface for all SageMaker operations (training, deployment, model registration, processing jobs)
- **No SageMaker SDK v2** — hard rule, no exceptions. v2 and v3 cannot coexist.
- **boto3 `sagemaker` client** is acceptable only where SDK v3 has no clean equivalent (e.g., Inference Components, advanced endpoint routing). Must be documented with justification.
- **boto3 `sagemaker-runtime`** is acceptable for benchmark invocations where latency precision matters.
- **boto3 for non-SageMaker services** (S3, Glue, Secrets Manager, ECR, CloudWatch) is fine — these are not SageMaker SDK territory.
- Key imports: `from sagemaker.core.resources import Model, Endpoint, TrainingJob, ProcessingJob, ModelPackageGroup, ModelPackage`
- High-level: `from sagemaker.train.sft_trainer import SFTTrainer` / `from sagemaker.serve import ModelBuilder`
- See `.kiro/specs/a-sdk-v3-processing-jobs/research.md` for full API reference.

## Project Structure

```
bin/cli.js                        → CLI entry point (Commander.js)
src/app.js                        → Main orchestrator (4-phase lifecycle)
src/lib/                          → Core modules (~72 files)
src/lib/generated/                → Code-gen'd from parameter-schema-v2.json (DO NOT EDIT)
src/lib/prompts/                  → Interactive wizard prompt modules
src/lib/bootstrap-command-handler.js → Bootstrap orchestration (modular flow)
src/lib/bootstrap-module-selector.js → selectModules, validateDependencies, topologicalSort
src/lib/bootstrap-profile-manager.js → Profile subcommands (status, use, list, remove)
src/agent/                        → Python advisory agent (strands-agents)
templates/                        → EJS templates for generated projects
templates/do/                     → Lifecycle scripts (build, push, deploy, test, tune, etc.)
templates/do/lib/profile.sh       → Bootstrap profile loader (flat key consumption)
servers/                          → Bundled MCP servers (12 servers, self-contained)
servers/lib/                      → Shared server utilities (Bedrock client, catalogs)
config/                           → Schema, presets, module manifest
config/parameter-schema-v2.json   → Single source of truth for all parameters
infra/bootstrap-modules/          → Modular CDK stacks (core, benchmark, registry, training, ci, etc.)
infra/bootstrap-modules/module-manifest.json → Module definitions, dependencies, exports
infra/bootstrap-modules/module-runner.cjs    → CdkModuleRunner (provision/teardown/status)
infra/ci-harness/                 → Legacy CI CDK app (being superseded by ci module)
scripts/                          → Code generation, validation, E2E runner
test/                             → Mocha tests (unit, integration, property-based)
docs/                             → MkDocs site source
```

## Bootstrap Module System

The bootstrap command uses a **modular CDK stack** architecture. Each module is independent:

| Module | Stack suffix | Depends on | Key outputs |
|--------|-------------|------------|-------------|
| core | core | (none) | RoleArn, EcrRepositoryName |
| benchmark | benchmark | core | BenchmarkBucket, GlueDatabase |
| registry | registry | core | AiRegistryHubName, ModelPackageGroupName |
| training | training | core | TrainingBucket, TrainingRoleArn, MlflowAppArn |
| ci | ci | core, benchmark, registry | CodeBuildProject, CiTableName |
| sagemaker-domain | sagemaker-domain | core | DomainId, UserProfileName |
| hyperpod-cluster | **3 stacks** (see below) | core | EksClusterArn, HyperPodClusterArn, InferenceOperatorStatus |

### HyperPod Module (Multi-Stack)

The `hyperpod-cluster` module is the only multi-stack module. It deploys THREE CDK stacks in sequence via `CdkMultiStackModuleRunner`:

1. `eks-cluster` — VPC + EKS control plane + 8 IAM roles (RETAIN) + dependency add-ons
2. `hyperpod-cluster` — `sagemaker.CfnCluster` at 0 instances (RETAIN)
3. `inference-operator` — `amazon-sagemaker-hyperpod-inference` EKS add-on + TLS bucket (RETAIN)

**Key patterns:**
- `module-manifest.json` uses `stacks[]` array instead of `stackNameSuffix` for this module
- The module runner reads SSM params from each completed stack and passes them as `--context` to the next
- `CdkMultiStackModuleRunner` in `module-runner.cjs` orchestrates sequential deploy and reverse teardown
- RETAIN policy: IAM roles, HyperPod cluster, TLS bucket survive normal teardown; only `--force-delete` removes them
- Adopt-existing: if SSM params exist from a prior deploy, sets `adoptX=true` context flags

**Key flows:**
- `bootstrap` (no args) → `_handleLanding` (shows status or getting-started)
- `bootstrap add <profile>` → `_handleInteractiveSetup` (creates profile, provisions modules)
- `bootstrap add-module <module>` → `_handleModuleAdd` (adds one module to active profile)
- `bootstrap update` → re-provisions all modules for active profile
- `bootstrap remove-module <module>` → `_handleModuleRemove` (tears down CDK stack)

**Profile schema:**
- `provisionedModules: string[]` — ordered list of active modules
- `moduleOutputs: { [module]: { [key]: value } }` — CDK stack outputs per module
- Flat keys (`roleArn`, `ecrRepositoryName`, etc.) are **denormalized** from `moduleOutputs` on every save for backward compatibility with `templates/do/lib/profile.sh`

**Dependencies are NOT auto-added.** If a user selects `ci` without `benchmark`, the CLI errors and asks them to include it explicitly. This avoids surprise cost.

## Key Architecture Decisions

### Schema-driven design
`config/parameter-schema-v2.json` is the single source of truth. Run `npm run codegen` to regenerate:
- `src/lib/generated/cli-options.js` — Commander CLI option definitions
- `src/lib/generated/parameter-matrix.js` — Parameter precedence and mapping
- `src/lib/generated/validation-rules.js` — Validation constraints

**Never edit generated files manually.** Edit the schema, run codegen.

Valid parameter phases: `project`, `model`, `infrastructure`, `features`, `build`, `auth`

### Configuration precedence (highest → lowest)
1. CLI options → 2. CLI arguments → 3. Env vars → 4. --config file → 5. config/mcp.json → 6. package.json section → 7. Bootstrap config → 8. Generator defaults → 9. Prompts

### MCP servers are self-contained
Each server in `servers/` has its own `package.json` and can run standalone. They share `servers/lib/` for catalogs and the Bedrock client.

Bundled servers: agent-knowledge, base-image-picker, e2e-status, endpoint-picker, hyperpod-cluster-picker, instance-sizer, marketplace-picker, model-picker, model-registry, region-picker, workload-picker

### Template rendering
- `src/copy-tpl.js` handles EJS rendering with architecture-specific ignore patterns
- Architecture overlays in `templates/` (e.g., `templates/diffusors/`, `templates/triton/`) add/override base files
- `CommentGenerator` injects explanatory comments into generated Dockerfiles

## Coding Standards

### JavaScript
- ESLint with custom rules in `eslint-rules/`
- 4-space indentation, single quotes
- JSDoc comments on all exported functions
- Prefer pure functions; side effects in top-level orchestration only
- Error messages start with emoji prefix (❌, ⚠️, ✅, 🚀, etc.)
- Unused function parameters: prefix with `_` (e.g., `_options`, `_region`)

### Testing
- Mocha + assert (no chai, no sinon)
- Property-based testing with fast-check for validators and schemas
- Tests are organized: `test/unit/`, `test/integration/`, `test/property/`, `test/input-parsing-and-generation/`
- Server tests are standalone (`node servers/<name>/test.js`)
- Mock pattern for bootstrap: override `handler._provisionModules` to avoid real CDK/AWS calls
- Mock pattern for AWS: override `handler._execAws`, `handler._resourceExists`
- Property test config: `test/helpers/property-config.js` (CI uses `PROPERTY_NUM_RUNS=30`)

### Git workflow
- Main development on `dferguson992:main` → PRs to `awslabs:main`
- Husky pre-commit hook runs ESLint via lint-staged
- CI: lint → test:all → coverage → validate servers → validate schemas
- Integration test: install → generate project → verify files

## Key Commands

```bash
npm run test:ci          # Full: lint + test:all (unit + property)
npm run test:unit        # Unit tests only (fast, ~2s)
npm run test:property    # Property-based tests (30s–60s)
npm run test:fast        # All tests, parallel, 15s timeout
npm run codegen          # Regenerate from parameter schema
npm run lint:fix         # Auto-fix lint issues
npm run validate:doc-commands  # Verify docs match CLI
node scripts/validate-schema-v2.js  # Validate parameter schema
node scripts/e2e-runner.js          # Run E2E validation (requires AWS)
```

## CI Pipeline

Two-stage per configuration:
1. **Gate** (15 min): generate → build → push → deploy → test → register
2. **Benchmark** (30 min, non-blocking): benchmark → Athena → DynamoDB

22 golden-path models, 3 tiers: daily ($8), nightly ($35), weekly ($150).

## Common Gotchas

- `from __future__ import annotations` must be the FIRST statement in Python files (after docstrings/comments only)
- `infra/bootstrap-modules/` TypeScript stacks need `npm install` in that directory for CDK deps — tests that don't mock `_provisionModules` will try to run `npx cdk` and fail
- The instance catalog (`servers/lib/catalogs/instances.json`) evolves — tests asserting "not in catalog" may break when instances are added. Use `getInstanceCudaGeneration()` to check current state.
- `_handleInteractiveSetup(options, profileNameArg)` takes an optional second arg (profile name from `bootstrap add <name>`)
- `handle()` arg parsing extracts flags like `--dry-run`, `--with` from positional args (Commander passThroughOptions quirk)

## Release Process

```bash
npm version <patch|minor|major>
npm publish
git push --tags
```

`prepublishOnly` runs lint + full test suite. Version is the source of truth in `package.json`.
