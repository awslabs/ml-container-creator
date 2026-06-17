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
Read and write secrets prefixed with `mlcc/` or `ml-container-creator/` (used for HF tokens, API keys).

### SNS
Publish notifications to `mlcc-*` and `ml-container-creator-*` topics (benchmark completion alerts).

### Service Quotas & Capacity
Query service quotas and training plan availability for instance selection.

### Lambda
Invoke functions (reward model evaluation during training/tuning).

### PassRole
Self-pass to SageMaker service, scoped to `mlcc-sagemaker-execution-role`.

The role is defined in `config/bootstrap-stack.json` and updated automatically when you re-run bootstrap after upgrading.

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

## CodeBuild Service Role

Created automatically by `./do/submit` as `<%= codebuildProjectName %>-service-role`. Permissions:

- **CloudWatch Logs**: Write build logs to `/aws/codebuild/<%= codebuildProjectName %>*`
- **ECR**: Push images to `ml-container-creator` repository
- **S3**: Read source archives from `codebuild-source-*` buckets

## User/CI Permissions

Your AWS user or CI system needs these permissions to run the do-scripts:

| Script | Permissions Needed |
|--------|-------------------|
| `./do/build` | Local only — no AWS permissions |
| `./do/run` | Local only — no AWS permissions |
| `./do/push` | `ecr:GetAuthorizationToken`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:BatchCheckLayerAvailability` |
| `./do/submit` | `codebuild:CreateProject`, `codebuild:StartBuild`, `codebuild:BatchGetBuilds`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:PassRole`, `s3:PutObject`, `s3:CreateBucket` |
| `./do/stage` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on mlcc-* buckets |
| `./do/deploy` | `sagemaker:CreateEndpointConfig`, `sagemaker:CreateEndpoint`, `sagemaker:CreateModel`, `sagemaker:CreateInferenceComponent`, `sagemaker:DescribeEndpoint`, `iam:PassRole` |
| `./do/add-ic` | `sagemaker:CreateInferenceComponent`, `sagemaker:DescribeEndpoint`, `sagemaker:ListInferenceComponents`, `iam:PassRole` |
| `./do/test` | `sagemaker-runtime:InvokeEndpoint` |
| `./do/benchmark` | `sagemaker:CreateAIBenchmarkJob`, `sagemaker:DescribeAIBenchmarkJob`, `sagemaker:ListAIBenchmarkJobs`, `sagemaker:CreateAIWorkloadConfig`, `iam:PassRole`, `s3:GetObject` |
| `./do/train` | `sagemaker:CreateTrainingJob`, `sagemaker:DescribeTrainingJob`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject` |
| `./do/tune` | `sagemaker:CreateTrainingJob`, `sagemaker:DescribeTrainingJob`, `iam:PassRole`, `s3:GetObject`, `s3:PutObject` |
| `./do/adapter` | `sagemaker:CreateInferenceComponent`, `sagemaker:UpdateInferenceComponent`, `sagemaker:DescribeInferenceComponent`, `s3:GetObject` |
| `./do/optimize` | `sagemaker:CreateModel`, `sagemaker:DescribeModel`, `s3:GetObject`, `s3:PutObject` |
| `./do/register` | `sagemaker:CreateModelPackage`, `sagemaker:CreateModelPackageGroup`, `sagemaker:DescribeModelPackage` |
| `./do/logs` | `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:DescribeLogStreams` |
| `./do/status` | `sagemaker:DescribeEndpoint`, `sagemaker:DescribeInferenceComponent`, `sagemaker:ListInferenceComponents` |
| `./do/clean` | `sagemaker:DeleteEndpoint`, `sagemaker:DeleteEndpointConfig`, `sagemaker:DeleteModel`, `sagemaker:DeleteInferenceComponent`, `codebuild:DeleteProject`, `iam:DeleteRole`, `iam:DeleteRolePolicy` |
| `./do/export` | Local only — reads config files |
| `./do/validate` | Local only — validates project structure |
| `./do/manifest` | Local only — generates deployment manifest |
| `bootstrap` | `cloudformation:*`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:TagRole`, `ecr:CreateRepository`, `s3:CreateBucket`, `sts:GetCallerIdentity` |

<% if (framework === 'transformers' && hfToken) { %>
## HuggingFace Token Security

This project includes a HuggingFace token baked into the Docker image. Key practices:

- **Use read-only tokens** — never bake write tokens into containers
- **Rotate regularly** — every 30–90 days, or immediately if compromised
- **Restrict ECR access** — limit who can pull images containing the token
- **Consider runtime injection** — pass `HF_TOKEN` as a SageMaker environment variable instead of baking it in (avoids token in image layers, enables rotation without rebuild)

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
