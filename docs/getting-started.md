# Getting Started

This guide covers installation and two end-to-end walkthroughs: deploying a predictive model (sklearn + Flask) and deploying an LLM (vLLM). Both deploy to a SageMaker AI managed inference endpoint.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org/) | 24+ | Runs the CLI |
| [Python](https://www.python.org/) | 3.10+ | `do/` lifecycle scripts and model serving |
| [Docker](https://docs.docker.com/get-docker/) | 20+ | Local container builds |
| [AWS CLI](https://aws.amazon.com/cli/) | 2+ | AWS resource management |

You also need an AWS IAM role with permissions for ECR, SageMaker AI, and (optionally) CodeBuild.

**Python dependencies** (`boto3`, `sagemaker>=3.0`, `huggingface_hub`, `pyarrow`, `hf_transfer`, `packaging`, `PyYAML`) are installed automatically when you run `npm install`. If you use a virtual environment or pyenv, activate it before running `npm install` so dependencies land in the correct location. The full list is in [`requirements.txt`](https://github.com/awslabs/ml-container-creator/blob/main/requirements.txt).

Verify your setup:

```bash
node --version
python --version
docker --version
aws --version
aws sts get-caller-identity
```

## Installation

### From npm (recommended)

```bash
npm install -g @aws/ml-container-creator
```

### Zero-install with npx

```bash
npx @aws/ml-container-creator
```

### From source

```bash
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator
npm install && npm link
```

Verify the CLI is available:

```bash
ml-container-creator --version
```

## Example 1: Predictive Model (sklearn + Flask)

This walkthrough generates a project that serves a scikit-learn model behind Flask on a SageMaker AI real-time endpoint. It uses the built-in Abalone sample model so you can follow along without providing your own model file.

### Generate the project

```bash
mkdir sklearn-demo && cd sklearn-demo
ml-container-creator sklearn-demo \
  --deployment-config=http-flask \
  --model-format=pkl \
  --deployment-target=realtime-inference \
  --instance-type=ml.m5.large \
  --region=us-east-1 \
  --skip-prompts
```

The generator creates the project directory and trains the sample model automatically.

### Project structure

```
sklearn-demo/
├── Dockerfile
├── requirements.txt
├── nginx-predictors.conf
├── code/
│   ├── model_handler.py          # Model loading and inference
│   ├── serve.py                  # Flask server
│   ├── start_server.py
│   └── flask/
│       ├── gunicorn_config.py
│       └── wsgi.py
├── sample_model/
│   ├── train_abalone.py          # Training script
│   ├── test_inference.py         # Local inference test
│   └── abalone_model.pkl         # Trained model artifact
├── do/                           # Lifecycle scripts
│   ├── config                    # Project configuration
│   ├── build                     # Build Docker image
│   ├── push                      # Push to ECR
│   ├── submit                    # Submit build to CodeBuild
│   ├── deploy                    # Deploy to SageMaker AI
│   ├── validate                  # Validate config against AWS service models
│   ├── test                      # Test local or deployed endpoint
│   ├── clean                     # Tear down resources
│   ├── register                  # Log to deployment registry
│   ├── manifest                  # Asset manifest operations
│   ├── run                       # Run container locally
│   ├── logs                      # Tail CloudWatch logs
│   └── export                    # Export config as JSON
└── test/
    ├── test_local_image.sh
    ├── test_model_handler.py
    └── test_endpoint.sh
```

### Build, push, and deploy

If you haven't already, run `ml-container-creator bootstrap` to set up your IAM role and ECR repository. Optionally sync AWS service models for pre-deploy validation:

```bash
ml-container-creator bootstrap sync-schemas
```

!!!tip
    `bootstrap` automatically chains post-setup steps: AWS resources → mcp init → sync-architectures → sync-schemas. You don't need to run `sync-schemas` separately after a fresh bootstrap. Use `--skip-post-setup` to bypass the chain if you only need the core AWS resources.

```bash
./do/build        # Build the Docker image
./do/push         # Push to Amazon ECR
./do/validate     # Validate config against AWS service models (optional)
./do/deploy       # Deploy to SageMaker AI (requires IAM role ARN)
```

`./do/deploy` creates a SageMaker AI endpoint configuration, endpoint, and inference component. It waits for the endpoint to reach `InService` status.

### Test

```bash
# Test the deployed endpoint
./do/test
```

Output:

```
🧪 Testing SageMaker AI endpoint: sklearn-demo-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: Sample feature vector
   Invoking SageMaker AI endpoint...
✅ Inference request successful
   Response preview: {"predictions": [12.86]}

✅ All tests passed!
```

You can also test locally before deploying:

```bash
./do/run          # Start container on localhost:8080
./do/test         # Test against local container (no argument = local mode)
```

### Bring your own model

To use your own model instead of the sample, edit the Dockerfile `COPY` directive:

```dockerfile
# Replace the sample model line:
# COPY sample_model/abalone_model.pkl /opt/ml/model/
COPY path/to/your/model.pkl /opt/ml/model/
```

## Example 2: LLM (vLLM)

This walkthrough deploys [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) to a SageMaker AI real-time endpoint using vLLM. The model runs on a single `ml.g5.xlarge` GPU instance and supports LoRA adapter hot-swapping out of the box.

!!! note "Time estimate"
    ~30 minutes end-to-end (most of that is waiting for the container build and endpoint deployment).

### Generate the project

```bash
ml-container-creator qwen3-demo \
  --deployment-config=transformers-vllm \
  --model-name=Qwen/Qwen3-4B \
  --deployment-target=realtime-inference \
  --instance-type=ml.g5.xlarge \
  --enable-lora \
  --region=us-east-1 \
  --skip-prompts
```

### Project structure

```
qwen3-demo/
├── Dockerfile
├── IAM_PERMISSIONS.md
├── code/
│   ├── serve                     # Entrypoint script launching vLLM
│   └── serving.properties        # Server configuration (model ID, LoRA settings)
├── do/
│   ├── config                    # Project configuration
│   ├── build                     # Build Docker image locally
│   ├── push                      # Push to Amazon ECR
│   ├── submit                    # Submit build to CodeBuild (alternative)
│   ├── deploy                    # Deploy to SageMaker AI
│   ├── test                      # Test inference
│   ├── tune                      # Fine-tune (SageMaker AI managed customization)
│   ├── adapter                   # LoRA adapter management (add/remove/list)
│   ├── benchmark                 # Latency + throughput measurement
│   ├── clean                     # Tear down resources
│   ├── register                  # Log to deployment registry
│   ├── manifest                  # Asset manifest operations
│   ├── logs                      # Tail CloudWatch logs
│   └── export                    # Export config as JSON
└── test/
    └── test_endpoint.sh
```

### Build and push

Build the container image locally and push to Amazon ECR:

```bash
cd qwen3-demo
./do/build        # Build the Docker image (~10 minutes for vLLM base)
./do/push         # Push to Amazon ECR
```

!!! tip
    If your local machine doesn't have enough disk space or you prefer a cloud build, use `./do/submit` instead. This submits the build to AWS CodeBuild (requires bootstrap with CodeBuild enabled).

### Deploy

```bash
./do/deploy       # Deploy to SageMaker AI (GPU endpoint, 5-10 minutes)
```

The deploy script creates an endpoint configuration, endpoint, and inference component. It waits until the endpoint reaches `InService` status — vLLM needs time to download the model weights from HuggingFace and load them onto the GPU.

### Test

```bash
./do/test
```

Output:

```
🧪 Testing SageMaker AI endpoint: qwen3-demo-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: OpenAI-compatible chat completion request
   Invoking SageMaker AI endpoint...
✅ Inference request successful
   Response preview: {"choices": [{"message": {"content": "Hello! I'm Qwen, a large language model created by Alibaba Cloud..."}}]}

✅ All tests passed!
```

The endpoint serves an OpenAI-compatible API — you can use it with any OpenAI SDK client by pointing to your SageMaker AI endpoint URL.

### Next: Fine-Tune and Add an Adapter

Your endpoint supports LoRA adapter hot-swapping (we passed `--enable-lora` during generation). You can fine-tune Qwen3-4B and attach the resulting adapter without redeploying:

```bash
# Fine-tune with SageMaker AI managed customization
./do/tune --technique sft --dataset s3://my-bucket/train.jsonl

# Attach the trained adapter to the running endpoint
./do/adapter add my-sft --from-tune

# Test the adapter
./do/test
```

The adapter is served as a separate inference component on the same endpoint — no downtime, no container rebuild. See [Fine-Tuning](fine-tuning.md) for the full guide on training data format, all supported techniques (SFT, DPO, RLAIF, RLVR), and adapter lifecycle management.

## Cleanup

Tear down deployed resources to stop incurring charges:

```bash
./do/clean endpoint   # Delete SageMaker AI endpoint, config, and inference component
./do/clean ecr        # Delete ECR images
./do/clean codebuild  # Delete CodeBuild project and IAM role (if applicable)
./do/clean all        # All of the above
```

## CI Integration (Optional)

The bootstrap command can optionally provision a **CI Integration Harness** that automatically tests your deployment configurations end-to-end on a recurring schedule. This is useful for validating that the generator continues to produce working containers across all supported configurations.

To enable CI during bootstrap:

```bash
ml-container-creator bootstrap
# Answer Yes when prompted for CI Integration
```

Or add CI to an existing bootstrap:

```bash
ml-container-creator bootstrap update --ci
```

Once provisioned, register any generated project for automated testing:

```bash
./do/register --ci
```

The harness will regenerate, build, deploy, test, and tear down the project hourly, reporting results via `./do/ci report`.

For full details, see the [CI Integration Guide](ci-integration.md).

## Next Steps

- [Supported Models](supported-models.md) — Check if your model is validated end-to-end
- [Configuration](configuration.md) — CLI flags, environment variables, config files, and MCP servers
- [Deployment & Inference](deployments.md) — All deployment targets and lifecycle scripts
- [Fine-Tuning](fine-tuning.md) — Fine-tune supported models with `do/tune` and deploy adapters
- [Examples](EXAMPLES.md) — Walkthroughs for other architectures (Triton, diffusors, async, batch transform)
- [MCP Servers](mcp-configuration.md) — Configure intelligent defaults for instance sizing, region selection, and more
- [Benchmarking](benchmarking.md) — Measure latency and throughput with SageMaker AI Benchmarking
- [CI Integration](ci-integration.md) — Automated lifecycle testing for all deployment configurations
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and solutions
