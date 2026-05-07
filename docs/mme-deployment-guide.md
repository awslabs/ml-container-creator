# Multi-Model Endpoint (MME) Deployment Guide

This guide walks through generating a SageMaker-compatible container project using ML Container Creator, then modifying the generated assets to support [Multi-Model Endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/multi-model-endpoints.html) deployments.

> **What is MME?** Multi-Model Endpoints let you host many models behind a single SageMaker endpoint. Models are loaded and unloaded dynamically from S3 as they're invoked, sharing the same fleet of instances. This reduces cost and deployment overhead when you have many models of similar size and framework.

## Prerequisites

- Node.js 24+
- Docker 20+
- AWS CLI 2+ configured with appropriate credentials
- ML Container Creator installed (`npm link` from the repo root)

## Part 1: Generate the Base Project

This section recreates a `transformers-djl` project similar to the reference configuration. You can adapt the prompt selections to your needs.

### Run the Generator

```bash
ml-container-creator
```

### Prompt Selections

Walk through the interactive prompts with these selections:

| Phase | Prompt | Selection |
|-------|--------|-----------|
| Infrastructure | Deployment target | `managed-inference` |
| Infrastructure | Instance type | `ml.g5.12xlarge` (or appropriate GPU instance) |
| Infrastructure | Build target | `codebuild` |
| Core ML | Deployment configuration | `Transformers with DJL (Deep Java Library)` |
| Core ML | Model name | Your HuggingFace model ID (e.g., `openai/gpt-oss-20b`) |
| Core ML | HuggingFace token | Your token or `$HF_TOKEN` for env var |
| Module | Include testing | `Yes` |
| Project | Project name | Your project name (e.g., `bright-gpt-deployment`) |

### Verify the Generated Project

```bash
cd <your-project-name>
```

You should see this structure:

```
<project-name>/
├── Dockerfile
├── requirements.txt
├── buildspec.yml
├── code/
│   ├── serve
│   ├── serving.properties
│   └── start_server.sh
├── deploy/
│   ├── build_and_push.sh
│   ├── deploy.sh
│   └── upload_to_s3.sh
├── do/
│   ├── build
│   ├── push
│   ├── deploy
│   ├── run
│   ├── test
│   ├── clean
│   └── config
└── test/
    ├── test_endpoint.sh
    └── test_local_image.sh
```

### Build and Test Locally

```bash
./do/build
./do/run
# In another terminal:
curl http://localhost:8080/ping
```


## Part 2: Modify for Multi-Model Endpoint Deployment

MME requires specific container APIs and deployment configuration changes. The modifications below convert a single-model DJL container into an MME-capable deployment.

### Important: Framework Compatibility

Not all serving frameworks work with MME. Here's the compatibility matrix for images in this codebase:

| Serving Image | MME Support | Notes |
|---------------|-------------|-------|
| `triton-*` (all backends) | **GPU MME** | Only supported option for GPU-backed MME. Already uses model repository pattern. |
| `djl` / `lmi` | **CPU MME** | DJL Serving supports MMS contract via SageMaker Inference Toolkit. |
| `vllm` | No | Single-model architecture; dedicates all GPU memory to one model. |
| `sglang` | No | Single-model architecture. |
| `tensorrt-llm` | No | Single-model architecture; requires model compilation. |
| `vllm-omni` | No | Single-model architecture for diffusion models. |

> **Recommendation:** For GPU-backed MME, regenerate your project using a **Triton** deployment configuration instead of DJL. 

### Step 1: Modify the Dockerfile

Add the multi-model capability label so SageMaker knows this container supports MME:

```dockerfile
# Add after the FROM line
LABEL com.amazonaws.sagemaker.capabilities.multi-models=true
```

Change the model directory setup to support multiple models. SageMaker will mount model artifacts at `/opt/ml/models/<model_name>/model` (note the plural `models`):

```dockerfile
# Replace:
#   RUN mkdir -p /opt/ml/model
#   COPY code/serving.properties /opt/ml/model/serving.properties

# With:
RUN mkdir -p /opt/ml/models
COPY code/serving.properties /opt/ml/model/serving.properties
```

### Step 2: Modify `code/serving.properties`

Update the DJL serving configuration to handle dynamic model loading:

```properties
# LMI/DJL Serving Configuration for Multi-Model Endpoints

# Remove the fixed model_id — models are loaded dynamically
# option.model_id=openai/gpt-oss-20b    <-- DELETE this line

# Engine Selection
engine=Python

# Multi-model settings
# DJL will load models from /opt/ml/models/{model_name}/model
# Each model should have its own serving.properties or config
```

### Step 3: Modify `do/config`

Update the deployment configuration variables:

```bash
# Add these lines to do/config:

# Multi-Model Endpoint configuration
export MME_ENABLED="true"
export MODEL_DATA_URL="s3://YOUR-BUCKET/models/"  # S3 prefix containing model artifacts
```

### Step 4: Modify `do/deploy`

