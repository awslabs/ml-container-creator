# Troubleshooting Guide

Common issues and solutions when using ML Container Creator.

## Quick Reference

| Issue | Quick Fix |
|-------|-----------|
| `yo: command not found` | `npm install -g yo` |
| `generator not found` | `npm link` in project directory |
| `SyntaxError: Unexpected token` | Update Node.js to latest: `nvm install node` |
| Container won't start | Check logs: `docker logs <container-id>` |
| Health check fails | Verify `/ping` endpoint returns 200 |
| Model not found | Check model file path in `/opt/ml/model/` |
| Permission denied | Fix file permissions: `chmod 644 code/*` |
| ECR push fails | Login: `aws ecr get-login-password` |

## Installation Issues

### Generator Not Found

**Problem:**
```bash
$ yo @aws/ml-container-creator
Error: ml-container-creator generator not found
```

**Solution:**
```bash
# Install Yeoman if not installed
npm install -g yo

# Link the generator
cd ml-container-creator
npm link

# Verify installation
yo --generators
```

### Node.js Version Issues

**Problem:**
```bash
SyntaxError: Unexpected token 'export'
# OR
Error: The engine "node" is incompatible with this module
```

**Solution:**
```bash
# Check your Node.js version
node --version

# Update to Node.js 24+ (required)
nvm install 24
nvm use 24

# Or install latest
nvm install node
nvm use node
```

## Docker Issues

### Container Build Fails

**Problem:**
```bash
ERROR: Could not find a version that satisfies the requirement scikit-learn
```

**Solution:**
```bash
# Option 1: Specify exact versions in requirements.txt
scikit-learn==1.3.0
numpy==1.24.0

# Option 2: Clear Docker cache and rebuild
docker build --no-cache -t my-model .

# Option 3: Use different base image
# Edit Dockerfile to use python:3.9-slim
```

### Container Won't Start

**Problem:**
```bash
$ docker run -p 8080:8080 my-model
Container exits immediately
```

**Solution:**
```bash
# Check what went wrong
docker logs <container-id>

# Run interactively to debug
docker run -it my-model /bin/bash

# Common issues:
# 1. Model file missing
ls -la /opt/ml/model/

# 2. Python import errors
python -c "import sklearn; import flask"

# 3. Port already in use
lsof -i :8080  # Find what's using port 8080
```

### Health Check Fails

**Problem:**
```bash
$ curl http://localhost:8080/ping
curl: (7) Failed to connect
```

**Solution:**
```bash
# 1. Verify container is running
docker ps

# 2. Check if server started
docker logs <container-id>

# 3. Test inside container
docker exec <container-id> curl http://localhost:8080/ping

# 4. Check firewall (macOS)
# System Preferences > Security & Privacy > Firewall
```

### Inference Fails

**Problem:**
```bash
$ curl -X POST http://localhost:8080/invocations -d '{"instances": [[1,2,3]]}'
{"error": "Model prediction failed"}
```

**Solution:**
```bash
# 1. Check container logs for detailed error
docker logs <container-id>

# 2. Verify input format
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'

# 3. Test model directly
docker exec -it <container-id> python
>>> from code.model_handler import ModelHandler
>>> handler = ModelHandler('/opt/ml/model')
>>> handler.predict([[1.0, 2.0, 3.0]])
```

## AWS Deployment Issues

### ECR Authentication

**Problem:**
```bash
Error: no basic auth credentials
```

**Solution:**
```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Verify AWS credentials work
aws sts get-caller-identity

# Check AWS CLI configuration
aws configure list
```

### ECR Repository Missing

**Problem:**
```bash
Error: Repository does not exist
```

**Solution:**
```bash
# Create ECR repository
aws ecr create-repository --repository-name my-model-name

# Or let the build script create it automatically
./do/build && ./do/push
```

### IAM Permissions

**Problem:**
```bash
Error: User is not authorized to perform: ecr:CreateRepository
```

