# ML Container Creator — First-Call Deck

> **Version:** 0.5.0 | **Updated:** 2026-05-14 | **Package:** `@aws/ml-container-creator`

---

## Slide 1: Title

### ML Container Creator

**One CLI command → a complete, deployable SageMaker AI BYOC project.**

```bash
npm install -g @aws/ml-container-creator
ml-container-creator
```

- GitHub: [github.com/awslabs/ml-container-creator](https://github.com/awslabs/ml-container-creator)
- Docs: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)
- License: Apache-2.0

> **Speaker Notes:**
> - Open with: "How many of you have written a Dockerfile for a SageMaker AI endpoint from scratch? How long did it take?"
> - Emphasize: open-source, AWS Labs, Apache-2.0
> - Transition: "Let me show you what that looks like with MCC."

---

## Slide 2: The Problem

### Why BYOC Is Hard

| Challenge | Impact |
|-----------|--------|
| **Boilerplate** | Every model needs a Dockerfile, serve script, health check, deploy script |
| **Framework diversity** | vLLM ≠ Triton ≠ Flask — each has different base images, ports, configs |
| **Instance selection** | 48 instance types across 16 families — which one fits your model? |
| **Misconfigurations** | Wrong CUDA version, missing /ping endpoint, incorrect port → hours of debugging |
| **Deployment targets** | Real-time, async, batch, HyperPod — each has different infrastructure |
| **Secrets & credentials** | HuggingFace tokens, NGC keys — need Secrets Manager, not hardcoded |

> **Speaker Notes:**
> - Ask: "Who here has deployed the same model to both real-time and async endpoints? How much code did you duplicate?"
> - Pain point: teams spend 2-5 days on container boilerplate before they can even test inference
> - Objection handling: "Why not JumpStart?" → JumpStart is great for supported models, but BYOC is needed for custom models, specific versions, or non-standard serving stacks
> - Transition: "MCC eliminates this boilerplate entirely."

---

## Slide 3: What MCC Does

### A Code Generator, Not a Runtime Framework

```
You select:                    MCC generates:
┌─────────────────────┐       ┌──────────────────────────────┐
│ • Model             │       │ • Dockerfile                 │
│ • Serving backend   │  ───► │ • Serving code               │
│ • Deployment target │       │ • do/ lifecycle scripts      │
│ • Instance type     │       │ • Tests                      │
└─────────────────────┘       │ • IAM permissions doc        │
                              │ • README with next steps     │
                              └──────────────────────────────┘
```

**Key principles:**
- **You own the output** — generated code is yours to modify, commit, and maintain
- **No runtime dependency** — MCC is not in your container or deployment path
- **Opinionated defaults, full escape hatches** — works out of the box, customizable everywhere

> **Speaker Notes:**
> - Analogy: "Think of it like create-react-app for ML containers"
> - Emphasize: no lock-in, no runtime agent, no phone-home
> - Objection: "What if I need to customize?" → "You own the code. Change anything. MCC just gives you a head start."
> - Transition: "Let me show you what architectures we support."

---

## Slide 4: Supported Architectures

### 4 Architecture Families — 15 Deployment Configs

| Architecture | Backends | Configs | Use Case |
|---|---|---|---|
| **HTTP** | Flask, FastAPI | 2 | Predictive models (sklearn, XGBoost, TensorFlow) |
| **Transformers** | vLLM, SGLang, TensorRT-LLM, LMI, DJL | 5 | Large language models |
| **Triton** | FIL, ONNX, TensorFlow, PyTorch, vLLM, TensorRT-LLM, Python | 7 | Multi-framework serving via NVIDIA Triton |
| **Diffusors** | vLLM-Omni | 1 | Image generation (diffusion models) |

**Non-interactive usage:**
```bash
ml-container-creator my-model \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-chat-hf \
  --instance-type=ml.g5.2xlarge \
  --region=us-east-1 \
  --skip-prompts
```

