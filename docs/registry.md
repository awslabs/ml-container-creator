# Registry System

The ML Container Creator includes a registry system that provides curated configurations for frameworks, models, and deployment targets. This system ensures your generated containers use tested, optimized settings for production deployments.

## Overview

The registry system consists of three components:

1. **Framework Registry** - Framework versions, base images, environment variables, and accelerator requirements
2. **Model Registry** - Model-specific configurations, chat templates, and known compatibility issues
3. **Instance Accelerator Mapping** - Maps AWS instance types to accelerator capabilities

These registries are automatically loaded when you run the CLI tool and provide intelligent defaults based on your selections.

## Framework Registry

### What It Provides

For each framework version, the registry defines:

- **Base Docker image** - Pre-built images with framework dependencies
- **Accelerator requirements** - CUDA version, compute capability, etc.
- **Environment variables** - Optimized runtime settings
- **SageMaker AI AMI version** - Compatible inference AMI
- **Recommended instance types** - Cost-effective instance recommendations
- **Validation level** - Testing status (tested, community-validated, experimental)
- **Profiles** - Pre-configured optimization profiles (low-latency, high-throughput, etc.)

### Example: vLLM Framework

```javascript
"vllm": {
  "0.4.0": {
    baseImage: "vllm/vllm-openai:v0.4.0",
    accelerator: {
      type: "cuda",
      version: "12.1",
      versionRange: { min: "12.0", max: "12.3" }
    },
    envVars: {
      "VLLM_TENSOR_PARALLEL_SIZE": "1",
      "VLLM_GPU_MEMORY_UTILIZATION": "0.9",
      "VLLM_MAX_NUM_SEQS": "256"
    },
    recommendedInstanceTypes: ["ml.g5.xlarge", "ml.g5.2xlarge"],
    validationLevel: "tested"
  }
}
```

### Validation Levels

| Level | Description | Usage |
|-------|-------------|-------|
| **tested** | Thoroughly tested by maintainers | Production-ready, recommended |
| **community-validated** | Tested by community contributors | Generally safe, may have edge cases |
| **experimental** | New or untested configurations | Use with caution, may change |
| **unknown** | No validation information | Not recommended for production |

### Framework Profiles

Profiles provide pre-configured optimization settings for common use cases:

**Low Latency Profile:**
- Optimized for single-request latency
- Smaller batch sizes
- Lower memory utilization
- Best for real-time inference

**High Throughput Profile:**
- Optimized for batch processing
- Larger batch sizes
- Higher memory utilization
- Best for offline/batch inference

**Example Usage:**

```bash
ml-container-creator \
  --deployment-config=transformers-vllm
```

## Model Registry

### What It Provides

For specific models or model families, the registry defines:

- **Chat templates** - Jinja2 templates for chat-based models
- **Framework compatibility** - Which frameworks support this model
- **Environment variable overrides** - Model-specific optimizations
- **Known issues** - Documented compatibility problems
- **Recommended instance types** - Based on model size
- **Model profiles** - Size-specific configurations (7B, 13B, 70B, etc.)

### Example: Llama-2 Model

```javascript
"meta-llama/Llama-2-7b-chat-hf": {
  family: "llama-2",
  chatTemplate: "{% for message in messages %}...",
  requiresTemplate: true,
  validationLevel: "tested",
  frameworkCompatibility: {
    "vllm": ">=0.3.0",
    "tensorrt-llm": ">=0.8.0"
  },
  profiles: {
    "7b": {
      displayName: "Llama-2 7B",
      envVars: {
        "MAX_MODEL_LEN": "4096",
        "GPU_MEMORY_UTILIZATION": "0.9"
      },
      recommendedInstanceTypes: ["ml.g5.xlarge"]
    }
  }
}
```

### Pattern Matching

The model registry supports wildcard patterns for model families:

```javascript
"mistralai/Mistral-*": {
  family: "mistral",
  // Applies to all Mistral models
}
```

This allows configuration to apply to multiple model variants without duplicating entries.

### Chat Templates

Chat templates define how conversation history is formatted for the model. The registry includes templates for popular chat models:

- Llama-2 chat format
- Mistral Instruct format
- Vicuna format
- ChatML format

If a model doesn't have a template in the registry, MCC attempts to fetch it from HuggingFace Hub.

## Instance Accelerator Mapping

Maps AWS SageMaker AI instance types to their accelerator capabilities:

```javascript
"ml.g5.xlarge": {
  accelerator: {
    type: "cuda",
    version: "12.1",
    computeCapability: "8.6",
    gpuMemory: "24GB",
    gpuCount: 1
  },
  vcpus: 4,
  memory: "16GB"
}
```

This mapping helps validate that your selected instance type is compatible with your framework's accelerator requirements.

## How the Registry Works

### 1. Automatic Loading

When you run the CLI tool, registries are loaded automatically:

```
📚 Registry System Initialized
   • Framework Registry: Loaded
   • Model Registry: Loaded
   • Instance Accelerator Mapping: Loaded
```

### 2. Configuration Matching

The CLI tool matches your selections against registry entries:

```bash
ml-container-creator \
  --framework=transformers \
  --model-server=vllm \
  --model-name="meta-llama/Llama-2-7b-chat-hf"
```

**Matching Process:**
1. Find framework version in Framework Registry
2. Find model in Model Registry (exact match or pattern)
3. Merge configurations with precedence: Model > Framework > Defaults
4. Validate instance type compatibility

### 3. Configuration Precedence

When multiple sources provide the same configuration, precedence is:

1. **User input** (CLI flags, prompts) - Highest priority
2. **Model Registry** - Model-specific overrides
3. **Framework Registry** - Framework defaults
4. **Generator defaults** - Lowest priority

