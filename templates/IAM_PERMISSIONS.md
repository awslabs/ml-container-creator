# IAM Permissions — <%= projectName %>

## Overview

This project uses three sets of IAM permissions:

1. **SageMaker Execution Role** — created automatically by `bootstrap` via CloudFormation
2. **CodeBuild Service Role** — created automatically by `./do/submit`
3. **User/CI Permissions** — your AWS user or CI system needs these to run the do-scripts

## SageMaker Execution Role

The bootstrap command creates an IAM role (`mlcc-sagemaker-execution-role`) with these permission groups:

### Endpoint Management
Create, update, delete, describe, and invoke endpoints, endpoint configs, models, and inference components.

### AI Benchmarking
Create, describe, list, stop, and delete AI benchmark jobs, AI recommendation jobs, and AI workload configs.

### Training & Model Customization
Create/describe/stop training jobs, model packages, model package groups. Access SageMaker Hub contents. Manage training plans.

### MLflow Integration
List/describe MLflow tracking servers and apps. Create presigned URLs. Call MLflow app APIs.

### ECR
Pull container images (GetAuthorizationToken, BatchGetImage, GetDownloadUrlForLayer, BatchCheckLayerAvailability).

### S3
Read and write model artifacts, adapters, benchmark results:
- `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListBucket`
- Scoped to `mlcc-*` and `ml-container-creator-*` buckets

### CloudWatch Logs
Create log groups/streams and put log events.

### Secrets Manager
Read and write secrets prefixed with `mlcc/` or `ml-container-creator/` (used for HF tokens, API keys); read `mlcc-hf-token-*`. `kms:Decrypt` through Secrets Manager for those secrets when they use a customer-managed key.
The serving container resolves `HF_TOKEN_ARN` / `NGC_API_KEY_ARN` at startup **as this role**. `do/deploy` passes only the ARN, never the value, so the token does not appear in SageMaker Describe* output or CloudTrail.

### SNS
Publish notifications to `mlcc-*` and `ml-container-creator-*` topics (benchmark completion alerts).

### Service Quotas & Capacity
Query service quotas and training plan availability for instance selection.

### Lambda
Invoke functions (reward model evaluation during training/tuning).

### PassRole
Self-pass to SageMaker service, scoped to `mlcc-sagemaker-execution-role`.

The role is defined in the core bootstrap stack (`infra/bootstrap-modules/core/stack.ts`) and updated automatically when you re-run bootstrap after upgrading.

If you use a custom role (`--role-arn`), ensure it has at minimum:

| Permission | Purpose |
|-----------|---------|
| `sagemaker:CreateEndpoint`, `CreateEndpointConfig`, `CreateModel`, `CreateInferenceComponent` | Deploy |
| `sagemaker:DeleteEndpoint`, `DeleteEndpointConfig`, `DeleteModel`, `DeleteInferenceComponent` | Clean up |
| `sagemaker:DescribeEndpoint`, `DescribeEndpointConfig`, `DescribeModel`, `DescribeInferenceComponent`, `ListInferenceComponents` | Status |
| `sagemaker:InvokeEndpoint`, `InvokeEndpointAsync` | Inference |
| `sagemaker:UpdateEndpoint`, `UpdateEndpointWeightsAndCapacities`, `UpdateInferenceComponent` | Updates |
| `sagemaker:CreateAIBenchmarkJob`, `DescribeAIBenchmarkJob`, `ListAIBenchmarkJobs` | Benchmark |
| `sagemaker:CreateTrainingJob`, `DescribeTrainingJob`, `StopTrainingJob` | Training/tuning |
| `ecr:GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`, `BatchCheckLayerAvailability` | Pull image |
| `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | Logging |
| `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on project buckets | Artifacts |
| `iam:PassRole` (to sagemaker.amazonaws.com) | Role delegation |

Trust policy must allow `sagemaker.amazonaws.com` to assume the role.

## HyperPod Training Role (`do/train` / `do/tune --backend hp-eks`)

The training bootstrap module creates `mlcc-hp-train-role-<region>` (one per profile), assumed by
HyperPod training pods through EKS Pod Identity (ServiceAccount `mlcc-train-sa`). Its ARN reaches
the project as `MLCC_HP_TRAIN_ROLE_ARN`.

- **Trust:** `pods.eks.amazonaws.com`, `sts:AssumeRole` + `sts:TagSession`, condition
  `aws:SourceAccount` = your account.
- **Core bucket (read):** `s3:GetObject` on `datasets/*` and `models/*`; `s3:ListBucket` limited
  to those prefixes.
- **Artifacts bucket (job output):** `s3:PutObject`, `s3:GetObject`, `s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts` on `*/train/*` and `*/tune/*`; `s3:ListBucket` on those prefixes.
- **MLflow:** `sagemaker-mlflow:*` and `sagemaker:CallMlflowAppApi` on this account and region's
  `mlflow-app/*`.
- **Nothing else:** no Lambda, Bedrock, KMS, ECR or core-bucket write (promotion runs in the CLI).

