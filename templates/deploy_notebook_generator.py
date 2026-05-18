#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate deploy_notebook.ipynb from environment variables."""
import json
import os
import sys


def env(name, default=""):
    """Read an environment variable with a default."""
    return os.environ.get(name, default)


def make_markdown_cell(source_lines):
    """Create a markdown cell dict."""
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": source_lines
    }


def make_code_cell(source_lines):
    """Create a code cell dict."""
    return {
        "cell_type": "code",
        "metadata": {},
        "source": source_lines,
        "outputs": [],
        "execution_count": None
    }


cells = []

# ── Section 1: Setup ─────────────────────────────────────────────────────────

# Title markdown cell
cells.append(make_markdown_cell([
    f"# Deploy {env('PROJECT_NAME')} on SageMaker\n",
    "\n",
    f"**Model Server**: {env('MODEL_SERVER')}  \n",
    f"**Instance**: {env('INSTANCE_TYPE')}  \n",
    f"**Region**: {env('AWS_REGION')}\n"
]))

# Pip install cell
cells.append(make_code_cell([
    "%pip install -qU sagemaker boto3"
]))

# Imports cell
cells.append(make_code_cell([
    "import json\n",
    "import time\n",
    "import boto3\n",
    "import sagemaker\n",
    "from sagemaker import get_execution_role\n",
    "from sagemaker.session import Session\n",
    "\n",
    "sagemaker_session = Session()\n",
    "role = get_execution_role()\n",
    "account_id = boto3.client('sts').get_caller_identity()['Account']\n",
    "region = sagemaker_session.boto_region_name\n",
    "\n",
    "sm_client = boto3.client('sagemaker', region_name=region)\n",
    "smr_client = boto3.client('sagemaker-runtime', region_name=region)"
]))

# ── Section 2: Configuration ─────────────────────────────────────────────────

# Project variables baked as Python literals
cells.append(make_code_cell([
    f'PROJECT_NAME = "{env("PROJECT_NAME")}"\n',
    f'AWS_REGION = "{env("AWS_REGION")}"\n',
<% if (deploymentTarget !== 'hyperpod-eks' && !(typeof existingEndpointName !== 'undefined' && existingEndpointName)) { %>
    f'INSTANCE_TYPE = "{env("INSTANCE_TYPE")}"\n',
<% } %>
    f'ENDPOINT_NAME = f"{{PROJECT_NAME}}-ep-{{int(time.time())}}"\n',
<% if (typeof inferenceAmiVersion !== 'undefined' && inferenceAmiVersion) { %>
    f'INFERENCE_AMI_VERSION = "{env("INFERENCE_AMI_VERSION")}"\n',
<% } else { %>
    f'INFERENCE_AMI_VERSION = "{env("INFERENCE_AMI_VERSION", "")}"\n',
<% } %>
    f'HEALTH_CHECK_TIMEOUT = 850\n',
    f'IC_GPU_COUNT = {env("IC_GPU_COUNT", "1")}\n',
    f'IC_MIN_MEMORY_MB = {env("IC_MEMORY_SIZE", "1024")}'
]))

# Environment variables dict cell
cells.append(make_code_cell([
    "env = {\n",
<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>
<% orderedEnvVars.forEach(function(item, index) { %>
    f'    "<%= item.key %>": "{env("<%= item.key %>", "<%= item.value %>")}",\n',
<% }); %>
<% } %>
    "}"
]))

# ── Section 2b: Secrets Handling ─────────────────────────────────────────────

