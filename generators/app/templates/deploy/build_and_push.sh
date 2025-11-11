# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#!/bin/bash

# Configuration
IMAGE_NAME="<%= projectName %>"
AWS_REGION="<%= awsRegion %>"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPOSITORY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${IMAGE_NAME}"

# Build Docker image
echo "Building Docker image..."

#docker build -t ${IMAGE_NAME}:latest .
docker buildx build --platform linux/arm64 --output type=docker --provenance=false -t ${IMAGE_NAME}:latest .

echo "Image pushed to: ${ECR_REPOSITORY}:latest"

# Tag for ECR
docker tag ${IMAGE_NAME}:latest ${ECR_REPOSITORY}:latest

# Login to ECR
echo "Logging into ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REPOSITORY}

# Create ECR repository if it doesn't exist
aws ecr describe-repositories --repository-names ${IMAGE_NAME} --region ${AWS_REGION} 2>/dev/null || \
aws ecr create-repository --repository-name ${IMAGE_NAME} --region ${AWS_REGION}

# Push to ECR
echo "Pushing to ECR..."
docker push ${ECR_REPOSITORY}:latest