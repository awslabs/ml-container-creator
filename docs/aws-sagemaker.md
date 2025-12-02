# AWS SageMaker BYOC Context

## SageMaker Container Requirements

### Mandatory Endpoints
All SageMaker inference containers must implement:

1. **`/ping` (GET)** - Health check endpoint
   - Returns 200 if container is healthy
   - Called periodically by SageMaker
   - Should be lightweight and fast

2. **`/invocations` (POST)** - Inference endpoint
   - Receives prediction requests
   - Returns predictions
   - Must handle the content-type specified in request

### Container Specifications
- **Port**: Must listen on port 8080
- **Model location**: `/opt/ml/model/` (SageMaker mounts model artifacts here)
- **Timeout**: Respond to /ping within 2 seconds
- **Memory**: Container should handle OOM gracefully

### Environment Variables
SageMaker provides these environment variables:
```bash
SM_MODEL_DIR=/opt/ml/model          # Model artifacts location
SM_NUM_GPUS=1                       # Number of GPUs available
SM_NUM_CPUS=4                       # Number of CPUs available
SM_LOG_LEVEL=INFO                   # Logging level
SM_NETWORK_INTERFACE_NAME=eth0      # Network interface
```

## Deployment Architecture

### Standard Flow
```
1. Build Docker Image
   └─> docker build -t my-model .

2. Push to ECR
   ├─> aws ecr create-repository
   ├─> docker tag my-model:latest <ecr-url>
   └─> docker push <ecr-url>

3. Create SageMaker Model
   └─> aws sagemaker create-model
       ├─> ModelName
       ├─> ExecutionRoleArn
       └─> PrimaryContainer
           ├─> Image (ECR URL)
           └─> ModelDataUrl (S3 path, optional)

4. Create Endpoint Configuration
   └─> aws sagemaker create-endpoint-config
       ├─> EndpointConfigName
       └─> ProductionVariants
           ├─> InstanceType
           ├─> InitialInstanceCount
           └─> ModelName

5. Create Endpoint
   └─> aws sagemaker create-endpoint
       ├─> EndpointName
       └─> EndpointConfigName

6. Wait for Endpoint
   └─> aws sagemaker describe-endpoint
       └─> Status: InService
```

### Transformer Models Flow (Additional Step)
```
0. Upload Model to S3
   └─> aws s3 cp model/ s3://bucket/model/ --recursive

Then follow standard flow with ModelDataUrl pointing to S3
```

## IAM Permissions

