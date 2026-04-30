# Registries and Catalogs

The generator's registry system is built on top of the MCP server catalogs. `RegistryLoader` (in `generators/app/lib/`) reads catalog JSON files at startup and produces three internal registries.

## Registry Overview

| Registry | Source Catalog | Internal Shape |
|----------|---------------|----------------|
| Framework Registry | `model-servers.json` | `{ frameworkName: { version: { baseImage, accelerator, envVars, ... } } }` |
| Model Registry | `popular-transformers.json` + `popular-diffusors.json` | `{ modelIdOrPattern: { family, chatTemplate, frameworkCompatibility, ... } }` |
| Instance Accelerator Mapping | `instances.json` | `{ instanceType: { family, accelerator: { type, hardware, versions }, memory, vcpus } }` |

## Consumers

These registries are consumed by several modules:

| Module | What It Uses |
|--------|-------------|
| `ConfigurationManager` | Matches user selections to framework/model configs, merges env vars with five-layer precedence |
| `PromptRunner` | Populates instance type choices, framework version choices |
| `ValidationEngine` | Checks accelerator compatibility between framework requirements and instance capabilities |
| `CommentGenerator` | Generates Dockerfile comments from registry metadata |

## Source of Truth

The source catalogs live in `servers/*/catalogs/`. The legacy `generators/app/config/registries/` and `generators/app/config/schemas/` directories are empty and no longer used.

| Catalog File | Location |
|-------------|----------|
| `model-servers.json` | `servers/base-image-picker/catalogs/` |
| `triton-backends.json` | `servers/base-image-picker/catalogs/` |
| `instances.json` | `servers/instance-recommender/catalogs/` |
| `popular-transformers.json` | `servers/model-picker/catalogs/` |
| `popular-diffusors.json` | `servers/model-picker/catalogs/` |
| `regions.json` | `servers/region-picker/catalogs/` |

Each catalog has a corresponding JSON schema in `servers/lib/schemas/` that defines the required fields and value constraints.

## Contributing Data

To add or update registry data, edit the source catalog and validate:

```bash
# Edit the catalog file directly
# Then validate against the schema
node scripts/validate-catalogs.js
```

For detailed instructions on adding instance types, base images, or model entries, see [MCP Server Development -- Adding a Catalog Entry](mcp-server-development.md#adding-a-catalog-entry).

## How RegistryLoader Transforms Catalogs

`RegistryLoader` is the adapter layer between the raw catalog JSON and the generator's internal data model. It performs these transformations:

**Framework Registry** (`loadFrameworkRegistry`): Reads `model-servers.json`, which stores image entries as arrays keyed by framework name. Each entry with a `labels.framework_version` field becomes a version entry in the registry. Fields like `image`, `accelerator`, `defaults.envVars`, `defaults.inferenceAmiVersion`, `defaults.recommendedInstanceTypes`, `validationLevel`, and `profiles` are mapped to the internal `FrameworkConfig` shape.

**Model Registry** (`loadModelRegistry`): Reads `popular-transformers.json` and `popular-diffusors.json`, merges them, and maps snake_case catalog keys to camelCase (`chat_template` to `chatTemplate`, `framework_compatibility` to `frameworkCompatibility`, `validation_level` to `validationLevel`). Pattern keys like `meta-llama/Llama-2-*` are preserved for glob matching.

**Instance Accelerator Mapping** (`loadInstanceAcceleratorMapping`): Reads `instances.json` and maps flat catalog fields (`acceleratorType`, `hardware`, `gpuArchitecture`, `cudaVersions`, `defaultCudaVersion`) into the nested `accelerator` object shape expected by `ValidationEngine`.