The cluster owner binds it once:
`aws eks create-pod-identity-association --cluster-name <eks> --namespace <ns> --service-account mlcc-train-sa --role-arn <role> --region <region>`.
The caller running `do/train --backend hp-eks` or `do/validate` also needs
`eks:ListPodIdentityAssociations`, `eks:DescribePodIdentityAssociation` and
`iam:SimulatePrincipalPolicy` (on `mlcc-hp-train-role-*`) for the cluster contract.

## CodeBuild Service Role

Created automatically by `./do/submit` as `<%= codebuildProjectName %>-service-role`. Permissions:

- **CloudWatch Logs**: Write build logs to `/aws/codebuild/<%= codebuildProjectName %>*`
- **ECR**: Push images to `ml-container-creator` repository
- **S3**: Read source archives from the CodeBuild source bucket (profile key `codebuildSourceS3Bucket`)

## User/CI Permissions

Your AWS user or CI system needs these permissions to run the do-scripts:

| Script | Permissions Needed |
|--------|-------------------|
| `./do/build` | Local only — no AWS permissions |
| `./do/run` | Local only — no AWS permissions |
| `./do/push` | `ecr:GetAuthorizationToken`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:BatchCheckLayerAvailability` |
| `./do/submit` | `codebuild:CreateProject`, `codebuild:StartBuild`, `codebuild:BatchGetBuilds`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:PassRole`, `s3:PutObject`, `s3:CreateBucket` |
| `./do/stage` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on mlcc-* buckets |
| `./do/deploy` | All targets: `ecr:DescribeImages` (image preflight), `secretsmanager:DescribeSecret` (when `HF_TOKEN_ARN` / `NGC_API_KEY_ARN` is set), `iam:PassRole`. realtime-inference / async-inference: `sagemaker:CreateModel`, `sagemaker:CreateEndpointConfig`, `sagemaker:CreateEndpoint`, `sagemaker:CreateInferenceComponent`, `sagemaker:DescribeEndpoint`, `sagemaker:DescribeEndpointConfig`. batch-transform: `sagemaker:CreateModel`, `sagemaker:CreateTransformJob`, `sagemaker:DescribeTransformJob`. hyperpod-eks / eks: `sagemaker:DescribeCluster` (hyperpod-eks), `eks:DescribeCluster` + Kubernetes API access (`aws eks update-kubeconfig`), `secretsmanager:GetSecretValue` (creates the in-cluster `hf-token-secret`). `--scale-to-zero on` (realtime-inference): `application-autoscaling:RegisterScalableTarget`, `application-autoscaling:PutScalingPolicy`, `cloudwatch:PutMetricAlarm`, `iam:CreateServiceLinkedRole` (first registration in an account) |
| `./do/add-ic` | `sagemaker:CreateInferenceComponent`, `sagemaker:DescribeEndpoint`, `sagemaker:ListInferenceComponents`, `iam:PassRole` |
| `./do/test` | `sagemaker:InvokeEndpoint`, `sagemaker:DescribeEndpoint`; async-inference: `sagemaker:InvokeEndpointAsync` + S3 read/write; batch-transform: `sagemaker:DescribeTransformJob` + S3; hyperpod-eks / eks: `eks:DescribeCluster` + Kubernetes API access |
| `./do/benchmark` | `sagemaker:CreateAIBenchmarkJob`, `sagemaker:DescribeAIBenchmarkJob`, `sagemaker:ListAIBenchmarkJobs`, `sagemaker:CreateAIWorkloadConfig`, `iam:PassRole`, `s3:GetObject`; Athena write: `s3:PutObject`, `glue:GetTable`, `glue:BatchCreatePartition`, `glue:GetPartition`, `glue:UpdatePartition` (partition column reconcile); cost: `pricing:GetProducts` (Price List API, `us-east-1` endpoint; without it the cost falls back to the bundled snapshot), `sagemaker:DescribeEndpoint` (realtime `CurrentInstanceCount`) |
| `pricing.py snapshot` / `verify-bedrock` (MLCC maintainers only) | `pricing:GetProducts`, `bedrock:ListFoundationModels` (read-only) |
| `./do/train` | `sagemaker:CreateTrainingJob`, `sagemaker:DescribeTrainingJob`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject` |
| `./do/tune` | `sagemaker:CreateTrainingJob`, `sagemaker:DescribeTrainingJob`, `sagemaker:ListTrainingJobs`, `sagemaker:ListHubContents` (model catalog), `sts:GetCallerIdentity`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject`, plus the AI Registry and MLflow App calls the SageMaker Python SDK v3 trainers make. `--backend hp-eks`: Kubernetes API access and the cluster-contract permissions above |
| `./do/adapter` | `sagemaker:CreateInferenceComponent`, `sagemaker:UpdateInferenceComponent`, `sagemaker:DescribeInferenceComponent`, `s3:GetObject` |
| `./do/optimize` | `sagemaker:CreateAIRecommendationJob`, `sagemaker:DescribeAIRecommendationJob`, `sagemaker:CreateAIWorkloadConfig`, `sagemaker:DescribeEndpoint`, `sagemaker:DescribeEndpointConfig`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject` |
| `./do/register` | `sagemaker:CreateModelPackage`, `sagemaker:CreateModelPackageGroup`, `sagemaker:DescribeModelPackage`, S3 read/write (datasets, evaluator samples), plus the AI Registry and MLflow App calls the SageMaker Python SDK v3 makes. `evaluator --from-sample`: `lambda:GetFunction`, `lambda:CreateFunction`, `lambda:UpdateFunctionCode`, `iam:PassRole`. `--ci`: `dynamodb:DescribeTable`, `dynamodb:PutItem`, `dynamodb:UpdateItem` |
| `./do/logs` | `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:DescribeLogStreams` |
| `./do/status` | `sagemaker:DescribeEndpoint`, `sagemaker:DescribeInferenceComponent`, `sagemaker:ListInferenceComponents`; scale-to-zero endpoints: `application-autoscaling:DescribeScalableTargets`; hyperpod-eks dashboard pointer: `grafana:ListWorkspaces` |
| `./do/metrics` | `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` (realtime-inference); `aps:QueryMetrics`, `sagemaker:DescribeCluster`, `eks:DescribeAddon`, `grafana:ListWorkspaces` (hyperpod-eks). All read-only |
| `./do/add-pod` | hyperpod-eks: `eks:DescribeCluster` + Kubernetes API access (applies a second InferenceEndpointConfig), `sagemaker:DescribeEndpoint`, S3 read on the core bucket (resolving `--from-tune` / `--from-weights`) |
| `./do/draft` | hyperpod-eks: writes do/config only (apply with `./do/deploy`); `s3:ListBucket` when the draft model is an S3 path |
| `./do/evaluate` | `sagemaker:DescribeEndpoint`, `sagemaker:InvokeEndpoint` (or Kubernetes API access on hyperpod-eks / eks) |
| `./do/clean` | `sagemaker:DeleteEndpoint`, `sagemaker:DeleteEndpointConfig`, `sagemaker:DeleteModel`, `sagemaker:DeleteInferenceComponent`, `codebuild:DeleteProject`, `iam:DeleteRole`, `iam:DeleteRolePolicy`, `ecr:BatchDeleteImage`; scale-to-zero endpoints: `application-autoscaling:DeleteScalingPolicy`, `application-autoscaling:DeregisterScalableTarget`, `cloudwatch:DeleteAlarms`; `./do/clean adapters`: `s3:ListBucket`, `s3:DeleteObject` on the core bucket |
| `./do/export` | Local only — reads config files |
| `./do/validate` | Mostly local. The right-sizing quota lookup calls `servicequotas:ListServiceQuotas`; on hyperpod-eks / eks the cluster contract needs Kubernetes API read access plus `eks:DescribeCluster`, `eks:ListPodIdentityAssociations`, `eks:DescribePodIdentityAssociation` and `iam:SimulatePrincipalPolicy` (see above). `--offline` skips AWS lookups |
| `./do/manifest` | Local only — asset manifest (`add`, `delete`, `list`) |
| `bootstrap` | `cloudformation:*`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:TagRole`, `ecr:CreateRepository`, `s3:CreateBucket`, `sts:GetCallerIdentity` |

