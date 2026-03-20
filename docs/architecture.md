# ML Container Creator - Architecture Guide

## Project Overview

This is a Yeoman generator that creates Docker containers for deploying ML models to AWS SageMaker using the Bring Your Own Container (BYOC) paradigm.

## Quick Architecture Overview

For newcomers, here's how the generator works:

```
User runs: yo @aws/ml-container-creator
           ↓
    ┌─────────────────┐
    │   index.js      │  ← Main generator (orchestration)
    │  (~50 lines)    │
    └─────────────────┘
           ↓
    ┌─────────────────┐
    │ PromptRunner    │  ← Collects user input
    │ (prompts.js)    │     • Project name
    └─────────────────┘     • Framework choice
           ↓                • Optional modules
    ┌─────────────────┐
    │ TemplateManager │  ← Validates & determines templates
    │                 │     • Checks supported options
    └─────────────────┘     • Builds ignore patterns
           ↓
    ┌─────────────────┐
    │ Template Copy   │  ← Copies & processes templates
    │ (EJS processing)│     • Replaces variables
    └─────────────────┘     • Excludes unwanted files
           ↓
    Generated Project Ready! 🎉
```

## Detailed Architecture

### Generator Structure (Modular Design)

The generator follows a clean, modular architecture:

- **Main generator**: `generators/app/index.js` - Orchestrates the generation process (~50 lines)
- **Prompt definitions**: `generators/app/lib/prompts.js` - All user prompts organized by phase
- **Prompt orchestration**: `generators/app/lib/prompt-runner.js` - Manages user interaction flow
- **Template logic**: `generators/app/lib/template-manager.js` - Handles conditional template copying
- **Templates**: `generators/app/templates/` - EJS templates that get copied and processed

### Key Components

#### 1. Main Generator (`index.js`)
- **Purpose**: Orchestrates the generation process
- **Size**: ~50 lines (was 300+ before refactoring)
- **Responsibilities**: 
  - Delegates to specialized modules
  - Sets destination directory
  - Handles errors

#### 2. Prompt Runner (`lib/prompt-runner.js`)
- **Purpose**: Manages user interaction
- **Phases**:
  1. 📋 Project Configuration
  2. 🔧 Core Configuration  
  3. 📦 Module Selection
  4. 💪 Infrastructure & Performance
- **Output**: Combined answers object

#### 3. Template Manager (`lib/template-manager.js`)
- **Purpose**: Handles template logic
- **Functions**:
  - Validates user configuration
  - Determines which templates to include/exclude
  - Centralizes conditional logic

#### 4. Prompts (`lib/prompts.js`)
- **Purpose**: Defines all user prompts
- **Organization**: Grouped by phase
- **Benefits**: Easy to add new prompts

### Key Concepts

1. **Yeoman Generator Pattern**: Extends `yeoman-generator` base class
2. **Phases**: Generator runs in phases (prompting → writing → install)
3. **Template Processing**: Uses EJS syntax (`<%= variable %>`) in template files
4. **Conditional Generation**: Files can be excluded via `ignorePatterns` array
5. **Modular Design**: Separation of concerns for maintainability

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

## Configuration Decision Tree

```
Framework?
├── sklearn/xgboost/tensorflow (Traditional ML)
│   ├── Model Format? (pkl, json, keras, etc.)
│   ├── Server? (Flask or FastAPI)
│   ├── Include sample model? (Yes/No)
│   ├── Include tests? (Yes/No)
│   └── Instance type? (CPU or GPU)
│
└── transformers (LLMs)
    ├── Server? (vLLM or SGLang)
    ├── Include tests? (Yes - endpoint only)
    └── Instance type? (GPU only)
```

## Template Structure & Logic

### Generated Project Structure
```
project-name/
├── Dockerfile              ← Always included
├── requirements.txt        ← Excluded for transformers
├── nginx-predictors.conf   ← Excluded for transformers (traditional ML only)
├── nginx-tensorrt.conf     ← Included only for TensorRT-LLM
├── code/
│   ├── model_handler.py   ← Excluded for transformers
│   ├── serve.py           ← Excluded for transformers
│   ├── serve              ← Excluded for traditional ML
│   └── flask/             ← Excluded if not Flask
├── deploy/
│   ├── build_and_push.sh  ← Always included
│   ├── deploy.sh          ← Always included
│   └── upload_to_s3.sh    ← Excluded for traditional ML
├── sample_model/          ← Optional module
└── test/                  ← Optional module
```

### File Generation Logic

The generator uses **exclusion patterns** to determine which templates to copy:

```javascript
// Example: Transformers exclude traditional ML files
if (framework === 'transformers') {
    exclude: [
        'model_handler.py',  // Custom loading
        'serve.py',          // Flask/FastAPI
        'nginx-predictors.conf', // Traditional ML reverse proxy
        'requirements.txt'   // Traditional deps
    ]
}
```

### Template Exclusion Logic

Files are conditionally excluded based on configuration:

- **Transformers**: Excludes traditional ML serving code (model_handler.py, serve.py, nginx-predictors.conf)
- **Traditional ML**: Excludes transformer serving code (code/serve, upload_to_s3.sh, nginx-tensorrt.conf, start_server.sh)
- **TensorRT-LLM**: Includes nginx-tensorrt.conf and start_server.sh for SageMaker compatibility
- **Non-Flask**: Excludes Flask-specific code
- **No sample model**: Excludes sample_model/ directory
- **No testing**: Excludes test/ directory

## Benefits of This Architecture

### ✅ **Maintainable**
- Small, focused modules
- Clear separation of concerns
- Easy to understand and modify

### ✅ **Testable**
- Each module can be tested independently
- Clear inputs and outputs
- Mocking is straightforward

### ✅ **Extensible**
- Adding new prompts is simple
- New template logic is centralized
- Framework additions follow patterns

### ✅ **Readable**
- Main generator is ~50 lines
- Logic is organized by purpose
- Comments explain the "why"

## Development Workflow

### Making Changes
1. Edit generator logic in appropriate module:
   - Prompts: `generators/app/lib/prompts.js`
   - Template logic: `generators/app/lib/template-manager.js`
   - Orchestration: `generators/app/index.js`
2. Edit templates in `generators/app/templates/`
3. Run `npm link` to test locally
4. Test with `yo @aws/ml-container-creator`
5. Run `npm test` before committing

### Testing
- Unit tests in `test/` directory
- Focus on `TemplateManager` and core logic
- Run security audit before tests: `npm run pretest`
- Use `npm run test:watch` for development

### Adding New Features

#### Adding a New Prompt
1. Add prompt definition to appropriate phase in `prompts.js`
2. Update template logic if it affects file generation
3. Add test cases for the new option

#### Adding a New Template
1. Create template file with EJS variables
2. Add exclusion logic if conditional
3. Test with different configurations

#### Adding a New Framework
1. Add to prompt choices in `prompts.js`
2. Add template exclusion logic to `template-manager.js`
3. Create framework-specific templates
4. Add tests for the new configuration

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
