#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

<% if (framework !== 'transformers') { %>
# Exit on any error
set -e

IMAGE_NAME="<%= projectName %>"
CONTAINER_NAME="<%= framework %>-test"
PORT=8080

echo "Building Docker image..."
docker build -t ${IMAGE_NAME} .

echo "Stopping any existing container..."
docker stop ${CONTAINER_NAME} 2>/dev/null || true
docker rm ${CONTAINER_NAME} 2>/dev/null || true

echo "Starting container on port ${PORT}..."
docker run -d --name ${CONTAINER_NAME} -p ${PORT}:8080 ${IMAGE_NAME}

echo "Waiting for container to start..."
sleep 10

echo "Testing health check endpoint..."
curl -f http://localhost:${PORT}/ping || echo "Health check failed"

echo -e "\nTesting inference endpoint..."
curl -X POST http://localhost:${PORT}/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]}' || echo "Inference failed"

echo -e "\nContainer logs:"
docker logs ${CONTAINER_NAME}

echo -e "\nCleaning up..."
docker stop ${CONTAINER_NAME}
docker rm ${CONTAINER_NAME}

echo "Test complete!"
<% } else
  {%><%if (modelServer !== 'vllm') { %>
# Exit on any error
set -e

IMAGE_NAME="<%= projectName %>"
CONTAINER_NAME="<%= framework %>-test"
PORT=8080

echo "Building Docker image..."
docker build \
  --build-arg MODEL=<%= modelName %> \
  --build-arg MODEL_NAME=<%= projectName %>.<%= modelName %> \
  --platform=linux/amd64 \
  -t ${IMAGE_NAME} \
  .

echo "Stopping any existing container..."
docker stop ${CONTAINER_NAME} 2>/dev/null || true
docker rm ${CONTAINER_NAME} 2>/dev/null || true

echo "Starting container on port ${PORT}..."
docker run -d --name ${CONTAINER_NAME} -p ${PORT}:8080 ${IMAGE_NAME}

echo "Waiting for container to start..."
sleep 10

echo "Testing health check endpoint..."
curl -f http://localhost:${PORT}/ping || echo "Health check failed"

echo -e "\nContainer logs:"
docker logs ${CONTAINER_NAME}

echo -e "\nCleaning up..."
docker stop ${CONTAINER_NAME}
docker rm ${CONTAINER_NAME}

echo "Test complete!"
<% } else { %>
# Local image testing is not applicable for the vLLM serving engine.
#
# The vLLM image is large and GPU-bound: it loads the model with a CUDA runtime
# and tensor-parallel workers that a local Docker run on a workstation cannot
# exercise meaningfully (no GPU, multi-GB weights, long warm-up). Smoke-testing
# it locally would prove nothing about the deployed container.
#
# Test against a real endpoint instead:
#
#     ./do/build && ./do/push && ./do/deploy      # build, push, deploy to SageMaker
#     ./do/test                                    # exercise /ping + /invocations on the endpoint
#
# ./do/test hits the live endpoint with the SageMaker inference contract, which is
# the only representative test for a vLLM deployment.
echo "Local image testing is not applicable for vLLM — use ./do/test against a deployed endpoint."
<% } %><% } %>