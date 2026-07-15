# Changelog

All notable changes to ml-container-creator are documented here.

## [1.3.4] — 2026-07-15

### 🔧 Validation Run Patch — `do/optimize` Refactor + 25 Bug Fixes

Comprehensive validation run against a real AWS account uncovered and fixed 25 issues.
The headline change is a full architectural refactor of `do/optimize`.

### Changed (Architecture)

- **`do/optimize` — single responsibility restored** — The Athena recommendation layer added in v1.3.0 has been moved to `do/benchmark --recommend`. `do/optimize` now exclusively manages `CreateAIRecommendationJob` (live SageMaker AI Recommendations API). `--goal <cost|latency|throughput>` is now required.
- **`do/benchmark --recommend`** — New flag. Queries your Athena benchmark history for proven config improvements. `--apply` writes changes to `do/ic/default.conf` with `.bak` backup. `--metric`, `--no-bedrock` flags available.
- **`do/deploy --optimize`** — Now calls `do/benchmark --recommend --apply` (Athena-backed, no live API needed) instead of `do/optimize --apply`.
- **`do/benchmark --compare-baseline`** — Upgraded from single-baseline to full historical comparison: most recent prior run as primary (B), all runs as individual rows (C), min/max/avg range across all runs (D). ADAPTER column shows which adapter was active per run. Self-comparison prevented via timestamp exclusion. `--adapter` flag filters Athena baseline to adapter-specific runs.

### Added

- **`@aws-sdk/client-dynamodb` + `@aws-sdk/util-dynamodb`** added to production dependencies — required by `mcc prove` to write results to DynamoDB; was missing from npm package.
- **`mcc prove` improvements:**
  - `generate` auto-prepended to stages (user no longer needs to specify it)
  - Interactive stage choices cleaned up: `build`+`push` → `submit`; `adapter`/`test-adapter`/`register` moved to opt-in only
  - Quantization sweep prompt now shows valid values (`fp16, bf16, fp8, int8, int4, awq, gptq`) with examples
  - `saveProveState` now persists `error` field so failed stage messages are visible in `.prove-state.json`
  - `executeGenerateStep` now resolves `bin/cli.js` absolute path to avoid PATH issues with nvm-managed node
  - `--quantization` removed as invalid CLI flag to `mcc generate`; quantization written to `do/ic/default.conf` post-generation instead
- **BL060** — Research backlog item: correct `HubContentDocument` schema for DataSet `import_hub_content` (fine-tuning datasets). Hub `DataSet` type uses a benchmarking schema — not suitable for SFT/DPO training datasets. `_register_to_hub()` is now a no-op stub.
- **BL061** — v1.4 planned: `servers/reasoning/` MCP server — stateless provider-agnostic LLM interpretation layer. Default: Bedrock Claude Sonnet. Callers: `do/benchmark --recommend`, `do/optimize`, `GoalPlanner`.

### Fixed (25 bugs from validation run)

