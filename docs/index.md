# ML Container Creator

<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
  <p><em>Simplify your machine learning deployments on AWS SageMaker</em></p>
</div>

ML Container Creator (MCC) is a [Yeoman](https://yeoman.io/) generator designed to simplify the bring-your-own-container (BYOC) deployment approach for model serving on [Amazon SageMaker AI](https://aws.amazon.com/sagemaker/ai/). MCC takes user requirements for ML serving containers and injects those values into templated code and configuration files. These files define the serving infrastructure for containerized model serving workloads.

!!! note "Important"
    This tool generates starter code and reference implementations. Before deploying to production, review and customize the generated code for your specific security, performance, operational, and cost requirements.

!!! note "AWS as a First-Class Deployment Platform"
    This tool treats Amazon Web Services as the platform of choice for deploying models for cloud-hosting. The container files can be extended and modified to run on your platform of choice, but the repository maintainers prioritize and test deployment on [Amazon SageMaker AI real-time managed inference endpoints](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints.html).

!!! note "Docker as a First-Class Container Builder"
    The authors of this codebase recognize there are many container-builders to select from when building containerized workloads. At present, [Docker](https://www.docker.com/) is the container-builder of choice. Using different container-builders, while possible, may result in varying levels of performance.

!!! note "AI Documentation"
    This documentation was built with [Kiro](https://kiro.dev/). It is being reviewed for accuracy and completeness by human-reviewers as part of an initiative to accelerate documentation creation.

## Why ML Container Creator?

Deploying machine learning models to production shouldn't be complicated. MCC eliminates the complexity of creating BYOC model deployments, letting you focus on what matters most - your models.

Every generated project includes:

- ✅ **Amazon SageMaker AI-compatible container** with health checks and invocation endpoints
- ✅ **Local testing files** to validate before deployment
- ✅ **Sample model and training code** to illustrate the deployment
- ✅ **Integration with HuggingFace** for transformer-based deployments
- ✅ **Deployment scripts** for [AWS CodeBuild](https://aws.amazon.com/codebuild/) and Amazon SageMaker AI
- ✅ **Predictive ML multi-framework support** (sklearn, XGBoost and TensorFlow)
- ✅ **Transformers multi-framework support** (vLLM, SGLang, DJL, LMI and TensorRT)

## Quick Start

```bash
# Install Yeoman
npm install -g yo

# Install the generator
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator

# Install Dependencies and Link Generator
npm install
npm link

# Generate your project
yo @aws/ml-container-creator
```

The Yeoman generator prompts users for details about the deployment they are building. Answer a few questions about your model, the configuration, and the serving architecture, and get a complete project directory containging model serving, mdoel testing, deployment, and endpoint testing scripts. 

Check out [Getting Started](getting-started.md) to learn more about installing, prerequisites, and how to deploy your first model with MCC. Review the User Guide for more detailed walkthroughs and examples of how to use MCC. Study the Developer Guide if you plan to contribute to this project. 

<!-- ## Supported Frameworks

### Traditional ML
- **scikit-learn** - pkl, joblib formats
- **XGBoost** - json, model, ubj formats
- **TensorFlow** - keras, h5, SavedModel formats

### Large Language Models
- **Transformers** - vLLM or SGLang serving

## Model Servers

### Traditional ML
- **Flask** - Lightweight Python web framework
- **FastAPI** - Modern, fast API framework

### Large Language Models
- **vLLM** - High-performance LLM serving
- **SGLang** - Efficient transformer serving -->

<!-- ## Features

### 🚀 SageMaker-Compatible

- SageMaker-compatible endpoints (/ping, /invocations)
- Nginx reverse proxy for traditional ML
- Health checks and error handling
- Logging and monitoring setup

### 🧪 Testing Options

- **Local CLI testing** - Test model handler directly
- **Local server testing** - Test full container locally
- **Hosted endpoint testing** - Test deployed SageMaker endpoint

### ☁️ AWS Integration

- **Multiple deployment targets** - SageMaker direct or CodeBuild CI/CD
- **CodeBuild CI/CD pipeline** - Automated Docker building with shared ECR repository
- **ECR image building** and pushing scripts
- **SageMaker endpoint deployment** scripts
- **S3 model artifact support** (for transformers)
- **IAM role configuration** guidance and automatic provisioning
- **Infrastructure automation** - CodeBuild projects, IAM roles, S3 buckets

### 🎯 Instance Types

Supports **CPU-optimized**, **GPU-enabled**, and **custom** instance types. Choose from predefined options (ml.m6g.large for CPU, ml.g5.xlarge/ml.g6.12xlarge for GPU) or specify any AWS SageMaker instance type for cost optimization and performance tuning. Transformer models default to **ml.g6.12xlarge** for optimal LLM performance. -->

<!-- ## Requirements

### For Users
- Node.js 24+
- Python 3.8+
- Docker 20+
- AWS CLI 2+

See the [Contributing Guide](CONTRIBUTING.md) to get started in 5 minutes. -->

<!-- Alternatively, read through the Developer Guide for detailed guidance on contributing new features. -->

## Community & Support

- 📖 [Examples Guide](EXAMPLES.md) - Detailed walkthroughs
- 🔧 [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues and solutions
- 🐛 [Report Issues](https://github.com/awslabs/ml-container-creator/issues)
- 💬 [Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- 🗺️ [Roadmap](https://github.com/awslabs/ml-container-creator/projects)

<!-- 
## Documentation

### User Guides
- **[Getting Started](getting-started.md)** - Installation and first project
- **[Configuration Guide](configuration.md)** - Complete configuration system guide
- **[Examples](EXAMPLES.md)** - Step-by-step walkthroughs for all frameworks
- **[Troubleshooting](TROUBLESHOOTING.md)** - Solutions to common issues

### Developer Guides
- **[Contributing](CONTRIBUTING.md)** - Get started contributing in 5 minutes
- **[Testing Guide](testing.md)** - Comprehensive testing philosophy and practices
- **[Adding Features](ADDING_FEATURES.md)** - Contribute new frameworks or features
- **[Template System](template-system.md)** - How templates work
- **[Project Architecture](architecture.md)** - Complete architecture guide
- **[Coding Standards](coding-standards.md)** - Code style guide
- **[AWS/SageMaker Guide](aws-sagemaker.md)** - Domain knowledge -->

## Production Considerations

!!! warning "Before Production Deployment"
    The generated code provides a starting point for SageMaker deployments. Before using in production:
    
    - **Security Review** - Review IAM roles, network configurations, and data handling
    - **Testing** - Thoroughly test with your actual models and data
    - **Monitoring** - Set up CloudWatch alarms and logging
    - **Performance** - Load test and optimize for your workload
    - **Cost Management** - Configure auto-scaling and instance types appropriately
    - **Compliance** - Ensure the setup meets your organization's requirements

See the [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/) for production best practices.

## License

This project is licensed under the Apache-2.0 License.

## Security

See [CONTRIBUTING](https://github.com/awslabs/ml-container-creator/blob/main/CONTRIBUTING.md#security-issue-notifications) for information on reporting security issues.

---

<div align="center">
  <p>Made with ❤️ by the ML community, for the ML community</p>
</div>