> **Speaker Notes:**
> - Walk through each architecture briefly: "HTTP is your traditional ML — sklearn, XGBoost. Transformers is LLMs. Triton is multi-model. Diffusors is image gen."
> - Highlight: 15 configs means 15 tested combinations of Dockerfile + serve code + deploy scripts
> - Engagement: "Which of these architectures does your team use today?"
> - Transition: "Let me show you the workflow end-to-end."

---

## Slide 5: Live Demo

### From Zero to Deployed in 4 Commands

```bash
# 1. Generate the project
ml-container-creator my-llm \
  --deployment-config=transformers-vllm \
  --model-name=mistralai/Mistral-7B-Instruct-v0.2 \
  --instance-type=ml.g5.2xlarge

# 2. Build the container
cd my-llm && ./do/build

# 3. Test locally
./do/run          # Start container locally
./do/test         # Run health check + inference test

# 4. Deploy to SageMaker AI
./do/push         # Push to ECR
./do/deploy       # Create endpoint
./do/test --live  # Test the live endpoint
```

**Full do/ script library (18 scripts):**

| Script | Purpose |
|--------|---------|
| `build` | Build Docker image |
| `run` | Run container locally |
| `test` | Test health + inference (local or live) |
| `push` | Push image to ECR |
| `deploy` | Deploy to SageMaker AI |
| `clean` | Tear down endpoint + resources |
| `status` | Check endpoint status |
| `logs` | Stream CloudWatch logs |
| `register` | Save deployment to registry |
| `benchmark` | Run latency/throughput benchmarks |
| `adapter` | Manage LoRA adapters |
| `add-ic` | Add inference component to endpoint |
| `optimize` | Run optimization recommendations |
| `validate` | Schema-driven config validation |
| `config` | View/edit project configuration |
| `export` | Export project for sharing |
| `ci` | CI pipeline integration |
| `submit` | Submit batch transform job |

> **Speaker Notes:**
> - If doing a live demo: generate an http-flask sklearn project (fastest to build, ~30s)
> - Show the generated file tree, then build + run + curl /ping
> - Key message: "4 commands from nothing to a live endpoint"
> - Transition: "Now let's talk about how MCC makes intelligent decisions for you."

---

## Slide 6: MCP Servers

### 6 Bundled MCP Servers — Intelligent Defaults

| Server | Tool | What It Does |
|--------|------|-------------|
| **instance-sizer** | `get_instance_recommendation` | Recommends instance types based on model size, framework, and budget |
| **region-picker** | `get_regions` | Finds regions with instance availability and lowest latency |
| **base-image-picker** | `get_base_images` | Selects optimal base image for framework + CUDA version |
| **model-picker** | `get_models` | Discovers models from HuggingFace, JumpStart, S3 |
| **hyperpod-cluster-picker** | `get_hyperpod_clusters` | Lists available HyperPod EKS clusters |
| **endpoint-picker** | `get_inference_endpoints` | Discovers existing SageMaker AI endpoints for attachment |

**Two modes:**
- **Static mode** — Uses catalog data (no AWS credentials needed)
- **Smart mode** — Calls AWS APIs for real-time availability, quotas, and pricing

> **Speaker Notes:**
> - Explain MCP: "Model Context Protocol — a standard for AI tools to call external services"
> - Key value: "The instance-sizer alone saves hours of research. It knows that Mistral-7B fits on a g5.xlarge but Llama-70B needs a p4d.24xlarge."
> - New in this version: endpoint-picker for attaching to existing endpoints
> - Objection: "Do I need MCP?" → "No. MCC works without it. MCP just makes the defaults smarter."
> - Transition: "For CI/CD pipelines, you don't use MCP — you use configuration."

---

## Slide 7: Configuration for CI/CD

### 8-Level Precedence Chain

