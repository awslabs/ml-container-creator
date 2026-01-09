# ML Container Creator - Examples

This guide provides step-by-step examples for common use cases.

## Table of Contents

- [Example 1: Deploy a scikit-learn Model](#example-1-deploy-a-scikit-learn-model)
- [Example 2: Deploy an XGBoost Model](#example-2-deploy-an-xgboost-model)
- [Example 3: Deploy a TensorFlow Model](#example-3-deploy-a-tensorflow-model)
- [Example 4: Deploy a Transformer Model (LLM)](#example-4-deploy-a-transformer-model-llm)
- [Example 5: Deploy with CodeBuild CI/CD](#example-5-deploy-with-codebuild-cicd)
- [Example 6: Custom Instance Types](#example-6-custom-instance-types)
- [Example 7: Custom Configuration](#example-7-custom-configuration)

---

## Example 1: Deploy a scikit-learn Model

### Scenario
You have a trained scikit-learn model saved as `model.pkl` and want to deploy it to SageMaker with Flask serving.

### Step 1: Generate Project

```bash
yo ml-container-creator
```

**Prompts and Answers:**
```
📋 Project Configuration
? What is the Project Name? sklearn-iris-classifier
? Where will the output directory be? ./sklearn-iris-classifier-2024-12-02

🔧 Core Configuration
? Which ML framework are you using? sklearn
? In which format is your model serialized? pkl
? Which model server are you serving with? flask

📦 Module Selection
? Include sample Abalone classifier? No
? Include test suite? Yes
? Test type? local-model-cli, local-model-server, hosted-model-endpoint

💪 Infrastructure & Performance
? Deployment target? sagemaker
? Instance type? cpu-optimized
? Target AWS region? us-east-1
```

### Step 2: Add Your Model

```bash
cd sklearn-iris-classifier-2024-12-02
cp /path/to/your/model.pkl code/model.pkl
```

### Step 3: Test Locally

```bash
# Build Docker image
docker build -t sklearn-iris-classifier .

# Run container locally
docker run -p 8080:8080 sklearn-iris-classifier

# Test in another terminal
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[5.1, 3.5, 1.4, 0.2]]}'
```

### Step 4: Deploy to SageMaker

```bash
# Build and push to ECR
./deploy/build_and_push.sh

# Deploy to SageMaker (replace with your IAM role ARN)
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerExecutionRole
```

### Step 5: Test Endpoint

```bash
# Test the deployed endpoint
./test/test_endpoint.sh sklearn-iris-classifier
```

---

## Example 2: Deploy an XGBoost Model

### Scenario
You have an XGBoost model saved in JSON format for a regression task.

### Step 1: Generate Project

```bash
yo ml-container-creator
```

**Configuration:**
- Project Name: `xgboost-house-prices`
- Framework: `xgboost`
- Model Format: `json`
- Model Server: `fastapi`
- Include sample model: `No`
- Include tests: `Yes`
- Instance type: `cpu-optimized`

### Step 2: Prepare Model

```python
# Save your XGBoost model in JSON format
import xgboost as xgb

# Train your model
model = xgb.XGBRegressor()
model.fit(X_train, y_train)

# Save as JSON
model.save_model('model.json')
```

```bash
# Copy to project
cp model.json xgboost-house-prices-*/code/model.json
```

### Step 3: Customize Inference (Optional)

Edit `code/model_handler.py` to customize preprocessing:

```python
def preprocess(data):
    """Custom preprocessing for house price features."""
    # Add your preprocessing logic
    return processed_data
```

### Step 4: Deploy

```bash
cd xgboost-house-prices-*
./deploy/build_and_push.sh
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerExecutionRole
```

---

## Example 3: Deploy a TensorFlow Model

### Scenario
You have a TensorFlow Keras model for image classification.

### Step 1: Generate Project

**Configuration:**
- Project Name: `tensorflow-image-classifier`
- Framework: `tensorflow`
- Model Format: `SavedModel`
- Model Server: `flask`
- Include sample model: `No`
- Include tests: `Yes`
- Instance type: `gpu-enabled`

### Step 2: Save Model in SavedModel Format

```python
import tensorflow as tf

# Train your model
model = tf.keras.Sequential([...])
model.compile(...)
model.fit(X_train, y_train)

# Save as SavedModel
model.save('saved_model')
```

```bash
# Copy to project
cp -r saved_model tensorflow-image-classifier-*/code/
```

### Step 3: Update Model Handler

Edit `code/model_handler.py` to handle image preprocessing:

```python
import numpy as np
from PIL import Image
import io

def preprocess(data):
    """Preprocess image data."""
    # Decode base64 image
    image = Image.open(io.BytesIO(data))
    # Resize and normalize
    image = image.resize((224, 224))
    image_array = np.array(image) / 255.0
    return np.expand_dims(image_array, axis=0)
```

### Step 4: Deploy to GPU Instance

```bash
cd tensorflow-image-classifier-*
./deploy/build_and_push.sh
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerExecutionRole
```

The deployment script will automatically select a GPU instance (ml.g4dn.xlarge) based on your configuration.

---

## Example 4: Deploy a Transformer Model (LLM)

### Scenario
You want to deploy a Llama 2 7B model using vLLM for efficient inference.

### Step 1: Generate Project

**Configuration:**
- Project Name: `llama2-7b-chat`
- Framework: `transformers`
- Model Server: `vllm`
- Include sample model: `No` (not applicable)
- Include tests: `Yes`
- Test types: `hosted-model-endpoint` (only option)
- Instance type: `gpu-enabled` (required)

### Step 2: Prepare Model Files

Option A: Download from Hugging Face Hub
```bash
cd llama2-7b-chat-*

# Install huggingface-cli
pip install huggingface-hub

# Download model (requires HF token for gated models)
huggingface-cli login
huggingface-cli download meta-llama/Llama-2-7b-chat-hf --local-dir ./model
```

Option B: Use existing local model
```bash
cp -r /path/to/llama2-model/* llama2-7b-chat-*/model/
```

### Step 3: Upload Model to S3

```bash
cd llama2-7b-chat-*

# Upload model to S3 (script will prompt for bucket name)
./deploy/upload_to_s3.sh
```

### Step 4: Update Dockerfile

Edit `Dockerfile` to specify model location:

```dockerfile
# Set model path (S3 or local)
ENV MODEL_NAME="meta-llama/Llama-2-7b-chat-hf"
# Or for S3: ENV MODEL_NAME="s3://my-bucket/models/llama2-7b"
```

### Step 5: Deploy

```bash
./deploy/build_and_push.sh
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerExecutionRole
```

**Note:** Transformer deployments require:
- GPU instance (defaults to `ml.g6.12xlarge` for optimal performance)
- Sufficient memory for model size
- S3 access permissions in IAM role

### Step 6: Test Inference

```bash
# Test the endpoint
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name llama2-7b-chat \
  --content-type application/json \
  --body '{"inputs": "What is machine learning?", "parameters": {"max_new_tokens": 100}}' \
  output.json

cat output.json
```

---

## Example 5: Deploy with CodeBuild CI/CD

### Scenario
You want to set up an enterprise-ready CI/CD pipeline using AWS CodeBuild for automated Docker image building and deployment.

### Step 1: Generate Project with CodeBuild

```bash
# Using CLI for automation
yo ml-container-creator sklearn-codebuild-project \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --deploy-target=codebuild \
  --codebuild-compute-type=BUILD_GENERAL1_MEDIUM \
  --include-testing \
  --skip-prompts
```

### Step 2: Review Generated Files

The CodeBuild deployment includes additional files:

```bash
cd sklearn-codebuild-project
ls -la

# CodeBuild-specific files:
# - buildspec.yml (CodeBuild build specification)
# - deploy/submit_build.sh (Submit build job script)
# - IAM_PERMISSIONS.md (Required IAM permissions documentation)

# Standard files:
# - Dockerfile, requirements.txt, code/, test/
# - deploy/deploy.sh (SageMaker deployment script)
```

### Step 3: Add Your Model

```bash
# Copy your trained model
cp /path/to/your/model.pkl code/

# Test locally (optional)
python test/test_local_model_cli.py
```

### Step 4: Submit CodeBuild Job

```bash
# This script will:
# 1. Create shared ECR repository (ml-container-creator) if needed
# 2. Create CodeBuild service role with required permissions
# 3. Create CodeBuild project with auto-generated name
# 4. Upload source code to S3
# 5. Start build job and monitor progress

./deploy/submit_build.sh
```

**Expected Output:**
```
🏗️  Submitting CodeBuild job...
Project: sklearn-codebuild-project-sklearn-build-20240102
Region: us-east-1
Compute Type: BUILD_GENERAL1_MEDIUM
ECR Repository: ml-container-creator

📦 Checking ECR repository...
✅ ECR repository already exists: ml-container-creator

🔐 Checking CodeBuild service role...
✅ CodeBuild service role already exists

🏗️  Checking CodeBuild project...
✅ CodeBuild project already exists

🚀 Starting CodeBuild job...
Build started with ID: sklearn-codebuild-project-sklearn-build-20240102:abc123

⏳ Monitoring build progress...
📋 Build status: IN_PROGRESS | Phase: PROVISIONING
📋 Build status: IN_PROGRESS | Phase: BUILD
📋 Build status: SUCCEEDED | Phase: COMPLETED

✅ Build completed successfully!
🐳 Docker image available at: 123456789012.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:sklearn-codebuild-project-latest
```

### Step 5: Deploy to SageMaker

```bash
# Deploy the CodeBuild-generated image to SageMaker
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerExecutionRole
```

### Step 6: Test the Endpoint

```bash
# Test the deployed endpoint
python test/test_hosted_model_endpoint.py
```

### CodeBuild Features

#### Shared ECR Repository
All ML Container Creator projects use a single ECR repository (`ml-container-creator`) with project-specific tags:
- `{project-name}-latest` - Latest build for the project
- `{project-name}-YYYYMMDD-HHMMSS` - Timestamped builds
- `latest` - Global latest across all projects

#### Automatic Infrastructure
The `submit_build.sh` script automatically creates:
- **CodeBuild Project**: Auto-generated name with pattern `{project}-{framework}-build-{YYYYMMDD}`
- **IAM Service Role**: With ECR, S3, and CloudWatch permissions
- **S3 Bucket**: For source code uploads (`codebuild-source-{account-id}-{region}`)

#### Build Monitoring
- Real-time build status updates
- CloudWatch logs integration
- Build failure detection with log retrieval
- Console links for detailed monitoring

### Troubleshooting

#### Build Fails
```bash
# Check CloudWatch logs
aws logs tail /aws/codebuild/your-project-name --follow

# Check IAM permissions
cat IAM_PERMISSIONS.md
```

#### Permission Issues
```bash
# Verify your AWS credentials have required permissions
aws sts get-caller-identity

# Check the IAM_PERMISSIONS.md file for required policies
```

---

## Example 6: Custom Instance Types

### Scenario
You want to optimize costs and performance by using specific AWS instance types for different deployment scenarios.

### Example 6a: Development with Low-Cost Instance

```bash
# Generate project with small instance for development
yo ml-container-creator dev-sklearn-model \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --instance-type=custom \
  --custom-instance-type=ml.t3.medium \
  --include-testing \
  --skip-prompts
```

**Benefits:**
- **ml.t3.medium**: 2 vCPU, 4 GB RAM - ~$0.05/hour
- Perfect for development and testing
- Burstable performance for intermittent workloads

### Example 6b: Inference Optimization with AWS Inferentia

```bash
# Generate project optimized for AWS Inferentia chips
yo ml-container-creator inferentia-model \
  --framework=tensorflow \
  --model-server=flask \
  --model-format=SavedModel \
  --instance-type=custom \
  --custom-instance-type=ml.inf1.xlarge \
  --skip-prompts
```

**Benefits:**
- **ml.inf1.xlarge**: AWS Inferentia chip - Up to 80% cost savings for inference
- Optimized for high-throughput, low-latency inference
- Best for production inference workloads

### Example 6c: High-Memory Workloads

```bash
# Generate project for memory-intensive models
yo ml-container-creator memory-intensive-model \
  --framework=sklearn \
  --model-server=fastapi \
  --model-format=pkl \
  --instance-type=custom \
  --custom-instance-type=ml.r5.xlarge \
  --skip-prompts
```

**Benefits:**
- **ml.r5.xlarge**: 4 vCPU, 32 GB RAM - Memory-optimized
- Ideal for large feature sets or ensemble models
- Better performance for memory-bound workloads

### Example 6d: Network-Optimized Inference

```bash
# Generate project for high-throughput inference
yo ml-container-creator high-throughput-model \
  --framework=xgboost \
  --model-server=fastapi \
  --model-format=json \
  --instance-type=custom \
  --custom-instance-type=ml.c5n.xlarge \
  --skip-prompts
```

**Benefits:**
- **ml.c5n.xlarge**: 4 vCPU, 10.5 GB RAM - Network-optimized
- Up to 25 Gbps network performance
- Ideal for high-throughput, low-latency applications

### Example 6e: Single GPU for Smaller Models

```bash
# Generate project with single GPU for cost-effective deep learning
yo ml-container-creator single-gpu-model \
  --framework=tensorflow \
  --model-server=flask \
  --model-format=SavedModel \
  --instance-type=custom \
  --custom-instance-type=ml.g4dn.xlarge \
  --skip-prompts
```

**Benefits:**
- **ml.g4dn.xlarge**: 1 GPU (16GB), 4 vCPU - Cost-effective GPU
- 50% cheaper than ml.g5.xlarge
- Sufficient for smaller deep learning models

### Configuration File Approach

Create reusable configurations for different environments:

#### Development Configuration (`dev-config.json`)
```json
{
  "instanceType": "custom",
  "customInstanceType": "ml.t3.medium",
  "awsRegion": "us-east-1",
  "includeTesting": true
}
```

#### Production Configuration (`prod-config.json`)
```json
{
  "instanceType": "custom", 
  "customInstanceType": "ml.inf1.xlarge",
  "awsRegion": "us-west-2",
  "includeTesting": false
}
```

#### Usage
```bash
# Development deployment
yo ml-container-creator --config=dev-config.json --framework=sklearn --skip-prompts

# Production deployment  
yo ml-container-creator --config=prod-config.json --framework=sklearn --skip-prompts
```

### Environment Variable Approach

Set instance types via environment variables:

```bash
# Development environment
export ML_INSTANCE_TYPE=custom
export ML_CUSTOM_INSTANCE_TYPE=ml.t3.medium
export AWS_REGION=us-east-1

# Production environment
export ML_INSTANCE_TYPE=custom
export ML_CUSTOM_INSTANCE_TYPE=ml.inf1.xlarge
export AWS_REGION=us-west-2

# Generate project (inherits environment config)
yo ml-container-creator --framework=sklearn --model-server=flask --skip-prompts
```

### Cost Comparison

| Instance Type | vCPU | Memory | GPU | Cost/Hour* | Use Case |
|---------------|------|--------|-----|------------|----------|
| ml.t3.medium | 2 | 4 GB | - | $0.05 | Development |
| ml.m6g.large | 2 | 8 GB | - | $0.08 | Small production |
| ml.m5.xlarge | 4 | 16 GB | - | $0.23 | Medium workloads |
| ml.g4dn.xlarge | 4 | 16 GB | 1 | $0.53 | GPU inference |
| ml.g5.xlarge | 4 | 16 GB | 1 | $1.01 | GPU inference |
| ml.inf1.xlarge | 4 | 8 GB | Inferentia | $0.23 | Optimized inference |
| ml.r5.xlarge | 4 | 32 GB | - | $0.30 | Memory-intensive |

*Approximate costs in us-east-1 region

### Instance Type Selection Guide

```bash
# Choose based on your requirements:

# 💰 Cost-sensitive development
--custom-instance-type=ml.t3.medium

# 🚀 High-performance inference  
--custom-instance-type=ml.inf1.xlarge

# 🧠 Memory-intensive models
--custom-instance-type=ml.r5.xlarge

# 🌐 High-throughput APIs
--custom-instance-type=ml.c5n.xlarge

# 🎮 GPU acceleration (budget)
--custom-instance-type=ml.g4dn.xlarge

# 🎮 GPU acceleration (performance)
--custom-instance-type=ml.g5.xlarge
```

### Validation and Troubleshooting

The generator validates custom instance types:

```bash
# Valid format
yo ml-container-creator --instance-type=custom --custom-instance-type=ml.g4dn.xlarge ✅

# Invalid format
yo ml-container-creator --instance-type=custom --custom-instance-type=invalid-type ❌
# Error: Invalid custom instance type format: invalid-type
```

#### Common Issues

**Issue: Instance type not available in region**
```bash
# Check instance availability
aws ec2 describe-instance-type-offerings \
  --location-type availability-zone \
  --filters Name=instance-type,Values=ml.inf1.xlarge \
  --region us-west-2
```

**Issue: Insufficient permissions**
```bash
# Ensure your IAM role has SageMaker permissions for the instance type
# Some instance types require special permissions
```

---

## Example 7: Custom Configuration

### Scenario
You want to customize the generated project for specific requirements.

### Custom Requirements File

After generation, edit `requirements.txt`:

```txt
# Add custom dependencies
flask==2.3.0
scikit-learn==1.3.0
pandas==2.0.0
numpy==1.24.0

# Add your custom packages
my-custom-preprocessing==1.0.0
```

### Custom Model Handler

Edit `code/model_handler.py`:

```python
import logging
import numpy as np
from typing import Any, Dict

logger = logging.getLogger(__name__)

class ModelHandler:
    """Custom model handler with advanced preprocessing."""
    
    def __init__(self, model_path: str):
        self.model = self._load_model(model_path)
        self.preprocessor = self._load_preprocessor()
    
    def _load_model(self, path: str):
        """Load model with custom logic."""
        logger.info(f"Loading model from {path}")
        # Your custom loading logic
        return model
    
    def _load_preprocessor(self):
        """Load custom preprocessor."""
        # Your preprocessing pipeline
        return preprocessor
    
    def preprocess(self, data: Dict[str, Any]) -> np.ndarray:
        """Custom preprocessing logic."""
        # Feature engineering
        # Normalization
        # Encoding
        return processed_data
    
    def predict(self, data: np.ndarray) -> np.ndarray:
        """Run inference with custom post-processing."""
        predictions = self.model.predict(data)
        # Custom post-processing
        return predictions
```

### Custom Nginx Configuration

Edit `nginx.conf` for custom timeouts:

```nginx
http {
    # Increase timeout for slow models
    proxy_read_timeout 300s;
    proxy_connect_timeout 300s;
    
    # Increase buffer sizes for large payloads
    client_max_body_size 10M;
    
    upstream gunicorn {
        server unix:/tmp/gunicorn.sock;
    }
    
    server {
        listen 8080 deferred;
        client_max_body_size 10M;
        
        location ~ ^/(ping|invocations) {
            proxy_pass http://gunicorn;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header Host $http_host;
            proxy_redirect off;
        }
    }
}
```

### Custom Deployment Script

Edit `deploy/deploy.sh` to customize instance type:

```bash
#!/bin/bash

# Use larger instance for production
INSTANCE_TYPE="ml.m5.2xlarge"
INSTANCE_COUNT=2  # Multiple instances for HA

# Create endpoint configuration with auto-scaling
aws sagemaker create-endpoint-config \
  --endpoint-config-name ${PROJECT_NAME}-config \
  --production-variants \
    VariantName=AllTraffic,\
    ModelName=${PROJECT_NAME}-model,\
    InstanceType=${INSTANCE_TYPE},\
    InitialInstanceCount=${INSTANCE_COUNT}
```

### Custom Instance Types

Use the custom instance type option for specialized hardware:

```bash
# Generate project with custom instance type
yo ml-container-creator my-optimized-model \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --instance-type=custom \
  --custom-instance-type=ml.inf1.xlarge \
  --skip-prompts
```

#### Popular Custom Instance Types

```bash
# AWS Inferentia for optimized inference
--custom-instance-type=ml.inf1.xlarge

# Development/testing with lower cost
--custom-instance-type=ml.t3.medium

# High-memory workloads
--custom-instance-type=ml.r5.xlarge

# Network-optimized inference
--custom-instance-type=ml.c5n.xlarge

# Single GPU for smaller models
--custom-instance-type=ml.g4dn.xlarge
```

#### Configuration File Example

```json
{
  "projectName": "optimized-inference",
  "framework": "tensorflow",
  "modelServer": "flask",
  "modelFormat": "SavedModel",
  "instanceType": "custom",
  "customInstanceType": "ml.inf1.xlarge",
  "awsRegion": "us-east-1"
}
```

---

## Common Patterns

### Pattern 1: Multi-Model Endpoint

Deploy multiple models to the same endpoint:

```python
# code/model_handler.py
class MultiModelHandler:
    def __init__(self):
        self.models = {
            'model_a': load_model('model_a.pkl'),
            'model_b': load_model('model_b.pkl')
        }
    
    def predict(self, data):
        model_name = data.get('model', 'model_a')
        return self.models[model_name].predict(data['input'])
```

### Pattern 2: Batch Prediction

Handle batch requests efficiently:

```python
def predict(self, data):
    """Handle batch predictions."""
    instances = data.get('instances', [])
    
    # Process in batches
    batch_size = 32
    predictions = []
    
    for i in range(0, len(instances), batch_size):
        batch = instances[i:i+batch_size]
        batch_pred = self.model.predict(batch)
        predictions.extend(batch_pred)
    
    return predictions
```

### Pattern 3: A/B Testing

Deploy multiple variants:

```bash
# Create endpoint config with multiple variants
aws sagemaker create-endpoint-config \
  --endpoint-config-name ab-test-config \
  --production-variants \
    VariantName=VariantA,ModelName=model-v1,InstanceType=ml.m5.xlarge,InitialInstanceCount=1,InitialVariantWeight=50 \
    VariantName=VariantB,ModelName=model-v2,InstanceType=ml.m5.xlarge,InitialInstanceCount=1,InitialVariantWeight=50
```

---

## Troubleshooting Examples

### Issue: Model File Not Found

**Error:**
```
FileNotFoundError: Model not found at /opt/ml/model/model.pkl
```

**Solution:**
```bash
# Verify model file is in correct location
ls -la code/
# Should show: model.pkl

# Rebuild container
docker build -t my-model .

# Verify model is in container
docker run my-model ls -la /opt/ml/model/
```

### Issue: Out of Memory

**Error:**
```
Container killed due to memory limit
```

**Solution:**
```bash
# Use larger instance type
# Edit deploy/deploy.sh
INSTANCE_TYPE="ml.m5.2xlarge"  # 32GB RAM instead of 16GB

# Or optimize model
# Use model quantization or pruning
```

### Issue: Slow Inference

**Problem:** Predictions take too long

**Solution:**
```python
# Load model once at startup, not per request
class ModelHandler:
    def __init__(self):
        self.model = load_model()  # Load once
    
    def predict(self, data):
        return self.model.predict(data)  # Reuse loaded model

# Use batch prediction
# Enable GPU acceleration
# Consider model optimization (ONNX, TensorRT)
```

---

## Next Steps

- Review [Project Documentation](https://github.com/awslabs/ml-container-creator)
- Check [Project Architecture](architecture.md) for detailed context
- Explore [Template Documentation](template-system.md)
- Read [AWS SageMaker Documentation](https://docs.aws.amazon.com/sagemaker/)

## Contributing Examples

Have a useful example? Please contribute!

1. Fork the repository
2. Add your example to this file
3. Test the example end-to-end
4. Submit a pull request

Include:
- Clear scenario description
- Step-by-step instructions
- Expected output
- Common issues and solutions
