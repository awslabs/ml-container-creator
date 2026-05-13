# Examples

Concise walkthroughs for each deployment configuration. Every example follows the same pattern: generate, build, deploy, test. For a full end-to-end tutorial, see [Getting Started](getting-started.md).

## HTTP: sklearn + Flask

Deploy a scikit-learn model with Flask serving on a CPU instance.

```bash
ml-container-creator sklearn-flask-demo \
  --deployment-config=http-flask \
  --engine=sklearn \
  --model-format=pkl \
  --include-sample-model \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

Copy your own model into the project (or use the generated sample):

```bash
cp /path/to/model.pkl code/model.pkl
```

Build, push, deploy:

```bash
./do/build
./do/push
./do/deploy
./do/test
```

## HTTP: XGBoost + FastAPI

Deploy an XGBoost model with FastAPI serving.

```bash
ml-container-creator xgboost-fastapi-demo \
  --deployment-config=http-fastapi \
  --engine=xgboost \
  --model-format=json \
  --include-sample-model \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/build && ./do/push && ./do/deploy && ./do/test
```

## HTTP: TensorFlow + Flask

Deploy a TensorFlow SavedModel with Flask serving.

```bash
ml-container-creator tf-flask-demo \
  --deployment-config=http-flask \
  --engine=tensorflow \
  --model-format=SavedModel \
  --include-sample-model \
  --deployment-target=managed-inference \
  --instance-type=ml.m5.large \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/build && ./do/push && ./do/deploy && ./do/test
```

## Transformers: vLLM

Deploy an LLM with vLLM. GPU instance required.

```bash
ml-container-creator vllm-demo \
  --deployment-config=transformers-vllm \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=managed-inference \
  --instance-type=ml.g6.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

LLM containers are large. Use CodeBuild for the image build:

```bash
./do/submit    # Build and push via CodeBuild
./do/deploy
./do/test
```

