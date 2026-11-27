# ml-container-creator (MLCC)

<!--
Maintainer notes (HTML comments are stripped before Claude sees this file).
- Steering layout: this file is always loaded; `.claude/rules/*.md` hold the rest.
  Rules without `paths:` frontmatter load every session; rules with `paths:` load
  only when Claude touches a matching file.
- Steering states RULES and POINTS AT sources of truth. Never put counts or
  inventories here ("13 servers", "~90 modules") — they rot. Point at the
  directory or the generator instead.
- test/unit/claude-steering-drift.test.js checks that every repo path cited in
  this file and in .claude/rules/ exists, that every `paths:` glob matches a file,
  and that no bare inventory counts creep back in.
-->

## What this is
`@aws/ml-container-creator` (`mcc` / `ml-container-creator`) is a Node CLI that generates a
self-contained **bring-your-own-container ML serving project** for AWS, plus the tooling
around it:

- **Generator** (`bin/cli.js`, `src/app.js`, `src/lib/`): renders EJS `templates/` into a project
  with a Dockerfile, serving code (vLLM, SGLang, TensorRT-LLM, LMI, llama.cpp,
  Triton, Flask/FastAPI predictors, vLLM-Omni diffusors) and `do/*` lifecycle scripts.
- **Generated-project runtime** (`templates/do/`): bash + Python scripts (build, push, deploy,
  test, benchmark, tune, train, register, adapter, optimize, …) that run in the USER's project,
  not in this repo. Deployment targets: SageMaker real-time / async / batch, HyperPod-EKS, plain EKS.
- **Bootstrap** (`infra/bootstrap-modules/`): modular CDK stacks provisioned once per account.
- **MCP servers** (`servers/`): bundled "picker" servers + catalogs. They are MLCC's product,
  not dev tooling.
- **Advisory agent** (`src/agent/`): the Python Strands/Bedrock agent behind `mcc hey`.

The primary maintainer is an AI agent. Optimise for "can one file be loaded and edited
correctly without spidering the tree" (ADR-002): one source of truth per fact, module header
docblocks, ADRs for structural decisions.

## Hard product rules (non-negotiable)
- **SageMaker Python SDK v3 only. No SDK v2, ever.** boto3 `sagemaker` only where v3 has no
  clean equivalent (document why); boto3 `sagemaker-runtime` is fine for benchmark invocations;
  boto3 for non-SageMaker services is fine.
- **HyperPod serving goes through the SageMaker HyperPod inference operator** (the
  `InferenceEndpointConfig` CRD). Don't add a parallel non-operator serving path for
  `hyperpod-eks`. Engine behaviour there (vLLM by default, plus SGLang including speculative
  decoding, `docs/hyperpod-speculative-decoding.md`) comes from the `serve.d` manifests, not
  from per-engine branches.
- **Consume, don't provision, clusters** (ADR-012). HyperPod cluster provisioning is deprecated.
- **Flexible Training Plan (`trainingPlanArn`) is NOT a bootstrap input** (no option, SSM value
  or CDK context). Integration point is undecided — ask before implementing.
