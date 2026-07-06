# Registries and Catalogs

The generator's registry system is built on top of the MCP server catalogs. `RegistryLoader` (in `src/lib/`) reads catalog JSON files at startup and produces three internal registries.

## Registry Overview

| Registry | Source Catalog | Internal Shape |
|----------|---------------|----------------|
| Framework Registry | `model-servers.json` | `{ backendName: { version: { baseImage, accelerator, envVars, ... } } }` |
| Model Registry | `models.json` | `{ modelIdOrPattern: { family, chatTemplate, frameworkCompatibility, architecture, tasks, modelType, ... } }` |
| Instance Accelerator Mapping | `instances.json` | `{ instanceType: { family, accelerator: { type, hardware, versions }, memory, vcpus } }` |

## Consumers

These registries are consumed by several modules:

| Module | What It Uses |
|--------|-------------|
| `ConfigurationManager` | Matches user selections to deployment-config/model configs, merges env vars with five-layer precedence |
| `PromptRunner` | Populates instance type choices, backend version choices |
| `ValidationEngine` | Checks accelerator compatibility between backend requirements and instance capabilities |
| `SchemaValidationEngine` | Validates generated API payloads against AWS service models |
| `CrossCuttingChecker` | Validates consistency across payloads using instance catalog data |
| `CommentGenerator` | Generates Dockerfile comments from registry metadata |

## Source of Truth

All catalogs live in the centralized shared directory `servers/lib/catalogs/`. Individual server directories no longer maintain their own `catalogs/` subdirectories.

| Catalog File | Location | Purpose |
|-------------|----------|---------|
| `model-servers.json` | `servers/lib/catalogs/` | Base images, backend versions, AMI versions |
| `models.json` | `servers/lib/catalogs/` | Unified model catalog (merged from transformers + diffusors + model-sizes) |
| `instances.json` | `servers/lib/catalogs/` | Instance types, GPU counts, CUDA versions |
| `jumpstart-public.json` | `servers/lib/catalogs/` | JumpStart public model metadata |
| `python-slim.json` | `servers/lib/catalogs/` | Python slim base images |
| `triton.json` | `servers/lib/catalogs/` | Triton base images |
| `triton-backends.json` | `servers/lib/catalogs/` | Triton backend configurations |
| `regions.json` | `servers/lib/catalogs/` | AWS region availability |

Each catalog has a corresponding JSON schema in `servers/lib/schemas/` that defines the required fields and value constraints.

## Unified Model Catalog

The `models.json` catalog merges data from three former sources into a single file keyed by model identifier:

| Former Source | Fields Contributed |
|---|---|
| `model-sizes.json` | `parameterCount`, `defaultDtype`, `maxPositionEmbeddings`, `recommendedQuantizations` |
| `popular-transformers.json` | `family`, `chatTemplate`, `gated`, `tags`, `frameworkCompatibility` |
| `popular-diffusors.json` | `family`, `pipeline`, `gated`, `tags`, `frameworkCompatibility` |

Every entry has three mandatory fields:

- `architecture` — HuggingFace `architectures[0]` value (e.g., `LlamaForCausalLM`)
- `tasks` — inference tasks the model performs (e.g., `["text-generation"]`)
- `modelType` — one of `transformer`, `diffusor`, or `predictor`

The `modelType` field drives architecture-level routing: which deployment config to suggest, which base image to use, and whether GPU instances are needed.

## Schema-Driven Validation

The schema-driven validation system validates generated AWS API payloads against actual AWS service model files (`service-2.json`). It catches enum violations, type mismatches, missing required fields, and cross-cutting consistency issues before deployment.

