# quick-inference-container

SageMaker-compatible ML container for deploying triton models using fil.

Generated on 2026-03-20T01-32-30 using [ML Container Creator](https://github.com/yourusername/ml-container-creator).

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

### Cleanup

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
| `./do/submit` | Submit build to AWS CodeBuild |

For detailed documentation on each command, see `do/README.md`.

## Framework-Specific Information



## SageMaker Endpoints

### Health Check

SageMaker calls the `/ping` endpoint to verify container health:

```bash
curl http://localhost:8080/ping
```

Expected response: `200 OK`

### Inference

Send prediction requests to the `/invocations` endpoint:

```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "instances": [[1.0, 2.0, 3.0, 4.0]]
  }'
```


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
export AWS_DEFAULT_REGION=us-east-1
```

## Troubleshooting

### Build Issues

**Docker Not Found**

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
aws logs tail /aws/sagemaker/Endpoints/quick-inference-container-endpoint --follow
```

### Runtime Issues

**Container Exits Immediately**

Check container logs:
```bash
docker logs $(docker ps -a | grep quick-inference-container | awk '{print $1}')
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
| `./deploy/submit_build.sh` | `./do/submit` |

The legacy scripts are still available but deprecated. They will display warnings and forward to do-framework commands.

## Additional Resources

- [do-framework Documentation](https://github.com/iankoulski/do-framework)
- [AWS SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)
- [SageMaker BYOC Guide](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html)

## Support

For issues or questions:

1. Check `do/README.md` for detailed command documentation
2. Review CloudWatch logs for deployment issues
3. See `MIGRATION.md` if migrating from legacy scripts
4. Open an issue on the [ML Container Creator repository](https://github.com/yourusername/ml-container-creator)

## License

This generated project is provided as starter code. Modify as needed for your use case.
