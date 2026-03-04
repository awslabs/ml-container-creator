# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

<% if (comments && comments.acceleratorInfo) { %>
<%= comments.acceleratorInfo %>
<% } %>

<% if (comments && comments.validationInfo) { %>
<%= comments.validationInfo %>
<% } %>

<% if (framework !== 'transformers') { %>
FROM python:3.12-slim

# Set a docker label to name this project, postpended with the build time
LABEL project.name="<%= projectName %>-<%= buildTimestamp %>" \
      project.base-name="<%= projectName %>" \
      project.build-time="<%= buildTimestamp %>"

# Set a docker label to advertise multi-model support on the container
LABEL com.amazonaws.sagemaker.capabilities.multi-models=true
# Set a docker label to enable container to use SAGEMAKER_BIND_TO_PORT environment variable if present
LABEL com.amazonaws.sagemaker.capabilities.accept-bind-to-port=true

# Set working directory
WORKDIR /opt/ml

RUN apt-get update &&  \
    apt-get upgrade -y && \
    apt-get clean

# Install system dependencies
RUN apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    nginx \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir pip==24.2 && \
    pip install --no-cache-dir -r requirements.txt

# Copy model serving code
COPY code/serve.py code/
COPY code/start_server.py code/
COPY code/model_handler.py code/

<% if (modelServer === 'flask') { %>
COPY code/flask/gunicorn_config.py code/
COPY code/flask/wsgi.py code/
<% } %>


# Set up SageMaker directories
RUN mkdir -p /opt/ml/input/data \
    && mkdir -p /opt/ml/output/data \
    && mkdir -p /opt/ml/model

COPY nginx-predictors.conf /etc/nginx/nginx.conf

# Model files will be provided at runtime via SageMaker model artifacts
<% if (includeSampleModel) { %>
# Copy the generated sample model
<% if (modelFormat === 'SavedModel') { %>
COPY sample_model/abalone_model /opt/ml/model/
<% } else { %>
COPY sample_model/abalone_model.<%= modelFormat %> /opt/ml/model/
<% } %>
# Also copy training script for reference
COPY sample_model/ /opt/ml/sample_model/
<% } else { %>
# COPY your_model_files /opt/ml/model/
<% } %>

<% if (comments && comments.envVarExplanations && Object.keys(comments.envVarExplanations).length > 0) { %>
# Environment Variables Configuration
<% for (const [category, comment] of Object.entries(comments.envVarExplanations)) { %>
<%= comment %>
<% } %>
<% } %>

# Set environment variables for SageMaker
ENV PYTHONPATH=/opt/ml/code
ENV SAGEMAKER_BIND_TO_PORT=8080

<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>
# Additional environment variables from configuration
<% orderedEnvVars.forEach(({ key, value }) => { %>
ENV <%= key %>=<%= value %>
<% }); %>
<% } %>

# Expose port 8080 for SageMaker inference
EXPOSE 8080

<% if (comments && comments.troubleshooting) { %>
<%= comments.troubleshooting %>
<% } %>

