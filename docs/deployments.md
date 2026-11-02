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
| `eks` | EKS **without** the HyperPod operator (standard Deployment + Service + ConfigMap) | Bring-your-own cluster; MLCC validates a deploy-time contract |

### SageMaker AI Real-Time Inference (`realtime-inference`)

The default deployment target. `./do/deploy` provisions resources using the SageMaker AI Inference Components API:

1. **Create endpoint configuration** -- specifies the instance type and count
2. **Create endpoint** -- provisions the compute infrastructure
3. **Create inference component** -- associates the ECR container image with the endpoint

The inference component model decouples compute provisioning from model deployment, allowing multiple models to share a single endpoint. Once the inference component reaches `InService` status, the endpoint is accessible via the SageMaker AI Runtime API for real-time inference requests.

The generated `do/config` file stores the `INSTANCE_TYPE` and optionally `INFERENCE_AMI_VERSION` for controlling the CUDA driver version on the instance.

After deployment, `./do/test` validates the endpoint by invoking inference through the inference component, `./do/logs` tails CloudWatch logs, and `./do/clean endpoint` tears down the inference component, endpoint, and endpoint configuration.

Real-time endpoints can opt in to scaling to zero instances when idle (`./do/deploy --scale-to-zero on`); requests fail while it wakes. See [Scale-to-Zero](scale-to-zero.md).
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

#### Serving a full fine-tune next to the base (`do/add-pod`)

`./do/add-pod <name> --from-tune|--from-train|--from-weights s3://...|--from-registry <arn>`
serves a **full** fine-tuned model as a second `InferenceEndpointConfig` named
`<project>-<name>` (and a SageMaker endpoint of the same name), rendered from the project's own
IEC template. A LoRA adapter is refused here; use `do/adapter`.

- The weights must live under `models/mlcc-<project>/<name>/` in the core bucket; other sources
  are promoted there first.
- Its pods are labeled `app: <project>-<name>`, `mlcc.aws/project-name` and
  `mlcc.aws/role: add-pod`, never `app: <project>`, so the base deployment's selectors don't see
  them.
- Before applying, it runs the read-only cluster contract (`free-gpus`, `local-queue`,
  `s3-csi-role`) and right-sizing against the fine-tune's own `config.json`.
  `--instance-group <g>` pins it with `nodeAffinity`; `--surge-node` adds one node when no node
  has room (billed; the node stays while the pod runs).
- `./do/add-pod --list`, `--status <name>` and `--remove <name>` manage it; state lives in
  `do/pods/<name>.conf`. `./do/clean` also deletes every add-pod IEC (and the project's MLCC
  HyperPodPyTorchJobs), by label.

On plain `eks`, a full model has no additive verb yet (planned post-2.0); the refusal says so.

#### Speculative decoding

Speculative decoding is supported for vLLM and SGLang images on HyperPod EKS. See the dedicated guide: [Speculative Decoding on HyperPod EKS](hyperpod-speculative-decoding.md).

Prerequisites:

- An existing SageMaker AI HyperPod cluster with EKS orchestrator, **provisioned via the AWS
  SageMaker console (Quick Install) or the published CloudFormation templates.** (MLCC's
  `bootstrap add-module hyperpod` provisioning is **deprecated** — it does not enable inference
  at cluster-creation time, so endpoints never get created. See
  [HyperPod Bootstrap](hyperpod-bootstrap.md). The `hyperpod-eks` deploy target below is
  unaffected and works against a correctly-provisioned cluster.)
- The `amazon-sagemaker-hyperpod-inference` EKS add-on installed on that cluster (the console
  Quick Install / CFT installs it), which provisions the `hyperpod-inference` service account in the target namespace
- `kubectl` installed locally
- IAM permissions for `sagemaker:DescribeCluster`, `eks:DescribeCluster`, and `sagemaker:DescribeEndpoint`
- Sufficient node capacity (especially GPU nodes for LLM workloads)

### Async Inference (`async-inference`)

For workloads with large payloads or long processing times (> 60s). `./do/deploy` creates an async endpoint with an S3 output location:

- Requests are submitted and return immediately with an output location
- Results are written to S3 when processing completes
- Optional SNS notifications on success/failure
- Scale-to-zero is not available for async endpoints in v2; the endpoint keeps its instance count until you clean it up. See [Scale-to-Zero](scale-to-zero.md).

