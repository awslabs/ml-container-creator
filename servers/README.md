# Bundled MCP Servers

This directory contains first-party MCP (Model Context Protocol) servers that ship with ML Container Creator. Each server is self-contained with its own `package.json` and dependencies, and shares a common Bedrock client library under `lib/`.

## Directory Structure

```
servers/
├── lib/                        # Shared library (Bedrock client)
│   ├── bedrock-client.js       # Reusable Bedrock invocation module
│   ├── package.json            # @aws-sdk/client-bedrock-runtime dependency
│   └── LICENSE
├── instance-recommender/       # Instance type recommendation server
│   ├── index.js                # MCP server entry point
│   ├── test.js                 # Standalone tests (node test.js)
│   ├── package.json
│   └── LICENSE
├── region-picker/              # AWS region suggestion server
│   ├── index.js                # MCP server entry point
│   ├── test.js                 # Standalone tests (node test.js)
│   ├── package.json
│   └── LICENSE
└── endpoint-picker/            # SageMaker endpoint discovery server
    ├── index.js                # MCP server entry point
    ├── test.js                 # Standalone tests (node test.js)
    ├── package.json
    └── LICENSE
```

## Available Servers

### instance-recommender

Recommends SageMaker instance types based on the current ML framework. Traditional ML frameworks (sklearn, xgboost, tensorflow) get CPU instance suggestions; transformer frameworks get GPU instances.

**Static mode (default):** Returns hardcoded instance lists by framework category — no AWS credentials needed.

**Smart mode (`BEDROCK_SMART=true`):** Queries Amazon Bedrock for context-aware instance recommendations, then pads with static results up to the requested limit. Falls back to static on any failure.

**Tool:** `get_ml_config`

| Input Field | Type | Description |
|-------------|------|-------------|
| `parameters` | `string[]` | Must include `"instanceType"` to get results |
| `limit` | `number` | Max choices to return (default: 10) |
| `context` | `object` | Current config — `framework`, `modelServer`, etc. |

**Example response:**

```json
{
  "values": { "instanceType": "ml.g5.xlarge" },
  "choices": { "instanceType": ["ml.g5.xlarge", "ml.g5.2xlarge", "ml.g4dn.xlarge"] }
}
```

### region-picker

Suggests AWS regions for SageMaker deployments based on a search term. Filters the built-in list of 22 SageMaker-available regions by case-insensitive substring match against both region codes and labels.

**Static mode (default):** Filters the hardcoded region list — no AWS credentials needed.

**Smart mode (`BEDROCK_SMART=true`):** Queries Amazon Bedrock for a context-aware region recommendation, uses it as the top choice, and pads with static results. Falls back to static on any failure.

**Tool:** `get_ml_config`

| Input Field | Type | Description |
|-------------|------|-------------|
| `parameters` | `string[]` | Must include `"awsRegion"` to get results |
| `limit` | `number` | Max choices to return (default: 10) |
| `context` | `object` | Use `regionSearch` for filtering (e.g., `"europe"`, `"us-east"`, `"tokyo"`) |

**Example response:**

```json
{
  "values": { "awsRegion": "eu-west-1" },
  "choices": { "awsRegion": ["eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1"] }
}
```

### endpoint-picker

Discovers InService SageMaker real-time endpoints with available GPU capacity for attaching new inference components. Uses `ListEndpoints`, `DescribeEndpoint`, and `ListInferenceComponents` to calculate available capacity.

**Discover mode:** Queries the SageMaker API using a 3-strategy credential fallback (explicit profile → default chain → detect profiles). No static mode — always requires AWS credentials.

**Tool:** `get_inference_endpoints`

| Input Field | Type | Description |
|-------------|------|-------------|
| `parameters` | `string[]` | Must include `"endpointName"` to get results |
| `limit` | `number` | Max endpoints to return (default: 10) |
| `context` | `object` | `awsRegion`, `awsProfile`, `deploymentTarget` (must be `realtime-inference`) |

**Example response:**

