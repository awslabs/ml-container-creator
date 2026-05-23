# ML Container Creator

<div align="center">
  <img src="logo.png" alt="ML Container Creator" width="200"/>
</div>

ML Container Creator (MCC) is the BYOC toolkit for [Amazon SageMaker AI](https://aws.amazon.com/sagemaker/ai/) — from model selection to endpoint in one workflow. You select a model, a serving framework, and a deployment target — MCC generates a complete project with Dockerfile, serving code, lifecycle scripts, and tests. Then iterate: fine-tune, hot-swap adapters, benchmark, and operate — all from the same CLI.

MCC validates specific model + server + instance combinations end-to-end — from build through fine-tuning and adapter serving. If your configuration is in the [Supported Models](supported-models.md) catalog, every lifecycle step has been proven. If it's not, MCC still generates a project — you take on the validation yourself.

## What It Supports

### Serving Architectures

| Architecture | Backends | Use Case |
|---|---|---|
| **Transformers** | vLLM, SGLang, TensorRT-LLM, LMI, DJL | Large language models |
| **HTTP** | Flask, FastAPI | Predictive models (sklearn, XGBoost, TensorFlow) |
| **Triton** | FIL, ONNX Runtime, TensorFlow, PyTorch, vLLM, TensorRT-LLM, Python | Multi-framework model serving via NVIDIA Triton |
| **Diffusors** | vLLM | Diffusion models (image generation) |

### Deployment Targets

| Target | Description |
|---|---|
| **Managed Inference** | SageMaker AI real-time endpoints |
| **Async Inference** | S3-based asynchronous processing with SNS notifications |
| **Batch Transform** | S3-to-S3 dataset processing |
| **HyperPod EKS** | Kubernetes deployment on SageMaker AI HyperPod clusters |

### Full Lifecycle

Every generated project includes `do/` scripts for the complete iteration loop:

```bash
./do/build          # Build container
./do/push           # Push to ECR
./do/deploy         # Deploy to SageMaker AI
./do/test           # Validate inference
./do/tune           # Fine-tune (managed serverless)
./do/adapter add    # Hot-swap LoRA adapter
./do/benchmark      # Latency + throughput measurement
./do/clean          # Tear down everything
```

See [Deployment & Inference](deployments.md) for the full script reference.

## Quick Start

```bash
npm install -g @aws/ml-container-creator

ml-container-creator
```

See [Getting Started](getting-started.md) for prerequisites, installation details, and a full walkthrough.

## Documentation

### User Guide

- [Getting Started](getting-started.md) — Install MCC and deploy your first model
- [How It Works](how-it-works.md) — Architecture, prompt flow, and generated project structure
- [Configuration](configuration.md) — CLI flags, environment variables, config files, and MCP
- [Deployment & Inference](deployments.md) — Build paths, deployment targets, and lifecycle scripts
- [Fine-Tuning](fine-tuning.md) — Managed tuning with `do/tune` and LoRA adapter serving
- [Examples](EXAMPLES.md) — End-to-end walkthroughs for each architecture
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and solutions

### Operations Guide

- [CI Integration](ci-integration.md) — Automated E2E validation across golden-path models
- [Benchmarking](benchmarking.md) — Performance measurement with SageMaker AI Benchmarking
- [Contributing](CONTRIBUTING.md) — Development setup and contribution workflow

## Links

- [GitHub Repository](https://github.com/awslabs/ml-container-creator)
- [Report an Issue](https://github.com/awslabs/ml-container-creator/issues)
- [Discussions](https://github.com/awslabs/ml-container-creator/discussions)

## License

Apache-2.0. See [CONTRIBUTING](https://github.com/awslabs/ml-container-creator/blob/main/CONTRIBUTING.md#security-issue-notifications) for security issue reporting.