| # | Component | Bug | Fix |
|---|---|---|---|
| 1 | `templates/do/validate` | Script not executable + wrong path resolution (looked in project dir, not npm global) | Added chmod to both `marketplaceScripts` and `defaultScripts` lists; new 3-path resolution (npm global → local node_modules → dev repo) |
| 2 | `src/lib/validate-runner.js` | `parseDoConfig` couldn't parse `${VAR:-default}` shell syntax | Regex now resolves `${KEY:-value}` to the default value before storing |
| 3 | `src/lib/service-model-parser.js` | Only parsed legacy REST-JSON format; GitHub aws-models uses Smithy 2.0 | Added `_parseSmithyModel()` that maps Smithy 2.0 `shapes` to internal Map representation |
| 4 | `src/lib/payload-builder.js` | Integer fields (IC_GPU_COUNT, InitialInstanceCount, etc.) passed as strings | Added `_toInt()` coercion for all 6 integer fields |
| 5 | `templates/do/optimize` | `ROLE_ARN` unbound variable crash with `set -u` | Changed to `${ROLE_ARN:-}` |
| 6 | `templates/do/optimize` | `--apply` without `--goal` silently exited 0 | Now prints actionable error with the two available paths |
| 7 | `src/agent/execution_config.py` | `do/submit` cost warning said "SageMaker Training Job" | Corrected to "CodeBuild job to build and push Docker image to ECR" |
| 8 | `src/agent/prompts/system.md` | Advisory REPL proposed `do/build` for build requests | Added "CRITICAL" build-path guidance: always propose `do/submit` for SageMaker deployments |
| 9 | `infra/bootstrap-modules/sagemaker-domain/stack.ts` | Domain used inference execution role — missing Studio permissions (`ListSpaces`, etc.) | New dedicated `mlcc-studio-execution-role-<profile>` with `AmazonSageMakerFullAccess` + Space/App inline policy |
| 10 | `templates/do/tune` | Auto-register ARN extraction used fragile regex | New: JSON parse with `model_package_arn`/`arn`/`ModelPackageArn` keys + MPG fallback query |
| 11 | `templates/do/tune` | Auto-register silently deployed IC to endpoint without user confirmation | Now only registers in MPG, prints `do/adapter add` next-step command |
| 12 | `templates/do/tune` | `--list-datasets --source` flag not parsed | Added `--source` arg parsing; passes `--source` to `.register_helper.py` |
| 13 | `templates/do/lib/python/register_dataset.py` (monolith) | `_register_to_hub()` used `create_hub_content` (non-existent API) | Changed to `import_hub_content`, then `HubContentType='DataSet'` (capital S), then profile resolver, then no-op stub (DataSet Hub type uses benchmarking schema) |
| 14 | `templates/do/lib/python/register_dataset.py` | `_get_hub_name_from_profile` used `startswith(region)` — never matched profile keys like `mcc-us-west-2` | Priority order: `activeProfile` → region-contains → first-found |
| 15 | `templates/do/lib/python/register_dataset.py` | Empty dimension values (e.g. empty `max_model_len`) formed recommendation groups | Now skips records where dimension value is empty/null |
| 16 | `templates/do/.optimize_engine.py` | `_parse_local_results` expected flat keys; AIPerf uses `{metadata, metrics}` nested dicts with `{avg, p90...}` | Added `AIPERF_METRIC_MAP` with correct field/sub-key mapping; fallback to `profile_export_aiperf.json` |
| 17 | `templates/do/.optimize_engine.py` | `_parse_local_results` couldn't extract metrics from `profile_export_aiperf.json` | Extended with `_extract_aiperf()` helper using correct AIPerf field names |
| 18 | `templates/do/benchmark` | `--compare-baseline` quantization default was `bf16`; vLLM default is `none` | Changed default to `none`; added TP-relaxed fallback query |
| 19 | `templates/do/.optimize_engine.py` | All Athena SQL queries used `model = 'lowercase'` — Parquet preserves original case | Changed all 4 queries to `LOWER(model) = 'lowercase'` |
| 20 | `templates/do/benchmark` | `--json` flag didn't suppress `do/config` stdout block | Config source redirected to stderr when in JSON/compare-baseline mode |
| 21 | `templates/do/benchmark` | `--adapter` flag parsed but never forwarded to Athena baseline query | Added `--adapter-name` to `.optimize_engine.py compare-baseline` argparse; passed from bash |
| 22 | `templates/do/benchmark` | `--compare-baseline` config block showed even for structured output | Fixed: `--compare-baseline` now also triggers config-to-stderr redirect |
| 23 | `package.json` | `@aws-sdk/client-dynamodb` missing from production deps | Added to `dependencies` |
| 24 | `package.json` | `@aws-sdk/util-dynamodb` missing from production deps | Added to `dependencies` |
| 25 | `src/lib/prove-pipeline-executor.js` | `executeGenerateStep` used `mcc` binary name — not found in nvm subprocess PATH | Resolved `bin/cli.js` absolute path; invokes via `node` directly |

