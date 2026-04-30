# ML Container Creator

<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
</div>

ML Container Creator (MCC) is a [Yeoman](https://yeoman.io/) generator that produces bring-your-own-container (BYOC) projects for deploying ML models on [Amazon SageMaker](https://aws.amazon.com/sagemaker/ai/). You select a model, a serving framework, and a deployment target — MCC generates the Dockerfile, serving code, deployment scripts, and tests.

## What It Supports

### Serving Architectures

| Architecture | Backends | Use Case |
|---|---|---|
| **HTTP** | Flask, FastAPI | Predictive models (sklearn, XGBoost, TensorFlow) |
| **Transformers** | vLLM, SGLang, TensorRT-LLM, LMI, DJL | Large language models |
| **Triton** | FIL, ONNX Runtime, TensorFlow, PyTorch, vLLM, TensorRT-LLM, Python | Multi-framework model serving via NVIDIA Triton |
| **Diffusors** | vLLM-Omni | Diffusion models (image generation) |

### Deployment Targets

| Target | Description |
|---|---|
| **Managed Inference** | SageMaker real-time endpoints |
| **Async Inference** | S3-based asynchronous processing with SNS notifications |
| **Batch Transform** | S3-to-S3 dataset processing |
| **HyperPod EKS** | Kubernetes deployment on SageMaker HyperPod clusters |

## Quick Start

```bash
npm install -g yo
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator
npm install && npm link

yo @aws/ml-container-creator
```

See [Getting Started](getting-started.md) for prerequisites, installation details, and a full walkthrough.

## Documentation

### User Guide

- [Getting Started](getting-started.md) — Install MCC and deploy your first model
- [How It Works](how-it-works.md) — Architecture, prompt flow, and generated project structure
- [Configuration](configuration.md) — CLI flags, environment variables, config files, and MCP
- [Deployment & Inference](deployments.md) — Build paths, deployment targets, and lifecycle scripts
- [Examples](EXAMPLES.md) — End-to-end walkthroughs for each architecture
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and solutions

### Developer Guide

- [Contributing](CONTRIBUTING.md) — Development setup and contribution workflow

## Links

- [GitHub Repository](https://github.com/awslabs/ml-container-creator)
- [Report an Issue](https://github.com/awslabs/ml-container-creator/issues)
- [Discussions](https://github.com/awslabs/ml-container-creator/discussions)

## License

Apache-2.0. See [CONTRIBUTING](https://github.com/awslabs/ml-container-creator/blob/main/CONTRIBUTING.md#security-issue-notifications) for security issue reporting.
