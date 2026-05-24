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
