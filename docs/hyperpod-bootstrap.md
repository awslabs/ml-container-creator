# HyperPod Bootstrap Module

The `hyperpod-cluster` bootstrap module provisions a complete SageMaker HyperPod EKS
environment as three CDK stacks deployed in sequence.

## Overview

When you run `bootstrap add-module hyperpod`, the module deploys:

| Stack | CDK Stack Name | What it provisions |
|-------|---------------|-------------------|
| 1. EKS Cluster | `mlcc-<profile>-eks-cluster` | VPC, EKS control plane, IAM roles, dependency add-ons |
| 2. HyperPod Cluster | `mlcc-<profile>-hyperpod-cluster` | SageMaker HyperPod cluster (0-instance) |
| 3. Inference Operator | `mlcc-<profile>-inference-operator` | `amazon-sagemaker-hyperpod-inference` EKS add-on + TLS bucket |

**Estimated creation time:** ~20–35 minutes (EKS cluster ~10 min + HyperPod ~10–20 min)

## Prerequisites

- AWS CLI v2 configured with sufficient permissions
- `kubectl` installed (for post-deploy verification)
- `helm` available (used by ALB controller chart)
- Bootstrap `core` module already provisioned

!!! note "TypeScript build is automatic"
    `npm run build` is now automatically run before every CDK deploy — there is no
    need to manually compile TypeScript before deploying the module.

## Quick Start

```bash
# Add the HyperPod module to an existing bootstrap profile
ml-container-creator bootstrap add-module hyperpod-cluster

# Check status
ml-container-creator bootstrap status

# Generate a project targeting HyperPod
ml-container-creator generate --deployment-target hyperpod-eks

# Deploy (after build + push)
do/build && do/push && do/deploy
```

## Cost

| Component | Monthly Cost |
|-----------|-------------|
| EKS control plane | ~$73 |
| NAT gateway | ~$32 |
| Compute (GPU nodes) | Billed per node-hour when scaled up |
| HyperPod cluster (0-instance) | $0 at rest |

**Total at rest:** ~$105/mo (no compute until you scale up)

## What Gets Provisioned

### Stack 1: EKS Cluster (`MlccEksClusterStack`)

- **VPC**: 2 AZs, public + private subnets, NAT gateway, S3 endpoint
- **EKS Cluster**: K8s 1.31, `API_AND_CONFIG_MAP` auth mode, OIDC provider
- **Fargate Profile**: System pod scheduling (see below)
- **Add-ons**: vpc-cni (≥1.18.3), coredns, kube-proxy, metrics-server, cert-manager, S3 CSI, FSx CSI
- **NVIDIA Device Plugin**: DaemonSet for GPU scheduling
- **AWS Load Balancer Controller**: Helm chart for ALB/NLB ingress
- **IAM Roles** (9 total, all `RETAIN`):
  - EKS cluster role
  - EKS node role
  - HyperPod instance role
  - HyperpodInferenceRole (IRSA)
  - AlbControllerRole (IRSA)
  - KedaOperatorRole (IRSA)
  - S3CsiRole (IRSA)
  - FsxCsiRole (IRSA)
  - Fargate pod execution role

#### HyperPod Instance Role

The HyperPod instance role attached to worker nodes carries **five policies**:

| Policy | Type | Purpose |
|--------|------|---------|
| `AmazonSageMakerClusterInstanceRolePolicy` | Managed | HyperPod cluster instance operations |
| `AmazonEC2ContainerRegistryReadOnly` | Managed | Pull container images from ECR |
| `AmazonEKS_CNI_Policy` | Managed | VPC CNI networking |
| `AmazonEKSWorkerNodePolicy` | Managed | EKS worker node registration |
| `HyperPodEksInstancePolicy` | Inline | ENI management (attach/detach/describe network interfaces) |

