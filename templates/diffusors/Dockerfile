# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

<% if (comments && comments.acceleratorInfo) { %>
<%= comments.acceleratorInfo %>
<% } %>

<% if (comments && comments.validationInfo) { %>
<%= comments.validationInfo %>
<% } %>

# vLLM-Omni: Diffusion model serving with OpenAI-compatible image generation API
# Image source: https://hub.docker.com/r/vllm/vllm-omni (public, no NGC auth required)
FROM vllm/vllm-omni:v0.16.0

# Set a docker label to name this project, postpended with the build time
LABEL project.name="<%= projectName %>-<%= buildTimestamp %>" \
      project.base-name="<%= projectName %>" \
      project.build-time="<%= buildTimestamp %>"

# Set a docker label to enable container to use SAGEMAKER_BIND_TO_PORT environment variable if present
LABEL com.amazonaws.sagemaker.capabilities.accept-bind-to-port=true

# Set the model name for the diffusion model
ENV VLLM_MODEL="<%= modelName %>"

<% if (hfToken) { %>
# Set HuggingFace authentication token
ENV HF_TOKEN="<%= hfToken %>"
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

# Patch vLLM-Omni encode_image_base64 to handle numpy.ndarray outputs
# Some diffusion models return numpy arrays instead of PIL Images from their
# pipeline, which causes an AttributeError on .save() during response encoding.
# This patch adds a safe isinstance guard to convert ndarray → PIL.Image.
COPY code/patch_image_api.py /tmp/patch_image_api.py
RUN python3 /tmp/patch_image_api.py && rm /tmp/patch_image_api.py

# Install nginx for SageMaker endpoint routing
# Maps /invocations -> /v1/images/generations and /ping -> /health
RUN apt-get update && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

# Copy nginx configuration
COPY nginx-diffusors.conf /etc/nginx/nginx.conf

# Copy serve entrypoint and startup scripts
COPY code/cuda_compat.sh /usr/bin/cuda_compat.sh
COPY code/serve /usr/bin/serve
RUN chmod 777 /usr/bin/serve /usr/bin/cuda_compat.sh

COPY code/start_server.sh /usr/bin/start_server.sh
RUN chmod +x /usr/bin/start_server.sh

<% if (comments && comments.troubleshooting) { %>
<%= comments.troubleshooting %>
<% } %>

ENTRYPOINT [ "/usr/bin/serve" ]
