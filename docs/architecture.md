# ML Container Creator - Project Context

## Project Overview

This is a Yeoman generator that creates Docker containers for deploying ML models to AWS SageMaker using the Bring Your Own Container (BYOC) paradigm.

## Architecture

### Generator Structure
- **Main generator**: `generators/app/index.js` - Contains all prompting and file generation logic
- **Templates**: `generators/app/templates/` - EJS templates that get copied and processed
- **Template variables**: Passed via `this.answers` object to all templates

### Key Concepts

1. **Yeoman Generator Pattern**: Extends `yeoman-generator` base class
2. **Phases**: Generator runs in phases (prompting → writing → install)
3. **Template Processing**: Uses EJS syntax (`<%= variable %>`) in template files
4. **Conditional Generation**: Files can be excluded via `ignorePatterns` array

## Supported Configurations

### Frameworks
- `sklearn` - scikit-learn models
- `xgboost` - XGBoost models  
- `tensorflow` - TensorFlow/Keras models
- `transformers` - Hugging Face transformer models (LLMs)

### Model Servers
- `flask` - Flask-based serving (traditional ML)
- `fastapi` - FastAPI-based serving (traditional ML)
- `vllm` - vLLM serving (transformers only)
- `sglang` - SGLang serving (transformers only)

### Model Formats
- sklearn: `pkl`, `joblib`
- xgboost: `json`, `model`, `ubj`
- tensorflow: `keras`, `h5`, `SavedModel`
- transformers: N/A (loaded from Hugging Face Hub)

## Code Conventions

### JavaScript Style
- Use ES6+ features (const, arrow functions, async/await)
- Prefer `const` over `let`, avoid `var`
- Use template literals for string interpolation
- Follow existing ESLint configuration

### Generator Methods
- `prompting()` - Collect user input via interactive prompts
- `writing()` - Copy and process template files
- `_validateAnswers()` - Private method for validation (prefix with `_`)

### Template Variables
All answers are stored in `this.answers` and available in templates:
```javascript
{
  projectName,
  destinationDir,
  framework,
  modelFormat,
  modelServer,
  includeSampleModel,
  includeTesting,
  testTypes,
  deployTarget,
  instanceType,
  awsRegion,
  buildTimestamp
}
```

## File Organization

### Generated Project Structure
```
project-name/
├── Dockerfile              # Container definition
├── requirements.txt        # Python dependencies
├── nginx.conf             # Nginx config (traditional ML only)
├── code/
│   ├── model_handler.py   # Model loading/inference logic
│   ├── serve.py           # Flask/FastAPI server
│   ├── serve              # vLLM/SGLang entrypoint script
│   └── flask/             # Flask-specific code
├── deploy/
│   ├── build_and_push.sh  # Build and push to ECR
│   ├── deploy.sh          # Deploy to SageMaker
│   └── upload_to_s3.sh    # Upload model to S3 (transformers)
├── sample_model/          # Optional sample training code
└── test/                  # Optional test suite
```

## Template Exclusion Logic

Files are conditionally excluded based on configuration:

- **Transformers**: Excludes traditional ML serving code (model_handler.py, serve.py, nginx.conf)
- **Traditional ML**: Excludes transformer serving code (code/serve, upload_to_s3.sh)
- **Non-Flask**: Excludes Flask-specific code
- **No sample model**: Excludes sample_model/ directory
- **No testing**: Excludes test/ directory

## Development Workflow

### Making Changes
1. Edit generator logic in `generators/app/index.js`
2. Edit templates in `generators/app/templates/`
3. Run `npm link` to test locally
4. Test with `yo ml-container-creator`
5. Run `npm test` before committing

### Testing
- Unit tests in `test/` directory
- Use `yeoman-test` and `yeoman-assert` for generator testing
- Run security audit before tests: `npm run pretest`

### Adding New Features
1. Add to `SUPPORTED_OPTIONS` if it's a new option type
2. Add prompt in appropriate phase (Project/Core/Module/Infrastructure)
3. Add validation in `_validateAnswers()`
4. Create/modify templates as needed
5. Update ignore patterns if conditional

## AWS/SageMaker Context

### SageMaker BYOC Requirements
- Container must expose port 8080
- Must implement `/ping` (health check) and `/invocations` (inference) endpoints
- Model artifacts typically stored in `/opt/ml/model/`
- Environment variables: `SM_MODEL_DIR`, `SM_NUM_GPUS`, etc.

### Deployment Flow
1. Build Docker image locally
2. Push to Amazon ECR
3. Create SageMaker model from ECR image
4. Deploy to SageMaker endpoint
5. Test endpoint with sample data

## Common Patterns

### Adding a New Framework
1. Add to `SUPPORTED_OPTIONS.frameworks`
2. Add model format choices in prompting
3. Create template variations if needed
4. Update validation logic
5. Test all combinations

### Adding a New Model Server
1. Add to `SUPPORTED_OPTIONS.modelServer`
2. Create server-specific templates in `code/`
3. Update ignore patterns
4. Add appropriate dependencies to requirements.txt template
5. Update Dockerfile if needed

## Dependencies

### Runtime (Generated Projects)
- Python 3.8+
- Docker 20+
- AWS CLI 2+
- Framework-specific: scikit-learn, xgboost, tensorflow, vllm, sglang

### Development (Generator)
- Node.js 24+
- Yeoman
- ESLint
- Mocha

## Security Considerations

- Run `npm audit` before tests (automated in pretest)
- Use `npm-force-resolutions` for dependency overrides
- Keep dependencies updated via `overrides` in package.json
- Never commit AWS credentials

## Troubleshooting

### Generator Issues
- Run `npm link` after changes
- Clear Yeoman cache: `rm -rf ~/.config/configstore/insight-yo.json`
- Check Node version: `node --version` (must be 24+)

### Generated Project Issues
- Test locally before deploying: `docker build` and `docker run`
- Check SageMaker logs in CloudWatch
- Verify IAM role has necessary permissions
- Ensure ECR repository exists in target region
