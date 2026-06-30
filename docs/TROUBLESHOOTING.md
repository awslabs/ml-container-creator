# Troubleshooting

Common issues and solutions when using ML Container Creator.

## Quick Reference

| Issue | Fix |
|-------|-----|
| `SyntaxError: Unexpected token 'export'` | `nvm use node` (requires Node.js 24.11.1+) |
| Generator not found | `npm link` in the project directory |
| Docker build fails: package not found | Pin versions in `requirements.txt` |
| Container exits immediately | `docker logs <id>` to check for errors |
| `/ping` returns connection refused | Verify container is running and port 8080 is exposed |
| ECR authentication failed | `aws ecr get-login-password` (see [ECR Auth](#ecr-authentication-failed)) |
| Endpoint stuck in Creating | Check CloudWatch logs for health check or model loading failures |
| Model file not found in container | Verify `COPY` directive in Dockerfile targets `/opt/ml/model/` |
| Adapter "Not Found" on first call | Wait 60s after `do/adapter add` (see [LoRA Adapter Issues](#lora-adapter-issues)) |
| Adapter read timeout | `./do/test --cli-read-timeout 120` |
| Adapter wrong model name | Use base model name, not adapter name (see [Wrong Model Name](#wrong-model-name-in-adapter-test)) |
| HuggingFace API timeout | Use `--offline` flag |
| HuggingFace access denied | Verify token and model license agreement |

## Generator Issues

### Generator Not Found

```
Error: @aws/ml-container-creator generator not found
```

```bash
cd ml-container-creator
npm link
ml-container-creator --help   # Should show available commands
```

### Node.js Version Error

```
SyntaxError: Unexpected token 'export'
SyntaxError: Cannot use import statement outside a module
```

MCC requires Node.js 24.11.1+ for ES module support:

```bash
nvm install node
nvm use node
node --version    # Must be 24.11.1+
```

### CLI Not Found in CI

```bash
npm install -g @aws/ml-container-creator
ml-container-creator --help
```

## Docker Build Issues

### Package Not Found

```
ERROR: Could not find a version that satisfies the requirement scikit-learn
```

Pin versions in `requirements.txt`:

```
scikit-learn==1.3.0
numpy==1.24.0
```

Or rebuild without cache: `docker build --no-cache -t my-model .`

### Permission Denied

```
ERROR: failed to copy files: permission denied
```

```bash
chmod 644 code/*
chmod 755 code/*.sh
docker build -t my-model .
```

## Local Testing Issues

### Container Exits Immediately

```bash
docker logs <container-id>           # Check for startup errors
docker run -it my-model /bin/bash    # Debug interactively
```

Common causes: missing model file at `/opt/ml/model/`, missing Python dependencies, syntax errors in serve.py.

### Health Check Fails

```
curl: (7) Failed to connect to localhost port 8080
```

```bash
docker ps                            # Is the container running?
docker logs <container-id>           # Check for errors
```

If the container is running but not responding, the server may have failed to bind to port 8080. Check that the Dockerfile exposes port 8080 and the server is configured to listen on `0.0.0.0:8080`.

### Inference Returns Error

```bash
docker logs <container-id>           # Check for the full traceback
```

Common causes:

- Wrong input format -- ensure `Content-Type: application/json` header is set
- Feature count mismatch -- input must have the same number of features as training data
- Wrong data types -- ensure numeric values are floats, not strings

## AWS Deployment Issues

### ECR Authentication Failed

```
Error: no basic auth credentials
```

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com
```

Verify credentials: `aws sts get-caller-identity`

### IAM Permission Denied

```
Error: User is not authorized to perform: ecr:CreateRepository
```

Required permissions for deployment: `ecr:CreateRepository`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `sagemaker:CreateModel`, `sagemaker:CreateEndpointConfig`, `sagemaker:CreateEndpoint`, `iam:PassRole`. See the generated `IAM_PERMISSIONS.md` for the full policy document.

### Endpoint Creation Failed

```bash
aws logs tail /aws/sagemaker/Endpoints/<endpoint-name> --follow
```

Common causes:

- Invalid IAM role -- verify with `aws iam get-role --role-name <role>`
- Image not found in ECR -- verify with `aws ecr describe-images --repository-name <repo>`
- Insufficient instance capacity -- try a different instance type or region

### Endpoint Stuck in Creating

If the endpoint stays in `Creating` status for more than 15 minutes, check CloudWatch logs. Common causes:

- Container fails to start -- check Dockerfile `CMD`/`ENTRYPOINT` and verify port 8080 is exposed
- Health check fails -- `/ping` must return 200 within 2 seconds
- Model loading fails -- verify model file exists in the container and format matches the handler code

To recover: delete the endpoint and redeploy.

```bash
./do/clean endpoint
./do/deploy
```

### Endpoint Returns 500

```bash
aws logs tail /aws/sagemaker/Endpoints/<endpoint-name> --follow
```

Common causes: exception in prediction code, wrong input format, model not loaded. Test locally first:

```bash
./do/run
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'
```

## LoRA Adapter Issues

!!! tip "Testing a specific adapter"
    To test a specific adapter by name, use either syntax:
    ```bash
    # Positional (adapter name as argument)
    ./do/test my-adapter

    # Flag syntax
    ./do/test --adapter my-adapter
    ./do/test -a my-adapter
    ```
    Both route the request through the adapter's inference component and override the model name in the payload.

### "Not Found" Error on First Adapter Invocation

**Symptoms:** After `do/adapter add`, the first `do/test` returns `{"detail":"Not Found"}` but a second attempt works.

**Root cause:** The adapter inference component reports `InService` before vLLM finishes loading LoRA weights into GPU memory. SageMaker AI's readiness check passes (the base model's `/ping` returns 200) but the adapter isn't actually ready to serve yet.

**Workaround:** Wait 30–60 seconds after `do/adapter add` reports success before testing:

```bash
./do/adapter add my-sft --from-tune
sleep 60
./do/test
```

A future release will add a post-attach probe loop to confirm the adapter is serving before returning.

### Read Timeout on First Adapter Inference

**Symptoms:** First inference after adapter load returns a "Read timeout" error, but the response body contains valid JSON.

**Root cause:** The first inference triggers JIT compilation of the adapter path. Combined with thinking-mode tokens (for reasoning models like DeepSeek R1), this can exceed the default CLI read timeout.

**Fix:** Increase the read timeout:

```bash
./do/test --cli-read-timeout 120
```

Or accept that the first invocation is slow — subsequent calls will be fast.

### Wrong Model Name in Adapter Test

**Symptoms:** `do/test` sends the adapter name (e.g., `"val-sft"`) as the `model` field, but vLLM returns an error because it only recognizes the base model name.

**Root cause:** When adapter config is detected, `do/test` should use the base `MODEL_NAME` in the request's `"model"` field, not `ADAPTER_MODEL_NAME`. SageMaker AI handles adapter routing at the inference component layer — vLLM doesn't need to know the adapter name.

**Fix (pending):** This will be fixed in a future release. As a workaround, manually invoke with the base model name:

```bash
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name <endpoint> \
  --inference-component-name <adapter-ic-name> \
  --body '{"model": "Qwen/Qwen3-0.6B", "messages": [{"role": "user", "content": "Hello"}]}' \
  --content-type application/json \
  output.json
```

## Model Loading Issues

### Model File Not Found

```
FileNotFoundError: No such file or directory: '/opt/ml/model/model.pkl'
```

```bash
# Verify model is in the container
docker run my-model ls -la /opt/ml/model/

# Check the COPY directive in Dockerfile
grep "COPY.*model" Dockerfile
```

For predictive models, the model file must be copied into the container at build time. For transformer models, the serving framework downloads the model at runtime from HuggingFace Hub.

### Model Format Mismatch

```
ValueError: Model format not recognized
```

Verify the model file format matches what you selected during generation:

| Framework | Expected formats |
|-----------|-----------------|
| sklearn | `.pkl`, `.joblib` |
| xgboost | `.json`, `.model`, `.ubj` |
| tensorflow | `SavedModel/` directory, `.keras`, `.h5` |

### Pickle Version Mismatch

```
ValueError: unsupported pickle protocol: 5
```

The Python version used to save the model must match the version in the container. Either re-save the model with a compatible protocol (`pickle.dump(model, f, protocol=4)`) or update the Python version in the Dockerfile.

## HuggingFace Issues

### API Timeout

```
Warning: HuggingFace API timeout, checking local registry
```

This is expected behavior -- the generator falls back to local registry data. To skip HuggingFace API calls entirely:

```bash
ml-container-creator --offline
```

### Access Denied or Repository Not Found

```
Warning: Model 'my-org/my-model' not found on HuggingFace
```

For private or gated models:

1. Verify the model ID at `https://huggingface.co/<model-id>`
2. Accept the model's license agreement on HuggingFace (for gated models like Llama)
3. Provide a valid token: `--hf-token='$HF_TOKEN'`

See [HuggingFace Authentication](configuration.md#huggingface-authentication) for details.

### Rate Limit Exceeded

```
Warning: HuggingFace API rate limit exceeded, using cached data
```

Use `--offline` to skip API calls, or set `HF_TOKEN` for higher rate limits:

```bash
export HF_TOKEN=hf_your_token_here
ml-container-creator
```

## LoRA Adapter Issues

### "Not Found" error on first adapter invocation

**Symptoms:** After `do/adapter add`, the first `do/test` returns `{"detail":"Not Found"}` but a second attempt succeeds.

**Root cause:** The adapter inference component reports `InService` before vLLM finishes loading LoRA weights into GPU memory. SageMaker AI's readiness check passes (base model `/ping` returns 200) but the adapter isn't actually ready to serve requests yet.

**Workaround:** Wait 30–60 seconds after `do/adapter add` reports success before testing. A future release will add a post-attach probe loop to confirm the adapter is serving.

```bash
# Wait, then test
./do/adapter add my-sft --from-tune
sleep 60
./do/test
```

### Read timeout on first adapter inference

**Symptoms:** First inference after adapter load returns a "Read timeout" error, but the response body contains valid JSON.

**Root cause:** The first inference triggers JIT compilation of the adapter code path. Combined with thinking-mode tokens (for reasoning models like DeepSeek R1), this can exceed the default CLI read timeout.

**Fix:** Increase the read timeout:

```bash
./do/test --cli-read-timeout 120
```

Subsequent calls will be fast — only the first invocation is slow.

### Wrong model name in adapter test

**Symptoms:** `do/test` sends the adapter name (e.g., `"val-sft"`) as the `model` field in the request, but vLLM returns "Not Found" because it only recognizes the base model name.

**Root cause:** When adapter config is detected, `do/test` uses `ADAPTER_MODEL_NAME` in the request's `"model"` field. However, SageMaker AI handles adapter routing at the inference component layer — vLLM doesn't need to know the adapter name. The correct value is the base `MODEL_NAME` (e.g., `"Qwen/Qwen3-0.6B"`).

**Workaround:** Invoke directly with the base model name:

```bash
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name <endpoint> \
  --inference-component-name <adapter-ic-name> \
  --body '{"model": "Qwen/Qwen3-0.6B", "messages": [{"role": "user", "content": "Hello"}]}' \
  --content-type application/json \
  output.json
```

This will be fixed in a future release so `do/test` automatically uses the base model name when testing adapters.

### Adapter IC stuck in "Creating" state

**Symptoms:** `do/adapter add` hangs waiting for the inference component to reach `InService`.

**Common causes:**

1. **Insufficient GPU memory** — The base model + adapter don't fit in the instance's GPU memory. Try a smaller adapter rank or a larger instance.
2. **Invalid S3 path** — The adapter weights URI doesn't exist or isn't accessible by the SageMaker AI execution role.
3. **Incompatible adapter** — The adapter was trained with a different base model or rank than configured.

**Debug:**

```bash
# Check IC status and failure reason
aws sagemaker describe-inference-component \
  --inference-component-name <adapter-ic-name> \
  --query '[InferenceComponentStatus, FailureReason]'

# Check endpoint logs for vLLM errors
./do/logs
```

## Getting Help

```bash
# Container logs
docker logs <container-id>

# SageMaker AI endpoint logs
aws logs tail /aws/sagemaker/Endpoints/<endpoint-name> --follow

# Generator debug output
DEBUG=* ml-container-creator
```

- [GitHub Issues](https://github.com/awslabs/ml-container-creator/issues) -- report bugs
- [GitHub Discussions](https://github.com/awslabs/ml-container-creator/discussions) -- ask questions
- [SageMaker AI Documentation](https://docs.aws.amazon.com/sagemaker/) -- AWS reference


### vLLM container logs go dark after "engine args" on multi-GPU

**Symptoms:** Container starts, logs show `CUDA compat: driver X < Y, adding compat libs` and `vLLM engine args: [...]`, then no further output. IC reports "InService" but inference returns `InternalFailure`. Benchmark jobs fail with 400 Bad Request.

**Root cause:** The vLLM image was compiled against a newer CUDA toolkit than the instance's GPU driver supports. The CUDA forward compatibility layer loads partially but **fails silently during NCCL initialization** for multi-GPU tensor-parallel deployments. No Python exception is raised — the process hangs or is killed by the container runtime.

**Example:** `vllm/vllm-openai:v0.23.0` (CUDA 12.9, requires driver ≥580) on `ml.g5.24xlarge` (driver ~550).

**Fix:**

1. Downgrade to a compatible vLLM version:
   ```bash
   # Check driver compatibility table in MCP Servers docs
   # For g5 (driver ~550): use vLLM ≤v0.21.x
   sed -i '' 's/vllm-openai:v0.23.0/vllm-openai:v0.20.2/' Dockerfile
   ./do/build && ./do/push
   ```

2. Or use base-image-picker with `instanceType` context — it automatically excludes incompatible versions:
   ```bash
   ml-container-creator mcp add base-image-picker --bundled
   # During generation, base-image-picker filters by driver compatibility
   ```

**Key diagnostic:** The `CUDA compat` log line confirms the mismatch. If you see this followed by silence (no "Loading model..." or error), it's always the driver compatibility issue.

### Adapter IC "InService" but inference returns "Failed to download model data"

**Symptoms:** `do/test --adapter <name>` returns `ValidationError: Failed to download model data (bucket: ..., key: .../adapter-name)`. The IC shows `InService` in `describe-inference-component`.

**Root cause:** The adapter's `ArtifactUrl` is missing the trailing slash. SageMaker Inference Components expect S3 directory prefixes to end with `/` — without it, SageMaker looks for a single object at that exact key (which doesn't exist).

**Fix:**

1. Delete the IC and re-create with the corrected URL:
   ```bash
   aws sagemaker delete-inference-component \
     --inference-component-name <ic-name> --region <region>
   sleep 45
   
   # Fix the conf file
   sed -i '' 's|adapters/my-adapter"|adapters/my-adapter/"|' do/adapters/<name>.conf
   
   # Re-add
   ./do/adapter add <name> --weights "s3://bucket/prefix/"
   ```

2. For adapters from `--from-registry`: the template fix (2026-06-29) automatically re-adds the trailing slash for non-tar.gz adapter URIs. Regenerate the project or update the `do/adapter` script.
