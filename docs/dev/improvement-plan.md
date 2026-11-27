<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Improvement Plan (post-v2.0)

This plan follows from a whole-codebase architecture review (2026-11-27). It covers the places
where the code falls short of its own rules: one source of truth per fact (ADR-002 and
ADR-008), a single validation framework (ADR-006), and an enforced `do/` contract (ADR-007).
It picks up the unfinished parts of the ADR-002 consolidation program rather than starting a
new one.

**Status key:** ✅ fixed on branch `chore/claude-steering-and-hygiene` · 🟡 planned · 🔒
security (planned and owner-gated; changes to deployed IAM need a redeploy).

**Sizing:** S is under half a day, M is 1–3 days, L is a wave (about a week, with its own spec).

---

## 1. Security (planned; owner decision: code changes in a later batch)

| ID | Problem | Evidence | Proposed change | Size |
|---|---|---|---|---|
| 🔒 SEC-1 | The ci-harness CodeBuild role can escalate to admin. It grants `ecr:*`, `sagemaker:*`, `s3:*`, `logs:*` and `iam:CreateRole` / `PutRolePolicy` / `PassRole` on `*`, and the project runs privileged. | `infra/ci-harness/lib/ci-harness-stack.ts` (CodeBuild role, around lines 787–850) | Scope resources to `mlcc-*` names, the account and the region. Allow `iam:PassRole` only on the execution roles, conditioned on `iam:PassedToService`. Drop `CreateRole` / `PutRolePolicy` by pre-creating any roles CI needs in the stack. Add a CDK assertion test that fails on `Action: '*'` / `service:*` on `Resource: '*'`. | M |
| 🔒 SEC-2 | The `mcc hey` model can approve its own actions. `auto_confirm` is a parameter of the LLM-facing `execute_script` tool, the script path isn't confined to `do/`, unknown scripts default to "confirm" (permitted), and `write_file` can overwrite executable `do/*` scripts. A prompt injection through MCP output could write and then run code with no prompt. | `src/agent/tools/execute_script.py` (`auto_confirm`, path handling); `src/agent/execution_config.py`; `src/agent/agent.py` (`write_file`) | Remove `auto_confirm` from the tool signature and pass pre-approval through an internal context set only by `chain_runner.py`. Resolve `script` against `<project>/do/`, rejecting `..`, absolute paths and symlinks that escape. Make `write_file` refuse existing executable files under `do/`. Add pytest cases for each. | S–M |
| 🔒 SEC-3 | Shell-string `execSync` interpolates profile names and AWS profiles. | `infra/bootstrap-modules/module-runner.cjs` (`execSync` call sites) | Switch to `execFileSync` with argument arrays. Validate profile names against `^[A-Za-z0-9_-]{1,64}$` at the CLI boundary (`src/lib/bootstrap-profile-manager.js`). | M |
| 🔒 SEC-4 | IAM is changed outside CloudFormation. `_ensureCdkExecRolePassRole` runs `aws iam put-role-policy` on the CDK bootstrap role and hardcodes the default qualifier `hnb659fds`. | `module-runner.cjs` `_ensureCdkExecRolePassRole` | Document the required bootstrap permission instead, or read the qualifier from `cdk.json` / context. Never mutate the CDK bootstrap role silently. | S |
| 🔒 SEC-5 | Broad managed policies: `AmazonSageMakerFullAccess` + `AmazonS3FullAccess` on the Studio role, and `AmazonFSxFullAccess` on the CSI IRSA role. | `infra/bootstrap-modules/sagemaker-domain/stack.ts`; `infra/bootstrap-modules/eks/stacks/eks-cluster-stack.ts` | Replace them with scoped inline policies. Cross-reference `.kiro/reports/mlcc-admin-least-privilege.md` and backlog items BL221–BL223. | M |

## 2. Validation consolidation (finish ADR-006), wave L

**Problem.** At least eight overlapping layers remain. `generated/validation-rules.js` runs
through `config-validator.js`; then come `parameter-schema-validator.js`,
`template-manager.js` `validate()` (which throws), `validation-engine.js` with the
accelerator validators (`accelerator`, `semver-accelerator`, `cuda`, `neuron`, `rocm`, `cpu`),
`schema-validation-engine.js` with `cross-cutting-checker.js` and `validators/*`,
`validation-adapters.js` (which converts unified findings back into the legacy formats),
`validate-runner.js`, and `tune-catalog-validator.js`. Observable inconsistencies:

- CUDA compatibility is checked twice, with different semantics: `cuda-validator.js` uses
  `compatibleVersions`, while `cross-cutting-checker.js` compares major versions only.
