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
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPOSITORY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${IMAGE_NAME}"
TIMESTAMP=$(date +%s)
MODEL_NAME="<%= framework %>-model-${TIMESTAMP}"
ENDPOINT_CONFIG_NAME="<%= framework %>-endpoint-config-${TIMESTAMP}"
ENDPOINT_NAME="<%= framework %>-endpoint-${TIMESTAMP}"
<% if (instanceType === 'cpu-optimized') { %>INSTANCE_TYPE="ml.m6g.large"
<% } else if (instanceType === 'gpu-enabled') { %>INSTANCE_TYPE="ml.g5.xlarge"
<% } %>

# Pull the latest image
echo "Pulling image from ECR..."
docker pull ${ECR_REPOSITORY}:latest

# Create SageMaker model
echo "Creating SageMaker model: ${MODEL_NAME}"
aws sagemaker create-model \
    --model-name ${MODEL_NAME} \
    --primary-container Image=${ECR_REPOSITORY}:latest,Mode=SingleModel \
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