**Solution:**
You need these AWS permissions:
- `ecr:CreateRepository`
- `ecr:PutImage` 
- `ecr:InitiateLayerUpload`
- `ecr:UploadLayerPart`
- `ecr:CompleteLayerUpload`
- `sagemaker:CreateEndpointConfig`
- `sagemaker:CreateEndpoint`
- `sagemaker:CreateInferenceComponent`
- `iam:PassRole`

Contact your AWS administrator to add these permissions to your user or role.

## SageMaker Issues

### Endpoint Creation Fails

**Problem:**
```bash
$ aws sagemaker describe-endpoint --endpoint-name my-model
Status: Failed
```

**Solution:**
```bash
# Use do/logs to tail the correct log group automatically
./do/logs

# Or check CloudWatch logs manually (inference component logs)
aws logs tail /aws/sagemaker/InferenceComponents/my-model-ic --follow

# Common causes:
# 1. Container fails to start - check Dockerfile
# 2. Health check timeout - ensure /ping responds quickly
# 3. Model loading fails - verify model file exists
# 4. Wrong IAM role - check SageMaker execution role
```

### Endpoint Stuck Creating

**Problem:**
Endpoint stays in "Creating" status for 15+ minutes

**Solution:**
```bash
# Check logs for errors
./do/logs

# If truly stuck, clean up and recreate
./do/clean endpoint

# Then redeploy
export ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/YOUR_ROLE
./do/deploy
```

### Inference Errors

**Problem:**
```bash
$ aws sagemaker-runtime invoke-endpoint --endpoint-name my-model ...
ModelError: An error occurred (ModelError)
```

**Solution:**
```bash
# 1. Check CloudWatch logs
aws logs tail /aws/sagemaker/Endpoints/my-model --follow

# 2. Test locally first
docker run -p 8080:8080 my-model
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'

# 3. Verify input format matches what model expects
# sklearn: {"instances": [[feature1, feature2, ...]]}
# transformers: {"inputs": "text to process"}
```

## Model Issues

### Model File Not Found

**Problem:**
```python
FileNotFoundError: No such file or directory: '/opt/ml/model/model.pkl'
```

**Solution:**
```bash
# 1. Verify model file exists in your code/ directory
ls -la code/

# 2. Check Dockerfile copies model correctly
grep "COPY.*model" Dockerfile

# 3. For transformers, verify S3 upload
aws s3 ls s3://your-bucket/models/

# 4. Check model path in model_handler.py
```

### Model Format Issues

**Problem:**
```python
ValueError: Model format not recognized
```

**Solution:**
Make sure your model format matches what you selected:
- **sklearn**: `.pkl` or `.joblib` files
- **xgboost**: `.json`, `.model`, or `.ubj` files  
- **tensorflow**: SavedModel directory or `.h5` files
- **transformers**: Hugging Face model files

```python
# Re-save in correct format if needed
import joblib
joblib.dump(model, 'model.pkl')  # For sklearn

# Or update model_handler.py to match your format
```

### Dependency Issues

**Problem:**
```python
ModuleNotFoundError: No module named 'xgboost'
```

**Solution:**
```bash
# Add missing dependency to requirements.txt
echo "xgboost==1.7.0" >> requirements.txt

# Rebuild container
docker build -t my-model .

# Verify dependencies installed
docker run my-model pip list | grep xgboost
```

## HuggingFace Authentication Issues

### Token Not Working

**Problem:**
Container fails to download model with authentication error:
```bash
Error: Repository not found or access denied
```

**Solutions:**

1. **Verify token is valid**:
   ```bash
   # Test token with HuggingFace CLI
   pip install huggingface-hub
   huggingface-cli login
   # Enter your token when prompted
   
   # Try downloading the model
   huggingface-cli download meta-llama/Llama-2-7b-hf
   ```

2. **Check token permissions**:
   - Go to https://huggingface.co/settings/tokens
   - Verify token has "Read" access
   - Ensure token is not expired