- A CPU instance with a GPU architecture gets a warning in `config-validator.js` but an error
  in `template-manager.js`.

**Plan.**
1. Inventory every rule in every layer and record its id, inputs, severity and call site in a
   table in `docs/architecture/validation.md`.
2. Port each rule into a `BaseValidator` in `src/lib/validators/`, with one finding
   vocabulary and one severity per rule.
3. Route every caller through `schema-validation-engine.js`. Remove `validation-adapters.js`
   after its last consumer (`registry-config-manager.js`) moves over.
4. Delete the old layers and the modules that only tests reach (§5).
5. Add a property test: for any config, generation-time and `do/validate` runtime validation
   return the same findings.

**Exit criteria:** one engine, a single implementation of each rule, and no `validation-adapters.js`.

## 3. Module break-up, wave L (split by substrate)

| Target | Today | Split into |
|---|---|---|
| `src/lib/bootstrap-command-handler.js` | Dispatch, interactive setup, provisioning, prune, scan, sync-*, migrate, and hand-written flag re-parsing | Keep `bootstrap-command-handler.js` as a dispatcher only. Add `bootstrap/setup.js`, `bootstrap/modules.js` (add / remove / update), `bootstrap/maintenance.js` (scan / prune / migrate) and `bootstrap/sync.js` (the sync-* commands). Replace the flag re-parse with Commander options defined on each action. |
| `src/app.js` `writeProject` | Builds ignore globs, routes per-architecture overlays, writes `.gitignore` (the same append block four times), copies manifests | Add `generation/ignore-patterns.js` (pure, unit-testable), `generation/architecture-router.js` (one entry per architecture) and `generation/post-process.js`. |
| `bin/cli.js` `hey` command (about 400 lines inline) | venv bootstrap, raw-key TUI, Python spawn | Move it to `src/lib/hey-command-handler.js` so `bin/cli.js` is Commander wiring only. |
| `src/lib/config-manager.js` and `config-loader.js` / `config-validator.js` / `config-mcp-client.js` | Collaborators get a parent back-reference and reach into private state. The parent forwards private methods (`_x()` delegators). | Turn the collaborators into pure functions over an explicit state object and delete the forwarding shims. |
| `prompt-runner.js` and `mcp-query-runner.js` | The same back-reference pattern | The same refactor. |
| `infra/bootstrap-modules/module-runner.cjs` | Single-stack runner, multi-stack runner, and imperative kubectl / helm / ENI cleanup | Split into `runner/single-stack.cjs`, `runner/multi-stack.cjs` and `runner/k8s-ops.cjs` (the last is deprecated with the `hyperpod` module). |
| `templates/do/{benchmark,adapter,tune,register,train}` (2,000–3,300 lines of bash each) | Many inline `python3 -c` blocks, mostly used like `jq` | Move logic into `templates/do/lib/python/` modules with CLIs, so each bash script keeps only argument parsing and flow. Start with `benchmark`, then `tune`. |

Each row is its own change with its own tests. Don't combine rows.

## 4. Consistent error handling (M)

| ID | Problem | Plan |
|---|---|---|
| ✅ ERR-1 | `run()` printed a warning and **returned exit 0** on config-load failure, validation errors and the refuse-generator-directory guard. | Fixed: these now set a non-zero exit code. |
| ✅ ERR-2 | `program.parse()` with async actions: rejections surfaced as raw stack traces. | Fixed: `parseAsync()` with a top-level handler that prints a ❌ message and exits 1. |
| 🟡 ERR-3 | `process.exit` is called inside library modules (`train-config-builder.js`, `deploy-config-builder.js` and others). | Libraries throw typed errors (`MlccError { code, exitCode, hint }`). Handlers and `bin/cli.js` map them to messages and exit codes. Add an ESLint rule that forbids `process.exit` in `src/lib/**` outside handlers. |
| 🟡 ERR-4 | Errors are swallowed in the `do/` runtime: `2>/dev/null` / `|| true` on commands that matter, `except Exception: KEY_MAP = {}` (BL239). | Sweep script by script, starting with `register`, `benchmark` and `deploy.d/*`. Add a lint check (a test) that flags new `2>/dev/null` on `aws` / `kubectl` / `python3` lines without a justification comment. |
| 🟡 ERR-5 | `templates/do/lib/script-contract.sh` sources `do/config` with errors discarded, and each script then sources it again. | Source it once in the contract, report syntax errors, and drop the per-script re-source. |

## 5. Dead and legacy code (S each)