This is the most significant change. The deploy script needs to create the model with `Mode: MultiModel` and point `ModelDataUrl` to an S3 prefix rather than a single artifact.

Replace the inference component creation section in `do/deploy` with MME-specific deployment logic. Here are the key AWS CLI commands:

```bash
# ============================================================
# Multi-Model Endpoint Deployment
# ============================================================

# Step 1: Create the SageMaker Model with MultiModel mode
echo "📦 Creating SageMaker model: ${PROJECT_NAME}-model"
aws sagemaker create-model \
    --model-name "${PROJECT_NAME}-model-${TIMESTAMP}" \
    --execution-role-arn "${ROLE_ARN}" \
    --primary-container "{
        \"Image\": \"${ECR_REPOSITORY}:${IMAGE_TAG}\",
        \"Mode\": \"MultiModel\",
        \"ModelDataUrl\": \"${MODEL_DATA_URL}\"
    }" \
    --region "${AWS_REGION}"

# Step 2: Create endpoint configuration (at least 2 instances recommended)
echo "⚙️  Creating endpoint configuration: ${ENDPOINT_CONFIG_NAME}"
aws sagemaker create-endpoint-config \
    --endpoint-config-name "${ENDPOINT_CONFIG_NAME}" \
    --production-variants "[{
        \"VariantName\": \"AllTraffic\",
        \"ModelName\": \"${PROJECT_NAME}-model-${TIMESTAMP}\",
        \"InstanceType\": \"${INSTANCE_TYPE}\",
        \"InitialInstanceCount\": 2,
        \"InitialVariantWeight\": 1
    }]" \
    --region "${AWS_REGION}"

# Step 3: Create the endpoint
echo "🚀 Creating endpoint: ${ENDPOINT_NAME}"
aws sagemaker create-endpoint \
    --endpoint-name "${ENDPOINT_NAME}" \
    --endpoint-config-name "${ENDPOINT_CONFIG_NAME}" \
    --region "${AWS_REGION}"

# Step 4: Wait for endpoint
echo "⏳ Waiting for endpoint to reach InService status..."
aws sagemaker wait endpoint-in-service \
    --endpoint-name "${ENDPOINT_NAME}" \
    --region "${AWS_REGION}"

echo "✅ Multi-Model Endpoint is InService: ${ENDPOINT_NAME}"
```

> **Key difference from single-model deploy:** MME uses `create-model` with `Mode: MultiModel` and a `ModelDataUrl` pointing to an S3 prefix. It does NOT use inference components — the endpoint manages model loading/unloading automatically.

### Step 5: Prepare Model Artifacts in S3

Each model must be packaged as a `.tar.gz` archive and uploaded to the S3 prefix you specified in `ModelDataUrl`:

```bash
# Package a model
cd /path/to/model-artifacts
tar -czf model-a.tar.gz *

# Upload to the S3 prefix
aws s3 cp model-a.tar.gz s3://YOUR-BUCKET/models/model-a.tar.gz
aws s3 cp model-b.tar.gz s3://YOUR-BUCKET/models/model-b.tar.gz
```

For DJL/LMI models, each `.tar.gz` should contain a `serving.properties` file and any model artifacts:

```
model-a.tar.gz
├── serving.properties    # Model-specific DJL config
├── config.json           # HuggingFace model config
├── tokenizer.json
└── model.safetensors     # (or downloaded from HF Hub)
```

### Step 6: Modify `test/test_endpoint.sh`

Update the test script to use the `--target-model` parameter:

```bash
# Invoke a specific model on the MME
aws sagemaker-runtime invoke-endpoint \
    --endpoint-name "${ENDPOINT_NAME}" \
    --content-type "application/json" \
    --target-model "model-a.tar.gz" \
    --body '{
        "inputs": "Hello, how are you?",
        "parameters": {
            "max_new_tokens": 100,
            "temperature": 0.7
        }
    }' \
    --region "${AWS_REGION}" \
    response.json

echo "Response:"
cat response.json
```

The `--target-model` value is the relative path of the model artifact within the S3 prefix.

### Step 7: Add/Remove Models Without Redeploying

One of MME's best features — you don't need to update the endpoint to add or remove models:

```bash
# Add a new model — just upload to S3
aws s3 cp model-c.tar.gz s3://YOUR-BUCKET/models/model-c.tar.gz

# Invoke it immediately (first call has cold-start latency)
aws sagemaker-runtime invoke-endpoint \
    --endpoint-name "${ENDPOINT_NAME}" \
    --target-model "model-c.tar.gz" \
    --content-type "application/json" \
    --body '{"inputs": "test"}' \
    response.json

# Remove a model — delete from S3 and stop sending requests
aws s3 rm s3://YOUR-BUCKET/models/model-c.tar.gz
```


## Part 3: GPU MME with Triton

If your use case requires GPU, consider using a Triton configuration instead.

### Regenerate with Triton

```bash
ml-container-creator
```

Select a Triton deployment configuration:

