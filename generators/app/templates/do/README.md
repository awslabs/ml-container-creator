# do-framework Scripts

This directory contains standardized scripts for managing the container lifecycle of your ML deployment project. These scripts follow the [do-framework](https://github.com/iankoulski/do-framework) conventions for consistent, predictable container operations.

## Quick Start

```bash
# Build Docker image
./do/build

# Test locally
./do/run

# Push to Amazon ECR
./do/push

# Deploy to SageMaker
export ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/YOUR_ROLE
./do/deploy

# Test the endpoint
./do/test <endpoint-name>

# Clean up resources
./do/clean all
```

## Project Configuration

**Deployment Configuration**: `<%= deploymentConfig %>`
- Framework: `<%= framework %>`
- Model Server: `<%= modelServer %>`
- AWS Region: `<%= awsRegion %>`
- Instance Type: `<%= instanceType %>`
- Deploy Target: `<%= deployTarget %>`

All configuration is centralized in `do/config`. You can override any setting by exporting environment variables before running scripts.

## Available Commands

### `./do/build`

Build the Docker image for your ML model.

**What it does:**
- Validates Docker is installed
- Handles framework-specific authentication (e.g., NGC for TensorRT-LLM)
- Builds Docker image with appropriate base image (CPU or GPU)
- Tags image with project name and timestamp

**Usage:**
```bash
./do/build
```

<% if (modelServer === 'tensorrt-llm') { %>
**TensorRT-LLM Requirements:**
```bash
# Set NGC API key before building
export NGC_API_KEY=your_ngc_api_key
./do/build
```

Get your NGC API key from [NVIDIA NGC](https://ngc.nvidia.com/).
<% } %>

**Output:**
- Docker image: `<%= projectName %>:latest`
- Tagged image: `<%= projectName %>:YYYYMMDD-HHMMSS`

---

### `./do/push`

Push the Docker image to Amazon Elastic Container Registry (ECR).

**What it does:**
- Validates AWS credentials
- Authenticates with ECR
- Creates ECR repository if it doesn't exist
- Pushes all image tags to ECR
- Displays pushed image URIs

**Prerequisites:**
- AWS credentials configured (`aws configure`)
- Docker image built (`./do/build`)
- IAM permissions for ECR operations

**Usage:**
```bash
./do/push
```

**Output:**
- Image URI: `ACCOUNT_ID.dkr.ecr.<%= awsRegion %>.amazonaws.com/ml-container-creator:<%= projectName %>-latest`

---

### `./do/deploy`

Deploy the container to AWS SageMaker as a managed endpoint.

**What it does:**
- Validates AWS credentials and execution role
- Verifies ECR image exists
- Creates SageMaker model
- Creates endpoint configuration
- Creates and waits for endpoint to reach InService status
- Displays endpoint details and test command

**Prerequisites:**
- AWS credentials configured
- Docker image pushed to ECR (`./do/push`<% if (deployTarget === 'codebuild') { %> or `./do/submit`<% } %>)
- SageMaker execution role ARN

**Usage:**
```bash
export ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/YOUR_SAGEMAKER_ROLE
./do/deploy
```

Or set `ROLE_ARN` in `do/config` to avoid exporting each time.

**Required IAM Permissions:**

The execution role must have:
- SageMaker model and endpoint management
- ECR image access
- S3 access (if using model artifacts)
- CloudWatch Logs write access

**Output:**
- Endpoint name: `<%= projectName %>-endpoint-TIMESTAMP`
- Endpoint status: InService
- Test command: `./do/test <endpoint-name>`

**Deployment Time:** Typically 5-10 minutes for endpoint to reach InService status.

---

### `./do/run`

Run the container locally for testing before deployment.

**What it does:**
- Detects if GPU support is needed based on deployment configuration
- Starts Docker container with port 8080 exposed
- Mounts model directory if specified
- Streams container logs to console

**Prerequisites:**
- Docker image built (`./do/build`)
<% if (framework === 'transformers') { %>- NVIDIA Docker runtime (for GPU support)
<% } %>

**Usage:**
```bash
./do/run
```

<% if (framework === 'transformers') { %>
**GPU Requirements:**
This deployment configuration requires GPU support. Ensure you have:
- NVIDIA GPU with appropriate drivers
- NVIDIA Container Toolkit installed
- Docker configured to use NVIDIA runtime
<% } %>

**Testing the local container:**
```bash
# In another terminal, test the endpoints
./do/test
```

**Stop the container:** Press `Ctrl+C`

---

### `./do/test`

Test the container or SageMaker endpoint with sample requests.

**What it does:**
- Sends health check request to `/ping` endpoint
- Sends sample inference request to `/invocations` endpoint
- Validates responses and displays results
- Supports both local container and SageMaker endpoint testing

**Usage:**

Test local container:
```bash
./do/test
```

Test SageMaker endpoint:
```bash
./do/test <endpoint-name>
```

**Test Payloads:**

<% if (framework === 'sklearn' || framework === 'xgboost' || framework === 'tensorflow') { %>
Traditional ML models expect JSON with feature vectors:
```json
{
  "instances": [[1.0, 2.0, 3.0, 4.0]]
}
```
<% } else if (framework === 'transformers') { %>
Transformer models expect text generation requests:
```json
{
  "inputs": "What is machine learning?",
  "parameters": {
    "max_new_tokens": 50,
    "temperature": 0.7
  }
}
```
<% } %>

**Exit Codes:**
- `0`: All tests passed
- `1`: Test failed (connection error, HTTP error, or validation error)

---

### `./do/clean`

Clean up Docker images and AWS resources.

**What it does:**
- Removes local Docker images
- Deletes images from ECR
- Deletes SageMaker endpoints, configurations, and models
- Prompts for confirmation before destructive operations

**Usage:**

Clean local Docker images:
```bash
./do/clean local
```

Clean ECR images:
```bash
./do/clean ecr
```

Clean SageMaker endpoint and related resources:
```bash
./do/clean endpoint
```

Clean everything:
```bash
./do/clean all
```

**Warning:** Cleaning operations are destructive and cannot be undone. Always confirm you want to delete resources.

---

<% if (deployTarget === 'codebuild') { %>
### `./do/submit`

Submit a build job to AWS CodeBuild (CodeBuild deployment only).

**What it does:**
- Creates CodeBuild project if it doesn't exist
- Creates IAM service role for CodeBuild if needed
- Uploads source code to S3
- Starts CodeBuild job that builds AND pushes image to ECR
- Monitors build progress
- Displays ECR image URI on success

**Prerequisites:**
- AWS credentials configured
- IAM permissions for CodeBuild, S3, and IAM operations

**Usage:**
```bash
./do/submit
```

**Important:** When using CodeBuild deployment, `./do/submit` replaces both `./do/build` and `./do/push`. The buildspec.yml handles building the Docker image and pushing it to ECR in the AWS environment.

**Workflow Comparison:**

Local/SageMaker deployment:
```bash
./do/build   # Build locally
./do/push    # Push to ECR
./do/deploy  # Deploy to SageMaker
```

CodeBuild deployment:
```bash
./do/submit  # Build + push via CodeBuild
./do/deploy  # Deploy to SageMaker
```

**Build Time:** Typically 5-15 minutes depending on image size and complexity.

---

<% } %>
## Configuration Reference

All scripts source configuration from `do/config`. Key variables:

| Variable | Description | Current Value |
|----------|-------------|---------------|
| `PROJECT_NAME` | Project identifier | `<%= projectName %>` |
| `DEPLOYMENT_CONFIG` | Framework-server combination | `<%= deploymentConfig %>` |
| `FRAMEWORK` | ML framework | `<%= framework %>` |
| `MODEL_SERVER` | Model serving framework | `<%= modelServer %>` |
| `AWS_REGION` | AWS region for deployment | `<%= awsRegion %>` |
| `ECR_REPOSITORY_NAME` | ECR repository name | `ml-container-creator` |
| `INSTANCE_TYPE` | SageMaker instance type | `<%= instanceType %>` |
| `DEPLOY_TARGET` | Deployment target | `<%= deployTarget %>` |
<% if (framework === 'transformers') { %>| `MODEL_NAME` | HuggingFace model name | `<%= modelName %>` |
<% } %><% if (modelFormat) { %>| `MODEL_FORMAT` | Model file format | `<%= modelFormat %>` |
<% } %>

### Environment Variable Overrides

You can override any configuration variable by exporting it before running scripts:

```bash
# Override AWS region
export AWS_REGION=us-west-2
./do/deploy

# Override instance type
export INSTANCE_TYPE=ml.g5.2xlarge
./do/deploy

# Override ECR repository name
export ECR_REPOSITORY_NAME=my-custom-repo
./do/push
```

## Troubleshooting

### Build Issues

**Docker not found:**
```
❌ Docker is not installed
```
Install Docker from [https://docs.docker.com/get-docker/](https://docs.docker.com/get-docker/)

<% if (modelServer === 'tensorrt-llm') { %>
**NGC authentication failed:**
```
❌ NGC_API_KEY environment variable not set
```
Get your NGC API key from [https://ngc.nvidia.com/](https://ngc.nvidia.com/) and export it:
```bash
export NGC_API_KEY=your_key_here
```
<% } %>

### Push Issues

**AWS credentials not configured:**
```
❌ AWS credentials not configured
```
Run `aws configure` or set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables.

**ECR authentication failed:**
```
❌ Failed to authenticate with ECR
```
Ensure your IAM user/role has `ecr:GetAuthorizationToken` permission.

### Deploy Issues

**Execution role not provided:**
```
❌ Execution role ARN not provided
```
Export the role ARN:
```bash
export ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/YOUR_ROLE
```

**ECR image not found:**
```
❌ ECR image not found
```
<% if (deployTarget === 'codebuild') { %>Run `./do/submit` to build and push the image via CodeBuild.
<% } else { %>Run `./do/build` and `./do/push` to build and push the image.
<% } %>

**Endpoint creation failed:**
```
❌ Failed to create endpoint
```
Check:
- Instance type is available in your region
- You have sufficient service quota for the instance type
- The execution role has correct permissions
- CloudWatch Logs for detailed error messages

### Test Issues

**Local container not responding:**
```
❌ Could not connect to local container
```
Ensure the container is running: `./do/run`

**SageMaker endpoint not InService:**
```
❌ Endpoint is not InService
```
Wait for endpoint to finish deploying. Check status:
```bash
aws sagemaker describe-endpoint --endpoint-name <endpoint-name> --region <%= awsRegion %>
```

<% if (framework === 'transformers') { %>
### GPU Issues

**NVIDIA runtime not found:**
```
❌ NVIDIA Container Toolkit not installed
```
Install NVIDIA Container Toolkit: [https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

**Out of GPU memory:**
```
❌ CUDA out of memory
```
Try:
- Using a larger instance type with more GPU memory
- Reducing batch size or model size
- Using model quantization
<% } %>

## Workflow Examples

### Development Workflow

1. **Build and test locally:**
   ```bash
   ./do/build
   ./do/run &
   ./do/test
   ```

2. **Deploy to SageMaker:**
   ```bash
   <% if (deployTarget === 'codebuild') { %>./do/submit<% } else { %>./do/push<% } %>
   export ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/YOUR_ROLE
   ./do/deploy
   ```

3. **Test the endpoint:**
   ```bash
   ./do/test <endpoint-name>
   ```

4. **Clean up when done:**
   ```bash
   ./do/clean endpoint
   ```

### CI/CD Workflow

<% if (deployTarget === 'codebuild') { %>
```bash
# In your CI/CD pipeline
./do/submit              # Build and push via CodeBuild
./do/deploy              # Deploy to SageMaker
./do/test <endpoint-name>  # Validate deployment
```
<% } else { %>
```bash
# In your CI/CD pipeline
./do/build               # Build image
./do/push                # Push to ECR
./do/deploy              # Deploy to SageMaker
./do/test <endpoint-name>  # Validate deployment
```
<% } %>

### Iterative Development

```bash
# Make code changes
vim code/model_handler.py

# Rebuild and test
./do/build
./do/run &
./do/test

# Deploy updated version
<% if (deployTarget === 'codebuild') { %>./do/submit<% } else { %>./do/push<% } %>
./do/deploy
```

## Relationship to Legacy Scripts

The `deploy/` directory contains legacy wrapper scripts for backward compatibility:

| Legacy Script | do-framework Equivalent | Status |
|---------------|------------------------|--------|
| `deploy/build_and_push.sh` | `./do/build && ./do/push` | Deprecated |
| `deploy/deploy.sh` | `./do/deploy` | Deprecated |
<% if (deployTarget === 'codebuild') { %>| `deploy/submit_build.sh` | `./do/submit` | Deprecated |
<% } %>

**Migration:** The legacy scripts display deprecation warnings and forward to do-framework scripts. Update your workflows to use `do/` scripts directly.

See [MIGRATION.md](../MIGRATION.md) for detailed migration instructions.

## Additional Resources

- **Main Project README**: [../README.md](../README.md)
- **Migration Guide**: [../MIGRATION.md](../MIGRATION.md)
- **do-framework**: [https://github.com/iankoulski/do-framework](https://github.com/iankoulski/do-framework)
- **AWS SageMaker BYOC**: [https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html)
- **Docker Documentation**: [https://docs.docker.com/](https://docs.docker.com/)

## Getting Help

If you encounter issues:

1. Check the troubleshooting section above
2. Review CloudWatch Logs for SageMaker endpoints
3. Verify IAM permissions and AWS credentials
4. Ensure prerequisites are installed and configured
5. Check the main project README for additional guidance

For bugs or feature requests, please open an issue in the project repository.