| Item | Evidence | Action |
|---|---|---|
| `config/defaults.json`, `config/presets/*.json` | No reads in `src/`, `bin/` or `scripts/`; v1 shape (`deployTarget`, sklearn/flask). Still published in `package.json` `files`. | Delete and remove from `files`. Note it in the CHANGELOG. |
| `src/lib/generation-validator.js`, `dry-run-validator.js`, `mcp-validator-config.js`, `template-engine.js` | Imported only by tests | Delete along with their tests, as part of §2 (some overlap with live validators). |
| `src/lib/e2e-bootstrap.js` + `config/bootstrap-e2e-stack.json` | No production importer; a third CI mechanism next to ci-harness and the bootstrap `ci` module | Delete once confirmed unused by docs and runbooks. |
| `src/lib/bootstrap-provisioners.js` `_setupIamRole` | A hand-rolled copy of the core role policy, reachable only from a delegator and tests; drifts from `core/stack.ts` | Delete. |
| `src/lib/prompts.js` | An 8-line re-export shim | Point importers at `src/lib/prompts/index.js` and delete it. |
| `src/lib/architecture-command-handler.js` `list-architectures` / `check` | No CLI path reaches them | Expose them under `mcc bootstrap` or delete them. |
| `infra/bootstrap-modules/hyperpod-cluster/` | Legacy stub left over from before the `eks` + `hyperpod` split | Delete with the `hyperpod` module deprecation. |
| `.githooks/pre-commit` | A legacy copy of `.husky/pre-commit` that isn't active | ✅ Removed. |
| Module-header lint rule still a warning | ADR-002 Wave 9 promised to make it an error | Add headers to the remaining pattern-participating modules, then promote the rule to `error`. |

## 6. `do/` runtime correctness

