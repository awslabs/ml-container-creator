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
- **Multiple deployment options** - Direct SageMaker deployment or AWS CodeBuild for CI/CD
- **Local testing suite** to validate before deployment
- **Sample model and training code** to illustrate the deployment
- **AWS deployment scripts** for ECR and SageMaker
- **Multi-framework support** (sklearn, XGBoost, TensorFlow, vLLM, SGLang)

> **Note**: This tool generates starter code. Review and customize for your production requirements.

## Prerequisites

Before you begin, ensure you have:
- An AWS account with SageMaker access
- Basic familiarity with Docker and command line
- A trained machine learning model ready for deployment

## 🚀 Deployment Options

ML Container Creator supports two deployment approaches to fit different workflows:

### 🎯 **Direct SageMaker Deployment**
Perfect for development and quick deployments:
- Build and push Docker image locally
- Deploy directly to SageMaker endpoint
- Ideal for prototyping and development environments

```bash
# Generate project with SageMaker deployment
yo ml-container-creator my-model --deploy-target=sagemaker --skip-prompts

# Deploy to SageMaker
cd my-model
./deploy/deploy.sh your-sagemaker-role-arn
```

### 🏗️ **CodeBuild CI/CD Pipeline**
Enterprise-ready CI/CD with AWS CodeBuild:
- Automated Docker image building in AWS
- Shared ECR repository with project-specific tagging
- Integrated with AWS infrastructure
- Perfect for production and team environments

```bash
# Generate project with CodeBuild deployment
yo ml-container-creator my-model --deploy-target=codebuild --skip-prompts

# Submit build job and deploy
cd my-model
./deploy/submit_build.sh  # Builds image in CodeBuild
./deploy/deploy.sh your-sagemaker-role-arn  # Deploys to SageMaker
```

### 🔄 **CodeBuild Features**
- **Shared ECR Repository**: All projects use `ml-container-creator` repository with project-specific tags
- **Automatic Infrastructure**: Creates CodeBuild projects, IAM roles, and S3 buckets automatically
- **Build Monitoring**: Real-time build status and progress tracking
- **Compute Options**: Small, Medium, or Large compute types for different project sizes
- **Comprehensive Logging**: CloudWatch integration for build logs and debugging

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
- Optimized model serving (Flask or FastAPI)
- Built-in testing and deployment scripts
- Support for SageMaker AI managed endpoint hosting

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
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --deploy-target=sagemaker \
  --skip-prompts

# Transformers project with vLLM and CodeBuild CI/CD
yo ml-container-creator my-llm-project \
  --framework=transformers \
  --model-server=vllm \
  --instance-type=gpu-enabled \
  --deploy-target=codebuild \
  --codebuild-compute-type=BUILD_GENERAL1_MEDIUM \
  --skip-prompts

# XGBoost with FastAPI and testing
yo ml-container-creator my-xgb-project \
  --framework=xgboost \
  --model-server=fastapi \
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
yo ml-container-creator --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts
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
| `--framework=<framework>` | ML framework | `sklearn`, `xgboost`, `tensorflow`, `transformers` |
| `--model-server=<server>` | Model server | `flask`, `fastapi`, `vllm`, `sglang` |
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
  "framework": "sklearn",
  "modelServer": "flask",
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
    "framework": "transformers",
    "modelServer": "vllm",
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
- **Model Servers**: `flask`, `fastapi`
- **Model Formats**: Varies by framework
- **Sample Model**: Available (Abalone classifier)
- **Instance Types**: `cpu-optimized`, `gpu-enabled`

#### Transformers (LLMs)
- **Model Servers**: `vllm`, `sglang`
- **Model Formats**: Not applicable (loaded from Hugging Face Hub)
- **Sample Model**: Not available
- **Instance Types**: `gpu-enabled` (defaults to `ml.g6.12xlarge`)

### Example: Deploy a scikit-learn Model

1. **Prepare your model**: Save as `model.pkl`
2. **Generate container**: Run `yo` and choose `ml-container-creator`
3. **Configure**: Choose sklearn → pkl → flask → deployment target (SageMaker or CodeBuild)
4. **Deploy**: 
   - **SageMaker**: Run `./deploy/deploy.sh your-sagemaker-role-arn`
   - **CodeBuild**: Run `./deploy/submit_build.sh` then `./deploy/deploy.sh your-sagemaker-role-arn`

## 🛠️ Requirements

### For Users
- Node.js 24+
- Python 3.8+
- Docker 20+
- AWS CLI 2+

### For Contributors
- [mise](https://mise.jdx.dev/) - Development environment manager
- All tools are automatically managed via `mise.toml`

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

This project uses [mise](https://mise.jdx.dev/) for development environment management:

```bash
# Quick contribution setup
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator

# Install mise (if not already installed)
curl https://mise.run | sh

# Install project dependencies and tools
mise install
mise run install

# Available development tasks
mise run test     # Run unit tests
mise run lint     # Run linting

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

#### Alternative Setup (Manual)

If you prefer not to use mise:

```bash
# Clone and setup
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator

# Ensure Node.js 24.11.1+ is installed
node --version

# Install dependencies
npm install
npm link

# Run development tasks
npm run validate          # Complete validation (ESLint + Security + All Tests)
npm test                  # Unit tests only
npm run test:property     # Property-based tests only
npm run test:watch        # Unit tests in watch mode
npm run lint              # ESLint code quality checks
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
