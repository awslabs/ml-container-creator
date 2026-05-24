# MCP Server Development

MCP servers live in `servers/`. Each is a self-contained Node.js package that speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio. The generator spawns them as child processes during configuration loading.

For user-facing MCP documentation (adding/removing servers, smart mode, writing custom servers), see [MCP Servers](../mcp-configuration.md).

## Directory Layout

Each bundled server follows this structure:

```
servers/<server-name>/
├── index.js          # MCP server entry point
├── test.js           # Standalone tests (node test.js)
├── package.json      # Dependencies (@modelcontextprotocol/sdk, zod)
├── manifest.json     # Server metadata (name, description, tool name)
├── catalogs/         # Static JSON data files
│   └── *.json
└── LICENSE
```

Five servers ship with the project:

| Server | Catalogs | Purpose |
|--------|----------|---------|
| `instance-recommender` | `instances.json` | Suggests SageMaker AI instance types based on framework |
| `region-picker` | `regions.json` | Filters AWS regions by search term |
| `base-image-picker` | `model-servers.json`, `triton-backends.json`, `triton.json`, `python-slim.json` | Selects base Docker images per framework |
| `model-picker` | `popular-transformers.json`, `popular-diffusors.json` | Resolves HuggingFace model metadata |
| `hyperpod-cluster-picker` | (none -- queries AWS APIs) | Discovers existing HyperPod EKS clusters |

## Catalogs and Schemas

Catalogs are the single source of truth for configuration data. They live in `servers/*/catalogs/` and are validated by JSON schemas in `servers/lib/schemas/`.

| Catalog | Schema | Contents |
|---------|--------|----------|
| `base-image-picker/catalogs/model-servers.json` | `image-catalog.schema.json` | Framework base images, env vars, profiles, accelerator requirements |
| `base-image-picker/catalogs/triton-backends.json` | `triton-backends.schema.json` | Triton backend metadata (supported model formats, sample model support) |
| `instance-recommender/catalogs/instances.json` | `instances.schema.json` | SageMaker AI instance types, vCPUs, memory, GPU specs |
| `model-picker/catalogs/popular-transformers.json` | `model-catalog.schema.json` | Popular transformer models, chat templates, framework compatibility |
| `model-picker/catalogs/popular-diffusors.json` | `model-catalog.schema.json` | Popular diffusion models |
| `region-picker/catalogs/regions.json` | `regions.schema.json` | AWS regions with SageMaker AI availability |

`RegistryLoader` (in `generators/app/lib/`) reads these catalogs at generator startup and transforms them into the internal shapes used by `ConfigurationManager`, `PromptRunner`, and `ValidationEngine`. This is the adapter layer between catalog JSON and the generator's internal data model.

## Adding a Catalog Entry

### New instance type

Edit `servers/instance-recommender/catalogs/instances.json`:

```json
{
  "catalog": {
    "ml.g6e.xlarge": {
      "family": "g6e",
      "vcpus": 4,
      "memGb": 32,
      "gpuCount": 1,
      "hardware": "NVIDIA L40S",
      "gpuArchitecture": "Ada Lovelace",
      "acceleratorType": "cuda",
      "cudaVersions": ["12.2", "12.4"],
      "defaultCudaVersion": "12.4",
      "category": "gpu",
      "tags": ["gpu", "inference"],
      "notes": "L40S GPU, good for medium LLMs"
    }
  }
}
```

### New base image version

Edit `servers/base-image-picker/catalogs/model-servers.json`. Each framework key maps to an array of image entries:

```json
{
  "vllm": [
    {
      "image": "vllm/vllm-openai:v0.11.0",
      "labels": { "framework_version": "0.11.0" },
      "accelerator": { "type": "cuda", "version": "12.1" },
      "defaults": {
        "envVars": { "VLLM_GPU_MEMORY_UTILIZATION": "0.9" },
        "inferenceAmiVersion": "al2-ami-sagemaker-inference-gpu-3-1",
        "recommendedInstanceTypes": ["ml.g5.xlarge"]
      },
      "validationLevel": "experimental"
    }
  ]
}
```

### Validation

After editing any catalog, validate it against the schema:

```bash
node scripts/validate-catalogs.js
```

The `catalog-schema-validation` property test also validates all catalog entries automatically during `npm run test:property`.

## Creating a New Bundled Server

1. Create `servers/<name>/` with `index.js`, `package.json`, `manifest.json`, `test.js`, and `LICENSE`.
2. Implement the `get_ml_config` tool using `@modelcontextprotocol/sdk`. The tool receives `{ parameters, limit, context }` and returns `{ values, choices }`.
3. Add a catalog directory if the server needs static data. Add a JSON schema in `servers/lib/schemas/`.
4. Add the server to the `mcp list --bundled` output in `mcp-command-handler.js`.
5. If `RegistryLoader` needs to consume the catalog, add a load method and a catalog path constant.
6. Run `node servers/<name>/test.js` and add the server to `npm run test:servers`.

### Tool Interface

The tool receives:

```json
{
  "parameters": ["instanceType", "awsRoleArn", "awsRegion"],
  "limit": 10,
  "context": {
    "framework": "sklearn",
    "modelServer": "flask"
  }
}
```

The tool returns (as a text content block containing JSON):

```json
{
  "values": {
    "instanceType": "ml.m5.xlarge"
  },
  "choices": {
    "instanceType": ["ml.m5.xlarge", "ml.m5.2xlarge", "ml.g4dn.xlarge"]
  }
}
```

Both `values` and `choices` are optional. A server may return only values, only choices, or both.

### Minimal Server Example

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'my-config-server', version: '1.0.0' })

server.tool(
    'get_ml_config',
    'Returns ML configuration values',
    {
        parameters: z.array(z.string()),
        limit: z.number().int().positive().default(10),
        context: z.record(z.string(), z.any()).optional()
    },
    async ({ parameters, limit, context }) => {
        const values = {}
        const choices = {}

        // Your logic here

        return {
            content: [{ type: 'text', text: JSON.stringify({ values, choices }) }]
        }
    }
)

const transport = new StdioServerTransport()
await server.connect(transport)
```

### License Compliance

All bundled servers and their dependencies must use only approved licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD. Run the compliance scripts before committing:

```bash
npm run _sbom
npm run _licenses:review
```