<% if (typeof hfTokenArn !== 'undefined' && hfTokenArn) { %>
# HF_TOKEN_ARN is configured — resolve via Secrets Manager
cells.append(make_code_cell([
    "import boto3 as _boto3_secrets\n",
    "\n",
    f'HF_TOKEN_ARN = "{env("HF_TOKEN_ARN")}"\n',
    "\n",
    "secrets_client = _boto3_secrets.client('secretsmanager', region_name=AWS_REGION)\n",
    "hf_token = secrets_client.get_secret_value(SecretId=HF_TOKEN_ARN)['SecretString']\n",
    'env["HF_TOKEN"] = hf_token'
]))
<% } else if (hfToken) { %>
# HF_TOKEN is configured — read from environment variable at notebook runtime
cells.append(make_markdown_cell([
    "### \u26a0\ufe0f HuggingFace Token Required\n",
    "\n",
    "Set the `HF_TOKEN` environment variable before running the next cell.  \n",
    "In SageMaker Studio, use the **Environment** tab or run:  \n",
    '`export HF_TOKEN="hf_your_token_here"`'
]))

cells.append(make_code_cell([
    "import os\n",
    "\n",
    'env["HF_TOKEN"] = os.environ["HF_TOKEN"]'
]))
<% } %>
<% if (typeof ngcTokenArn !== 'undefined' && ngcTokenArn) { %>
# NGC_API_KEY_ARN is configured — resolve via Secrets Manager
cells.append(make_code_cell([
    "import boto3 as _boto3_secrets\n",
    "\n",
    f'NGC_API_KEY_ARN = "{env("NGC_API_KEY_ARN")}"\n',
    "\n",
    "secrets_client = _boto3_secrets.client('secretsmanager', region_name=AWS_REGION)\n",
    "ngc_key = secrets_client.get_secret_value(SecretId=NGC_API_KEY_ARN)['SecretString']\n",
    'env["NGC_API_KEY"] = ngc_key'
]))
<% } else if (ngcApiKey) { %>
# NGC_API_KEY is configured — read from environment variable at notebook runtime
cells.append(make_markdown_cell([
    "### \u26a0\ufe0f NVIDIA NGC API Key Required\n",
    "\n",
    "Set the `NGC_API_KEY` environment variable before running the next cell.  \n",
    "In SageMaker Studio, use the **Environment** tab or run:  \n",
    '`export NGC_API_KEY="your_ngc_key_here"`'
]))

cells.append(make_code_cell([
    "import os\n",
    "\n",
    'env["NGC_API_KEY"] = os.environ["NGC_API_KEY"]'
]))
<% } %>

# ── Section 3: Build & Push ──────────────────────────────────────────────────

<% if (modelServer !== 'lmi' && modelServer !== 'djl') { %>
cells.append(make_markdown_cell([
    "## Build & Push Container\n",
    "\n",
    "Build the container via CodeBuild and push to ECR.\n"
]))

cells.append(make_code_cell([
    'CODEBUILD_PROJECT_NAME = f"{PROJECT_NAME}-build"\n',
    'cb_client = boto3.client("codebuild", region_name=AWS_REGION)\n',
    '\n',
    'build = cb_client.start_build(\n',
    '    projectName=CODEBUILD_PROJECT_NAME,\n',
    '    sourceVersion="main",\n',
    ')\n',
    'build_id = build["build"]["id"]\n',
    'print(f"Build started: {build_id}")\n',
    '\n',
    'while True:\n',
    '    resp = cb_client.batch_get_builds(ids=[build_id])\n',
    '    status = resp["builds"][0]["buildStatus"]\n',
    '    phase = resp["builds"][0].get("currentPhase", "UNKNOWN")\n',
    '    if status == "SUCCEEDED":\n',
    '        print(f"\\u2705 Build succeeded")\n',
    '        break\n',
    '    elif status in ("FAILED", "FAULT", "TIMED_OUT", "STOPPED"):\n',
    '        print(f"\\u274c Build {status}")\n',
    '        break\n',
    '    print(f"   {phase}... ({status})")\n',
    '    time.sleep(30)\n',
]))

cells.append(make_code_cell([
    f'image_uri = f"{{account_id}}.dkr.ecr.{{region}}.amazonaws.com/{env("PROJECT_NAME")}:{env("PROJECT_NAME")}-latest"\n',
    'print(f"Image URI: {image_uri}")'
]))
<% } else { %>
cells.append(make_markdown_cell([
    "## Container Image\n",
    "\n",
    "Using AWS Deep Learning Container (DLC) image.\n"
]))

cells.append(make_code_cell([
    f'image_uri = sagemaker.image_uris.retrieve(\n',
    f'    framework="<%= modelServer %>",\n',
    f'    region=region,\n',
    f'    version="latest",\n',
    f'    instance_type=INSTANCE_TYPE,\n',
    f')\n',
    'print(f"DLC Image URI: {image_uri}")'
]))
<% } %>

# ── Section 4: Model ─────────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Create SageMaker Model\n",
    "\n",
    "Define the model container and environment variables.\n"
]))