```bash
./do/deploy --target async-inference --async-output-path s3://my-bucket/async-output/
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

!!! note "Bring-your-own cluster"
    `eks` consumes a cluster you already provisioned — MLCC does not create it.
    Before applying anything, `./do/deploy --target eks` validates a deploy-time
    contract (pod identity, the CSI driver, and the volume backing a mount) and
    fails fast with a clear remediation when the cluster does not satisfy it. See
    the [vanilla-EKS cluster contract](#vanilla-eks-cluster-contract) below.

Because there is no SageMaker endpoint, verbs that operate on the serving pod
directly work via a `kubectl` port-forward (same mechanism as `hyperpod-eks`):

- **Supported:** `do/deploy`, `do/test eks`, `do/benchmark` (local AIPerf via pod
  port-forward — see below), `do/adapter` (vLLM LoRA hot-load), `do/logs`,
  `do/status`, `do/clean eks`.
- **Not applicable:** `do/optimize` (SageMaker AI Recommendations need a SageMaker
  endpoint), `do/add-ic` (Inference Components are real-time-only), `do/ci` (the CI
  harness is SageMaker-managed-inference specific). These print a clear message and
  exit with code `3`.

#### Benchmarking plain EKS (local AIPerf)

`do/benchmark` on `eks` has the SAME capability as the SageMaker-endpoint targets
(`realtime-inference` / `hyperpod-eks`) — workload profiles, the concurrency
sweep, BYOD datasets, TTFT/ITL/throughput, and the same Athena persistence. Since
`eks` has no SageMaker endpoint to drive the managed benchmarking service, it runs
the SAME tool that service runs — NVIDIA **AIPerf** — **locally** against the
port-forwarded pod and emits the same per-request `profile_export.jsonl` the rest
of the pipeline consumes. This works against the wrapper engines (vLLM / SGLang /
TensorRT-LLM), whose pods serve the OpenAI `/v1/chat/completions` route AIPerf
drives.

- **Prerequisite:** install AIPerf into the active Python env the `do/` scripts
  use: `pip install aiperf`. If it is missing, `do/benchmark` **fails loud** with
  install guidance rather than silently degrading.
- **Same flags as the other targets:** `./do/benchmark --workload <name>` selects a
  profile from the workload catalog; `--dataset <name>[@ver]` replays a registered
  dataset (resolved, downloaded client-side, and replayed as `--input-file`);
  `BENCHMARK_CONCURRENCY_LEVELS` runs the multi-level sweep (one row per level). The
  serving port is derived from the engine manifest (`serve.d/<engine>/manifest.json`),
  not hardcoded.
- **Same Athena table:** results are written through the shared `.benchmark_writer.py`
  with `deployment_target=eks`, so they land in the SAME benchmark results table and
  the read-only analytics verbs — `--compare-baseline`, `--peak`, `--list` — operate
  on eks runs identically. `--recommend` shows recommendations, but `--recommend
  --apply` is **not** supported on eks (it would write `do/ic/default.conf`, a
  realtime-inference Inference-Component artifact that does not apply to a plain-EKS
  Deployment); it degrades with a clear message.
- **GPU/engine metrics (opt-in):** set `HP_BENCHMARK_METRICS_ENABLED=true` to scrape
  the engine's `/metrics` during the run and merge the GPU-efficiency columns into
  the Athena record (same Phase-2 poller as `hyperpod-eks`, resolved via `aws eks
  update-kubeconfig` for a plain-EKS cluster).

```bash
# install the local load generator once
pip install aiperf
# a multi-level sweep with a named workload, GPU metrics on
HP_BENCHMARK_METRICS_ENABLED=true ./do/benchmark --workload multi-turn-chat
# a BYOD replay
./do/benchmark --dataset my-traffic@v2
# read-only analytics (Athena)
./do/benchmark --list
```

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
| `EKS_MODEL_MOUNT` | Select a CSI mount for the model volume: `s3` (read-only stream from the staged S3 prefix via the Mountpoint-S3 CSI driver — no local download), `ebs`, or `fsx` (download the model onto a larger CSI volume). Emits a namespaced PVC; the backing PV/StorageClass is cluster-provided (see the contract above). Wrapper engines only (vLLM/SGLang/TensorRT-LLM). | unset → emptyDir/hostPath path |
| `EKS_STORAGE_CLASS` | StorageClass the `ebs`/`fsx` PVC references (ignored for `s3`, which binds a static PV). | cluster default StorageClass |
| `HP_EPHEMERAL_STORAGE` | `ephemeral-storage` request/limit for the `emptyDir` model path (ignored on the `hostPath` and CSI-mount paths, which do not draw from it). Also the PVC size request on the `ebs`/`fsx` path. | `HP_GPU_COUNT × 20Gi` |
| `HP_SHM_SIZE` | Size of the RAM-backed `/dev/shm` the Deployment mounts for NCCL. Multi-GPU tensor-parallel models need more than the Kubernetes default of 64Mi, or NCCL fails to initialize. | `HP_GPU_COUNT × 8Gi` |

The four storage modes are mutually exclusive, selected by one precedence:
`HP_MODEL_HOSTPATH` (hostPath NVMe) > `EKS_MODEL_MOUNT` (`s3` stream / `ebs`·`fsx`
PVC) > the default bounded `emptyDir` on the node root. The serving container
reads its model from `/opt/ml/model` regardless of which volume backs it, and
derives tensor-parallel degree from `HP_GPU_COUNT` (overridable per engine, e.g.
`VLLM_TENSOR_PARALLEL_SIZE`).

Before applying anything, `do/deploy --target eks` also runs a deploy-time
**ephemeral-storage fail-fast** on the default `emptyDir` path: if the largest
GPU node's allocatable root volume cannot fit the model footprint
(`HP_EPHEMERAL_STORAGE`, else `HP_GPU_COUNT × 20Gi`), it fails fast (exit `4`)
with the remediations above, instead of letting the pod schedule and then hit a
silent kubelet eviction loop. An unreadable node list warns and proceeds.

!!! note "Engine-specific pass-through"
    Arbitrary engine flags are set via the engine's env-var prefix in `do/config`
    (e.g. `SGLANG_MEM_FRACTION_STATIC`, `SGLANG_TRUST_REMOTE_CODE`) and forwarded to
    the server verbatim (ADR-010 Tier-2 pass-through). `mcc regenerate` preserves any
    var that starts with a serve engine's prefix (`VLLM_`, `SGLANG_`, …), so hand-set
    advanced engine knobs survive a regenerate — the one exception is the
    speculative-decoding components (reassembled from the `HP_SPECULATIVE_*` vars,
    which are themselves preserved).

#### Vanilla-EKS cluster contract

The plain `eks` target follows a **consume-don't-provision** posture
([ADR-012](adr/ADR-012-consume-dont-provision-clusters.md)): MLCC deploys its own
workload objects (the Deployment, Service, ConfigMap, and the namespaced
`mlcc-eks-inference-sa` ServiceAccount) but it does **not** provision cluster
infrastructure. Instead, before applying anything, `do/deploy --target eks` runs a
read-only **cluster-contract preflight** that detects + validates the
cluster-provided capabilities this deploy needs and **fails fast** (exit code `4`)
with a remediation when one is missing. A bring-your-own (BYO) cluster that
satisfies the contract is a first-class path; the optional `eks` bootstrap module
is convenience, not a requirement.

The preflight checks these Contract Elements. Each is conditional — it only runs
when the deploy actually needs it:

| Contract Element | When it applies | Cluster must provide | If missing |
|---|---|---|---|
| **Pod identity** | `MODEL_SOURCE=s3` (an S3-staged model — the pod downloads it) | A resolvable inference role (`EKS_INFERENCE_ROLE_ARN`) **and** pod identity via **either** IRSA (an associated IAM OIDC provider) **or** EKS Pod Identity (the agent add-on + an association for `mlcc-eks-inference-sa`) | Fail fast with the `eksctl`/OIDC/Pod-Identity remediation |
| **CSI driver** | `EKS_MODEL_MOUNT` is set (`s3`/`ebs`/`fsx`) | The matching CSI driver installed: `s3.csi.aws.com`, `ebs.csi.aws.com`, or `fsx.csi.aws.com` | Fail fast naming the driver + its add-on/Helm install |
| **Volume backing** | `EKS_MODEL_MOUNT` is set | The volume the namespaced PVC binds: for `s3`, a **static `PersistentVolume`** on `s3.csi.aws.com` whose bucket + prefix match the staged path; for `ebs`/`fsx`, the target `StorageClass` (`EKS_STORAGE_CLASS`, else the cluster default) | Fail fast with a "pre-create this PV/StorageClass" remediation |

MLCC emits **only the namespaced PVC** for a mount, never the cluster-scoped PV or
StorageClass — those are infrastructure the cluster provides. An S3 static PV is
specific to one bucket + prefix, so a BYO operator pre-creates one per staged
dataset. The preflight is strictly read-only (`describe`/`get`/`list`); the only
write a plain-EKS deploy performs is its own ServiceAccount.

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
| `./do/validate` | Target-aware pre-deploy checks: right-sizing (GPU memory fit), config consistency, the cluster contract on `hyperpod-eks` / `eks`, and SageMaker payload shapes on SageMaker targets (after `bootstrap sync-schemas`) |
| `./do/deploy` | Deploy to the configured deployment target. Flags: `--optimize` (run `do/benchmark --recommend --apply` before deploying), `--no-optimize` (skip optimization), `--force-ic` (force new IC even if one exists), `--force` (redeploy an already-deployed target), `--ignore-sizing` (proceed past a right-sizing block), `--dry-run` (resolved config + right-sizing preflight only; creates nothing) |
| `./do/tune` | Fine-tune using SageMaker AI Managed Model Customization (serverless) |
| `./do/train` | Custom training jobs with your own scripts and hyperparameters |
| `./do/adapter` | LoRA adapter lifecycle (add, list, remove, update) |
| `./do/add-ic` | Add an inference component to an existing endpoint |
| `./do/benchmark` | Run latency and throughput benchmarks via SageMaker AI Benchmarking |
| `./do/status` | Check endpoint and inference component status (IC copies as current/desired, plus a one-line pointer to the native metrics dashboard) |
| `./do/metrics` | Serving-metrics readout over the last N minutes (`--window`, default 15): server-side TTFT / e2e p50/p99, queue, KV cache, GPU util, per-copy concurrency; skip notice on targets without a metrics store. See [Benchmarking](benchmarking.md#gpu-engine-metrics) |
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
| Default | `./do/export` | Prints the `ml-container-creator …` CLI command that reproduces this project (values shell-quoted). |
| JSON | `./do/export --json` | Prints the canonical generator `--config` object, ready to feed back in via `ml-container-creator --config=<file> --skip-prompts`. |
| Notebook | `./do/export --notebook` | Writes `deploy_notebook.ipynb` — a runnable, step-by-step Jupyter notebook that builds, deploys, tests, and tears down the endpoint. |

`--notebook` and `--json` are mutually exclusive. `./do/export --help` lists the options.

How the CLI and JSON modes work:

- `do/config` is read at **run time**, so edits made after generation are exported.
- Each `do/config` variable maps to exactly one generator parameter through the
  `doConfigVar` field in `config/parameter-schema-v2.json`; the JSON keys are the
  schema parameter keys (`region`, `hyperpodCluster`, `asyncMaxConcurrent`,
  `modelEnv`, …) and values are typed (numbers, booleans, `KEY=VALUE` maps). The CLI
  command is rendered from the same data, using each parameter's `cliFlag`.
- Only parameters that apply to the effective target (the schema's
  `appliesTo.deploymentTargets`) and differ from their default are emitted.
- Secrets (`HF_TOKEN`, `NGC_API_KEY`) are emitted as `$HF_TOKEN` / `$NGC_API_KEY`
  references, never values. Runtime-owned state (deploy status, endpoint names,
  speculative-decoding settings, benchmark job state) and derived values are not
  exported. Profile-resolved values (role ARN, secret ARNs, async/batch S3 paths)
  come from your bootstrap profile, not the export.
- The CLI and JSON modes are stdlib Python and need no project venv.

> **Upgrade note (Wave 8).** `do/export --json` now writes the `--config` parameter
> names. Earlier versions wrote internal template names that `--config` silently
> dropped: `awsRegion` → `region`, `awsRoleArn` → `roleArn`, `hyperPodCluster` /
> `hyperPodNamespace` / `hyperPodReplicas` → `hyperpodCluster` / `hyperpodNamespace` /
> `hyperpodReplicas`, `asyncMaxConcurrentInvocations` → `asyncMaxConcurrent`,
> `batchMaxConcurrentTransforms` → `batchMaxConcurrent`, `batchMaxPayloadInMB` →
> `batchMaxPayload`, and the nested `endpointConfig` / `icConfig` / `modelEnvVars` /
> `serverEnvVars` objects → flat `endpoint*` / `ic*` keys and `modelEnv` / `serverEnv`
> / `icEnv` maps. Scripts that parse the old keys must switch to the new names.
> `--config` files written with the old keys still load (the loader accepts both).

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
| `5` | `do/deploy` only: deployed, but the opt-in [scale-to-zero](scale-to-zero.md) setup failed and was rolled back. The endpoint is up at a fixed floor. |

Exit `3` is not a failure of the operation — it means the command couldn't start
because a precondition (a live deployment, or a compatible target) wasn't met.
For the full contract behind these codes, see the developer guide:
[do/ Script Contracts](do-script-contract.md).

### Pre-Deploy Validation

Run `./do/validate` before deploying. It reads the configured `DEPLOYMENT_TARGET`
and runs every check that applies to it (derived from the target's descriptor in
`do/targets.d/`), then prints one report:

| Section | Targets | What it checks |
|---|---|---|
| Right-sizing | all | KV cache + weights (+ LoRA buffer, draft model) vs GPU memory, context limit, TP vs GPUs and heads, dtype vs GPU architecture, LoRA rank, IC packing, disk, Service Quota. See [Right-Sizing Checks](architecture/right-sizing.md). |
| Config consistency | all | required `do/config` settings for the target (an empty one warns: `do/deploy` prompts for it), `do/ic/*.conf` values |
| Cluster contract | `hyperpod-eks`, `eks` | the same read-only cluster checks the deploy driver runs (CSI driver, pod identity, storage backing). Needs kubectl access to the cluster; skipped with the reason otherwise. |
| SageMaker payloads | `realtime-inference`, `async-inference`, `batch-transform` | request shapes against the AWS service models. Skipped (not an error) until you run `ml-container-creator bootstrap sync-schemas`. |

```bash
./do/validate                # Text report
./do/validate --format json  # JSON report for CI (--format=json also works)
./do/validate --smart        # Include smart-mode advisory findings (live AWS lookups)
./do/validate --offline      # Skip network-only checks (Service Quota lookup)
```

Exit codes: `0` no errors, `1` errors (including a right-sizing block or a
cluster-contract miss), `2` could not run (no `DEPLOYMENT_TARGET`, unknown target).

#### Right-sizing preflight in `do/deploy`

`./do/deploy` runs the same right-sizing checks before it creates or applies
anything. When the configuration clearly cannot fit (for example a 131,072-token
context whose KV cache plus weights exceed GPU memory), the deploy stops in
seconds with the numbers and a computed fix, instead of failing a health check
many minutes later:

```
❌ [context-memory] max_model_len 131,072 needs ~32.9 GiB ... usable 28.8 GiB ... — over usable memory.
   Fix: set VLLM_MAX_MODEL_LEN=63488 or lower ...; use <larger instance> for 131,072 tokens
```

To proceed anyway, pass `--ignore-sizing` (a warning line is printed). It also
overrides the LoRA rank / buffer refusal in the `eks` and `hyperpod-eks` drivers.
`--force` does not bypass right-sizing; it only redeploys a target that is already
deployed.

To run only the preflight (nothing is created, applied, or dispatched), use
`--dry-run`. It prints the resolved configuration, then the same right-sizing
findings a real deploy would print, and exits 1 on a block (0 with
`--ignore-sizing`) or 0 when the configuration fits or only warns. After changing
the generator or a serving setting, this is the repeatable check:
```bash
mcc regenerate                       # re-render do/ from the current generator
./do/deploy --dry-run                # preflight-only: exit 0 fits/warn, 1 block
./do/deploy --dry-run --ignore-sizing  # see the full output even when it blocks
```
`--dry-run` also works on a project that is already deployed. With or without
`--target` or `--force`, it previews the saved configuration and runs the preflight,
without switching focus or re-prompting.

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
