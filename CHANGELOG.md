# Changelog

All notable changes to ml-container-creator are documented here.

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