```
1. CLI flags              (highest priority)
2. Environment variables
3. Config file (~/.ml-container-creator/config.json)
4. Preset files (config/presets/*.json)
5. MCP server responses
6. Bootstrap config
7. Parameter schema defaults
8. Hardcoded defaults     (lowest priority)
```

**Non-interactive example:**
```bash
# Environment variables
export MCC_DEPLOYMENT_CONFIG=transformers-vllm
export MCC_MODEL_NAME=meta-llama/Llama-2-7b-chat-hf
export MCC_INSTANCE_TYPE=ml.g5.2xlarge
export MCC_REGION=us-east-1

# Generate without prompts
ml-container-creator my-model --skip-prompts
```

**Config file example:**
```json
{
  "deploymentConfig": "transformers-vllm",
  "modelName": "meta-llama/Llama-2-7b-chat-hf",
  "instanceType": "ml.g5.2xlarge",
  "region": "us-east-1"
}
```

> **Speaker Notes:**
> - Key message: "Every parameter can be set via CLI flag, env var, or config file — no interactive prompts needed"
> - CI/CD use case: "In your pipeline, set env vars and pass --skip-prompts. MCC generates deterministically."
> - Mention: `do/ci` script provides CodeBuild integration out of the box
> - Transition: "Let's look at where these containers can be deployed."

---

## Slide 8: Deployment Targets

### 4 Deployment Targets — Same Container, Different Infrastructure

| Target | Description | Key Feature |
|--------|-------------|-------------|
| **Managed Inference** | SageMaker AI real-time endpoints | Inference Components (multi-model), auto-scaling |
| **Async Inference** | S3-based async processing | SNS notifications, large payload support |
| **Batch Transform** | S3-to-S3 dataset processing | Cost-efficient bulk inference |
| **HyperPod EKS** | Kubernetes on SageMaker AI HyperPod | GPU scheduling, heterogeneous clusters |

**Multi-IC Endpoints (new):**
```bash
# Deploy base model
./do/deploy

# Add a second inference component
./do/add-ic --model-name=codellama/CodeLlama-7b-hf --instance-type=ml.g5.xlarge

# Manage adapters on an IC
./do/adapter add --name=my-lora --path=s3://bucket/adapter/
```

> **Speaker Notes:**
> - Emphasize: "Same Dockerfile works across all 4 targets. The do/ scripts handle the infrastructure differences."
> - Multi-IC: "You can now run multiple models on the same endpoint with independent scaling"
> - HyperPod: "For teams already on EKS, we generate Kubernetes manifests + Helm values"
> - Objection: "We use serverless inference" → "Serverless is great for sporadic traffic. MCC targets persistent endpoints where you need control over the container."
> - Transition: "Let me show you what the generated project looks like."

---

## Slide 9: What You Get

### Generated Project Structure

```
my-model/
├── Dockerfile                    # Multi-stage, optimized for SageMaker AI
├── requirements.txt              # Python dependencies
├── nginx-predictors.conf         # Reverse proxy config (HTTP arch)
├── code/
│   ├── model_handler.py          # Model loading + inference logic
│   ├── serve.py                  # Flask/FastAPI server
│   └── serving.properties        # LMI/DJL config (transformers)
├── do/
│   ├── build                     # Build Docker image
│   ├── run                       # Run locally
│   ├── test                      # Test health + inference
│   ├── push                      # Push to ECR
│   ├── deploy                    # Deploy to SageMaker AI
│   ├── clean                     # Tear down resources
│   ├── adapter                   # LoRA adapter management
│   ├── benchmark                 # Performance testing
│   ├── lib/                      # Shared shell helpers
│   └── ... (18 scripts total)
├── hyperpod/                     # K8s manifests (if HyperPod target)
├── triton/                       # Model repository (if Triton arch)
├── test/
│   └── test_model_handler.py    # Unit tests
├── IAM_PERMISSIONS.md            # Required IAM policies
├── MIGRATION.md                  # Upgrade guide
└── README.md                     # Project-specific docs
```