### Known Limitations (deferred to v1.3.x or v1.4)

- `do/optimize` (`CreateAIRecommendationJob`) not validated — requires expensive `p*`/`g*` instance provisioning. Deferred to dedicated validation environment.
- `mcc prove` live end-to-end run with real deployment — prove infrastructure validated to `generate` stage. Full lifecycle (stage → submit → deploy → test → clean) deferred.
- DataSet AI Registry Hub registration — `HubContentDocument` schema for SFT/DPO training datasets unknown; `_register_to_hub()` is a no-op stub (BL060).

## [1.3.0] — 2026-07-10

### 🤖 Agent Autonomy + Intelligent Optimization

v1.3 completes the agent autonomy arc (advise → act → auto), delivers Athena-backed optimization recommendations, decomposes the monolithic Python helpers, and ships the prove pipeline for catalog expansion.

### Added

- **`hey --goal '<objective>' --auto`** — Agent auto-goal mode: `GoalPlanner` converts a natural-language objective into an ordered `do/` script plan; `QuestionResolver` answers clarifying questions from project context, capability matrix, and instance-sizer defaults; `ChainRunner` executes the plan, pausing at `confirm`-class steps. `--dry-run` runs the planner without executing anything (golden-file testable).
- **`ConfirmationPolicy`** — Script classification (`auto` / `confirm`) externalized to `config/agent.json` and project-local `.mlcc/agent-config.json`. Scripts like `do/test` and `do/validate` run without prompts; mutating scripts always pause for confirmation.
- **Athena-backed `do/optimize`** — Queries your own benchmark history (Parquet in S3/Athena) for proven configurations better than your current config. Shows ranked recommendations with confidence scores (HIGH/MEDIUM/LOW based on run count and variance). Bedrock explains tradeoffs when available. `--apply` writes changes to `do/ic/default.conf` with `.bak` backup.
- **`do/benchmark --compare-baseline`** — Compares the most recent local benchmark run against your Athena historical best. `--threshold metric:pct` (repeatable, with aliases) sets per-metric regression thresholds. Exit code 1 on regression — CI-friendly.
- **`do/deploy --optimize`** — Pre-deploy hook: applies `do/optimize --apply` before deploying, non-fatal on failure.
- **`mcc prove`** — Local prove pipeline: `prove prove.json` runs the full `do/` lifecycle end-to-end for a configuration and writes results to DynamoDB. `prove --interactive` builds a prove config via MCP-assisted wizard. `prove sync` promotes passing results to catalog JSON. `prove report` and `prove status` for observability. Sweep axes (`base` + `sweep` → Cartesian product) with resumable persistent workspaces.
- **Dataset hub listing** (`do/tune --list-datasets --source remote|local|all`) — Shows Remote DataSets (AWS AI Registry, account-scoped) and Local Datasets in separate sections. `--source remote` queries the AI Registry Hub; `--source local` reads local JSON registry only.
- **Auto row count** — `do/register dataset` computes row count from S3 by streaming (jsonl line count, csv rows−1, parquet footer parse). Non-fatal; null if unsupported format or error.
- **Technique guardrail** — `do/tune` warns when a dataset was registered for a different technique (e.g. registering a DPO dataset for SFT). In `MLCC_AUTO_MODE=1`, auto-declines with exit code 4.
- **`ml.p6-b200.48xlarge`** — Added to instance catalog (8× NVIDIA B200 GPUs, Blackwell architecture, 192GB VRAM per GPU).

### Changed

