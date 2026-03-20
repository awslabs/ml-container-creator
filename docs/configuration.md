# Configuration Guide

ML Container Creator supports multiple configuration methods with a clear precedence order, allowing you to choose the approach that best fits your workflow - from interactive prompts to fully automated CLI usage.

## Configuration Precedence

Configuration sources are applied in strict precedence order (highest to lowest priority):

| Priority | Source | Description | Example |
|----------|--------|-------------|---------|
| **1** | CLI Options | Command-line flags | `--deployment-config=http-flask` |
| **2** | CLI Arguments | Positional arguments | `yo @aws/ml-container-creator my-project` |
| **3** | Environment Variables | Shell environment | `export AWS_REGION=us-east-1` |
| **4** | CLI Config File | `--config` specified file | `--config=production.json` |
| **5** | Custom Config File | `config/mcp.json` | Auto-discovered in current directory |
| **6** | Package.json Section | `"ml-container-creator": {...}` | Project-specific defaults |
| **7** | Generator Defaults | Built-in defaults | `awsRegion: "us-east-1"` |
| **8** | Interactive Prompts | User input (fallback) | Yeoman prompts |

!!! tip "Configuration Strategy"
    Higher precedence sources override lower ones. Use CLI options for one-off changes, environment variables for deployment environments, and config files for repeatable setups.

## Parameter Matrix

This table shows which parameters are supported by each configuration source:

| Parameter | CLI Option | CLI Arg | Env Var | Config File | Package.json | Default | Promptable | Required |
|-----------|------------|---------|---------|-------------|--------------|---------|------------|----------|
| **Core Parameters** |
| Deployment Config | `--deployment-config` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| Engine | `--engine` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| Framework | `--framework` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| Model Server | `--model-server` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| Model Format | `--model-format` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| **Module Options** |
| Include Sample | `--include-sample` | ❌ | ❌ | ✅ | ❌ | `false` | ✅ | ✅ |
| Include Testing | `--include-testing` | ❌ | ❌ | ✅ | ❌ | `true` | ✅ | ✅ |
| **Infrastructure** |
| Deployment Target | `--deployment-target` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| Build Target | `--build-target` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| Instance Type | `--instance-type` | ❌ | `ML_INSTANCE_TYPE` | ✅ | ❌ | N/A | ✅ | ✅ |
| CodeBuild Compute Type | `--codebuild-compute-type` | ❌ | ❌ | ✅ | ❌ | `BUILD_GENERAL1_MEDIUM` | ✅ | ❌ |
| AWS Region | `--region` | ❌ | `AWS_REGION` | ✅ | ✅ | `us-east-1` | ✅ | ❌ |
| AWS Role ARN | `--role-arn` | ❌ | `AWS_ROLE` | ✅ | ✅ | N/A | ✅ | ❌ |
| **HyperPod EKS** |
| HyperPod Cluster | `--hyperpod-cluster` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| HyperPod Namespace | `--hyperpod-namespace` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| HyperPod Replicas | `--hyperpod-replicas` | ❌ | ❌ | ✅ | ❌ | `1` | ✅ | ❌ |
| FSx Volume Handle | `--fsx-volume-handle` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ❌ |
| **Project Settings** |
| Project Name | `--project-name` | ✅ | ❌ | ✅ | ✅ | N/A | ❌ | ✅ |
| Project Directory | `--project-dir` | ❌ | ❌ | ✅ | ✅ | `.` | ❌ | ✅ |
| **System Options** |
| Config File | `--config` | ❌ | `ML_CONTAINER_CREATOR_CONFIG` | ❌ | ✅ | N/A | ✅ | ❌ |
| Skip Prompts | `--skip-prompts` | ❌ | ❌ | ❌ | ❌ | `false` | ❌ | ❌ |

### Legend
- ✅ **Supported** - Parameter can be set from this source
- ❌ **Not Supported** - Parameter ignored from this source
- **Promptable** - Can be collected via interactive prompts
- **Required** - Must be provided from some source

## Configuration Methods

### 1. Interactive Mode (Default)

The simplest approach - just run the generator and answer the prompts:

```bash
yo @aws/ml-container-creator
```

