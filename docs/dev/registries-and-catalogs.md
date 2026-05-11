# Registries and Catalogs

The generator's registry system is built on top of the MCP server catalogs. `RegistryLoader` (in `generators/app/lib/`) reads catalog JSON files at startup and produces three internal registries.

## Registry Overview

| Registry | Source Catalog | Internal Shape |
|----------|---------------|----------------|
| Framework Registry | `model-servers.json` | `{ frameworkName: { version: { baseImage, accelerator, envVars, ... } } }` |
| Model Registry | `models.json` | `{ modelIdOrPattern: { family, chatTemplate, frameworkCompatibility, architecture, tasks, modelType, ... } }` |
| Instance Accelerator Mapping | `instances.json` | `{ instanceType: { family, accelerator: { type, hardware, versions }, memory, vcpus } }` |

## Consumers

These registries are consumed by several modules:

| Module | What It Uses |
|--------|-------------|
| `ConfigurationManager` | Matches user selections to framework/model configs, merges env vars with five-layer precedence |
| `PromptRunner` | Populates instance type choices, framework version choices |
| `ValidationEngine` | Checks accelerator compatibility between framework requirements and instance capabilities |
| `SchemaValidationEngine` | Validates generated API payloads against AWS service models |
| `CrossCuttingChecker` | Validates consistency across payloads using instance catalog data |
| `CommentGenerator` | Generates Dockerfile comments from registry metadata |

## Source of Truth

All catalogs live in the centralized shared directory `servers/lib/catalogs/`. Individual server directories no longer maintain their own `catalogs/` subdirectories.

| Catalog File | Location | Purpose |
|-------------|----------|---------|
| `model-servers.json` | `servers/lib/catalogs/` | Base images, framework versions, AMI versions |
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

**Framework Registry** (`loadFrameworkRegistry`): Reads `model-servers.json`, which stores image entries as arrays keyed by framework name. Each entry with a `labels.framework_version` field becomes a version entry in the registry. Fields like `image`, `accelerator`, `defaults.envVars`, `defaults.inferenceAmiVersion`, `validationLevel`, and `profiles` are mapped to the internal `FrameworkConfig` shape.

**Model Registry** (`loadModelRegistry`): Reads `models.json` (the unified model catalog) and maps entries to the internal model registry shape. Each entry includes `architecture`, `tasks`, `modelType`, `family`, `chatTemplate`, `frameworkCompatibility`, `validationLevel`, and `profiles`. Pattern keys like `meta-llama/Llama-2-*` are preserved for glob matching.

**Instance Accelerator Mapping** (`loadInstanceAcceleratorMapping`): Reads `instances.json` and maps flat catalog fields (`acceleratorType`, `hardware`, `gpuArchitecture`, `cudaVersions`, `defaultCudaVersion`) into the nested `accelerator` object shape expected by `ValidationEngine`.
