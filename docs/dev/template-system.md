# Template System

Templates live in `templates/` and use [EJS](https://ejs.co/) syntax. The generator renders them during the writing phase, with all template variables flowing from user configuration through `src/app.js`.

---

## Directory Structure

```
templates/
├── Dockerfile              # Main Dockerfile (HTTP + Transformers architectures)
├── IAM_PERMISSIONS.md      # IAM permissions reference (rendered per-project)
├── MIGRATION.md            # Migration notes for upgrading MCC versions
├── PROJECT_README.md       # Becomes README.md in generated project
├── TEMPLATE_SYSTEM.md      # In-project template documentation
├── buildspec.yml           # CodeBuild spec for remote builds
├── deploy_notebook_generator.py  # SageMaker AI notebook exporter
├── nginx-diffusors.conf    # Nginx config for diffusors architecture
├── nginx-predictors.conf   # Nginx config for HTTP architecture
├── nginx-tensorrt.conf     # Nginx config for TensorRT-LLM
├── requirements.txt        # Python dependencies (HTTP architecture)
├── code/                   # Serving code (model_handler.py, serve.py, flask/)
├── deploy/                 # Deployment scripts
├── diffusors/              # Diffusors-specific Dockerfile + serve scripts
├── do/                     # Lifecycle scripts (build, deploy, test, tune, etc.)
├── hyperpod/               # HyperPod EKS manifests + scripts
├── marketplace/            # Marketplace-specific config/deploy/test overlays
├── sample_model/           # Sample sklearn/xgboost/tensorflow model training
├── test/                   # Test scripts
└── triton/                 # Triton-specific Dockerfile + model repository
```

---

## EJS Syntax

```ejs
<%= variable %>          <%# Escaped output (HTML entities) %>
<%- variable %>          <%# Raw output (no escaping — use in shell scripts) %>
<% if (condition) { %>   <%# Control flow %>
<% } %>
<%# This is a comment — not rendered %>
```

Templates have access to the full `templateVars` object, which includes all user answers plus computed values like `comments`, `orderedEnvVars`, and `serverEnvVars`.

---

## How Template Variables Flow

```
CLI flags / env vars / config file
         │
         ▼
src/lib/config-manager.js         → loads + merges all config sources
         │
         ▼
src/lib/prompt-runner.js          → runs interactive prompts (fills gaps)
         │
         ▼
configManager.getFinalConfiguration()  → merged answers object
         │
         ▼
src/lib/template-variable-resolver.js  → ensures defaults, merges env vars from catalogs
         │
         ▼
src/app.js writeProject()         → adds comments, orderedEnvVars, serverEnvVars
         │
         ▼
src/copy-tpl.js                   → renders all EJS templates with templateVars
```

The precedence for environment variables (lowest → highest):

1. Catalog defaults (`Image_Entry.defaults.envVars`)
2. Framework profile (`Image_Entry.profiles[selectedProfile].envVars`)
3. Model entry (`model catalog entry envVars`)
4. Model profile (`model catalog entry profiles[selectedProfile].envVars`)
5. CLI overrides (user's `--env` flags or config file)

---

## The Dockerfile Template

The main `templates/Dockerfile` (332 lines) has a top-level branch on `framework !== 'transformers'`:

```ejs
<% if (framework !== 'transformers') { %>
  <%# HTTP architecture — python:3.12-slim, Nginx, model_handler.py %>
  FROM <%= baseImage || 'public.ecr.aws/docker/library/python:3.12-slim' %>
  ...
<% } else { %>
  <%# Transformers architecture — framework-specific base images %>
  <% if (modelServer === 'vllm') { %>
    ARG BASE_IMAGE=<%= baseImage || 'vllm/vllm-openai:v0.10.1' %>
  <% } else if (modelServer === 'sglang') { %>
    ARG BASE_IMAGE=<%= baseImage || 'lmsysorg/sglang:v0.5.4.post1' %>
  <% } else if (modelServer === 'tensorrt-llm') { %>
    ...
  <% } %>
<% } %>
```

Architecture-specific Dockerfiles live in their own directories:

- `templates/triton/Dockerfile` — for Triton architecture
- `templates/diffusors/Dockerfile` — for Diffusors architecture

These are rendered and overlaid during the writing phase (not via the main Dockerfile).

---

## Runtime Branching in do/ Scripts

The `do/` scripts in `templates/do/` use **three** branching strategies:

### 1. EJS Conditionals (Generation-Time)

Some scripts have EJS blocks that emit different code based on `deploymentTarget`, `deploymentConfig`, or `architecture`:

```ejs
<%# In templates/do/config %>
<% if (deploymentTarget === 'realtime-inference') { %>
export ENDPOINT_INITIAL_INSTANCE_COUNT=<%= endpointInitialInstanceCount || 1 %>
<% } else if (deploymentTarget === 'async-inference') { %>
export ASYNC_S3_OUTPUT_PATH="<%= asyncS3OutputPath %>"
<% } %>
```

### 2. Shell `case` Statements (Runtime)

Other scripts use runtime branching on `DEPLOYMENT_CONFIG` (sourced from `do/config`). This means the same generated script works for multiple backends:

```bash
case "${DEPLOYMENT_CONFIG}" in
    transformers-tensorrt-llm)
        # NGC authentication, then docker build
        ;;
    transformers-vllm|transformers-sglang)
        # Standard GPU image build
        ;;
    transformers-lmi|transformers-djl)
        # ECR authentication for DLC base images
        ;;
    http-flask|http-fastapi)
        # CPU image build
        ;;
esac
```

### 3. EJS Partials (Include Files)

Complex scripts use EJS partials in `.d/` directories:

```
templates/do/
├── deploy
├── deploy.d/
│   ├── async-inference.ejs
│   ├── batch-transform.ejs
│   ├── hyperpod-eks.ejs
│   └── managed-inference.ejs
├── clean
└── clean.d/
    ├── async-inference.ejs
    ├── batch-transform.ejs
    ├── hyperpod-eks.ejs
    └── managed-inference.ejs
```

The main `do/deploy` template includes the appropriate partial:

```ejs
<%- include('deploy.d/' + (deploymentTarget === 'realtime-inference' ? 'managed-inference' : deploymentTarget)) %>
```

!!! note "Legacy partial naming"
    The partials for realtime inference are named `managed-inference.ejs` (a legacy artifact from before the `realtime-inference` rename). The include expression handles this mapping. New partials should use the current `deploymentTarget` value as their filename.

Partials are NOT copied to the output (they're in `ignorePatterns`). They're resolved at generation time.

---

## Architecture-Specific File Routing

The `writeProject()` function in `src/app.js` handles five architectures. After copying all non-ignored templates, it **deletes** files that don't belong:

| Architecture | Keeps | Deletes | Special |
|---|---|---|---|
| `http` | model_handler.py, serve.py, flask/, nginx-predictors.conf | code/serve, serving.properties, chat_template.jinja, start_server.sh | Deletes flask/ if backend is fastapi |
| `transformers` | code/serve, serving.properties, chat_template.jinja | model_handler.py, serve.py, start_server.py, flask/, nginx-predictors.conf | — |
| `triton` | — | All http + transformers code files | Overlays triton/Dockerfile, generates model_repository/ |
| `diffusors` | — | All http + transformers code files | Overlays diffusors/Dockerfile, serve, start_server.sh, patch_image_api.py |
| `marketplace` | — | Almost everything (no container) | Overlays marketplace/config, deploy, test |

### Conditional File Exclusion (Ignore Patterns)

Before file routing, the generator excludes entire file trees based on configuration:

| Condition | Excluded |
|---|---|
| `deploymentTarget !== 'hyperpod-eks'` | `hyperpod/**` |
| `deploymentTarget === 'hyperpod-eks'` | `do/lib/**`, `do/ic/**`, `do/add-ic`, `do/status`, `do/optimize` |
| `deploymentTarget === 'async-inference'` or `batch-transform` | `do/ic/**`, `do/add-ic`, `do/status` |
| `!enableLora` | `do/adapter`, `do/adapters/**`, `code/adapter_sidecar.py` |
| `!includeBenchmark` | `do/benchmark`, `do/optimize` |
| Architecture is not `transformers` | `do/tune`, `do/.tune_helper.py` |
| `deploymentTarget === 'batch-transform'` | `do/train`, `do/training/**` |
| `!includeSampleModel` or transformers/diffusors | `sample_model/**` |
| Test type `hosted-model-endpoint` not selected | `do/test` |

---

## Key Template Variables

These variables are available in all templates via the `templateVars` context:

### Core Configuration

| Variable | Type | Description |
|---|---|---|
| `projectName` | string | Project name (e.g., `my-llm`) |
| `deploymentConfig` | string | Full config string (e.g., `transformers-vllm`) |
| `architecture` | string | `http`, `transformers`, `triton`, `diffusors`, `marketplace` |
| `backend` | string | Backend server (e.g., `vllm`, `flask`, `fil`) |
| `framework` | string | Derived framework (`transformers`, `http`) |
| `modelServer` | string | Alias for backend |
| `modelName` | string | HuggingFace model ID or S3 path |
| `modelFormat` | string | `pkl`, `joblib`, `h5`, `SavedModel`, etc. |
| `modelSource` | string | `huggingface`, `s3`, `registry` |
| `deploymentTarget` | string | `realtime-inference`, `async-inference`, `batch-transform`, `hyperpod-eks` |
| `instanceType` | string | SageMaker AI instance type |
| `region` | string | AWS region |
| `buildTarget` | string | `local`, `codebuild` |

### Feature Flags

| Variable | Type | Description |
|---|---|---|
| `enableLora` | boolean | Whether LoRA adapter support is enabled |
| `includeSampleModel` | boolean | Whether to include sample training data |
| `includeBenchmark` | boolean | Whether to include benchmarking scripts |
| `includeTesting` | boolean | Whether to include test scripts |

### Infrastructure

| Variable | Type | Description |
|---|---|---|
| `baseImage` | string | Docker base image |
| `roleArn` | string | SageMaker AI execution role ARN |
| `buildTimestamp` | string | ISO timestamp of generation |
| `hyperPodCluster` | string | HyperPod cluster name (if applicable) |
| `hyperPodNamespace` | string | HyperPod namespace (default: `default`) |
| `hyperPodReplicas` | number | HyperPod replica count (default: 1) |

### LoRA

| Variable | Type | Description |
|---|---|---|
| `maxLoras` | number | Maximum concurrent LoRA adapters (default: 30) |
| `maxLoraRank` | number | Maximum LoRA rank (default: 64) |

### Environment Variables

| Variable | Type | Description |
|---|---|---|
| `envVars` | object | Raw env var key-value pairs |
| `orderedEnvVars` | array | `[{key, value}]` — ordered for Dockerfile `ENV` lines |
| `modelEnvVars` | object | Model-specific env vars from catalogs |
| `serverEnvVars` | object | Engine-prefixed server env vars |
| `comments` | object | Generated Dockerfile comments (accelerator info, env var explanations) |

---

## Adding a New Deployment Configuration

A deployment configuration is a string like `transformers-vllm` or `triton-fil` that bundles an architecture and a backend. There are currently **16 canonical configs** (2 HTTP + 5 Transformers + 7 Triton + 1 Diffusors + 1 Marketplace).

To add one, touch these files:

### 1. Deployment config resolver (`src/lib/deployment-config-resolver.js`)

Add the canonical mapping in the `CANONICAL_CONFIGS` Map:

```javascript
['transformers-myserver', { architecture: 'transformers', backend: 'myserver', engine: null }],
```

### 2. Validation (`src/lib/template-manager.js`)

Add the value to the `deploymentConfigs` array in `validate()`. If the backend requires a GPU, add it to `GPU_REQUIRING_BACKENDS`:

```javascript
const GPU_REQUIRING_BACKENDS = ['triton-vllm', 'triton-tensorrtllm', 'diffusors-vllm-omni', 'transformers-myserver'];
```

### 3. Prompt definition (`src/lib/prompts/infrastructure-prompts.js`)

Add a choice to the deployment config prompt:

```javascript
{
    name: 'Transformers with MyServer',
    value: 'transformers-myserver',
    short: 'transformers-myserver'
}
```

### 4. Dockerfile template (`templates/Dockerfile`)

In the `else` (transformers) branch, add an `else if` for the new backend:

```ejs
<% } else if (modelServer === 'myserver') { %>
ARG BASE_IMAGE=<%= baseImage || 'myserver/myserver:latest' %>
FROM ${BASE_IMAGE}
...
<% } %>
```

### 5. do/ script case statements

Add cases to `templates/do/build`, `templates/do/deploy`, `templates/do/test`, and `templates/do/clean` for any backend-specific behavior (authentication, build flags, test payloads).

### 6. Base image catalog entry

Add an image entry to `servers/base-image-picker/catalogs/model-servers.json` so the MCP server can recommend the correct base image. See [MCP Server Development](mcp-server-development.md) for the catalog schema.

### 7. Parameter schema (if new params needed)

If the new backend introduces unique parameters, add them to `config/parameter-schema-v2.json` with `appliesTo` scoped to the new config. See [Schema-Driven Architecture](schema-driven-architecture.md).

### 8. Tests

Add test cases:

- `test/input-parsing-and-generation/` — generate a project with the new config, assert expected files
- `test/property/` — if the config introduces validation rules
- Property tests for deployment-config-resolver decomposition

See [Testing](testing.md) for the test framework details.

---

## Tips

- **Preview rendering:** Use `npx ejs templates/Dockerfile -d '{"framework":"transformers","modelServer":"vllm",...}'` to preview a template without running the full generator.
- **Debug variables:** Add `<%- JSON.stringify(answers, null, 2) %>` temporarily to any template to dump the full context.
- **Shell escaping:** In `do/` scripts, use `<%-` (raw output) not `<%=` (HTML-escaped) — otherwise `<`, `>`, and `&` get mangled.