The generator will guide you through all configuration options with smart defaults and validation.

### 2. CLI Options (Highest Precedence)

Use command-line flags for quick one-off configurations:

```bash
# Basic sklearn project
yo @aws/ml-container-creator my-project \
  --deployment-config=http-flask \
  --engine=sklearn \
  --model-format=pkl \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --build-target=codebuild \
  --skip-prompts

# Advanced LLM configuration
yo @aws/ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.2xlarge \
  --region=us-west-2 \
  --role-arn=arn:aws:iam::123456789012:role/SageMakerRole \
  --build-target=codebuild \
  --skip-prompts
```

#### Supported CLI Options

| Option | Type | Description | Values |
|--------|------|-------------|--------|
| `--skip-prompts` | Boolean | Skip interactive prompts | `true`/`false` |
| `--config=<file>` | String | Load configuration from file | File path |
| `--project-name=<name>` | String | Project name | Any valid name |
| `--project-dir=<dir>` | String | Output directory | Directory path |
| `--deployment-config=<config>` | String | Deployment configuration | See [Deployment Configs](#deployment-configs) |
| `--engine=<engine>` | String | ML engine (traditional ML only) | `sklearn`, `xgboost`, `tensorflow` |
| `--framework=<framework>` | String | ML framework (deprecated) | Use `--deployment-config` instead |
| `--model-server=<server>` | String | Model server (deprecated) | Use `--deployment-config` instead |
| `--model-format=<format>` | String | Model format | Framework-dependent |
| `--include-sample` | Boolean | Include sample model code | `true`/`false` |
| `--include-testing` | Boolean | Include test suite | `true`/`false` |
| `--deployment-target=<target>` | String | Where the model runs | `managed-inference`, `hyperpod-eks` |
| `--build-target=<target>` | String | Where Docker image is built | `codebuild` |
| `--instance-type=<type>` | String | AWS instance type | `ml.m5.large`, `ml.g5.2xlarge`, etc. |
| `--codebuild-compute-type=<type>` | String | CodeBuild compute type | `BUILD_GENERAL1_SMALL`, `BUILD_GENERAL1_MEDIUM`, `BUILD_GENERAL1_LARGE` |
| `--region=<region>` | String | AWS region | AWS region code |
| `--role-arn=<arn>` | String | AWS IAM role ARN | Valid ARN |
| `--hyperpod-cluster=<name>` | String | HyperPod EKS cluster name | Cluster name |
| `--hyperpod-namespace=<ns>` | String | HyperPod K8s namespace | Namespace |
| `--hyperpod-replicas=<n>` | Number | HyperPod replica count | `1` (default) |
| `--fsx-volume-handle=<id>` | String | FSx volume handle for HyperPod | Volume ID |

#### Deployment Configs

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

For traditional ML configs (`http-flask`, `http-fastapi`), also specify `--engine` to set the ML framework (e.g., `--engine=sklearn`).

### 3. CLI Arguments

Use positional arguments for the project name:

```bash
# Project name as first argument
yo @aws/ml-container-creator my-awesome-model --deployment-config=http-flask --engine=sklearn --skip-prompts
```

### 4. Environment Variables

Set environment variables for deployment-specific configuration:

```bash
# Set environment variables
export ML_INSTANCE_TYPE="ml.g5.2xlarge"
export AWS_REGION="us-west-2"
export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"
export ML_CONTAINER_CREATOR_CONFIG="./production.json"

# Generate with environment config + CLI options for core parameters
yo @aws/ml-container-creator --deployment-config=transformers-vllm --skip-prompts
```

#### Supported Environment Variables

| Variable | Maps To | Description | Example |
|----------|---------|-------------|---------|
| `ML_INSTANCE_TYPE` | `instanceType` | AWS instance type | `ml.m5.large`, `ml.g5.2xlarge` |
| `AWS_REGION` | `awsRegion` | AWS region | `us-east-1` |
| `AWS_ROLE` | `awsRoleArn` | AWS IAM role ARN | `arn:aws:iam::123456789012:role/SageMakerRole` |
| `ML_CONTAINER_CREATOR_CONFIG` | `configFile` | Config file path | `./my-config.json` |

!!! note "Limited Environment Variable Support"
    Only infrastructure and system parameters support environment variables. Core parameters (deployment-config, engine, etc.) must be configured via CLI options or configuration files for security and clarity.

### 5. Configuration Files

#### Custom Config File (`config/mcp.json`)

Create a configuration file in your project directory:

```json
{
  "projectName": "my-ml-project",
  "deploymentConfig": "http-flask",
  "engine": "sklearn",
  "modelFormat": "pkl",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "hosted-model-endpoint"],
  "deploymentTarget": "managed-inference",
  "buildTarget": "codebuild",
  "instanceType": "ml.m5.large",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/SageMakerRole"
}
```

```bash
# Use the config file
yo @aws/ml-container-creator --skip-prompts
```

#### CLI Config File (`--config`)

Specify a custom config file location:

```bash
# Use specific config file
yo @aws/ml-container-creator --config=production.json --skip-prompts

# Config file via environment variable
export ML_CONTAINER_CREATOR_CONFIG="./staging.json"
yo @aws/ml-container-creator --skip-prompts
```

#### Package.json Section

Add configuration to your `package.json` for project-specific defaults:

```json
{
  "name": "my-project",
  "ml-container-creator": {
    "awsRegion": "us-west-2",
    "awsRoleArn": "arn:aws:iam::123456789012:role/MyProjectRole",
    "projectName": "my-ml-service",
    "includeTesting": true
  }
}
```

!!! note "Package.json Limitations"
    Only infrastructure and project settings are supported in package.json. Core parameters (deployment-config, engine, etc.) are not supported to avoid confusion.

## CLI Commands

Special CLI commands for configuration management:

### Interactive Configuration Setup

```bash
yo @aws/ml-container-creator configure
```

Guides you through creating configuration files with validation and examples.

### Generate Empty Config

```bash
yo @aws/ml-container-creator generate-empty-config
```

Creates an empty configuration file template that you can customize.

### Help

```bash
yo @aws/ml-container-creator help
# or
yo @aws/ml-container-creator --help
```

Shows comprehensive help with all options, examples, and configuration methods.

## HuggingFace Authentication

When deploying transformer models, you may need to authenticate with HuggingFace to access private or gated models.

### When is Authentication Needed?

HuggingFace authentication is required for:
- **Private models**: Models in private repositories
- **Gated models**: Models requiring user agreement (e.g., Llama 2, Llama 3)
- **Rate-limited access**: Avoiding rate limits on public models

Public models like `openai/gpt-oss-20b` do not require authentication.

### Providing Your HF_TOKEN

#### Option 1: Interactive Prompt (Recommended for Local Development)

When you manually enter a transformer model ID (not selecting from examples), you'll be prompted:

```
🔐 HuggingFace Authentication
⚠️  Security Note: The token will be baked into the Docker image.
   For CI/CD, consider using "$HF_TOKEN" to reference an environment variable.

? HuggingFace token (enter token, "$HF_TOKEN" for env var, or leave empty):
```

You can:
- **Enter your token directly**: `hf_abc123...`
- **Reference an environment variable**: `$HF_TOKEN`
- **Leave empty for public models**: (press Enter)

#### Option 2: CLI Option

```bash
# Direct token
yo @aws/ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-hf \
  --hf-token=hf_abc123... \
  --skip-prompts

# Environment variable reference
yo @aws/ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-hf \
  --hf-token='$HF_TOKEN' \
  --skip-prompts
```

#### Option 3: Configuration File

```json
{
  "deploymentConfig": "transformers-vllm",
  "modelName": "meta-llama/Llama-2-7b-hf",
  "hfToken": "$HF_TOKEN"
}
```

### Security Best Practices

!!! warning "Security Considerations"
    Tokens are baked into the Docker image. Anyone with access to your Docker image can extract the token using `docker inspect`.

**Best Practices:**

1. **Use environment variable references for CI/CD**:
   ```bash
   export HF_TOKEN=hf_your_token_here
   yo @aws/ml-container-creator --deployment-config=transformers-vllm --hf-token='$HF_TOKEN' --skip-prompts
   ```

2. **Never commit tokens to version control**: Use `$HF_TOKEN` in config files, not actual tokens.

3. **Rotate tokens regularly**: Generate new tokens periodically from your HuggingFace account.

4. **Use read-only tokens**: Create tokens with minimal permissions (read-only access to specific models).

### Getting Your HF_TOKEN

1. Go to https://huggingface.co/settings/tokens
2. Click "New token"
3. Give it a descriptive name (e.g., "sagemaker-deployment")
4. Select "Read" access
5. Copy the token (starts with `hf_`)

### Troubleshooting Authentication

**Error: "Repository not found" or "Access denied"**
- Verify your token is valid and not expired
- Ensure you've accepted the model's license agreement on HuggingFace
- Check that your token has access to the model's organization

**Error: "HF_TOKEN environment variable not set"**
- You specified `$HF_TOKEN` but the environment variable is not set
- Set it: `export HF_TOKEN=hf_your_token_here`
- Or provide the token directly instead of using `$HF_TOKEN`

**Container builds but fails at runtime**
- The model requires authentication but no token was provided
- Rebuild with `--hf-token` option

For more troubleshooting, see the [Troubleshooting Guide](./TROUBLESHOOTING.md).

## Framework-Specific Configuration

### Traditional ML (sklearn, xgboost, tensorflow)

```bash
# scikit-learn with Flask
yo @aws/ml-container-creator sklearn-project \
  --deployment-config=http-flask \
  --engine=sklearn \
  --model-format=pkl \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --include-sample \
  --skip-prompts

# XGBoost with FastAPI
yo @aws/ml-container-creator xgb-project \
  --deployment-config=http-fastapi \
  --engine=xgboost \
  --model-format=json \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --skip-prompts

# TensorFlow with Flask
yo @aws/ml-container-creator tf-project \
  --deployment-config=http-flask \
  --engine=tensorflow \
  --model-format=SavedModel \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --skip-prompts
```

#### Model Format Options

| Framework | Supported Formats | Default |
|-----------|-------------------|---------|
| **sklearn** | `pkl`, `joblib` | `pkl` |
| **xgboost** | `json`, `model`, `ubj` | `json` |
| **tensorflow** | `keras`, `h5`, `SavedModel` | `keras` |

### Large Language Models (transformers)

```bash
# Transformers with vLLM
yo @aws/ml-container-creator llm-project \
  --deployment-config=transformers-vllm \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.2xlarge \
  --region=us-west-2 \
  --skip-prompts

# Transformers with SGLang
yo @aws/ml-container-creator llm-project \
  --deployment-config=transformers-sglang \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.2xlarge \
  --skip-prompts
```

!!! note "Transformers Limitations"
    - Model format is not applicable (models loaded from Hugging Face Hub)
    - Sample models are not available
    - GPU-enabled instances are strongly recommended

## Configuration Examples

### Development Environment

```json
{
  "projectName": "dev-model",
  "deploymentConfig": "http-flask",
  "engine": "sklearn",
  "modelFormat": "pkl",
  "includeSampleModel": true,
  "includeTesting": true,
  "deploymentTarget": "managed-inference",
  "instanceType": "ml.m5.large",
  "awsRegion": "us-east-1"
}
```

### Production Environment

```json
{
  "projectName": "prod-recommendation-service",
  "deploymentConfig": "http-fastapi",
  "engine": "tensorflow",
  "modelFormat": "SavedModel",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-server", "hosted-model-endpoint"],
  "deploymentTarget": "managed-inference",
  "buildTarget": "codebuild",
  "instanceType": "ml.g4dn.xlarge",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/ProdSageMakerRole"
}
```

### LLM Deployment

```json
{
  "projectName": "llm-chat-service",
  "deploymentConfig": "transformers-vllm",
  "includeSampleModel": false,
  "includeTesting": true,
  "deploymentTarget": "managed-inference",
  "buildTarget": "codebuild",
  "instanceType": "ml.g5.12xlarge",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/LLMSageMakerRole"
}
```

## Anti-Patterns (What NOT to Do)

### ❌ Mixing Incompatible Options

```bash
# DON'T: traditional ML engine with LLM deployment config
yo @aws/ml-container-creator --deployment-config=transformers-vllm --engine=sklearn --skip-prompts

# DON'T: transformers with model format
yo @aws/ml-container-creator --deployment-config=transformers-vllm --model-format=pkl --skip-prompts

# DON'T: transformers with sample model
yo @aws/ml-container-creator --deployment-config=transformers-vllm --include-sample --skip-prompts
```

### ❌ Using Unsupported Environment Variables

```bash
# DON'T: Core parameters via environment variables
export ML_FRAMEWORK=sklearn        # Not supported
export ML_MODEL_SERVER=flask       # Not supported
export ML_MODEL_FORMAT=pkl         # Not supported

# DO: Use CLI options or config files for core parameters
yo @aws/ml-container-creator --deployment-config=http-flask --engine=sklearn --skip-prompts
```

### ❌ Invalid Configuration Files

```json
{
  // DON'T: Include unsupported parameters in package.json
  "ml-container-creator": {
    "framework": "sklearn",        // Not supported in package.json
    "modelServer": "flask",        // Not supported in package.json
    "awsRegion": "us-east-1"       // This is OK
  }
}
```

### ❌ Conflicting Configuration

```bash
# DON'T: Rely on precedence for critical settings
export AWS_REGION=us-east-1
yo @aws/ml-container-creator --region=us-west-2 --skip-prompts
# Confusing: CLI option wins, but not obvious
```

## Validation and Error Handling

The generator validates all configuration and provides clear error messages:

### Framework Validation

```bash
yo @aws/ml-container-creator --deployment-config=invalid --skip-prompts
# Error: ⚠️ invalid not implemented yet.
```

### Format Validation

```bash
yo @aws/ml-container-creator --deployment-config=http-flask --engine=sklearn --model-format=json --skip-prompts
# Error: Unsupported model format 'json' for engine 'sklearn'
```

### ARN Validation

```bash
yo @aws/ml-container-creator --role-arn=invalid-arn --skip-prompts
# Error: Invalid AWS Role ARN format
```

### Required Parameter Validation

```bash
yo @aws/ml-container-creator --skip-prompts
# Error: Required parameter 'deploymentConfig' is missing
```

## Best Practices

### 1. Use Configuration Files for Repeatable Setups

```bash
# Create once, use many times
yo @aws/ml-container-creator configure
yo @aws/ml-container-creator --skip-prompts  # Uses config/mcp.json
```

### 2. Use Environment Variables for Deployment Environments

```bash
# Different environments
export AWS_REGION=us-east-1     # Development
export AWS_REGION=us-west-2     # Production
```

### 3. Use CLI Options for One-Off Changes

```bash
# Quick test with different deployment config
yo @aws/ml-container-creator --deployment-config=http-fastapi --engine=sklearn --skip-prompts
```

### 4. Combine Methods Strategically

```bash
# Base config in file, environment-specific overrides
export AWS_REGION=us-west-2
yo @aws/ml-container-creator --config=base-config.json --skip-prompts
```

### 5. Validate Configuration Before Deployment

```bash
# Test configuration without skipping prompts first
yo @aws/ml-container-creator --config=production.json
# Review all settings, then use --skip-prompts for automation
```

## Troubleshooting Configuration

### Debug Configuration Loading

The generator shows which configuration sources are being used:

```bash
yo @aws/ml-container-creator --deployment-config=http-flask --engine=sklearn --skip-prompts

# Output shows:
# ⚙️ Configuration will be collected from prompts and merged with:
#    • Deployment config: http-flask
#    • No external configuration found
```

### Common Issues

1. **"Missing required parameter"** - Ensure all required parameters are provided
2. **"Invalid combination"** - Check framework/server/format compatibility
3. **"Config file not found"** - Verify file path and permissions
4. **"Precedence confusion"** - Use `--help` to see precedence order

### Getting Help

```bash
# Show all configuration options
yo @aws/ml-container-creator help

# Show interactive configuration
yo @aws/ml-container-creator configure

# Show environment variable examples
yo @aws/ml-container-creator configure  # Choose "Show environment variable examples"
```

This comprehensive configuration system ensures you can use ML Container Creator in any workflow, from interactive development to fully automated CI/CD pipelines.