cells.append(make_code_cell([
    'model_name = f"{PROJECT_NAME}-model-{int(time.time())}"\n',
    '\n',
    'sm_client.create_model(\n',
    '    ModelName=model_name,\n',
    '    ExecutionRoleArn=role,\n',
    '    PrimaryContainer={\n',
    '        "Image": image_uri,\n',
    '        "Environment": env,\n',
    '    },\n',
    ')\n',
    '\n',
    'print(f"✅ Model created: {model_name}")'
]))

<% if (deploymentTarget === 'realtime-inference') { %>
# ── Section 5: Endpoint ──────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Create Endpoint\n",
    "\n",
    "Create an endpoint configuration and deploy the endpoint.\n"
]))

# Create endpoint config
cells.append(make_code_cell([
    'endpoint_config_name = f"{PROJECT_NAME}-epc-{int(time.time())}"\n',
    '\n',
    'production_variant = {\n',
    '    "VariantName": "AllTraffic",\n',
    '    "InstanceType": INSTANCE_TYPE,\n',
    '    "InitialInstanceCount": 1,\n',
    '    "ContainerStartupHealthCheckTimeoutInSeconds": HEALTH_CHECK_TIMEOUT,\n',
    '}\n',
    '\n',
    '# Include InferenceAmiVersion if configured\n',
    'if INFERENCE_AMI_VERSION:\n',
    '    production_variant["InferenceAmiVersion"] = INFERENCE_AMI_VERSION\n',
    '\n',
    'sm_client.create_endpoint_config(\n',
    '    EndpointConfigName=endpoint_config_name,\n',
    '    ExecutionRoleArn=role,\n',
    '    ProductionVariants=[production_variant],\n',
    ')\n',
    '\n',
    'print(f"✅ Endpoint config created: {endpoint_config_name}")'
]))

# Create endpoint
cells.append(make_code_cell([
    'sm_client.create_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    EndpointConfigName=endpoint_config_name,\n',
    ')\n',
    '\n',
    'print(f"Creating endpoint: {ENDPOINT_NAME}...")\n',
    '\n',
    '# Wait for InService\n',
    'while True:\n',
    '    resp = sm_client.describe_endpoint(EndpointName=ENDPOINT_NAME)\n',
    '    status = resp["EndpointStatus"]\n',
    '    if status == "InService":\n',
    '        print(f"✅ Endpoint InService: {ENDPOINT_NAME}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        print(f"❌ Endpoint failed: {resp.get(\'FailureReason\', \'Unknown\')}")\n',
    '        break\n',
    '    print(f"   Status: {status}...")\n',
    '    time.sleep(30)'
]))

# ── Section 6: Inference Component ───────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Create Inference Component\n",
    "\n",
    "Attach the model to the endpoint with compute resource allocation.  \n",
    "This is separate from the endpoint to support multi-LoRA adapter extensibility.\n"
]))

cells.append(make_code_cell([
    'ic_name = f"{PROJECT_NAME}-ic-{int(time.time())}"\n',
    '\n',
    'sm_client.create_inference_component(\n',
    '    InferenceComponentName=ic_name,\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    VariantName="AllTraffic",\n',
    '    Specification={\n',
    '        "ModelName": model_name,\n',
    '        "Container": {\n',
    '            "Image": image_uri,\n',
    '            "Environment": env,\n',
    '        },\n',
    '        "ComputeResourceRequirements": {\n',
    '            "NumberOfAcceleratorDevicesRequired": IC_GPU_COUNT,\n',
    '            "MinMemoryRequiredInMb": IC_MIN_MEMORY_MB,\n',
    '        },\n',
    '    },\n',
    '    RuntimeConfig={\n',
    '        "CopyCount": 1,\n',
    '    },\n',
    ')\n',
    '\n',
    'print(f"Creating inference component: {ic_name}...")\n',
    '\n',
    '# Wait for IC InService\n',
    'while True:\n',
    '    resp = sm_client.describe_inference_component(InferenceComponentName=ic_name)\n',
    '    status = resp["InferenceComponentStatus"]\n',
    '    if status == "InService":\n',
    '        print(f"✅ Inference Component InService: {ic_name}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        print(f"❌ IC failed: {resp.get(\'FailureReason\', \'Unknown\')}")\n',
    '        break\n',
    '    print(f"   Status: {status}...")\n',
    '    time.sleep(30)'
]))

# ── Section 7: Test ──────────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Test Inference\n",
    "\n",
    "Send a test request to the deployed model.\n"
]))

