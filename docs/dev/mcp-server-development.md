# MCP Server Development

MCP servers provide intelligent defaults during project generation. Each server is a self-contained Node.js package that speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio. The generator spawns them as child processes, sends a tool call with the current configuration context, and receives recommended values and choices.

For user-facing documentation (adding/removing servers, smart mode, configuring servers), see [MCP Servers](../mcp-configuration.md).

---

## Architecture

```
┌──────────────────────────────────────────┐
│  ml-container-creator (generator)        │
│                                          │
│  ConfigManager                           │
│    └─ ConfigMcpClient                    │
│         └─ McpClient (per server)        │
│              ├─ StdioClientTransport      │
│              │   (spawns child process)   │
│              └─ Client.callTool()         │
│                   ↕ stdio JSON-RPC        │
│  ┌────────────────────────────────────┐  │
│  │  MCP Server (child process)        │  │
│  │  StdioServerTransport              │  │
│  │  └─ McpServer.tool() handler       │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

**Flow:**

1. Generator reads `config/mcp.json` to discover configured servers
2. During prompting, `McpQueryRunner` triggers on-demand queries (e.g., after user types a region search term)
3. `McpClient` spawns the server process via `StdioClientTransport`
4. MCP handshake (`initialize` → `initialized`)
5. Generator calls the server's tool with `{ parameters, limit, context }`
6. Server returns `{ values, choices }` as a JSON text content block
7. Generator injects values/choices into prompt selections and config

**Timeout:** Each query has a 15-second timeout covering the entire lifecycle (spawn + handshake + tool call). If the server doesn't respond, the generator falls back gracefully.

---

## Bundled Servers

Eleven servers ship with the project:

| Server | Tool Name | Modes | Purpose |
|--------|-----------|-------|---------|
| `instance-sizer` | `get_instance_recommendation` | static, smart, discover | Estimates VRAM, recommends instance types |
| `region-picker` | `get_regions` | static, smart | Filters AWS regions by search term |
| `base-image-picker` | `get_ml_config` | static, smart | Selects base Docker images per framework |
| `model-picker` | `get_ml_config` | static, smart, discover | Resolves HuggingFace model metadata |
| `hyperpod-cluster-picker` | `get_ml_config` | discover | Discovers existing HyperPod EKS clusters |
| `endpoint-picker` | `get_inference_endpoints` | discover | Discovers InService SageMaker AI endpoints |
| `marketplace-picker` | `get_ml_config` | static, discover | Lists SageMaker AI Marketplace models |
| `e2e-status` | `get_ml_config` | static | Returns E2E validation status for models |
| `workload-picker` | `list_workloads`, `get_workload_profile` | static | Provides named benchmark workload profiles for `do/benchmark` |
| `model-registry` | `list_model_packages`, `get_model_version` | discover | Queries SageMaker Model Package Groups |
| `agent-knowledge` | `query_knowledge` | static | Script reference, config docs, troubleshooting, capability matrix |

**Modes:**

- **Static** — Filters local catalog data (no network calls, fast)
- **Smart** — Queries Amazon Bedrock for context-aware recommendations (set `BEDROCK_SMART=true`)
- **Discover** — Queries live AWS APIs (e.g., HuggingFace Hub, SageMaker AI ListEndpoints)

---

## Directory Layout

Each server follows this structure:

```
servers/<server-name>/
├── index.js          # MCP server entry point
├── test.js           # Standalone tests (node test.js)
├── package.json      # Dependencies (@modelcontextprotocol/sdk, zod)
├── manifest.json     # Server metadata (name, modes, tool name, catalogs)
├── lib/              # Optional: internal modules (resolvers, rankers, etc.)
├── catalogs/         # Optional: server-specific catalog files
└── LICENSE
```

Shared resources live in `servers/lib/`:

```
servers/lib/
├── bedrock-client.js       # Shared Bedrock invocation + JSON extraction
├── custom-validators.js    # Shared validation utilities
├── dynamic-resolver.js     # Shared HuggingFace Hub / AWS API queries
├── catalogs/               # Shared catalogs (instances, regions, models, images)
│   ├── instances.json
│   ├── regions.json
│   ├── model-servers.json
│   ├── model-sizes.json
│   ├── models.json
│   ├── popular-transformers.json
│   ├── popular-diffusors.json
│   ├── python-slim.json
│   ├── triton-backends.json
│   ├── triton.json
│   └── jumpstart-public.json
├── schemas/                # JSON schemas for catalog validation
│   ├── manifest.schema.json
│   ├── instances.schema.json
│   ├── regions.schema.json
│   ├── image-catalog.schema.json
│   ├── model-catalog.schema.json
│   ├── triton-backends.schema.json
│   └── unified-model-catalog.schema.json
└── package.json            # Shared dependencies (@aws-sdk/*)
```

---

## Building a New MCP Server

### Step 1: Create the Directory

```bash
mkdir -p servers/my-server
cd servers/my-server
```

### Step 2: Write package.json

```json
{
  "name": "@amzn/ml-container-creator-my-server",
  "private": true,
  "version": "1.0.0",
  "description": "MCP server that does X for ML Container Creator.",
  "type": "module",
  "main": "index.js",
  "license": "Apache-2.0",
  "scripts": {
    "test": "node test.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

!!! note "Dependency policy"
    Only `@modelcontextprotocol/sdk` and `zod` are guaranteed available. If you need AWS SDK clients, add them to `servers/lib/package.json` and import from `'../lib/...'`. All dependencies must use approved licenses (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD).

### Step 3: Write manifest.json

```json
{
    "name": "@amzn/ml-container-creator-my-server",
    "version": "1.0.0",
    "description": "Short description of what this server recommends.",
    "modes": {
        "static": true,
        "smart": false,
        "discover": false
    },
    "catalogs": {
        "myData": "./catalogs/my-data.json"
    },
    "tool": {
        "name": "get_my_recommendations"
    }
}
```

The `modes` object declares which modes the server supports. The generator passes `BEDROCK_SMART=true` env var when `--smart` is active, and `DISCOVER_MODE=false` when discover is explicitly disabled.

!!! note "Bundling Constraints"
    To be bundled with ml-container-creator, your MCP server must satisfy these constraints:

    1. **Manifest schema compliance** — `manifest.json` is validated against `servers/lib/schemas/manifest.schema.json`. All six top-level fields are required: `name`, `version`, `description`, `modes`, `catalogs`, `tool`. No additional properties are permitted.

    2. **Identity consistency** — The `name` and `version` in `manifest.json` must exactly match `package.json`. These are cross-validated in CI.

    3. **Mode declaration** — The `modes` object must declare all three modes (`static`, `smart`, `discover`) as booleans, even if your server only supports one. Set unsupported modes to `false`.

    4. **Catalog declaration** — The `catalogs` field is required. If `modes.static` is `true`, at least one catalog must be declared — static mode means "answer from local data," so the manifest must reference that data source. Catalog paths must resolve to valid files. If your server reads from non-traditional sources (e.g., project templates, config files), declare those as catalogs to make the data dependency explicit.

    5. **Tool uniqueness** — Your tool `name` must be unique across all bundled servers. CI validates this.

    6. **License and SBOM** — Bundled servers must include `licenses.csv` and `sbom.json` (generated via `npm run license-check` in the server directory).

    Run `node scripts/validate-servers.js` locally to verify all constraints before pushing.

!!! tip
    Copy an existing server's `manifest.json` as your starting point (e.g., `servers/e2e-status/manifest.json` for a simple static-only server). This guarantees the schema is correct from the start.

### Step 4: Implement the Server (index.js)

```javascript
#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── Load catalog ──────────────────────────────────────────────────

let MY_CATALOG
try {
    const raw = readFileSync(resolve(__dirname, './catalogs/my-data.json'), 'utf8')
    MY_CATALOG = JSON.parse(raw)
} catch (err) {
    process.stderr.write(`[my-server] Fatal: ${err.message}\n`)
    process.exit(1)
}

// ── Logging (always to stderr — stdout is MCP protocol) ──────────

function log(message) {
    process.stderr.write(`[my-server] ${message}\n`)
}

// ── Core logic ───────────────────────────────────────────────────

function getRecommendations(context, limit) {
    // Your filtering/ranking logic here
    const results = Object.keys(MY_CATALOG).slice(0, limit)

    return {
        values: results.length > 0 ? { myParam: results[0] } : {},
        choices: { myParam: results }
    }
}

// ── MCP server setup ─────────────────────────────────────────────

const server = new McpServer({
    name: 'my-server',
    version: '1.0.0'
})

server.tool(
    'get_my_recommendations',
    'Returns recommended values for myParam',
    {
        parameters: z.array(z.string())
            .describe('Parameter names to provide values for'),
        limit: z.number().int().positive().default(10)
            .describe('Maximum choices per parameter'),
        context: z.record(z.string(), z.any()).optional()
            .describe('Current configuration context')
    },
    async ({ parameters, limit, context }) => {
        // Only respond if our parameter is requested
        if (!parameters.includes('myParam')) {
            return {
                content: [{ type: 'text', text: JSON.stringify({ values: {}, choices: {} }) }]
            }
        }

        const result = getRecommendations(context || {}, limit)

        return {
            content: [{ type: 'text', text: JSON.stringify(result) }]
        }
    }
)

// ── Export for testing ────────────────────────────────────────────

export { getRecommendations, MY_CATALOG }

// ── Start transport (only when run as main module) ───────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename
if (isMain) {
    log('Starting...')
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
```

**Key patterns from existing servers:**

- Always log to `stderr` (stdout is the MCP JSON-RPC channel)
- Guard MCP transport connection with `isMain` check (allows `import` for testing)
- Export core logic functions for direct testing
- Use `z` (zod) for input schema validation
- Return results as `{ content: [{ type: 'text', text: JSON.stringify({...}) }] }`
- Check if your parameter is actually in the `parameters` array before doing work

### Step 5: Write test.js

```javascript
#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert'
import { getRecommendations, MY_CATALOG } from './index.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

console.log('\nmy-server: getRecommendations\n')

test('returns values and choices', () => {
    const result = getRecommendations({}, 5)
    assert.ok(result.values.myParam, 'should have a top recommendation')
    assert.ok(result.choices.myParam.length > 0, 'should have choices')
    assert.ok(result.choices.myParam.length <= 5, 'should respect limit')
})

test('respects limit', () => {
    const result = getRecommendations({}, 2)
    assert.ok(result.choices.myParam.length <= 2)
})

test('empty context works', () => {
    const result = getRecommendations(undefined, 10)
    assert.ok(result.values)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
```

**Test convention:** Uses only `node:assert` — no external test framework. Run with `node servers/my-server/test.js`.

### Step 6: Register in config/mcp.json

Add your server to `config/mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["servers/my-server/index.js"]
    }
  }
}
```

Or use the CLI:

```bash
ml-container-creator mcp add my-server --bundled
```

The `mcp init` command registers all bundled servers at once:

```bash
ml-container-creator mcp init
```

### Step 7: Wire into the Generator

The generator queries MCP servers on-demand via `McpQueryRunner` (in `src/lib/mcp-query-runner.js`). To trigger your server during prompting:

1. Add your parameter to `config/parameter-schema-v2.json` with `"mcp": true` and `"valueSpace": "unbounded"`
2. Add a query method in `McpQueryRunner` that calls `cm.queryMcpServer('my-server', context)`
3. The returned `values` and `choices` are automatically injected into prompt list choices

If your server doesn't map to a schema parameter (e.g., it provides auxiliary data), you can query it directly from the prompt runner without the parameter matrix integration.

### Step 8: Install and Test

```bash
cd servers/my-server && npm install && cd ../..
node servers/my-server/test.js

# Integration test with the generator
ml-container-creator --smart --skip-prompts --instance-type=ml.g5.xlarge
```

---

## Adding Smart Mode (Bedrock)

Smart mode uses Amazon Bedrock for context-aware recommendations. Import the shared client:

```javascript
import { queryBedrock } from '../lib/bedrock-client.js'

const SMART_MODE = process.env.BEDROCK_SMART === 'true'
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-20250514-v1:0'
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'

const SERVER_CONFIG = {
    serverName: 'my-server',
    systemPromptTemplate: `You are an advisor for ... 
Context: {context}
Parameters: {parameters}
Limit: {limit}

Respond with ONLY JSON: { "values": { ... } }`,
    temperature: 0.3,
    maxTokens: 1024,
    modelId: BEDROCK_MODEL,
    region: BEDROCK_REGION
}
```

In your tool handler, try Bedrock first, fall back to static:

```javascript
if (SMART_MODE) {
    log('[smart] Querying Bedrock...')
    const bedrockResult = await queryBedrock(SERVER_CONFIG, parameters, limit, context || {})
    if (bedrockResult?.values?.myParam) {
        // Validate Bedrock's suggestion against your catalog
        // Then merge with static results
    }
}

// Fall through to static logic
```

The `queryBedrock` function handles:
- Dynamic import of `@aws-sdk/client-bedrock-runtime` (with 1s timeout)
- Prompt template variable substitution (`{context}`, `{parameters}`, `{limit}`)
- JSON extraction from LLM responses (handles fenced code blocks)
- Error handling (returns `null` on any failure)

---

## Adding Discover Mode

Discover mode queries live APIs. Common patterns:

```javascript
const DISCOVER_MODE = process.env.DISCOVER_MODE !== 'false' && !process.argv.includes('--no-discover')

// In your tool handler:
if (DISCOVER_MODE && context?.modelName) {
    // Query HuggingFace Hub, SageMaker AI APIs, etc.
    const metadata = await fetchModelMetadata(context.modelName)
    // Use metadata to improve recommendations
}
```

See `servers/instance-sizer/lib/model-resolver.js` for an example that fetches `config.json` from HuggingFace Hub.

---

## Catalogs and Schemas

Catalogs are JSON data files that servers filter/rank at runtime. Shared catalogs live in `servers/lib/catalogs/` and server-specific catalogs in `servers/<name>/catalogs/`.

### Catalog Schemas

Every catalog has a JSON Schema in `servers/lib/schemas/`. The `catalog-schema-validation` property test validates all catalogs automatically.

### Adding a Catalog Entry

**New instance type** (`servers/lib/catalogs/instances.json`):

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

**New base image version** (`servers/lib/catalogs/model-servers.json`):

```json
{
  "vllm": [
    {
      "image": "vllm/vllm-openai:v0.11.0",
      "labels": { "framework_version": "0.11.0" },
      "accelerator": { "type": "cuda", "version": "12.1" },
      "defaults": {
        "envVars": { "VLLM_GPU_MEMORY_UTILIZATION": "0.9" },
        "inferenceAmiVersion": "al2-ami-sagemaker-inference-gpu-3-1"
      },
      "validationLevel": "experimental"
    }
  ]
}
```

### Validation

```bash
# Validate all catalogs against schemas
node scripts/validate-catalogs.js

# Property tests also validate automatically
npm run test:property -- --grep "catalog-schema"
```

---

## Testing

### Standalone Tests

```bash
# Individual server
node servers/my-server/test.js

# All servers
npm run test:servers
```

### Integration Tests

Integration tests in `test/integration/` verify the full MCP client-server flow:

```bash
npm test -- --grep "MCP"
```

### Manual Testing

Spawn a server manually and call it via stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node servers/region-picker/index.js
```

---

## How the Generator Uses MCP

### Query Timing

MCP servers are queried **on-demand** during the interactive prompt flow (not at startup):

1. **Region** — After user enters a region search term
2. **Instance** — After model name is known (VRAM-based sizing) or after user enters an instance search term
3. **Base image** — After deployment config is chosen
4. **Model** — After architecture is determined
5. **Endpoint** — When `--existing-endpoint` is needed for IC attachment
6. **HyperPod cluster** — When deployment target is HyperPod EKS

### Smart vs Standard Mode

| Aspect | Standard (`ml-container-creator`) | Smart (`ml-container-creator --smart`) |
|--------|------|------|
| Static catalogs | ✅ Queried | ✅ Queried |
| Discover (live APIs) | ✅ Enabled by default | ✅ Enabled |
| Bedrock LLM | ❌ Not called | ✅ Called (BEDROCK_SMART=true injected) |
| Latency | ~1-2s per server | ~3-5s per server (Bedrock round-trip) |
| Requires credentials | AWS CLI for discover | AWS CLI + Bedrock model access |

### Parameter Matrix Integration

The generator's `parameterMatrix` (from `src/lib/generated/parameter-matrix.js`) marks parameters as MCP-eligible:

```javascript
{
    instanceType: {
        valueSpace: 'unbounded',  // MCP can provide values
        mcp: true,                // MCP is enabled for this param
        ...
    }
}
```

Only parameters with `valueSpace: 'unbounded'` and `mcp: true` are sent in the `parameters` array to MCP servers. The generator stores returned values in `configManager.mcpSources` and choices in `configManager.mcpChoices`.

---

## License Compliance

All bundled servers and dependencies must use approved open-source licenses:

- MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD

Before committing a new server or dependency:

```bash
npm run _sbom           # Generate SBOM
npm run _licenses:review  # Review license compliance
```
