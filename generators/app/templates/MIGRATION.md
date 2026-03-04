# Migration Guide: Legacy Scripts to do-framework

This guide helps you transition from the legacy `deploy/` scripts to the new do-framework commands.

## Why Migrate?

The do-framework provides:

- **Standardization**: Consistent interface across all ML Container Creator projects
- **Better Organization**: Clear separation of concerns with dedicated scripts
- **Enhanced Features**: More granular control over build, push, deploy, test, and cleanup
- **Community Standard**: Follows the widely-adopted do-framework conventions
- **Improved Maintainability**: Centralized configuration in `do/config`

## Quick Reference

| Legacy Command | do-framework Command | Notes |
|----------------|---------------------|-------|
| `./deploy/build_and_push.sh` | `./do/build && ./do/push` | Now split into two commands |
| `./deploy/deploy.sh <role>` | `./do/deploy <role>` | Same functionality |
<% if (deployTarget === 'codebuild') { %>| `./deploy/submit_build.sh` | `./do/submit` | CodeBuild integration |
<% } %>| N/A | `./do/run` | New: Run container locally |
| N/A | `./do/test [endpoint]` | New: Test container or endpoint |
| N/A | `./do/clean <target>` | New: Clean up resources |

## Detailed Migration Steps

### Step 1: Understand the New Structure

The do-framework organizes scripts in the `do/` directory:

```
do/
├── config      # Centralized configuration
├── build       # Build Docker image
├── push        # Push to ECR
├── deploy      # Deploy to SageMaker
├── run         # Run locally
├── test        # Test container/endpoint
├── clean       # Clean up resources
<% if (deployTarget === 'codebuild') { %>├── submit      # Submit to CodeBuild
<% } %>└── README.md   # Detailed documentation
```

### Step 2: Update Your Workflow

#### Old Workflow

```bash
# Build and push
./deploy/build_and_push.sh

# Deploy
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerRole
```

#### New Workflow

```bash
# Build
./do/build

# Test locally (optional but recommended)
./do/run &
./do/test

# Push to ECR
./do/push

# Deploy to SageMaker
./do/deploy arn:aws:iam::123456789012:role/SageMakerRole

# Test the endpoint
./do/test <%= projectName %>-endpoint
```

<% if (deployTarget === 'codebuild') { %>#### CodeBuild Workflow

**Old**:
```bash
./deploy/submit_build.sh
./deploy/deploy.sh <role-arn>
```

**New**:
```bash
./do/submit  # Builds and pushes via CodeBuild
./do/deploy <role-arn>
./do/test <%= projectName %>-endpoint
```

<% } %>### Step 3: Update Configuration

#### Old: Hardcoded in Scripts

Legacy scripts had configuration hardcoded or passed as arguments.

#### New: Centralized in do/config

All configuration is now in `do/config`:

```bash
# Edit do/config
export PROJECT_NAME="<%= projectName %>"
export AWS_REGION="<%= awsRegion %>"
export INSTANCE_TYPE="<%= instanceType %>"
export DEPLOYMENT_CONFIG="<%= deploymentConfig %>"
```

You can override these with environment variables:

```bash
AWS_REGION=us-west-2 ./do/push
INSTANCE_TYPE=ml.m5.2xlarge ./do/deploy <role-arn>
```

### Step 4: Update CI/CD Pipelines

#### Old Pipeline

```yaml
# .github/workflows/deploy.yml
- name: Build and Push
  run: ./deploy/build_and_push.sh

- name: Deploy
  run: ./deploy/deploy.sh ${{ secrets.SAGEMAKER_ROLE }}
```

#### New Pipeline

```yaml
# .github/workflows/deploy.yml
- name: Build
  run: ./do/build

- name: Push
  run: ./do/push

- name: Deploy
  run: ./do/deploy ${{ secrets.SAGEMAKER_ROLE }}

- name: Test
  run: ./do/test <%= projectName %>-endpoint
```

### Step 5: Update Documentation

Update any project documentation that references the old scripts:

