# Template System Documentation

This directory contains EJS templates that are processed and copied to generate complete ML container projects.

## How Templates Work

### Template Processing
All files in this directory are processed using [EJS (Embedded JavaScript)](https://ejs.co/) templating:

```ejs
<%= variable %>     <%# Outputs escaped value %>
<%- variable %>     <%# Outputs unescaped value %>
<% if (condition) { %>
    Conditional content
<% } %>
```

### Available Variables

All user answers from the prompting phase are available in templates:

| Variable | Type | Description | Example Values |
|----------|------|-------------|----------------|
| `projectName` | string | Project name | `my-ml-model` |
| `destinationDir` | string | Output directory | `./my-ml-model-2024-12-02` |
| `framework` | string | ML framework | `sklearn`, `xgboost`, `tensorflow`, `transformers` |
| `modelFormat` | string | Model serialization format | `pkl`, `joblib`, `json`, `keras`, `h5` |
| `modelServer` | string | Model serving framework | `flask`, `fastapi`, `vllm`, `sglang` |
| `includeSampleModel` | boolean | Include sample model | `true`, `false` |
| `includeTesting` | boolean | Include test suite | `true`, `false` |
| `testTypes` | string[] | Selected test types | `['local-model-cli', 'hosted-model-endpoint']` |
| `deployTarget` | string | Deployment target | `sagemaker` |
| `instanceType` | string | Instance configuration | `cpu-optimized`, `gpu-enabled` |
| `awsRegion` | string | AWS region | `us-east-1` |
| `buildTimestamp` | string | Generation timestamp | `2024-12-02T15-30-45` |

## Directory Structure

```
templates/
├── code/                    # Model serving code
│   ├── flask/              # Flask-specific implementation
│   ├── model_handler.py    # Model loading and inference (traditional ML)
│   ├── serve.py            # Flask/FastAPI server (traditional ML)
│   ├── serve               # vLLM/SGLang entrypoint (transformers)
│   └── start_server.py     # Server startup script (traditional ML)
├── deploy/                 # Deployment scripts
│   ├── build_and_push.sh   # Build Docker image and push to ECR
│   ├── deploy.sh           # Deploy to SageMaker endpoint
│   └── upload_to_s3.sh     # Upload model to S3 (transformers only)
├── sample_model/           # Optional sample training code
│   ├── train_abalone.py    # Sample model training
│   └── test_inference.py   # Sample inference testing
├── test/                   # Optional test suite
│   ├── test_endpoint.sh    # Test hosted SageMaker endpoint
│   ├── test_local_image.sh # Test local Docker container
│   └── test_model_handler.py # Unit tests for model handler
├── Dockerfile              # Container definition
├── nginx.conf              # Nginx configuration (traditional ML only)
└── requirements.txt        # Python dependencies
```

## Conditional File Inclusion

Files are conditionally included based on user configuration:

### Transformers Configuration
When `framework === 'transformers'`:
- **Excluded**: Traditional ML serving files
  - `code/model_handler.py`
  - `code/serve.py`
  - `code/start_server.py`
  - `nginx.conf`
  - `requirements.txt` (uses transformer-specific version)
  - `test/test_local_image.sh`
  - `test/test_model_handler.py`
- **Included**: Transformer-specific files
  - `code/serve` (vLLM/SGLang entrypoint)
  - `deploy/upload_to_s3.sh`

### Traditional ML Configuration
When `framework !== 'transformers'`:
- **Excluded**: Transformer-specific files
  - `code/serve`
  - `deploy/upload_to_s3.sh`
- **Included**: Traditional ML serving files
  - All Flask/FastAPI serving code
  - Nginx configuration
  - Model handler

### Optional Modules
- **Sample Model**: Excluded if `includeSampleModel === false`
- **Test Suite**: Excluded if `includeTesting === false`
- **Flask Code**: Excluded if `modelServer !== 'flask'`

## Template Examples

### Using Variables in Shell Scripts
```bash
#!/bin/bash
# deploy/build_and_push.sh

PROJECT_NAME="<%= projectName %>"
REGION="<%= awsRegion %>"

echo "Building ${PROJECT_NAME} for region ${REGION}"
```

### Conditional Content in Python
```python
# code/model_handler.py

<% if (framework === 'sklearn') { %>
import joblib
model = joblib.load(model_path)
<% } else if (framework === 'xgboost') { %>
import xgboost as xgb
model = xgb.Booster()
model.load_model(model_path)
<% } %>
```

### Using Arrays
```python
# test/test_endpoint.sh

<% if (testTypes.includes('hosted-model-endpoint')) { %>
echo "Testing hosted endpoint..."
aws sagemaker-runtime invoke-endpoint \
  --endpoint-name <%= projectName %>-endpoint \
  --body file://test_data.json \
  output.json
<% } %>
```

## Adding New Templates

### 1. Create Template File
Add your template file in the appropriate directory:
```bash
templates/code/my_new_file.py
```

### 2. Use EJS Syntax
```python
# templates/code/my_new_file.py
"""
Generated for <%= projectName %>
Framework: <%= framework %>
"""

<% if (framework === 'sklearn') { %>
# sklearn-specific code
<% } %>
```

### 3. Add Conditional Exclusion (if needed)
In `generators/app/index.js`, add to `ignorePatterns`:
```javascript
if (someCondition) {
    ignorePatterns.push('**/code/my_new_file.py');
}
```

### 4. Update This Documentation
Document the new template and when it's included/excluded.

## Best Practices

### Template Design
- **Keep templates simple** - Complex logic belongs in the generator
- **Use descriptive variable names** - Make templates self-documenting
- **Add comments** - Explain why conditional logic exists
- **Test all paths** - Verify templates work for all configurations

### Variable Usage
- **Escape output by default** - Use `<%= %>` unless you need HTML
- **Validate in generator** - Don't assume variables exist in templates
- **Provide defaults** - Use `<%= variable || 'default' %>`

### File Organization
- **Group related files** - Keep similar templates together
- **Use subdirectories** - Organize by feature or component
- **Name clearly** - File names should indicate purpose

## Testing Templates

### Manual Testing
```bash
# Link generator locally
npm link

# Run generator
yo ml-container-creator

# Test different configurations
# - sklearn + flask
# - xgboost + fastapi
# - transformers + vllm
# - With/without sample model
# - With/without tests
```

### Automated Testing
See `test/` directory for generator tests that verify template generation.

## Troubleshooting

### Template Not Copied
- Check if file matches an ignore pattern
- Verify file is in templates directory
- Check for EJS syntax errors

### Variables Not Replaced
- Ensure variable exists in `this.answers`
- Check EJS syntax: `<%= variable %>` not `{{ variable }}`
- Verify template is processed with `copyTpl` not `copy`

### Conditional Logic Not Working
- Test condition in generator first
- Use `console.log()` to debug values
- Check for typos in variable names

## Related Documentation

- [Yeoman Generator API](https://yeoman.io/authoring/)
- [EJS Documentation](https://ejs.co/)
- [Project Steering Files](../../../.kiro/steering/)