### Required SageMaker Execution Role Permissions
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-model-bucket/*",
        "arn:aws:s3:::my-model-bucket"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
```

### Required User/CI Permissions
```json
{
  "Effect": "Allow",
  "Action": [
    "ecr:CreateRepository",
    "ecr:PutImage",
    "ecr:InitiateLayerUpload",
    "ecr:UploadLayerPart",
    "ecr:CompleteLayerUpload",
    "sagemaker:CreateModel",
    "sagemaker:CreateEndpointConfig",
    "sagemaker:CreateEndpoint",
    "sagemaker:DescribeEndpoint",
    "sagemaker:DeleteEndpoint",
    "sagemaker:DeleteEndpointConfig",
    "sagemaker:DeleteModel",
    "iam:PassRole"
  ],
  "Resource": "*"
}
```

## Instance Types

### CPU-Optimized Instances
- **ml.m5.xlarge** - 4 vCPU, 16 GB RAM - Good for small models
- **ml.m5.2xlarge** - 8 vCPU, 32 GB RAM - Medium models
- **ml.m5.4xlarge** - 16 vCPU, 64 GB RAM - Large models
- **ml.c5.xlarge** - 4 vCPU, 8 GB RAM - Compute-intensive

### GPU-Enabled Instances
- **ml.g4dn.xlarge** - 1 GPU (16GB), 4 vCPU - Small LLMs
- **ml.g4dn.2xlarge** - 1 GPU (16GB), 8 vCPU - Medium LLMs
- **ml.g5.xlarge** - 1 GPU (24GB), 4 vCPU - Larger models
- **ml.g5.2xlarge** - 1 GPU (24GB), 8 vCPU - Better performance
- **ml.p3.2xlarge** - 1 GPU (16GB V100) - Training/large inference
- **ml.p4d.24xlarge** - 8 GPUs (40GB A100) - Very large models

### Cost Considerations
- Start with smallest instance that fits your model
- Use CPU instances for traditional ML (sklearn, xgboost)
- Use GPU instances for deep learning and transformers
- Consider multi-model endpoints for cost optimization

## Model Artifacts

### Traditional ML Models
```
/opt/ml/model/
└── model.pkl          # Single model file
```

### Transformer Models
```
/opt/ml/model/
├── config.json        # Model configuration
├── pytorch_model.bin  # Model weights
├── tokenizer.json     # Tokenizer
├── tokenizer_config.json
└── special_tokens_map.json
```

### Model Loading Best Practices
```python
import os

# Use environment variable
model_dir = os.environ.get('SM_MODEL_DIR', '/opt/ml/model')

# Check if model exists
model_path = os.path.join(model_dir, 'model.pkl')
if not os.path.exists(model_path):
    raise FileNotFoundError(f"Model not found at {model_path}")

# Load model once at startup, not per request
model = load_model(model_path)
```

## Request/Response Format

### JSON Input (Traditional ML)
```json
{
  "instances": [
    {"feature1": 1.0, "feature2": 2.0},
    {"feature1": 3.0, "feature2": 4.0}
  ]
}
```

### JSON Output (Traditional ML)
```json
{
  "predictions": [0.8, 0.2]
}
```

### Text Input (Transformers)
```json
{
  "inputs": "What is the capital of France?",
  "parameters": {
    "max_new_tokens": 100,
    "temperature": 0.7
  }
}
```

### Content-Type Handling
```python
@app.route('/invocations', methods=['POST'])
def predict():
    content_type = request.headers.get('Content-Type', 'application/json')
    
    if content_type == 'application/json':
        data = request.get_json()
    elif content_type == 'text/csv':
        data = parse_csv(request.data)
    else:
        return Response(
            f"Unsupported content type: {content_type}",
            status=415
        )
```

## Logging

### CloudWatch Logs
- All stdout/stderr goes to CloudWatch Logs
- Log group: `/aws/sagemaker/Endpoints/{endpoint-name}`
- Use structured logging for better searchability

### Logging Best Practices
```python
import logging
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Log structured data
logger.info(json.dumps({
    'event': 'prediction',
    'latency_ms': 45,
    'input_size': 1024,
    'status': 'success'
}))

# Log errors with context
try:
    prediction = model.predict(data)
except Exception as e:
    logger.error(f"Prediction failed: {str(e)}", exc_info=True)
    raise
```

## Testing Endpoints

### Local Testing
```bash
# Test health check
curl http://localhost:8080/ping

# Test inference
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'
```

### SageMaker Endpoint Testing
```bash
# Using AWS CLI
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name my-endpoint \
  --body '{"instances": [[1.0, 2.0, 3.0]]}' \
  --content-type application/json \
  output.json

# Using Python SDK
import boto3
import json

runtime = boto3.client('sagemaker-runtime')
response = runtime.invoke_endpoint(
    EndpointName='my-endpoint',
    ContentType='application/json',
    Body=json.dumps({'instances': [[1.0, 2.0, 3.0]]})
)
result = json.loads(response['Body'].read())
```

## Common Issues & Solutions

### Container Fails to Start
- Check CloudWatch logs for errors
- Verify model files exist in /opt/ml/model
- Ensure port 8080 is exposed and listening
- Check for Python import errors

### Endpoint Creation Fails
- Verify IAM role has correct permissions
- Check ECR image exists and is accessible
- Ensure instance type is available in region
- Verify model data URL is correct (if using S3)

### Slow Inference
- Model loading on every request (load once at startup)
- Large model size (consider model optimization)
- Insufficient instance resources (upgrade instance type)
- Network latency (use VPC endpoints)

### Out of Memory
- Model too large for instance (upgrade instance type)
- Memory leak in inference code (profile and fix)
- Batch size too large (reduce batch size)
- Multiple models loaded (use multi-model endpoint)

## Cost Optimization

### Strategies
1. **Right-size instances** - Don't over-provision
2. **Use auto-scaling** - Scale down during low traffic
3. **Serverless inference** - For sporadic workloads
4. **Multi-model endpoints** - Share instance across models
5. **Spot instances** - For non-critical workloads (not supported for endpoints)
6. **Delete unused endpoints** - Stop paying for idle resources

### Monitoring Costs
```bash
# Check endpoint costs
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --filter file://filter.json

# filter.json
{
  "Dimensions": {
    "Key": "SERVICE",
    "Values": ["Amazon SageMaker"]
  }
}
```

## Security Best Practices

### Network Security
- Deploy in VPC for private endpoints
- Use VPC endpoints for AWS service access
- Restrict security group ingress rules
- Enable encryption in transit

### Data Security
- Encrypt model artifacts in S3 (SSE-S3 or SSE-KMS)
- Use IAM roles, not access keys
- Enable CloudTrail for audit logging
- Rotate credentials regularly

### Container Security
- Use minimal base images
- Scan images for vulnerabilities
- Don't run as root user
- Keep dependencies updated
- Remove unnecessary tools from production images

## Regional Considerations

### Available Regions
SageMaker is available in most AWS regions, but:
- Some instance types are region-specific
- Pricing varies by region
- Consider data residency requirements
- Use same region as your data for lower latency

### Multi-Region Deployment
```bash
# Deploy to multiple regions for HA
for region in us-east-1 us-west-2 eu-west-1; do
  aws sagemaker create-endpoint \
    --endpoint-name my-endpoint \
    --endpoint-config-name my-config \
    --region $region
done
```
