# Configuration Guide

ML Container Creator supports multiple configuration methods with a clear precedence order, allowing you to choose the approach that best fits your workflow - from interactive prompts to fully automated CLI usage.

## Configuration Precedence

Configuration sources are applied in strict precedence order (highest to lowest priority):

| Priority | Source | Description | Example |
|----------|--------|-------------|---------|
| **1** | CLI Options | Command-line flags | `--framework=sklearn` |
| **2** | CLI Arguments | Positional arguments | `yo ml-container-creator my-project` |
| **3** | Environment Variables | Shell environment | `export AWS_REGION=us-east-1` |
| **4** | CLI Config File | `--config` specified file | `--config=production.json` |
| **5** | Custom Config File | `ml-container.config.json` | Auto-discovered in current directory |
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
| Framework | `--framework` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| Model Server | `--model-server` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| Model Format | `--model-format` | ❌ | ❌ | ✅ | ❌ | N/A | ✅ | ✅ |
| **Module Options** |
| Include Sample | `--include-sample` | ❌ | ❌ | ✅ | ❌ | `false` | ✅ | ✅ |
| Include Testing | `--include-testing` | ❌ | ❌ | ✅ | ❌ | `true` | ✅ | ✅ |
| **Infrastructure** |
| Instance Type | `--instance-type` | ❌ | `ML_INSTANCE_TYPE` | ✅ | ❌ | N/A | ✅ | ✅ |
| Custom Instance Type | `--custom-instance-type` | ❌ | `ML_CUSTOM_INSTANCE_TYPE` | ✅ | ❌ | N/A | ✅ | ❌ |
| AWS Region | `--region` | ❌ | `AWS_REGION` | ✅ | ✅ | `us-east-1` | ✅ | ❌ |
| AWS Role ARN | `--role-arn` | ❌ | `AWS_ROLE` | ✅ | ✅ | N/A | ✅ | ❌ |
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
yo ml-container-creator
```

The generator will guide you through all configuration options with smart defaults and validation.

### 2. CLI Options (Highest Precedence)

Use command-line flags for quick one-off configurations:

```bash
# Basic sklearn project
yo ml-container-creator my-project \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --skip-prompts

# Advanced configuration
yo ml-container-creator my-llm-project \
  --framework=transformers \
  --model-server=vllm \
  --instance-type=gpu-enabled \
  --region=us-west-2 \
  --role-arn=arn:aws:iam::123456789012:role/SageMakerRole \
  --skip-prompts
```

#### Supported CLI Options

| Option | Type | Description | Values |
|--------|------|-------------|--------|
| `--skip-prompts` | Boolean | Skip interactive prompts | `true`/`false` |
| `--config=<file>` | String | Load configuration from file | File path |
| `--project-name=<name>` | String | Project name | Any valid name |
| `--project-dir=<dir>` | String | Output directory | Directory path |
| `--framework=<framework>` | String | ML framework | `sklearn`, `xgboost`, `tensorflow`, `transformers` |
| `--model-server=<server>` | String | Model server | `flask`, `fastapi`, `vllm`, `sglang` |
| `--model-format=<format>` | String | Model format | Framework-dependent |
| `--include-sample` | Boolean | Include sample model code | `true`/`false` |
| `--include-testing` | Boolean | Include test suite | `true`/`false` |
| `--instance-type=<type>` | String | Instance type | `cpu-optimized`, `gpu-enabled`, `custom` |
| `--custom-instance-type=<type>` | String | Custom AWS instance type | `ml.m5.large`, `ml.g4dn.xlarge` |
| `--region=<region>` | String | AWS region | AWS region code |
| `--role-arn=<arn>` | String | AWS IAM role ARN | Valid ARN |

### 3. CLI Arguments

Use positional arguments for the project name:

```bash
# Project name as first argument
yo ml-container-creator my-awesome-model --framework=sklearn --skip-prompts
```

### 4. Environment Variables

Set environment variables for deployment-specific configuration:

```bash
# Set environment variables
export ML_INSTANCE_TYPE="gpu-enabled"
export AWS_REGION="us-west-2"
export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"
export ML_CONTAINER_CREATOR_CONFIG="./production.json"

# Generate with environment config + CLI options for core parameters
yo ml-container-creator --framework=transformers --model-server=vllm --skip-prompts
```

#### Supported Environment Variables

| Variable | Maps To | Description | Example |
|----------|---------|-------------|---------|
| `ML_INSTANCE_TYPE` | `instanceType` | Instance type | `cpu-optimized`, `gpu-enabled`, `custom` |
| `ML_CUSTOM_INSTANCE_TYPE` | `customInstanceType` | Custom AWS instance type | `ml.g4dn.xlarge` |
| `AWS_REGION` | `awsRegion` | AWS region | `us-east-1` |
| `AWS_ROLE` | `awsRoleArn` | AWS IAM role ARN | `arn:aws:iam::123456789012:role/SageMakerRole` |
| `ML_CONTAINER_CREATOR_CONFIG` | `configFile` | Config file path | `./my-config.json` |

!!! note "Limited Environment Variable Support"
    Only infrastructure and system parameters support environment variables. Core parameters (framework, model-server, etc.) must be configured via CLI options or configuration files for security and clarity.

### 5. Configuration Files

#### Custom Config File (`ml-container.config.json`)

Create a configuration file in your project directory:

```json
{
  "projectName": "my-ml-project",
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "pkl",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "hosted-model-endpoint"],
  "deployTarget": "sagemaker",
  "instanceType": "cpu-optimized",
  "customInstanceType": "ml.m5.large",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/SageMakerRole"
}
```

```bash
# Use the config file
yo ml-container-creator --skip-prompts
```

#### CLI Config File (`--config`)

Specify a custom config file location:

```bash
# Use specific config file
yo ml-container-creator --config=production.json --skip-prompts