<% if (framework === 'transformers' && hfToken) { %>
## HuggingFace Token Security

This project includes a HuggingFace token baked into the Docker image. Key practices:

- **Use read-only tokens** — never bake write tokens into containers
- **Rotate regularly** — every 30–90 days, or immediately if compromised
- **Restrict ECR access** — limit who can pull images containing the token
- **Prefer runtime resolution** — store the token in Secrets Manager and set `HF_TOKEN_ARN` instead of baking it in. The container resolves it at startup with the execution role, so the token is not in image layers, Describe* output or CloudTrail, and you can rotate it without a rebuild. Do not pass a plaintext `HF_TOKEN` as a SageMaker environment variable: `do/deploy` refuses it unless you pass `--allow-plaintext-secret`.

To rotate: generate a new token on [HuggingFace](https://huggingface.co/settings/tokens), rebuild with `./do/submit`, revoke the old token.

If compromised: revoke the token immediately, delete the ECR image (`aws ecr batch-delete-image`), rebuild, and review CloudTrail logs.
<% } %>

## Security Best Practices

- **Least privilege**: All roles are scoped to specific resources where possible
- **Resource scoping**: CodeBuild permissions scoped to `<%= codebuildProjectName %>`, SageMaker to `<%= projectName %>*`
- **Audit**: Enable CloudTrail for IAM, SageMaker, ECR, and CodeBuild events
- **Separate environments**: Consider per-environment roles (dev/prod)

## References

- [SageMaker Execution Roles](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-roles.html)
- [CodeBuild Service Role](https://docs.aws.amazon.com/codebuild/latest/userguide/setting-up.html#setting-up-service-role)
- [ECR Permissions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/security_iam_service-with-iam.html)
