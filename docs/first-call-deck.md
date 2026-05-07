# ML Container Creator — First-Call Deck

> Audience: ML engineers, platform teams, DevOps leads evaluating SageMaker BYOC deployment tooling
> Duration: 30 minutes (20 min presentation + 10 min Q&A)
> Presenter prep: Have a terminal ready with Node.js 24+ and Docker for live demo on Slide 5

---

## Slide 1: Title

**ML Container Creator**

Open-source CLI tool for deploying ML models to Amazon SageMaker

- `npx @aws/ml-container-creator`
- GitHub: [awslabs/ml-container-creator](https://github.com/awslabs/ml-container-creator)
- License: Apache 2.0

> **Speaker Notes:**
> Introduce yourself and the tool in one sentence: "ML Container Creator is an open-source code generator that takes your ML model and produces a complete, deployable SageMaker container project in under a minute."
> Mention it's an AWS Labs project — community-driven, Apache 2.0 licensed, not a managed service.

---

## Slide 2: The Problem

**Getting a model from a notebook to a SageMaker endpoint is harder than it should be.**

Every deployment requires:

1. A Dockerfile that meets SageMaker BYOC requirements (port 8080, `/ping`, `/invocations`)
2. A model server choice and configuration (Flask? vLLM? Triton?)
3. Model loading and inference code
4. Deployment scripts (ECR push, endpoint creation, IAM roles)
5. Testing infrastructure (local container tests, endpoint tests)

**The result:**
- Teams repeat this boilerplate for every model, every framework, every serving stack
- Container misconfigurations → failed deployments, wasted GPU hours
- No standardization across teams → knowledge silos

> **Speaker Notes:**
> Ask the audience: "How many of you have a Dockerfile for SageMaker that you copy-paste between projects?" — this is the pain point.
> Emphasize that the problem isn't any single step — it's the combination of all of them, and the fact that each framework (sklearn vs. vLLM vs. Triton) has completely different container requirements.
> If they use SageMaker built-in algorithms or JumpStart, acknowledge those are great for supported models — MCC is for when you need full control over the container.

---

## Slide 3: What ML Container Creator Does

**One CLI command → complete, buildable project**

```
ml-container-creator
```

Generates:
- SageMaker-compatible Dockerfile (framework-specific)
- Model serving code (handler, server, configs)
- do-framework lifecycle scripts (build, push, deploy, test, clean)
- Optional sample model for immediate testing
- Optional test suite
- Project documentation and IAM permission reference

**Key principle: It's a code generator, not a runtime framework.**
- You own the output — modify anything
- No agent running in your container
- No lock-in beyond SageMaker itself

> **Speaker Notes:**
> Stress the "code generator" distinction. This is not like SageMaker Inference Toolkit or a framework you import. It generates plain files — Dockerfiles, Python scripts, bash scripts — that you can read, modify, and commit to your repo.
> The generated code is starter code. We don't claim "production-ready" — we say "SageMaker-compatible." Teams should review for their security and performance requirements.

---

## Slide 4: Supported Architectures

**4 architecture families, 15 deployment configurations**

### HTTP — Traditional ML
| Config | Use Case |
|--------|----------|
| `http-flask` | sklearn, XGBoost, TensorFlow models via Flask + Gunicorn + Nginx |
| `http-fastapi` | Same frameworks via FastAPI + Uvicorn |

- Small models (KB–MB), CPU instances, millisecond latency
- Model files copied into container at build time
- Engines: `sklearn`, `xgboost`, `tensorflow`

### Transformers — LLM Serving
| Config | Server |
|--------|--------|
| `transformers-vllm` | vLLM (PagedAttention, continuous batching) |
| `transformers-sglang` | SGLang (RadixAttention) |
| `transformers-tensorrt-llm` | TensorRT-LLM (NVIDIA optimized) |
| `transformers-lmi` | Large Model Inference (AWS DJL) |
| `transformers-djl` | Deep Java Library |

- Billion-parameter models from HuggingFace Hub
- GPU instances required, seconds-latency inference
- Models downloaded at runtime, not baked into container

### Triton — NVIDIA Triton Inference Server
| Config | Backend |
|--------|---------|
| `triton-fil` | Forest Inference Library (XGBoost, LightGBM) |
| `triton-onnxruntime` | ONNX Runtime |
| `triton-tensorflow` | TensorFlow SavedModel |
| `triton-pytorch` | PyTorch TorchScript |
| `triton-vllm` | vLLM via Triton |
| `triton-tensorrtllm` | TensorRT-LLM via Triton |
| `triton-python` | Custom Python backend |

- High-throughput, multi-model serving
- Model repository layout + `config.pbtxt` auto-generated

### Diffusors — Image Generation (Roadmap)
| Config | Backend |
|--------|---------|
| `diffusors-vllm-omni` | vLLM-Omni for Stable Diffusion, FLUX |

> **Speaker Notes:**
> Walk through each architecture family briefly. The key insight is that these aren't just different frameworks — they have fundamentally different container architectures:
> - HTTP: your code loads the model, your code handles requests, Nginx sits in front
> - Transformers: the framework IS the server — vLLM/SGLang handle HTTP, model loading, batching, everything
> - Triton: NVIDIA's inference server with a model repository pattern and config.pbtxt
>
> Ask: "Which of these architectures are you currently using or evaluating?" to gauge where to spend time.

---

## Slide 5: Live Demo

**Generate a project in ~60 seconds**

```bash
# Install
npm install -g @aws/ml-container-creator

# Generate
ml-container-creator
```

**Demo flow:**
1. Choose `http-flask` with `sklearn` engine
2. Accept defaults for model format (`pkl`), include sample model
3. Show the generated project structure
4. `./do/build` → Docker image builds
5. `./do/run` → container starts on port 8080
6. `./do/test` → hits `/ping` and `/invocations`
7. Open `do/config` → show centralized configuration
8. Open `Dockerfile` → show it's readable, modifiable code

**If time permits — second demo:**
1. Choose `transformers-vllm` with `meta-llama/Llama-2-7b-chat-hf`
2. Show how the generated Dockerfile is completely different
3. Show the `do/deploy` script and what it does

> **Speaker Notes:**
> This is the most important slide. A live demo is worth 10 slides of explanation.
> Have the terminal pre-configured. If network is unreliable, have a pre-generated project ready as backup.
> Key moments to pause on:
> - The prompt flow (show how few questions are needed)
> - The generated Dockerfile (show it's clean, commented, understandable)
> - The do/config file (show all config is centralized)
> - The do/test output (show it actually works)
>
> If someone asks "can I do this without the interactive prompts?" — perfect segue to Slide 7.

---

## Slide 6: Intelligent Defaults via MCP Servers

**Built-in advisors that help you make better choices**

5 bundled Model Context Protocol servers:

| Server | What It Does |
|--------|-------------|
| Instance Recommender | Suggests right-sized SageMaker instances for your framework and model |
| Region Picker | Filters AWS regions by availability and proximity |
| Base Image Picker | Curated, versioned container images per framework |
| HyperPod Cluster Picker | Discovers your existing HyperPod EKS clusters |
| Model Picker | Resolves HuggingFace model metadata (architecture, gated status, chat templates) |

**Two modes:**
- **Static** (default) — Instant responses from curated catalogs, no AWS credentials needed
- **Smart** (opt-in) — Queries Amazon Bedrock for context-aware recommendations

**Key design decision:** MCP servers are configuration providers, not AI agents. They populate prompt choices and defaults. No LLM is in the loop unless you opt into smart mode.

> **Speaker Notes:**
> MCP (Model Context Protocol) might be unfamiliar to the audience. Explain it simply: "These are small helper programs that the generator talks to over stdio. They answer questions like 'what instance types work well for vLLM?' and the generator uses those answers to populate your choices."
> Emphasize that static mode requires zero AWS credentials — it works from curated JSON catalogs shipped with the tool.
> Smart mode is a nice-to-have for teams that want Bedrock-powered recommendations, but it's completely optional.

---

## Slide 7: Configuration for CI/CD

**8-level configuration precedence — prompts are the last resort**

```
CLI Options (highest)
  → CLI Arguments
    → Environment Variables
      → CLI Config File (--config=prod.json)
        → Custom Config File (ml-container.config.json)
          → Package.json section
            → Generator Defaults
              → Interactive Prompts (lowest)
```

**Fully automated generation:**
```bash
ml-container-creator \
  --skip-prompts \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-2-7b-chat-hf \
  --instance-type=ml.g5.xlarge \
  --region=us-east-1
```

**Config file for teams:**
```json
{
  "deploymentConfig": "transformers-vllm",
  "modelName": "meta-llama/Llama-2-7b-chat-hf",
  "instanceType": "ml.g5.xlarge",
  "awsRegion": "us-east-1"
}
```

**Environment variables for pipelines:**
```bash
export ML_INSTANCE_TYPE=ml.g5.xlarge
export AWS_REGION=us-east-1
export AWS_ROLE=arn:aws:iam::123456789012:role/SageMakerRole
```

> **Speaker Notes:**
> This slide matters most for platform teams and DevOps leads. The interactive prompts are great for exploration, but real adoption happens when you can run this in a CI pipeline.
> Walk through a concrete scenario: "Your ML platform team creates a config file with approved instance types and regions. Individual data scientists run the generator with that config file, and it pre-fills the right defaults. In CI, you use --skip-prompts with environment variables."
> Mention that `AWS_REGION` is treated as an ambient env var — it's used as a default rather than an override, since most developers have it set in their shell already.

---

## Slide 8: Deployment Targets

**Same container, multiple deployment paths**

### SageMaker Managed Inference
- Standard real-time endpoints via Inference Components API
- `./do/deploy <role-arn>` → creates endpoint config, endpoint, inference component
- `./do/test <endpoint-name>` → validates the live endpoint
- `./do/logs` → tails CloudWatch logs
- `./do/clean endpoint` → tears down everything

### SageMaker HyperPod EKS
- Kubernetes-based deployment on HyperPod clusters
- Generates K8s manifests: `deployment.yaml`, `service.yaml`, `configmap.yaml`, `pvc.yaml`
- `./do/deploy` → `kubectl apply` to your cluster
- FSx for Lustre volume support for large model storage
- Cluster discovery via MCP server (auto-populates cluster choices)

### Build Targets
- **Local** — `./do/build` + `./do/push` (Docker on your machine)
- **CodeBuild** — `./do/submit` (cloud-based build, no local Docker needed)

> **Speaker Notes:**
> The key message: the container image is the same regardless of deployment target. What changes is the deployment script and the infrastructure manifests.
> For HyperPod EKS, mention that this is for teams that already have HyperPod clusters. The generator doesn't create the cluster — it generates the manifests to deploy onto an existing one.
> CodeBuild is important for LLM containers that can be 10-20GB — building those locally is painful. `do/submit` sends the build to CodeBuild where it has fast network access to pull base images.

---

## Slide 9: What You Get

**Generated project structure**

```
my-model/
├── do/                         ← Lifecycle scripts
│   ├── config                  ← Centralized configuration (all settings in one place)
│   ├── build                   ← Build Docker image
│   ├── push                    ← Push to Amazon ECR
│   ├── deploy                  ← Deploy to SageMaker (branches by target)
│   ├── run                     ← Run container locally on port 8080
│   ├── test                    ← Test local container or live endpoint
│   ├── logs                    ← Tail CloudWatch logs
│   ├── clean                   ← Tear down resources (local/ecr/endpoint/all)
│   ├── submit                  ← Submit build to CodeBuild
│   ├── export                  ← Export configuration
│   ├── register                ← Capture deployment to registry
│   └── README.md               ← Script documentation
├── code/                       ← Model serving code
│   ├── model_handler.py        ← Model loading and inference logic
│   ├── serve.py                ← Flask/FastAPI server
│   └── flask/                  ← Gunicorn config, WSGI entry (if Flask)
├── hyperpod/                   ← K8s manifests (if HyperPod target)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   └── pvc.yaml
├── sample_model/               ← Optional: trains Abalone sample model
├── test/                       ← Optional: test scripts
├── deploy/                     ← Legacy scripts (backward compat)
├── Dockerfile                  ← SageMaker-compatible, framework-specific
├── requirements.txt            ← Python dependencies
├── IAM_PERMISSIONS.md          ← Required IAM permissions reference
├── MIGRATION.md                ← Legacy → do-framework migration guide
└── README.md                   ← Project-specific documentation
```

> **Speaker Notes:**
> Walk through the structure top-down. Emphasize:
> - `do/config` is the single source of truth — every script reads from it
> - The `do/` scripts are the primary interface — you rarely need to run raw Docker or AWS CLI commands
> - `code/model_handler.py` is where data scientists customize — load_model(), preprocess(), predict(), postprocess()
> - The structure changes based on architecture: Triton projects get a model repository layout, transformer projects get a `code/serve` entrypoint script instead of serve.py
> - Everything is plain files — no hidden magic, no runtime dependencies on the generator

---

## Slide 10: Registry & Validation System

**Curated knowledge that prevents bad deployments**

### Three registries:

| Registry | What It Stores | Example |
|----------|---------------|---------|
| Framework Registry | Base images, CUDA versions, env vars, optimization profiles | vLLM 0.4.0 needs CUDA 12.0–12.3, base image `vllm/vllm-openai:v0.4.0` |
| Model Registry | Chat templates, framework compatibility, tensor parallelism configs | Llama-2-70B needs tp=2 or tp=4 for tensor parallelism |
| Instance-Accelerator Mapping | GPU memory, compute capability per instance type | ml.g5.xlarge has 1x A10G with 24GB VRAM |

### Validation levels:
- **Tested** — Verified by maintainers (vLLM 0.4.0, TensorRT-LLM 1.0.0, LMI 14.0.0)
- **Community-validated** — Reported working by community (vLLM 0.3.0, DJL 0.32.0)
- **Experimental** — New or untested (SGLang, all Triton backends)

### What gets validated:
- Framework + instance type compatibility (GPU required for transformers)
- CUDA version ranges (warns on mismatches)
- Model + framework compatibility (version ranges)
- Environment variable types and ranges

> **Speaker Notes:**
> This is the "why not just use a Dockerfile template?" answer. The registries encode deployment knowledge that would otherwise live in tribal knowledge or Stack Overflow answers.
> Give a concrete example: "If you pick vLLM with an ml.m5.xlarge (CPU-only instance), the generator will warn you that vLLM requires a GPU. If you pick Llama-2-70B, it'll suggest tensor parallelism profiles that split the model across multiple GPUs."
> The registries are extensible — teams can contribute new framework versions or model entries.

---

## Slide 11: Deployment Registry

**Capture what worked, replay it, share it**

```bash
# After a successful deployment, capture it
./do/register

# List all captured deployments
ml-container-creator --registry list

# Replay a known-good deployment
ml-container-creator --registry replay abc12345

# Export for team sharing (sensitive fields auto-stripped)
ml-container-creator --registry export --file team-configs.json

# Import a teammate's configs
ml-container-creator --registry import --file team-configs.json

# Search: "what has worked for vLLM?"
ml-container-creator --registry search --framework vllm
```

**What gets captured:**
- Full configuration (deployment config, instance type, region, env vars)
- Docker image metadata (via `docker inspect`)
- Timestamp, status, deployment target
- Sensitive fields (role ARN, HF_TOKEN) stripped on export

> **Speaker Notes:**
> This feature is about organizational learning. Instead of asking "hey, what instance type did you use for that Mistral deployment?" in Slack, you can search the registry.
> The replay feature is particularly powerful for incident response — "the endpoint that was working last week, what was its exact configuration?" → replay it.
> Export/import enables a team lead to curate a set of known-good configurations and distribute them.

---

## Slide 12: What It's Not

**Setting proper expectations**

| It Is | It Is Not |
|-------|-----------|
| A code generator | A managed service |
| Starter code you own and modify | Production-ready without review |
| SageMaker BYOC tooling | A replacement for JumpStart or built-in algorithms |
| Framework-agnostic scaffolding | A model serving framework (no runtime dependency) |
| Open source (Apache 2.0) | An AWS service with SLA |

**When to use something else:**
- Your model is supported by SageMaker built-in algorithms → use those
- You want one-click deployment of a popular model → use JumpStart
- You need a managed MLOps pipeline → use SageMaker Pipelines
- You want to use MCC → when you need full control over the container, custom serving logic, or frameworks not supported by built-in options

> **Speaker Notes:**
> This slide builds trust. Being honest about limitations makes the strengths more credible.
> The most common objection will be "why not just use JumpStart?" — the answer is control. JumpStart is great when it supports your model and your serving requirements. MCC is for when you need to customize the container, use a specific framework version, or deploy to HyperPod.
> Another common question: "Is this supported by AWS?" — it's an AWS Labs open-source project. It's not an AWS service. There's no support plan. But it's actively maintained and contributions are welcome.

---

## Slide 13: Getting Started

**Prerequisites:**
- Node.js 24.11.1+ and npm 11.6.2+
- Python 3.8+ (for generated projects)
- Docker 20+ (for building containers)
- AWS CLI 2+ (for deployment)
- SageMaker execution role ARN (for endpoint creation)

**Install and run:**
```bash
# Clone and install
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator
npm install
npm link

# Generate a project
ml-container-creator

# Or fully automated
ml-container-creator --skip-prompts --deployment-config=http-flask --engine=sklearn
```

**Resources:**
- Documentation: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)
- GitHub: [awslabs/ml-container-creator](https://github.com/awslabs/ml-container-creator)
- Issues & contributions welcome

> **Speaker Notes:**
> If doing a workshop or hands-on session, have participants clone the repo before the session.
> The Node.js 24+ requirement may surprise people — mention it's for ES module support and modern JavaScript features. Most teams can use nvm to manage Node versions.
> End with a clear call to action: "Try generating a container for one of your existing models this week. If you hit issues, open a GitHub issue."

---

## Slide 14: Roadmap Highlights

**What's coming next:**

| Feature | Status | Description |
|---------|--------|-------------|
| Async Inference Endpoints | Designed | Large payloads (up to 1GB), long inference (up to 1hr), scale-to-zero |
| Diffusion Model Support | Designed | Image generation via vLLM-Omni (Stable Diffusion, FLUX) |
| Triton Sample Models | Designed | Auto-training for Triton backends (FIL, ONNX, TF, Python) |
| S3 Model Loading | Planned | Load models from S3 at runtime instead of baking into container |
| JumpStart Integration | Planned | Use JumpStart model artifacts with custom containers |
| SageMaker Model Registry | Planned | Pull models from SageMaker Model Registry |

> **Speaker Notes:**
> Gauge interest in roadmap items. If the audience is heavy on LLMs, emphasize async inference (critical for large batch workloads). If they're on traditional ML, emphasize S3 model loading.
> "Designed" means there's a full spec with requirements, design, and task breakdown. "Planned" means it's on the roadmap but not yet specced out.
> Invite contributions: "If any of these are critical for your team, we'd love contributions or even just detailed use cases to help prioritize."

---

## Appendix A: Why a Code Generator?

**Alternatives considered:**

| Approach | Pros | Cons |
|----------|------|------|
| CLI wrapper (like `sam deploy`) | Familiar UX | Hides complexity, hard to customize |
| SDK/library (import in Python) | Programmatic control | Runtime dependency, version coupling |
| Managed service | Zero maintenance | Vendor lock-in, limited customization |
| **Code generator** | **Full transparency, no runtime dependency, customizable output** | **One-time generation, manual updates** |

**The code generator approach means:**
- You can read every line of generated code
- You can modify anything without fighting a framework
- Your CI/CD pipeline works with standard Docker and AWS CLI
- No version coupling — generated code doesn't depend on the generator
- You can stop using the generator tomorrow and your projects still work

---

## Appendix B: Framework Versions & Base Images

| Framework | Version | Base Image | CUDA | Validation |
|-----------|---------|-----------|------|------------|
| vLLM | 0.4.0 | `vllm/vllm-openai:v0.4.0` | 12.1 (12.0–12.3) | Tested |
| vLLM | 0.3.0 | `vllm/vllm-openai:v0.3.0` | 12.1 (11.8–12.2) | Community |
| TensorRT-LLM | 1.0.0 | `nvidia/tensorrt-llm:1.0.0-py3` | 12.2 (12.1–12.3) | Tested |
| TensorRT-LLM | 0.8.0 | `nvidia/tensorrt-llm:0.8.0-py3` | 12.1 (12.0–12.2) | Community |
| LMI | 14.0.0 | AWS DJL inference (cu126) | 12.6 (12.0–12.6) | Tested |
| DJL | 0.32.0 | `deepjavalibrary/djl-serving:0.32.0-pytorch-cu126` | 12.6 (11.8–12.6) | Community |
| SGLang | 0.2.0 | `lmsysorg/sglang:v0.2.0-cu121` | 12.1 (11.8–12.2) | Experimental |
| Triton (all 7) | 24.08 | `nvcr.io/nvidia/tritonserver:24.08-py3` | 12.5 (12.0–12.6) | Experimental |
| vLLM-Omni | 0.16.0 | `vllm/vllm-omni:v0.16.0` | 12.4 (12.1–12.6) | Experimental |
| HTTP (sklearn/xgboost/tf) | — | `python:3.12-slim` | N/A | Tested |

---

## Appendix C: Full Parameter Reference

| Parameter | CLI Flag | Env Var | Config Key | MCP | Required | Value Space |
|-----------|----------|---------|------------|-----|----------|-------------|
| Deployment Config | `--deployment-config` | — | `deploymentConfig` | No | Yes | 15 bounded values |
| Engine | `--engine` | — | `engine` | No | No* | sklearn, xgboost, tensorflow |
| Model Format | `--model-format` | — | `modelFormat` | No | Yes* | Framework-dependent |
| Model Name | `--model-name` | — | `modelName` | No | No* | HuggingFace model ID |
| Instance Type | `--instance-type` | `ML_INSTANCE_TYPE` | `instanceType` | Yes | Yes | Unbounded (any ml.* type) |
| AWS Region | `--region` | `AWS_REGION` | `awsRegion` | Yes | No | Unbounded (any AWS region) |
| IAM Role ARN | `--role-arn` | `AWS_ROLE` | `awsRoleArn` | Yes | No | Unbounded (any ARN) |
| Build Target | `--build-target` | `ML_BUILD_TARGET` | `buildTarget` | No | Yes | codebuild |
| Deployment Target | `--deployment-target` | `ML_DEPLOYMENT_TARGET` | `deploymentTarget` | No | Yes | managed-inference, hyperpod-eks |
| HyperPod Cluster | `--hyperpod-cluster` | — | `hyperPodCluster` | Yes | No* | Unbounded (cluster name) |
| Base Image | `--base-image` | — | `baseImage` | Yes | No | Unbounded (Docker image) |
| HF Token | `--hf-token` | — | `hfToken` | No | No* | Token string |
| Project Name | `--project-name` | — | `projectName` | No | Yes | RFC 1123 DNS label |
| Project Dir | `--project-dir` | — | `destinationDir` | No | Yes | Filesystem path |
| CodeBuild Compute | `--codebuild-compute-type` | `ML_CODEBUILD_COMPUTE_TYPE` | `codebuildComputeType` | No | No | BUILD_GENERAL1_SMALL/MEDIUM/LARGE |

*Required conditionally based on architecture selection

---

## Appendix D: Instance Types

### CPU Instances (for HTTP architecture)

| Instance | vCPUs | Memory | Use Case |
|----------|-------|--------|----------|
| ml.m5.large | 2 | 8 GB | Small models |
| ml.m5.xlarge | 4 | 16 GB | Medium models |
| ml.m5.2xlarge | 8 | 32 GB | Large models |
| ml.m5.4xlarge | 16 | 64 GB | XL models |

### GPU Instances (for Transformers/Triton/Diffusors)

| Instance | vCPUs | Memory | GPU | VRAM | Use Case |
|----------|-------|--------|-----|------|----------|
| ml.g4dn.xlarge | 4 | 16 GB | 1x T4 | 16 GB | Budget GPU |
| ml.g5.xlarge | 4 | 16 GB | 1x A10G | 24 GB | Small LLMs (7B) |
| ml.g5.2xlarge | 8 | 32 GB | 1x A10G | 24 GB | Medium LLMs |
| ml.g5.12xlarge | 48 | 192 GB | 4x A10G | 96 GB | Large LLMs (70B) |
| ml.g6.xlarge | 4 | 16 GB | 1x L4 | 24 GB | Newer GPU, small models |
| ml.g6.12xlarge | 48 | 192 GB | 4x L4 | 96 GB | Newer GPU, multi-GPU |
| ml.p3.2xlarge | 8 | 61 GB | 1x V100 | 16 GB | High-performance |
| ml.p3.8xlarge | 32 | 244 GB | 4x V100 | 64 GB | Multi-GPU training/inference |
