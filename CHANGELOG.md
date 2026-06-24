# Changelog

All notable changes to ml-container-creator are documented here.

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