**Find and replace**:
- `./deploy/build_and_push.sh` → `./do/build && ./do/push`
- `./deploy/deploy.sh` → `./do/deploy`
<% if (deployTarget === 'codebuild') { %>- `./deploy/submit_build.sh` → `./do/submit`
<% } %>
## Command Mapping Details

### Build and Push

**Legacy**:
```bash
./deploy/build_and_push.sh
```

This single script built the Docker image and pushed it to ECR.

**do-framework**:
```bash
./do/build  # Build Docker image
./do/push   # Push to ECR
```

**Why the change?** Separating build and push allows you to:
- Test the image locally before pushing
- Build once and push to multiple registries
- Skip pushing if you only need local testing

**Benefits**:
- Test locally with `./do/run` before pushing
- More granular control over the workflow
- Clearer error messages for each step

### Deploy

**Legacy**:
```bash
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerRole
```

**do-framework**:
```bash
./do/deploy arn:aws:iam::123456789012:role/SageMakerRole
```

**What's the same?**
- Same command-line interface
- Same functionality
- Same SageMaker endpoint creation

**What's different?**
- Better error messages
- Progress indicators
- Automatic endpoint status polling
- Displays test command when complete

<% if (deployTarget === 'codebuild') { %>### CodeBuild Submit

**Legacy**:
```bash
./deploy/submit_build.sh
```

**do-framework**:
```bash
./do/submit
```

**What's improved?**
- Better build progress monitoring
- Clearer error messages
- Automatic ECR image URI display
- Build log streaming

<% } %>### New Commands

The do-framework adds several new commands that weren't available with legacy scripts:

#### Run Locally

```bash
./do/run
```

Starts the container locally on port 8080 for testing before deployment.

**Use cases**:
- Test model loading
- Verify inference logic
- Debug issues locally
- Validate container configuration

#### Test

```bash
# Test local container
./do/test

# Test SageMaker endpoint
./do/test <%= projectName %>-endpoint
```

Sends health check and inference requests to validate functionality.

**Use cases**:
- Verify endpoints are working
- Validate inference responses
- Automated testing in CI/CD
- Quick smoke tests

#### Clean

```bash
# Remove local images
./do/clean local

# Remove ECR images
./do/clean ecr

# Delete SageMaker endpoint
./do/clean endpoint

# Clean everything
./do/clean all
```

Manages cleanup of resources across different environments.

**Use cases**:
- Free up disk space
- Remove old ECR images
- Delete test endpoints
- Complete project cleanup

## Configuration Changes

### Legacy Configuration

Configuration was scattered across multiple scripts:

```bash
# In deploy/build_and_push.sh
PROJECT_NAME="my-model"
REGION="us-east-1"

# In deploy/deploy.sh
INSTANCE_TYPE="ml.m5.xlarge"
```

### do-framework Configuration

All configuration is centralized in `do/config`:

```bash
# do/config
export PROJECT_NAME="<%= projectName %>"
export DEPLOYMENT_CONFIG="<%= deploymentConfig %>"
export FRAMEWORK="<%= framework %>"
export MODEL_SERVER="<%= modelServer %>"
export AWS_REGION="<%= awsRegion %>"
export INSTANCE_TYPE="<%= instanceType %>"
export ECR_REPOSITORY_NAME="ml-container-creator"
<% if (deployTarget === 'codebuild') { %>export DEPLOY_TARGET="codebuild"
export CODEBUILD_COMPUTE_TYPE="<%= codebuildComputeType %>"
<% } %><% if (framework === 'transformers') { %>export MODEL_NAME="<%= modelName %>"
<% if (hfToken) { %>export HF_TOKEN="<%= hfToken %>"
<% } %><% } %>
```

**Benefits**:
- Single source of truth
- Easy to override with environment variables
- Clear documentation of all settings
- Consistent across all scripts

## Backward Compatibility

The legacy scripts are still available in the `deploy/` directory for backward compatibility:

```bash
./deploy/build_and_push.sh  # Still works
./deploy/deploy.sh          # Still works
<% if (deployTarget === 'codebuild') { %>./deploy/submit_build.sh     # Still works
<% } %>
```

