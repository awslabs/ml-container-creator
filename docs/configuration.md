# Configuration

ML Container Creator supports multiple configuration methods with a clear precedence order, from interactive prompts to fully automated CLI usage.

## Precedence

Configuration sources are applied in strict precedence order (highest to lowest):

| Priority | Source | Description | Example |
|----------|--------|-------------|---------|
| 1 | CLI Options | Command-line flags | `--deployment-config=http-flask` |
| 2 | CLI Arguments | Positional arguments | `ml-container-creator my-project` |
| 3 | Environment Variables | Shell environment | `export AWS_REGION=us-east-1` |
| 4 | CLI Config File | `--config` specified file | `--config=production.json` |
| 5 | Custom Config File | `config/mcp.json` | Auto-discovered in current directory |
| 6 | Package.json Section | `"ml-container-creator": {...}` | Project-specific defaults |
| 7 | Generator Defaults | Built-in defaults | `awsRegion: "us-east-1"` |
| 8 | Interactive Prompts | User input (fallback) | CLI prompts |

Higher precedence sources override lower ones.

## Parameter Reference

All 68 parameters supported by MCC, organized by category. Each can be set via CLI flag, config file key, or (where noted) environment variable.

### Project

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `projectName` | `--project-name` | string | — | Name for the generated project (env: `ML_PROJECT_NAME`) |
| `skipPrompts` | `--skip-prompts` | boolean | `false` | Skip interactive prompts and use configuration from other sources (env: `MCC_SKIP_PROMPTS`) |
| `autoPrompt` | `--auto-prompt` | boolean | `false` | Fill defaults, prompt only for missing required values |
| `config` | `--config` | string | — | Path to JSON configuration file |
| `projectDir` | `--project-dir` | string | — | Output directory path (env: `ML_PROJECT_DIR`) |
| `force` | `--force` | boolean | `false` | Overwrite existing output directory without prompting |
| `smart` | `--smart` | boolean | `false` | Enable smart mode (live AWS API calls for MCP servers) |
| `discover` | `--discover` | boolean | `false` | Enable discovery mode for MCP servers |
| `noValidate` | `--no-validate` | boolean | `false` | Skip parameter validation |
| `validateEnvVars` | `--validate-env-vars` | boolean | `false` | Validate environment variables against schema |
| `validateWithDocker` | `--validate-with-docker` | boolean | `false` | Validate Dockerfile builds successfully |
| `offline` | `--offline` | boolean | `false` | Run in offline mode (no network calls) |

