# Deployment & Inference

MCC supports two deployment targets and two build paths, all managed through standardized `do/` scripts inspired by the [do-framework](https://github.com/iankoulski/do-framework). Generated projects include a `do/` directory with scripts for every stage of the container lifecycle: `build`, `push`, `run`, `test`, `deploy`, `clean`, `logs`, `export`, and optionally `submit` (for CodeBuild).

## Build Paths

### Local Build

Run `./do/build` to create the Docker image and `./do/push` to upload it to Amazon ECR. This two-step approach lets you test locally with `./do/run` before pushing.

Local containers may produce `exec` errors when deployed to a different architecture (e.g., building on ARM, deploying on x86). Use CodeBuild for production builds to avoid this.

`./do/run` starts the container on localhost:8080 for local testing. This works well for predictive ML containers (small images, no GPU dependency). LLM containers are large and typically require GPU resources, so local deployment may not be practical for those.

### AWS CodeBuild

`./do/submit` creates an AWS CodeBuild project that builds the Docker image and pushes it to ECR in a single step. This is the preferred method for production containers, as it avoids architecture mismatches and provides fast network access to base image registries.

## Deployment Targets

MCC supports two deployment targets, selected during project generation via the `--deployment-target` option. The chosen target determines how `./do/deploy`, `./do/test`, `./do/clean`, and `./do/logs` behave.

### SageMaker Managed Inference (`managed-inference`)

The default deployment target. `./do/deploy` provisions resources using the SageMaker Inference Components API:

1. **Create endpoint configuration** -- specifies the instance type and count
2. **Create endpoint** -- provisions the compute infrastructure
3. **Create inference component** -- associates the ECR container image with the endpoint

The inference component model decouples compute provisioning from model deployment, allowing multiple models to share a single endpoint. Once the inference component reaches `InService` status, the endpoint is accessible via the SageMaker Runtime API for real-time inference requests.

The generated `do/config` file stores the `INSTANCE_TYPE` and optionally `INFERENCE_AMI_VERSION` for controlling the CUDA driver version on the instance.

After deployment, `./do/test` validates the endpoint by invoking inference through the inference component, `./do/logs` tails CloudWatch logs, and `./do/clean endpoint` tears down the inference component, endpoint, and endpoint configuration.

Only real-time endpoints are supported at this time.

### SageMaker HyperPod EKS (`hyperpod-eks`)

For existing [SageMaker HyperPod](https://aws.amazon.com/sagemaker/hyperpod/) clusters running on Amazon EKS, MCC can deploy containers directly to Kubernetes:

- `./do/deploy` retrieves the underlying EKS cluster from the HyperPod cluster, configures `kubectl`, and applies Kubernetes manifests (Deployment, Service, ConfigMap, and optionally PVC for FSx storage) to the specified namespace.
- `./do/test hyperpod` port-forwards the Kubernetes service and runs the same `/ping` and `/invocations` health checks used for managed inference.
- `./do/logs` tails pod logs via `kubectl`.
- `./do/clean hyperpod` deletes the Kubernetes resources from the namespace.

The generated `do/config` file stores HyperPod-specific variables: `HYPERPOD_CLUSTER_NAME`, `HYPERPOD_NAMESPACE`, `HYPERPOD_REPLICAS`, and optionally `FSX_VOLUME_HANDLE`.

Prerequisites:

- An existing SageMaker HyperPod cluster with EKS orchestrator
- `kubectl` installed locally
- IAM permissions for `sagemaker:DescribeCluster` and `eks:DescribeCluster`
- Sufficient node capacity (especially GPU nodes for LLM workloads)

## Lifecycle Scripts Reference

All generated projects include these `do/` scripts:

| Command | Description |
|---------|-------------|
| `./do/config` | Centralized configuration for all scripts (sourced, not executed) |
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/run` | Run container locally on port 8080 |
| `./do/test` | Test local container or deployed endpoint |
| `./do/validate` | Validate configuration against AWS service models (requires schema sync) |
| `./do/deploy` | Deploy to the configured deployment target |
| `./do/logs` | Tail logs (CloudWatch for managed-inference, kubectl for HyperPod) |
| `./do/clean <target>` | Clean up resources (local, ecr, endpoint/hyperpod, codebuild, all) |
| `./do/export` | Export current configuration as a reproducible CLI command |
| `./do/register` | Capture deployment to the deployment registry |
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
