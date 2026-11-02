# <%= projectName %>

SageMaker-compatible ML container for the `<%= deploymentConfig %>` deployment configuration (<%= framework %> architecture, <%= modelServer %> server).

Generated on <%= buildTimestamp %> using [ML Container Creator](https://github.com/awslabs/ml-container-creator).

## Quick Start

### 1. Build the Container

<% if (buildTarget === 'codebuild') { %>```bash
./do/submit     # Build and push with AWS CodeBuild (no local Docker needed)
# or, with local Docker:
./do/build && ./do/push
```
<% } else { %>```bash
./do/build && ./do/push
```
<% } %>
`./do/build` builds a Docker image tagged `<%= projectName %>:latest`; `./do/push` pushes it to Amazon ECR in `<%= awsRegion %>`.

### 2. Test Locally (optional)

```bash
# Start the container
./do/run

# In another terminal, test the local container
./do/test
```

Before the first deploy (no `ENDPOINT_NAME` in `do/config`), `./do/test` targets the local container on port 8080.

### 3. Deploy

```bash
./do/deploy
```

`./do/deploy` deploys to the target set as `DEPLOYMENT_TARGET` in `do/config` (`<%= typeof deploymentTarget !== 'undefined' && deploymentTarget ? deploymentTarget : 'realtime-inference' %>` by default) and prompts for any value it still needs, such as the instance type. Choose a target explicitly with `--target`:

```bash
./do/deploy --target realtime-inference --instance-type <%= instanceType %>
./do/deploy --target hyperpod-eks --cluster-name <cluster> --namespace <ns>
./do/deploy --dry-run    # resolved config + right-sizing preflight, creates nothing
./do/deploy --help       # all targets and flags
```

`./do/deploy --help` lists every target. The SageMaker execution role comes from your bootstrap profile (`ml-container-creator bootstrap`) or `ROLE_ARN` in the environment; `do/deploy` takes no positional arguments. On `realtime-inference` the endpoint is named `<%= projectName %>-endpoint-<timestamp>` unless you pass `--endpoint-name`.

### 4. Test the Deployment

```bash
./do/test       # invokes the active deployment
./do/status     # deployment health
./do/logs       # CloudWatch (SageMaker targets) or kubectl (hyperpod-eks / eks)
```

## Project Structure

```
<%= projectName %>/
├── do/                      # Lifecycle scripts (see do/README.md for the full list)
│   ├── config               # Project configuration, sourced by every script
│   ├── build, push, submit  # Build and publish the image
│   ├── deploy, test, status # Deploy, invoke, inspect
│   ├── logs, metrics        # Logs and serving metrics
│   ├── clean                # Tear down resources
│   └── README.md            # Script reference
├── code/                    # Model serving code
<% if (includeSampleModel && framework !== 'transformers' && framework !== 'diffusors') { %>├── sample_model/            # Sample training code
│   ├── train_abalone.py     # Train sample model
│   └── test_inference.py    # Test inference
<% } %><% if (includeTesting) { %>├── test/                    # Test suite
<% } %>├── Dockerfile               # Container definition
├── requirements.txt         # Python dependencies
├── IAM_PERMISSIONS.md       # IAM permissions per script
└── README.md                # This file
```

## Configuration

All deployment configuration is centralized in `do/config`:

```bash
# Project identification
PROJECT_NAME="<%= projectName %>"
DEPLOYMENT_CONFIG="<%= deploymentConfig %>"

# AWS configuration
AWS_REGION="<%= awsRegion %>"
INSTANCE_TYPE="<%= instanceType %>"

# Derived from the deployment config
FRAMEWORK="<%= framework %>"
MODEL_SERVER="<%= modelServer %>"
<% if (framework === 'transformers') { %>
# Model configuration
MODEL_NAME="<%= modelName %>"
<% } %>
```

You can override these values by setting environment variables before running do scripts. `./do/export` prints the current configuration as a reproducible generator command.

<% if (framework === 'transformers') { %>### Gated models (Hugging Face token)

Store the token in AWS Secrets Manager and deploy by reference. The container resolves the ARN at startup with the execution role, so the value is not baked into the image or written to the SageMaker container Environment:

```bash
ml-container-creator secrets create --type hf-token --name <label> --secret-value <token>
mcc bootstrap add-secret hfToken <secret-arn>    # or set HF_TOKEN_ARN in do/config
./do/deploy
```

`do/deploy` refuses a plaintext `HF_TOKEN` with no `HF_TOKEN_ARN` (exit 3). `--allow-plaintext-secret` is the explicit opt-out. See the [Secrets guide](https://awslabs.github.io/ml-container-creator/secrets/).

<% } %>## Deployment Workflows

### Local Development Workflow

```bash
# Build and test locally
./do/build
./do/run &
./do/test

# When satisfied, push to ECR
./do/push
```

<% if (buildTarget === 'codebuild') { %>### CodeBuild Workflow

```bash
# Submit build to CodeBuild (builds and pushes to ECR)
./do/submit

# Deploy (DEPLOYMENT_TARGET from do/config, or --target <t>)
./do/deploy

# Test the deployment
./do/test
```

<% } else { %>### Deployment Workflow

```bash
# Build, push, and deploy
./do/build
./do/push
./do/deploy

# Test the deployment
./do/test
```

<% } %>### Cleanup

```bash
# Remove local images
./do/clean local

# Remove ECR images
./do/clean ecr

# Delete the SageMaker endpoint (realtime-inference)
./do/clean endpoint

# Clean everything for the active target
./do/clean all
```

`./do/clean --help` lists the scopes for the active target (`--target <t>` selects another).

## do-framework Commands

This project uses the [do-framework](https://github.com/iankoulski/do-framework) for standardized container lifecycle management.

### Main Commands

| Command | Description |
|---------|-------------|
<% if (buildTarget === 'codebuild') { %>| `./do/submit` | Build and push the image with AWS CodeBuild |
<% } %>| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/run` | Run container locally on port 8080 |
| `./do/deploy [--target <t>]` | Deploy to the active (or given) target |
| `./do/test [<ic-name>]` | Test the local container or the active deployment |
| `./do/status` | Deployment health and status |
| `./do/logs` | Tail deployment logs |
| `./do/clean <scope>` | Clean up resources (`./do/clean --help` for scopes) |

For every script (fine-tuning, adapters, benchmarking, metrics and more), see `do/README.md`.

## Framework-Specific Information

<% if (framework === 'http') { %>### HTTP (<%= modelServer %>)

This container serves a <%= typeof engine !== 'undefined' && engine ? engine : 'Python' %> model behind a <%= modelServer %> server.

**Model Format**: <%= modelFormat %>

**Loading**: Models are loaded from `/opt/ml/model/`

**Inference**: Send JSON requests to the `/invocations` endpoint

<% } else if (framework === 'transformers') { %>### Transformers (<%= modelServer %>)

This container serves transformer models using <%= modelServer %>.

**Model**: <%= modelName %>

<% if (modelServer === 'vllm') { %>**Server**: vLLM - High-throughput LLM serving with PagedAttention

**Features**:
- Continuous batching
- Optimized CUDA kernels
- OpenAI-compatible API

<% } else if (modelServer === 'sglang') { %>**Server**: SGLang - Fast serving with RadixAttention

**Features**:
- Structured generation
- Radix attention for prefix caching
- OpenAI-compatible API

<% } else if (modelServer === 'tensorrt-llm') { %>**Server**: TensorRT-LLM - NVIDIA optimized LLM serving

**Features**:
- TensorRT optimizations
- Multi-GPU support
- OpenAI-compatible API via nginx proxy

**Note**: Requires an NGC API key for building. Store it in Secrets Manager and set `NGC_API_KEY_ARN` (or `mcc bootstrap add-secret ngcApiKey <arn>`).

<% } else if (modelServer === 'lmi') { %>**Server**: LMI (Large Model Inference) - AWS optimized serving

**Features**:
- AWS-optimized inference
- Multiple backend support
- DJL Serving integration

<% } else if (modelServer === 'djl') { %>**Server**: DJL (Deep Java Library) - Multi-framework serving

**Features**:
- Multi-framework support
- Production-ready serving
- AWS integration

<% } else if (modelServer === 'llama-cpp') { %>**Server**: llama.cpp - GGUF model serving on CPU or GPU

<% } %>
<% if (modelServer === 'vllm' || modelServer === 'sglang') { %>**Inference**: Send OpenAI-compatible chat completion requests to the `/invocations` endpoint:
```json
{
  "model": "<%= modelName %>",
  "messages": [{"role": "user", "content": "Your prompt here"}],
  "max_tokens": 100,
  "temperature": 0.7
}
```
<% } else { %>**Inference**: Send requests to the `/invocations` endpoint with:
```json
{
  "inputs": "Your prompt here",
  "parameters": {
    "max_new_tokens": 100,
    "temperature": 0.7
  }
}
```
<% } %>
<% } else if (framework === 'diffusors') { %>### Diffusors (<%= modelServer %>)

This container serves image-generation models using <%= modelServer %>.

**Model**: <%= modelName %>

**Inference**: Send OpenAI-compatible image generation requests to the `/invocations` endpoint, for example `{"prompt": "A white cat", "n": 1, "size": "512x512"}`.

<% } else if (framework === 'triton') { %>### Triton (<%= modelServer %>)

This container serves models with NVIDIA Triton Inference Server using the `<%= modelServer %>` backend. See the [Triton documentation](https://docs.nvidia.com/deeplearning/triton-inference-server/) for the request format of your model.

<% } %>

## SageMaker Endpoints

### Health Check

SageMaker calls the `/ping` endpoint to verify container health:

```bash
curl http://localhost:8080/ping
```

Expected response: `200 OK`

### Inference

Send prediction requests to the `/invocations` endpoint:

<% if (framework === 'transformers' && (modelServer === 'vllm' || modelServer === 'sglang')) { %>```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<%= modelName %>",
    "messages": [{"role": "user", "content": "What is machine learning?"}],
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

<% } else if (framework === 'transformers') { %>```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": "What is machine learning?",
    "parameters": {
      "max_new_tokens": 100,
      "temperature": 0.7
    }
  }'
```

<% } else if (framework === 'http') { %>```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "instances": [[1.0, 2.0, 3.0, 4.0]]
  }'
```

<% } else { %>`./do/test` sends a sample request for this configuration.

<% } %>
## AWS Requirements

### IAM Permissions

See `IAM_PERMISSIONS.md` for the execution role, the CodeBuild role and the permissions each `do/` script needs. The SageMaker execution role created by `ml-container-creator bootstrap` already includes ECR pull, S3 artifact access, CloudWatch Logs and Secrets Manager read (for `HF_TOKEN_ARN` / `NGC_API_KEY_ARN`).

### AWS CLI Configuration

Ensure AWS CLI is configured with appropriate credentials:

```bash
aws configure
```

Or use environment variables:

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_DEFAULT_REGION=<%= awsRegion %>
```

## Troubleshooting

### Build Issues

<% if (modelServer === 'tensorrt-llm') { %>**NGC Authentication Failed**

Store your NGC API key in Secrets Manager and point the project at it:
```bash
ml-container-creator secrets create --type ngc-token --name <label> --secret-value <key>
mcc bootstrap add-secret ngcApiKey <secret-arn>
./do/build
```

<% } %>**Docker Not Found**

Install Docker: https://docs.docker.com/get-docker/ (or build with `./do/submit`, which uses CodeBuild).

**Permission Denied**

Add your user to the docker group:
```bash
sudo usermod -aG docker $USER
```

### Deployment Issues

**ECR Push Failed**

Check AWS credentials and IAM permissions:
```bash
aws sts get-caller-identity
```

**Endpoint Creation Failed**

- Check that your bootstrap profile has an execution role (`ml-container-creator bootstrap status`)
- Check IAM permissions (`IAM_PERMISSIONS.md`)
- Ensure the instance type is available in your region
- Run `./do/validate` and `./do/deploy --dry-run` for pre-deploy checks

**Endpoint Stuck in Creating**

Check the logs:
```bash
./do/logs
```

### Runtime Issues

**Container Exits Immediately**

Check container logs:
```bash
docker logs $(docker ps -a | grep <%= projectName %> | awk '{print $1}')
```

**Out of Memory**

Choose a larger instance and redeploy. `--reconfigure` re-prompts the deployment settings (including the instance type) for the active target, and `--dry-run` runs the right-sizing preflight without creating anything:
```bash
./do/deploy --dry-run
./do/deploy --reconfigure
```

## Additional Resources

- [ML Container Creator documentation](https://awslabs.github.io/ml-container-creator/)
- [do-framework Documentation](https://github.com/iankoulski/do-framework)
- [AWS SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)
- [SageMaker BYOC Guide](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html)
<% if (framework === 'transformers') { %>
<% if (modelServer === 'vllm') { %>- [vLLM Documentation](https://docs.vllm.ai/)
<% } else if (modelServer === 'sglang') { %>- [SGLang Documentation](https://sgl-project.github.io/)
<% } else if (modelServer === 'tensorrt-llm') { %>- [TensorRT-LLM Documentation](https://github.com/NVIDIA/TensorRT-LLM)
<% } else if (modelServer === 'lmi') { %>- [LMI Documentation](https://docs.aws.amazon.com/sagemaker/latest/dg/large-model-inference.html)
<% } else if (modelServer === 'djl') { %>- [DJL Documentation](https://docs.djl.ai/)
<% } %>
<% } %>
## Support

For issues or questions:

1. Check `do/README.md` for the script reference
2. Run `./do/logs` for deployment issues
3. Open an issue on the [ML Container Creator repository](https://github.com/awslabs/ml-container-creator)

## License

This generated project is provided as starter code. Modify as needed for your use case.
