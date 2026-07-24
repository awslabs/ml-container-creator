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

#### Fargate Profile: Why System Pods Need It

The cluster starts with zero GPU nodes to avoid idle compute costs. But
Kubernetes requires certain system pods to be running before the cluster can
function — creating a chicken-and-egg problem. Fargate solves this by providing
serverless compute for lightweight control-plane workloads.

The Fargate profile covers five namespaces:

| Namespace | Pods | Purpose |
|-----------|------|---------|
| `kube-system` | CoreDNS, metrics-server, VPC-CNI, ALB controller, FSx/MPI operators | Core cluster infrastructure: DNS resolution, pod networking, metrics, storage |
| `cert-manager` | cert-manager, CA injector, webhook | TLS certificate issuance for admission webhooks. Without it, the inference operator's webhooks can't serve. |
| `aws-hyperpod` | HyperPod system agents | HyperPod-managed components for node lifecycle |
| `hyperpod-inference-system` | Inference controller, ALB ingress, KEDA | The HyperPod inference operator stack: workload routing, event-driven autoscaling, load balancer management |
| `kubeflow` | Training operators (PyTorchJob, etc.) | Distributed training job orchestration |

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
      "SourceS3Uri": "s3://sagemaker-lifecycle-<region>/hyperpod/",
      "OnCreate": "on_create.sh"
    }
  }]'
```

## `do/config` Variables

After provisioning, the module writes these to your project's `do/config`:

| Variable | Source |
|----------|--------|
| `HYPERPOD_CLUSTER_NAME` | HyperPod cluster name |
| `HYPERPOD_EKS_CLUSTER_NAME` | EKS cluster name |
| `HYPERPOD_SUBNET_ID` | First private subnet ID |

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

## Limitations (Current)

- `do/benchmark`, `do/adapter`, `do/register` not yet supported on the HyperPod path
- Multi-GPU TP/PP configuration is handled by a separate spec (e8-h2)
- Cluster capacity reporting is handled by e8-h3
