# Troubleshooting Guide

Common issues and solutions when using ML Container Creator.

## Quick Reference

| Issue | Quick Fix |
|-------|-----------|
| `yo: command not found` | `npm install -g yo` |
| `generator not found` | `npm link` in project directory |
| `SyntaxError: Unexpected token` | Update Node.js: `nvm use node` |
| Container won't start | Check logs: `docker logs <container-id>` |
| Health check fails | Verify `/ping` endpoint returns 200 |
| Model not found | Check model file path in `/opt/ml/model/` |
| Permission denied | Fix file permissions: `chmod 644 code/*` |
| ECR push fails | Login: `aws ecr get-login-password` |

## Installation Issues

### Generator Not Found

**Problem:**
```bash
$ yo ml-container-creator
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

# Update to Node.js 18+ (recommended: latest LTS)
nvm install --lts
nvm use --lts

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
./deploy/build_and_push.sh
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
- `sagemaker:CreateModel`
- `sagemaker:CreateEndpointConfig` 
- `sagemaker:CreateEndpoint`
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
# Check CloudWatch logs for detailed error
aws logs tail /aws/sagemaker/Endpoints/my-model --follow

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
aws logs tail /aws/sagemaker/Endpoints/my-model --follow

# If truly stuck, delete and recreate
aws sagemaker delete-endpoint --endpoint-name my-model
aws sagemaker delete-endpoint-config --endpoint-config-name my-model
aws sagemaker delete-model --model-name my-model

# Then redeploy
./deploy/deploy.sh <your-sagemaker-role-arn>
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
   aws sagemaker delete-endpoint --endpoint-name unused-model
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
- ✅ Node.js 18+ installed (`node --version`)
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