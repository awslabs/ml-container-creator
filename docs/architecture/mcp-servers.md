<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# MCP Picker Servers

The `servers/` directory holds the bundled **MCP picker servers**: small,
independent stdio servers that answer configuration questions during generation
and prompting (which region? which instance? which base image? which model?…).
The CLI reaches them only through `src/lib/mcp-client.js`, which spawns each as a
child process and calls a tool, expecting a `{ values, choices }` response. See
[system-overview.md](system-overview.md) for where this sits in the whole.

## The pattern

Each server is a declaration of three things — **catalogs**, **tools**, and
**handler logic** — wrapped in a shared scaffold provided by
`servers/lib/createPickerServer` (see
[ADR-003](../adr/ADR-003-mcp-picker-server-factory.md)). The scaffold owns
everything that used to be copy-pasted into every `index.js`:

- resolving the server directory (`__dirname` from `import.meta.url`),
- `loadCatalog(relativePath)` — read + parse a JSON catalog, throwing with the
  path on failure,
- `log(message)` — stderr logging with a `[server-name]` prefix (stdout is
  reserved for the MCP protocol),
- the **main-guard**: connect a `StdioServerTransport` only when the file is run
  as the main module, so importing it for tests never opens a transport,
- optional **Bedrock smart-mode**: when a server declares a `bedrock` config, the
  factory wires the static→smart→fallback flow around the handler using
  `servers/lib/bedrock-client.js`.

A handler receives the MCP tool arguments and returns the MCP text-content
envelope:

```js
async ({ parameters, limit, context }) => ({
  content: [{ type: 'text', text: JSON.stringify({ values, choices }) }]
})
```

Servers may register **one to seven** tools; the factory takes a `tools` array,
so single-picker and multi-tool servers use the same shape.

## The 14 servers and their variance

Captured in the Wave 2 Task 1 audit. "Scaffold" columns show what each server
currently re-implements (and what the factory absorbs). "Unique" is what stays in
the server after migration.

| Server | idx LOC | Tools | loadCatalog | log | main-guard | Bedrock smart | Unique after migration |
|---|---:|---:|:---:|:---:|:---:|:---:|---|
| region-picker | 230 | 1 | ✓ | ✓ | ✓ | ✓ | regions catalog, `get_regions`, filter + Bedrock prompt |
| workload-picker | 171 | 2 | ✓ | ✓ | – | – | workload-profiles catalog, 2 tools |
| e2e-status | 297 | 2 | – | – | ✓ | – | status tools (no catalog) |
| adapter-picker | 365 | 3 | – | ✓ | – | – | adapter tools |
| draft-model-picker | 390 | 4 | ✓ | ✓ | – | – | draft-models catalog, 4 tools |
| endpoint-picker | 565 | 1 | – | ✓ | ✓ | – | live SageMaker endpoint query |
| hyperpod-cluster-picker | 569 | 1 | – | ✓ | ✓ | – | HyperPod EKS cluster query |
| base-image-picker | 621 | 2 | ✓ | ✓ | ✓ | – | DLC catalogs, StaticCatalogResolver |
| agent-knowledge | 787 | 2 | – | ✓ | ✓ | – | docs/knowledge retrieval |
| model-registry | 826 | 7 | – | ✓ | ✓ | – | 7 SageMaker MPG tools |
| instance-sizer | 856 | 4 | – | ✓ | ✓ | ✓ | VRAM sizing, quota resolver, Bedrock prompt, lib/ |
| model-picker | 1788 | 2 | ✓ | – | ✓ | – | HF client, ModelResolver, catalogs |

Universal (14/14): `__dirname` block, `new McpServer`, `StdioServerTransport`.
Only **region-picker** and **instance-sizer** use Bedrock smart-mode. `loadCatalog`
is byte-identical in all 5 servers that have it.

## Adding a new picker server

1. Create `servers/<name>/index.js` that calls `createPickerServer({...})` with
   the server's `catalogs`, `tools`, and (optionally) `bedrock` config.
2. Add a conforming module header
   ([convention](module-header-convention.md)).
3. Register the server in `config/mcp.json` (and any loader path) so the CLI can
   spawn it.
4. Add its `test.js`; wire it into the `test:servers` npm script.
5. Add its files to `package.json` `files` so it ships in the package.

## Shared library (`servers/lib/`)

- `createPickerServer` — the scaffold factory (this pattern).
- `bedrock-client.js` — `queryBedrock(serverConfig, …)`; the single Bedrock call
  path (temperature/model from the server's `bedrock` config).
- `dynamic-resolver.js`, `model-id-resolver.js`, `image-filter.js`,
  `override-loader.js`, `custom-validators.js` — domain helpers used by specific
  servers.