> **Speaker Notes:**
> - Walk through key files: "Dockerfile is multi-stage and optimized. The do/ scripts are the lifecycle framework."
> - Highlight: "IAM_PERMISSIONS.md tells your platform team exactly what permissions are needed"
> - Key message: "This is a complete, self-contained project. No external dependencies on MCC after generation."
> - Transition: "How does MCC know which base images and versions to use? That's the registry system."

---

## Slide 10: Registry & Validation

### Three Catalogs — Validated Combinations

| Catalog | Entries | What It Contains |
|---------|---------|-----------------|
| **model-servers** | 13 servers | Versions, base images, CUDA compatibility, ports |
| **models** | Popular transformers + diffusors | Model families, parameter counts, recommended instances |
| **instances** | 48 types / 16 families | vCPU, memory, GPU type, GPU memory, cost tier |

### Validation Levels

| Level | Meaning | Example |
|-------|---------|---------|
| ✅ **tested** | End-to-end CI validated | vLLM v0.10.1, TensorRT-LLM 1.2.0rc8, LMI 0.32.0 |
| 🟡 **community-validated** | Reported working by users | DJL 0.36.0 |
| 🔬 **experimental** | Generated but not CI-tested | SGLang v0.5.4, all Triton backends |

**Schema-driven validation (`do/validate`):**
```bash
./do/validate
# ✅ Instance type ml.g5.2xlarge supports CUDA 12.1
# ✅ Model mistralai/Mistral-7B fits in 24GB GPU memory
# ❌ Region ap-southeast-3 does not have ml.g5.2xlarge availability
```

> **Speaker Notes:**
> - Key message: "MCC doesn't just generate code — it validates that your configuration makes sense before you deploy"
> - Engagement: "How many of you have deployed a model to an instance that didn't have enough GPU memory?"
> - The validation catches: wrong CUDA version, insufficient GPU memory, unavailable instance types, incompatible model/server combos
> - Transition: "Once you've deployed, you can save that configuration for replay."

---

## Slide 11: Deployment Registry

### Capture, Replay, Export, Search

```bash
# After a successful deployment, register it
./do/register

# List all registered deployments
ml-container-creator registry list

# Replay a previous deployment
ml-container-creator registry replay my-model-prod

# Export for team sharing
ml-container-creator registry export --format=json > deployments.json

# Import on another machine
ml-container-creator registry import deployments.json

# Search by model or config
ml-container-creator registry search --model="Mistral"
```

**What gets captured:**
- Deployment config, model name, instance type, region
- Timestamp, endpoint name, status
- Full parameter set for deterministic replay

> **Speaker Notes:**
> - Use case: "Your ML engineer deploys a model. Six months later, someone needs to redeploy it. The registry has the exact config."
> - Team sharing: "Export your team's deployments as JSON, commit to git, import on any machine"
> - Objection: "We use Terraform/CDK for this" → "Great — the registry complements IaC. It captures the MCC-specific parameters that feed into your IaC."
> - Transition: "Let me be honest about what MCC is NOT."

---

## Slide 12: What It's Not

### Honest Positioning

| MCC Is | MCC Is Not |
|--------|-----------|
| A code generator | A managed service |
| SageMaker-compatible starter code | Production-ready without review |
| A head start on BYOC | A replacement for JumpStart (supported models) |
| Opinionated defaults | The only way to deploy |
| Open-source (Apache-2.0) | An AWS service with SLA |

**When to use alternatives:**

- **JumpStart** — Your model is in the JumpStart catalog and you don't need container customization
- **SageMaker Inference Toolkit** — You want a Python SDK approach rather than generated code
- **Custom from scratch** — You have unique requirements that don't fit any of the 15 configs

> **Speaker Notes:**
> - This slide builds trust. Be upfront about limitations.
> - Key message: "MCC gives you a 90% head start. The last 10% is your domain-specific customization."
> - Objection: "Is this production-ready?" → "It's SageMaker-compatible and tested, but you should review the generated code, add your security controls, and test with your data before production."
> - Transition: "Here's how to get started."

