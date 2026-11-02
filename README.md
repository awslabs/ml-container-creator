# ML Container Creator

A CLI tool that creates SageMaker-compatible Docker containers for deploying ML models using the Bring Your Own Container (BYOC) paradigm.

## Supported Configurations

| Architecture | Model Servers | Use Case |
|---|---|---|
| HTTP (traditional ML) | Flask, FastAPI | sklearn, XGBoost, TensorFlow |
| Transformers (LLMs) | vLLM, SGLang, TensorRT-LLM, LMI, DJL, llama.cpp | HuggingFace model IDs, `s3://` artifacts, `registry://` model packages |
| Triton | FIL, ONNX, Python, TensorRT-LLM, vLLM | Multi-framework serving |
| Diffusors | vLLM-Omni | Image generation models |

| Deployment Target | Description |
|---|---|
| Real-Time Inference (`realtime-inference`) | SageMaker real-time endpoints |
| Async Inference (`async-inference`) | SageMaker async endpoints with S3 output |
| Batch Transform (`batch-transform`) | SageMaker batch processing |
| HyperPod EKS (`hyperpod-eks`) | Kubernetes on an existing SageMaker HyperPod cluster |
| Plain EKS (`eks`) | Bring-your-own EKS cluster (Deployment + Service + ConfigMap), no operator |

The target is chosen at deploy time: `./do/deploy --target <target>`.

## Quick Start

### Install from npm

```bash
npm install -g @aws/ml-container-creator
```

### Or use without installing (npx)

```bash
npx @aws/ml-container-creator --help
```

### Or install from source

```bash
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator
npm install && npm link
```

### Bootstrap AWS infrastructure (one-time)

```bash
ml-container-creator bootstrap
```

Provisions modular CDK stacks: `core` (IAM execution role + ECR) and, by default, `registry`; opt in to `benchmark`, `training`, `ci`, `sagemaker-domain` and `eks` (`ml-container-creator bootstrap --help` lists every module). Configuration is saved to `~/.ml-container-creator/config.json`.

### Generate a project

```bash
# Interactive
ml-container-creator

# Non-interactive
ml-container-creator my-model \
  --deployment-config=transformers-vllm \
  --model-name=openai/gpt-oss-20b \
  --instance-type=ml.g6.12xlarge \
  --region=us-east-1 \
  --skip-prompts
```

### Build, push, deploy

```bash
cd my-model
./do/submit       # Build and push with CodeBuild (or: ./do/build && ./do/push)
./do/deploy       # Deploy to the target in do/config (realtime-inference by default; --target <t> to choose)
./do/test         # Test the deployment
./do/benchmark --workload multi-turn-chat
```

### Get help from the advisor

```bash
ml-container-creator hey   # Conversational AI advisor (powered by Bedrock)
```

Ask questions about your project, get optimization recommendations, troubleshoot issues, and plan workflows. See [Agent docs](https://awslabs.github.io/ml-container-creator/agent/) for details.

## Documentation

Full documentation is available at [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/).

- [Getting Started](https://awslabs.github.io/ml-container-creator/getting-started/) — Installation and walkthroughs
- [Upgrading to v2](https://awslabs.github.io/ml-container-creator/upgrading-to-v2/) — What changed and how to migrate
- [Bootstrap](https://awslabs.github.io/ml-container-creator/bootstrap/) — One-time AWS infrastructure
- [Secrets](https://awslabs.github.io/ml-container-creator/secrets/) — Hugging Face / NGC tokens in Secrets Manager
- [Configuration](https://awslabs.github.io/ml-container-creator/configuration/) — CLI flags, env vars, config files, MCP servers
- [Deployment Guide](https://awslabs.github.io/ml-container-creator/deployments/) — All deployment targets and lifecycle scripts
- [Fine-Tuning](https://awslabs.github.io/ml-container-creator/fine-tuning/) — Managed fine-tuning and LoRA adapters
- [Custom Training](https://awslabs.github.io/ml-container-creator/custom-training/) — Your own training code with `do/train`
- [Scale-to-Zero](https://awslabs.github.io/ml-container-creator/scale-to-zero/) — Idle real-time endpoints at zero instances
- [CI Integration](https://awslabs.github.io/ml-container-creator/ci-integration/) — Automated lifecycle testing for all deployment configurations
- [Examples](https://awslabs.github.io/ml-container-creator/EXAMPLES/) — Framework-specific walkthroughs
- [Advisory Agent](https://awslabs.github.io/ml-container-creator/agent/) — Conversational AI advisor (`ml-container-creator hey`)
- [Troubleshooting](https://awslabs.github.io/ml-container-creator/TROUBLESHOOTING/) — Common issues and solutions

## Prerequisites

| Tool | Version | Purpose | Required |
|---|---|---|---|
| [Node.js](https://nodejs.org/) | 24+ | Runs the CLI | Yes |
| [Python](https://www.python.org/) | 3.10+ | `do/` lifecycle scripts (stage, tune, benchmark) | Yes |
| [uv](https://docs.astral.sh/uv/) | latest | Fast Python package installer | Recommended |
| [Docker](https://docs.docker.com/get-docker/) | 20+ | Container builds | Yes |
| [AWS CLI](https://aws.amazon.com/cli/) | 2+ | AWS resource management | Yes |

### Python dependencies

The `do/` lifecycle scripts (`do/tune`, `do/train`, `do/stage`, `do/adapter`) require Python packages. Install them in your Python environment before first use:

```bash
# Recommended (fast):
uv pip install -r requirements.txt

# Or with pip:
pip install -r requirements.txt
```

If you use virtual environments, activate yours first. See [`requirements.txt`](requirements.txt) for the full list (`boto3`, `sagemaker-core`, `huggingface_hub`, `pyarrow`, etc.).

> **Tip:** Install [uv](https://docs.astral.sh/uv/) for 10-50x faster Python package installs: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [CONTRIBUTING.md](CONTRIBUTING.md#security-issue-notifications) for reporting security issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
