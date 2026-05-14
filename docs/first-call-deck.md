# ML Container Creator — First-Call Deck

> **Version:** 0.5.0 | **Updated:** 2026-05-14 | **Package:** `@aws/ml-container-creator`

---

## Slide 1: Title

### ML Container Creator

**One CLI command → a complete, deployable SageMaker BYOC project.**

```bash
npm install -g @aws/ml-container-creator
ml-container-creator
```

- GitHub: [github.com/awslabs/ml-container-creator](https://github.com/awslabs/ml-container-creator)
- Docs: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)
- License: Apache-2.0

> **Speaker Notes:**
> - Open with: "How many of you have written a Dockerfile for a SageMaker endpoint from scratch? How long did it take?"
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

# 4. Deploy to SageMaker
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
| `deploy` | Deploy to SageMaker |
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
| **endpoint-picker** | `get_inference_endpoints` | Discovers existing SageMaker endpoints for attachment |

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