### 4. Environment Variable Validation

The registry system validates environment variables against framework requirements:

```
🔍 Validating environment variables...
   ✅ All environment variables validated successfully
```

**Validation checks:**
- Required variables are present
- Values are within acceptable ranges
- CUDA versions are compatible
- Memory settings are reasonable

## Using the Registry

### View Available Frameworks

```bash
ml-container-creator --help
```

Look for the "REGISTRY SYSTEM" section showing available frameworks and versions.

### Select Framework Version

During prompting:

```
? Which framework version?
  ❯ 0.4.0 (tested)
    0.3.0 (community-validated)
    0.2.0 (experimental)
```

Or via CLI:

```text
# Framework version is now determined by the base image in the catalog
# See: servers/base-image-picker/catalogs/model-servers.json
```

### Select Framework Profile

```
? Select optimization profile:
  ❯ Default
    Low Latency (optimized for single-request latency)
    High Throughput (optimized for batch processing)
```

Or via CLI:

```text
# Framework profiles are no longer CLI flags
# Configure via environment variables in do/config instead
```

### Offline Mode

If you don't have internet access or want to skip HuggingFace API lookups:

```bash
ml-container-creator --offline
```

This disables:
- HuggingFace Hub API calls
- Model existence validation
- Chat template fetching from HF

The CLI tool will use registry data only.

## Configuration Sources

The CLI tool shows which sources contributed to your configuration:

```
Configuration Sources:
   • Framework_Registry
   • Model_Registry
   • HuggingFace_Hub_API
   • User_Input
```

This helps you understand where each setting came from.

## Validation Levels

### Environment Variable Validation

By default, the CLI tool validates environment variables:

```bash
# Enable validation (default)
ml-container-creator --validate-env-vars=true

# Disable validation
ml-container-creator --validate-env-vars=false
```

**What gets validated:**
- CUDA version compatibility
- Memory utilization ranges (0.0-1.0)
- Tensor parallel size vs GPU count
- Max sequence length limits

### Docker Introspection (Experimental)

For advanced validation, enable Docker introspection:

```bash
ml-container-creator \
  --validate-env-vars=true \
  --validate-with-docker=true
```

This runs the base image and inspects:
- Installed CUDA version
- Available GPU memory
- Framework version
- Python version

**Note:** Requires Docker and may take longer.

## Contributing to the Registry

The registry is community-driven. You can contribute:

### 1. Test New Framework Versions

Try a new framework version and report results:

```bash
ml-container-creator \
  --deployment-config=transformers-vllm
```

If it works, submit a PR adding it to `servers/base-image-picker/catalogs/model-servers.json`.

### 2. Add Model Configurations

Found optimal settings for a model? Add them to `servers/model-picker/catalogs/popular-transformers.json`:

```javascript
"your-org/your-model": {
  family: "custom",
  chatTemplate: "...",
  validationLevel: "community-validated",
  frameworkCompatibility: {
    "vllm": ">=0.4.0"
  },
  notes: "Tested on ml.g5.xlarge with vLLM 0.4.0"
}
```

### 3. Report Issues

Found a compatibility issue? Open an issue with:
- Framework and version
- Model name
- Instance type
- Error message
- Steps to reproduce

See [Registry Contribution Guide](REGISTRY_CONTRIBUTION_GUIDE.md) for detailed instructions.

## Troubleshooting

### Registry Loading Failed

```
⚠️  Registry system initialization failed, using defaults
```

**Causes:**
- Corrupted registry files
- Syntax errors in registry JavaScript
- Missing dependencies

**Solution:**
- Check `servers/*/catalogs/` files
- Reinstall CLI tool
- Report issue if problem persists

### Validation Errors

```
❌ Environment Variable Validation Errors:
   • VLLM_GPU_MEMORY_UTILIZATION: Value 1.5 exceeds maximum 1.0
```

**Solution:**
- Fix the environment variable value
- Or disable validation: `--validate-env-vars=false`

### Model Not Found in Registry

```
ℹ️  Not found on HuggingFace Hub (may be private or offline)
```

**This is normal for:**
- Private models
- Local models
- Offline mode

**Solution:**
- Continue with generation (registry provides defaults)
- Or add model to registry if you have configuration

### Instance Type Incompatible

```
⚠️  Selected instance type ml.t2.micro does not support CUDA
```

**Solution:**
- Choose GPU-enabled instance: `ml.g5.xlarge`
- Or use CPU-compatible framework

## Advanced Usage

### Custom Registry Location

For enterprise deployments, you can maintain a custom registry:

```bash
export REGISTRY_PATH=/path/to/custom/registries
ml-container-creator
```

### Registry Versioning

Registries are versioned with the CLI tool.

### Programmatic Access

Access registry data programmatically:

```javascript
import RegistryLoader from './lib/registry-loader.js';

const loader = new RegistryLoader();
const frameworks = await loader.loadFrameworkRegistry();
console.log(frameworks.vllm['0.4.0']);
```

## Best Practices

1. **Use tested configurations** - Prefer `validationLevel: "tested"` for production
2. **Enable validation** - Keep `--validate-env-vars=true` to catch issues early
3. **Check compatibility** - Verify framework version supports your model
4. **Use profiles** - Leverage pre-configured profiles for common use cases
5. **Stay updated** - Update the CLI tool regularly for new registry entries
6. **Contribute back** - Share your successful configurations with the community

## See Also

- [Configuration Guide](configuration.md) - Complete configuration options
- [Getting Started](getting-started.md) - Basic usage guide
- [Registry Contribution Guide](REGISTRY_CONTRIBUTION_GUIDE.md) - How to contribute
- [Troubleshooting](TROUBLESHOOTING.md) - Common issues and solutions