3. **Accept model license**:
   - Visit the model page on HuggingFace (e.g., https://huggingface.co/meta-llama/Llama-2-7b-hf)
   - Click "Agree and access repository"
   - Accept the license terms

4. **Rebuild image**:
   Token changes require rebuilding the Docker image:
   ```bash
   docker build -t my-model .
   ```

### Environment Variable Not Resolved

**Problem:**
Warning during generation:
```bash
⚠️  Warning: $HF_TOKEN specified but HF_TOKEN environment variable is not set
```

**Solutions:**

1. **Set the environment variable**:
   ```bash
   export HF_TOKEN=hf_your_token_here
   
   # Verify it's set
   echo $HF_TOKEN
   ```

2. **Check variable name** (case-sensitive):
   ```bash
   # Must be exactly HF_TOKEN, not hf_token or Hf_Token
   export HF_TOKEN=hf_abc123...
   ```

3. **Verify in current shell**:
   ```bash
   # Check all environment variables
   env | grep HF_TOKEN
   
   # If not found, set it again
   export HF_TOKEN=hf_your_token_here
   ```

4. **Make it persistent** (optional):
   ```bash
   # Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
   echo 'export HF_TOKEN=hf_your_token_here' >> ~/.bashrc
   source ~/.bashrc
   ```

### Token Format Warning

**Problem:**
Warning during generation:
```bash
⚠️  Warning: HuggingFace tokens typically start with "hf_"
```

**Solutions:**

1. **Verify token format**:
   - HuggingFace tokens should start with `hf_`
   - Example: `hf_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890`

2. **Get a new token**:
   - Go to https://huggingface.co/settings/tokens
   - Click "New token"
   - Copy the token (it will start with `hf_`)

3. **If using a valid token**:
   - The warning is non-blocking
   - If your token works, you can ignore the warning
   - The generator will continue with your provided token

### Container Builds But Fails at Runtime

**Problem:**
Container builds successfully but fails when trying to load the model:
```bash
Error: Failed to download model from HuggingFace Hub
```

**Solutions:**

1. **Token not provided**:
   The model requires authentication but no token was provided during generation.
   
   Rebuild with token:
   ```bash
   yo @aws/ml-container-creator my-llm-project \
     --deployment-config=transformers-vllm \
     --model-name=meta-llama/Llama-2-7b-hf \
     --hf-token=hf_your_token_here \
     --skip-prompts
   ```

2. **Token expired**:
   Generate a new token and rebuild:
   ```bash
   # Get new token from https://huggingface.co/settings/tokens
   docker build -t my-model . --build-arg HF_TOKEN=hf_new_token
   ```

3. **Model requires agreement**:
   - Visit the model page on HuggingFace
   - Accept the license agreement
   - Wait a few minutes for access to be granted
   - Rebuild the container

### Token Visible in Docker Image

**Problem:**
Concerned about token security in Docker image

**Solutions:**

1. **Use environment variable reference** (recommended for CI/CD):
   ```bash
   # During generation, use $HF_TOKEN reference
   yo @aws/ml-container-creator --hf-token='$HF_TOKEN' --skip-prompts
   
   # Set environment variable before building
   export HF_TOKEN=hf_your_token_here
   ```

2. **Restrict image access**:
   ```bash
   # Use private ECR repository
   aws ecr create-repository --repository-name my-private-models
   
   # Set repository policy to restrict access
   aws ecr set-repository-policy \
     --repository-name my-private-models \
     --policy-text file://policy.json
   ```

3. **Rotate tokens regularly**:
   - Generate new tokens periodically
   - Revoke old tokens
   - Rebuild images with new tokens

4. **Use read-only tokens**:
   - Create tokens with minimal permissions
   - Only grant "Read" access
   - Limit scope to specific models/organizations

### Model Access Denied

**Problem:**
```bash
Error: You don't have permission to access this model
```

**Solutions:**

1. **Check organization membership**:
   - Some models require organization membership
   - Contact the model owner for access

2. **Verify token scope**:
   - Token may not have access to the specific model
   - Create a new token with appropriate permissions

3. **Check model visibility**:
   - Model may be private or restricted
   - Verify you have access on HuggingFace website

### Rate Limiting Issues

**Problem:**
```bash
Error: Rate limit exceeded
```

**Solutions:**

1. **Use authentication**:
   Authenticated requests have higher rate limits:
   ```bash
   yo @aws/ml-container-creator --hf-token=hf_your_token_here --skip-prompts
   ```

2. **Wait and retry**:
   - Rate limits reset after a period
   - Wait a few minutes and try again

3. **Use cached models**:
   - Download model once and cache it
   - Upload to S3 and reference in SageMaker

For more information on HuggingFace authentication, see the [README](./README.md#-huggingface-authentication).

## Performance Issues

### Slow Predictions

**Problem:**
Each prediction takes several seconds

**Solutions:**
1. **Load model once at startup** (not per request)
2. **Use batch predictions** when possible
3. **Choose appropriate instance type**:
   - CPU models: `ml.m5.xlarge` or larger
   - GPU models: `ml.g5.xlarge` or larger (transformers default to `ml.g6.12xlarge`)
4. **Optimize model size** (quantization, pruning)

### Out of Memory

**Problem:**
```bash
Container killed: Out of memory
```

**Solutions:**
1. **Use larger instance type**:
   - `ml.m5.xlarge` (16GB) → `ml.m5.2xlarge` (32GB)
   - `ml.g5.xlarge` (24GB GPU) → `ml.g5.2xlarge` (24GB GPU + more CPU RAM)
   - For transformers: `ml.g6.12xlarge` (96GB GPU) → `ml.g6.24xlarge` (192GB GPU)
2. **Reduce batch size** in your code
3. **Optimize model loading** (use model quantization)

### High Costs

**Problem:**
SageMaker endpoint costs are too high

**Solutions:**
1. **Right-size your instance** - don't over-provision
2. **Use auto-scaling** to scale down during low traffic
3. **Delete unused endpoints**:
   ```bash
   ./do/clean endpoint
   ```
4. **Consider serverless inference** for sporadic workloads

## Getting Help

### Enable Debug Logging

Add this to your `serve.py` for more detailed logs:
```python
import logging
logging.basicConfig(level=logging.DEBUG)

# Add detailed error handling
try:
    prediction = model.predict(data)
except Exception as e:
    logging.error(f"Prediction failed: {str(e)}", exc_info=True)
    raise
```

### Test Components Separately

```bash
# 1. Test model loading
docker run -it my-model python
>>> from code.model_handler import ModelHandler
>>> handler = ModelHandler('/opt/ml/model')

# 2. Test Flask/FastAPI server
docker run -it my-model python code/serve.py

# 3. Test inference endpoint
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'
```

### Check All Logs

```bash
# Use do/logs for automatic log tailing (detects deployment target)
./do/logs

# Or check manually:
# Local container logs
docker logs <container-id>

# SageMaker endpoint logs
aws logs tail /aws/sagemaker/Endpoints/my-model --follow

# Build logs
docker build -t my-model . 2>&1 | tee build.log
```

### Community Support

- **GitHub Issues**: [Report bugs or ask questions](https://github.com/awslabs/ml-container-creator/issues)
- **GitHub Discussions**: [Community Q&A](https://github.com/awslabs/ml-container-creator/discussions)
- **Documentation**: [Full documentation](https://awslabs.github.io/ml-container-creator/)
- **Examples**: [See working examples](https://awslabs.github.io/ml-container-creator/EXAMPLES/)

### AWS Resources

- **SageMaker Documentation**: https://docs.aws.amazon.com/sagemaker/
- **AWS Support**: https://console.aws.amazon.com/support/
- **SageMaker Developer Guide**: https://docs.aws.amazon.com/sagemaker/latest/dg/

---

## Prevention Checklist

Before you start:
- ✅ Node.js 24+ installed (`node --version`)
- ✅ Docker installed and running
- ✅ AWS CLI configured (`aws configure list`)
- ✅ Model file ready in correct format

Before deploying:
- ✅ Test container locally (`docker run -p 8080:8080 my-model`)
- ✅ Verify health check works (`curl http://localhost:8080/ping`)
- ✅ Test inference locally (`curl -X POST http://localhost:8080/invocations ...`)
- ✅ Check AWS permissions and IAM role

This should help you avoid the most common issues! If you're still stuck, please [open an issue](https://github.com/awslabs/ml-container-creator/issues) with:
- Your operating system
- Node.js version (`node --version`)
- Complete error message
- Steps to reproduce the issue