| ID | Problem | Status |
|---|---|---|
| ✅ DO-1 | `script-contract.sh` turned on `set -u` for every caller unconditionally. | Fixed: the caller's nounset state is restored. |
| ✅ DO-2 | A guard ran before argument parsing, so `--help` exited 3 on a project with nothing deployed. | Fixed: guards are skipped when `-h` / `--help` is present. |
| ✅ DO-3 | An unknown `# guard:` name called a non-existent function. | Fixed: it is now a contract violation (exit 3). |
| ✅ DO-4 | Eight private `sed -i` config writers, unescaped (`|`, `&`, `"`, `\` corrupt `do/config`), only one handling a missing trailing newline, and a quoting bug in `do/stage`. | Fixed: a single `lib/config-store.sh` (`_config_set` / `_config_unset`), escaped and atomic. |
| ✅ DO-5 | `realtime` alias: the generated guard accepted it but the hand-written dispatcher in `do/deploy` rejected it. | Fixed: the dispatch is codegen'd from the descriptors (target + aliases). |
| 🟡 DO-6 | Sourced `deploy.d/*` drivers use `exit 0` on success paths, which skips the dispatcher's write-back of `DEPLOYMENT_TARGET`. | Convert success-path `exit 0` to `return 0`. The driver-by-driver audit needs live validation per target. |
| 🟡 DO-7 | `lib/deployment-state.sh` hardcodes a `case "$target"` per target. | Derive it from the descriptor `status_var` / `success_status` (ADR-008). |
| 🟡 DO-8 | The `envsubst` fallback (a Perl one-liner, duplicated in `deploy.d/eks` and `lib/hp-iec-render.sh`) leaves unset `${VAR}` literally and inserts values into YAML unquoted. | Move it into one helper. Fail on unresolved placeholders. YAML-quote values. |
| 🟡 DO-9 | `serve_manifest.py` falls back to `cwd/templates/code/serve.d`, so a script run from another checkout can read the wrong descriptors. | Resolve only relative to the project root. |
| 🟡 DO-10 | Verb × target support lives in three places: descriptor `verbs{}`, `# targets:` headers, and the `_additive_*` tables. | Make descriptor `verbs{}` the source and codegen the other two. |

## 7. CLI and packaging correctness

| ID | Problem | Status |
|---|---|---|
| ✅ PKG-1 | `servers/hyperpod-cluster-picker/gpu-capacity.js` (a runtime import) and the `adapter-picker`, `draft-model-picker` and `model-registry` servers were missing from the published package. | Fixed, and `test/unit/npm-package-contents.test.js` now checks server import closure. |
| ✅ PKG-2 | `package.json` `main` pointed to a nonexistent `src/index.js`. | Fixed. |
| ✅ CLI-1 | Default instance type per architecture had three disagreeing copies. | Fixed: one source. |
| ✅ CLI-2 | The `bootstrap` help omitted `sync-serving-versions`. | Fixed. |
| ✅ CLI-3 | Model IDs drifted across `config/agent.json`, `src/agent/config_loader.py` and `servers/lib/create-picker-server.js`, and the reasoning block lacked an inference-profile prefix. | Fixed, with a drift test. |
| ✅ CLI-4 | `scripts/codegen-parity.js` matched zero items and wasn't wired anywhere. | Fixed: deleted. The pre-commit freshness check and the `deploy-flag-forwarding` / `target-descriptor-conformance` tests already cover parity. |
| ✅ TPL-1 | The HyperPod `InferenceEndpointConfig` template emitted `SGLANG_SPECULATIVE_*`, contradicting "vLLM only on HyperPod". | Fixed. |
| ✅ INF-1 | The legacy `hyperpod-cluster` stub wrote a timestamp into a value commented "must be deterministic". | Fixed. |
| 🟡 CLI-5 | `deploymentConfig.split('-')[0]` appears 27 times across nine files, and `GENERATOR_ROOT` is recomputed in about 12 modules. | Use `DeploymentConfigResolver` and `base-command-handler.js` exports. |
| 🟡 CLI-6 | Bootstrap flags given after the action (`--profile`, `--region`, `--name`, `--role-arn`) fall through as positional arguments. | Fixed by the §3 Commander-options refactor. |
| 🟡 CLI-7 | `config/mcp.json` is gitignored and unpublished, but `agent.py` exits without it, and `mcp-command-handler.js` writes it into the package root (inside `node_modules` for a global install). | Write it to `~/.ml-container-creator/mcp.json`. Fall back to bundled defaults when it's missing. |
| 🟡 CLI-8 | Generated files embed a `Generated:` timestamp, which adds diff noise on every regeneration. | Drop the timestamp (the pre-commit hook already ignores it). |

## 8. Infra and CI

| ID | Problem | Plan |
|---|---|---|
| ✅ INF-2 | The bootstrap `ci` module manifest advertised Step Functions / EventBridge and a `StateMachineArn` export that the stack doesn't create. | Fixed in the manifest. |
| 🟡 INF-3 | Three CI mechanisms: `infra/ci-harness` (live), the bootstrap `ci` module, and `e2e-bootstrap.js` with its raw CloudFormation template. `docs/ci-integration.md` mixes them. | Make ci-harness the only orchestrator, keep the `ci` module as the per-account results store, and delete e2e-bootstrap (§5). |
| 🟡 INF-4 | SSM keys are shared as string literals across 12 writers and one reader, under a `/mlcc/<profile>/hyperpod/*` prefix even for vanilla EKS. | Add a shared SSM-key module used by stacks and the runner. Migrate the prefix with a dual-read period. |
| 🟡 INF-5 | `ci/stack.ts` uses DESTROY for the CI log group and results table, so history is lost on teardown. | Use RETAIN, consistent with the rest of the stack policy. |
| 🟡 INF-6 | `bucket-declarations.ts` and `.cjs` duplicate the renderer logic, guarded only by a test. | Keep the test, or generate the `.cjs` from the `.ts` at build time. |

## 9. Process: leaving Kiro

| ID | Item | Status |
|---|---|---|
| ✅ PROC-1 | Claude Code steering: `CLAUDE.md` plus `.claude/rules/*`, with a drift test (`test/unit/claude-steering-drift.test.js`). | Done |
| 🟡 PROC-2 | The backlog (`.kiro/backlog.jsonl`), trackers and specs are gitignored and exist only in one checkout. | Move the backlog to a tracked location (GitHub issues or a tracked `planning/backlog.jsonl` plus `sync_v2_status.py`). Freeze `.kiro/` as an archive or export the still-open specs. |
| 🟡 PROC-3 | `.kiro/v2.0-status.md` lists 23 items as needs-validation (W4–W8, W10, W11). | Owner-run validation pass, recorded per item. |
| 🟡 PROC-4 | Backlog ID collisions between old tracker prose and `backlog.jsonl` (BL130–BL132). | Treat `backlog.jsonl` as canonical. Annotate the tracker sections as historical. |

## Suggested sequencing

1. **Now (this branch):** steering, the correctness and hygiene fixes marked ✅, packaging.
2. **Next:** §1 security (SEC-2 and SEC-1 first) as one owner-reviewed batch.
3. **Wave A:** §4 error handling (ERR-3 to ERR-5) plus the §6 runtime items. These are
   low-risk and make failures visible, which helps every later wave.
4. **Wave B:** §2 validation consolidation.
5. **Wave C:** §3 module break-up, one row per change.
6. **Wave D:** §5 dead code (most of it falls out of B and C) and §8 infra.