<% if (framework === 'transformers') { %>
cells.append(make_code_cell([
    'payload = {\n',
    '    "messages": [{"role": "user", "content": "What is machine learning?"}],\n',
    '    "max_tokens": 100,\n',
    '    "temperature": 0.7,\n',
    '}\n',
    '\n',
    'response = smr_client.invoke_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    InferenceComponentName=ic_name,\n',
    '    ContentType="application/json",\n',
    '    Body=json.dumps(payload),\n',
    ')\n',
    '\n',
    'result = json.loads(response["Body"].read().decode())\n',
    'print(result["choices"][0]["message"]["content"])'
]))
<% } else { %>
cells.append(make_code_cell([
    'payload = {\n',
    '    "inputs": "What is machine learning?",\n',
    '    "parameters": {"max_new_tokens": 100},\n',
    '}\n',
    '\n',
    'response = smr_client.invoke_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    InferenceComponentName=ic_name,\n',
    '    ContentType="application/json",\n',
    '    Body=json.dumps(payload),\n',
    ')\n',
    '\n',
    'result = json.loads(response["Body"].read().decode())\n',
    'print(json.dumps(result, indent=2))'
]))
<% } %>
<% if (enableLora) { %>
# ── Section 8: LoRA Adapter ──────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## 🔗 LoRA Adapter\n",
    "\n",
    "LoRA (Low-Rank Adaptation) adapters let you serve multiple fine-tuned \"personalities\"\n",
    "from a single base model. Adapter ICs share the base IC's GPU resources — no additional\n",
    "compute allocation is needed. You can add/remove adapters without redeploying the endpoint.\n"
]))

cells.append(make_code_cell([
    '# ✏️ Edit these values to configure your adapter\n',
    'ADAPTER_NAME = "my-adapter"\n',
    f'ADAPTER_WEIGHTS_URI = "{env("TUNE_ADAPTER_PATH_SFT", env("TUNE_ADAPTER_PATH_DPO", env("TUNE_OUTPUT_PATH_LATEST", "s3://your-bucket/adapters/my-adapter/adapter.tar.gz")))}"\n',
]))

cells.append(make_code_cell([
    'adapter_ic_name = f"{PROJECT_NAME}-adapter-{ADAPTER_NAME}"\n',
    '\n',
    'sm_client.create_inference_component(\n',
    '    InferenceComponentName=adapter_ic_name,\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    Specification={\n',
    '        "BaseInferenceComponentName": ic_name,\n',
    '        "Container": {\n',
    '            "ArtifactUrl": ADAPTER_WEIGHTS_URI,\n',
    '        },\n',
    '    },\n',
    ')\n',
    '\n',
    'print(f"Creating adapter IC: {adapter_ic_name}...")\n',
    '\n',
    '# Wait for adapter IC InService\n',
    'while True:\n',
    '    resp = sm_client.describe_inference_component(InferenceComponentName=adapter_ic_name)\n',
    '    status = resp["InferenceComponentStatus"]\n',
    '    if status == "InService":\n',
    '        print(f"✅ Adapter IC InService: {adapter_ic_name}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        print(f"❌ Adapter IC failed: {resp.get(\'FailureReason\', \'Unknown\')}")\n',
    '        break\n',
    '    print(f"   Status: {status}...")\n',
    '    time.sleep(30)'
]))

<% if (framework === 'transformers') { %>
cells.append(make_code_cell([
    'payload = {\n',
    '    "messages": [{"role": "user", "content": "What is machine learning?"}],\n',
    '    "max_tokens": 100,\n',
    '    "temperature": 0.7,\n',
    '}\n',
    '\n',
    'response = smr_client.invoke_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    InferenceComponentName=adapter_ic_name,\n',
    '    ContentType="application/json",\n',
    '    Body=json.dumps(payload),\n',
    ')\n',
    '\n',
    'result = json.loads(response["Body"].read().decode())\n',
    'print(f"Adapter \'{ADAPTER_NAME}\' response:")\n',
    'print(result["choices"][0]["message"]["content"])'
]))
<% } else { %>
cells.append(make_code_cell([
    'payload = {\n',
    '    "inputs": "What is machine learning?",\n',
    '    "parameters": {"max_new_tokens": 100},\n',
    '}\n',
    '\n',
    'response = smr_client.invoke_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    InferenceComponentName=adapter_ic_name,\n',
    '    ContentType="application/json",\n',
    '    Body=json.dumps(payload),\n',
    ')\n',
    '\n',
    'result = json.loads(response["Body"].read().decode())\n',
    'print(f"Adapter \'{ADAPTER_NAME}\' response:")\n',
    'print(json.dumps(result, indent=2))'
]))
<% } %>