```json
{
  "values": { "endpointName": "my-endpoint-1234567890" },
  "choices": { "endpointName": ["my-endpoint-1234567890", "prod-llm-endpoint"] },
  "metadata": {
    "my-endpoint-1234567890": {
      "variantName": "AllTraffic",
      "instanceType": "ml.g6e.48xlarge",
      "instanceCount": 1,
      "icCount": 2,
      "availableGpus": 4,
      "hasInstancePools": false
    }
  }
}
```

## Usage

### Adding a Bundled Server

```bash
# Add instance-recommender
ml-container-creator mcp add instance-recommender --bundled

# Add region-picker with a search filter for European regions
ml-container-creator mcp add region-picker --bundled -e REGION_SEARCH=europe
```

Dependencies are installed automatically on first use.

### Listing Bundled Servers

```bash
ml-container-creator mcp list --bundled
```

### Enabling Smart Mode

Pass `BEDROCK_SMART=true` as an environment variable when adding the server:

```bash
ml-container-creator mcp add instance-recommender --bundled -e BEDROCK_SMART=true
ml-container-creator mcp add region-picker --bundled -e BEDROCK_SMART=true
```

## Environment Variables

Both servers share the same environment variable interface:

| Variable | Default | Description |
|----------|---------|-------------|
| `BEDROCK_SMART` | `false` | Set to `"true"` to enable Bedrock-powered recommendations |
| `BEDROCK_MODEL` | `global.anthropic.claude-sonnet-4-20250514-v1:0` | Bedrock model ID |
| `BEDROCK_REGION` | Falls back: `AWS_REGION` → `us-east-1` | AWS region for Bedrock API calls |


## Authenticating with Amazon Bedrock

Smart mode requires valid AWS credentials and access to the configured Bedrock model. The servers use the standard AWS SDK credential chain, so any of these approaches work:

### Option 1: Environment Variables

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...          # if using temporary credentials
export BEDROCK_REGION=us-east-1
```

### Option 2: AWS CLI Profile

```bash
aws configure                         # set up a default profile
# or
export AWS_PROFILE=my-profile         # use a named profile
```

### Option 3: IAM Role (EC2, ECS, Lambda, etc.)

If running on AWS infrastructure, the instance/task role is picked up automatically. No extra configuration needed.

### Required IAM Permission

The calling identity needs `bedrock:InvokeModel` on the inference profile:

```json
{
    "Effect": "Allow",
    "Action": "bedrock:InvokeModel",
    "Resource": "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0"
}
```

The default model (`global.anthropic.claude-sonnet-4-20250514-v1:0`) uses a cross-region inference profile that routes to the nearest available region. If you override `BEDROCK_MODEL` with a region-specific model, adjust the resource ARN accordingly.

### Enabling Model Access

Bedrock models must be explicitly enabled in your AWS account:

1. Open the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/)
2. Go to **Model access** in the left nav
3. Request access to the Anthropic Claude models
4. Wait for the status to show "Access granted"

## How Servers Impact the Generator Flow

When you run `ml-container-creator`, the generator queries any configured MCP servers during the configuration loading phase. Here's how the bundled servers influence the flow:

### Without MCP Servers

```
$ ml-container-creator

? AWS Region: (use arrow keys or type to search)
❯ us-east-1
  us-east-2
  us-west-1
  us-west-2
  ... (all regions, alphabetical)

? Instance type: (enter manually)
  ml.m5.xlarge
```

The user sees a generic list of regions and must know which instance type to pick.

### With instance-recommender (Static Mode)

```bash
ml-container-creator mcp add instance-recommender --bundled
ml-container-creator
```

```
? Framework: transformers
? Instance type: (use arrow keys)
❯ ml.g4dn.xlarge      # GPU instances suggested because framework=transformers
  ml.g4dn.2xlarge
  ml.g5.xlarge
  ml.g5.2xlarge
  Custom (enter manually)
```

The server detects the transformer framework from context and suggests GPU instances instead of CPU ones.

### With region-picker (Static Mode)

```bash
ml-container-creator mcp add region-picker --bundled -e REGION_SEARCH=europe
ml-container-creator
```

```
? AWS Region: (use arrow keys)
❯ eu-west-1            # Filtered to European regions only
  eu-west-2
  eu-west-3
  eu-central-1
  eu-central-2
  eu-north-1
  eu-south-1
  Custom (enter manually)