# Config file via environment variable
export ML_CONTAINER_CREATOR_CONFIG="./staging.json"
yo ml-container-creator --skip-prompts
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
    Only infrastructure and project settings are supported in package.json. Core parameters (framework, model-server, etc.) are not supported to avoid confusion.

## CLI Commands

Special CLI commands for configuration management:

### Interactive Configuration Setup

```bash
yo ml-container-creator configure
```

Guides you through creating configuration files with validation and examples.

### Generate Empty Config

```bash
yo ml-container-creator generate-empty-config
```

Creates an empty configuration file template that you can customize.

### Help

```bash
yo ml-container-creator help
# or
yo ml-container-creator --help
```

Shows comprehensive help with all options, examples, and configuration methods.

## Framework-Specific Configuration

### Traditional ML (sklearn, xgboost, tensorflow)

```bash
# scikit-learn with Flask
yo ml-container-creator sklearn-project \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --include-sample \
  --skip-prompts

# XGBoost with FastAPI
yo ml-container-creator xgb-project \
  --framework=xgboost \
  --model-server=fastapi \
  --model-format=json \
  --instance-type=cpu-optimized \
  --skip-prompts

# TensorFlow with custom format
yo ml-container-creator tf-project \
  --framework=tensorflow \
  --model-server=flask \
  --model-format=SavedModel \
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
yo ml-container-creator llm-project \
  --framework=transformers \
  --model-server=vllm \
  --instance-type=gpu-enabled \
  --region=us-west-2 \
  --skip-prompts

# Transformers with SGLang
yo ml-container-creator llm-project \
  --framework=transformers \
  --model-server=sglang \
  --instance-type=gpu-enabled \
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
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "pkl",
  "includeSampleModel": true,
  "includeTesting": true,
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1"
}
```

### Production Environment

```json
{
  "projectName": "prod-recommendation-service",
  "framework": "tensorflow",
  "modelServer": "fastapi",
  "modelFormat": "SavedModel",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-server", "hosted-model-endpoint"],
  "instanceType": "gpu-enabled",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/ProdSageMakerRole"
}
```

### LLM Deployment

```json
{
  "projectName": "llm-chat-service",
  "framework": "transformers",
  "modelServer": "vllm",
  "includeSampleModel": false,
  "includeTesting": true,
  "instanceType": "gpu-enabled",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/LLMSageMakerRole"
}
```

## Anti-Patterns (What NOT to Do)

### ❌ Mixing Incompatible Options

```bash
# DON'T: sklearn with vLLM server
yo ml-container-creator --framework=sklearn --model-server=vllm --skip-prompts

# DON'T: transformers with model format
yo ml-container-creator --framework=transformers --model-format=pkl --skip-prompts

# DON'T: transformers with sample model
yo ml-container-creator --framework=transformers --include-sample --skip-prompts
```

### ❌ Using Unsupported Environment Variables

```bash
# DON'T: Core parameters via environment variables
export ML_FRAMEWORK=sklearn        # Not supported
export ML_MODEL_SERVER=flask       # Not supported
export ML_MODEL_FORMAT=pkl         # Not supported

# DO: Use CLI options or config files for core parameters
yo ml-container-creator --framework=sklearn --model-server=flask --skip-prompts
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
yo ml-container-creator --region=us-west-2 --skip-prompts
# Confusing: CLI option wins, but not obvious
```

## Validation and Error Handling

The generator validates all configuration and provides clear error messages:

### Framework Validation

```bash
yo ml-container-creator --framework=invalid --skip-prompts
# Error: ⚠️ invalid not implemented yet.
```

### Format Validation

```bash
yo ml-container-creator --framework=sklearn --model-format=json --skip-prompts
# Error: Invalid model format 'json' for framework 'sklearn'
```

### ARN Validation

```bash
yo ml-container-creator --role-arn=invalid-arn --skip-prompts
# Error: Invalid AWS Role ARN format
```

### Required Parameter Validation

```bash
yo ml-container-creator --skip-prompts
# Error: Missing required parameter: framework
```

## Best Practices

### 1. Use Configuration Files for Repeatable Setups

```bash
# Create once, use many times
yo ml-container-creator configure
yo ml-container-creator --skip-prompts  # Uses ml-container.config.json
```

### 2. Use Environment Variables for Deployment Environments

```bash
# Different environments
export AWS_REGION=us-east-1     # Development
export AWS_REGION=us-west-2     # Production
```

### 3. Use CLI Options for One-Off Changes

```bash
# Quick test with different server
yo ml-container-creator --model-server=fastapi --skip-prompts
```

### 4. Combine Methods Strategically

```bash
# Base config in file, environment-specific overrides
export AWS_REGION=us-west-2
yo ml-container-creator --config=base-config.json --skip-prompts
```

### 5. Validate Configuration Before Deployment

```bash
# Test configuration without skipping prompts first
yo ml-container-creator --config=production.json
# Review all settings, then use --skip-prompts for automation
```

## Troubleshooting Configuration

### Debug Configuration Loading

The generator shows which configuration sources are being used:

```bash
yo ml-container-creator --framework=sklearn --skip-prompts

# Output shows:
# ⚙️ Configuration will be collected from prompts and merged with:
#    • Framework: sklearn
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
yo ml-container-creator help

# Show interactive configuration
yo ml-container-creator configure

# Show environment variable examples
yo ml-container-creator configure  # Choose "Show environment variable examples"
```

This comprehensive configuration system ensures you can use ML Container Creator in any workflow, from interactive development to fully automated CI/CD pipelines.