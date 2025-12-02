# ML Container Creator

<div align="center">
  <img src="../logo.png" alt="ML Container Creator" width="200"/>
  <p><em>Simplify your machine learning deployments on AWS SageMaker</em></p>
</div>

## Overview

ML Container Creator is a Yeoman generator that creates Docker containers for deploying machine learning models to AWS SageMaker using the Bring Your Own Container (BYOC) paradigm.

!!! note "Important"
    This tool generates starter code and reference implementations. Before deploying to production, review and customize the generated code for your specific security, performance, and operational requirements.

!!! note "AI Documentation"
    This documentation was built with AI. It is being reviewed for accuracy and completeness by human-reviewers as part of an initiative to accelerate documentation creation.

**Perfect for:**

- Data scientists who want to deploy models without DevOps overhead
- ML engineers building production model serving pipelines
- Teams standardizing their ML deployment process
- Organizations moving from prototype to production

## Why ML Container Creator?

Deploying machine learning models to production shouldn't be complicated. ML Container Creator eliminates the complexity of creating SageMaker BYOC deployments, letting you focus on what matters most - your models.

### What You Get

Every generated project includes:

- ✅ **SageMaker-compatible container** with health checks and invocation endpoints
- ✅ **Local testing suite** to validate before deployment
- ✅ **Sample model and training code** to illustrate the deployment
- ✅ **AWS deployment scripts** for ECR and SageMaker
- ✅ **Multi-framework support** (sklearn, XGBoost, TensorFlow, vLLM, SGLang)

## Quick Start

```bash
# Install Yeoman and the generator
cd ml-container-creator
npm install -g yo
npm link

# Generate your project
yo ml-container-creator
```

Answer a few questions about your model, and get a complete container with model serving, testing, and deployment scripts.

## Supported Frameworks

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
- **SGLang** - Efficient transformer serving

## Features

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

- ECR image building and pushing scripts
- SageMaker endpoint deployment scripts
- S3 model artifact support (for transformers)
- IAM role configuration guidance

### 🎯 Instance Types

Currently supports **CPU-optimized** instances. The generated deployment scripts can be customized to use GPU instances (ml.g4dn.xlarge, ml.g5.xlarge, ml.p3.2xlarge) for your specific needs.

## Documentation

### User Guides
- **[Getting Started](getting-started.md)** - Installation and first project
- **[Examples](EXAMPLES.md)** - Step-by-step walkthroughs for all frameworks
- **[Troubleshooting](TROUBLESHOOTING.md)** - Solutions to common issues

### Developer Guides
- **[Adding Features](ADDING_FEATURES.md)** - Contribute new frameworks or features
- **[Template System](template-system.md)** - How templates work
- **[Project Architecture](architecture.md)** - Architecture and patterns
- **[Coding Standards](coding-standards.md)** - Code style guide
- **[AWS/SageMaker Guide](aws-sagemaker.md)** - Domain knowledge

## Example: Deploy a scikit-learn Model

```bash
# 1. Generate project
yo ml-container-creator
# Choose: sklearn → pkl → flask

# 2. Add your model
cp /path/to/model.pkl my-project/code/model.pkl

# 3. Test locally
cd my-project
docker build -t my-model .
docker run -p 8080:8080 my-model

# 4. Deploy to SageMaker
./deploy/build_and_push.sh
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerRole
```

See [Examples](EXAMPLES.md) for more detailed walkthroughs.

## Requirements

### For Users
- Node.js 24+
- Python 3.8+
- Docker 20+
- AWS CLI 2+

### For Contributors
- [mise](https://mise.jdx.dev/) - Development environment manager
- All tools are automatically managed via `mise.toml`

## Community & Support

### Get Help
- 📖 [Examples Guide](EXAMPLES.md) - Detailed walkthroughs
- 🔧 [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues and solutions
- 🐛 [Report Issues](https://github.com/awslabs/ml-container-creator/issues)
- 💬 [Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- 🗺️ [Roadmap](https://github.com/awslabs/ml-container-creator/projects)

### Contributing

We welcome contributions of all sizes! Whether you're:

- Reporting bugs or requesting features
- Improving documentation
- Adding support for new frameworks
- Optimizing performance

See [Adding Features](ADDING_FEATURES.md) for a detailed guide on contributing new features.

## What is SageMaker BYOC?

Amazon SageMaker Bring Your Own Container (BYOC) lets you deploy custom machine learning models using your own Docker containers. This gives you full control over your model's runtime environment while leveraging SageMaker's managed infrastructure for hosting and scaling.

### Key Benefits

- **Full control** - Use any framework, library, or custom code
- **Managed infrastructure** - SageMaker handles scaling, monitoring, and availability
- **Cost-effective** - Pay only for what you use
- **SageMaker-ready** - Built-in logging, metrics, and health checks

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