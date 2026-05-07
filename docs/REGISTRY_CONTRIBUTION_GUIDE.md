# Registry Contribution Guide

This guide explains how to contribute tested configurations to the ML Container Creator registry system.

## Overview

The registry system consists of three main registries:

1. **Framework Registry** - Framework-specific configurations (base images, environment variables, accelerator requirements)
2. **Model Registry** - Model-specific overrides and optimizations
3. **Instance Accelerator Mapping** - Instance type hardware specifications

## Table of Contents

- [Framework Registry](#framework-registry)
- [Model Registry](#model-registry)
- [Instance Accelerator Mapping](#instance-accelerator-mapping)
- [Validation Levels](#validation-levels)
- [Contributing Process](#contributing-process)
- [Testing Your Contribution](#testing-your-contribution)

## Framework Registry

### Schema

The Framework Registry stores framework-specific configurations indexed by framework name and version.

**Location:** `servers/base-image-picker/catalogs/model-servers.json`

**Schema:** `servers/lib/schemas/model-servers-schema.json`

### Structure

```javascript
{
  "framework_name": {
    "version": {
      "baseImage": "string",              // Docker base image
      "accelerator": {
        "type": "cuda" | "neuron" | "cpu" | "rocm",
        "version": "string | null",       // Required version (e.g., "12.1" for CUDA)
        "versionRange": {                 // Optional version range
          "min": "string",
          "max": "string"
        }
      },
      "envVars": {                        // Environment variables
        "VAR_NAME": "value"
      },
      "inferenceAmiVersion": "string",    // SageMaker AMI version
      "recommendedInstanceTypes": ["string"],  // Recommended instance types
      "validationLevel": "tested" | "community-validated" | "experimental" | "unknown",
      "profiles": {                       // Optional optimization profiles
        "profile_name": {
          "displayName": "string",
          "description": "string",
          "envVars": {},
          "recommendedInstanceTypes": ["string"],
          "notes": "string"
        }
      },
      "notes": "string"                   // Additional information
    }
  }
}
```

### Required Fields

- `baseImage` - Docker base image for the framework
- `accelerator.type` - Accelerator type (cuda, neuron, cpu, rocm)
- `accelerator.version` - Required accelerator version (null for CPU)
- `envVars` - Environment variables (can be empty object)
- `inferenceAmiVersion` - SageMaker AMI version
- `recommendedInstanceTypes` - Array of recommended instance types
- `validationLevel` - Validation level (see [Validation Levels](#validation-levels))

### Example: Adding vLLM 0.5.0

```javascript
{
  "vllm": {
    "0.5.0": {
      "baseImage": "vllm/vllm-openai:v0.5.0",
      "accelerator": {
        "type": "cuda",
        "version": "12.1",
        "versionRange": {
          "min": "12.0",
          "max": "12.2"
        }
      },
      "envVars": {
        "VLLM_MAX_BATCH_SIZE": "256",
        "VLLM_GPU_MEMORY_UTILIZATION": "0.9",
        "CUDA_VISIBLE_DEVICES": "0"
      },
      "inferenceAmiVersion": "al2-ami-sagemaker-inference-gpu-3-1",
      "recommendedInstanceTypes": [
        "ml.g5.xlarge",
        "ml.g5.2xlarge",
        "ml.g5.4xlarge"
      ],
      "validationLevel": "community-validated",
      "profiles": {
        "low-latency": {
          "displayName": "Low Latency",
          "description": "Optimized for single-request latency",
          "envVars": {
            "VLLM_MAX_BATCH_SIZE": "1",
            "VLLM_GPU_MEMORY_UTILIZATION": "0.95"
          },
          "recommendedInstanceTypes": ["ml.g5.xlarge"],
          "notes": "Best for real-time inference with minimal latency"
        },
        "high-throughput": {
          "displayName": "High Throughput",
          "description": "Optimized for batch processing",
          "envVars": {
            "VLLM_MAX_BATCH_SIZE": "512",
            "VLLM_GPU_MEMORY_UTILIZATION": "0.9"
          },
          "recommendedInstanceTypes": ["ml.g5.12xlarge", "ml.g5.24xlarge"],
          "notes": "Best for high-volume batch inference"
        }
      },
      "notes": "vLLM 0.5.0 adds support for new model architectures and improved performance"
    }
  }
}
```

### Example: Adding LMI (Large Model Inference)

```javascript
{
  "lmi": {
    "14.0.0": {
      "baseImage": "763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.32.0-lmi14.0.0-cu126",
      "accelerator": {
        "type": "cuda",
        "version": "12.6",
        "versionRange": {
          "min": "12.0",
          "max": "12.6"
        }
      },
      "envVars": {
        "SERVING_PORT": "8080",
        "OPTION_TENSOR_PARALLEL_DEGREE": "1",
        "OPTION_MAX_ROLLING_BATCH_SIZE": "32",
        "OPTION_DTYPE": "fp16"
      },
      "inferenceAmiVersion": "al2-ami-sagemaker-inference-gpu-3-2",
      "recommendedInstanceTypes": [
        "ml.g5.xlarge",
        "ml.g5.2xlarge",
        "ml.g5.4xlarge",
        "ml.g5.12xlarge"
      ],
      "validationLevel": "tested",
      "profiles": {
        "vllm-backend": {
          "displayName": "vLLM Backend",
          "description": "Use vLLM as the inference backend for LMI",
          "envVars": {
            "OPTION_ROLLING_BATCH": "vllm",
            "OPTION_MAX_ROLLING_BATCH_SIZE": "32",
            "OPTION_DTYPE": "fp16"
          },
          "recommendedInstanceTypes": ["ml.g5.xlarge", "ml.g5.2xlarge"],
          "notes": "vLLM backend provides excellent performance for most models"
        },
        "auto": {
          "displayName": "Auto Backend Selection",
          "description": "Let LMI automatically select the best backend",
          "envVars": {
            "OPTION_MAX_ROLLING_BATCH_SIZE": "32",
            "OPTION_DTYPE": "fp16"
          },
          "recommendedInstanceTypes": ["ml.g5.xlarge", "ml.g5.2xlarge", "ml.g5.4xlarge"],
          "notes": "LMI will analyze your model and select the optimal backend automatically"
        }
      },
      "notes": "AWS Large Model Inference (LMI) with automatic backend selection. Configuration uses serving.properties file instead of environment variables"
    }
  }
}
```

**Note:** LMI and DJL use `serving.properties` configuration files instead of environment variables. The `envVars` in the registry are converted to properties format during generation.

### Accelerator Types

#### CUDA (NVIDIA GPUs)
```javascript
"accelerator": {
  "type": "cuda",
  "version": "12.1",  // Major.minor version
  "versionRange": {
    "min": "12.0",
    "max": "12.2"
  }
}
```

#### Neuron SDK (AWS Inferentia/Trainium)
```javascript
"accelerator": {
  "type": "neuron",
  "version": "2.15.0",  // Semantic versioning
  "versionRange": {
    "min": "2.15.0",
    "max": "2.20.0"
  }
}
```

#### CPU
```javascript
"accelerator": {
  "type": "cpu",
  "version": null,  // No version for CPU
  "versionRange": null
}
```

#### ROCm (AMD GPUs)
```javascript
"accelerator": {
  "type": "rocm",
  "version": "5.4",  // Semantic versioning
  "versionRange": {
    "min": "5.4",
    "max": "6.0"
  }
}
```

## Model Registry

### Schema

The Model Registry stores model-specific overrides and optimizations.

**Location:** `servers/model-picker/catalogs/popular-transformers.json`

**Schema:** `servers/lib/schemas/model-registry-schema.json`

### Structure

```javascript
{
  "model_id_or_pattern": {
    "family": "string",                   // Model family name
    "chatTemplate": "string | null",      // Jinja2 chat template
    "requiresTemplate": boolean,          // Whether chat template is required
    "validationLevel": "tested" | "community-validated" | "experimental",
    "frameworkCompatibility": {           // Framework version requirements
      "framework_name": "version_range"
    },
    "profiles": {                         // Optional model profiles
      "profile_name": {
        "displayName": "string",
        "envVars": {}
      }
    },
    "notes": "string"
  }
}
```

### Required Fields

- `family` - Model family name
- `chatTemplate` - Chat template (null if not applicable)
- `requiresTemplate` - Whether chat template is required
- `validationLevel` - Validation level
- `frameworkCompatibility` - Compatible frameworks (can be empty object)

### Example: Adding Llama 3 Models

{% raw %}
```javascript
{
  "meta-llama/Meta-Llama-3-*": {
    "family": "llama-3",
    "chatTemplate": "{% for message in messages %}{% if message['role'] == 'system' %}{{ '<|start_header_id|>system<|end_header_id|>\n\n' + message['content'] + '<|eot_id|>' }}{% elif message['role'] == 'user' %}{{ '<|start_header_id|>user<|end_header_id|>\n\n' + message['content'] + '<|eot_id|>' }}{% elif message['role'] == 'assistant' %}{{ '<|start_header_id|>assistant<|end_header_id|>\n\n' + message['content'] + '<|eot_id|>' }}{% endif %}{% endfor %}{% if add_generation_prompt %}{{ '<|start_header_id|>assistant<|end_header_id|>\n\n' }}{% endif %}",
    "requiresTemplate": true,
    "validationLevel": "community-validated",
    "frameworkCompatibility": {
      "vllm": ">=0.4.0",
      "tensorrt-llm": ">=0.9.0",
      "sglang": ">=0.2.0"
    },
    "profiles": {
      "8b": {
        "displayName": "Llama 3 8B",
        "envVars": {
          "MAX_MODEL_LEN": "8192",
          "GPU_MEMORY_UTILIZATION": "0.9"
        },
        "recommendedInstanceTypes": ["ml.g5.2xlarge", "ml.g5.4xlarge"]
      },
      "70b": {
        "displayName": "Llama 3 70B",
        "envVars": {
          "MAX_MODEL_LEN": "8192",
          "GPU_MEMORY_UTILIZATION": "0.95",
          "TENSOR_PARALLEL_SIZE": "4"
        },
        "recommendedInstanceTypes": ["ml.g5.48xlarge", "ml.p4d.24xlarge"]
      }
    },
    "notes": "Llama 3 uses a new chat template format with special tokens"
  }
}
```
{% endraw %}

### Pattern Matching

The Model Registry supports pattern matching for model families:

- `meta-llama/Llama-2-*` - Matches all Llama 2 variants
- `mistralai/Mistral-*` - Matches all Mistral models
- `google/gemma-*` - Matches all Gemma models

Exact matches take precedence over pattern matches.

## Instance Accelerator Mapping

### Schema

The Instance Accelerator Mapping stores hardware specifications for AWS instance types.

**Location:** `servers/instance-recommender/catalogs/instances.json`

**Schema:** `servers/lib/schemas/instance-accelerator-mapping-schema.json`

### Structure

```javascript
{
  "instance_type": {
    "family": "string",                   // Instance family (e.g., "g5")
    "accelerator": {
      "type": "cuda" | "neuron" | "cpu" | "rocm",
      "hardware": "string",               // Hardware description
      "architecture": "string",           // Architecture name
      "versions": ["string"] | null,      // Available versions
      "default": "string | null"          // Default version
    },
    "memory": "string",                   // Memory size
    "vcpus": number,                      // Number of vCPUs
    "notes": "string"
  }
}
```

### Required Fields

- `family` - Instance family
- `accelerator.type` - Accelerator type
- `accelerator.hardware` - Hardware description
- `accelerator.architecture` - Architecture name
- `accelerator.versions` - Available versions (null for CPU)
- `accelerator.default` - Default version (null for CPU)
- `memory` - Memory size
- `vcpus` - Number of vCPUs

### Example: Adding ml.g6 Instances

```javascript
{
  "ml.g6.xlarge": {
    "family": "g6",
    "accelerator": {
      "type": "cuda",
      "hardware": "NVIDIA L4",
      "architecture": "Ada Lovelace",
      "versions": ["12.1", "12.2"],
      "default": "12.2"
    },
    "memory": "16 GB",
    "vcpus": 4,
    "notes": "Cost-effective GPU instance with NVIDIA L4"
  },
  "ml.g6.2xlarge": {
    "family": "g6",
    "accelerator": {
      "type": "cuda",
      "hardware": "NVIDIA L4",
      "architecture": "Ada Lovelace",
      "versions": ["12.1", "12.2"],
      "default": "12.2"
    },
    "memory": "32 GB",
    "vcpus": 8,
    "notes": "Cost-effective GPU instance with NVIDIA L4"
  }
}
```

## Validation Levels

Validation levels indicate how well-tested a configuration is:

### Tested
- **Criteria**: Successfully deployed and validated on AWS SageMaker
- **Requirements**:
  - Passes all automated tests (syntax, schema validation)
  - Passes Docker build tests
  - Has successful AWS deployment reports from community members
  - Maintainer approval required
- **Display**: ✅ Tested configuration

### Community-Validated
- **Criteria**: Successfully built and tested by community members
- **Requirements**:
  - Passes all automated tests
  - Passes Docker build tests
  - Community member reports successful local testing
- **Display**: ✓ Community-validated configuration

### Experimental
- **Criteria**: Passes automated tests but not yet validated
- **Requirements**:
  - Passes syntax tests
  - Passes schema validation
  - No deployment validation yet
- **Display**: ⚠ Experimental configuration

### Unknown
- **Criteria**: No validation data available
- **Requirements**: None
- **Display**: ℹ Unknown validation status

## Contributing Process

### 1. Test Your Configuration

Before contributing, test your configuration:

```bash
# Generate project with your configuration
ml-container-creator test-project \
  --framework=your-framework \
  --version=your-version \
  --skip-prompts

# Build Docker image
cd test-project
docker build -t test-image .

# Test locally
docker run -p 8080:8080 test-image

# Deploy to SageMaker (optional but recommended)
./deploy/deploy.sh your-sagemaker-role-arn
```

### 2. Export Your Configuration

After successful deployment, export your configuration:

```bash
# The generator will offer to export after successful deployment
# Or manually create the configuration following the schema
```

### 3. Create Pull Request

1. Fork the repository
2. Add your configuration to the appropriate registry file
3. Ensure your configuration passes schema validation
4. Include test results in your PR description
5. Submit pull request

### 4. PR Requirements

Your pull request must include:

- **Configuration entry** in the appropriate registry file
- **Validation level** (start with "experimental")
- **Test results** showing successful generation and build
- **Instance type** tested on (if applicable)
- **Notes** about any special requirements or known issues

### 5. Review Process

1. Automated tests run on your PR
2. Maintainers review your configuration
3. If tests pass and configuration is valid, PR is merged
4. Validation level may be upgraded based on testing evidence

## Testing Your Contribution

### Automated Tests

All contributions must pass automated tests:

```bash
# Run all tests
npm test

# Run registry validation tests
npm test -- --grep "registry"

# Run schema validation tests
npm test -- --grep "schema"
```

### Manual Testing

Test your configuration manually:

```bash
# 1. Link your local version
npm link

# 2. Generate project with your configuration
ml-container-creator test-project \
  --framework=your-framework \
  --version=your-version \
  --skip-prompts

# 3. Verify generated files
cd test-project
cat Dockerfile  # Check environment variables
cat deploy/deploy.sh  # Check AMI version

# 4. Build Docker image
docker build -t test-image .

# 5. Test locally
docker run -p 8080:8080 test-image
curl http://localhost:8080/ping  # Should return 200

# 6. Deploy to SageMaker (optional)
./deploy/deploy.sh your-sagemaker-role-arn
```

### Test Report Format

When submitting test results, include:

```json
{
  "framework": "vllm",
  "version": "0.5.0",
  "instanceType": "ml.g5.2xlarge",
  "region": "us-east-1",
  "deploymentSuccess": true,
  "inferenceSuccess": true,
  "testDate": "2024-01-15",
  "tester": "github-username",
  "notes": "Tested with Llama 2 7B model, average latency 45ms"
}
```

## Examples

### Example 1: Adding a New Framework Version

```javascript
// servers/base-image-picker/catalogs/model-servers.json
{
  "sglang": {
    "0.3.0": {
      "baseImage": "lmsysorg/sglang:v0.3.0",
      "accelerator": {
        "type": "cuda",
        "version": "12.1",
        "versionRange": {
          "min": "12.0",
          "max": "12.2"
        }
      },
      "envVars": {
        "SGLANG_MAX_BATCH_SIZE": "256",
        "SGLANG_GPU_MEMORY_UTILIZATION": "0.9"
      },
      "inferenceAmiVersion": "al2-ami-sagemaker-inference-gpu-3-1",
      "recommendedInstanceTypes": ["ml.g5.xlarge", "ml.g5.2xlarge"],
      "validationLevel": "experimental",
      "notes": "SGLang 0.3.0 adds support for structured generation"
    }
  }
}
```

### Example 2: Adding Model-Specific Overrides

{% raw %}
```javascript
// servers/model-picker/catalogs/popular-transformers.json
{
  "mistralai/Mixtral-8x7B-*": {
    "family": "mixtral",
    "chatTemplate": "{{ bos_token }}{% for message in messages %}{% if message['role'] == 'user' %}{{ '[INST] ' + message['content'] + ' [/INST]' }}{% elif message['role'] == 'assistant' %}{{ message['content'] + eos_token }}{% endif %}{% endfor %}",
    "requiresTemplate": true,
    "validationLevel": "community-validated",
    "frameworkCompatibility": {
      "vllm": ">=0.3.0",
      "tensorrt-llm": ">=0.8.0"
    },
    "profiles": {
      "default": {
        "displayName": "Mixtral 8x7B",
        "envVars": {
          "MAX_MODEL_LEN": "32768",
          "GPU_MEMORY_UTILIZATION": "0.95",
          "TENSOR_PARALLEL_SIZE": "2"
        },
        "recommendedInstanceTypes": ["ml.g5.12xlarge", "ml.g5.24xlarge"]
      }
    },
    "notes": "Mixtral is a sparse mixture-of-experts model requiring tensor parallelism"
  }
}
```
{% endraw %}

### Example 3: Adding New Instance Types

```javascript
// servers/instance-recommender/catalogs/instances.json
{
  "ml.inf2.xlarge": {
    "family": "inf2",
    "accelerator": {
      "type": "neuron",
      "hardware": "AWS Inferentia2",
      "architecture": "Inferentia2",
      "versions": ["2.15.0", "2.16.0", "2.17.0"],
      "default": "2.17.0"
    },
    "memory": "16 GB",
    "vcpus": 4,
    "notes": "Cost-effective inference with AWS Inferentia2"
  }
}
```

## Best Practices

### 1. Start with Experimental
Always start with `validationLevel: "experimental"` and let the community upgrade it through testing.

### 2. Provide Clear Notes
Include helpful notes about:
- Special requirements
- Known issues
- Performance characteristics
- Recommended use cases

### 3. Test Thoroughly
Test your configuration on multiple instance types if possible.

### 4. Document Profiles
If adding profiles, clearly document:
- What each profile optimizes for
- When to use each profile
- Performance trade-offs

### 5. Follow Naming Conventions
- Framework names: lowercase (e.g., "vllm", "tensorrt-llm")
- Versions: semantic versioning (e.g., "0.5.0")
- Profile names: kebab-case (e.g., "low-latency", "high-throughput")

## Getting Help

- **Questions**: Open a [GitHub Discussion](https://github.com/awslabs/ml-container-creator/discussions)
- **Issues**: Report bugs via [GitHub Issues](https://github.com/awslabs/ml-container-creator/issues)
- **Examples**: See existing registry entries for reference

## Related Documentation

- [Architecture Guide](./architecture.md) - System architecture overview
- [Testing Guide](./testing.md) - Testing requirements and procedures
- [Contributing Guide](./CONTRIBUTING.md) - General contribution guidelines
