# <%= projectName %>

SageMaker-compatible ML container for deploying <%= framework %> models using <%= modelServer %>.

Generated on <%= buildTimestamp %> using [ML Container Creator](https://github.com/yourusername/ml-container-creator).

## Quick Start

### 1. Build the Container

```bash
./do/build
```

Builds a Docker image tagged as `<%= projectName %>:latest`.

### 2. Test Locally

```bash
# Start the container
./do/run

# In another terminal, test the endpoints
./do/test
```

### 3. Push to ECR

```bash
./do/push
```

Pushes the image to Amazon ECR in the `<%= awsRegion %>` region.

### 4. Deploy to SageMaker

```bash
./do/deploy <your-sagemaker-execution-role-arn>
```

Creates a SageMaker endpoint named `<%= projectName %>-endpoint`.

### 5. Test the Endpoint

```bash
./do/test <%= projectName %>-endpoint
```

## Project Structure

```
<%= projectName %>/
├── do/                      # do-framework lifecycle scripts
│   ├── build                # Build Docker image
│   ├── push                 # Push to Amazon ECR
│   ├── deploy               # Deploy to SageMaker
│   ├── run                  # Run container locally
│   ├── test                 # Test container or endpoint
│   ├── clean                # Clean up resources
<% if (deployTarget === 'codebuild') { %>│   ├── submit               # Submit build to CodeBuild
<% } %>│   ├── config               # Configuration variables
│   └── README.md            # Detailed do-framework documentation
├── code/                    # Model serving code
<% if (framework === 'transformers') { %>│   └── serve               # <%= modelServer %> entrypoint script
<% } else { %>│   ├── model_handler.py   # Model loading and inference
│   └── serve.py            # <%= modelServer %> server
<% } %>├── deploy/                 # Legacy scripts (deprecated)
│   ├── build_and_push.sh   # Use ./do/build && ./do/push instead
│   └── deploy.sh           # Use ./do/deploy instead
<% if (includeSampleModel) { %>├── sample_model/          # Sample training code
│   ├── train_abalone.py    # Train sample model
│   └── test_inference.py   # Test inference
<% } %>
<% if (includeTesting) { %>├── test/                  # Test suite
│   ├── test_endpoint.sh    # Test SageMaker endpoint
│   └── test_local_image.sh # Test local container
<% } %>
├── Dockerfile              # Container definition
├── requirements.txt        # Python dependencies
└── README.md               # This file
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

# Framework configuration
FRAMEWORK="<%= framework %>"
MODEL_SERVER="<%= modelServer %>"
<% if (framework === 'transformers') { %>
# Model configuration
MODEL_NAME="<%= modelName %>"
<% } %>
```

You can override these values by setting environment variables before running do scripts.

## Deployment Workflows

### Local Development Workflow

```bash
# Build and test locally
./do/build
./do/run &
./do/test

# When satisfied, push to ECR
./do/push
```

<% if (deployTarget === 'codebuild') { %>### CodeBuild Workflow

```bash
# Submit build to CodeBuild (builds and pushes to ECR)
./do/submit

# Deploy to SageMaker
./do/deploy <role-arn>

# Test the endpoint
./do/test <%= projectName %>-endpoint
```

<% } else { %>### SageMaker Deployment Workflow

```bash
# Build, push, and deploy
./do/build
./do/push
./do/deploy <role-arn>

# Test the endpoint
./do/test <%= projectName %>-endpoint
```

<% } %>### Cleanup

```bash
# Remove local images
./do/clean local

# Remove ECR images
./do/clean ecr

# Delete SageMaker endpoint
./do/clean endpoint

# Clean everything
./do/clean all
```

## do-framework Commands

This project uses the [do-framework](https://github.com/iankoulski/do-framework) for standardized container lifecycle management.

### Available Commands

| Command | Description |
|---------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/deploy <role-arn>` | Deploy to SageMaker endpoint |
| `./do/run` | Run container locally on port 8080 |
| `./do/test [endpoint]` | Test local container or SageMaker endpoint |
| `./do/clean <target>` | Clean up resources (local/ecr/endpoint/all) |
<% if (deployTarget === 'codebuild') { %>| `./do/submit` | Submit build to AWS CodeBuild |
<% } %>
For detailed documentation on each command, see `do/README.md`.

## Framework-Specific Information

<% if (framework === 'sklearn') { %>### scikit-learn

This container serves scikit-learn models using <%= modelServer %>.

**Model Format**: <%= modelFormat %>

**Loading**: Models are loaded from `/opt/ml/model/model.<%= modelFormat %>`

**Inference**: Send JSON requests to `/invocations` endpoint

<% } else if (framework === 'xgboost') { %>### XGBoost

This container serves XGBoost models using <%= modelServer %>.

**Model Format**: <%= modelFormat %>

**Loading**: Models are loaded from `/opt/ml/model/model.<%= modelFormat %>`

**Inference**: Send JSON requests to `/invocations` endpoint

<% } else if (framework === 'tensorflow') { %>### TensorFlow

This container serves TensorFlow/Keras models using <%= modelServer %>.

**Model Format**: <%= modelFormat %>

**Loading**: Models are loaded from `/opt/ml/model/`

**Inference**: Send JSON requests to `/invocations` endpoint

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

**Note**: Requires NGC API key for building. Set `NGC_API_KEY` environment variable.

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

<% } %>
**Inference**: Send requests to `/invocations` endpoint with:
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

## SageMaker Endpoints

### Health Check

SageMaker calls the `/ping` endpoint to verify container health:

```bash
curl http://localhost:8080/ping
```

Expected response: `200 OK`

### Inference

Send prediction requests to the `/invocations` endpoint:

<% if (framework === 'transformers') { %>```bash
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

<% } else { %>```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "instances": [[1.0, 2.0, 3.0, 4.0]]
  }'
```

<% } %>
## AWS Requirements

### IAM Permissions

The SageMaker execution role needs these permissions:

- `ecr:GetAuthorizationToken`
- `ecr:BatchCheckLayerAvailability`
- `ecr:GetDownloadUrlForLayer`
- `ecr:BatchGetImage`
- `s3:GetObject` (if using S3 for model artifacts)
- `logs:CreateLogGroup`
- `logs:CreateLogStream`
- `logs:PutLogEvents`

See `IAM_PERMISSIONS.md` for detailed permission requirements.

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

Set your NGC API key:
```bash
export NGC_API_KEY=your-ngc-api-key
./do/build
```

<% } %>**Docker Not Found**

