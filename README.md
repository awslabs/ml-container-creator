#
<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
  <h1>ML Container Creator</h1>
  <p><em>Simplify your machine learning deployments on AWS SageMaker</em></p>
</div>

## Why ML Container Creator?

GitHub Pages site -- [ML Container Creator](https://awslabs.github.io/ml-container-creator/)

Deploying machine learning models to production shouldn't be complicated. ML Container Creator eliminates the complexity of creating SageMaker Bring Your Own Container (BYOC) deployments, letting you focus on what matters most - your models.

**Perfect for:**
- Data scientists who want to deploy models without DevOps overhead
- ML engineers building production model serving pipelines
- Teams standardizing their ML deployment process
- Organizations moving from prototype to production

## What is SageMaker BYOC?

Amazon SageMaker Bring Your Own Container (BYOC) lets you deploy custom machine learning models using your own Docker containers. This gives you full control over your model's runtime environment while leveraging SageMaker's managed infrastructure for hosting and scaling.

## 📋 What You Get with ml-container-creator

Every generated project includes:
- **SageMaker-compatible container** with health checks and invocation endpoints
- **do-framework scripts** for standardized container lifecycle management (`build`, `push`, `deploy`, `run`, `test`, `clean`)
- **Multiple deployment options** - Direct SageMaker deployment or AWS CodeBuild for CI/CD
- **Local testing suite** to validate before deployment
- **Sample model and training code** to illustrate the deployment
- **Centralized configuration** in `do/config` for easy customization
- **Multi-framework support** (sklearn, XGBoost, TensorFlow, vLLM, SGLang, TensorRT-LLM)
- **🆕 Intelligent configuration system** with community-validated settings
  - Framework Registry: Pre-configured settings for framework versions (vLLM, SGLang, TensorRT-LLM, LMI, DJL)
  - Model Registry: Model-specific optimizations and overrides
  - HuggingFace Hub integration: Automatic model metadata fetching
- **🆕 Accelerator compatibility validation** (CUDA, Neuron SDK, CPU, ROCm)
  - Automatic instance type validation against framework requirements
  - Version compatibility checking for accelerator drivers
  - Clear error messages with recommended alternatives
- **🆕 Configuration profiles** for different optimization strategies
  - Low-latency vs high-throughput profiles
  - Single-GPU vs multi-GPU configurations
  - Framework and model-specific optimizations
- **🆕 Environment variable validation** to catch configuration errors early
  - Known flags validation against framework specifications
  - Type and range constraint checking
  - Deprecated flag warnings with suggested replacements

> **Note**: This tool generates starter code. Review and customize for your production requirements.

## Prerequisites

Before you begin, ensure you have:
- **Node.js v24+** (required for development and testing)
  - Check version: `node --version`
  - Use nvm: `nvm use node` to switch to latest version
- An AWS account with SageMaker access
- Basic familiarity with Docker and command line
- A trained machine learning model ready for deployment

## 🚀 Deployment Options

ML Container Creator supports two deployment approaches to fit different workflows:

### 🏗️ **CodeBuild CI/CD Pipeline (Recommended)**
Enterprise-ready CI/CD with AWS CodeBuild:
- Automated Docker image building in AWS with correct architecture
- Shared ECR repository with project-specific tagging
- No local architecture compatibility issues
- Integrated with AWS infrastructure
- Perfect for production and team environments

```bash
# Generate project with CodeBuild deployment
yo ml-container-creator my-model --deploy-target=codebuild --skip-prompts

# Submit build job and deploy using do-framework
cd my-model
./do/submit  # Builds and pushes image via CodeBuild
./do/deploy your-sagemaker-role-arn  # Deploys to SageMaker
./do/test my-model-endpoint  # Test the endpoint
```

### 🎯 **Direct SageMaker Deployment**
Quick local builds for development:
- Build and push Docker image locally
- Deploy directly to SageMaker endpoint
- Ideal for prototyping and development environments
- ⚠️ **Note**: May encounter architecture compatibility issues (e.g., ARM64 Mac → x86_64 SageMaker)

```bash
# Generate project with SageMaker deployment
yo ml-container-creator my-model --deploy-target=sagemaker --skip-prompts

# Build, deploy, and test using do-framework
cd my-model
./do/build  # Build Docker image
./do/push   # Push to ECR
./do/deploy your-sagemaker-role-arn  # Deploy to SageMaker
./do/test my-model-endpoint  # Test the endpoint
```

### 🔄 **CodeBuild Features**
- **Shared ECR Repository**: All projects use `ml-container-creator` repository with project-specific tags
- **Automatic Infrastructure**: Creates CodeBuild projects, IAM roles, and S3 buckets automatically
- **Build Monitoring**: Real-time build status and progress tracking
- **Compute Options**: Small, Medium, or Large compute types for different project sizes
- **Comprehensive Logging**: CloudWatch integration for build logs and debugging

## 🛠️ do-framework Integration

All generated projects use the [do-framework](https://github.com/iankoulski/do-framework) for standardized container lifecycle management. This provides a consistent interface across all ML Container Creator projects.

### Available Commands

Every generated project includes these standardized scripts in the `do/` directory:

| Command | Description |
|---------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/deploy` | Deploy to SageMaker endpoint |
| `./do/run` | Run container locally for testing |
| `./do/test` | Test local container or SageMaker endpoint |
| `./do/clean` | Clean up resources (local, ECR, endpoint) |
| `./do/submit` | Submit build to CodeBuild (CodeBuild deployment only) |

### Quick Workflow Examples

**Local Development:**
```bash
./do/build          # Build image
./do/run &          # Run locally
./do/test           # Test local container
./do/push           # Push to ECR
./do/deploy $ROLE   # Deploy to SageMaker
```

**CodeBuild CI/CD:**
```bash
./do/submit         # Build and push via CodeBuild
./do/deploy $ROLE   # Deploy to SageMaker
./do/test my-endpoint  # Test the endpoint
```

### Configuration

All scripts use centralized configuration in `do/config`:

```bash
# Edit do/config to customize
export PROJECT_NAME="my-model"
export AWS_REGION="us-east-1"
export INSTANCE_TYPE="ml.m5.xlarge"
export DEPLOYMENT_CONFIG="sklearn-flask"
```

Override any setting with environment variables:
```bash
AWS_REGION=us-west-2 ./do/deploy
```

### Migration from Legacy Scripts

Legacy `deploy/` scripts are still available for backward compatibility but are deprecated:

| Legacy | do-framework | Status |
|--------|--------------|--------|
| `./deploy/build_and_push.sh` | `./do/build && ./do/push` | Deprecated |
| `./deploy/deploy.sh` | `./do/deploy` | Deprecated |
| `./deploy/submit_build.sh` | `./do/submit` | Deprecated |

See the generated `MIGRATION.md` file in your project for detailed migration instructions.

## 🎯 Intelligent Configuration System

ML Container Creator includes a powerful multi-registry configuration system that provides:

### Framework Registry
Pre-configured, tested settings for transformer serving frameworks:
- **Base images** and environment variables for each framework version
- **Accelerator requirements** (CUDA versions, Neuron SDK versions)
- **SageMaker AMI versions** matched to accelerator requirements
- **Recommended instance types** for optimal performance
- **Validation levels** indicating how well-tested each configuration is

### Model Registry
Model-specific optimizations and overrides:
- **Chat templates** for conversational models
- **Framework compatibility** information
- **Known issues** and workarounds
- **Pattern matching** for model families (e.g., `mistral*` matches all Mistral variants)

### HuggingFace Hub Integration
Automatic fetching of model metadata:
- **Tokenizer configurations** including chat templates
- **Model architectures** and requirements
- **Graceful fallback** when API is unavailable
- **Offline mode** for air-gapped environments

### Configuration Profiles
Choose optimization strategies for your use case:
- **Low-latency profiles**: Optimized for single-request response time
- **High-throughput profiles**: Optimized for batch processing
- **Single-GPU vs multi-GPU**: Different tensor parallelism settings
- **Framework-specific profiles**: vLLM, TensorRT-LLM, SGLang optimizations

### Accelerator Compatibility Validation
Automatic validation of hardware compatibility:
- **Type matching**: Ensures framework accelerator type (CUDA/Neuron/CPU/ROCm) matches instance
- **Version checking**: Validates accelerator driver versions
- **AMI compatibility**: Verifies SageMaker AMI provides required drivers
- **Clear recommendations**: Suggests compatible instance types when mismatches detected

### Environment Variable Validation
Catch configuration errors before deployment:
- **Known flags validation**: Checks against framework specifications
- **Type constraints**: Validates integer, float, string, boolean values
- **Range constraints**: Enforces min/max values
- **Deprecation warnings**: Alerts about deprecated flags with suggested replacements
- **Opt-in validation**: Enable with `--validate-env-vars` flag (enabled by default)

### Community Contributions
Share your tested configurations:
- **Export working configurations**: After successful deployment
- **Validation levels**: Experimental → Community-validated → Tested
- **Test reports**: Document successful deployments on specific instance types
- **Registry contributions**: Submit configurations via pull requests

### How It Works

```
User Input → Framework Registry Lookup → Profile Selection (optional)
                    ↓
         Model Registry Lookup (optional)
                    ↓
         HuggingFace API Fetch (optional)
                    ↓
         Configuration Merge (priority order)
                    ↓
         Accelerator Validation
                    ↓
         Environment Variable Validation
                    ↓
         Template Generation
```

**Configuration Priority Order:**
1. Base framework configuration (Framework Registry)
2. Framework profile (if selected)
3. HuggingFace API data (if available)
4. Model registry overrides (if available)
5. Model profile (if selected)

**Graceful Degradation:**
When registry data is unavailable, the generator falls back to current default behavior - ensuring backward compatibility and reliability.

## 🚀 Get Started in Minutes

```bash
# Install Yeoman and the generator
cd ml-container-creator
npm install -g yo
npm link

# Generate your project
yo ml-container-creator
```

Answer a few questions about your model, and get a complete container with:
- **do-framework scripts** for standardized container lifecycle management
- **Optimized model serving** (Flask, FastAPI, vLLM, SGLang, TensorRT-LLM)
- **Built-in testing and deployment scripts** with consistent interface
- **Support for SageMaker AI** managed endpoint hosting
- **Local testing capabilities** before cloud deployment

## ⚙️ Configuration Options

ML Container Creator supports multiple ways to configure your project, from interactive prompts to fully automated CLI usage. Choose the method that best fits your workflow.

### Configuration Methods (by precedence)

1. **CLI Options** (highest precedence)
2. **CLI Arguments** 
3. **Environment Variables**
4. **CLI Config File** (`--config=file.json`)
5. **Custom Config File** (`ml-container.config.json`)
6. **Package.json Section** (`"ml-container-creator": {...}`)
7. **Generator Defaults**
8. **Interactive Prompts** (lowest precedence)

### Quick Start Examples

#### Interactive Mode (Default)
```bash
yo ml-container-creator
# Follow the prompts to configure your project
```

#### CLI Mode (Skip Prompts)
```bash
# Basic sklearn project with SageMaker deployment
yo ml-container-creator my-sklearn-project \
  --deployment-config=sklearn-flask \
  --model-format=pkl \
  --deploy-target=sagemaker \
  --skip-prompts

# Transformers project with vLLM and CodeBuild CI/CD
yo ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --instance-type=gpu-enabled \
  --deploy-target=codebuild \
  --codebuild-compute-type=BUILD_GENERAL1_MEDIUM \
  --skip-prompts

# XGBoost with FastAPI and testing
yo ml-container-creator my-xgb-project \
  --deployment-config=xgboost-fastapi \
  --model-format=json \
  --include-testing \
  --deploy-target=sagemaker \
  --skip-prompts
```

#### Environment Variables
```bash
# Set configuration via environment (only supported parameters)
export ML_INSTANCE_TYPE="cpu-optimized"
export AWS_REGION="us-east-1"
export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"

# Generate with environment config + CLI options for core parameters
yo ml-container-creator --deployment-config=sklearn-flask --model-format=pkl --skip-prompts
```

#### Configuration File
```bash
# Create configuration file
yo ml-container-creator configure

# Or generate empty config
yo ml-container-creator generate-empty-config

# Use configuration file
yo ml-container-creator --config=production.json --skip-prompts
```

### CLI Options Reference

| Option | Description | Values |
|--------|-------------|---------|
| `--skip-prompts` | Skip interactive prompts | `true/false` |
| `--config=<file>` | Load configuration from file | File path |
| `--project-name=<name>` | Project name | String |
| `--deployment-config=<config>` | Deployment configuration (framework-server) | `sklearn-flask`, `sklearn-fastapi`, `xgboost-flask`, `xgboost-fastapi`, `tensorflow-flask`, `tensorflow-fastapi`, `transformers-vllm`, `transformers-sglang`, `transformers-tensorrt-llm`, `transformers-lmi`, `transformers-djl` |
| `--framework=<framework>` | ML framework (deprecated, use --deployment-config) | `sklearn`, `xgboost`, `tensorflow`, `transformers` |
| `--model-server=<server>` | Model server (deprecated, use --deployment-config) | `flask`, `fastapi`, `vllm`, `sglang`, `tensorrt-llm` |
| `--model-format=<format>` | Model format | Depends on framework |
| `--include-sample` | Include sample model code | `true/false` |
| `--include-testing` | Include test suite | `true/false` |
| `--test-types=<types>` | Test types (comma-separated) | `local-model-cli`, `local-model-server`, `hosted-model-endpoint` |
| `--deploy-target=<target>` | Deployment target | `sagemaker`, `codebuild` |
| `--codebuild-compute-type=<type>` | CodeBuild compute type | `BUILD_GENERAL1_SMALL`, `BUILD_GENERAL1_MEDIUM`, `BUILD_GENERAL1_LARGE` |
| `--instance-type=<type>` | Instance type | `cpu-optimized`, `gpu-enabled` |
| `--region=<region>` | AWS region | `us-east-1`, etc. |
| `--role-arn=<arn>` | AWS IAM role ARN | `arn:aws:iam::123456789012:role/SageMakerRole` |
| `--project-dir=<dir>` | Output directory path | `./my-project` |
| `--hf-token=<token>` | HuggingFace authentication token | `hf_abc123...` or `$HF_TOKEN` |
| `--validate-env-vars` | Enable environment variable validation | `true/false` (default: `true`) |
| `--validate-with-docker` | Enable Docker introspection validation | `true/false` (default: `false`) |
| `--offline` | Skip HuggingFace API lookups | `true/false` (default: `false`) |

### Environment Variables Reference

**Note:** According to the parameter matrix specification, only the following environment variables are supported. Core parameters (framework, model-server, etc.) must be configured via CLI options or configuration files.

| Variable | Description | Example |
|----------|-------------|---------|
| `ML_INSTANCE_TYPE` | Instance type | `cpu-optimized` |
| `AWS_REGION` | AWS region | `us-east-1` |
| `AWS_ROLE` | AWS IAM role ARN | `arn:aws:iam::123456789012:role/SageMakerRole` |
| `ML_CONTAINER_CREATOR_CONFIG` | Config file path | `./my-config.json` |

### Configuration File Examples

#### Custom Config File (`ml-container.config.json`)
```json
{
  "projectName": "my-ml-project",
  "deploymentConfig": "sklearn-flask",
  "modelFormat": "pkl",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "hosted-model-endpoint"],
  "deployTarget": "sagemaker",
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1"
}
```

#### Package.json Section
```json
{
  "name": "my-project",
  "ml-container-creator": {
    "projectName": "my-ml-project",
    "deploymentConfig": "transformers-vllm",
    "instanceType": "gpu-enabled",
    "includeTesting": true
  }
}
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `yo ml-container-creator` | Interactive generation |
| `yo ml-container-creator configure` | Interactive configuration setup |
| `yo ml-container-creator generate-empty-config` | Generate empty config file |
| `yo ml-container-creator help` | Show help information |

### Framework-Specific Options

#### Traditional ML (sklearn, xgboost, tensorflow)
- **Deployment Configurations**: `sklearn-flask`, `sklearn-fastapi`, `xgboost-flask`, `xgboost-fastapi`, `tensorflow-flask`, `tensorflow-fastapi`
- **Model Formats**: Varies by framework
- **Sample Model**: Available (Abalone classifier)
- **Instance Types**: `cpu-optimized`, `gpu-enabled`

#### Transformers (LLMs)
- **Deployment Configurations**: `transformers-vllm`, `transformers-sglang`, `transformers-tensorrt-llm`, `transformers-lmi`, `transformers-djl`
- **Model Formats**: Not applicable (loaded from Hugging Face Hub)
- **Sample Model**: Not available
- **Instance Types**: `gpu-enabled` (defaults to `ml.g6.12xlarge`)
- **Note**: TensorRT-LLM requires [NVIDIA NGC authentication](#tensorrt-llm-authentication) to pull the base image

### Example: Deploy a scikit-learn Model

1. **Prepare your model**: Save as `model.pkl`
2. **Generate container**: Run `yo ml-container-creator` and select `sklearn-flask` deployment configuration
3. **Build and test locally**:
   ```bash
   cd my-sklearn-project
   ./do/build
   ./do/run &
   ./do/test
   ```
4. **Deploy to SageMaker**:
   ```bash
   ./do/push
   ./do/deploy your-sagemaker-role-arn
   ./do/test my-sklearn-project-endpoint
   ```

Or use CodeBuild for CI/CD:
```bash
./do/submit  # Build and push via CodeBuild
./do/deploy your-sagemaker-role-arn
```

## 🔐 HuggingFace Authentication

### When is Authentication Needed?

HuggingFace authentication is required for:
- **Private models**: Models in private repositories
- **Gated models**: Models requiring user agreement (e.g., Llama 2, Llama 3)
- **Rate-limited access**: Avoiding rate limits on public models

Public models like `openai/gpt-oss-20b` do not require authentication.

### Providing Your HF_TOKEN

When you manually enter a transformer model ID (not selecting from examples), you'll be prompted for authentication:

#### Option 1: Interactive Prompt (Recommended for Local Development)

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
yo ml-container-creator my-llm-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-hf \
  --hf-token=hf_abc123... \
  --skip-prompts

# Environment variable reference
yo ml-container-creator my-llm-project \
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

⚠️ **Important Security Considerations:**

1. **Tokens are baked into the image**: Anyone with access to your Docker image can extract the token using `docker inspect`.

2. **Use environment variable references for CI/CD**:
   ```bash
   export HF_TOKEN=hf_your_token_here
   yo ml-container-creator --framework=transformers --hf-token='$HF_TOKEN' --skip-prompts
   ```

3. **Never commit tokens to version control**: Use `$HF_TOKEN` in config files, not actual tokens.

4. **Rotate tokens regularly**: Generate new tokens periodically from your HuggingFace account.

### TensorRT-LLM Authentication

TensorRT-LLM uses NVIDIA's NGC (NVIDIA GPU Cloud) registry, which requires authentication:

**Before building a TensorRT-LLM container:**

1. **Create an NGC account**: Visit [https://ngc.nvidia.com/signup](https://ngc.nvidia.com/signup)

2. **Generate an API key**:
   - Go to [https://ngc.nvidia.com/setup/api-key](https://ngc.nvidia.com/setup/api-key)
   - Click "Generate API Key"
   - Save your API key securely

3. **Set NGC_API_KEY environment variable**:
   ```bash
   export NGC_API_KEY='your-api-key-here'
   ```

4. **Build and deploy**:

   **For SageMaker deployment (local build):**
   ```bash
   cd my-tensorrt-project
   ./do/build  # Automatically authenticates with NGC using NGC_API_KEY
   ./do/push
   ./do/deploy your-sagemaker-role-arn
   ```

   **For CodeBuild deployment (CI/CD):**
   ```bash
   cd my-tensorrt-project
   ./do/submit  # Passes NGC_API_KEY to CodeBuild
   ./do/deploy your-sagemaker-role-arn
   ```

**How it works:**
- The do-framework scripts automatically authenticate with NGC using your `NGC_API_KEY` environment variable
- For local builds (`./do/build`), Docker login happens on your machine
- For CodeBuild (`./do/submit`), the NGC_API_KEY is passed as a CodeBuild environment variable
- No manual `docker login` required!

**Security Note for CodeBuild:**
- NGC_API_KEY is passed as a plaintext environment variable to CodeBuild
- For production, consider using AWS Secrets Manager:
  ```bash
  # Store in Secrets Manager
  aws secretsmanager create-secret --name ngc-api-key --secret-string "$NGC_API_KEY"
  
  # Update buildspec to retrieve from Secrets Manager
  # See AWS CodeBuild documentation for details
  ```

**Note**: NGC authentication is only required for TensorRT-LLM. vLLM and SGLang use publicly available images.

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

For more authentication troubleshooting, see the [Troubleshooting Guide](./TROUBLESHOOTING.md#huggingface-authentication-issues).

## 🛠️ Requirements

### For Users
- Node.js 24+
- Python 3.8+
- Docker 20+
- AWS CLI 2+

### For Contributors
- Node.js 24+ and npm
- All other tools managed via npm scripts

## 🌟 Open Source & Community Driven

ML Container Creator is **open source** under the Apache 2.0 license.

### 🗺️ Live Roadmap

Our development is driven by user needs. Check out our [live roadmap](https://github.com/ml-container-creator/projects) to:
- See what's coming next
- Vote on features you need
- Contribute ideas and feedback
- Track progress on requested features

**Current priorities:**
- Enhanced transformer model support
- Multi-model endpoints
- Auto-scaling configurations
- Cost optimization features

## 🧪 Testing

ML Container Creator has a comprehensive test suite ensuring reliability and correctness across all supported configurations.

### Test Architecture

Our testing approach combines multiple testing strategies for comprehensive coverage:

#### 📋 **Unit Tests** (87 tests)
Focused tests for specific functionality organized by capability:

- **CLI Options** - Command-line option parsing and validation
- **Environment Variables** - Environment variable handling and precedence
- **Configuration Files** - JSON config files and package.json sections
- **Configuration Precedence** - Multi-source configuration merging
- **File Generation** - Template processing and conditional file creation
- **Error Handling** - Validation errors and edge cases

#### 🔬 **Property-Based Tests** (10 universal properties)
Automated testing of universal correctness properties using [fast-check](https://github.com/dubzzz/fast-check):

- **Parameter Source Enforcement** - Unsupported sources are ignored
- **Environment Variable Mapping** - Correct variable-to-parameter mapping
- **CLI Option Consistency** - CLI options accepted and mapped correctly
- **Package.json Filtering** - Only supported parameters loaded from package.json
- **Default Value Application** - Correct defaults applied when values missing
- **Configuration Isolation** - .yo-rc.json files completely ignored
- **Non-Promptable Handling** - Non-interactive parameters handled correctly
- **Required Parameter Validation** - Missing required parameters produce errors
- **Config File Resolution** - Environment variable config paths work correctly
- **Parameter Precedence** - Highest precedence source values used

#### 🔒 **Security Testing**
- **Dependency Scanning** - npm audit for known vulnerabilities
- **Code Quality** - ESLint for security best practices
- **Input Validation** - Malformed configuration handling

### Running Tests

```bash
# Complete validation (recommended before PR)
npm run validate                # ESLint + Security + All Tests

# Individual test categories
npm test                        # Unit tests only
npm run test:property          # Property-based tests only
npm run test:all               # Unit + Property tests
npm run test:coverage          # Tests with coverage report

# Development workflows
npm run test:watch             # Unit tests in watch mode
npm run test:property:watch    # Property tests in watch mode

# Specific test targeting
npm test -- --grep "CLI Options"     # CLI-related tests
npm test -- --grep "sklearn"         # Framework-specific tests
npm test -- --grep "precedence"      # Configuration precedence tests
```

### Test Features

#### 🎯 **Comprehensive Coverage**
- **1000+ test iterations** across all parameter combinations
- **All configuration sources** tested (CLI, env vars, config files, package.json)
- **All frameworks** tested (sklearn, xgboost, tensorflow, transformers)
- **All precedence scenarios** validated

#### 📊 **Detailed Reporting**
```
🧪 Test #1: should parse sklearn CLI options correctly
📍 Test Suite: CLI Options Parsing
🔍 Checking 6 expected files for sklearn CLI parsing...
✅ Found: Dockerfile
✅ Found: requirements.txt
📊 Summary: All 6 expected files found
```

#### 🔍 **Debug Information**
When tests fail, detailed context is provided:
```
🔍 DEBUG: Current state for test #5 failure:
📁 Working directory: /tmp/test-dir
📄 Files in current directory (3 total): [Dockerfile, requirements.txt, ...]
```

#### ⚡ **Performance Optimized**
- **Smart test generation** - Only valid parameter combinations tested
- **Configurable timeouts** - Prevent hanging tests
- **Efficient validation** - Early returns for known invalid states
- **Minimal logging** during property execution

### Test Results

Current test status:
- ✅ **87 unit tests passing** - All functionality validated
- ✅ **10 property tests passing** - Universal correctness verified
- ✅ **100% success rate** - Zero failing tests
- ✅ **~6 second execution** - Fast feedback cycle
- ✅ **1000+ iterations** - Comprehensive coverage

### For Contributors

When adding new features, include appropriate tests:

1. **Choose the right test module** based on functionality
2. **Follow existing patterns** for consistency
3. **Test both success and failure cases**
4. **Add property tests** for universal behavior
5. **Run `npm run validate`** before submitting PR

See [CONTRIBUTING.md](./CONTRIBUTING.md#testing-requirements) for detailed testing guidelines.

### Test Philosophy

Our testing approach ensures reliability through multiple complementary strategies:

#### 🎯 **Focused Unit Tests**
Each test module focuses on a specific capability (CLI options, environment variables, configuration files, etc.), making it easy to understand what's being tested and debug failures.

#### 🔬 **Property-Based Testing**
Using [fast-check](https://github.com/dubzzz/fast-check), we test universal correctness properties across thousands of parameter combinations, ensuring the system behaves correctly for all valid inputs.

#### 🔒 **Security & Quality**
Automated security auditing and code quality checks ensure the generated containers and deployment scripts follow best practices.

#### 📊 **Comprehensive Coverage**
- **87 unit tests** covering specific functionality
- **10 property tests** validating universal behavior
- **1000+ test iterations** across all parameter combinations
- **Multi-Node.js version testing** ensuring compatibility

#### ⚡ **Fast Feedback**
Tests complete in ~6 seconds, providing rapid feedback during development while maintaining comprehensive coverage.

## 🤝 Contributing

We welcome contributions of all sizes! Whether you're:
- Reporting bugs or requesting features
- Improving documentation
- Adding support for new frameworks
- Optimizing performance

Your input shapes the future of this tool.

### Development Setup

Quick contribution setup:

```bash
# Clone and setup
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator

# Ensure you're using Node.js 24+
nvm use node  # or: nvm install 24

# Install dependencies and link for local development
npm install
npm link

# Run tests
npm test

# Run linting
npm run lint

# Make your changes and submit a PR!
```

### Continuous Integration

All pull requests are automatically tested with our comprehensive CI pipeline:

#### 🔄 **Automated Testing**
- **Multi-Node Testing**: Tests run on Node.js 24.x and 22.x
- **Complete Test Suite**: Unit tests + property-based tests + security audit
- **Code Quality**: ESLint checks for code standards
- **Security Scanning**: npm audit for known vulnerabilities
- **Coverage Reporting**: Test coverage analysis and reporting

#### 📋 **CI Pipeline Stages**

1. **Test Suite** - Runs on multiple Node.js versions
   - ESLint code quality checks
   - Security audit (npm audit)
   - Unit tests (87 tests)
   - Property-based tests (10 universal properties)
   - Test coverage generation

2. **Full Validation** - Complete end-to-end testing
   - Full validation suite (`npm run validate`)
   - Generator installation testing
   - CLI functionality verification
   - File generation validation

3. **Security Scan** - Security vulnerability assessment
   - Dependency vulnerability scanning
   - High/critical vulnerability blocking
   - Security best practices validation

#### ✅ **PR Requirements**

Before your PR can be merged, it must:
- ✅ Pass all tests on supported Node.js versions
- ✅ Pass ESLint code quality checks
- ✅ Pass security audit (no high/critical vulnerabilities)
- ✅ Maintain or improve test coverage
- ✅ Successfully generate containers with CLI options

#### 🚀 **Local Validation**

Run the same checks locally before submitting:

```bash
# Run the complete validation suite (same as CI)
npm run validate

# Test generator functionality
npm link
yo ml-container-creator test-project --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts
```

### Running Tests

The project has a comprehensive test suite with multiple types of tests:

```bash
# Run all tests (unit + property-based + security audit)
npm run validate

# Run unit tests only
npm test

# Run property-based tests only
npm run test:property

# Run all tests without security audit
npm run test:all

# Development workflows
npm run test:watch          # Watch mode for unit tests
npm run test:property:watch # Watch mode for property tests
npm run test:coverage       # Run with coverage report
```

#### Test Organization

Our test suite is organized into focused modules:

**📋 Unit Tests** (`test/input-parsing-and-generation/`)
- **CLI Options**: `cli-options.test.js` - CLI option parsing and validation
- **Environment Variables**: `environment-variables.test.js` - Environment variable handling
- **Configuration Files**: `configuration-files.test.js` - Config file parsing (JSON, package.json)
- **Configuration Precedence**: `configuration-precedence.test.js` - Multi-source precedence testing
- **File Generation**: `file-generation.test.js` - Template processing and file creation
- **Error Handling**: `error-handling.test.js` - Validation and error scenarios

**🔬 Property-Based Tests** (`test/input-parsing-and-generation/parameter-matrix-compliance.property.test.js`)
- **Parameter Matrix Compliance**: 10 universal correctness properties
- **Comprehensive Coverage**: 1000+ test iterations across all parameter combinations
- **Automated Validation**: Tests all configuration sources and precedence rules

#### Test Features

- **87 passing tests** with comprehensive coverage
- **Property-based testing** using fast-check for universal correctness validation
- **Detailed progress reporting** with numbered tests and clear output
- **Debug information** when tests fail
- **Modular structure** for easy maintenance and contribution

#### Running Specific Tests

```bash
# Run specific test categories
npm test -- --grep "CLI Options"        # CLI option tests
npm test -- --grep "Environment"        # Environment variable tests
npm test -- --grep "precedence"         # Configuration precedence tests
npm test -- --grep "sklearn"            # Framework-specific tests

# Run property tests for specific properties
npm run test:property -- --grep "Property 1"  # Parameter source enforcement
npm run test:property -- --grep "Property 10" # Parameter precedence order
```

## Security

See [CONTRIBUTING](./CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.

## 📚 Documentation

**📖 [Full Documentation Site](https://awslabs.github.io/ml-container-creator/)** - Complete guides, examples, and API reference

### Quick Links
- 📖 **[Getting Started](./docs/getting-started.md)** - Installation and first project tutorial
- 📖 **[Examples Guide](./docs/EXAMPLES.md)** - Step-by-step examples for common use cases including CodeBuild CI/CD
- 🔧 **[Troubleshooting Guide](./docs/TROUBLESHOOTING.md)** - Solutions to common issues
- 🎯 **[Template System](./docs/template-system.md)** - How the template system works
- 🏗️ **[Architecture](./docs/architecture.md)** - Complete architecture guide

### Release Documentation
- 📋 **[v1.0.0 Release Notes](./.kiro/v1.0.0-Release/RELEASE_NOTES.md)** - Complete feature descriptions and testing commands
- 📊 **[v1.0.0 Release Summary](./.kiro/v1.0.0-Release/RELEASE_SUMMARY.md)** - High-level overview and statistics
- ⚡ **[Quick Test Guide](./.kiro/v1.0.0-Release/REVIEWER_QUICK_TEST.md)** - Fast validation for reviewers

### For Contributors
- 🚀 **[Contributing Guide](./docs/CONTRIBUTING.md)** - Get started contributing in 5 minutes
- 🛠️ **[Adding Features](./docs/ADDING_FEATURES.md)** - Guide for adding new frameworks
- 📝 **[Coding Standards](./docs/coding-standards.md)** - Code style and conventions
- ☁️ **[AWS/SageMaker Guide](./docs/aws-sagemaker.md)** - Domain knowledge and best practices

### Examples
- [Deploy a scikit-learn Model](./docs/EXAMPLES.md#example-1-deploy-a-scikit-learn-model)
- [Deploy an XGBoost Model](./docs/EXAMPLES.md#example-2-deploy-an-xgboost-model)
- [Deploy a TensorFlow Model](./docs/EXAMPLES.md#example-3-deploy-a-tensorflow-model)
- [Deploy a Transformer Model (LLM)](./docs/EXAMPLES.md#example-4-deploy-a-transformer-model-llm)

## 🆘 Support & Troubleshooting

### Get Help
- 📖 [Examples Guide](./docs/EXAMPLES.md) - Detailed walkthroughs
- 🔧 [Troubleshooting Guide](./TROUBLESHOOTING.md) - Common issues and solutions
- 🔧 [Advanced Troubleshooting](./docs/TROUBLESHOOTING.md) - Development and CI issues
- 🐛 [Report Issues](https://github.com/awslabs/ml-container-creator/issues)
- 💬 [Community Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- 🗺️ [Roadmap & Feature Requests](https://github.com/awslabs/ml-container-creator/projects)
- 📖 [SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)

### Quick Troubleshooting

**Container fails to start**
```bash
# Check logs
docker logs your-container-name

# See detailed solutions in troubleshooting guide
```

**SageMaker deployment fails**
```bash
# Check CloudWatch logs
aws logs tail /aws/sagemaker/Endpoints/your-endpoint --follow

# See detailed solutions in troubleshooting guide
```

**Need more help?** Check the [troubleshooting guide](./TROUBLESHOOTING.md) for common issues and solutions.

<div align="center">
  <p>Made with ❤️ by the ML community, for the ML community</p>
</div>