# Set the inference script as the entry point
RUN chmod +x code/start_server.py
ENTRYPOINT ["python", "/opt/ml/code/start_server.py"]
<% } else { %>
<% if (comments && comments.acceleratorInfo) { %>
<%= comments.acceleratorInfo %>
<% } %>

<% if (comments && comments.validationInfo) { %>
<%= comments.validationInfo %>
<% } %>

<% if (modelServer === 'vllm') { %>
# https://github.com/aws-samples/sagemaker-genai-hosting-examples/tree/main/OpenAI/gpt-oss/deploy/docker
ARG BASE_IMAGE=vllm/vllm-openai:v0.10.1
<% } else if (modelServer === 'sglang') { %>
ARG BASE_IMAGE=lmsysorg/sglang:v0.5.4.post1
<% } else if (modelServer === 'tensorrt-llm') { %>
# TensorRT-LLM requires NVIDIA NGC authentication
# Before building, authenticate with NGC:
#   1. Create NGC account: https://ngc.nvidia.com/signup
#   2. Generate API key: https://ngc.nvidia.com/setup/api-key
#   3. Login: docker login nvcr.io
#      Username: $oauthtoken
#      Password: <your-ngc-api-key>
# Using a stable release for better SageMaker compatibility
ARG BASE_IMAGE=nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc8
<% } else if (modelServer === 'lmi') { %>
# AWS Large Model Inference (LMI) Container
# LMI containers are pre-built by AWS and include DJL Serving with optimized inference libraries
# Available backends: vLLM, TensorRT-LLM, LMI-Dist (DeepSpeed), Transformers NeuronX
# Documentation: https://docs.djl.ai/master/docs/serving/serving/docs/lmi/index.html
ARG BASE_IMAGE=763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.32.0-lmi14.0.0-cu126
<% } else if (modelServer === 'djl') { %>
# DJL Serving Container
# Deep Java Library serving with support for multiple inference backends
# Documentation: https://djl.ai/
ARG BASE_IMAGE=deepjavalibrary/djl-serving:0.32.0-pytorch-cu126
<% } %>

FROM ${BASE_IMAGE}

<% if (comments && comments.chatTemplate) { %>
<%= comments.chatTemplate %>
<% } %>

# Set the model name for the transformer model
<% if (modelServer === 'vllm') { %>
ENV VLLM_MODEL="<%= modelName %>"
<% } else if (modelServer === 'sglang') { %>
ENV SGLANG_MODEL_PATH="<%= modelName %>"
<% } else if (modelServer === 'tensorrt-llm') { %>
ENV TRTLLM_MODEL="<%= modelName %>"

# Disable UCX CUDA transport to avoid symbol lookup errors
# The UCX CUDA library has compatibility issues with some CUDA versions in SageMaker
RUN if [ -f /usr/local/ucx/lib/ucx/libuct_cuda.so.0 ]; then \
        mv /usr/local/ucx/lib/ucx/libuct_cuda.so.0 /usr/local/ucx/lib/ucx/libuct_cuda.so.0.disabled; \
    fi

ENV UCX_TLS=tcp,self,sm
ENV UCX_NET_DEVICES=all
ENV NCCL_IB_DISABLE=1
ENV NCCL_P2P_DISABLE=1
<% } else if (modelServer === 'lmi' || modelServer === 'djl') { %>
# LMI/DJL Configuration
# Model configuration is done via serving.properties file
# The model will be loaded from HuggingFace Hub or S3
ENV HF_MODEL_ID="<%= modelName %>"

# DJL Serving listens on port 8080 by default (SageMaker requirement)
ENV SERVING_PORT=8080
<% } %>

<% if (hfToken) { %>
# Set HuggingFace authentication token
ENV HF_TOKEN="<%= hfToken %>"
<% } %>

<% if (chatTemplate) { %>
# Chat template configuration
# This template formats chat messages for the model
# Writing to file to avoid shell escaping issues with multi-line Jinja2 templates
COPY code/chat_template.jinja /opt/ml/chat_template.jinja
ENV SGLANG_CHAT_TEMPLATE="/opt/ml/chat_template.jinja"
<% } %>

<% if (comments && comments.envVarExplanations && Object.keys(comments.envVarExplanations).length > 0) { %>
# Environment Variables Configuration
<% for (const [category, comment] of Object.entries(comments.envVarExplanations)) { %>
<%= comment %>
<% } %>
<% } %>

<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>
# Additional environment variables from configuration
<% orderedEnvVars.forEach(({ key, value }) => { %>
ENV <%= key %>=<%= value %>
<% }); %>
<% } %>

<% if (modelServer === 'tensorrt-llm') { %>
# Install nginx and curl for reverse proxy and health checks
RUN apt-get update && \
    apt-get install -y nginx curl && \
    rm -rf /var/lib/apt/lists/*

# Copy nginx configuration for TensorRT-LLM
COPY nginx-tensorrt.conf /etc/nginx/nginx.conf

# Copy TensorRT-LLM serve script
COPY code/serve /usr/bin/serve_trtllm
RUN chmod +x /usr/bin/serve_trtllm

# Copy startup script
COPY code/start_server.sh /usr/bin/start_server.sh
RUN chmod +x /usr/bin/start_server.sh

ENTRYPOINT [ "/usr/bin/start_server.sh" ]
<% } else if (modelServer === 'lmi' || modelServer === 'djl') { %>
# Create serving.properties configuration file for LMI/DJL
RUN mkdir -p /opt/ml/model
COPY code/serving.properties /opt/ml/model/serving.properties

<% if (comments && comments.troubleshooting) { %>
<%= comments.troubleshooting %>
<% } %>

# LMI/DJL containers use their own entrypoint
# The container will automatically start DJL Serving with the configuration
<% } else { %>
COPY code/serve /usr/bin/serve
RUN chmod 777 /usr/bin/serve

<% if (comments && comments.troubleshooting) { %>
<%= comments.troubleshooting %>
<% } %>

ENTRYPOINT [ "/usr/bin/serve" ]
<% } %>

<% } %>
