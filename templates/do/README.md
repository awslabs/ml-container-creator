# do/ Scripts

Standardized lifecycle scripts for your ML deployment project, following [do-framework](https://github.com/iankoulski/do-framework) conventions.

> Full documentation: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)

## Configuration

- **Framework**: `<%= framework %>`
- **Model Server**: `<%= modelServer %>`
- **Region**: `<%= awsRegion %>`
- **Instance**: `<%= instanceType %>`
- **Build Target**: `<%= buildTarget %>`

All settings centralized in `do/config`. Override via environment variables.

## Available Scripts

| Script | Description |
|--------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/submit` | Submit remote build to CodeBuild |
| `./do/stage` | Download and stage model artifacts (HuggingFace → S3) |
| `./do/deploy` | Deploy endpoint to SageMaker |
| `./do/add-ic` | Add an inference component to an existing endpoint |
| `./do/test` | Test local container or live endpoint |
| `./do/benchmark` | Run SageMaker AI Benchmarking job |
| `./do/optimize` | Apply model optimizations (quantization, compilation) |
| `./do/tune` | Run hyperparameter tuning job |
| `./do/train` | Launch SageMaker training job |
| `./do/adapter` | Deploy/manage LoRA adapters on a base endpoint |
| `./do/register` | Register model in SageMaker Model Registry |
| `./do/manifest` | Generate deployment manifest (multi-model, multi-region) |
| `./do/export` | Export project configuration as portable archive |
| `./do/validate` | Validate project structure and configuration |
| `./do/run` | Run container locally (docker run) |
| `./do/logs` | Tail CloudWatch logs for endpoint |
| `./do/status` | Show endpoint/IC status and health |
| `./do/clean` | Clean up AWS resources (endpoint, ECR, CodeBuild) |
| `./do/ci` | Run full CI pipeline (build → push → deploy → test) |
| `./do/config` | Display resolved configuration |

## Quick Start

```bash
./do/build              # Build image
./do/push               # Push to ECR
./do/deploy             # Deploy endpoint
./do/test <endpoint>    # Test inference
./do/clean all          # Tear down
```

## See Also

- [`IAM_PERMISSIONS.md`](../IAM_PERMISSIONS.md) — Required IAM permissions per script
- [Full docs](https://awslabs.github.io/ml-container-creator/) — Architecture, tutorials, API reference