- **Helper decomposition** — `.tune_helper.py` (2082 lines → 181-line dispatcher), `.register_helper.py` (2095 lines → 168-line dispatcher), `.stage_helper.py` (420 lines → 72-line dispatcher), `.adapter_helper.py` (451 lines → 62-line dispatcher). Implementation now lives in `templates/do/lib/python/` (15 focused sub-modules ≤200 lines each). Dispatchers re-export all helpers for backward compatibility.
- **`do/optimize`** — Extended with Athena-first recommendation flow. Existing `CreateAIRecommendationJob` logic preserved as complementary path (useful when no benchmark history exists). New flags: `--apply`, `--json`, `--metric`, `--no-bedrock`.
- **ConfirmationPolicy classification defaults** — `do/test`, `do/status`, `do/logs`, `do/validate`, `do/export`, `do/ci` are `auto`-class (no prompt). All mutating/costly scripts are `confirm`-class.
- **`_truncate_metadata`** — Now preserves empty strings in metadata output (previously silently dropped keys with empty values, violating the expected contract for optional fields).
- **HyperPod specs** (E8-H1 through H5) moved to **v1.4 — HyperPod & SGLang**.

### Fixed

- Bootstrap status `--dry-run` now honored in interactive flow (`bootstrap add <profile>`)
- `ic-env-deploy-time`: IC_ENV placeholder renders as active export with default-value syntax, not commented-out placeholder
- `stage-update-config`: `--update-config` help text updated to match template
- `tp-degree-auto-resolution`: `ml.p6-b200.48xlarge` was referenced in tests but missing from catalog
- Health check: `importlib.util.find_spec` fallback mocked correctly in tests; check count updated to 10 (EBS quota check added)
- `auto_flatten`: log output goes to stderr, not stdout — tests updated
- `_check_technique_mismatch` re-exported from `.tune_helper.py` dispatcher for test backward-compat

## [1.2.0] — 2026-07-06

### 🧱 Modular Bootstrap + Agent Execution

v1.2 replaces the monolithic bootstrap stack with independent, selectively-provisioned CDK modules, and extends the `hey` agent to execute approved `do/` scripts with confirmation.

### Added

- **Modular bootstrap** — 7 independent modules (core, benchmark, registry, training, ci, sagemaker-domain, hyperpod-cluster), each its own CDK stack (`mlcc-<profile>-<module>`)
- **Symmetric commands** — `add`/`remove` (profiles), `add-module`/`remove-module` (modules); bare `bootstrap` is a read-only smart landing (getting-started or status + next steps)
- **`--dry-run`** on `add`, `add-module`, `remove-module`, and `update` (previews via `cdk diff`)
- **Non-interactive `--with <modules>`** (defaults to `core + registry`)
- **DLC-direct deploy** (`--no-build`) — skip Dockerfile/build/push, deploy a stock DLC image resolved via the driver-aware base-image-picker
- **Agent execution layer** — `hey` runs approved scripts (`do/stage`, `do/build`, `do/push`, `do/submit`) with per-step confirmation, cost warnings, and size-aware staging
- **`do/optimize`** — Athena-backed serving-config recommendations + `--compare-baseline` regression detection
- **`do/stage --instance-type`** — size the staging Processing Job (prevents large-model OOM); EBS-quota health check
- **Agent `read_docs`** — `docs/**/*.md` ships in the package; agent grounds answers in published docs
- **g6/g6e instance support** — 16 catalog entries (L4 24GB, L40S 48GB); 14B fits BF16 on a single g6e.xlarge

### Changed

- **Retained-resource adoption** — RETAIN'd S3 buckets + core ECR repo auto-adopted on re-provision (no name collisions)
- **Failed-stack auto-cleanup** — un-updatable stacks deleted before redeploy
- **`update` force-deploys** all installed modules (fixes silent no-op via idempotency short-circuit)
- **Per-module CDK isolation** — a synth error in one module no longer blocks another's deploy
- **Hardened migration** — dependency-validated (warn & abort on inconsistent sets), infers training from MLflow, maps CI outputs; migration-aware `status`
- **Honest `hyperpod-cluster`** — records config intent only (no fabricated ClusterArn); real-cluster provisioning spec'd separately (e8-h4)

### Fixed

