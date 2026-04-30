# Getting Started

This guide covers installation and two end-to-end walkthroughs: deploying a predictive model (sklearn + Flask) and deploying an LLM (SGLang). Both deploy to a SageMaker managed inference endpoint.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org/) | 24.11.1+ | Runs the Yeoman generator |
| [Python](https://www.python.org/) | 3.8+ | Model serving code |
| [Docker](https://docs.docker.com/get-docker/) | 20+ | Local container builds |
| [AWS CLI](https://aws.amazon.com/cli/) | 2+ | AWS resource management |

You also need an AWS IAM role with permissions for ECR, SageMaker, and (optionally) CodeBuild. Verify your setup:

```bash
node --version
python --version
docker --version
aws --version
aws sts get-caller-identity
```

## Installation

```bash
npm install -g yo
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator
npm install && npm link
```

Verify the generator is registered:

```bash
yo --generators
# Should list @aws/ml-container-creator
```

## Example 1: Predictive Model (sklearn + Flask)

This walkthrough generates a project that serves a scikit-learn model behind Flask on a SageMaker real-time endpoint. It uses the built-in Abalone sample model so you can follow along without providing your own model file.

### Generate the project

```bash
mkdir sklearn-demo && cd sklearn-demo
yo @aws/ml-container-creator sklearn-demo \
  --deployment-config=http-flask \
  --engine=sklearn \
  --model-format=pkl \
  --include-sample-model \
  --deployment-target=managed-inference \
  --instance-type=ml.m6g.large \
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
│   ├── deploy                    # Deploy to SageMaker
│   ├── test                      # Test local or deployed endpoint
│   ├── clean                     # Tear down resources
│   ├── run                       # Run container locally
│   ├── logs                      # Tail CloudWatch logs
│   └── export                    # Export config as CLI command
└── test/
    ├── test_local_image.sh
    ├── test_model_handler.py
    └── test_endpoint.sh
```

### Build, push, and deploy

```bash
./do/build        # Build the Docker image
./do/push         # Push to Amazon ECR
./do/deploy       # Deploy to SageMaker (requires IAM role ARN)
```

`./do/deploy` creates a SageMaker endpoint configuration, endpoint, and inference component. It waits for the endpoint to reach `InService` status.

### Test

```bash
# Test the deployed endpoint
./do/test
```

Output:

```
🧪 Testing SageMaker endpoint: sklearn-demo-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: Sample feature vector
   Invoking SageMaker endpoint...
✅ Inference request successful
   Response preview: {"predictions": [12.86]}

✅ All tests passed!
```

You can also test locally before deploying:

```bash
./do/run          # Start container on localhost:8080
./do/test local   # Test against local container
```

### Bring your own model

To use your own model instead of the sample, edit the Dockerfile `COPY` directive:

```dockerfile
# Replace the sample model line:
# COPY sample_model/abalone_model.pkl /opt/ml/model/
COPY path/to/your/model.pkl /opt/ml/model/
```

## Example 2: LLM (SGLang)

This walkthrough deploys an LLM to a SageMaker endpoint using SGLang. LLM containers are large and GPU-dependent — this example uses CodeBuild for the image build.

### Generate the project

```bash
mkdir sglang-demo && cd sglang-demo
yo @aws/ml-container-creator sglang-demo \
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
│   ├── deploy
│   ├── test
│   ├── clean
│   ├── logs
│   ├── export
│   └── submit                    # Submit build to CodeBuild
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
./do/deploy       # Deploy to SageMaker (GPU endpoint, may take 5-10 minutes)
./do/test         # Test with an OpenAI-compatible chat completion request
```

Output:

```
🧪 Testing SageMaker endpoint: sglang-demo-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: OpenAI-compatible chat completion request
   Invoking SageMaker endpoint...
✅ Inference request successful
   Response preview: {"choices": [{"message": {"content": "I'm doing great—thanks for asking!..."}}]}

✅ All tests passed!
```

## Cleanup

Tear down deployed resources to stop incurring charges:

```bash
./do/clean endpoint   # Delete SageMaker endpoint, config, and inference component
./do/clean ecr        # Delete ECR images
./do/clean codebuild  # Delete CodeBuild project and IAM role (if applicable)
./do/clean all        # All of the above
```

## Next Steps

- [How It Works](how-it-works.md) — Understand the generator architecture and prompt flow
- [Configuration](configuration.md) — CLI flags, environment variables, config files, and MCP servers
- [Deployment & Inference](deployments.md) — All deployment targets and lifecycle scripts
- [Examples](EXAMPLES.md) — Walkthroughs for other architectures (Triton, diffusors, async, batch transform)
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and solutions
