# Getting Started

This guide will walk you through installing ML Container Creator and creating your first SageMaker-ready container.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 24.11.1+** - [Download](https://nodejs.org/)
- **Python 3.8+** - For model serving code
- **Docker 20+** - [Install Docker](https://docs.docker.com/get-docker/)
- **AWS CLI 2+** - [Install AWS CLI](https://aws.amazon.com/cli/)
- **AWS Account** - With SageMaker access

### Verify Prerequisites

```bash
# Check Node.js version
node --version  # Should be 24.11.1 or higher

# Check Python version
python --version  # Should be 3.8 or higher

# Check Docker
docker --version

# Check AWS CLI
aws --version

# Verify AWS credentials
aws sts get-caller-identity
```

## Installation

### Option 1: Quick Install (Recommended)

```bash
# Clone the repository
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator

# Install dependencies and link generator
npm install
npm link

# Verify installation
yo --generators
# Should show "ml-container-creator" in the list

# Run tests to verify setup (for contributors)
npm test
```

### Option 2: Using mise (For Contributors)

If you're contributing to the project, use [mise](https://mise.jdx.dev/) for environment management:

```bash
# Install mise
curl https://mise.run | sh

# Clone and setup
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator

# Install all dependencies and tools
mise install
mise run install

# Run tests
mise run test
```

## Your First Project

Let's create a simple scikit-learn model container. For more advanced configuration options, see the [Configuration Guide](configuration.md).

### Step 1: Prepare Your Model

First, save a trained model:

```python
# train_model.py
from sklearn.datasets import load_iris
from sklearn.ensemble import RandomForestClassifier
import joblib

# Train a simple model
X, y = load_iris(return_X_y=True)
model = RandomForestClassifier(n_estimators=10, random_state=42)
model.fit(X, y)

# Save the model
joblib.dump(model, 'model.pkl')
print("Model saved as model.pkl")
```

```bash
python train_model.py
```

### Step 2: Generate Container Project

Run the generator:

```bash
yo ml-container-creator
```

You'll be prompted with questions. Here's what to answer for this example:

```
📋 Project Configuration
? What is the Project Name? iris-classifier
? Where will the output directory be? ./iris-classifier-2024-12-02

🔧 Core Configuration
? Which ML framework are you using? sklearn
? In which format is your model serialized? pkl
? Which model server are you serving with? flask

📦 Module Selection
? Include sample Abalone classifier? No
? Include test suite? Yes
? Test type? ✓ local-model-cli
             ✓ local-model-server
             ✓ hosted-model-endpoint

💪 Infrastructure & Performance
? Deployment target? sagemaker
? Instance type? CPU-optimized (ml.m6g.large)
? Target AWS region? us-east-1
```

!!! info "Deployment Targets"
    ML Container Creator supports two deployment approaches:
    
    - **SageMaker**: Direct deployment - builds and deploys locally (good for development)
    - **CodeBuild**: CI/CD pipeline - automated building in AWS (good for production)
    
    For this getting started example, we'll use SageMaker direct deployment. For CodeBuild CI/CD, see the [CodeBuild Example](EXAMPLES.md#example-5-deploy-with-codebuild-cicd).

### Step 3: Add Your Model

Copy your trained model to the generated project:

```bash
cp model.pkl iris-classifier-*/code/model.pkl
cd iris-classifier-*
```

### Step 4: Test Locally

Build and run the container locally:

```bash
# Build Docker image
docker build -t iris-classifier .

# Run container
docker run -p 8080:8080 iris-classifier
```

In another terminal, test the endpoints:

```bash
# Test health check
curl http://localhost:8080/ping

# Test inference
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[5.1, 3.5, 1.4, 0.2]]}'

# Expected output:
# {"predictions": [0]}
```

Stop the container with `Ctrl+C`.

### Step 5: Deploy to SageMaker

#### 5.1: Setup AWS Credentials

Ensure your AWS credentials are configured:

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (e.g., us-east-1)
```

#### 5.2: Create IAM Role

Your SageMaker endpoint needs an IAM role with these permissions:

```bash
# Create trust policy
cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "sagemaker.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name SageMakerExecutionRole \
  --assume-role-policy-document file://trust-policy.json

# Attach policies
aws iam attach-role-policy \
  --role-name SageMakerExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSageMakerFullAccess

aws iam attach-role-policy \
  --role-name SageMakerExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess

# Get role ARN (save this for next step)
aws iam get-role --role-name SageMakerExecutionRole --query 'Role.Arn' --output text
```

#### 5.3: Build and Push to ECR

```bash
# Build and push Docker image to ECR
./deploy/build_and_push.sh
```

This script will:
- Create an ECR repository (if it doesn't exist)
- Build your Docker image
- Tag and push to ECR

#### 5.4: Deploy to SageMaker

```bash
# Deploy to SageMaker endpoint
./deploy/deploy.sh arn:aws:iam::YOUR-ACCOUNT-ID:role/SageMakerExecutionRole
```

Replace `YOUR-ACCOUNT-ID` with your AWS account ID from step 5.2.

The deployment takes 5-10 minutes. You'll see:
```
Creating SageMaker model...
Creating endpoint configuration...
Creating endpoint...
Waiting for endpoint to be in service...
Endpoint is in service!
```

#### 5.5: Test the Endpoint

```bash
# Test the deployed endpoint
./test/test_endpoint.sh iris-classifier

# Or manually:
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name iris-classifier \
  --content-type application/json \
  --body '{"instances": [[5.1, 3.5, 1.4, 0.2]]}' \
  output.json

cat output.json
```

## Project Structure

Your generated project contains:

```
iris-classifier-2024-12-02/
├── Dockerfile              # Container definition
├── requirements.txt        # Python dependencies
├── nginx.conf             # Nginx configuration
├── code/
│   ├── model.pkl          # Your trained model
│   ├── model_handler.py   # Model loading and inference
│   ├── serve.py           # Flask server
│   └── flask/             # Flask-specific code
├── deploy/
│   ├── build_and_push.sh  # Build and push to ECR
│   └── deploy.sh          # Deploy to SageMaker
└── test/
    ├── test_endpoint.sh       # Test hosted endpoint
    ├── test_local_image.sh    # Test local container
    └── test_model_handler.py  # Unit tests
```

## Customization

### Customize Model Handler

Edit `code/model_handler.py` to add preprocessing or postprocessing:

```python
def preprocess(data):
    """Add custom preprocessing logic."""
    # Your preprocessing code
    return processed_data

def postprocess(predictions):
    """Add custom postprocessing logic."""
    # Your postprocessing code
    return formatted_predictions
```

### Customize Dependencies

Edit `requirements.txt` to add packages:

```txt
flask==2.3.0
scikit-learn==1.3.0
pandas==2.0.0
numpy==1.24.0
# Add your custom packages here
```

### Customize Instance Type

The generator provides three instance type options:

1. **CPU-optimized** (ml.m6g.large) - Default for traditional ML
2. **GPU-enabled** (ml.g5.xlarge for traditional ML, ml.g6.12xlarge for transformers)
3. **Custom** - Specify any AWS SageMaker instance type

#### Using Custom Instance Types

```bash
# Edit deploy/deploy.sh to use a custom instance type
INSTANCE_TYPE="ml.g4dn.xlarge"  # For GPU inference
# or
INSTANCE_TYPE="ml.inf1.xlarge"  # For AWS Inferentia optimization
# or  
INSTANCE_TYPE="ml.t3.medium"    # For development/testing
```

#### Or configure during generation:

```bash
yo ml-container-creator --instance-type=custom --custom-instance-type=ml.g4dn.xlarge
```

Popular custom instance types:
- `ml.t3.medium` - Development/testing (low cost)
- `ml.g4dn.xlarge` - Single GPU inference
- `ml.inf1.xlarge` - AWS Inferentia optimization
- `ml.c5n.xlarge` - Network-optimized inference

## Cleanup

To avoid ongoing charges, delete your SageMaker endpoint:

```bash
# Delete endpoint
aws sagemaker delete-endpoint --endpoint-name iris-classifier

# Delete endpoint configuration
aws sagemaker delete-endpoint-config --endpoint-config-name iris-classifier-config

# Delete model
aws sagemaker delete-model --model-name iris-classifier-model

# Delete ECR repository (optional)
aws ecr delete-repository --repository-name iris-classifier --force
```

## Configuration Options

The example above used interactive prompts, but ML Container Creator supports multiple configuration methods for different workflows:

### Quick CLI Generation

Skip prompts entirely using CLI options:

```bash
# Generate sklearn project with CLI options
yo ml-container-creator iris-classifier \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --include-testing \
  --skip-prompts
```

### Configuration Files

Create reusable configuration files:

```bash
# Generate configuration file
yo ml-container-creator configure

# Use configuration file
yo ml-container-creator --skip-prompts
```

### Environment Variables

Set deployment-specific variables:

```bash
export AWS_REGION=us-west-2
export ML_INSTANCE_TYPE=gpu-enabled
yo ml-container-creator --framework=transformers --model-server=vllm --skip-prompts
```

### Configuration Precedence

Configuration sources are applied in order (highest to lowest priority):

1. **CLI Options** (`--framework=sklearn`)
2. **CLI Arguments** (`yo ml-container-creator my-project`)
3. **Environment Variables** (`AWS_REGION=us-east-1`)
4. **Config Files** (`--config=prod.json` or `ml-container.config.json`)
5. **Package.json** (`"ml-container-creator": {...}`)
6. **Generator Defaults**
7. **Interactive Prompts** (fallback)

For complete configuration documentation, see the [Configuration Guide](configuration.md).

## Next Steps

### Learn More
- **[Examples](EXAMPLES.md)** - Detailed examples for all frameworks
- **[Troubleshooting](TROUBLESHOOTING.md)** - Common issues and solutions

### Try Other Frameworks
- [Deploy an XGBoost Model](EXAMPLES.md#example-2-deploy-an-xgboost-model)
- [Deploy a TensorFlow Model](EXAMPLES.md#example-3-deploy-a-tensorflow-model)
- [Deploy a Transformer Model](EXAMPLES.md#example-4-deploy-a-transformer-model-llm)

### Advanced Topics
- [Adding New Features](ADDING_FEATURES.md) - Contribute to the project
- [Template System](template-system.md) - Understand how templates work
- [AWS/SageMaker Guide](aws-sagemaker.md) - Deep dive into SageMaker

## Getting Help

If you run into issues:

1. Check the [Troubleshooting Guide](TROUBLESHOOTING.md)
2. Search [existing issues](https://github.com/awslabs/ml-container-creator/issues)
3. Ask in [Discussions](https://github.com/awslabs/ml-container-creator/discussions)
4. Open a [new issue](https://github.com/awslabs/ml-container-creator/issues/new)

## Common Issues

### Generator Not Found
```bash
# Re-link the generator
cd ml-container-creator
npm link
```

### Docker Build Fails
```bash
# Clear Docker cache
docker system prune -a
docker build --no-cache -t iris-classifier .
```

### AWS Authentication Fails
```bash
# Verify credentials
aws sts get-caller-identity

# Reconfigure if needed
aws configure
```

See the [full troubleshooting guide](TROUBLESHOOTING.md) for more solutions.