# Deployment & Inference

MCC supports four deployment targets and two build paths, all managed through standardized `do/` scripts inspired by the [do-framework](https://github.com/iankoulski/do-framework). Generated projects include a `do/` directory with scripts for the complete container lifecycle — from build through deployment, fine-tuning, and teardown.

## Build Paths

### Local Build

Run `./do/build` to create the Docker image and `./do/push` to upload it to Amazon ECR. This two-step approach lets you test locally with `./do/run` before pushing.

Local containers may produce `exec` errors when deployed to a different architecture (e.g., building on ARM, deploying on x86). Use CodeBuild for production builds to avoid this.

`./do/run` starts the container on localhost:8080 for local testing. This works well for predictive ML containers (small images, no GPU dependency). LLM containers are large and typically require GPU resources, so local deployment may not be practical for those.

### AWS CodeBuild

`./do/submit` creates an AWS CodeBuild project that builds the Docker image and pushes it to ECR in a single step. This is the preferred method for production containers, as it avoids architecture mismatches and provides fast network access to base image registries.

## Deployment Targets

MCC supports four deployment targets, selected during project generation via the `--deployment-target` option. The chosen target determines how `./do/deploy`, `./do/test`, `./do/clean`, and `./do/logs` behave.

### SageMaker AI Real-Time Inference (`realtime-inference`)

The default deployment target. `./do/deploy` provisions resources using the SageMaker AI Inference Components API:

1. **Create endpoint configuration** -- specifies the instance type and count
2. **Create endpoint** -- provisions the compute infrastructure
3. **Create inference component** -- associates the ECR container image with the endpoint

The inference component model decouples compute provisioning from model deployment, allowing multiple models to share a single endpoint. Once the inference component reaches `InService` status, the endpoint is accessible via the SageMaker AI Runtime API for real-time inference requests.

The generated `do/config` file stores the `INSTANCE_TYPE` and optionally `INFERENCE_AMI_VERSION` for controlling the CUDA driver version on the instance.

After deployment, `./do/test` validates the endpoint by invoking inference through the inference component, `./do/logs` tails CloudWatch logs, and `./do/clean endpoint` tears down the inference component, endpoint, and endpoint configuration.

For real-time inference, async inference, and batch transform deployment patterns, see the target-specific sections below.

### SageMaker AI HyperPod EKS (`hyperpod-eks`)

For existing [SageMaker AI HyperPod](https://aws.amazon.com/sagemaker/hyperpod/) clusters running on Amazon EKS, MCC can deploy containers directly to Kubernetes:

- `./do/deploy` retrieves the underlying EKS cluster from the HyperPod cluster, configures `kubectl`, and applies Kubernetes manifests (Deployment, Service, ConfigMap, and optionally PVC for FSx storage) to the specified namespace.
- `./do/test hyperpod` port-forwards the Kubernetes service and runs the same `/ping` and `/invocations` health checks used for managed inference.
- `./do/logs` tails pod logs via `kubectl`.
- `./do/clean hyperpod` deletes the Kubernetes resources from the namespace.

The generated `do/config` file stores HyperPod-specific variables: `HYPERPOD_CLUSTER_NAME`, `HYPERPOD_NAMESPACE`, `HYPERPOD_REPLICAS`, and optionally `FSX_VOLUME_HANDLE`.

Prerequisites:

- An existing SageMaker AI HyperPod cluster with EKS orchestrator
- `kubectl` installed locally
- IAM permissions for `sagemaker:DescribeCluster` and `eks:DescribeCluster`
- Sufficient node capacity (especially GPU nodes for LLM workloads)

### Async Inference (`async-inference`)

For workloads with large payloads or long processing times (> 60s). `./do/deploy` creates an async endpoint with an S3 output location:

- Requests are submitted and return immediately with an output location
- Results are written to S3 when processing completes
- Optional SNS notifications on success/failure
- Endpoint auto-scales to zero when idle (no cost when not in use)

```bash
ml-container-creator my-async-project \
  --deployment-target=async-inference \
  --async-s3-output-path=s3://my-bucket/async-output/ \
  ...
```

### Batch Transform (`batch-transform`)

For offline batch processing of large datasets. `./do/deploy` submits a SageMaker AI Transform Job:

- Input: S3 path containing request payloads (one per file or line)
- Output: S3 path where predictions are written
- Compute is provisioned on-demand and released after the job completes
- No persistent endpoint — pay only for processing time

!!! note "Limitations"
    Batch transform does not support `do/tune` or `do/adapter` (no running endpoint to attach adapters to).

## Lifecycle Scripts Reference

All generated projects include these `do/` scripts:

| Command | Description |
|---------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/run` | Run container locally on port 8080 |
| `./do/test` | Test local container or deployed endpoint |
| `./do/validate` | Validate configuration against AWS service models (requires schema sync) |
| `./do/deploy` | Deploy to the configured deployment target |
| `./do/tune` | Fine-tune using SageMaker AI Managed Model Customization (serverless) |
| `./do/train` | Custom training jobs with your own scripts and hyperparameters |
| `./do/adapter` | LoRA adapter lifecycle (add, list, remove, update) |
| `./do/add-ic` | Add an inference component to an existing endpoint |
| `./do/benchmark` | Run latency and throughput benchmarks via SageMaker AI Benchmarking |
| `./do/status` | Check endpoint and inference component status |
| `./do/logs` | Tail logs (CloudWatch for realtime-inference, kubectl for HyperPod) |
| `./do/clean <target>` | Clean up resources (local, ecr, endpoint/hyperpod, codebuild, all) |
| `./do/config` | Centralized configuration for all scripts (sourced, not executed) |
| `./do/export` | Export current configuration as a reproducible CLI command |
| `./do/register` | Capture deployment to the deployment registry |
| `./do/ci` | CI pipeline integration (report, status, trigger, dashboard) |
| `./do/submit` | Submit build to AWS CodeBuild (CodeBuild build target only) |

See the generated `do/README.md` for detailed documentation on each command.

### Pre-Deploy Validation

Run `./do/validate` before deploying to catch configuration issues that would cause AWS API failures:

```bash
./do/validate                # Text output, exit 1 on errors
./do/validate --format=json  # JSON output for CI pipelines
./do/validate --smart        # Include smart-mode advisory findings
```

This validates your `do/config` values against the AWS service model, checking enum constraints, type correctness, required fields, and cross-cutting consistency (GPU counts, tensor parallelism, CUDA compatibility). See [Configuration — Schema-Driven Validation](configuration.md#schema-driven-validation) for setup instructions.

The `./do/deploy --dry-run` flag also runs schema validation as part of its pre-flight checks and blocks deployment if errors are found.

## Benchmarking

For transformer and diffusor architectures, MCC can generate a `do/benchmark` script that measures endpoint performance using the SageMaker AI Benchmarking service (NVIDIA AIPerf). Enable it with `--include-benchmark` during project generation.

See the dedicated [Benchmarking](benchmarking.md) guide for prerequisites, parameter tuning, and interpreting results.

## AWS Marketplace Model Packages

For pre-built models from AWS Marketplace vendors (AI21, Cohere, etc.), MCC generates a thin project with only lifecycle scripts — no Dockerfile, no `code/` directory, no build/push steps.

### How It Works

Marketplace model packages include the vendor's container image and model weights. MCC deploys them using the SageMaker AI `CreateModel` API with `ModelPackageName` instead of a custom ECR image:

```bash
ml-container-creator my-marketplace-model \
  --deployment-config=marketplace \
  --model-name='marketplace://arn:aws:sagemaker:us-east-1:aws:model-package/vendor-model/1' \
  --instance-type=ml.g5.xlarge \
  --region=us-east-1
```

### Generated Project Structure

```
my-marketplace-model/
├── do/
│   ├── config          ← MODEL_PACKAGE_ARN, instance type, region
│   ├── deploy          ← CreateModel(ModelPackageName=ARN) → endpoint
│   ├── test            ← invoke endpoint
│   ├── benchmark       ← benchmark endpoint (same as BYOC)
│   ├── logs            ← CloudWatch logs
│   ├── clean           ← delete model + endpoint
│   ├── status          ← endpoint status
│   └── register        ← register deployment
├── (NO Dockerfile)
├── (NO code/)
├── (NO do/build, do/push, do/submit)
```

### What Doesn't Apply

- No Dockerfile (vendor provides the container)
- No `do/build`, `do/push`, `do/submit` (nothing to build)
- No LoRA adapters (can't modify vendor's model)
- No `do/tune` (can't fine-tune proprietary weights)
- No local testing (no container to run locally)

### What Still Works

- `do/deploy` / `do/test` / `do/clean` lifecycle
- `do/benchmark` (benchmarks the endpoint regardless of who built the container)
- `do/status` / `do/logs` / `do/register`
- Async inference and batch transform (if supported by the model package)

### Prerequisites

1. Subscribe to a model on [AWS Marketplace](https://aws.amazon.com/marketplace/solutions/machine-learning)
2. Note the Model Package ARN from your subscription
3. Ensure your IAM role has permission to deploy the model package
