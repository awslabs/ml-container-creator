MCC supports two deployment targets and two build paths, all managed through standardized `do/` scripts inspired by the [do-framework](https://github.com/iankoulski/do-framework). Generated projects include a `do/` directory with scripts for every stage of the container lifecycle: `build`, `push`, `run`, `test`, `deploy`, `clean`, `logs`, `export`, and optionally `submit` (for CodeBuild).

## Build Paths

### Local Build
For local builds, users run `./do/build` to create the Docker image and `./do/push` to upload it to Amazon ECR. This two-step approach lets you test locally with `./do/run` before pushing.

### AWS CodeBuild
For CI/CD workflows, `./do/submit` creates an AWS CodeBuild project that builds the Docker image and pushes it to ECR in a single step. This is the preferred method for building containers destined for production endpoints, as it avoids architecture mismatches between local machines and deployment instances.

## Deployment Targets

MCC supports two deployment targets, selected during project generation via the `--deployment-target` option. The chosen target determines how `./do/deploy`, `./do/test`, `./do/clean`, and `./do/logs` behave.

#### Local Deployment
Local endpoints can be deployed once the image has been built. Local deployments are most easily accommodated by users who elect to build the container locally. Otherwise, users will have to download the container image from Amazon ECR to launch it locally.

!!! warning "Local LLM Containers"
    Local deployment should be used sparingly. Predictive containers built on ML frameworks like XGBoost can easily be launched locally given their relatively small size and lack of GPU dependencies. This capability may not work for LLM-based serving frameworks. Images built from SGLang for example are quite large, and require GPU resources to be made available to your container.

#### Amazon SageMaker AI Managed Inference (`managed-inference`)
Amazon SageMaker AI Managed Inference is the default deployment target for MCC containers. When this target is selected, `./do/deploy` provisions resources using the SageMaker Inference Components API:

1. **Create endpoint configuration** -- specifies the instance type and count
2. **Create endpoint** -- provisions the compute infrastructure
3. **Create inference component** -- associates the ECR container image with the endpoint

The inference component model decouples compute provisioning from model deployment, allowing multiple models to share a single endpoint. Once the inference component reaches `InService` status, the endpoint is accessible via the SageMaker Runtime API for real-time inference requests.

Users select their preferred instance type, family, and size when generating an MCC project. The generated `do/config` file stores the `INSTANCE_TYPE` and optionally `INFERENCE_AMI_VERSION` for controlling the CUDA driver version on the instance.

After deployment, `./do/test` validates the endpoint by invoking inference through the inference component, `./do/logs` tails CloudWatch logs, and `./do/clean endpoint` tears down the inference component, endpoint, and endpoint configuration.

!!! info "Real-Time Only"
    At this time, real-time endpoints are the only supported SageMaker AI managed inference endpoints supported by MCC.

#### Amazon SageMaker HyperPod EKS (`hyperpod-eks`)
For users with existing [SageMaker HyperPod](https://aws.amazon.com/sagemaker/hyperpod/) clusters running on Amazon EKS, MCC can deploy containers directly to Kubernetes. When this target is selected:

- `./do/deploy` retrieves the underlying EKS cluster from the HyperPod cluster, configures `kubectl`, and applies Kubernetes manifests (Deployment, Service, ConfigMap, and optionally PVC for FSx storage) to the specified namespace.
- `./do/test hyperpod` port-forwards the Kubernetes service and runs the same `/ping` and `/invocations` health checks used for managed inference.
- `./do/logs` tails pod logs via `kubectl`.
- `./do/clean hyperpod` deletes the Kubernetes resources from the namespace.

The generated `do/config` file stores HyperPod-specific variables: `HYPERPOD_CLUSTER_NAME`, `HYPERPOD_NAMESPACE`, `HYPERPOD_REPLICAS`, and optionally `FSX_VOLUME_HANDLE`.

!!! note "Prerequisites for HyperPod EKS"
    - An existing SageMaker HyperPod cluster with EKS orchestrator
    - `kubectl` installed locally
    - IAM permissions for `sagemaker:DescribeCluster` and `eks:DescribeCluster`
    - Sufficient node capacity (especially GPU nodes for LLM workloads)

## Lifecycle Scripts Reference

All generated projects include these `do/` scripts:

| Command | Description |
|---------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/run` | Run container locally on port 8080 |
| `./do/test` | Test local container or deployed endpoint |
| `./do/deploy` | Deploy to the configured deployment target |
| `./do/logs` | Tail logs (CloudWatch for managed-inference, kubectl for HyperPod) |
| `./do/clean <target>` | Clean up resources (local, ecr, endpoint/hyperpod, codebuild, all) |
| `./do/export` | Export current configuration as a reproducible `yo` CLI command |
| `./do/submit` | Submit build to AWS CodeBuild (CodeBuild build target only) |

Configuration for all scripts is centralized in `do/config`. See the generated `do/README.md` for detailed documentation on each command.