cells.append(make_markdown_cell([
    "### Adding More Adapters\n",
    "\n",
    "To add another adapter, duplicate this section with a different `ADAPTER_NAME` and\n",
    "`ADAPTER_WEIGHTS_URI`. Each adapter shares the base IC's GPU resources.\n",
    "\n",
    "The CLI equivalent is: `./do/adapter add <name> --weights <s3-uri>`\n"
]))
<% } %>
<% if (tuneSupported) { %>
# ── Section 9: Fine-Tune ─────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## 🎯 Managed Fine-Tuning\n",
    "\n",
    "SageMaker Managed Model Customization provides serverless fine-tuning — no instance\n",
    "selection or container management needed. You provide a dataset and technique; SageMaker\n",
    "handles infrastructure and optimization. The output is either LoRA adapter weights or a\n",
    "full merged model, depending on the training type.\n"
]))

cells.append(make_code_cell([
    '# ✏️ Edit these values to configure your fine-tuning job\n',
    'TECHNIQUE = "sft"  # Options: sft, dpo, rlaif, rlvr\n',
    'TRAINING_TYPE = "lora"  # Options: lora, full-rank\n',
    'DATASET_S3_URI = "s3://your-bucket/datasets/train.jsonl"  # ← Replace with your dataset\n',
    f'TUNE_OUTPUT_BUCKET = "{env("TUNE_S3_BUCKET")}"'
]))

cells.append(make_code_cell([
    'from sagemaker.modules.train import ModelTrainer\n',
    '\n',
    f'MODEL_NAME = "{env("MODEL_NAME")}"\n',
    '\n',
    'job_name = f"{PROJECT_NAME}-tune-{TECHNIQUE}-{int(time.time())}"\n',
    '\n',
    'trainer = ModelTrainer(\n',
    '    model_id=MODEL_NAME,\n',
    '    training_dataset={"s3Uri": DATASET_S3_URI},\n',
    '    technique=TECHNIQUE,\n',
    '    training_type=TRAINING_TYPE,\n',
    '    output_path=f"s3://{TUNE_OUTPUT_BUCKET}/{PROJECT_NAME}/output/",\n',
    '    role=role,\n',
    ')\n',
    'trainer.train()\n',
    '\n',
    'print(f"✅ Training job submitted: {job_name}")'
]))

cells.append(make_code_cell([
    'import time as _time\n',
    'start_time = _time.time()\n',
    '\n',
    'while True:\n',
    '    status = trainer.describe()["TrainingJobStatus"]\n',
    '    elapsed = int(_time.time() - start_time)\n',
    '    elapsed_str = f"{elapsed // 60}m {elapsed % 60}s"\n',
    '\n',
    '    if status == "Completed":\n',
    '        print(f"✅ Training completed in {elapsed_str}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        reason = trainer.describe().get("FailureReason", "Unknown")\n',
    '        print(f"❌ Training failed after {elapsed_str}: {reason}")\n',
    '        break\n',
    '    print(f"   Status: {status} (elapsed: {elapsed_str})...")\n',
    '    _time.sleep(60)'
]))

cells.append(make_code_cell([
    'job_desc = trainer.describe()\n',
    'output_path = job_desc["ModelArtifacts"]["S3ModelArtifacts"]\n',
    'print(f"Output artifacts: {output_path}")'
]))

cells.append(make_markdown_cell([
    "### Next Steps\n",
    "\n",
    "**If LoRA output** (TRAINING_TYPE=\"lora\"):  \n",
    "- Run the adapter section above with `ADAPTER_WEIGHTS_URI` set to the output path  \n",
    "- Or use the CLI: `./do/adapter add tuned-sft --from-tune`\n",
    "\n",
    "**If full-rank output** (TRAINING_TYPE=\"full-rank\"):  \n",
    "- Deploy as a new inference component: `./do/add-ic tuned-v1 --from-tune`\n"
]))
<% } %>

