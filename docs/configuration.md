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

This table shows every parameter, its CLI flag, which configuration sources support it, and whether it is required.

| Parameter | CLI Option | Env Var | Config File | Package.json | Default | Required |
|-----------|------------|---------|-------------|--------------|---------|----------|
| **Core** |
| Deployment Config | `--deployment-config` | -- | yes | -- | -- | yes |
| Engine | `--engine` | -- | yes | -- | -- | no |
| Framework | `--framework` | -- | yes | -- | -- | no |
| Model Server | `--model-server` | -- | yes | -- | -- | no |
| Model Format | `--model-format` | -- | yes | -- | -- | yes |
| **Modules** |
| Include Sample | `--include-sample` | -- | yes | -- | `false` | yes |
| Include Testing | `--include-testing` | -- | yes | -- | `true` | yes |
| **Infrastructure** |
| Deployment Target | `--deployment-target` | -- | yes | -- | -- | yes |
| Build Target | `--build-target` | -- | yes | -- | -- | yes |
| Instance Type | `--instance-type` | `ML_INSTANCE_TYPE` | yes | -- | -- | yes |
| CodeBuild Compute | `--codebuild-compute-type` | -- | yes | -- | `BUILD_GENERAL1_MEDIUM` | no |
| AWS Region | `--region` | `AWS_REGION` | yes | yes | `us-east-1` | no |
| AWS Role ARN | `--role-arn` | `AWS_ROLE` | yes | yes | -- | no |
| **HyperPod EKS** |
| Cluster | `--hyperpod-cluster` | -- | yes | -- | -- | no |
| Namespace | `--hyperpod-namespace` | -- | yes | -- | -- | no |
| Replicas | `--hyperpod-replicas` | -- | yes | -- | `1` | no |
| FSx Volume Handle | `--fsx-volume-handle` | -- | yes | -- | -- | no |
| **Project** |
| Project Name | `--project-name` | -- | yes | yes | -- | yes |
| Project Directory | `--project-dir` | -- | yes | yes | `.` | yes |
| **System** |
| Config File | `--config` | `ML_CONTAINER_CREATOR_CONFIG` | -- | yes | -- | no |
| Skip Prompts | `--skip-prompts` | -- | -- | -- | `false` | no |

Core parameters (deployment-config, engine, model-server, model-format) are not supported via environment variables or package.json. Only infrastructure and project settings are supported in those sources.

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

For traditional ML configs (`http-flask`, `http-fastapi`), also specify `--engine` to set the ML framework.

### Model Formats

| Framework | Supported Formats | Default |
|-----------|-------------------|---------|
| sklearn | `pkl`, `joblib` | `pkl` |
| xgboost | `json`, `model`, `ubj` | `json` |
| tensorflow | `keras`, `h5`, `SavedModel` | `keras` |
| transformers | N/A (models loaded from HuggingFace Hub) | -- |

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
  --engine=sklearn \
  --model-format=pkl \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --build-target=codebuild \
  --skip-prompts
```

The project name can also be passed as a positional argument (priority 2 in the precedence chain).

### Environment Variables

Set infrastructure parameters via the shell environment:

```bash
export ML_INSTANCE_TYPE="ml.g5.2xlarge"
export AWS_REGION="us-west-2"
export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"

ml-container-creator --deployment-config=transformers-vllm --skip-prompts
```

Only four environment variables are supported: `ML_INSTANCE_TYPE`, `AWS_REGION`, `AWS_ROLE`, and `ML_CONTAINER_CREATOR_CONFIG`. Core parameters must come from CLI options or config files.

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
  "engine": "sklearn",
  "modelFormat": "pkl",
  "includeSampleModel": false,
  "includeTesting": true,
  "deploymentTarget": "managed-inference",
  "buildTarget": "codebuild",
  "instanceType": "ml.m5.large",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/SageMakerRole"
}
```

**Package.json section** (infrastructure and project settings only):

```json
{
  "name": "my-project",
  "ml-container-creator": {
    "awsRegion": "us-west-2",
    "awsRoleArn": "arn:aws:iam::123456789012:role/MyProjectRole",
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

When deploying transformer models, you may need to authenticate with HuggingFace to access private or gated models. Public models like `openai/gpt-oss-20b` do not require authentication.

Authentication is required for:

- Private models in your HuggingFace account
- Gated models requiring license agreement (e.g., Llama 2, Llama 3)
- Avoiding rate limits on public models

### Providing Your Token

**CLI option:**

```bash
ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-hf \
  --hf-token='$HF_TOKEN' \
  --skip-prompts
```

**Config file:**

```json
{
  "deploymentConfig": "transformers-vllm",
  "modelName": "meta-llama/Llama-2-7b-hf",
  "hfToken": "$HF_TOKEN"
}
```

**Interactive prompt:** When you enter a custom model ID during generation, you will be prompted for a token. You can enter the token directly, reference `$HF_TOKEN`, or leave it empty for public models.

### Security

Tokens are baked into the Docker image. Anyone with access to the image can extract the token via `docker inspect`.

- Use `$HF_TOKEN` (environment variable reference) in config files and CI/CD pipelines instead of literal tokens.
- Never commit tokens to version control.
- Use read-only tokens with minimal permissions.
- Rotate tokens periodically. Generate new ones at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

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

```bash
# Invalid deployment config
ml-container-creator --deployment-config=invalid --skip-prompts
# Error: invalid not implemented yet.

# Incompatible model format
ml-container-creator --deployment-config=http-flask --engine=sklearn --model-format=json --skip-prompts
# Error: Unsupported model format 'json' for engine 'sklearn'

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

This downloads service models for SageMaker, IAM, ECR, and S3 from the AWS SDK source and stores them at `~/.ml-container-creator/schemas/`. Re-run periodically to pick up new enum values and API changes.

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

This checks fields like `inferenceAmiVersion` in `model-servers.json` against the SageMaker service model's enum set. Run this as a CI gate when updating catalog files.

#### Skipping Validation

Pass `--no-validate` to the generator to skip schema validation at generation time:

```bash
ml-container-creator my-project --deployment-config=transformers-vllm --no-validate --skip-prompts
```
