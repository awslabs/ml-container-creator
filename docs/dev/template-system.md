# Template System

Templates live in `generators/app/templates/` and use [EJS](https://ejs.co/) syntax. All template variables come from `this.answers` in the generator.

## EJS in Templates

```ejs
<%= variable %>          <%# Escaped output %>
<% if (condition) { %>   <%# Control flow %>
<% } %>
```

The Dockerfile template (`templates/Dockerfile`) is the most complex. It has a top-level `if/else` on `framework !== 'transformers'` that splits into two entirely different Dockerfiles: one for HTTP architecture (python:3.12-slim base, Nginx, model_handler.py) and one for transformers (framework-specific base images, model server entrypoints). Within the transformers branch, nested conditionals handle vLLM, SGLang, TensorRT-LLM, LMI, and DJL differences.

Triton and diffusors architectures have their own Dockerfile templates in `templates/triton/Dockerfile` and `templates/diffusors/Dockerfile`, copied during the `writing()` phase.

## Runtime Branching in do/ Scripts

The `do/` scripts use `case` statements on `DEPLOYMENT_CONFIG` (sourced from `do/config`) instead of generating different scripts per configuration. This means all 15 deployment configurations share the same `do/build`, `do/deploy`, `do/test`, and `do/clean` scripts.

Example from `do/build`:

```bash
case "${DEPLOYMENT_CONFIG}" in
    transformers-tensorrt-llm)
        # NGC authentication, then docker build
        ;;
    transformers-vllm|transformers-sglang)
        # GPU image build
        ;;
    transformers-lmi|transformers-djl)
        # ECR authentication for DLC base images, then build
        ;;
    sklearn-*|xgboost-*|tensorflow-*)
        # CPU image build
        ;;
esac
```

The `do/config` template uses EJS conditionals to emit different environment variable blocks based on `deploymentTarget` (managed-inference, async-inference, batch-transform, hyperpod-eks) and `framework` (transformers, diffusors, http).

## Architecture-Specific File Routing

The `writing()` phase in `index.js` handles four architectures:

| Architecture | Keeps | Deletes | Special |
|---|---|---|---|
| `http` | model_handler.py, serve.py, flask/, nginx-predictors.conf | code/serve, serving.properties, chat_template.jinja | Deletes flask/ if backend is fastapi |
| `transformers` | code/serve, serving.properties, chat_template.jinja | model_handler.py, serve.py, flask/, nginx-predictors.conf | -- |
| `triton` | -- | All http and transformers code files | Copies triton/Dockerfile, generates model_repository/ with config.pbtxt |
| `diffusors` | -- | All http and transformers code files | Copies diffusors/Dockerfile, serve, start_server.sh, patch_image_api.py |

## Adding a New Deployment Configuration

A deployment configuration is a string like `transformers-vllm` or `triton-fil` that bundles an architecture and backend. To add one, touch these files:

### 1. Prompt definition (`prompts.js`)

Add a choice to the `deploymentConfigPrompts` array:

```javascript
{
    name: 'Transformers with MyServer',
    value: 'transformers-myserver',
    short: 'transformers-myserver'
}
```

### 2. Validation (`template-manager.js`)

Add the value to the `supportedOptions.deploymentConfigs` array. If the backend requires a GPU, add it to `GPU_REQUIRING_BACKENDS`.

### 3. Deployment config resolver (`deployment-config-resolver.js`)

If the architecture-backend split is non-obvious (e.g., `triton-tensorrtllm` maps to backend `tensorrtllm`, not `tensorrt-llm`), add a mapping entry.

### 4. Dockerfile template

For http or transformers architectures, add an `else if` branch in `templates/Dockerfile`. For triton or diffusors, add logic in the architecture-specific Dockerfile.

### 5. do/ script case statements

Add a case to `do/build`, `do/deploy`, `do/test`, and `do/clean` for any configuration-specific behavior (authentication, special flags, test payloads).

### 6. Catalog entry

Add an image entry to `servers/base-image-picker/catalogs/model-servers.json` (see [MCP Server Development](mcp-server-development.md)).

### 7. Tests

Add a test case to `test/generator.test.js` that generates a project with the new config and asserts the expected files exist. Add a property test if the new config introduces validation rules.