# ── Section 10: Cleanup ───────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## ⚠️ Cleanup\n",
    "\n",
    "**Warning**: This will delete all deployed resources. Only run when you're done testing.\n"
]))

cells.append(make_code_cell([
    '# Delete in reverse dependency order\n',
    '\n',
    '# 1. Delete adapter IC (if created in Section 8)\n',
    'try:\n',
    '    sm_client.delete_inference_component(InferenceComponentName=adapter_ic_name)\n',
    '    print(f"Deleting adapter IC: {adapter_ic_name}...")\n',
    '    time.sleep(15)\n',
    'except NameError:\n',
    '    pass  # adapter_ic_name not defined — Section 8 was not run\n',
    'except Exception as e:\n',
    '    print(f"Note: {e}")\n',
    '\n',
    '# 2. Delete base IC\n',
    'sm_client.delete_inference_component(InferenceComponentName=ic_name)\n',
    'print(f"Deleting base IC: {ic_name}...")\n',
    'time.sleep(30)\n',
    '\n',
    '# 3. Delete endpoint\n',
    'sm_client.delete_endpoint(EndpointName=ENDPOINT_NAME)\n',
    'print(f"Deleting endpoint: {ENDPOINT_NAME}...")\n',
    '\n',
    '# 4. Delete endpoint config\n',
    'sm_client.delete_endpoint_config(EndpointConfigName=endpoint_config_name)\n',
    'print(f"Deleting endpoint config: {endpoint_config_name}...")\n',
    '\n',
    '# 5. Delete model\n',
    'sm_client.delete_model(ModelName=model_name)\n',
    'print(f"Deleting model: {model_name}...")\n',
    '\n',
    'print("\\n✅ All resources cleaned up")'
]))
<% } else if (deploymentTarget === 'async-inference') { %>
# ── Section 5: Endpoint (Async) ──────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Create Async Endpoint\n",
    "\n",
    "Create an endpoint configuration with async inference settings and deploy the endpoint.  \n",
    "Async inference is ideal for large payloads or long-running predictions — results are\n",
    "written to S3 when ready.\n"
]))

# Create endpoint config with AsyncInferenceConfig
cells.append(make_code_cell([
    'endpoint_config_name = f"{PROJECT_NAME}-epc-{int(time.time())}"\n',
    '\n',
    'sm_client.create_endpoint_config(\n',
    '    EndpointConfigName=endpoint_config_name,\n',
    '    ExecutionRoleArn=role,\n',
    '    ProductionVariants=[\n',
    '        {\n',
    '            "VariantName": "AllTraffic",\n',
    '            "InstanceType": INSTANCE_TYPE,\n',
    '            "InitialInstanceCount": 1,\n',
    '            "ContainerStartupHealthCheckTimeoutInSeconds": HEALTH_CHECK_TIMEOUT,\n',
    '        }\n',
    '    ],\n',
    '    AsyncInferenceConfig={\n',
    '        "OutputConfig": {\n',
    '            "S3OutputPath": f"s3://{PROJECT_NAME}-async-output/{PROJECT_NAME}/",\n',
    '        },\n',
    '        "ClientConfig": {\n',
    '            "MaxConcurrentInvocationsPerInstance": 4,\n',
    '        },\n',
    '    },\n',
    ')\n',
    '\n',
    'print(f"✅ Async endpoint config created: {endpoint_config_name}")'
]))

# Create endpoint
cells.append(make_code_cell([
    'sm_client.create_endpoint(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    EndpointConfigName=endpoint_config_name,\n',
    ')\n',
    '\n',
    'print(f"Creating endpoint: {ENDPOINT_NAME}...")\n',
    '\n',
    '# Wait for InService\n',
    'while True:\n',
    '    resp = sm_client.describe_endpoint(EndpointName=ENDPOINT_NAME)\n',
    '    status = resp["EndpointStatus"]\n',
    '    if status == "InService":\n',
    '        print(f"✅ Endpoint InService: {ENDPOINT_NAME}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        print(f"❌ Endpoint failed: {resp.get(\'FailureReason\', \'Unknown\')}")\n',
    '        break\n',
    '    print(f"   Status: {status}...")\n',
    '    time.sleep(30)'
]))

# ── Section 6: Inference Component — SKIPPED for async ───────────────────────
# Async inference does not support inference components.

# ── Section 7: Test (Async) ──────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Test Async Inference\n",
    "\n",
    "Upload input to S3, invoke the async endpoint, then poll S3 for the result.\n"
]))