### Model & Server

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `deploymentConfig` | `--deployment-config` | enum (16 values) | — | Deployment configuration (e.g. http-flask, transformers-vllm, triton-fil) (env: `ML_DEPLOYMENT_CONFIG`) |
| `modelName` | `--model-name` | string | — | Model identifier (hf-org/model, s3://..., registry://..., marketplace://...) (env: `ML_MODEL_NAME`) |
| `framework` | `--framework` | enum: `sklearn`, `xgboost`, `tensorflow`, `transformers` | — | ~~ML framework~~ *(deprecated, use `--deploymentConfig` instead)* |
| `modelFormat` | `--model-format` | string | — | Model serialization format (pkl, joblib, json, model, ubj, keras, h5, SavedModel) (env: `ML_MODEL_FORMAT`) |
| `modelServer` | `--model-server` | enum: `flask`, `fastapi`, `vllm`, `sglang` | — | ~~Model server~~ *(deprecated, use `--deploymentConfig` instead)* |
| `modelEnv` | `--model-env` | string | `[]` | Model env var, repeatable (e.g. VLLM_TENSOR_PARALLEL_SIZE=4) |
| `serverEnv` | `--server-env` | string | `[]` | Server env var, repeatable (e.g. SGLANG_MEM_FRACTION=0.9) |

### Infrastructure

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `deploymentTarget` | `--deployment-target` | enum (5 values) | `realtime-inference` | Deployment target (realtime-inference, async-inference, batch-transform, hyperpod-eks). `managed-inference` is accepted but deprecated (env: `ML_DEPLOYMENT_TARGET`) |
| `instanceType` | `--instance-type` | string | — | SageMaker instance type (e.g. ml.g5.xlarge, ml.m5.large) (env: `ML_INSTANCE_TYPE`) |
| `region` | `--region` | string | `us-east-1` | AWS region (env: `ML_REGION`) |
| `roleArn` | `--role-arn` | string | — | IAM role ARN for SageMaker execution (env: `ML_ROLE_ARN`) |

### Build

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `baseImage` | `--base-image` | string | — | Base container image for Dockerfile (env: `ML_BASE_IMAGE`) |
| `buildTarget` | `--build-target` | string | `codebuild` | Build target (codebuild) (env: `ML_BUILD_TARGET`) |
| `codebuildComputeType` | `--codebuild-compute-type` | string | `BUILD_GENERAL1_LARGE` | CodeBuild compute type (SMALL, MEDIUM, LARGE) (env: `ML_CODEBUILD_COMPUTE_TYPE`) |

### Endpoint

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `endpointInitialInstanceCount` | `--endpoint-initial-instance-count` | integer | `1` | Number of instances for the endpoint (env: `ML_ENDPOINT_INSTANCE_COUNT`) |
| `endpointDataCapturePercent` | `--endpoint-data-capture-percent` | integer | `0` | Data capture percentage for monitoring, 0-100 |
| `endpointVariantName` | `--endpoint-variant-name` | string | `AllTraffic` | Production variant name |
| `endpointVolumeSize` | `--endpoint-volume-size` | integer | — | ML storage volume size in GB |

### Capacity & Serving

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `capacityReservationArn` | `--capacity-reservation-arn` | string | — | FTP/capacity reservation ARN for deploying on reserved capacity. Mutually exclusive with `instancePools`. |
| `instancePools` | `--instance-pools` | JSON | — | Heterogeneous instance types with priority-based fallback. Mutually exclusive with `capacityReservationArn`. |
| `serverEnv` | `--server-env` | string[] | — | Container environment variable overrides (e.g., `SM_VLLM_KV_CACHE_DTYPE=fp8`). Repeatable flag. |


### Inference Component

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `icGpuCount` | `--ic-gpu-count` | integer | — | GPUs allocated to the inference component (env: `ML_IC_GPU_COUNT`) |
| `icCopyCount` | `--ic-copy-count` | integer | `1` | Number of inference component copies (env: `ML_IC_COPY_COUNT`) |
| `icMemorySize` | `--ic-memory-size` | integer | — | Memory in MB for the inference component (env: `ML_IC_MEMORY_SIZE`) |
| `icCpuCount` | `--ic-cpu-count` | number | — | vCPUs allocated to the inference component (env: `ML_IC_CPU_COUNT`) |
| `icModelWeight` | `--ic-model-weight` | number | `1` | Traffic routing weight, 0-1 |

### LoRA Adapters

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `enableLora` | `--enable-lora` | boolean | `true` | Enable LoRA adapter serving (env: `ML_ENABLE_LORA`). Disable with `--enable-lora=false` |
| `maxLoras` | `--max-loras` | integer | `30` | Maximum concurrent LoRA adapters in GPU memory (env: `ML_MAX_LORAS`) |
| `maxLoraRank` | `--max-lora-rank` | integer | `64` | Maximum LoRA rank (env: `ML_MAX_LORA_RANK`) |

### Authentication

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `hfToken` | `--hf-token` | string | — | HuggingFace token (or $HF_TOKEN for env var reference) |
| `hfTokenArn` | `--hf-token-arn` | string | — | HuggingFace token ARN from Secrets Manager (env: `ML_HF_TOKEN_ARN`) |
| `ngcToken` | `--ngc-token` | string | — | NVIDIA NGC token (or $NGC_API_KEY for env var reference) |
| `ngcTokenArn` | `--ngc-token-arn` | string | — | NVIDIA NGC token ARN from Secrets Manager (env: `ML_NGC_TOKEN_ARN`) |

### Async Inference

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `asyncS3OutputPath` | `--async-s3-output-path` | string | — | S3 output path for async results (env: `ML_ASYNC_S3_OUTPUT_PATH`) |
| `asyncSnsSuccessTopic` | `--async-sns-success-topic` | string | — | SNS topic ARN for success notifications |
| `asyncSnsErrorTopic` | `--async-sns-error-topic` | string | — | SNS topic ARN for error notifications |
| `asyncMaxConcurrent` | `--async-max-concurrent` | integer | `1` | Max concurrent invocations per instance |

### Batch Transform

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `batchInputPath` | `--batch-input-path` | string | — | S3 input path for batch data (env: `ML_BATCH_INPUT_PATH`) |
| `batchOutputPath` | `--batch-output-path` | string | — | S3 output path for batch results (env: `ML_BATCH_OUTPUT_PATH`) |
| `batchInstanceCount` | `--batch-instance-count` | integer | `1` | Number of batch instances |
| `batchSplitType` | `--batch-split-type` | enum: `Line`, `RecordIO`, `None` | `Line` | Input split type: Line, RecordIO, None |
| `batchStrategy` | `--batch-strategy` | enum: `MultiRecord`, `SingleRecord` | `MultiRecord` | Batch strategy: MultiRecord, SingleRecord |
| `batchJoinSource` | `--batch-join-source` | enum: `Input`, `None` | `None` | Join source: Input, None |
| `batchMaxConcurrent` | `--batch-max-concurrent` | integer | `1` | Max concurrent transforms per instance |
| `batchMaxPayload` | `--batch-max-payload` | integer | `6` | Max payload size in MB, 0-100 |

### HyperPod EKS

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `hyperpodCluster` | `--hyperpod-cluster` | string | — | HyperPod EKS cluster name (env: `ML_HYPERPOD_CLUSTER`) |
| `hyperpodNamespace` | `--hyperpod-namespace` | string | `default` | Kubernetes namespace (env: `ML_HYPERPOD_NAMESPACE`) |
| `hyperpodReplicas` | `--hyperpod-replicas` | integer | `1` | Number of replicas |
| `fsxVolumeHandle` | `--fsx-volume-handle` | string | — | FSx for Lustre volume handle (env: `ML_FSX_VOLUME_HANDLE`) |

### Benchmarking

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `includeBenchmark` | `--include-benchmark` | boolean | `true` | Include `do/benchmark` script in the generated project (env: `ML_INCLUDE_BENCHMARK`). Disable with `--include-benchmark=false` |

!!! note "Runtime resolution"
    Benchmark parameters (concurrency, token counts, streaming, S3 paths) are **not** set at generation time. They are resolved at runtime by `do/benchmark --workload <name>` from the workload-picker MCP server and the bootstrap profile. See [Benchmarking](benchmarking.md) for workload profiles and the full runtime flow.

### Testing

| Parameter | CLI Flag | Type | Default | Description |
|---|---|---|---|---|
| `includeSample` | `--include-sample` | boolean | `true` | Include sample model code (env: `ML_INCLUDE_SAMPLE`) |
| `includeTesting` | `--include-testing` | boolean | `true` | Include test suite (env: `ML_INCLUDE_TESTING`) |
| `testTypes` | `--test-types` | string | — | Comma-separated test types (env: `ML_TEST_TYPES`) |


### Deployment Configs

The `--deployment-config` flag bundles the architecture and model server into a single value:

| Config | Architecture | Backend | Use Case |
|--------|-------------|---------|----------|
| `http-flask` | HTTP | Flask | Traditional ML with Flask server |
| `http-fastapi` | HTTP | FastAPI | Traditional ML with FastAPI server |
| `transformers-vllm` | Transformers | vLLM | LLM serving with vLLM |
| `transformers-sglang` | Transformers | SGLang | LLM serving with SGLang |
| `transformers-tensorrt-llm` | Transformers | TensorRT-LLM | LLM serving with TensorRT-LLM |
| `transformers-lmi` | Transformers | LMI | LLM serving with Large Model Inference |
| `transformers-djl` | Transformers | DJL | LLM serving with Deep Java Library |
| `triton-fil` | Triton | FIL | Tree models (XGBoost, LightGBM) on Triton |
| `triton-onnxruntime` | Triton | ONNX Runtime | ONNX models on Triton |
| `triton-tensorflow` | Triton | TensorFlow | TensorFlow models on Triton |
| `triton-pytorch` | Triton | PyTorch | PyTorch models on Triton |
| `triton-vllm` | Triton | vLLM | LLM serving on Triton |
| `triton-tensorrtllm` | Triton | TensorRT-LLM | LLM serving on Triton with TensorRT-LLM |
| `triton-python` | Triton | Python | Custom Python models on Triton |
| `diffusors-vllm-omni` | Diffusors | vLLM Omni | Diffusion/multimodal models |
| `marketplace` | Marketplace | — | AWS Marketplace model packages (no container build) |

For traditional ML configs (`http-flask`, `http-fastapi`), also specify `--model-format` to set the serialization format for your model.

The `marketplace` config deploys pre-built vendor model packages from AWS Marketplace. No Dockerfile, no build/push — just deploy, test, and benchmark. Use the `marketplace://` prefix with `--model-name`:

```bash
ml-container-creator my-marketplace-model \
  --deployment-config=marketplace \
  --model-name='marketplace://arn:aws:sagemaker:us-east-1:aws:model-package/vendor-model/1' \
  --instance-type=ml.g5.xlarge \
  --region=us-east-1
```

### Model Formats

| Framework | Supported Formats | Default |
|-----------|-------------------|---------|
| sklearn | `pkl`, `joblib` | `pkl` |
| xgboost | `json`, `model`, `ubj` | `json` |
| tensorflow | `keras`, `h5`, `SavedModel` | `keras` |
| transformers | N/A (models loaded from HuggingFace Hub) | — |


!!! info "S3 Model URIs"
    When the model identifier starts with `s3://`, MCC loads model weights directly from S3 instead of downloading from HuggingFace. This enables faster cold-start for pre-staged models. Example: `--model-name s3://my-bucket/models/gemma-4-31b/`

!!! info "Runtime Profile Resolution (v0.12.0)"
    Generated projects include `do/lib/profile.sh` which reads the active bootstrap profile (`~/.ml-container-creator/config.json`) at runtime. Values like S3 bucket names, account ID, and region are resolved from the profile — no need to regenerate when switching profiles. Scripts use `${_PROFILE[key]}` for profile values, with env var precedence: explicit env var > profile > default.


## Configuration Methods

### Interactive Mode

The default. Run the generator and answer the prompts:

```bash
ml-container-creator
```

### CLI Options

Use command-line flags for non-interactive generation:

```bash
ml-container-creator my-project \
  --deployment-config=http-flask \
  --model-format=pkl \
  --deployment-target=realtime-inference \
  --instance-type=ml.m5.large \
  --skip-prompts
```

The project name can also be passed as a positional argument (priority 2 in the precedence chain).

### Environment Variables

Set infrastructure parameters via the shell environment:

```bash
export ML_INSTANCE_TYPE="ml.g5.2xlarge"
export ML_REGION="us-west-2"
export ML_ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerAIRole"

ml-container-creator --deployment-config=transformers-vllm --skip-prompts
```

Many parameters support environment variables (listed in the parameter reference above with `env:` annotations). Infrastructure and model parameters are commonly set via env vars in CI pipelines.

### Configuration Files

Three file-based sources are supported, in descending precedence:

**CLI config file** (`--config` flag or `ML_CONTAINER_CREATOR_CONFIG` env var):

```bash
ml-container-creator --config=production.json --skip-prompts
```

**Custom config file** (`config/mcp.json`, auto-discovered):

```json
{
  "projectName": "my-ml-project",
  "deploymentConfig": "http-flask",
  "modelFormat": "pkl",
  "includeSample": false,
  "includeTesting": true,
  "deploymentTarget": "realtime-inference",
  "buildTarget": "codebuild",
  "instanceType": "ml.m5.large",
  "region": "us-east-1",
  "roleArn": "arn:aws:iam::123456789012:role/SageMakerAIRole"
}
```

**Package.json section** (infrastructure and project settings only):

```json
{
  "name": "my-project",
  "ml-container-creator": {
    "region": "us-west-2",
    "roleArn": "arn:aws:iam::123456789012:role/MyProjectRole",
    "projectName": "my-ml-service"
  }
}
```

## CLI Commands

Beyond project generation, MCC provides configuration management commands:

| Command | Description |
|---------|-------------|
| `ml-container-creator configure` | Interactive configuration file setup |
| `ml-container-creator generate-empty-config` | Create an empty config file template |
| `ml-container-creator help` | Show all options and examples |

## HuggingFace Authentication

When deploying transformer models, you may need to authenticate with HuggingFace to access private or gated models. Public models like `Qwen/Qwen3-4B` do not require authentication.

Authentication is required for:

- Private models in your HuggingFace account
- Gated models requiring license agreement (e.g., Llama 3)
- Avoiding rate limits on public models

### Providing Your Token

**CLI option:**

```bash
ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --hf-token='$HF_TOKEN' \
  --skip-prompts
```

**Config file:**

```json
{
  "deploymentConfig": "transformers-vllm",
  "modelName": "meta-llama/Llama-3.1-8B-Instruct",
  "hfToken": "$HF_TOKEN"
}
```

**Interactive prompt:** When you enter a custom model ID during generation, you will be prompted for a token. You can enter the token directly, reference `$HF_TOKEN`, or leave it empty for public models.

### Secrets Manager Alternative

For improved security, use AWS Secrets Manager instead of plaintext tokens. Pass an ARN instead of a literal value:

```bash
ml-container-creator my-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --hf-token-arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token \
  --skip-prompts
```

This resolves the token at build-time and runtime without baking it into the image. See [Secrets Management](secrets.md) for the full workflow, including creating and managing secrets.

!!! note
    You cannot use both `--hf-token` and `--hf-token-arn` simultaneously. Choose one approach per project.

### Security

Tokens are baked into the Docker image. Anyone with access to the image can extract the token via `docker inspect`.

- Use `$HF_TOKEN` (environment variable reference) in config files and CI/CD pipelines instead of literal tokens.
- Never commit tokens to version control.
- Use read-only tokens with minimal permissions.
- Rotate tokens periodically. Generate new ones at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
- Consider using [Secrets Manager](secrets.md) for zero-knowledge images and automatic rotation.

### Troubleshooting Authentication

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Repository not found" or "Access denied" | Invalid token, expired token, or license not accepted | Verify token at huggingface.co; accept model license |
| "HF_TOKEN environment variable not set" | `$HF_TOKEN` referenced but not exported | `export HF_TOKEN=hf_...` |
| Container builds but fails at runtime | Model requires auth but no token provided | Rebuild with `--hf-token` |

## Validation

The generator validates configuration at multiple levels:

### Parameter Validation

The generator validates configuration parameters and provides error messages:

```text
# Invalid deployment config
ml-container-creator --deployment-config=invalid --skip-prompts
# Error: invalid not implemented yet.

# Incompatible model format
ml-container-creator --deployment-config=http-flask --model-format=json --skip-prompts
# Error: Unsupported model format 'json' for http-flask (sklearn supports pkl, joblib)

# Invalid ARN
ml-container-creator --role-arn=invalid-arn --skip-prompts
# Error: Invalid AWS Role ARN format

# Missing required parameter
ml-container-creator --skip-prompts
# Error: Required parameter 'deploymentConfig' is missing
```

Do not mix incompatible options: traditional ML engines with LLM deployment configs, model formats with transformer configs, or sample models with transformer configs will all produce validation errors.

### Schema-Driven Validation

Schema-driven validation checks generated AWS API payloads against the actual AWS service model (`service-2.json`) files. It catches issues that parameter validation cannot — enum values that AWS has deprecated, type mismatches in nested structures, missing required fields for specific API operations, and cross-cutting consistency problems between your Dockerfile, deploy scripts, and configuration.

#### Setup

Download the AWS service models into your local schema registry:

```bash
ml-container-creator bootstrap sync-schemas
```

This downloads service models for SageMaker AI, IAM, ECR, and S3 from the AWS SDK source and stores them at `~/.ml-container-creator/schemas/`. Re-run periodically to pick up new enum values and API changes.

#### When Validation Runs

Schema validation runs at two points:

**At generation time (non-blocking):** After the generator produces deploy scripts, it validates the constructed payloads and prints any issues as warnings. Generation still completes — this is informational.

**At pre-deploy time (blocking):** Run `./do/validate` before deploying to catch all issues, including those introduced by manual edits to `do/config` after generation.

```bash
# Run full schema validation
./do/validate

# JSON output for CI integration
./do/validate --format=json

# Include smart-mode validators (future MCP integration)
./do/validate --smart
```

#### What It Checks

| Check | Example Issue Caught |
|-------|---------------------|
| **Enum values** | `InferenceAmiVersion` set to a value AWS no longer accepts |
| **Type mismatches** | `InitialInstanceCount` set to a string instead of integer |
| **Required fields** | `EndpointConfigName` missing from CreateEndpointConfig payload |
| **Pattern constraints** | Role ARN not matching `arn:aws:iam::\d{12}:role/.+` |
| **Range constraints** | `VolumeSizeInGB` below minimum or above maximum |
| **GPU consistency** | `NumberOfAcceleratorDevicesRequired` doesn't match instance GPU count |
| **Tensor parallelism** | `VLLM_TENSOR_PARALLEL_SIZE` != IC GPU count != instance GPUs |
| **CUDA compatibility** | Base image requires CUDA 12 but instance only supports CUDA 11 |
| **Model source requirements** | `jumpstart-hub` source without `HubAccessConfig.HubContentArn` |

#### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Validation passed (no errors, may have warnings) |
| 1 | Validation failed (one or more errors found) |
| 2 | Validation could not run (schema registry missing) |

#### Keeping Schemas Current

The schema registry becomes stale as AWS adds new enum values and instance types. If schemas are older than 30 days, validation prints a warning:

```
⚠️  Schema registry is 45 days old. Run `ml-container-creator bootstrap sync-schemas` to update.
```

Suppress this warning with `--ignore-staleness` if you're working offline.

#### Catalog Validation

Validate that catalog entries use valid AWS enum values:

```bash
npm run validate:catalogs
```

This checks fields like `inferenceAmiVersion` in `model-servers.json` against the SageMaker AI service model's enum set. Run this as a CI gate when updating catalog files.

#### Skipping Validation

Pass `--no-validate` to the generator to skip schema validation at generation time:

```bash
ml-container-creator my-project --deployment-config=transformers-vllm --no-validate --skip-prompts
```

### Architecture Compatibility

Architecture compatibility validation checks whether your chosen model's `model_type` (from its HuggingFace `config.json`) is supported by the selected server version. This catches mismatches early — before you spend time building and deploying a container that won't load the model.

#### Syncing Architecture Data

Populate the architecture registry by scraping model type lists from server GitHub repositories (vLLM, SGLang, TensorRT-LLM):

```bash
ml-container-creator registry sync-architectures
```

This fetches each server version's model registry source file, parses it for supported `model_type` values, and writes them into the `supportedModelTypes` field in `model-servers.json`.

!!! note
    `bootstrap` automatically runs `sync-architectures` as part of its post-setup chain. You only need to run it manually to pick up newly released server versions.

#### Viewing Supported Architectures

List supported architecture counts per server version:

```bash
ml-container-creator registry list-architectures
```

Output:

```
Model Architecture Support:

  Server                Version      Architectures
  ════════════════════  ═══════════  ═════════════
  vllm                  0.6.3        85
  vllm                  0.5.5        72
  sglang                0.4.1        68
  tensorrt-llm          0.15.0       45
```

Filter by server or show the full model type list:

```bash
ml-container-creator registry list-architectures --server vllm
ml-container-creator registry list-architectures --verbose
```

#### Pre-Generation Compatibility Check

Check a specific model's compatibility before generating a project:

```bash
ml-container-creator registry check meta-llama/Llama-3.1-8B-Instruct
```

Output:

```
🔍 Checking model: meta-llama/Llama-3.1-8B-Instruct

   Fetching model config from HuggingFace...
   Model type: llama

   ✅ Compatible server versions:
      • vllm 0.6.3
      • vllm 0.5.5
      • sglang 0.4.1
      • tensorrt-llm 0.15.0

   ⚠️  Potentially incompatible server versions:
      • tensorrt-llm 0.12.0
```

This fetches the model's `config.json` from HuggingFace, extracts the `model_type`, and checks it against all server versions in the catalog.

#### Generation-Time Warning

When you generate a project, the architecture check runs automatically. If the model type is not in the server's supported list, you'll see an advisory warning:

```
⚠️  Model architecture "mamba" may not be supported by vllm 0.5.5. Consider a newer server version.
```

This is advisory only — generation still completes. Some models work via `trust_remote_code` even when not in the official registry.

#### `do/validate` Architecture Findings

The `do/validate` script includes architecture compatibility as one of its cross-cutting checks. If the model type doesn't match the server's supported list, it reports a medium-confidence warning alongside other validation findings.