For gated models (e.g., Llama), add `--hf-token='$HF_TOKEN'` and export the token in your environment. See [HuggingFace Authentication](configuration.md#huggingface-authentication).

## Transformers: SGLang

Deploy an LLM with SGLang. Same workflow as vLLM with a different deployment config.

```bash
ml-container-creator sglang-demo \
  --deployment-config=transformers-sglang \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=managed-inference \
  --instance-type=ml.g6.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/submit && ./do/deploy && ./do/test
```

## Transformers: TensorRT-LLM

Deploy an LLM with NVIDIA TensorRT-LLM. Requires NGC authentication for the base image and A10G or newer GPUs (ml.g5 instances, not ml.g6).

```bash
ml-container-creator trtllm-demo \
  --deployment-config=transformers-tensorrt-llm \
  --model-name=meta-llama/Llama-3.2-3B-Instruct \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

Set your NGC API key before building:

```bash
export NGC_API_KEY='your-ngc-api-key'
./do/submit && ./do/deploy && ./do/test
```

The generated container runs TensorRT-LLM on port 8081 behind an Nginx reverse proxy on port 8080 for SageMaker compatibility. Key environment variables for tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `TRTLLM_TP_SIZE` | `1` | Tensor parallelism (set to GPU count) |
| `TRTLLM_MAX_BATCH_SIZE` | `256` | Maximum batch size |
| `TRTLLM_MAX_INPUT_LEN` | `2048` | Maximum input token length |
| `TRTLLM_MAX_OUTPUT_LEN` | `512` | Maximum output token length |

## Transformers: LMI (Large Model Inference)

Deploy an LLM with AWS Large Model Inference (DJL-based). Uses `serving.properties` for configuration instead of environment variables.

```bash
ml-container-creator lmi-demo \
  --deployment-config=transformers-lmi \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/submit && ./do/deploy && ./do/test
```

## Transformers: DJL

Deploy an LLM with Deep Java Library serving.

```bash
ml-container-creator djl-demo \
  --deployment-config=transformers-djl \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/submit && ./do/deploy && ./do/test
```

## Triton: FIL (Tree Models)

Deploy XGBoost or LightGBM models on NVIDIA Triton Inference Server using the Forest Inference Library backend.

```bash
ml-container-creator triton-fil-demo \
  --deployment-config=triton-fil \
  --model-format=json \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

The generator creates a Triton model repository layout with `config.pbtxt`. Place your model file in the generated `model_repository/` directory before building.

```bash
./do/build && ./do/push && ./do/deploy && ./do/test
```

## Triton: ONNX Runtime

Deploy ONNX models on Triton.

```bash
ml-container-creator triton-onnx-demo \
  --deployment-config=triton-onnxruntime \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/build && ./do/push && ./do/deploy && ./do/test
```

## Triton: Python Backend

Deploy custom Python models on Triton. The Python backend gives full control over preprocessing, inference, and postprocessing logic.

```bash
ml-container-creator triton-python-demo \
  --deployment-config=triton-python \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

Edit the generated `model.py` in the model repository to implement your inference logic, then build and deploy.

## CodeBuild CI/CD

Any of the examples above can use CodeBuild for the image build instead of building locally. Set `--build-target=codebuild` during generation, then use `./do/submit` instead of `./do/build` + `./do/push`:

```bash
./do/submit    # Creates CodeBuild project, uploads source, builds, pushes to ECR
./do/deploy    # Deploy the CodeBuild-built image
./do/test      # Validate the endpoint
```

`./do/submit` automatically creates the CodeBuild project, IAM service role, and S3 source bucket on first run. All projects share a single ECR repository (`ml-container-creator`) with project-specific image tags.

## HyperPod EKS Deployment

Any of the examples above can target HyperPod EKS instead of managed inference. Set `--deployment-target=hyperpod-eks` and provide your cluster details:

```bash
ml-container-creator hyperpod-demo \
  --deployment-config=transformers-vllm \
  --model-name=openai/gpt-oss-20b \
  --deployment-target=hyperpod-eks \
  --hyperpod-cluster=my-cluster \
  --hyperpod-namespace=ml-serving \
  --instance-type=ml.g5.12xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --skip-prompts
```

```bash
./do/submit && ./do/deploy && ./do/test hyperpod
```

## Benchmarking: Generate → Deploy → Benchmark → Results

Measure LLM endpoint performance using SageMaker AI Benchmarking (NVIDIA AIPerf). Benchmarking is available for transformer and diffusor architectures only.

Generate a project with benchmarking enabled:

```bash
ml-container-creator vllm-benchmark-demo \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3.1-8B-Instruct \
  --deployment-target=managed-inference \
  --instance-type=ml.g5.2xlarge \
  --build-target=codebuild \
  --region=us-east-1 \
  --include-benchmark \
  --benchmark-concurrency=10 \
  --benchmark-input-tokens=550 \
  --benchmark-output-tokens=150 \
  --benchmark-streaming \
  --skip-prompts
```

Build, deploy, and wait for the endpoint to reach `InService`:

```bash
cd vllm-benchmark-demo
./do/submit    # Build and push via CodeBuild
./do/deploy
```

Run the benchmark against the deployed endpoint:

```bash
./do/benchmark
```

Example output:

```
✓ Endpoint is InService
✓ Created workload config: vllm-benchmark-demo-benchmark-config
✓ Created benchmark job: vllm-benchmark-demo-benchmark-20250115-143022
⏳ Polling for completion (every 30s, up to 30 min)...
✓ Benchmark completed

┌─────────────────────────────┬───────────┐
│ Metric                      │ Value     │
├─────────────────────────────┼───────────┤
│ Request throughput (req/s)  │ 8.42      │
│ Output token throughput     │ 1,263     │
│ Request latency P50         │ 1.12s     │
│ Request latency P90         │ 1.58s     │
│ Request latency P99         │ 2.34s     │
│ TTFT P50                    │ 85ms      │
│ TTFT P90                    │ 142ms     │
│ TTFT P99                    │ 298ms     │
│ ITL P50                     │ 7.2ms     │
│ ITL P90                     │ 12.1ms    │
│ ITL P99                     │ 24.8ms    │
└─────────────────────────────┴───────────┘
```

Clean up benchmark resources when done:

```bash
./do/benchmark --clean    # Delete workload config and benchmark jobs
./do/clean all            # Delete endpoint, ECR images, and benchmark resources
```

For parameter tuning and interpreting results, see [Benchmarking](benchmarking.md).

## Cleanup

Tear down resources when done to stop incurring charges:

```bash
./do/clean endpoint   # Delete SageMaker endpoint, config, and inference component
./do/clean ecr        # Delete ECR images
./do/clean codebuild  # Delete CodeBuild project and IAM role
./do/clean benchmark  # Delete workload configs and benchmark jobs
./do/clean all        # All of the above
```
