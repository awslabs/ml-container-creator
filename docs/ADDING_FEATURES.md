# Adding New Features

Guide for contributors who want to add new frameworks, model servers, or other features to ML Container Creator.

## Table of Contents

- [Adding a New ML Framework](#adding-a-new-ml-framework)
- [Adding a New Model Server](#adding-a-new-model-server)
- [Adding a New Test Type](#adding-a-new-test-type)
- [Adding a New Deployment Target](#adding-a-new-deployment-target)
- [Testing Your Changes](#testing-your-changes)

---

## Adding a New ML Framework

Let's walk through adding support for PyTorch models.

### Step 1: Update SUPPORTED_OPTIONS

Edit `generators/app/index.js`:

```javascript
SUPPORTED_OPTIONS = {
    frameworks: ['sklearn', 'xgboost', 'tensorflow', 'transformers', 'pytorch'],
    // ...
}
```

### Step 2: Add Framework to Prompts

```javascript
{
    type: 'list',
    name: 'framework',
    message: 'Which ML framework are you using?',
    choices: ['sklearn', 'xgboost', 'tensorflow', 'transformers', 'pytorch']
}
```

### Step 3: Add Model Format Choices

```javascript
{
    type: 'list',
    name: 'modelFormat',
    message: 'In which format is your model serialized?',
    choices: (answers) => {
        // ... existing choices ...
        if (answers.framework === 'pytorch') {
            return ['pt', 'pth', 'torchscript'];
        }
    },
    when: answers => answers.framework !== 'transformers'
}
```

### Step 4: Create Template Variations

Create PyTorch-specific model handler:

```python
# templates/code/model_handler.py

<% if (framework === 'pytorch') { %>
import torch

class ModelHandler:
    def __init__(self, model_path):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        <% if (modelFormat === 'torchscript') { %>
        self.model = torch.jit.load(model_path, map_location=self.device)
        <% } else { %>
        self.model = torch.load(model_path, map_location=self.device)
        <% } %>
        self.model.eval()
    
    def predict(self, data):
        with torch.no_grad():
            inputs = torch.tensor(data, device=self.device)
            outputs = self.model(inputs)
            return outputs.cpu().numpy().tolist()
<% } %>
```

### Step 5: Update Requirements Template

```python
# templates/requirements.txt

<% if (framework === 'pytorch') { %>
torch==2.0.0
torchvision==0.15.0
<% } %>
```

### Step 6: Update Dockerfile (if needed)

```dockerfile
# templates/Dockerfile

<% if (framework === 'pytorch' && instanceType === 'gpu-enabled') { %>
FROM pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime
<% } else if (framework === 'pytorch') { %>
FROM pytorch/pytorch:2.0.0-cpu
<% } %>
```

### Step 7: Add Tests

Create test file `test/pytorch-generator.js`:

```javascript
const helpers = require('yeoman-test');
const assert = require('yeoman-assert');
const path = require('path');

describe('generator-ml-container-creator:pytorch', () => {
    it('creates pytorch project with pt format', async () => {
        await helpers.run(path.join(__dirname, '../generators/app'))
            .withPrompts({
                projectName: 'pytorch-test',
                framework: 'pytorch',
                modelFormat: 'pt',
                modelServer: 'flask'
            });
        
        assert.file([
            'Dockerfile',
            'code/model_handler.py',
            'requirements.txt'
        ]);
        
        assert.fileContent('requirements.txt', 'torch==');
        assert.fileContent('code/model_handler.py', 'import torch');
    });
});
```

### Step 8: Update Documentation

Add to `docs/EXAMPLES.md`:

```markdown
## Example: Deploy a PyTorch Model

### Step 1: Save Your Model

\`\`\`python
import torch

# Save model
torch.save(model.state_dict(), 'model.pt')

# Or save as TorchScript
scripted_model = torch.jit.script(model)
scripted_model.save('model.torchscript')
\`\`\`

### Step 2: Generate Project

\`\`\`bash
yo ml-container-creator
# Select pytorch, pt format, flask server
\`\`\`
```

### Step 9: Update Documentation

Add to `docs/architecture.md`:

```markdown
### Frameworks
- `pytorch` - PyTorch models (pt, pth, torchscript formats)
```

---

## Adding a New Model Server

Let's add support for TorchServe.

### Step 1: Update SUPPORTED_OPTIONS

```javascript
SUPPORTED_OPTIONS = {
    modelServer: ['flask', 'fast-api', 'vllm', 'sglang', 'torchserve'],
    // ...
}
```

### Step 2: Add to Model Server Prompt

```javascript
{
    type: 'list',
    name: 'modelServer',
    message: 'Which model server are you serving with?',
    choices: (answers) => {
        if (answers.framework === 'pytorch') {
            return ['flask', 'fastapi', 'torchserve'];
        }
        // ... existing logic ...
    }
}
```

### Step 3: Create TorchServe Templates

Create `templates/code/torchserve/`:

```python
# templates/code/torchserve/handler.py
from ts.torch_handler.base_handler import BaseHandler

class ModelHandler(BaseHandler):
    def initialize(self, context):
        self.manifest = context.manifest
        properties = context.system_properties
        model_dir = properties.get("model_dir")
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # Load model
        self.model = torch.jit.load(f"{model_dir}/model.pt")
        self.model.to(self.device)
        self.model.eval()
    
    def preprocess(self, data):
        # Preprocessing logic
        return processed_data
    
    def inference(self, data):
        with torch.no_grad():
            return self.model(data)
    
    def postprocess(self, data):
        # Postprocessing logic
        return predictions
```

### Step 4: Update Dockerfile

```dockerfile
# templates/Dockerfile

<% if (modelServer === 'torchserve') { %>
FROM pytorch/torchserve:latest

# Copy model and handler
COPY code/torchserve/handler.py /home/model-server/
COPY code/model.pt /home/model-server/

# Create model archive
RUN torch-model-archiver \
    --model-name <%= projectName %> \
    --version 1.0 \
    --serialized-file /home/model-server/model.pt \
    --handler /home/model-server/handler.py \
    --export-path /home/model-server/model-store

# Start TorchServe
CMD ["torchserve", \
     "--start", \
     "--model-store", "/home/model-server/model-store", \
     "--models", "<%= projectName %>=<%= projectName %>.mar"]
<% } %>
```

### Step 5: Update Ignore Patterns

```javascript
// In writing() method
if (this.answers.modelServer === 'torchserve') {
    ignorePatterns.push('**/code/flask/**');
    ignorePatterns.push('**/code/serve.py');
    ignorePatterns.push('**/nginx.conf');
} else if (this.answers.modelServer !== 'flask') {
    ignorePatterns.push('**/code/flask/**');
}
```

---

## Adding a New Test Type

Let's add integration tests.

### Step 1: Update SUPPORTED_OPTIONS

```javascript
SUPPORTED_OPTIONS = {
    testTypes: [
        'local-model-cli',
        'local-model-server',
        'hosted-model-endpoint',
        'integration-tests'
    ],
    // ...
}
```

### Step 2: Add to Test Type Prompt

```javascript
{
    type: 'checkbox',
    name: 'testTypes',
    message: 'Test type?',
    choices: (answers) => {
        const baseTests = [
            'local-model-cli',
            'local-model-server',
            'hosted-model-endpoint',
            'integration-tests'
        ];
        // Filter based on framework
        return baseTests;
    }
}
```

### Step 3: Create Test Template

```bash
# templates/test/test_integration.sh

#!/bin/bash
set -e

echo "Running integration tests for <%= projectName %>"

# Test 1: Build container
echo "Test 1: Building container..."
docker build -t <%= projectName %>-test .

# Test 2: Start container
echo "Test 2: Starting container..."
CONTAINER_ID=$(docker run -d -p 8080:8080 <%= projectName %>-test)
sleep 10

# Test 3: Health check
echo "Test 3: Testing health endpoint..."
curl -f http://localhost:8080/ping || exit 1

# Test 4: Inference
echo "Test 4: Testing inference..."
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}' || exit 1

# Test 5: Load test
echo "Test 5: Running load test..."
for i in {1..100}; do
  curl -X POST http://localhost:8080/invocations \
    -H "Content-Type: application/json" \
    -d '{"instances": [[1.0, 2.0, 3.0]]}' &
done
wait

# Cleanup
echo "Cleaning up..."
docker stop $CONTAINER_ID
docker rm $CONTAINER_ID

echo "All integration tests passed!"
```

### Step 4: Update Conditional Logic

```javascript
// In writing() method
if (!this.answers.testTypes.includes('integration-tests')) {
    ignorePatterns.push('**/test/test_integration.sh');
}
```

---

## Adding a New Deployment Target

Let's add support for AWS Lambda.

### Step 1: Update SUPPORTED_OPTIONS

```javascript
SUPPORTED_OPTIONS = {
    deployment: ['sagemaker', 'lambda'],
    // ...
}
```

### Step 2: Add to Deployment Prompt

```javascript
{
    type: 'list',
    name: 'deployTarget',
    message: 'Deployment target?',
    choices: ['sagemaker', 'lambda'],
    default: 'sagemaker'
}
```

### Step 3: Create Lambda-Specific Templates

```python
# templates/code/lambda_handler.py

import json
import base64
from model_handler import ModelHandler

# Initialize model once (outside handler)
model_handler = ModelHandler('/opt/ml/model')

def lambda_handler(event, context):
    """AWS Lambda handler function."""
    try:
        # Parse input
        body = json.loads(event['body'])
        instances = body.get('instances', [])
        
        # Run inference
        predictions = model_handler.predict(instances)
        
        # Return response
        return {
            'statusCode': 200,
            'body': json.dumps({
                'predictions': predictions
            })
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }
```

### Step 4: Create Lambda Deployment Script

```bash
# templates/deploy/deploy_lambda.sh

#!/bin/bash
set -e

PROJECT_NAME="<%= projectName %>"
REGION="<%= awsRegion %>"
ROLE_ARN=$1

if [ -z "$ROLE_ARN" ]; then
    echo "Usage: ./deploy_lambda.sh <lambda-execution-role-arn>"
    exit 1
fi

echo "Deploying ${PROJECT_NAME} to AWS Lambda..."

# Create deployment package
echo "Creating deployment package..."
cd code
zip -r ../deployment.zip . -x "*.pyc" "__pycache__/*"
cd ..

# Create Lambda function
echo "Creating Lambda function..."
aws lambda create-function \
    --function-name ${PROJECT_NAME} \
    --runtime python3.9 \
    --role ${ROLE_ARN} \
    --handler lambda_handler.lambda_handler \
    --zip-file fileb://deployment.zip \
    --timeout 30 \
    --memory-size 512 \
    --region ${REGION}

echo "Lambda function deployed successfully!"
echo "Test with: aws lambda invoke --function-name ${PROJECT_NAME} --payload '{...}' output.json"
```

### Step 5: Update Conditional Logic

```javascript
// In writing() method
if (this.answers.deployTarget === 'lambda') {
    ignorePatterns.push('**/deploy/build_and_push.sh');
    ignorePatterns.push('**/deploy/deploy.sh');
    ignorePatterns.push('**/nginx.conf');
} else {
    ignorePatterns.push('**/deploy/deploy_lambda.sh');
    ignorePatterns.push('**/code/lambda_handler.py');
}
```

---

## Testing Your Changes

### Unit Tests

```bash
# Run all tests
npm test

# Run specific test
npm test -- test/pytorch-generator.js

# Run with coverage
npm test -- --coverage
```

### Manual Testing

```bash
# Link generator
npm link

# Test generation
yo ml-container-creator

# Test all combinations
# - New framework + flask
# - New framework + fastapi
# - With/without sample model
# - With/without tests
```

### Integration Testing

```bash
# Generate project
yo ml-container-creator

# Build container
cd generated-project
docker build -t test-model .

# Test locally
docker run -p 8080:8080 test-model

# Test inference
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"instances": [[1.0, 2.0, 3.0]]}'
```

### Validation Checklist

- [ ] Code follows existing style (run `npm run lint`)
- [ ] All tests pass (`npm test`)
- [ ] New tests added for new features
- [ ] Documentation updated
  - [ ] README.md
  - [ ] docs/EXAMPLES.md
  - [ ] docs/TROUBLESHOOTING.md
  - [ ] docs/architecture.md
- [ ] Templates use proper EJS syntax
- [ ] Conditional logic works correctly
- [ ] Generated projects build successfully
- [ ] Generated projects deploy successfully
- [ ] No breaking changes to existing features

---

## Submitting Your Changes

### 1. Create Feature Branch

```bash
git checkout -b feature/add-pytorch-support
```

### 2. Make Changes

Follow the steps above for your feature.

### 3. Test Thoroughly

```bash
npm test
npm run lint
```

### 4. Commit Changes

```bash
git add .
git commit -m "feat: add PyTorch framework support

- Add pytorch to supported frameworks
- Add pt, pth, torchscript model formats
- Create PyTorch-specific model handler
- Add tests for PyTorch generation
- Update documentation"
```

### 5. Push and Create PR

```bash
git push origin feature/add-pytorch-support
```

Then create a Pull Request on GitHub with:
- Clear description of changes
- Screenshots/examples if applicable
- Link to related issues
- Test results

---

## Best Practices

### Code Organization

- Keep generator logic in `generators/app/index.js`
- Keep templates in `generators/app/templates/`
- Keep tests in `test/`
- Keep documentation in `docs/`

### Template Design

- Use EJS for all dynamic content
- Keep templates simple and readable
- Add comments explaining conditional logic
- Test all template paths

### Documentation

- Update all relevant documentation
- Add examples for new features
- Include troubleshooting tips
- Update steering files for AI context

### Testing

- Write unit tests for generator logic
- Test all configuration combinations
- Test generated projects end-to-end
- Include edge cases

### Backward Compatibility

- Don't break existing features
- Provide migration guide if needed
- Deprecate features gracefully
- Version breaking changes appropriately

---

## Getting Help

- Review existing code for patterns
- Check [Project Architecture](architecture.md)
- Ask in [GitHub Discussions](https://github.com/awslabs/ml-container-creator/discussions)
- Open a draft PR for early feedback

## Resources

- [Yeoman Generator Documentation](https://yeoman.io/authoring/)
- [EJS Documentation](https://ejs.co/)
- [Mocha Testing Framework](https://mochajs.org/)
- [SageMaker BYOC Guide](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms.html)
