# quick-inference-container

SageMaker-compatible ML container for deploying triton models using fil.

Generated on 2026-03-20T01-32-30 using [ML Container Creator](https://github.com/yourusername/ml-container-creator).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running.
- [AWS CLI](https://aws.amazon.com/cli/) configured with appropriate permissions.
- Python 3.8+ (for local testing scripts).

## Quick Start

### 1. Build the Container

```bash
./do/build
```

Builds a Docker image tagged as `quick-inference-container:latest`.

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

Pushes the image to Amazon ECR in the `us-east-1` region.

### 4. Deploy to SageMaker

```bash
./do/deploy <your-sagemaker-execution-role-arn>
```

Creates a SageMaker endpoint named `quick-inference-container-endpoint`.

### 5. Test the Endpoint

```bash
./do/test quick-inference-container-endpoint
```

## Project Structure

```
quick-inference-container/
├── do/                      # do-framework lifecycle scripts
│   ├── build                # Build Docker image
│   ├── push                 # Push to Amazon ECR
│   ├── deploy               # Deploy to SageMaker
│   ├── run                  # Run container locally
│   ├── test                 # Test container or endpoint
│   ├── clean                # Clean up resources
│   ├── submit               # Submit build to CodeBuild
│   ├── config               # Configuration variables
│   └── README.md            # Detailed do-framework documentation
├── code/                    # Model serving code
│   ├── model_handler.py   # Model loading and inference
│   └── serve.py            # fil server
├── deploy/                 # Legacy scripts (deprecated)
│   ├── build_and_push.sh   # Use ./do/build && ./do/push instead
│   └── deploy.sh           # Use ./do/deploy instead
├── sample_model/          # Sample training code
│   ├── train_abalone.py    # Train sample model
│   └── test_inference.py   # Test inference

├── test/                  # Test suite
│   ├── test_endpoint.sh    # Test SageMaker endpoint
│   └── test_local_image.sh # Test local container

├── Dockerfile              # Container definition
├── requirements.txt        # Python dependencies
└── README.md               # This file
```

## Configuration

All deployment configuration is centralized in `do/config`:

```bash
# Project identification
PROJECT_NAME="quick-inference-container"
DEPLOYMENT_CONFIG="triton-fil"

# AWS configuration
AWS_REGION="us-east-1"
INSTANCE_TYPE="ml.g5.12xlarge"

# Framework configuration
FRAMEWORK="triton"
MODEL_SERVER="fil"

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

### CodeBuild Workflow

```bash
# Submit build to CodeBuild (builds and pushes to ECR)
./do/submit

# Deploy to SageMaker
./do/deploy <role-arn>

# Test the endpoint
./do/test quick-inference-container-endpoint
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.