# Deployment & Inference

MCC supports five deployment targets and two build paths, all managed through standardized `do/` scripts inspired by the [do-framework](https://github.com/iankoulski/do-framework). Every generated project contains scripts for all targets — you select which target to deploy to at deploy time, not at generation time. See [Deploy-time workflow](#deploy-time-workflow) below for the interactive flow and multi-target focus switching.

## Build Paths

### Local Build

Run `./do/build` to create the Docker image and `./do/push` to upload it to Amazon ECR. This two-step approach lets you test locally with `./do/run` before pushing.

Local containers may produce `exec` errors when deployed to a different architecture (e.g., building on ARM, deploying on x86). Use CodeBuild for production builds to avoid this.

`./do/run` starts the container on localhost:8080 for local testing. This works well for predictive ML containers (small images, no GPU dependency). LLM containers are large and typically require GPU resources, so local deployment may not be practical for those.

### AWS CodeBuild

`./do/submit` creates an AWS CodeBuild project that builds the Docker image and pushes it to ECR in a single step. This is the preferred method for production containers, as it avoids architecture mismatches and provides fast network access to base image registries.

## Deployment Targets

MCC supports five deployment targets. Select the active target at deploy time using `./do/deploy --target <mode>`. The active target determines how `./do/test`, `./do/clean`, and `./do/logs` behave.

| Target | Where it runs | Notes |
|---|---|---|
| `realtime-inference` | SageMaker real-time endpoint (Inference Components) | Default |
| `async-inference` | SageMaker async endpoint | Large payloads / long jobs |
| `batch-transform` | SageMaker batch transform job | Offline batch |
| `hyperpod-eks` | EKS via the HyperPod Inference Operator | Registers a SageMaker endpoint |
| `eks` | EKS **without** the HyperPod operator (standard Deployment + Service + ConfigMap) | First-class, **currently untested/unvalidated** |

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

For existing [SageMaker AI HyperPod](https://aws.amazon.com/sagemaker/hyperpod/) clusters running on Amazon EKS, MCC deploys through the SageMaker HyperPod inference operator using an `InferenceEndpointConfig` custom resource (rather than raw Kubernetes manifests):

- `./do/deploy` retrieves the underlying EKS cluster from the HyperPod cluster, configures `kubectl`, and applies a single `InferenceEndpointConfig` custom resource to the specified namespace. The `amazon-sagemaker-hyperpod-inference` operator reconciles it — creating the serving Deployment, Service, pods, and a `SageMakerEndpointRegistration` that registers a SageMaker AI endpoint named after the project. The deploy driver polls the resource's `status.state` until `DeploymentComplete`, then waits for the SageMaker endpoint to reach `InService` (up to 15 minutes) before recording `ENDPOINT_NAME` in `do/config`.
- The model source is derived automatically: a model staged to S3 (`STAGED_MODEL_PATH` in `do/config`) renders `modelSourceConfig.s3Storage` (bucket + region parsed from the staged URI); otherwise the model is pulled from Hugging Face via `MODEL_NAME`, using a `hf-token-secret` Kubernetes Secret when a token is configured.
- `./do/test hyperpod` port-forwards the operator-created Kubernetes service (resolved from the project name) and runs the same `/ping` and `/invocations` health checks used for managed inference.
- `./do/logs` tails serving-pod logs via `kubectl`.
- `./do/benchmark` targets the registered SageMaker endpoint directly (no inference component) once `ENDPOINT_NAME` is set.
- `./do/clean hyperpod` deletes the `InferenceEndpointConfig`, waits for the `SageMakerEndpointRegistration` to be removed, and clears `ENDPOINT_NAME`.

The generated `do/config` file stores HyperPod-specific variables: `HP_CLUSTER_NAME`, `HP_NAMESPACE`, `HP_REPLICAS`, and — after a successful deployment — `ENDPOINT_NAME`.

#### Speculative decoding

Speculative decoding is supported for vLLM and SGLang images on HyperPod EKS. See the dedicated guide: [Speculative Decoding on HyperPod EKS](hyperpod-speculative-decoding.md).

Prerequisites:

- An existing SageMaker AI HyperPod cluster with EKS orchestrator
- The `amazon-sagemaker-hyperpod-inference` EKS add-on installed (via `mcc bootstrap add-module hyperpod-cluster`), which provisions the `hyperpod-inference` service account in the target namespace
- `kubectl` installed locally
- IAM permissions for `sagemaker:DescribeCluster`, `eks:DescribeCluster`, and `sagemaker:DescribeEndpoint`
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

### Plain EKS (`eks`)

Deploys the model to any conformant EKS cluster as **standard Kubernetes objects**
— a Deployment, a Service, and a ConfigMap — **without** the HyperPod Inference
Operator and without any SageMaker endpoint. It works on a plain EKS cluster or a
HyperPod EKS cluster used as plain EKS.

```bash
./do/deploy --target eks
```

!!! warning "Untested target"
    `eks` is a first-class, supported target, but it is **currently untested and
    unvalidated** end-to-end. Treat it as experimental.

Because there is no SageMaker endpoint, verbs that operate on the serving pod
directly work via a `kubectl` port-forward (same mechanism as `hyperpod-eks`):

- **Supported:** `do/deploy`, `do/test eks`, `do/benchmark` (direct pod
  port-forward), `do/adapter` (vLLM LoRA hot-load), `do/logs`, `do/status`,
  `do/clean eks`.
- **Not applicable:** `do/optimize` (SageMaker AI Recommendations need a SageMaker
  endpoint), `do/add-ic` (Inference Components are real-time-only), `do/ci` (the CI
  harness is SageMaker-managed-inference specific). These print a clear message and
  exit with code `3`.

#### Large models and multi-GPU on plain EKS

Unlike `hyperpod-eks`, the plain `eks` target has no operator to mount model
storage, grant the pod an IAM identity, or size shared memory. The pod does these
itself, and for a large or multi-GPU model you must set a few knobs in `do/config`.
These default to safe values for small single-GPU models; set them explicitly when
a model does not fit the defaults. All are optional overrides — nothing is
hardcoded per model.

| `do/config` var | Purpose | Default |
|---|---|---|
| `EKS_INFERENCE_ROLE_ARN` | IAM role ARN the pod's ServiceAccount is annotated with (IRSA), so `code/serve` can `aws s3 sync` an S3-staged model. Required when `MODEL_SOURCE=s3`. | — (SA annotated only if set) |
| `HP_MODEL_HOSTPATH` | Base path of a pre-mounted node-local NVMe volume (e.g. the DLAMI instance-store at `/opt/dlami/nvme`). When set, the model volume is a `hostPath` at `<base>/<project>` instead of an `emptyDir` on the node root. Use for models too large for the node's EBS root (the driver otherwise evicts the pod under DiskPressure). | unset → bounded `emptyDir` on node root |
| `HP_EPHEMERAL_STORAGE` | `ephemeral-storage` request/limit for the `emptyDir` model path (ignored on the `hostPath` path, which does not draw from it). | `HP_GPU_COUNT × 20Gi` |
| `HP_SHM_SIZE` | Size of the RAM-backed `/dev/shm` the Deployment mounts for NCCL. Multi-GPU tensor-parallel models need more than the Kubernetes default of 64Mi, or NCCL fails to initialize. | `HP_GPU_COUNT × 8Gi` |

The serving container reads its model from `/opt/ml/model` regardless of which
volume backs it, and derives tensor-parallel degree from `HP_GPU_COUNT`
(overridable per engine, e.g. `VLLM_TENSOR_PARALLEL_SIZE`).

!!! note "Engine-specific pass-through"
    Arbitrary engine flags are set via the engine's env-var prefix in `do/config`
    (e.g. `SGLANG_MEM_FRACTION_STATIC`, `SGLANG_TRUST_REMOTE_CODE`) and forwarded to
    the server verbatim (ADR-010 Tier-2 pass-through). Note: `mcc regenerate`
    currently preserves only the vars it knows about — re-add any hand-set
    `<PREFIX>*` engine knobs after a regenerate.

## Deploy-time workflow

Deployment configuration is chosen at deploy time, not at generation time. On the first `./do/deploy` for a freshly generated project (empty `DEPLOYMENT_TARGET`), the script runs a short interactive prompt flow with fresh recommendations from the instance-sizer and cluster-picker MCP servers:

```
$ ./do/deploy

? Select deployment target:
  ❯ realtime-inference  — SageMaker real-time endpoint (IC)
    async-inference     — SageMaker async endpoint (S3 I/O)
    batch-transform     — SageMaker batch transform job
    hyperpod-eks        — HyperPod EKS cluster
    eks                 — plain EKS (no operator)

? Select instance type: (recommended: ml.g5.4xlarge — fits Llama-3.1-8B)
  ❯ ml.g5.4xlarge  ★ recommended
    ml.g5.12xlarge
    Enter manually...
```

Answers are persisted to `do/config` immediately after you confirm, so a failed deploy can be re-run without re-prompting. If MCP servers are unreachable, the prompts fall back to manual text input with a warning.

**Repeat deploys** skip the prompts once `DEPLOYMENT_TARGET` and its required vars are populated. **Non-interactive (CI/CD)** runs pass the equivalent flags; if all required flags for a target are present, deploy proceeds without prompting:

```bash
./do/deploy --target realtime-inference --instance-type ml.g5.4xlarge
./do/deploy --target batch-transform \
  --instance-type ml.m5.4xlarge \
  --batch-input-path s3://bucket/input/ \
  --batch-output-path s3://bucket/output/
./do/deploy --target realtime-inference --instance-type ml.g5.4xlarge --dry-run   # preview only
```

With `--skip-prompts` at generation time, `do/config` is pre-populated with sensible defaults (`DEPLOYMENT_TARGET=realtime-inference`, and `INSTANCE_TYPE` auto-sized from the model's parameter count), producing a deployable project with no interactive input.

### Multi-target deployments and focus switching

A single project can hold active deployments on multiple targets at once. `DEPLOYMENT_TARGET` in `do/config` marks the **active** one — the target that `do/test`, `do/logs`, and `do/benchmark` route to.

- **Deploy to a second target:** `./do/deploy --target hyperpod-eks` creates a new deployment alongside the existing one.
- **Switch focus:** if a deployment already exists for the requested target, `./do/deploy --target <mode>` switches focus without redeploying — handy for benchmarking the same model on, say, `realtime-inference` vs. `hyperpod-eks`.
- **View all target states:** `./do/deploy --status` prints each target's status; `do/config` tracks per-target state in `DEPLOYMENT_TARGET_*_STATUS` vars.

## Lifecycle Scripts Reference

All generated projects include these `do/` scripts:

| Command | Description |
|---------|-------------|
| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
| `./do/run` | Run container locally on port 8080 |
| `./do/test` | Test local container or deployed endpoint |
| `./do/validate` | Validate configuration against AWS service models (requires schema sync) |
| `./do/deploy` | Deploy to the configured deployment target. Flags: `--optimize` (run `do/benchmark --recommend --apply` before deploying), `--no-optimize` (skip optimization), `--force-ic` (force new IC even if one exists), `--dry-run` (validate only) |
| `./do/tune` | Fine-tune using SageMaker AI Managed Model Customization (serverless) |
| `./do/train` | Custom training jobs with your own scripts and hyperparameters |
| `./do/adapter` | LoRA adapter lifecycle (add, list, remove, update) |
| `./do/add-ic` | Add an inference component to an existing endpoint |
| `./do/benchmark` | Run latency and throughput benchmarks via SageMaker AI Benchmarking |
| `./do/status` | Check endpoint and inference component status |
| `./do/logs` | Tail logs (CloudWatch for SageMaker targets, kubectl for hyperpod-eks / eks) |
| `./do/clean <target>` | Clean up resources (local, ecr, endpoint/hyperpod, codebuild, all) |
| `./do/config` | Centralized configuration for all scripts (sourced, not executed) |
| `./do/export` | Export the project: a reproduce-it CLI command (default), config JSON (`--json`), or a runnable Jupyter deploy notebook (`--notebook`) |
| `./do/register` | Register the model/adapters to the SageMaker Model Package Group |
| `./do/ci` | CI pipeline integration (report, status, trigger, dashboard) |
| `./do/submit` | Submit build to AWS CodeBuild (CodeBuild build target only) |
| `./do/draft` | Configure speculative decoding for an active deployment (hyperpod-eks) |

See the generated `do/README.md` for detailed documentation on each command.

### Exporting the project (`do/export`)

`do/export` turns the project's `do/config` into a portable artifact. It has three
modes; they read the effective deployment target from `do/config`, or you can
override it for one run with `--target <mode>`.

| Mode | Command | Output |
|---|---|---|
| Default | `./do/export` | Prints the `ml-container-creator …` CLI command that reproduces this project. |
| JSON | `./do/export --json` | Prints the configuration as JSON (camelCase keys), ready to feed back in via `ml-container-creator --config=<file>`. |
| Notebook | `./do/export --notebook` | Writes `deploy_notebook.ipynb` — a runnable, step-by-step Jupyter notebook that builds, deploys, tests, and tears down the endpoint. |

`--notebook` and `--json` are mutually exclusive.

#### The deploy notebook (`--notebook`)

The generated notebook walks the full lifecycle in order — install deps, build &
push the container (or resolve a DLC image for LMI/DJL), then a deploy + test +
cleanup section tailored to the deployment target:

| Target | Deploy path in the notebook |
|---|---|
| `realtime-inference` | `boto3` create endpoint + inference component; invoke via `smr_client.invoke_endpoint`. Includes optional LoRA-adapter and managed fine-tuning sections when the project enables them. |
| `async-inference` | `boto3` endpoint with `AsyncInferenceConfig`; upload input to S3, `invoke_endpoint_async`, poll S3 for the result. |
| `batch-transform` | `boto3` `create_transform_job`; poll to completion and download output from S3. |
| `hyperpod-eks` | `kubectl apply` of an `InferenceEndpointConfig` custom resource (the SageMaker HyperPod inference operator); poll the CRD to `DeploymentComplete` and the registered SageMaker endpoint to `InService`; test via `kubectl port-forward` to the serving pod. |

Secrets are never baked into the notebook: when the project uses `HF_TOKEN_ARN`
or `NGC_API_KEY_ARN`, the notebook resolves them from AWS Secrets Manager at
runtime; when it uses a plain token, the notebook reads it from an environment
variable you set before running the cell.

The notebook is generated for every supported deployment target. (The removed
`marketplace` config built no container and had no notebook — see
[AWS Marketplace Model Packages (removed)](#aws-marketplace-model-packages-removed)
below.) Open it in SageMaker Studio or any Jupyter
environment with AWS credentials configured. The `hyperpod-eks` notebook also
needs local `kubectl` and the HyperPod inference operator installed on the
cluster — the same prerequisites as `./do/deploy` for that target.

### Reading exit codes

Every `do/` script uses a consistent exit-code convention, so you (and CI) can
tell *why* a command stopped:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error (including missing AWS credentials) |
| `2` | Usage / argument error |
| `3` | **Not supported for this deployment target** — the command doesn't apply to your current `DEPLOYMENT_TARGET`, or a required deployment/precondition isn't in place. The message names the supported targets. |

Exit `3` is not a failure of the operation — it means the command couldn't start
because a precondition (a live deployment, or a compatible target) wasn't met.
For the full contract behind these codes, see the developer guide:
[do/ Script Contracts](do-script-contract.md).

### Pre-Deploy Validation

Run `./do/validate` before deploying to catch configuration issues that would cause AWS API failures:

```bash
./do/validate                # Text output, exit 1 on errors
./do/validate --format=json  # JSON output for CI pipelines
./do/validate --smart        # Include smart-mode advisory findings
```

This validates your `do/config` values against the AWS service model, checking enum constraints, type correctness, required fields, and cross-cutting consistency (GPU counts, tensor parallelism, CUDA compatibility). See [Configuration — Schema-Driven Validation](configuration.md#schema-driven-validation) for setup instructions.

The `./do/deploy --dry-run` flag also runs schema validation as part of its pre-flight checks and blocks deployment if errors are found.

### Pre-Deploy Optimization

!!! tip "Pre-deploy optimization"
    `do/deploy --optimize` runs `do/benchmark --recommend --apply` before deploying, writing any Athena-proven serving-config improvements to `do/ic/default.conf`. Non-fatal — if no benchmark history exists or Athena is unavailable, deploy proceeds with the existing config.

    ```bash
    # Apply proven config improvements, then deploy
    ./do/deploy --optimize

    # Explicit opt-out (e.g., for pinned configs in CI)
    ./do/deploy --no-optimize
    ```

    !!! note "Already-live endpoints"
        If the endpoint is already `InService`, `do/deploy` prints "Deployment is already live. Nothing to do." even after optimization runs. To apply the updated config to a running endpoint, force a new inference component:
        ```bash
        ./do/deploy --optimize --force-ic
        ```
        Or use the explicit workflow: `do/benchmark --recommend --apply` → `do/clean endpoint` → `do/deploy`

    For hardware recommendations (which instance type to use), see [`do/optimize`](optimize.md).

## Benchmarking

For transformer and diffusor architectures, MCC generates a `do/benchmark` script by default that measures endpoint performance using the SageMaker AI Benchmarking service (NVIDIA AIPerf). Disable with `--include-benchmark=false` during project generation.

See the dedicated [Benchmarking](benchmarking.md) guide for prerequisites, parameter tuning, and interpreting results.

## AWS Marketplace Model Packages (removed)

!!! warning "Marketplace deployments are no longer supported"
    Deploying a pre-built AWS Marketplace model package never built a container,
    which conflicts with this tool's core purpose: bring your own container. The
    `marketplace` deployment config has been removed — both
    `--deployment-config=marketplace` and the `marketplace://` model-name prefix
    are now refused with a non-zero exit.

    To serve a model, build and deploy your own image using a HuggingFace model
    ID, an `s3://` artifact, or a `registry://` model package. See the deployment
    configs above.