cells.append(make_code_cell([
    'import boto3\n',
    '\n',
    's3_client = boto3.client("s3", region_name=AWS_REGION)\n',
    'async_input_bucket = f"{PROJECT_NAME}-async-output"\n',
    'async_input_key = f"{PROJECT_NAME}/input/test-request.json"\n',
    '\n',
<% if (framework === 'transformers') { %>
    'payload = {\n',
    '    "messages": [{"role": "user", "content": "What is machine learning?"}],\n',
    '    "max_tokens": 100,\n',
    '    "temperature": 0.7,\n',
    '}\n',
<% } else { %>
    'payload = {\n',
    '    "inputs": "What is machine learning?",\n',
    '    "parameters": {"max_new_tokens": 100},\n',
    '}\n',
<% } %>
    '\n',
    '# Upload input payload to S3\n',
    's3_client.put_object(\n',
    '    Bucket=async_input_bucket,\n',
    '    Key=async_input_key,\n',
    '    Body=json.dumps(payload),\n',
    '    ContentType="application/json",\n',
    ')\n',
    'input_s3_uri = f"s3://{async_input_bucket}/{async_input_key}"\n',
    'print(f"Input uploaded to: {input_s3_uri}")'
]))

cells.append(make_code_cell([
    '# Invoke async endpoint\n',
    'response = smr_client.invoke_endpoint_async(\n',
    '    EndpointName=ENDPOINT_NAME,\n',
    '    ContentType="application/json",\n',
    '    InputLocation=input_s3_uri,\n',
    ')\n',
    'output_location = response["OutputLocation"]\n',
    'print(f"Output will be at: {output_location}")\n',
    '\n',
    '# Poll S3 for the result\n',
    'import urllib.parse\n',
    'parsed = urllib.parse.urlparse(output_location)\n',
    'output_bucket = parsed.netloc\n',
    'output_key = parsed.path.lstrip("/")\n',
    '\n',
    'print("Waiting for result...")\n',
    'while True:\n',
    '    try:\n',
    '        result_obj = s3_client.get_object(Bucket=output_bucket, Key=output_key)\n',
    '        result = json.loads(result_obj["Body"].read().decode())\n',
    '        print("\\n✅ Async inference result:")\n',
    '        print(json.dumps(result, indent=2))\n',
    '        break\n',
    '    except s3_client.exceptions.NoSuchKey:\n',
    '        print("   Waiting for output...")\n',
    '        time.sleep(10)'
]))

# ── Sections 8-9: SKIPPED for async ─────────────────────────────────────────
# LoRA adapters and fine-tuning require a realtime endpoint with inference components.

# ── Section 10: Cleanup (Async) ──────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## ⚠️ Cleanup\n",
    "\n",
    "**Warning**: This will delete all deployed resources. Only run when you're done testing.  \n",
    "Note: The S3 output bucket and any SNS topics are NOT deleted (user-managed).\n"
]))

cells.append(make_code_cell([
    '# Delete in reverse dependency order (no IC for async)\n',
    '\n',
    '# 1. Delete endpoint\n',
    'sm_client.delete_endpoint(EndpointName=ENDPOINT_NAME)\n',
    'print(f"Deleting endpoint: {ENDPOINT_NAME}...")\n',
    '\n',
    '# 2. Delete endpoint config\n',
    'sm_client.delete_endpoint_config(EndpointConfigName=endpoint_config_name)\n',
    'print(f"Deleting endpoint config: {endpoint_config_name}...")\n',
    '\n',
    '# 3. Delete model\n',
    'sm_client.delete_model(ModelName=model_name)\n',
    'print(f"Deleting model: {model_name}...")\n',
    '\n',
    'print("\\n✅ All resources cleaned up")\n',
    'print("Note: S3 output bucket and SNS topics are not deleted (user-managed).")'
]))
<% } else if (deploymentTarget === 'batch-transform') { %>
# ── Section 5: Batch Transform Job ───────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Create Batch Transform Job\n",
    "\n",
    "Run batch inference on your input data stored in S3.  \n",
    "The transform job reads input from S3, runs inference, and writes output back to S3.\n"
]))

