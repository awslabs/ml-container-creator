#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Configuration
IMAGE_NAME="<%= projectName %>"
AWS_REGION="<%= awsRegion %>"

# Use shared ECR repository for all ML container projects
ECR_REPOSITORY_NAME="ml-container-creator"

# Check AWS credentials
if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "❌ AWS credentials not configured. Please run 'aws configure' first."
    exit 1
fi

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPOSITORY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY_NAME}"

# Build Docker image
echo "Building Docker image for project: ${IMAGE_NAME}..."

#docker build -t ${IMAGE_NAME}:latest .
#docker buildx build --platform linux/amd64 --output type=docker --provenance=false -t ${IMAGE_NAME}:latest .
docker buildx build --output type=docker --provenance=false -t ${IMAGE_NAME}:latest .

# Tag for ECR with project-specific tags
PROJECT_TAG="${IMAGE_NAME}-$(date +%Y%m%d-%H%M%S)"
docker tag ${IMAGE_NAME}:latest ${ECR_REPOSITORY}:${PROJECT_TAG}
docker tag ${IMAGE_NAME}:latest ${ECR_REPOSITORY}:${IMAGE_NAME}-latest
docker tag ${IMAGE_NAME}:latest ${ECR_REPOSITORY}:latest

# Login to ECR
echo "Logging into ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REPOSITORY}

# Create ECR repository if it doesn't exist
echo "📦 Checking ECR repository..."
aws ecr describe-repositories --repository-names ${ECR_REPOSITORY_NAME} --region ${AWS_REGION} 2>/dev/null || \
aws ecr create-repository --repository-name ${ECR_REPOSITORY_NAME} --region ${AWS_REGION}

# Push to ECR
echo "Pushing images to ECR repository: ${ECR_REPOSITORY_NAME}..."
docker push ${ECR_REPOSITORY}:${PROJECT_TAG}
docker push ${ECR_REPOSITORY}:${IMAGE_NAME}-latest
docker push ${ECR_REPOSITORY}:latest

echo "✅ Images successfully pushed to ECR:"
echo "  - ${ECR_REPOSITORY}:${PROJECT_TAG} (timestamped build)"
echo "  - ${ECR_REPOSITORY}:${IMAGE_NAME}-latest (project latest)"
echo "  - ${ECR_REPOSITORY}:latest (global latest)"