**However**:
- They display deprecation warnings
- They forward to do-framework commands
- They will be removed in a future version

**Deprecation timeline**:
- Current version: Legacy scripts work with warnings
- Next major version: Legacy scripts may be removed
- Recommendation: Migrate now to avoid future issues

## Troubleshooting Migration

### Issue: "Command not found"

**Problem**: `./do/build: command not found`

**Solution**: Ensure scripts are executable:
```bash
chmod +x do/*
```

The generator should set this automatically, but if you copied files manually, you may need to set permissions.

### Issue: "Configuration variable not set"

**Problem**: `PROJECT_NAME not set in do/config`

**Solution**: Ensure `do/config` is properly sourced:
```bash
# Check if config exists
cat do/config

# Manually source to test
source do/config
echo $PROJECT_NAME
```

### Issue: "AWS credentials not configured"

**Problem**: `AWS credentials not configured`

**Solution**: Configure AWS CLI:
```bash
aws configure
# Or set environment variables
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
```

### Issue: "Docker permission denied"

**Problem**: `permission denied while trying to connect to the Docker daemon`

**Solution**: Add user to docker group:
```bash
sudo usermod -aG docker $USER
# Log out and back in for changes to take effect
```

### Issue: Legacy scripts not working

**Problem**: Legacy scripts fail after migration

**Solution**: 
1. Check that do-framework scripts work: `./do/build`
2. Verify do/config exists and is valid
3. Check script permissions: `ls -la do/`
4. Review deprecation warnings for guidance

## FAQ

### Q: Do I have to migrate immediately?

**A**: No, legacy scripts still work. However, we recommend migrating to benefit from new features and avoid future compatibility issues.

### Q: Can I use both legacy and do-framework commands?

**A**: Yes, but it's not recommended. Choose one approach for consistency.

### Q: Will my existing CI/CD pipelines break?

**A**: No, legacy scripts still work. But you should update pipelines to use do-framework commands for better features and future compatibility.

### Q: What if I have custom modifications to legacy scripts?

**A**: Review your modifications and apply them to the appropriate do-framework scripts. The modular structure makes customization easier.

### Q: Can I customize do-framework scripts?

**A**: Yes! The scripts are designed to be customizable. Edit them as needed for your use case.

### Q: Where can I find detailed documentation?

**A**: See `do/README.md` for comprehensive documentation of all do-framework commands.

### Q: What if I encounter issues during migration?

**A**: 
1. Check this migration guide
2. Review `do/README.md`
3. Check CloudWatch logs for deployment issues
4. Open an issue on the ML Container Creator repository

## Benefits Summary

### For Developers

- **Clearer workflow**: Separate commands for each step
- **Better testing**: Test locally before deploying
- **Easier debugging**: Granular control over each phase
- **Consistent interface**: Same commands across all projects

### For Teams

- **Standardization**: Everyone uses the same commands
- **Better documentation**: Clear, comprehensive guides
- **Easier onboarding**: New team members learn one system
- **Community alignment**: Follows do-framework conventions

### For CI/CD

- **More control**: Fine-grained pipeline steps
- **Better error handling**: Clear failure points
- **Easier testing**: Test at each stage
- **Improved monitoring**: Track each step separately

## Next Steps

1. **Read** `do/README.md` for detailed command documentation
2. **Test** the new commands in a development environment
3. **Update** your CI/CD pipelines
4. **Update** your team documentation
5. **Remove** references to legacy scripts from your workflows

## Additional Resources

- [do-framework Documentation](https://github.com/iankoulski/do-framework)
- [ML Container Creator Documentation](https://github.com/yourusername/ml-container-creator)
- [AWS SageMaker BYOC Guide](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html)

## Feedback

We'd love to hear about your migration experience! If you encounter issues or have suggestions, please:

1. Open an issue on the ML Container Creator repository
2. Share your feedback with the team
3. Contribute improvements to this guide

---

**Last Updated**: <%= buildTimestamp %>

**Generated by**: ML Container Creator v2.0 (do-framework integration)
