## ml-container-creator

<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
  <h1>ML Container Creator</h1>
  <p><em>Simplify your machine learning deployments on AWS SageMaker</em></p>
</div>

## Why ML Container Creator?

Deploying machine learning models to production shouldn't be complicated. ML Container Creator eliminates the complexity of creating SageMaker Bring Your Own Container (BYOC) inference endpoints, letting you focus on what matters most - your models.

**Perfect for:**
- Data scientists who want to deploy models without DevOps overhead
- ML engineers building production inference pipelines
- Teams standardizing their ML deployment process
- Organizations moving from prototype to production

## 🚀 Get Started in Minutes

```bash
# Install and run
npm install -g yo
npm link
yo sagemaker-generate-byoc
```

Answer a few questions about your model, and get a complete, production-ready container with:
- Optimized inference server (Flask or FastAPI)
- Multi-framework support (sklearn, XGBoost, TensorFlow, Transformers)
- Built-in testing and deployment scripts
- AWS best practices baked in

## 🌟 Open Source & Community Driven

ML Container Creator is **100% open source** under the Apache 2.0 license. We believe the ML community thrives when tools are accessible, transparent, and collaborative.

### 🗺️ Live Roadmap

Our development is driven by real user needs. Check out our [live roadmap](https://github.com/your-repo/projects) to:
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

```bash
# Quick contribution setup
git clone https://github.com/your-repo/ml-container-creator
cd ml-container-creator
npm install
# Make your changes and submit a PR!
```

## 📋 What You Get

Every generated project includes:
- **BYOC-ready container** with health checks and monitoring
- **Local testing suite** to validate before deployment for predictive models
- **Sample model and training code** to get started immediately
- **One-click AWS deployment** scripts

## 🛠️ Requirements

- Node.js 16+
- Python 3.8+
- Docker 20+
- AWS CLI 2+

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.

## 🆘 Need Help?

- 📖 [Documentation](https://github.com/awslabs/ml-container-creator/wiki)
- 🐛 [Report Issues](https://github.com/awslabs/ml-container-creator/issues)
- 💬 [Community Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- 🗺️ [Roadmap & Feature Requests](https://github.com/awslabs/ml-container-creator/projects)

---

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

### Support

- 📖 [SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)
- 🐛 [Report Issues](https://github.com/awslabs/issues)
- 💬 [Discussions](https://github.com/awslabs/discussions)

<div align="center">
  <p>Made with ❤️ by the ML community, for the ML community</p>
</div>
