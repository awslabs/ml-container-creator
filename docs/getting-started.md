# Getting Started

This guide will walk you through installing ML Container Creator (MCC), configuring MCC for first-time use, and the various methods to creating your first SageMaker-ready container.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 24.11.1+** - [Download](https://nodejs.org/)
- **Python 3.8+** - For model serving code
- **Docker 20+** - [Install Docker](https://docs.docker.com/get-docker/), required for local builds
- **AWS CLI 2+** - [Install AWS CLI](https://aws.amazon.com/cli/)
- **AWS Role** - With an appropriately provisioned [AWS Identity and Access Management](https://aws.amazon.com/iam/) [policy document](#iam-policy-document)

### Verify Prerequisites

```bash
# Check Node.js version
node --version  # Should be 24.11.1 or higher

# Check Python version
python --version  # Should be 3.8 or higher

# Check Docker (local builds only)
docker --version

# Check AWS CLI
aws --version

# Verify AWS credentials
aws sts get-caller-identity
```

### IAM Policy Document
!!! todo "Coming Soon"
    Documentation for this feature is in progress.


## Installation

```bash
# Install Yeoman
npm install -g yo

# Install the generator
git clone https://github.com/awslabs/ml-container-creator.git
cd ml-container-creator

# Install Dependencies and Link Generator
npm install
npm link

# Verify installation
yo --generators
# Should show "ml-container-creator" in the list

# Run tests to verify setup (for contributors)
npm test

# Generate your project
yo @aws/ml-container-creator
```

## Predictive ML

Let's create a simple [scikit-learn](https://scikit-learn.org/stable/) model container. All predictive ML containers feature a very basic regression model trained on the [Abalone dataset](https://archive.ics.uci.edu/dataset/1/abalone). These sample models are for demonstration purposes only. The instructions assume you have a model object saved locally to be copied to your container in the format specified for your chosen framework.

For LLMs, check out the section on [Generative AI](#generative-ai).

### Step 1: Prepare Your Model

First, save a trained model in the format you plan to use for your deployment. Each predictive framework supports different model format types. Check the "supported frameworks" page for more details.

!!! todo "Coming Soon"
    Link to predictive framework support page.

In this example, we'll use the sample Abalone classifier. This deployment option trains a light-weight and overly simplistic regression model using the selected predictive ML framework, and saves the model object in the format specified. The model file is automatically included in the container files for simplicity.

### Step 2: Generate Container Project

Run the generator using the `yo` command and selecting the generator from the provided list. Alternatively, specify the generator inline: `yo @aws/ml-container-creator`. You'll be prompted with questions. Each option creates conditional branching logic custom to the selected values. For a basic scikit-learn container using the default regression model, follow the prompts as defined below. You'll want to do this in a new directory.

```
(base) frgud@842f5776eab6 ml-container-creator % mkdir scikit-test
(base) frgud@842f5776eab6 ml-container-creator % cd scikit-test 
(base) frgud@842f5776eab6 scikit-test % yo @aws/ml-container-creator scikit-test-project

📚 Registry System Initialized
   • Framework Registry: Loaded
   • Model Registry: Loaded
   • Instance Accelerator Mapping: Loaded
   • Environment Variable Validation: Enabled

⚙️  Configuration will be collected from prompts and merged with:
   • Project name: scikit-test-project

🔧 Core Configuration
✔ Which ML framework are you using? sklearn
✔ In which format is your model serialized? pkl
✔ Which model server are you serving with? flask

📦 Module Selection
✔ Include sample Abalone classifier? Yes
✔ Include test suite? Yes
✔ Test type? local-model-cli, local-model-server, hosted-model-endpoint

💪 Infrastructure & Performance
✔ Deployment target? managed-inference
✔ Instance type? CPU-optimized (ml.m6g.large)
✔ Target AWS region? us-east-1
✔ AWS IAM Role ARN for SageMaker execution (optional)? <IAM ROLE>

⚠️  Warning: Building locally for SageMaker deployment
   Building this image locally may result in `exec format error` when deploying
   to SageMaker if your local architecture differs from the target instance.
   Ensure you have set the appropriate --platform flag in your Dockerfile
   (e.g., --platform=linux/amd64 for x86_64 instances, --platform=linux/arm64 for ARM).
   Consider using CodeBuild for architecture-independent builds.


📋 Project Configuration

🚀 Manual Deployment

☁️ The following steps assume authentication to an AWS account.

💰 The following commands will incur charges to your AWS account.
         ./build_and_push.sh -- Builds the image and pushes to ECR.
         ./deploy.sh -- Deploys the image to a SageMaker AI Managed Inference Endpoint.
                 deploy.sh needs a valid IAM Role ARN as a parameter.
   create scikit-test-project/Dockerfile
   create scikit-test-project/nginx-predictors.conf
   create scikit-test-project/requirements.txt
   create scikit-test-project/code/model_handler.py
   create scikit-test-project/code/serve.py
   create scikit-test-project/code/serving.properties
   create scikit-test-project/code/start_server.py
   create scikit-test-project/deploy/build_and_push.sh
   create scikit-test-project/deploy/deploy.sh
   create scikit-test-project/sample_model/test_inference.py
   create scikit-test-project/sample_model/train_abalone.py
   create scikit-test-project/test/test_endpoint.sh
   create scikit-test-project/test/test_local_image.sh
   create scikit-test-project/test/test_model_handler.py
   create scikit-test-project/code/flask/gunicorn_config.py
   create scikit-test-project/code/flask/wsgi.py

No change to package.json was detected. No package manager install will be executed.

🤖 Training sample model...
This will generate the model file needed for Docker build.
Model trained and saved. Test score: 0.531
Model saved.
✅ Sample model training completed successfully!
📁 Model file saved in: /User/frgud/../scikit-test/scikit-test-project/sample_model
```

#### Project Structure

Your generated project contains:

```
scikit-test-project/
├── Dockerfile              # Container definition
├── requirements.txt        # Python dependencies
├── nginx-predictors.conf   # Nginx configuration
├── code/
│   ├── model.pkl               # Your trained model
│   ├── model_handler.py        # Model loading and inference
│   ├── serve.py                # Flask server
│   └── flask/                  # Flask-specific code
|       ├── gunicorn_config.py    # Gunicorn Config (Flask only)
|       └── wsgi.py               # Creates Flask app
├── do/                    # do-framework lifecycle scripts
│   ├── config             # Centralized configuration
│   ├── build              # Build Docker image
│   ├── push               # Push to Amazon ECR
│   ├── deploy             # Deploy to SageMaker
│   ├── run                # Run container locally
│   ├── test               # Test container or endpoint
│   ├── clean              # Clean up resources
│   ├── logs               # Tail deployment logs
│   ├── export             # Export config as CLI command
│   └── README.md          # Detailed documentation
├── deploy/                # Legacy scripts (deprecated)
│   ├── build_and_push.sh  # Use ./do/build && ./do/push instead
│   └── deploy.sh          # Use ./do/deploy instead
└── test/
    ├── test_endpoint.sh       # Test hosted endpoint
    ├── test_local_image.sh    # Test local container
    └── test_model_handler.py  # Unit tests
```

### Step 3: Add Your Model

If you have your own model saved in the `pkl` format, modify the generated Dockerfile accordingly.
```bash
# COPY sample_model/abalone_model.pkl /opt/ml/model/
COPY my_local_model/model.pkl /opt/ml/model/
```
The Dockerfile will be different based on the values selected in Step 2, but the step remains the same so long as you are supplying your own already trained model.

!!! info "Model Source Locations"
    At this time, predictive models can only be sourced from local storage.

### Step 4: Test the Container

This particular flow yields three different tests that can be run. The first is a test of the image build process, the second tests the model's ability to receive requests and respond, and the third tests the deployed endpoint using the [AWS SageMaker CLI](https://docs.aws.amazon.com/cli/latest/reference/sagemaker/).

!!! info "Testing Data"
    Data used to test these capabilities come directly from the Abalone dataset. It is not a true test of a model's predictive performance. Rather it is a test of the container's to serve inference, the model loader's `predict` method, and the endpoint's ability to receive requests on the `/invocations` endpoint. If you provide your own model, you may have to modify these scripts with your own test data.

#### Test Container Locally:

```bash
(base) frgud@842f5776eab6 scikit-test-project % ./test/test_local_image.sh 
Building Docker image...
[+] Building 34.9s (9/20)                                                             docker:desktop-linux
...
View build details: docker-desktop://dashboard/build/desktop-linux/desktop-linux/ztddsyganjri4bak78mgdjb5g
Stopping any existing container...
Starting container on port 8080...
95af750298500a09416ca1e2f8fd83adde66387be933c98bd3b897ff2a4383db
Waiting for container to start...
Testing health check endpoint...
{"status":"healthy"}

Testing inference endpoint...
{"predictions":[12.86]}

Container logs:
[2026-01-29 22:33:10 +0000] [7] [INFO] Starting gunicorn 23.0.0
[2026-01-29 22:33:10 +0000] [7] [INFO] Listening at: http://0.0.0.0:8080 (7)
[2026-01-29 22:33:10 +0000] [7] [INFO] Using worker: sync
[2026-01-29 22:33:11 +0000] [21] [INFO] Booting worker with pid: 21
INFO:serve:Loading model from /opt/ml/model
INFO:model_handler:Loading model from /opt/ml/model/abalone_model.pkl
[2026-01-29 22:33:11 +0000] [22] [INFO] Booting worker with pid: 22
INFO:serve:Loading model from /opt/ml/model
INFO:model_handler:Loading model from /opt/ml/model/abalone_model.pkl
[2026-01-29 22:33:11 +0000] [23] [INFO] Booting worker with pid: 23
INFO:serve:Loading model from /opt/ml/model
INFO:model_handler:Loading model from /opt/ml/model/abalone_model.pkl
[2026-01-29 22:33:11 +0000] [55] [INFO] Booting worker with pid: 55
INFO:serve:Loading model from /opt/ml/model
INFO:model_handler:Loading model from /opt/ml/model/abalone_model.pkl
INFO:model_handler:SKLearn model loaded successfully
INFO:serve:Model loaded successfully
INFO:model_handler:SKLearn model loaded successfully
INFO:serve:Model loaded successfully
INFO:model_handler:SKLearn model loaded successfully
INFO:serve:Model loaded successfully
INFO:model_handler:SKLearn model loaded successfully
INFO:serve:Model loaded successfully
192.168.65.1 - - [29/Jan/2026:22:33:20 +0000] "GET /ping HTTP/1.1" 200 21 "-" "curl/8.7.1"
/usr/local/lib/python3.12/site-packages/sklearn/utils/validation.py:2749: UserWarning: X does not have valid feature names, but RandomForestRegressor was fitted with feature names
  warnings.warn(
192.168.65.1 - - [29/Jan/2026:22:33:20 +0000] "POST /invocations HTTP/1.1" 200 24 "-" "curl/8.7.1"

Cleaning up...
sklearn-test
sklearn-test
Test complete!
(base) frgud@842f5776eab6 scikit-test-project % 
```
This test builds the container locally and stands it up as a temporary process behind `localhost:8080`. It then sends a request to the `/ping` endpoint, followed by a request to the `/invocations` endpoint. 

#### Test Model Handler:
```bash
(base) frgud@842f5776eab6 scikit-test-project % python ./test/test_model_handler.py --model-path ./sample_model --input-data '[[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]'
Loading model from: ./sample_model
INFO:model_handler:Loading model from ./sample_model/abalone_model.pkl
INFO:model_handler:SKLearn model loaded successfully
Running inference...
/Users/frgud/.local/share/mise/installs/python/3.12.11/lib/python3.12/site-packages/sklearn/utils/validation.py:2749: UserWarning: X does not have valid feature names, but RandomForestRegressor was fitted with feature names
  warnings.warn(

Result:
{
  "predictions": [
    12.86
  ]
}
(base) frgud@842f5776eab6 scikit-test-project % 
```
This test executes the Python code that runs within the container. If you require custom input preprocessing and post-processing, you will have to modify the `code/model_handler.py` file. The model handler test can be extended to test how the container receives and responds to inference requests at the model layer.

#### Test Endpoint:
We will come back to this once we deploy the model in the next step.


### Step 5: Deploy to SageMaker

#### 5.1: Build and Push to ECR

```bash
# Build Docker image
(base) frgud@842f5776eab6 scikit-test-project % ./do/build
🚀 Building Docker image for scikit-test-project
   Deployment config: sklearn-flask
   Framework: sklearn
   Model server: flask
🏗️  Building CPU-optimized image...
...
✅ Build complete!
   Image: scikit-test-project:latest
   Tagged: scikit-test-project:20260129-175045

Next steps:
  • Test locally: ./do/run
  • Push to ECR: ./do/push
  • Deploy to SageMaker: ./do/deploy

# Push to ECR
(base) frgud@842f5776eab6 scikit-test-project % ./do/push
🚀 Pushing Docker image to Amazon ECR
   Project: scikit-test-project
   Region: us-east-1
   Repository: ml-container-creator
🔍 Validating AWS credentials...
✅ AWS credentials validated (Account: <ACCOUNT_NO>)
🔐 Authenticating with Amazon ECR...
✅ ECR authentication successful
✅ ECR repository exists
🏷️  Tagging images for ECR...
📤 Pushing images to ECR...
✅ Push complete!

📦 Pushed image URIs:
   <ECR_URI>/ml-container-creator:latest
   <ECR_URI>/ml-container-creator:scikit-test-project-latest
   <ECR_URI>/ml-container-creator:scikit-test-project-20260129-175045
```

#### 5.2: Deploy to SageMaker AI
```bash
(base) frgud@842f5776eab6 scikit-test-project % ./do/deploy
🚀 Deploying to AWS
   Project: scikit-test-project
   Deployment config: sklearn-flask
   Region: us-east-1
   Build target: local
   Deployment target: managed-inference
   Instance type: ml.m6g.large
🔍 Validating AWS credentials...
✅ AWS credentials validated (Account: <ACCOUNT_NO>)
🔍 Verifying ECR image exists...
✅ ECR image found: <ECR_URI>/ml-container-creator:scikit-test-project-latest
⚙️  Creating endpoint configuration: scikit-test-project-epc-<TIMESTAMP>
✅ Endpoint configuration created
🚀 Creating endpoint: scikit-test-project-endpoint-<TIMESTAMP>
✅ Endpoint creation initiated
⏳ Waiting for endpoint to reach InService status...
✅ Endpoint is InService
📦 Creating inference component: scikit-test-project-ic-<TIMESTAMP>
⏳ Waiting for inference component to reach InService status...
✅ Deployment complete!

📋 Deployment Details:
   Endpoint: scikit-test-project-endpoint-<TIMESTAMP>
   Inference Component: scikit-test-project-ic-<TIMESTAMP>
   Region: us-east-1
   Instance Type: ml.m6g.large

🧪 Test your endpoint:
   ./do/test
```

#### 5.3: Test the Endpoint

```bash
(base) frgud@842f5776eab6 scikit-test-project % ./do/test
🧪 Testing SageMaker endpoint: scikit-test-project-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: Sample feature vector
   Invoking SageMaker endpoint...
✅ Inference request successful
   Response preview: {"predictions": [12.86]}

✅ All tests passed!
```

## Generative AI

### Step 1: Generate Container Project
Just as with the [predictive scenario](#predictive-ml), we can use MCC to generate container assets for transformer-based architectures and LLMs. In this example, we'll use MCC to deploy [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) onto a SageMaker AI managed inference endpoint using the [SGLang](https://docs.sglang.io/) serving framework.


```bash
(base) frgud@842f5776eab6 transformers-test % yo @aws/ml-container-creator sglang-gptoss-test 

📚 Registry System Initialized
   • Framework Registry: Loaded
   • Model Registry: Loaded
   • Instance Accelerator Mapping: Loaded
   • Environment Variable Validation: Enabled

⚙️  Configuration will be collected from prompts and merged with:
   • Project name: sglang-gptoss-test

🔧 Core Configuration
✔ Which ML framework are you using? transformers
✔ Which model do you want to use? openai/gpt-oss-20b
✔ Which model server are you serving with? sglang

🔍 Fetching model information for: openai/gpt-oss-20b
   ✅ Found on HuggingFace Hub

📋 Model Information:
   • Model ID: openai/gpt-oss-20b
   • Chat Template: ❌ Not available
     (Chat endpoints may require manual configuration)
   • Sources: HuggingFace_Hub_API

📦 Module Selection
✔ Include test suite? Yes
✔ Test type? hosted-model-endpoint

💪 Infrastructure & Performance
✔ Deployment target? codebuild (recommended)
✔ CodeBuild compute type? BUILD_GENERAL1_MEDIUM
✔ Instance type? GPU-optimized (ml.g6.12xlarge)
✔ Target AWS region? us-east-1
✔ AWS IAM Role ARN for SageMaker execution (optional)? <EXECUTION_ROLE_ARN>

📋 Project Configuration

🚀 Manual Deployment

☁️ The following steps assume authentication to an AWS account.

💰 The following commands will incur charges to your AWS account.
         ./build_and_push.sh -- Builds the image and pushes to ECR.
         ./deploy.sh -- Deploys the image to a SageMaker AI Managed Inference Endpoint.
                 deploy.sh needs a valid IAM Role ARN as a parameter.
   create sglang-gptoss-test/Dockerfile
   create sglang-gptoss-test/IAM_PERMISSIONS.md
   create sglang-gptoss-test/buildspec.yml
   create sglang-gptoss-test/code/serve
   create sglang-gptoss-test/code/serving.properties
   create sglang-gptoss-test/deploy/deploy.sh
   create sglang-gptoss-test/deploy/submit_build.sh
   create sglang-gptoss-test/deploy/upload_to_s3.sh
   create sglang-gptoss-test/test/test_endpoint.sh

No change to package.json was detected. No package manager install will be executed.
(base) frgud@842f5776eab6 transformers-test % 
```

#### Project Structure

Your generated project contains:

```
sglang-gptoss-test/
    ├── Dockerfile                    # Container definition with SGLang runtime
    ├── IAM_PERMISSIONS.md            # Required AWS IAM policies for AWS CodeBuild deployment
    ├── buildspec.yml                 # AWS CodeBuild configuration for CI/CD
    ├── code/
    │   ├── serve                     # Shell entrypoint script that launches SGLang server
    │   └── serving.properties        # SGLang server configuration (model ID, port, etc.)
    ├── do/                           # do-framework lifecycle scripts
    │   ├── config                    # Centralized configuration
    │   ├── build                     # Build Docker image
    │   ├── push                      # Push to Amazon ECR
    │   ├── deploy                    # Deploy to SageMaker
    │   ├── test                      # Test container or endpoint
    │   ├── clean                     # Clean up resources
    │   ├── logs                      # Tail deployment logs
    │   ├── export                    # Export config as CLI command
    │   └── submit                    # Submit build to CodeBuild
    ├── deploy/                       # Legacy scripts (deprecated)
    │   ├── deploy.sh                 # Use ./do/deploy instead
    │   └── submit_build.sh           # Use ./do/submit instead
    └── test/
        └── test_endpoint.sh          # Tests the deployed SageMaker endpoint with sample requests
```
### Step 2. Build the Container
The transformer based projects used managed containers from framework providers to build the final container. These containers take significantly longer to build given how large they are. It is recommended to use AWS CodeBuild for transformer-based containers. Building with AWS CodeBuild helps reduce the likelihood of architecture mismatches as well.

```bash
(base) frgud@842f5776eab6 sglang-gptoss-test % ./do/submit
🚀 Submitting CodeBuild job for sglang-gptoss-test
Project: sglang-gptoss-test-llm-build-20260129
Region: us-east-1
Compute Type: BUILD_GENERAL1_MEDIUM
ECR Repository: ml-container-creator
📦 Checking ECR repository...
✅ ECR repository already exists: ml-container-creator
🔐 Checking CodeBuild service role...
Creating CodeBuild service role: sglang-gptoss-test-llm-build-20260129-service-role
{
    "Role": {
        "Path": "/",
        "RoleName": "<ROLE_NAME>",
        "RoleId": "<IAM ROLE ID>",
        "Arn": "arn:aws:iam::<ACCOUNT_NO>:role/sglang-gptoss-test-llm-build-20260129-service-role",
        "CreateDate": "2026-01-29T23:15:56+00:00",
        "AssumeRolePolicyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "codebuild.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }
    }
}
✅ CodeBuild service role created successfully
⏳ Waiting for IAM role to propagate...
🏗️  Checking CodeBuild project...
Creating CodeBuild project: sglang-gptoss-test-llm-build-20260129
Creating CodeBuild project...
✅ CodeBuild project created successfully
Project ARN: arn:aws:codebuild:us-east-1:<ACCOUNT_NO>:project/sglang-gptoss-test-llm-build-20260129
⏳ Waiting for CodeBuild project to be available...
✅ Project creation verified: sglang-gptoss-test-llm-build-20260129
🚀 Starting CodeBuild job...
Using project name: sglang-gptoss-test-llm-build-20260129
📁 Uploading source code from current directory...
Creating source archive...
✅ Source archive created:  16K
📤 Uploading source to S3...
upload: ../../../../../../tmp/sglang-gptoss-test-source.zip to s3://codebuild-source-<ACCOUNT_NO>-us-east-1/sglang-gptoss-test/source-20260129-181616.zip
🚀 Starting CodeBuild job with source from S3...
Using project name: 'sglang-gptoss-test-llm-build-20260129'
S3 source location: s3://codebuild-source-<ACCOUNT_NO>-us-east-1/sglang-gptoss-test/source-20260129-181616.zip
Starting build...
Build started with ID: sglang-gptoss-test-llm-build-20260129:e49cb662-7e0a-485d-9bcc-eb0f23e4f8ac
📊 You can monitor the build at: https://us-east-1.console.aws.amazon.com/codesuite/codebuild/projects/sglang-gptoss-test-llm-build-20260129/build/sglang-gptoss-test-llm-build-20260129:e49cb662-7e0a-485d-9bcc-eb0f23e4f8ac

⏳ Monitoring build progress...
📋 Build status: IN_PROGRESS | Phase: PROVISIONING
📋 Build status: IN_PROGRESS | Phase: BUILD
📋 Build status: SUCCEEDED | Phase: COMPLETED

✅ Build completed successfully!
🐳 Docker image available at: <ACCOUNT_NO>.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:latest

Next steps:
  • Deploy to SageMaker: ./do/deploy
  • Or use the ECR image URI in your own deployment process
(base) frgud@842f5776eab6 sglang-gptoss-test % 
```

### Step 3. Deploy to SageMaker AI
Transformer based containers typically require GPU to successfully deploy. Take care to provision your transformer-based container onto the appropriate instance type. The deployment script is populated with a "best-guess" instance type, but you may try experimenting with the deployment instance based on your unique workload requirements.

#### 3.1: Deploy
```bash
(base) frgud@842f5776eab6 sglang-gptoss-test % ./do/deploy
🚀 Deploying to AWS
   Project: sglang-gptoss-test
   Deployment config: transformers-sglang
   Region: us-east-1
   Build target: codebuild
   Deployment target: managed-inference
   Instance type: ml.g6.12xlarge
🔍 Validating AWS credentials...
✅ AWS credentials validated (Account: <ACCOUNT_NO>)
🔍 Verifying ECR image exists...
✅ ECR image found: <ACCOUNT_NO>.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:sglang-gptoss-test-latest
⚙️  Creating endpoint configuration: sglang-gptoss-test-epc-<TIMESTAMP>
✅ Endpoint configuration created
🚀 Creating endpoint: sglang-gptoss-test-endpoint-<TIMESTAMP>
✅ Endpoint creation initiated
⏳ Waiting for endpoint to reach InService status...
✅ Endpoint is InService
📦 Creating inference component: sglang-gptoss-test-ic-<TIMESTAMP>
⏳ Waiting for inference component to reach InService status...
   This may take 5-10 minutes...
✅ Deployment complete!

📋 Deployment Details:
   Endpoint: sglang-gptoss-test-endpoint-<TIMESTAMP>
   Inference Component: sglang-gptoss-test-ic-<TIMESTAMP>
   Region: us-east-1
   Instance Type: ml.g6.12xlarge

🧪 Test your endpoint:
   ./do/test
```

#### 3.2: Test
```bash
(base) frgud@842f5776eab6 sglang-gptoss-test % ./do/test

🧪 Testing SageMaker endpoint: sglang-gptoss-test-endpoint-<TIMESTAMP>

🔍 Test 1: Health check
   Checking endpoint status...
✅ Endpoint is InService

🔍 Test 2: Inference request
   Payload: OpenAI-compatible chat completion request
   Invoking SageMaker endpoint...
✅ Inference request successful
   Response preview: {
  "id": "5e7ce6ccc0f04cb8abd320b27b508ff5",
  "object": "chat.completion",
  "created": 1769730729,
  "model": "openai/gpt-oss-20b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<|channel|>analysis<|message|>We need to respond to user greeting. It's a friendly question, \"Hello, how are you?\" We can respond politely: \"I'm good, thanks! How can I help you today?\" The user didn't ask a question; it's just a greeting. So respond accordingly.<|end|><|start|>assistant<|channel|>final<|message|>I’m doing great—thanks for asking! How can I help you today?",
        "reasoning_content": null,
        "tool_calls": null
      },
      "logprobs": null,
      "finish_reason": "stop",
      "matched_stop": 200002
    }
  ],
  "usage": {
    "prompt_tokens": 73,
    "total_tokens": 153,
    "completion_tokens": 80,
    "prompt_tokens_details": null,
    "reasoning_tokens": 0
  },
  "metadata": {
    "weight_version": "default"
  }
}

✅ All tests passed!

Endpoint is ready for production use!
  • Endpoint name: sglang-gptoss-test-endpoint-<TIMESTAMP>
  • Region: us-east-1
```

## Configuration Options

The example above used interactive prompts, but ML Container Creator supports multiple configuration methods for different workflows:

### Quick CLI Generation

Skip prompts entirely using CLI options:

```bash
# Generate sklearn project with CLI options
yo @aws/ml-container-creator iris-classifier \
  --framework=sklearn \
  --model-server=flask \
  --model-format=pkl \
  --include-testing \
  --skip-prompts
```

### Environment Variables

Set deployment-specific variables:

```bash
export AWS_REGION=us-west-2
export ML_INSTANCE_TYPE=gpu-enabled
yo @aws/ml-container-creator --framework=transformers --model-server=vllm --skip-prompts
```

### Configuration Precedence

Configuration sources are applied in order (highest to lowest priority):

1. **CLI Options** (`--framework=sklearn`)
2. **CLI Arguments** (`yo @aws/ml-container-creator my-project`)
3. **Environment Variables** (`AWS_REGION=us-east-1`)
4. **Config Files** (`--config=prod.json` or `config/mcp.json`)
5. **Package.json** (`"ml-container-creator": {...}`)
6. **Generator Defaults**
7. **Interactive Prompts** (fallback)

For complete configuration documentation, see the [Configuration Guide](configuration.md).

## Cleanup

To avoid ongoing charges, use the `do/clean` script to tear down all deployed resources:

```bash
# Delete SageMaker endpoint, inference component, and endpoint configuration
./do/clean endpoint

# Or clean everything (local images, ECR images, endpoint, CodeBuild)
./do/clean all
```

You can also clean individual resource types:

```bash
./do/clean local      # Remove local Docker images
./do/clean ecr        # Remove images from Amazon ECR
./do/clean codebuild  # Delete CodeBuild project and IAM role
```

<!-- ## Next Steps

### Learn More
- **[Examples](EXAMPLES.md)** - Detailed examples for all frameworks
- **[Troubleshooting](TROUBLESHOOTING.md)** - Common issues and solutions

### Try Other Frameworks
- [Deploy an XGBoost Model](EXAMPLES.md#example-2-deploy-an-xgboost-model)
- [Deploy a TensorFlow Model](EXAMPLES.md#example-3-deploy-a-tensorflow-model)
- [Deploy a Transformer Model with vLLM](EXAMPLES.md#example-4-deploy-a-transformer-model-llm)
- [Deploy a Transformer Model with TensorRT-LLM](EXAMPLES.md#example-5-deploy-a-transformer-model-with-tensorrt-llm)

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

See the [full troubleshooting guide](TROUBLESHOOTING.md) for more solutions. -->