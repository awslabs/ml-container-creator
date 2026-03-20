# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# NVIDIA Triton Inference Server Dockerfile
# Backend: <%= backend %>

<% if (comments && comments.acceleratorInfo) { %>
<%= comments.acceleratorInfo %>
<% } %>

<% if (comments && comments.validationInfo) { %>
<%= comments.validationInfo %>
<% } %>

# Triton Inference Server base image from NVIDIA NGC
# Public image - no NGC authentication required
ARG BASE_IMAGE=<%= baseImage || 'nvcr.io/nvidia/tritonserver:24.08-py3' %>
FROM ${BASE_IMAGE}

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

<% if (backend === 'vllm' || backend === 'tensorrtllm') { %>
# HuggingFace model configuration for LLM backends
ENV HF_MODEL_ID="<%= modelName %>"
<% if (hfToken) { %>
# Set HuggingFace authentication token for gated models
ENV HF_TOKEN="<%= hfToken %>"
<% } %>
<% } %>

<% if (backend === 'python') { %>
# Install Python backend dependencies
COPY triton/requirements.txt /tmp/triton_requirements.txt
RUN pip install --no-cache-dir -r /tmp/triton_requirements.txt && \
    rm /tmp/triton_requirements.txt
<% } %>

# Set up model repository directory structure
# Triton expects models at: /opt/ml/model/model_repository/<model-name>/<version>/
RUN mkdir -p /opt/ml/model/model_repository/<%= modelName || 'model' %>/1

# Set permissions for model repository
RUN chmod -R 755 /opt/ml/model/model_repository

# Copy Triton model configuration
COPY triton/config.pbtxt /opt/ml/model/model_repository/<%= modelName || 'model' %>/config.pbtxt

<% if (backend === 'python') { %>
# Copy Python backend model implementation
COPY triton/model.py /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.py
<% } %>

<% if (includeSampleModel) { %>
# Copy sample model artifact
<% if (backend === 'fil') { %>
<% if (modelFormat === 'xgboost_json') { %>
COPY sample_model/abalone_model.json /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/xgboost.json
<% } else if (modelFormat === 'xgboost_ubj') { %>
COPY sample_model/abalone_model.ubj /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/xgboost.ubj
<% } else if (modelFormat === 'lightgbm_txt') { %>
COPY sample_model/abalone_model.txt /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.txt
<% } %>
<% } else if (backend === 'onnxruntime') { %>
COPY sample_model/abalone_model.onnx /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.onnx
<% } else if (backend === 'tensorflow') { %>
COPY sample_model/abalone_model.savedmodel /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.savedmodel/
<% } else if (backend === 'pytorch') { %>
COPY sample_model/abalone_model.pt /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.pt
<% } else if (backend === 'python') { %>
<% if (modelFormat === 'pkl') { %>
COPY sample_model/abalone_model.pkl /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.pkl
<% } else if (modelFormat === 'joblib') { %>
COPY sample_model/abalone_model.joblib /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/model.joblib
<% } %>
<% } %>
# Also copy training script for reference
COPY sample_model/ /opt/ml/sample_model/
<% } else { %>
# Model artifacts should be placed in:
# /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/
# COPY your_model_files /opt/ml/model/model_repository/<%= modelName || 'model' %>/1/
<% } %>

<% if (comments && comments.envVarExplanations && Object.keys(comments.envVarExplanations).length > 0) { %>
# Environment Variables Configuration
<% for (const [category, comment] of Object.entries(comments.envVarExplanations)) { %>
<%= comment %>
<% } %>
<% } %>

# Triton environment variables
ENV TRITON_MODEL_REPOSITORY=/opt/ml/model/model_repository

<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>
# Additional environment variables from configuration
<% orderedEnvVars.forEach(({ key, value }) => { %>
ENV <%= key %>=<%= value %>
<% }); %>
<% } %>

# Expose port 8080 for SageMaker compatibility
# Triton default ports: 8000 (HTTP), 8001 (gRPC), 8002 (metrics)
# SageMaker requires port 8080
EXPOSE 8080

<% if (comments && comments.troubleshooting) { %>
<%= comments.troubleshooting %>
<% } %>

# Start Triton Inference Server
# --http-port=8080: SageMaker requires port 8080
# --model-repository: Path to model repository
# --strict-model-config=false: Allow Triton to auto-complete config for some backends
ENTRYPOINT ["tritonserver", \
            "--http-port=8080", \
            "--model-repository=/opt/ml/model/model_repository", \
            "--strict-model-config=false"]