The validation system uses the instance catalog (`instances.json`) for cross-cutting checks like GPU count consistency, CUDA compatibility, and model type / instance alignment. See the [Schema Validation section in Configuration](../configuration.md#schema-driven-validation) for user-facing documentation.

## Architecture Compatibility (`supportedModelTypes`)

Each entry in `model-servers.json` can include a `supportedModelTypes` array field that lists the lowercase `model_type` strings (from HuggingFace `config.json`) that the server version supports.

### What It Contains

An array of lowercase model type identifiers. These correspond to the `model_type` field in a HuggingFace model's `config.json` (e.g., `llama`, `qwen2`, `mistral`, `gpt2`).

```json
{
    "vllm": [
        {
            "image": "vllm/vllm-openai:v0.6.3",
            "labels": { "framework_version": "0.6.3" },
            "supportedModelTypes": ["llama", "qwen2", "mistral", "gemma", "phi3", "..."]
        }
    ]
}
```

### How It's Populated

The `registry sync-architectures` command fetches model registry source files from each server's GitHub repository at the tagged version, parses them to extract supported model types, and writes the result into the catalog entry.

The parsing logic lives in `src/lib/architecture-sync.js` and handles server-specific formats:

| Server | Source File | Parser |
|--------|------------|--------|
| vLLM | `vllm/model_executor/models/registry.py` | `parseVllmRegistry` |
| SGLang | `python/sglang/srt/models/model_registry.py` | `parseSglangRegistry` |
| TensorRT-LLM | `tensorrt_llm/models/__init__.py` | `parseTensorRTRegistry` |

### How It's Used

The `CrossCuttingChecker.checkModelArchitectureCompatibility()` method (in `src/lib/cross-cutting-checker.js`) uses `supportedModelTypes` to validate that the user's model is compatible with their selected server version. This check runs:

- At generation time (advisory warning, does not block)
- During `do/validate` (reported as a medium-confidence warning)
- Via `registry check <model-id>` (pre-generation compatibility check)

### When Absent or Empty

The `supportedModelTypes` field is optional. When it's absent or an empty array, architecture compatibility validation is skipped gracefully — no warning is emitted and generation proceeds normally. This happens when:

- `registry sync-architectures` has not been run
- The server entry doesn't have a matching source configuration
- The fetch for a specific version failed (network error, tag not found)

## Contributing Data

To add or update registry data, edit the source catalog in `servers/lib/catalogs/` and validate:

```bash
# Edit the catalog file directly
# Then validate against the schema
node scripts/validate-catalogs.js

# Validate catalog enum values against AWS service models (requires schema sync)
npm run validate:catalogs
```

For detailed instructions on adding instance types, base images, or model entries, see [MCP Server Development -- Adding a Catalog Entry](mcp-server-development.md#adding-a-catalog-entry).

## How RegistryLoader Transforms Catalogs

`RegistryLoader` is the adapter layer between the raw catalog JSON and the generator's internal data model. It performs these transformations:

**Framework Registry** (`loadFrameworkRegistry`): Reads `model-servers.json`, which stores image entries as arrays keyed by backend name (e.g. `vllm`, `sglang`, `triton-vllm`). Each entry with a `labels.framework_version` field becomes a version entry in the registry. Fields like `image`, `accelerator`, `defaults.envVars`, `defaults.inferenceAmiVersion`, `validationLevel`, and `profiles` are mapped to the internal `FrameworkConfig` shape.

**Model Registry** (`loadModelRegistry`): Reads `popular-transformers.json` and `popular-diffusors.json` and merges them into a single registry. Each entry includes `family`, `chatTemplate`, `requiresTemplate`, `validationLevel`, `frameworkCompatibility`, `profiles`, and `notes`. Pattern keys like `meta-llama/Llama-2-*` are preserved for glob matching.

**Instance Accelerator Mapping** (`loadInstanceAcceleratorMapping`): Reads `instances.json` and maps flat catalog fields (`acceleratorType`, `hardware`, `gpuArchitecture`, `cudaVersions`, `defaultCudaVersion`) into the nested `accelerator` object shape expected by `ValidationEngine`.

## Adding a New Instance Family

When AWS launches new GPU instance types (e.g., g6, g6e, p5), follow this procedure to add them to ml-container-creator.

### Prerequisites — Research First

Before editing any catalog, gather:

1. **Instance specs** for every size in the family: GPU count, GPU memory, vCPUs, system RAM
2. **GPU type and architecture**: e.g., NVIDIA L40S, Ada Lovelace (SM 8.9)
3. **CUDA driver version** on the SageMaker fleet (check `inference-gpu-drivers.html` in AWS docs, then verify empirically — docs can lag)
4. **Supported CUDA toolkit versions** (driver version → max CUDA from NVIDIA compat matrix)
5. **Compute capability** (determines FP8, Flash Attention, etc. support)
6. **vLLM/SGLang minimum version** that supports the GPU architecture
7. **Max model sizes** at BF16 and FP8 for single-GPU and multi-GPU configurations

### Step 1: `servers/lib/catalogs/fleet-drivers.json`

Add an entry mapping the instance family (without `ml.` prefix) to its driver info:

```json
"g6e": {
    "driver": "560.35",
    "cuda_native": "12.6",
    "gpu": "L40S",
    "gpu_memory_gb": 48
}
```

This is used by `image-filter.js` to determine which container images are CUDA-driver-compatible with the instance.

### Step 2: `servers/lib/catalogs/instances.json`

Add one entry per instance size under the `catalog` key:

```json
"ml.g6e.xlarge": {
    "category": "gpu",
    "gpus": 1,
    "vcpus": 4,
    "memGb": 32,
    "accelerator": "L40S 48GB",
    "cudaVersions": ["12.2", "12.4", "12.6"],
    "tags": ["gpu", "single-gpu", "inference", "l40s", "ada-lovelace", "fp8", "cuda-12"],
    "family": "g6e",
    "acceleratorType": "cuda",
    "hardware": "NVIDIA L40S",
    "gpuArchitecture": "Ada Lovelace",
    "defaultCudaVersion": "12.6",
    "notes": "1x NVIDIA L40S GPU (48GB). Fits 14B BF16 or 32B FP8",
    "gpuMemoryGb": 48,
    "gpuType": "NVIDIA L40S",
    "costTier": "medium"
}
```

**Required fields:** `category`, `gpus`, `vcpus`, `memGb`, `accelerator`, `cudaVersions`, `tags`, `family`, `acceleratorType`, `hardware`, `gpuArchitecture`, `defaultCudaVersion`, `notes`, `gpuMemoryGb`, `gpuType`, `costTier`

**Tags guidance:**

- Always include: `"gpu"`, `"inference"`, the GPU short name (e.g., `"l40s"`)
- Include `"single-gpu"` or `"multi-gpu"` based on GPU count
- Include `"fp8"` if compute capability ≥ 8.9
- Include architecture name (e.g., `"ada-lovelace"`, `"hopper"`)
- Include CUDA generation (e.g., `"cuda-12"`)

**costTier values:** `"low"` (cheapest, e.g., L4), `"medium"` (mid-range, e.g., A10G/L40S single), `"high"` (expensive, e.g., multi-GPU or A100/H100)

Also add ALL new instances to `recommendations.gpu` array.

### Step 3: `servers/lib/catalogs/model-sizes.json`

Update `recommendedInstances` arrays for models where the new instances are a good fit:

| Model Size | Recommendation Pattern |
|-----------|----------------------|
| ≤8B | Single-GPU smallest (xlarge) |
| 14B | Single L40S (48GB) for BF16, or multi-GPU A10G with FP8 |
| 32B | 4× L40S or 4× A10G with FP8 |
| 70B | 4× L40S (192GB) for BF16 |
| 120B+ | 8× L40S (384GB) with FP8 |

### Step 4: Validate

```bash
# Schema validation
node scripts/validate-catalogs.js

# Sync to docs/data/ (for the command generator widget)
node scripts/sync-command-generator.js

# Run property tests
npm test -- --grep "catalog"
```

### What Does NOT Need Changes

These files are instance-family-agnostic and need no updates:

- **`model-servers.json`** — image entries specify CUDA version requirements, not instance families. The `image-filter.js` handles instance↔image compatibility at runtime via `fleet-drivers.json`.
- **`popular-transformers.json` / `popular-diffusors.json`** — model-centric catalogs, no instance references.
- **`image-filter.js`** — uses generic regex `^ml\.([a-z0-9]+)\.` to parse family, then looks up `fleet-drivers.json`. Works for any family automatically.
- **`scripts/validate-catalogs.js`** — schema accepts any `ml.*` key with the correct shape.
- **`scripts/sync-model-families.js`** — model discovery, not instance-related.
- **`scripts/sync-serving-versions.js`** — image version management, not instance-related.

## Adding a New Model to the Catalog

To add a model to `model-sizes.json`:

1. Look up the model on HuggingFace — get `config.json` for `architectures[0]`, parameter count, `max_position_embeddings`
2. Add entry with glob pattern key (e.g., `"meta-llama/Llama-4-8B*"`)
3. Set `recommendedInstances` based on the sizing formula: `params × 2 (BF16) × 1.2 (overhead) ≤ GPU memory`
4. Run `node scripts/merge-model-catalogs.mjs` to regenerate `models.json`
5. Validate with `node scripts/validate-catalogs.js`

## Adding a New Base Image Version

When a new vLLM/SGLang/TRT-LLM version is released:

1. Run `node scripts/sync-serving-versions.js` — auto-fetches latest tags from DockerHub/NGC
2. Review the diff — it keeps top 3 versions per server, prunes old ones
3. Verify `supportedModelTypes` is populated (run `registry sync-architectures` if needed)
4. Check CUDA version compatibility with fleet drivers: new vLLM versions may require newer CUDA (e.g., v0.23.0 needs CUDA 12.9 / driver ≥580 for multi-GPU)

## Adding a New AWS Region

Edit `servers/lib/catalogs/regions.json` and add the region code with its available instance families. No script needed — it's a static mapping.
