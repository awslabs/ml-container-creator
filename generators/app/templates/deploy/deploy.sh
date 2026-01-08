#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Exit on any error
set -e

<% if (awsRoleArn && awsRoleArn !== null && awsRoleArn !== '') { %>
# Using configured execution role ARN
ROLE_ARN="<%= awsRoleArn %>"
echo "Using configured execution role: ${ROLE_ARN}"
<% } else { %>
# Check if execution role ARN is provided
if [ $# -ne 1 ]; then
    echo "Usage: $0 <execution-role-arn>"
    echo "Example: $0 arn:aws:iam::123456789012:role/SageMakerExecutionRole"
    exit 1
fi

ROLE_ARN=$1
echo "Using execution role: ${ROLE_ARN}"
<% } %>

# Configuration
IMAGE_NAME="<%= projectName %>"
AWS_REGION="<%= awsRegion %>"
DEPLOY_TARGET="<%= deployTarget %>"

# Use shared ECR repository for all ML container projects
ECR_REPOSITORY_NAME="ml-container-creator"

# Check AWS credentials
if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "❌ AWS credentials not configured. Please run 'aws configure' first."
    exit 1
fi

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPOSITORY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY_NAME}"
TIMESTAMP=$(date +%s)
MODEL_NAME="${IMAGE_NAME}-model-${TIMESTAMP}"
ENDPOINT_CONFIG_NAME="${IMAGE_NAME}-endpoint-config-${TIMESTAMP}"
ENDPOINT_NAME="${IMAGE_NAME}-endpoint-${TIMESTAMP}"
<% if (instanceType === 'cpu-optimized') { %>INSTANCE_TYPE="ml.m6g.large"
<% } else if (instanceType === 'gpu-enabled' && framework === 'transformers') { %>INSTANCE_TYPE="ml.g6.12xlarge"
<% } else if (instanceType === 'gpu-enabled') { %>INSTANCE_TYPE="ml.g5.xlarge"
<% } %>

<% if (deployTarget === 'codebuild') { %>
# CodeBuild deployment - image should already be in ECR
echo "🚀 Deploying CodeBuild-generated image to SageMaker..."

# Verify ECR image exists
echo "🔍 Verifying ECR image exists..."
if ! aws ecr describe-images --repository-name ${ECR_REPOSITORY_NAME} --image-ids imageTag=${IMAGE_NAME}-latest --region ${AWS_REGION} >/dev/null 2>&1; then
    echo "❌ ECR image not found: ${ECR_REPOSITORY}:${IMAGE_NAME}-latest"
    echo ""
    echo "The CodeBuild deployment requires the Docker image to be built and pushed to ECR first."
    echo "Please run the following command to build and push your image:"
    echo "  ./deploy/submit_build.sh"
    echo ""
    echo "After the build completes successfully, run this deploy script again."
    exit 1
fi

echo "✅ ECR image found: ${ECR_REPOSITORY}:latest"
<% } else { %>
# SageMaker deployment - pull locally built image
echo "🚀 Deploying locally built image to SageMaker..."

# Pull the latest image
echo "Pulling image from ECR..."
docker pull ${ECR_REPOSITORY}:latest
<% } %>

# Create SageMaker model
echo "Creating SageMaker model: ${MODEL_NAME}"
aws sagemaker create-model \
    --model-name ${MODEL_NAME} \
    --primary-container Image=${ECR_REPOSITORY}:${IMAGE_NAME}-latest,Mode=SingleModel \
    --execution-role-arn ${ROLE_ARN} \
    --region ${AWS_REGION}

# Create endpoint configuration
echo "Creating endpoint configuration: ${ENDPOINT_CONFIG_NAME}"
aws sagemaker create-endpoint-config \
    --endpoint-config-name ${ENDPOINT_CONFIG_NAME} \
    --production-variants VariantName=primary,ModelName=${MODEL_NAME},InitialInstanceCount=1,InstanceType=${INSTANCE_TYPE},InitialVariantWeight=1 \
    --region ${AWS_REGION}

# Create endpoint
echo "Creating endpoint: ${ENDPOINT_NAME}"
aws sagemaker create-endpoint \
    --endpoint-name ${ENDPOINT_NAME} \
    --endpoint-config-name ${ENDPOINT_CONFIG_NAME} \
    --region ${AWS_REGION}

echo "Waiting for endpoint to be in service..."
aws sagemaker wait endpoint-in-service --endpoint-name ${ENDPOINT_NAME} --region ${AWS_REGION}

echo "Deployment complete!"
echo "Endpoint name: ${ENDPOINT_NAME}"
echo "You can test the endpoint with:"
echo "./test_endpoint.sh ${ENDPOINT_NAME}"