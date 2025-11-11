# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
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

COPY nginx.conf /etc/nginx/nginx.conf

# REPLACE WITH YOUR MODEL FILE
<% if (modelFormat === 'SavedModel') { %>
COPY "sample_model/abalone_model" /opt/ml/model
<% } else { %>
COPY "sample_model/abalone_model.<%=modelFormat%>" /opt/ml/model
<% } %>

# Set environment variables for SageMaker
ENV PYTHONPATH=/opt/ml/code:$PYTHONPATH
ENV SAGEMAKER_BIND_TO_PORT=$SAGEMAKER_BIND_TO_PORT

# Expose port $SAGEMAKER_BIND_TO_PORT for SageMaker inference
#EXPOSE $SAGEMAKER_BIND_TO_PORT
EXPOSE 8080

# Set the inference script as the entry point
RUN chmod +x code/start_server.py
ENTRYPOINT ["python", "/opt/ml/code/start_server.py"]
<% } else { %>
<% if (modelServer === 'vllm') { %>
# https://github.com/aws-samples/sagemaker-genai-hosting-examples/tree/main/OpenAI/gpt-oss/deploy/docker
ARG BASE_IMAGE=vllm/vllm-openai:v0.10.1
<% } else if (modelServer === 'sglang') { %>
ARG BASE_IMAGE=lmsysorg/sglang:v0.5.4.post1
<% } %>

FROM ${BASE_IMAGE}

COPY code/serve /usr/bin/serve
RUN chmod 777 /usr/bin/serve

ENTRYPOINT [ "/usr/bin/serve" ]

<% } %>