---

## Slide 13: Getting Started

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 24+ | Runs the CLI |
| Docker | 20+ | Container builds |
| AWS CLI | 2+ | AWS resource management |
| Python | 3.8+ | Generated serving code |

### Install & Run

```bash
# Install globally
npm install -g @aws/ml-container-creator

# Bootstrap AWS infrastructure (one-time)
ml-container-creator bootstrap

# Generate your first project
ml-container-creator

# Or use without installing
npx @aws/ml-container-creator
```

### Resources

- 📖 [Getting Started Guide](https://awslabs.github.io/ml-container-creator/getting-started/)
- 🔧 [Configuration Reference](https://awslabs.github.io/ml-container-creator/configuration/)
- 📋 [Examples](https://awslabs.github.io/ml-container-creator/EXAMPLES/)
- 🐛 [Troubleshooting](https://awslabs.github.io/ml-container-creator/TROUBLESHOOTING/)

> **Speaker Notes:**
> - Bootstrap: "This creates an IAM role, ECR repo, and optionally S3 buckets + CI harness. One-time setup, ~2 minutes."
> - Emphasize: "npx means you can try it without installing anything permanently"
> - Call to action: "Try it today. Generate a project, build it, run it locally. Takes 5 minutes."
> - Transition: "Let me show you what's coming next."

---

## Slide 14: Roadmap

### Shipped ✅ / Designed 📐 / Planned 📋

#### Shipped ✅ (v0.3.0 → v0.5.0)

| Feature | Description |
|---------|-------------|
| Async/Batch/HyperPod targets | 4 deployment targets from one container |
| Secrets Manager integration | HF_TOKEN, NGC_API_KEY via AWS Secrets Manager |
| Schema-driven validation | `do/validate` catches misconfigs before deploy |
| Instance right-sizing MCP | 48 instances, quota-aware recommendations |
| Training Plan reservations | MlReservationArn support for capacity |
| CUDA auto-resolution | Automatic CUDA version matching + compat script |
| CLI config + --skip-prompts | Full non-interactive CI/CD support |
| Yeoman removal | Standalone CLI, no generator framework dependency |
| CI integration harness | CodeBuild-based automated lifecycle testing |
| Bootstrap shared infra | One-command AWS setup (IAM, ECR, S3, CI) |
| Deployment registry | Capture, replay, export/import deployments |
| Multi-IC endpoints | Multiple inference components per endpoint |
| LoRA adapter lifecycle | `do/adapter` add/list/remove/update |
| Post-deploy guidance | Next-steps recommendations after deploy |
| Instance quota & availability | Real-time quota checking via Service Quotas API |
| Benchmarking | `do/benchmark` for latency/throughput testing |

#### Designed 📐 (spec complete, implementation in progress)

| Feature | Description |
|---------|-------------|
| Model architecture validation | Validate model compatibility with selected server |
| Fine-tuning & training | `do/tune` (managed) and `do/train` (bespoke) |

#### Planned 📋

| Feature | Description |
|---------|-------------|
| Notebook export | Export project as Jupyter notebook |
| E2E validation runner | Automated end-to-end deployment testing |

> **Speaker Notes:**
> - Key message: "We've shipped 16 major features since v0.3.0. The tool is actively developed with weekly releases."
> - Highlight multi-IC + LoRA: "You can now run multiple models on one endpoint and hot-swap LoRA adapters without redeploying"
> - Engagement: "Which of the planned features would be most valuable for your team?"
> - Transition: "Thank you — let's open it up for questions."

---

## Slide 15: Thank You + Q&A

### Try It Today

```bash
npx @aws/ml-container-creator
```

**Links:**
- GitHub: [github.com/awslabs/ml-container-creator](https://github.com/awslabs/ml-container-creator)
- Docs: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)
- Issues: [github.com/awslabs/ml-container-creator/issues](https://github.com/awslabs/ml-container-creator/issues)

**Contact:** Open an issue or start a Discussion on GitHub.

> **Speaker Notes:**
> - Reiterate: "5 minutes to try, no AWS credentials needed for local build+test"
> - Common Q&A topics: security review process, multi-region deployment, cost estimation, team onboarding
> - If time: offer to do a live demo of their specific use case

---

## Appendix A: Why a Code Generator

### Alternatives Comparison

| Approach | Pros | Cons |
|----------|------|------|
| **MCC (code generator)** | Full control, no lock-in, customizable, auditable | Must maintain generated code |
| **CLI wrapper (e.g., sagemaker deploy)** | Simple commands | Black box, limited customization |
| **SDK approach (Inference Toolkit)** | Pythonic, flexible | Still need Dockerfile, deploy scripts |
| **Managed service (JumpStart)** | Zero container work | Limited model support, no customization |
| **IaC only (CDK/Terraform)** | Infrastructure as code | Doesn't generate serving code or Dockerfile |

**MCC's sweet spot:** Teams that need BYOC but don't want to write boilerplate from scratch every time.

> **Speaker Notes:**
> - This slide is for the "why not just use X?" objection
> - Key insight: "MCC is complementary to IaC. It generates the application layer; your CDK/Terraform handles the infrastructure layer."

---

## Appendix B: Model Server Versions & Base Images

| Server | Version | Base Image | CUDA | Validation |
|--------|---------|-----------|------|------------|
| vLLM | v0.10.1 | `vllm/vllm-openai:v0.10.1` | 12.4 | ✅ tested |
| vLLM | v0.9.1 | `vllm/vllm-openai:v0.9.1` | 12.1 | ✅ tested |
| SGLang | v0.5.4.post1-cu121 | `lmsysorg/sglang:v0.5.4.post1-cu121` | 12.1 | 🔬 experimental |
| SGLang | v0.4.6-cu121 | `lmsysorg/sglang:v0.4.6-cu121` | 12.1 | 🔬 experimental |
| TensorRT-LLM | 1.2.0rc8 | `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc8` | 12.4 | ✅ tested |
| TensorRT-LLM | 1.1.0 | `nvcr.io/nvidia/tensorrt-llm/release:1.1.0` | 12.1 | ✅ tested |
| LMI | 0.32.0-lmi14.0.0-cu126 | `763104351884.dkr.ecr...djl-inference:0.32.0-lmi14.0.0-cu126` | 12.6 | ✅ tested |
| LMI | 0.31.0-lmi13.0.0-cu124 | `763104351884.dkr.ecr...djl-inference:0.31.0-lmi13.0.0-cu124` | 12.4 | ✅ tested |
| DJL | 0.36.0-pytorch-gpu | `deepjavalibrary/djl-serving:0.36.0-pytorch-gpu` | 12.6 | 🟡 community |
| DJL | 0.35.0-pytorch-gpu | `deepjavalibrary/djl-serving:0.35.0-pytorch-gpu` | 12.4 | 🟡 community |
| vLLM-Omni | v0.16.0 | `vllm/vllm-omni:v0.16.0` | 12.4 | 🔬 experimental |
| vLLM-Omni | v0.14.0 | `vllm/vllm-omni:v0.14.0` | 12.4 | 🔬 experimental |
| Triton (all backends) | 24.08 | `nvcr.io/nvidia/tritonserver:24.08-py3` | 12.5 | 🔬 experimental |

> **Speaker Notes:**
> - "tested" means we run CI against this combination weekly
> - CUDA versions are auto-resolved — MCC picks the right base image for your instance type

---

## Appendix C: Full Parameter Reference

| Parameter | CLI Flag | Env Var | Type | Default |
|-----------|----------|---------|------|---------|
| Project name | (positional) | — | string | — |
| Deployment config | `--deployment-config` | `MCC_DEPLOYMENT_CONFIG` | enum (15 values) | — |
| Model name | `--model-name` | `MCC_MODEL_NAME` | string | — |
| Instance type | `--instance-type` | `MCC_INSTANCE_TYPE` | string | — |
| Region | `--region` | `MCC_REGION` | string | us-east-1 |
| Deploy target | `--deploy-target` | `MCC_DEPLOY_TARGET` | enum | sagemaker |
| Skip prompts | `--skip-prompts` | `MCC_SKIP_PROMPTS` | boolean | false |
| Include testing | `--include-testing` | `MCC_INCLUDE_TESTING` | boolean | true |
| Include sample model | `--include-sample-model` | `MCC_INCLUDE_SAMPLE_MODEL` | boolean | true |

**Endpoint parameters (realtime-inference):**

| Parameter | Type | Range | Default |
|-----------|------|-------|---------|
| initialInstanceCount | integer | 1–100 | 1 |
| dataCapturePercent | integer | 0–100 | 0 |
| variantName | string | — | "AllTraffic" |
| volumeSize | integer | 1–16384 GB | null |

**Inference Component parameters:**

| Parameter | Type | Range | Default |
|-----------|------|-------|---------|
| cpuCount | number | 0.25–768 | null |
| memorySize | integer | 128–3145728 MB | null |
| gpuCount | integer | 0–8 | null |
| copyCount | integer | 0–100 | 1 |
| modelWeight | number | 0–1 | 1.0 |

> **Speaker Notes:**
> - Every parameter follows the 8-level precedence chain
> - IC parameters enable fine-grained resource allocation for multi-model endpoints

---

## Appendix D: Instance Types

### GPU Instances (40 types across 13 families)

| Family | GPU | GPU Memory | CUDA Arch | Cost Tier | Sizes |
|--------|-----|-----------|-----------|-----------|-------|
| g4dn | NVIDIA T4 | 16 GB | Turing | Low | xlarge → 16xlarge (6) |
| g5 | NVIDIA A10G | 24 GB | Ampere | Medium | xlarge → 48xlarge (8) |
| g6 | NVIDIA L4 | 24 GB | Ada Lovelace | Medium | xlarge → 12xlarge (3) |
| g6e | NVIDIA L40S | 48 GB | Ada Lovelace | Medium | xlarge → 48xlarge (7) |
| g7e | NVIDIA RTX PRO 6000 | 96 GB | Blackwell | Medium | 2xlarge → 48xlarge (6) |
| p3 | NVIDIA V100 | 16 GB | Volta | High | 2xlarge → 16xlarge (3) |
| p4d | NVIDIA A100 | 40 GB | Ampere | High | 24xlarge (1) |
| p5 | NVIDIA H100 | 80 GB | Hopper | High | 48xlarge (1) |
| p5e | NVIDIA H200 | 141 GB | Hopper | High | 48xlarge (1) |
| p5en | NVIDIA H200 | 141 GB | Hopper | High | 48xlarge (1) |
| p6 | NVIDIA B200 | 179 GB | Blackwell | High | 48xlarge (1) |
| inf2 | AWS Inferentia2 | 32 GB | Inferentia2 | Low | xlarge → 48xlarge (4) |
| trn1 | AWS Trainium | 32 GB | Trainium1 | Medium | 2xlarge → 32xlarge (2) |

### CPU Instances (8 types across 3 families)

| Family | Use Case | Sizes |
|--------|----------|-------|
| c5 | Compute-optimized (sklearn, XGBoost) | xlarge, 2xlarge |
| m5 | General purpose | large → 4xlarge (4) |
| r5 | Memory-optimized (large feature sets) | large, xlarge |

> **Speaker Notes:**
> - Instance right-sizing MCP server recommends from this catalog based on model size
> - g6e and g7e are the newest additions — great price/performance for mid-size LLMs
> - p6 (B200) is the latest GPU — 179 GB memory for the largest models