```

The search term `"europe"` filters the region list to only show European regions.

### With Smart Mode (Bedrock)

```bash
ml-container-creator mcp add instance-recommender --bundled -e BEDROCK_SMART=true
ml-container-creator mcp add region-picker --bundled -e BEDROCK_SMART=true
ml-container-creator
```

```
? Framework: transformers
? Model: meta-llama/Llama-3.1-8B

? Instance type: (use arrow keys)
❯ ml.g5.2xlarge        # Bedrock recommended based on Llama 3.1 8B + transformers
  ml.g5.xlarge
  ml.g4dn.xlarge
  ml.g4dn.2xlarge
  Custom (enter manually)

? AWS Region: (use arrow keys)
❯ us-west-2            # Bedrock recommended based on model availability + pricing
  us-east-1
  us-east-2
  Custom (enter manually)
```

Bedrock considers the full configuration context (framework, model, model server) to make informed recommendations. The LLM-suggested value appears first, padded with static results.

## Troubleshooting

### "Failed to load @aws-sdk/client-bedrock-runtime"

The Bedrock SDK isn't installed. Run:

```bash
cd servers/lib
npm install
```

This only affects smart mode. Static mode works without the SDK.

### "Access denied. Ensure bedrock:InvokeModel permission"

Your AWS credentials don't have permission to call Bedrock. Either:
- Add the `bedrock:InvokeModel` permission to your IAM user/role (see the IAM section above)
- Or check that your credentials are configured correctly (`aws sts get-caller-identity`)

### "Model not found"

The configured model ID isn't available in your account or region. Either:
- Enable model access in the Bedrock console (see "Enabling Model Access" above)
- Override with a model you have access to: `BEDROCK_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0`

### "Bedrock rate limit hit"

You're sending too many requests. The server automatically falls back to static mode. If this happens frequently, consider:
- Using static mode for development
- Requesting a quota increase in the AWS console

### "Bedrock request timed out"

The Bedrock API didn't respond within 10 seconds. This usually means network connectivity issues. The server falls back to static mode automatically.

### Server Not Returning Results

1. Check the server is registered: `ml-container-creator mcp list`
2. Check stderr output — all diagnostic messages go to stderr
3. Verify the tool is being called with the right parameters (e.g., `"awsRegion"` for region-picker, `"instanceType"` for instance-recommender)
4. Try running the standalone tests to verify the server logic:

```bash
node servers/region-picker/test.js
node servers/instance-recommender/test.js
node servers/endpoint-picker/test.js
```

### Smart Mode Not Activating

Smart mode only activates when `BEDROCK_SMART` is exactly `"true"`. Check:
- The env var is set in the server config: `ml-container-creator mcp get <server-name>`
- It's not `"True"`, `"TRUE"`, or `"1"` — only `"true"` works

## Testing

Each server has standalone tests that run without AWS credentials or network access:

```bash
# Run individual server tests
node servers/region-picker/test.js
node servers/instance-recommender/test.js
node servers/endpoint-picker/test.js

# Run all server tests from the project root
npm run test:servers
```

Property-based tests for correctness properties are in the main test suite:

```bash
npm test
```

## Creating a Custom MCP Server

Any process that speaks the MCP protocol over stdio can serve as a configuration provider. Your server needs to:

1. Handle the MCP initialize handshake
2. Register a tool (default name: `get_ml_config`)
3. Accept `{ parameters, limit, context }` as tool input
4. Return `{ values, choices }` as a JSON text response

### Tool Interface

Your tool receives:

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

Your tool returns (as a text content block containing JSON):

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

- `values` — recommended default value per parameter (merged into config)
- `choices` — list of valid options per parameter (shown during prompting)

Both fields are optional. A server may return only values, only choices, or both.

### Minimal Example

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

Register it:

```bash
ml-container-creator mcp add my-server -- node path/to/my-server.js
```

## License Compliance

All bundled servers and their dependencies must use only approved licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD.

When adding or updating a bundled server, run the compliance scripts before committing:

```bash
npm run _sbom
npm run _licenses:review
npm run _licenses:csv
npm run _licenses:attribution
```
