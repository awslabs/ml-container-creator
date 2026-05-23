# Getting Started

This guide covers installation and two end-to-end walkthroughs: deploying a predictive model (sklearn + Flask) and deploying an LLM (SGLang). Both deploy to a SageMaker AI managed inference endpoint.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org/) | 24.11.1+ | Runs the CLI |
| [Python](https://www.python.org/) | 3.8+ | Model serving code |
| [Docker](https://docs.docker.com/get-docker/) | 20+ | Local container builds |
| [AWS CLI](https://aws.amazon.com/cli/) | 2+ | AWS resource management |

You also need an AWS IAM role with permissions for ECR, SageMaker AI, and (optionally) CodeBuild. Verify your setup:

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
  --engine=sklearn \
  --model-format=pkl \
  --include-sample \
  --deployment-target=managed-inference \
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

## Example 2: LLM (SGLang)

This walkthrough deploys an LLM to a SageMaker AI endpoint using SGLang. LLM containers are large and GPU-dependent — this example uses CodeBuild for the image build.

### Generate the project

```bash
mkdir sglang-demo && cd sglang-demo
ml-container-creator sglang-demo \
  --deployment-config=transformers-sglang \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=managed-inference \
  --build-target=codebuild \
  --instance-type=ml.g6.12xlarge \
  --region=us-east-1 \
  --skip-prompts
```

### Project structure

```
sglang-demo/
├── Dockerfile
├── buildspec.yml                 # CodeBuild build specification
├── IAM_PERMISSIONS.md
├── code/
│   ├── serve                     # Entrypoint script launching SGLang
│   └── serving.properties        # Server configuration (model ID, port)
├── do/
│   ├── config
│   ├── build
│   ├── push
│   ├── submit                    # Submit build to CodeBuild
│   ├── deploy
│   ├── test
│   ├── clean
│   ├── register
│   ├── manifest
│   ├── logs
│   └── export
└── test/
    └── test_endpoint.sh
```

### Build with CodeBuild

```bash
./do/submit
```

This creates a CodeBuild project, uploads the source, builds the Docker image, and pushes it to ECR. Monitor progress in the terminal or the CodeBuild console link printed during execution.

### Deploy and test

```bash
./do/deploy       # Deploy to SageMaker AI (GPU endpoint, may take 5-10 minutes)
./do/test         # Test with an OpenAI-compatible chat completion request
```

Output:

```
🧪 Testing SageMaker AI endpoint: sglang-demo-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: OpenAI-compatible chat completion request
   Invoking SageMaker AI endpoint...
✅ Inference request successful
   Response preview: {"choices": [{"message": {"content": "I'm doing great—thanks for asking!..."}}]}

✅ All tests passed!
```

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

- [How It Works](how-it-works.md) — Understand the generator architecture and prompt flow
- [Configuration](configuration.md) — CLI flags, environment variables, config files, and MCP servers
- [Deployment & Inference](deployments.md) — All deployment targets and lifecycle scripts
- [Fine-Tuning](fine-tuning.md) — Fine-tune supported models with `do/tune` and deploy adapters
- [Examples](EXAMPLES.md) — Walkthroughs for other architectures (Triton, diffusors, async, batch transform)
- [CI Integration](ci-integration.md) — Automated lifecycle testing for all deployment configurations
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and solutions