- Bootstrap status `[object Object]` rendering; module-aware + migration-aware validation
- `hey` health check false-negative on `sagemaker` (import-spec fallback for metadata-less installs)
- Deterministic hyperpod SSM param (was churning on every synth)
- Registry hub description constraint violation; `installLatestAwsSdk: false` on the hub custom resource

### Breaking Changes

- Bare `bootstrap` no longer launches interactive setup — use `bootstrap add <profile>`
- Legacy `--ci`, `--benchmark-infra`, `--skip-ci`, `--skip-s3`, `--role-arn` flags are now no-ops (use `--with`)
- Monolithic bootstrap removed from the interactive path (migration provided)

## [1.1.0] — 2026-07-02

### 🤖 Strands Agent + Custom Training + Fine-Tuning Loop

### Added

- **`ml-container-creator hey`** — conversational advisory agent (Amazon Bedrock): project-aware + getting-started modes, MCP-powered knowledge (incl. new agent-knowledge server), capability matrix, health check, `--offline` mode, action plans, cost tracking
- **`do/train`** — custom training (Epic 7): technique routing (`sft`/`dpo`/`custom`), `--interactive` builder, dataset resolution (registered names / `s3://` / `hf://` / `@v<N>`), spot training, HyperPod K8s manifests
- **Fine-tuning loop** (Epic 6) — adapter auto-registration, from-registry deploy, multi-adapter ICs, dataset versioning

### Changed

- **Default `max_model_len=4096`** for all vLLM/SGLang projects (prevents first-deploy OOM)
- Capability matrix updated with 14B validation findings (CUDA graph overhead, LoRA + FP8 on A10G)

### Fixed

- Dataset resolution, submission error handling, agent token-cost tracking (bugs 60-62)

### Removed

- ~2,370 lines of dead code (stale CLI handler, orphaned training subsystem)

## [1.0.0] — 2026-06-24

### 🎉 First Stable Release

MCC v1 delivers a complete, validated CLI for generating SageMaker-compatible BYOC containers with full lifecycle scripts — from model staging through benchmarking and registration.

### Highlights

- **Full SageMaker Python SDK v3 migration** — All Python helpers use `sagemaker.core.resources` (no SDK v2). boto3 used only for non-SageMaker services and documented exceptions.
- **Processing Jobs by default** — `do/stage` and `do/adapter` submit SageMaker Processing Jobs instead of downloading to local disk. `--local` flag preserves legacy behavior.
- **LoRA + Benchmarks as defaults** — Projects generate with adapter serving and benchmarking enabled. Opt out with `--enable-lora=false` / `--include-benchmark=false`.
- **Inference Component environment variables** — `IC_ENV_*` prefix in `do/ic/*.conf` passes deploy-time env vars to containers (max 16 entries, 1024 chars/value).
- **Model Package Group registration** — `do/register` creates versioned Model Packages with deployment metadata. Subcommands for datasets and evaluators.
- **EAGLE speculative decoding support** — Golden path models validated against SageMaker EAGLE training (6 architecture classes).
- **6 MCP servers** — instance-sizer, base-image-picker, endpoint-picker, model-picker, region-picker, hyperpod-cluster-picker. Auto-discover tool names.
- **Tier 1 validated** — 6 models (≤4B) pass full lifecycle on `ml.g5.xlarge`: generate → build → push → deploy → test → benchmark → tune → adapter → test-adapter → clean.

### Validated Models (Tier 1 — daily CI)

| Model | Instance | Notes |
|-------|----------|-------|
| Qwen/Qwen3-0.6B | ml.g5.xlarge | Native 32K context |
| Qwen/Qwen3-1.7B | ml.g5.xlarge | Native 32K context |
| Qwen/Qwen3-4B | ml.g5.xlarge | max_model_len=4096 |
| meta-llama/Llama-3.2-1B-Instruct | ml.g5.xlarge | Native 128K context |
| meta-llama/Llama-3.2-3B-Instruct | ml.g5.xlarge | Native 128K context |
| deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B | ml.g5.xlarge | Native 128K context |

