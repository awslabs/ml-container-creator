# IAM Permissions — <%= projectName %>

## Overview

This project uses three sets of IAM permissions:

1. **SageMaker Execution Role** — created automatically by `bootstrap` via CloudFormation
2. **CodeBuild Service Role** — created automatically by `./do/submit`
3. **User/CI Permissions** — your AWS user or CI system needs these to run the do-scripts

## SageMaker Execution Role

The bootstrap command creates an IAM role (`mlcc-sagemaker-execution-role`) with permissions for:

- **SageMaker**: Create, update, delete, and invoke endpoints, endpoint configs, models, and inference components
- **ECR**: Pull images from the `ml-container-creator` repository
- **CloudWatch Logs**: Write container logs
- **S3**: Read model artifacts from `ml-container-creator-*` buckets

The role is defined in the CloudFormation stack template (`config/bootstrap-stack.json`) and updated automatically when you re-run bootstrap after upgrading.

If you use a custom role (`--role-arn`), ensure it has at minimum:

| Permission | Purpose |
|-----------|---------|
| `sagemaker:CreateEndpoint`, `CreateEndpointConfig`, `CreateModel`, `CreateInferenceComponent` | Deploy |
| `sagemaker:DeleteEndpoint`, `DeleteEndpointConfig`, `DeleteModel`, `DeleteInferenceComponent` | Clean up |
| `sagemaker:DescribeEndpoint`, `DescribeEndpointConfig`, `DescribeModel`, `DescribeInferenceComponent` | Status checks |
| `sagemaker:InvokeEndpoint`, `InvokeEndpointAsync` | Inference |
| `sagemaker:UpdateEndpoint`, `UpdateEndpointWeightsAndCapacities`, `UpdateInferenceComponent` | Updates |
| `ecr:GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`, `BatchCheckLayerAvailability` | Pull container image |
| `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | Container logging |
| `s3:GetObject`, `s3:ListBucket` on `ml-container-creator-*` | Model artifact access |

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
| `./do/push` | `ecr:GetAuthorizationToken`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:BatchCheckLayerAvailability` |
| `./do/submit` | `codebuild:CreateProject`, `codebuild:StartBuild`, `codebuild:BatchGetBuilds`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:PassRole`, `s3:PutObject`, `s3:CreateBucket` |
| `./do/deploy` | `sagemaker:CreateEndpointConfig`, `sagemaker:CreateEndpoint`, `sagemaker:CreateInferenceComponent`, `sagemaker:DescribeEndpoint`, `iam:PassRole` |
| `./do/clean` | `sagemaker:DeleteEndpoint`, `sagemaker:DeleteEndpointConfig`, `sagemaker:DeleteInferenceComponent`, `codebuild:DeleteProject`, `iam:DeleteRole`, `iam:DeleteRolePolicy` |
| `./do/test` | `sagemaker-runtime:InvokeEndpoint` |
| `bootstrap` | `cloudformation:*`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:TagRole`, `ecr:CreateRepository`, `s3:CreateBucket` (and `sts:GetCallerIdentity`) |

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