cells.append(make_code_cell([
    'INPUT_S3_URI = "s3://your-bucket/input/"  # ← Replace with your input data S3 path\n',
    'OUTPUT_S3_URI = "s3://your-bucket/output/"  # ← Replace with your desired output S3 path\n',
    '\n',
    'transform_job_name = f"{PROJECT_NAME}-transform-{int(time.time())}"\n',
    '\n',
    'sm_client.create_transform_job(\n',
    '    TransformJobName=transform_job_name,\n',
    '    ModelName=model_name,\n',
    '    TransformInput={\n',
    '        "DataSource": {\n',
    '            "S3DataSource": {\n',
    '                "S3DataType": "S3Prefix",\n',
    '                "S3Uri": INPUT_S3_URI,\n',
    '            }\n',
    '        },\n',
    '        "ContentType": "application/json",\n',
    '    },\n',
    '    TransformOutput={\n',
    '        "S3OutputPath": OUTPUT_S3_URI,\n',
    '    },\n',
    '    TransformResources={\n',
    '        "InstanceType": INSTANCE_TYPE,\n',
    '        "InstanceCount": 1,\n',
    '    },\n',
    ')\n',
    '\n',
    'print(f"Transform job started: {transform_job_name}")\n',
    '\n',
    '# Wait for transform job to complete\n',
    'while True:\n',
    '    resp = sm_client.describe_transform_job(TransformJobName=transform_job_name)\n',
    '    status = resp["TransformJobStatus"]\n',
    '    if status == "Completed":\n',
    '        print(f"✅ Transform job completed: {transform_job_name}")\n',
    '        break\n',
    '    elif status == "Failed":\n',
    '        print(f"❌ Transform job failed: {resp.get(\'FailureReason\', \'Unknown\')}")\n',
    '        break\n',
    '    elif status == "Stopped":\n',
    '        print(f"⚠️ Transform job stopped")\n',
    '        break\n',
    '    print(f"   Status: {status}...")\n',
    '    time.sleep(30)'
]))

# ── Section 7: Test (Download Output) ────────────────────────────────────────

cells.append(make_markdown_cell([
    "## Review Transform Output\n",
    "\n",
    "Download and display a sample result from the batch transform output.\n"
]))

cells.append(make_code_cell([
    'import boto3\n',
    'from urllib.parse import urlparse\n',
    '\n',
    's3 = boto3.client("s3", region_name=AWS_REGION)\n',
    '\n',
    '# Parse the output S3 URI\n',
    'parsed = urlparse(OUTPUT_S3_URI)\n',
    'bucket = parsed.netloc\n',
    'prefix = parsed.path.lstrip("/")\n',
    '\n',
    '# List output files\n',
    'response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)\n',
    'output_files = [obj["Key"] for obj in response.get("Contents", [])]\n',
    'print(f"Output files ({len(output_files)}):")\n',
    'for f in output_files[:10]:\n',
    '    print(f"  s3://{bucket}/{f}")\n',
    '\n',
    '# Download and display first result\n',
    'if output_files:\n',
    '    first_file = output_files[0]\n',
    '    obj = s3.get_object(Bucket=bucket, Key=first_file)\n',
    '    content = obj["Body"].read().decode("utf-8")\n',
    '    print(f"\\nSample output from: {first_file}")\n',
    '    print("-" * 60)\n',
    '    print(content[:2000])\n',
    'else:\n',
    '    print("No output files found.")'
]))

# ── Section 10: Cleanup ───────────────────────────────────────────────────────

cells.append(make_markdown_cell([
    "## ⚠️ Cleanup\n",
    "\n",
    "**Warning**: This will delete the model resource. Only run when you're done.  \n",
    "Note: The transform job is ephemeral and does not need deletion.\n"
]))

cells.append(make_code_cell([
    'sm_client.delete_model(ModelName=model_name)\n',
    'print(f"Deleting model: {model_name}...")\n',
    '\n',
    'print("\\n✅ All resources cleaned up")'
]))
<% } %>

# ── Write notebook ───────────────────────────────────────────────────────────

notebook = {
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {
        "kernelspec": {
            "display_name": "Python 3 (ipykernel)",
            "language": "python",
            "name": "python3"
        },
        "language_info": {
            "name": "python",
            "version": "3.10.0"
        }
    },
    "cells": cells
}

output_path = "deploy_notebook.ipynb"
with open(output_path, "w") as f:
    json.dump(notebook, f, indent=1)

print(f"\u2705 Notebook exported: ./{output_path}")