| Prompt | Selection |
|--------|-----------|
| Deployment configuration | `Triton FIL` (tree models), `Triton ONNX Runtime`, `Triton PyTorch`, `Triton TensorFlow`, `Triton vLLM`, or `Triton TensorRT-LLM` |
| Instance type | GPU instance from the supported list (e.g., `ml.g5.xlarge`, `ml.g4dn.xlarge`) |

### Triton Model Repository Structure

Triton uses a model repository layout that maps naturally to MME. Each model artifact `.tar.gz` should contain:

```
model-a.tar.gz
└── model_repository/
    └── model-a/
        ├── config.pbtxt        # Triton model configuration
        └── 1/                  # Version directory
            └── model.onnx      # (or model.pt, model.savedmodel/, xgboost.json, etc.)
```

### Triton Dockerfile Changes

The Triton base image (`nvcr.io/nvidia/tritonserver:24.08-py3`) already supports multi-model serving. Add the MME label:

```dockerfile
FROM nvcr.io/nvidia/tritonserver:24.08-py3

LABEL com.amazonaws.sagemaker.capabilities.multi-models=true

# SageMaker will set SAGEMAKER_MULTI_MODEL=true automatically
# Models are loaded to /opt/ml/models/{model_name}/model
ENV TRITON_MODEL_REPOSITORY=/opt/ml/model/model_repository
```

### Supported GPU Instance Types for MME

| Family | Instance | GPUs | GPU Memory |
|--------|----------|------|------------|
| g4dn | ml.g4dn.xlarge – ml.g4dn.16xlarge | 1 | 16 GB (T4) |
| g5 | ml.g5.xlarge – ml.g5.16xlarge | 1 | 24 GB (A10G) |
| p2 | ml.p2.xlarge | 1 | 12 GB (K80) |
| p3 | ml.p3.2xlarge | 1 | 16 GB (V100) |

## Operational Considerations

### Cold Starts

The first invocation of a model has higher latency because SageMaker must download it from S3 and load it into the container. Subsequent calls to a cached model are fast. If a model takes longer than 60 seconds to load, you'll get a `ModelNotReadyException` — implement retry logic (the AWS SDKs handle this by default).

### Model Caching

Model caching is enabled by default. To disable it (models are evicted after each invocation):

```bash
aws sagemaker create-model \
    --model-name "my-model" \
    --primary-container "{
        \"Image\": \"...\",
        \"Mode\": \"MultiModel\",
        \"ModelDataUrl\": \"s3://bucket/models/\",
        \"MultiModelConfig\": {
            \"ModelCacheSetting\": \"Disabled\"
        }
    }" \
    --execution-role-arn "${ROLE_ARN}"
```

### Auto Scaling

MME supports auto scaling. Configure it based on invocations per instance:

```bash
aws application-autoscaling register-scalable-target \
    --service-namespace sagemaker \
    --resource-id "endpoint/${ENDPOINT_NAME}/variant/AllTraffic" \
    --scalable-dimension "sagemaker:variant:DesiredInstanceCount" \
    --min-capacity 2 \
    --max-capacity 10

aws application-autoscaling put-scaling-policy \
    --policy-name "mme-scaling-policy" \
    --service-namespace sagemaker \
    --resource-id "endpoint/${ENDPOINT_NAME}/variant/AllTraffic" \
    --scalable-dimension "sagemaker:variant:DesiredInstanceCount" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration '{
        "TargetValue": 1000,
        "PredefinedMetricSpecification": {
            "PredefinedMetricType": "SageMakerVariantInvocationsPerInstance"
        }
    }'
```

### CloudWatch Metrics

MME provides additional CloudWatch metrics beyond standard endpoints:

- `ModelLoadingWaitTime` — time spent waiting for model to load
- `ModelUnloadingTime` — time to unload a model
- `ModelCacheHit` — whether the invoked model was already in memory
- `LoadedModelCount` — number of models currently loaded

### Cleanup

```bash
# Delete the endpoint
aws sagemaker delete-endpoint --endpoint-name "${ENDPOINT_NAME}"
aws sagemaker delete-endpoint-config --endpoint-config-name "${ENDPOINT_CONFIG_NAME}"
aws sagemaker delete-model --model-name "${PROJECT_NAME}-model-${TIMESTAMP}"

# Or use the do-framework
./do/clean endpoint
```

## Further Reading

- [SageMaker Multi-Model Endpoints](https://docs.aws.amazon.com/sagemaker/latest/dg/multi-model-endpoints.html)
- [Build Your Own Container for MME](https://docs.aws.amazon.com/sagemaker/latest/dg/build-multi-model-build-container.html)
- [Custom Container Contract for MME](https://docs.aws.amazon.com/sagemaker/latest/dg/mms-container-apis.html)
- [Supported Frameworks and Instances](https://docs.aws.amazon.com/sagemaker/latest/dg/multi-model-support.html)
- [MME Sample Notebooks](https://sagemaker-examples.readthedocs.io/en/latest/advanced_functionality/multi_model_xgboost_home_value/xgboost_multi_model_endpoint_home_value.html)
