# IAM Permissions for CodeBuild Deployment

This document outlines the IAM permissions required for deploying <%= projectName %> using AWS CodeBuild.

## Overview

The CodeBuild deployment uses a **shared ECR repository** approach where all ML container projects created by this generator use a single ECR repository named `ml-container-creator`. Each project gets its own image tags within this shared repository:

- `<project-name>-latest` - Latest build for a specific project
- `<project-name>-YYYYMMDD-HHMMSS` - Timestamped builds for a specific project  
- `latest` - Global latest build across all projects

This approach simplifies ECR management and reduces the number of repositories needed.

The CodeBuild deployment requires two sets of permissions:
1. **CodeBuild Service Role** - Permissions for the CodeBuild service to build and push Docker images
2. **User/CI System Permissions** - Permissions for your user account or CI system to manage CodeBuild projects and SageMaker resources

## CodeBuild Service Role Permissions

The CodeBuild service role (`<%= codebuildProjectName %>-service-role`) needs the following permissions:

### Trust Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Service Role Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:<%= awsRegion %>:*:log-group:/aws/codebuild/<%= codebuildProjectName %>*"
    },
    {
      "Sid": "ECRAccess",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:GetAuthorizationToken",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": [
        "arn:aws:ecr:*:*:repository/ml-container-creator"
      ]
    },
    {
      "Sid": "S3Access",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::codebuild-source-*/*"
      ]
    },
    {
      "Sid": "S3ListBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::codebuild-source-*"
      ]
    }
  ]
}
```

## User/CI System Permissions

Your AWS user account or CI system needs the following permissions to manage the CodeBuild deployment:

### Required Permissions Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodeBuildManagement",
      "Effect": "Allow",
      "Action": [
        "codebuild:CreateProject",
        "codebuild:BatchGetProjects",
        "codebuild:StartBuild",
        "codebuild:BatchGetBuilds",
        "codebuild:StopBuild"
      ],
      "Resource": [
        "arn:aws:codebuild:<%= awsRegion %>:*:project/<%= codebuildProjectName %>",
        "arn:aws:codebuild:<%= awsRegion %>:*:build/<%= codebuildProjectName %>:*"
      ]
    },
    {
      "Sid": "ECRManagement",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": [
        "arn:aws:ecr:*:*:repository/ml-container-creator"
      ]
    },
    {
      "Sid": "IAMRoleManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/<%= codebuildProjectName %>-service-role",
        "arn:aws:iam::*:role/<%= projectName %>-sagemaker-role"
      ]
    },
    {
      "Sid": "SageMakerDeployment",
      "Effect": "Allow",
      "Action": [
        "sagemaker:CreateModel",
        "sagemaker:CreateEndpointConfig",
        "sagemaker:CreateEndpoint",
        "sagemaker:DescribeEndpoint",
        "sagemaker:DescribeEndpointConfig",
        "sagemaker:DescribeModel",
        "sagemaker:DeleteEndpoint",
        "sagemaker:DeleteEndpointConfig",
        "sagemaker:DeleteModel",
        "sagemaker:UpdateEndpoint"
      ],
      "Resource": [
        "arn:aws:sagemaker:<%= awsRegion %>:*:model/<%= projectName %>*",
        "arn:aws:sagemaker:<%= awsRegion %>:*:endpoint-config/<%= projectName %>*",
        "arn:aws:sagemaker:<%= awsRegion %>:*:endpoint/<%= projectName %>*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents"
      ],
      "Resource": "arn:aws:logs:<%= awsRegion %>:*:log-group:/aws/codebuild/<%= codebuildProjectName %>*"
    },
    {
      "Sid": "S3SourceManagement",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:HeadBucket"
      ],
      "Resource": [
        "arn:aws:s3:::codebuild-source-*",
        "arn:aws:s3:::codebuild-source-*/*"
      ]
    },
    {
      "Sid": "STSAccess",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

## SageMaker Execution Role Permissions

For SageMaker deployment, you'll also need a SageMaker execution role with these permissions:

### Trust Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "sagemaker.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Execution Role Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRAccess",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:<%= awsRegion %>:*:log-group:/aws/sagemaker/*"
    }<% if (framework === 'transformers') { %>,
    {
      "Sid": "S3ModelAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-model-bucket/*",
        "arn:aws:s3:::your-model-bucket"
      ]
    }<% } %>
  ]
}
```

## Setup Instructions

### 1. Automatic Setup (Recommended)
The `submit_build.sh` script will automatically create the CodeBuild service role with the required permissions. You only need to ensure your user account has the permissions listed in the "User/CI System Permissions" section above.

### 2. Manual Setup
If you prefer to create the roles manually:

#### Create CodeBuild Service Role
```bash
# Create the role
aws iam create-role \
  --role-name <%= codebuildProjectName %>-service-role \
  --assume-role-policy-document file://codebuild-trust-policy.json

# Attach the policy
aws iam put-role-policy \
  --role-name <%= codebuildProjectName %>-service-role \
  --policy-name CodeBuildServicePolicy \
  --policy-document file://codebuild-service-policy.json
```

#### Create SageMaker Execution Role
```bash
# Create the role
aws iam create-role \
  --role-name <%= projectName %>-sagemaker-role \
  --assume-role-policy-document file://sagemaker-trust-policy.json

# Attach the policy
aws iam put-role-policy \
  --role-name <%= projectName %>-sagemaker-role \
  --policy-name SageMakerExecutionPolicy \
  --policy-document file://sagemaker-execution-policy.json
```

## Security Best Practices

### Principle of Least Privilege
- The permissions listed above follow the principle of least privilege
- Each role only has the minimum permissions required for its function
- Resource ARNs are scoped to specific projects where possible

### Resource Scoping
- CodeBuild permissions are scoped to the specific project: `<%= codebuildProjectName %>`
- SageMaker permissions are scoped to resources with the project prefix: `<%= projectName %>*`
- CloudWatch logs are scoped to the appropriate log groups

### Regular Review
- Review and audit IAM permissions regularly
- Remove unused roles and policies
- Monitor CloudTrail logs for permission usage

### Environment-Specific Roles
Consider creating separate roles for different environments:
- `<%= codebuildProjectName %>-dev-service-role`
- `<%= codebuildProjectName %>-prod-service-role`

## Troubleshooting

### Common Permission Issues

#### "Access Denied" when creating CodeBuild project
- Ensure your user has `codebuild:CreateProject` permission
- Verify the IAM role ARN is correct in the CodeBuild project configuration

#### "Access Denied" when pushing to ECR
- Check that the CodeBuild service role has ECR permissions
- Ensure the ECR repository exists and is in the correct region

#### "Role cannot be assumed" error
- Verify the trust policy allows CodeBuild to assume the role
- Check that the role name matches exactly

#### SageMaker deployment fails
- Ensure the SageMaker execution role exists
- Verify ECR image permissions for SageMaker
- Check that the execution role has the correct trust policy

### Getting Help
- Check AWS CloudTrail logs for detailed permission errors
- Use AWS IAM Policy Simulator to test permissions
- Review AWS CodeBuild and SageMaker documentation for the latest permission requirements

## References
- [AWS CodeBuild Service Role](https://docs.aws.amazon.com/codebuild/latest/userguide/setting-up.html#setting-up-service-role)
- [Amazon SageMaker Execution Roles](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-roles.html)
- [Amazon ECR Permissions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/security_iam_service-with-iam.html)