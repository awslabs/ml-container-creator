#
<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
  <h1>ML Container Creator</h1>
  <p><em>Simplify your machine learning deployments on AWS SageMaker</em></p>
</div>

## Why ML Container Creator?

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
- **Ready-to-go container** with health checks and invocation endpoints
- **Local testing suite** to validate before deployment
- **Sample model and training code** to illustrate the deployment
- **One-click AWS deployment** scripts
- **Multi-framework support** (sklearn, XGBoost, TensorFlow, vLLM, SGLang)

## Prerequisites

Before you begin, ensure you have:
- An AWS account with SageMaker access
- Basic familiarity with Docker and command line
- A trained machine learning model ready for deployment

## 🚀 Get Started in Minutes

```bash
# Install Yeoman and the generator
cd ml-container-creator
npm install -g yo
npm link

# Generate your project
yo
```

Answer a few questions about your model, and get a complete container with:
- Optimized model serving (Flask or FastAPI)
- Built-in testing and deployment scripts
- Support for SageMaker AI managed endpoint hosting

### Example: Deploy a scikit-learn Model

1. **Prepare your model**: Save as `model.pkl`
2. **Generate container**: Run `yo` and choose `ml-container-creator`
3. **Configure**: Choose sklearn → pkl → flask
4. **Deploy**: Run `./deploy.sh your-sagemaker-role-arn`

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
mise run test     # Run tests
mise run lint     # Run linting

# Make your changes and submit a PR!
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
npm test
npm run lint
```

## Security

See [CONTRIBUTING](./CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.

## 🆘 Support & Troubleshooting

### Get Help
- 📖 [Documentation](https://github.com/awslabs/ml-container-creator/wiki)
- 🐛 [Report Issues](https://github.com/awslabs/ml-container-creator/issues)
- 💬 [Community Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- 🗺️ [Roadmap & Feature Requests](https://github.com/awslabs/ml-container-creator/projects)
- 📖 [SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)

### Common Issues

**Container fails to start**
```bash
# Check logs
docker logs your-container-name

# Test locally first
python code/serve.py
```

**SageMaker deployment fails**
```bash
# Verify IAM permissions
aws iam get-role --role-name SageMakerExecutionRole

# Check ECR repository exists
aws ecr describe-repositories --repository-names your-project
```

<div align="center">
  <p>Made with ❤️ by the ML community, for the ML community</p>
</div>