- **MLflow registered model names must not contain `/`** (MLflow #8801). Use `--` between
  family/variant and `__` between sub-components.
- **Bootstrap module dependencies are never auto-added** — error and ask (cost surprise).
- **Agents make no live AWS calls** and write no tests that need credentials. Account probes
  are owner-run; record results, don't fake them.

## Sources of truth — derive, never re-declare
| Fact | Source | Consumers / how to regenerate |
|---|---|---|
| CLI parameters, validation rules, precedence | `config/parameter-schema-v2.json` | `npm run codegen` → `src/lib/generated/` |
| Deployment-target contract | `templates/do/targets.d/<target>/manifest.json` | `src/lib/target-manifest-reader.js`, `templates/do/lib/python/target_manifest.py`, codegen'd blocks |
| Serving-engine contract | `templates/code/serve.d/<engine>/manifest.json` | `src/lib/serve-manifest-reader.js`, `templates/do/lib/python/serve_manifest.py` |
| Tune techniques | `templates/code/tune.d/<technique>/manifest.json` | `src/lib/tune-manifest-reader.js` |
| Predictor frameworks | `templates/code/predictors.d/<fw>/manifest.json` | `src/lib/predictor-manifest-reader.js` |
| Bootstrap modules | `infra/bootstrap-modules/module-manifest.json` | `src/lib/bootstrap-module-selector.js`, `infra/bootstrap-modules/module-runner.cjs` |
| Bucket names | per-stack `buckets.json` | `infra/bootstrap-modules/bucket-declarations.ts` / `.cjs` |
| Catalogs (instances, models, images, pricing) | `servers/lib/catalogs/` | MCP servers, instance sizer |

Full rules: `.claude/rules/derive-dont-hardcode.md`. Decisions: `docs/adr/`. Subsystem
explainers: `docs/architecture/`.

## Commands
```bash
npm run lint                 # eslint src/ servers/ bin/
npm test                     # mocha, everything except property tests (parallel)
npm run test:unit            # fast unit subset
npm run test:property        # fast-check property tests (slow; CI uses PROPERTY_NUM_RUNS=30)
npm run test:node            # node-native tests (scripts/run-node-tests.js)
npm run test:servers         # MCP server tests (custom node:assert harness, not mocha)
python3 -m pytest            # Python suites in tests/ and test/ (see pyproject.toml)
npm run codegen              # regenerate from the schema + descriptors (must be idempotent)
npm run validate:doc-commands  # docs ↔ CLI
```
There is no `npm run generate`. Release: `npm version <level> && npm publish && git push --tags`
(`prepublishOnly` runs lint + tests). Do not infer implementation status from the
`package.json` version.

## Commit gate
`.husky/pre-commit` is the live gate (`core.hooksPath` points at husky's generated `_` directory). In order: reject hardcoded
`numRuns` in staged property tests; `lint-staged`; `ast.parse` on staged `.py` (skips EJS
templates); codegen freshness when schema / codegen scripts / catalogs are staged; catalog and
tune-manifest validation; `node scripts/sync-command-generator.js --check`; `tsc` build of
`infra/bootstrap-modules` when `.ts` is staged; strip `__pycache__`. Never bypass with
`--no-verify`.

## Working rules
- **Generated code:** never edit `src/lib/generated/**` or anything between
  `# >>> GENERATED` / `# <<< END GENERATED` markers — not with Edit/Write, not with `sed -i`,
  not with shell redirection. Edit the schema/descriptor and run `npm run codegen`. A hook
  (`.claude/hooks/guard-generated.mjs`) and a deny rule enforce this.
- **Ask before** `git commit`, `git push`, `npm publish`, `npm version`, `npx cdk`, `aws`, and
  `node scripts/e2e-runner.js`. If on `main`, branch first. Stage files by name.
- **Plan first** for anything non-trivial: state the premise, verify it against the code
  (cite `file:line`), then change. Plans and reports go in `docs/dev/` when they should outlive
  the session.
- **Test vs code:** when a test fails, decide which side is wrong from the ADRs, specs, committed
  behaviour and git history — not from which is easier to change. Never fabricate data to make
  a test pass; use a documented skip.
- **Help text lands with the behaviour.** Never advertise a verb, flag or option in help, docs or
  `do/*` usage before it is implemented.
- **Every duplicate needs a wired drift check.** A conformance test that is not reachable from a
  CI script is not a check.
- More rules load automatically by area — see `.claude/rules/`.

## Project history
`.kiro/` is a **read-only archive** from the Kiro era: specs (`.kiro/specs/<name>/`), trackers
(`.kiro/v2.0-tracker.md`), the backlog (`.kiro/backlog.jsonl`), lessons learned and wave reports.
Mostly gitignored (local to this checkout). Read it for context and history; do not edit it.
Backlog IDs come from `.kiro/backlog.jsonl` only — prose IDs in older trackers collided.
Live, still-relevant facts from it have been promoted into `.claude/rules/`.

## Claude Code guardrails
- `.claude/settings.json`: permissions (allow / ask / deny) and the generated-file hook.
- `.mcp.json` (Claude-only) loads `e2e-status` and `agent-knowledge`.