Install Docker: https://docs.docker.com/get-docker/

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

- Verify the execution role ARN is correct
- Check IAM permissions
- Ensure the instance type is available in your region

**Endpoint Stuck in Creating**

Check CloudWatch logs:
```bash
aws logs tail /aws/sagemaker/Endpoints/<%= projectName %>-endpoint --follow
```

### Runtime Issues

**Container Exits Immediately**

Check container logs:
```bash
docker logs $(docker ps -a | grep <%= projectName %> | awk '{print $1}')
```

**Out of Memory**

Increase instance size or optimize model:
```bash
# Edit do/config
INSTANCE_TYPE="ml.m5.2xlarge"  # Larger instance
```

## Migration from Legacy Scripts

If you're familiar with the old `deploy/` scripts, see `MIGRATION.md` for a command mapping guide.

**Quick Reference**:

| Legacy Command | do-framework Command |
|----------------|---------------------|
| `./deploy/build_and_push.sh` | `./do/build && ./do/push` |
| `./deploy/deploy.sh <role>` | `./do/deploy <role>` |
<% if (deployTarget === 'codebuild') { %>| `./deploy/submit_build.sh` | `./do/submit` |
<% } %>
The legacy scripts are still available but deprecated. They will display warnings and forward to do-framework commands.

## Additional Resources

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

1. Check `do/README.md` for detailed command documentation
2. Review CloudWatch logs for deployment issues
3. See `MIGRATION.md` if migrating from legacy scripts
4. Open an issue on the [ML Container Creator repository](https://github.com/yourusername/ml-container-creator)

## License

This generated project is provided as starter code. Modify as needed for your use case.