### Breaking Changes (from 0.x)

- **Python 3.10+ required** (was 3.9). Dependencies auto-install via `npm postinstall`.
- **`do/stage` default changed** — now submits Processing Job (old: local download). Use `--local` for previous behavior.
- **`do/adapter --from-tune` default changed** — same as above.
- **sagemaker-core v2.x imports** — `from sagemaker.core.resources import X` (was `from sagemaker_core.resources`).
- **`do/register` subcommand syntax** — `./do/register dataset <name>` replaces `--dataset` flag (flag still works for backward compat).

### Known Limitations

- 7B+ models require `ml.g5.12xlarge` (multi-GPU) — Tier 1 validates ≤4B models only.
- `do/register` MPG registration requires valid ECR URI — works without it but skips InferenceSpecification.
- Property tests fail locally due to bootstrap profile env contamination (pass in CI).
- `do/benchmark` tar extraction requires `npm run codegen` + regenerate for flat-archive AIPerf output format.

## [0.15.1] — 2026-06-23

### Bug Fixes

- **do/register**: `InferenceSpecification` no longer crashes when container image is empty or non-ECR URI. Registration works pre-push with metadata-only Model Package. (#Bug 32)
- **do/register**: Container image URI now builds from bootstrap profile (account + region + repo) instead of using `BASE_IMAGE`. (#Bug 32)
- **MCP servers**: Fixed `get_ml_config` tool-not-found error — client auto-discovers server tool names via `listTools()`. (#Bug 33)
- **endpoint-picker**: Removed `parameters.includes('endpointName')` guard that blocked on-demand queries. (#Bug 34)
- **endpoint-picker**: Passes `awsProfile` from bootstrap config so credential resolution works. (#Bug 35)
- **endpoint-picker**: Falls back to `DescribeEndpointConfig` when variant doesn't include `InstanceType` (IC-based endpoints). (#Bug 36)
- **Base image prompt**: Schema `baseImage.prompt` changed from `null` to `"external"` so codegen marks it as promptable. Requires `npm run codegen`. (#Bug 37)
- **Benchmark writer**: Now captures `IC_ENV_*` serving config (max_model_len, quantization, gpu_memory_utilization) from `do/ic/*.conf` into the Athena `serving_config` column.

### UX Improvements

- **TP auto-detection**: No longer inherits TP from the first sizer recommendation when user selects a custom instance. Custom instances resolve TP from instance catalog (actual GPU count).
- **Endpoint picker timing**: MCP query now runs AFTER user confirms "Yes — attach to existing endpoint" instead of unconditionally before the prompt.
- **Base image selection**: Prompt now appears when MCP server returns choices (was previously suppressed by `promptable: false`).

### Documentation

- **Golden path**: Replaced three-tier Gold/Silver/Bronze model with binary "validated models" vs "off-path" framing. Documents the 6 EAGLE architecture classes and why specific models are in the catalog.
- **CI tiers restructured**: 8B models moved from daily (ml.g5.xlarge — OOM) to nightly (ml.g5.12xlarge). Daily tier now 8 models with `max_model_len` column.
- **deployment-registry.md**: Documents that ECR image is optional for MPG registration and failures are non-fatal.
- **ci-integration.md**: Added Qwen3.5, Qwen3.6, Nemotron 3 Nano to nightly tier.

### Internal

- Added BL025 to backlog: `do/deploy --update` for IC model artifact migration on existing endpoints.

## [0.15.0] — 2026-06-22

### Features

- Adapter benchmark differentiation in Athena (`adapter_name` column)
- `do/register` refactored to subcommands (model/dataset/evaluator)
- `do/register dataset --from-tune` auto-derives from tune state
- `do/test --adapter` flag
- CDK stack: `importExistingBenchmarkBucket` support

### Bug Fixes

- Bugs 25–31 (see PR description for details)