The role's **trust policy requires BOTH** `sagemaker.amazonaws.com` **AND** `ec2.amazonaws.com`
as trusted principals — SageMaker assumes it to manage the HyperPod cluster, and EC2 assumes it
for the underlying worker instances.

#### Fargate Profile: Why System Pods Need It

The cluster starts with zero GPU nodes to avoid idle compute costs. But
Kubernetes requires certain system pods to be running before the cluster can
function — creating a chicken-and-egg problem. Fargate solves this by providing
serverless compute for lightweight control-plane workloads.

The Fargate profile covers four namespaces:

| Namespace | Pods | Purpose |
|-----------|------|---------|
| `kube-system` | CoreDNS, metrics-server, VPC-CNI, ALB controller, FSx/MPI operators | Core cluster infrastructure: DNS resolution, pod networking, metrics, storage |
| `cert-manager` | cert-manager, CA injector, webhook | TLS certificate issuance for admission webhooks. Without it, the inference operator's webhooks can't serve. |
| `aws-hyperpod` | HyperPod system agents | HyperPod-managed components for node lifecycle |
| `kubeflow` | Training operators (PyTorchJob, etc.) | Distributed training job orchestration |

!!! note "`hyperpod-inference-system` runs on EC2, not Fargate"
    The `hyperpod-inference-system` namespace is intentionally **not** covered by the Fargate
    profile. The inference gateway controller uses `hostPath` volumes, which Fargate does not
    support — so it must run on HyperPod EC2 nodes instead. See the post-install patches below,
    which pin the gateway controller to HyperPod EC2 nodes via `nodeSelector`.

**Without Fargate**, these pods sit `Pending` indefinitely. And without CoreDNS +
VPC-CNI + cert-manager running, GPU nodes cannot properly register with the cluster
— resulting in a deadlock where nodes never launch.

**Cost**: Fargate charges ~$0.04/vCPU/hr and ~$0.004/GB/hr. These are small pods
(typically 256m–500m CPU, 512MB–1GB RAM). Total system overhead is roughly **$2–4/day**,
far cheaper than keeping a GPU instance running to host control-plane pods.

### Stack 2: HyperPod Cluster (`MlccHyperPodClusterStack`)

- **SageMaker HyperPod Cluster**: Real cluster via `AWS::SageMaker::Cluster`
  - 0-instance (no compute cost)
  - Orchestrator: EKS
  - NodeRecovery: Automatic
  - Scalable via `aws sagemaker update-cluster`

### Stack 3: Inference Operator (`MlccInferenceOperatorStack`)

- **TLS S3 Bucket**: `hyperpod-tls-<profile>-<region>` (RETAIN)
- **Inference Operator EKS Add-on**: `amazon-sagemaker-hyperpod-inference`

#### Post-Install Patches

After the inference operator add-on reaches `ACTIVE`, the bootstrap automatically applies
two patches to make the operator functional on this cluster topology:

1. **`HYPERPOD_CLUSTER_ARN` env var** — patched onto the
   `hyperpod-inference-controller-manager` deployment so the controller knows which HyperPod
   cluster it manages.
2. **`inference-gateway-controller` nodeSelector** — patched so the gateway controller lands
   on HyperPod EC2 nodes (not Fargate). This is required because the gateway controller uses
   `hostPath` volumes that Fargate cannot mount.

!!! important "Inference operator needs an active worker node"
    The inference operator requires **at least 1 active HyperPod worker node** so the CSI driver
    can register before the controller manager can start. A `g5.2xlarge` (or similar GPU
    instance) is recommended — CPU-only nodes like `m5` do **not** satisfy the NVIDIA device
    plugin check, so the operator will not come up on them. Scale up at least one GPU node
    before expecting the operator to reach a healthy state.

## Removal Behavior

### Normal removal (`remove-module hyperpod-cluster`)

Destroys VPC, EKS cluster, and Inference Operator add-on. The following are **retained**:

| Resource | Reason |
|----------|--------|
| IAM roles (8) | May be referenced by external trust policies |
| HyperPod cluster | Slow to create; may have running workloads |
| TLS S3 bucket | Data loss risk; globally unique name |

### Force removal (`remove-module hyperpod-cluster --force-delete`)

Also destroys retained resources. Requires typing the cluster name to confirm.

## Scaling Up

The HyperPod cluster starts at 0 instances. To add compute:

```bash
aws sagemaker update-cluster \
  --cluster-name mlcc-<profile>-hyperpod \
  --instance-groups '[{
    "InstanceGroupName": "default-worker",
    "InstanceType": "ml.g5.2xlarge",
    "InstanceCount": 1,
    "ExecutionRole": "<HyperPodInstanceRoleArn>",
    "LifeCycleConfig": {
      "SourceS3Uri": "s3://mlcc-core-<account>-<region>/hyperpod-lifecycle/",
      "OnCreate": "on_create.sh"
    }
  }]'
```

`ExecutionRole` must be the HyperPod instance role ARN (the five-policy role described above),
`LifeCycleConfig` is required, and the lifecycle S3 URI is
`s3://mlcc-core-<account>-<region>/hyperpod-lifecycle/`.

!!! tip "Use a GPU instance"
    Choose a GPU instance type such as `ml.g5.2xlarge` — the inference operator's NVIDIA device
    plugin check requires GPU nodes, and CPU-only types like `m5` will not satisfy it.

## `do/config` Variables

After provisioning, the module writes these to your project's `do/config`:

| Variable | Source |
|----------|--------|
| `HYPERPOD_CLUSTER_NAME` | HyperPod cluster name (profile-level) |
| `HYPERPOD_EKS_CLUSTER_NAME` | EKS cluster name (profile-level) |
| `HYPERPOD_SUBNET_ID` | First private subnet ID (profile-level) |
| `HP_CLUSTER_NAME` | Written to project `do/config` by `do/deploy` on first deploy |
| `HP_NAMESPACE` | Written to project `do/config` by `do/deploy` on first deploy |
| `ENDPOINT_NAME` | Written to project `do/config` after SageMaker endpoint reaches `InService` |

## Adopt-Existing (Idempotency)

If you have pre-existing infrastructure (e.g., from manual setup), the module
auto-detects it via SSM parameters and adopts instead of recreating:

| Context Flag | What it adopts |
|-------------|---------------|
| `adoptVpc=true` | Uses existing VPC by ID |
| `adoptEks=true` | Uses existing EKS cluster |
| `adoptRoles=true` | References existing IAM roles |
| `adoptCluster=true` | References existing HyperPod cluster |
| `adoptTlsBucket=true` | References existing TLS bucket |

The module runner sets these automatically when it finds SSM parameters from
a prior deployment.

## HyperPod EKS deployment model

HyperPod EKS deployments use the SageMaker HyperPod inference operator's
`InferenceEndpointConfig` custom resource. A single `InferenceEndpointConfig`
replaces the previous raw Deployment, Service, and ConfigMap manifests. When
`do/deploy --target hyperpod-eks` applies the resource, the operator creates the
serving workload and a `SageMakerEndpointRegistration`, which registers a
SageMaker AI endpoint named after the project. This registered endpoint is what
unblocks `do/benchmark`.

## Limitations (Current)

- `do/benchmark` is supported for HyperPod EKS targets: after `do/deploy` records
  `ENDPOINT_NAME`, benchmarks run against the registered SageMaker endpoint
  directly (no inference component)
- `do/optimize` **is** supported for HyperPod EKS targets (see the optimize docs);
  applying a recommendation writes `OPTIMIZE_MODEL_PACKAGE_ARN` to `do/config` and
  redeploys the `InferenceEndpointConfig`
- `do/adapter`, `do/register` not yet supported on the HyperPod path
- Multi-GPU TP/PP configuration is handled by a separate spec (e8-h2)
- Cluster capacity reporting is handled by e8-h3
