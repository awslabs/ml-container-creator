# ADR-003: MCP Picker-Server Factory

## Status

Accepted — in progress (Wave 2)

## Context

`servers/` contains 14 bundled MCP servers (plus `servers/lib/` shared code).
Each is an independent stdio MCP server that the CLI spawns via
`src/lib/mcp-client.js` to answer configuration questions (regions, instances,
base images, models, endpoints, …). They were authored one at a time by AI
agents, and each `index.js` re-implements the same server skeleton.

Measured duplication across the 14 servers (from the Wave 2 Task 1 audit):

| Scaffold element | Servers with it | Notes |
|---|---:|---|
| `__dirname` via `fileURLToPath(import.meta.url)` | 14 / 14 | byte-identical |
| `new McpServer({ name, version })` | 14 / 14 | version always `'1.0.0'` |
| `StdioServerTransport` + connect | 14 / 14 | identical |
| stderr `log()` with `[name]` prefix | 14 / 14 | same shape, re-declared per file (some named `log`, some inline) |
| main-guard `const isMain = process.argv[1] && resolve(process.argv[1]) === __filename` | 11 / 14 | **byte-identical** where present; the other 3 inline the same connect |
| `function loadCatalog(relativePath)` | 5 / 14 | **byte-for-byte identical** copy-paste |
| Bedrock smart-mode (`SMART_MODE`, `SERVER_CONFIG`, `queryBedrock`, static→smart→fallback) | 2 / 14 | region-picker, instance-sizer |

Only the following genuinely differ between servers:
- **the catalog files** each loads,
- **the tool(s)** it registers (name, description, Zod input schema) — tool count
  ranges from **1 to 7** (e.g. `model-registry` has 7, `region-picker` has 1),
- **the handler logic** that turns inputs + catalogs into a response,
- for two servers, a **Bedrock system-prompt template**.

`servers/lib/` already holds correctly-shared code (`bedrock-client.js`,
`dynamic-resolver.js`, `model-id-resolver.js`, `image-filter.js`,
`override-loader.js`, `custom-validators.js`) and some servers extend it — so the
"share it in lib/" pattern is established. What is missing is a shared **server
scaffold**: the boilerplate above still lives, duplicated, in every `index.js`.

For an AI maintainer this is the worst kind of duplication: 14 near-identical
files where the essential (this server's catalogs + tools + handler) is buried in
incidental boilerplate, so an edit to "how servers start up" must be repeated 14
times and an agent cannot tell essential from incidental.

## Decision

Introduce a single factory, **`createPickerServer`**, in `servers/lib/`, that owns
the entire shared scaffold. Each `servers/<name>/index.js` becomes a declaration
of only what is unique to that server.

### Factory contract

```js
createPickerServer({
  name,            // string — server + log prefix; McpServer name
  version = '1.0.0',
  serverDir,       // the server's dir (for catalog resolution): pass import.meta.url
  catalogs = {},   // { key: 'relative/path.json' } → loaded + validated at startup
  tools,           // array of { name, description, schema (Zod), handler }
  bedrock = null,  // optional { systemPromptTemplate, modelId?, temperature?, maxTokens? }
                   //   enables smart-mode wiring via servers/lib/bedrock-client.js
})
  → { server, loadCatalog, log, start, catalogs }  // start() = main-guard connect
```

Design points, driven by the audit:

- **Multi-tool.** `tools` is an array so servers with 1–7 tools all fit; the
  single-picker case is just a one-element array. This is why the factory is not
  a single-`{ name, tool }` shape.
- **Catalog loading + logging + main-guard** are provided once. `loadCatalog`
  and `log` are returned so handlers can use them; the identical copies are
  deleted from each server.
- **Bedrock is opt-in.** Passing `bedrock` wires the `SMART_MODE`/`SERVER_CONFIG`
  plumbing and the static→smart→fallback control flow around the handler, using
  the existing `servers/lib/bedrock-client.js`. Servers without it (12 of 14) pay
  no Bedrock cost and carry no Bedrock code.
- **Startup guard** (`start()`) encapsulates the `isMain` check + `connect`, so
  importing a server for tests never opens a transport (preserving current test
  behavior).

### Scope

Wave 2 migrates all 14 servers onto the factory (Task 3: region/model/base-image
as the reference trio; Task 4: the remaining 11), deletes the duplicated
`loadCatalog`/`log`/main-guard/Bedrock plumbing, and reconciles
`package.json` `files` and `scripts/validate-servers.js`. Each migrated server
and the factory carry a conforming module header
(`docs/architecture/module-header-convention.md`), clearing the `servers/lib/`
header-lint warnings introduced in Wave 1.

## Consequences

- **Positive:** one place defines "how an MCP picker server behaves"; each
  `index.js` shrinks to its catalogs + tools + handler; adding a server becomes
  "call the factory." Bedrock smart-mode is a declared capability, not copied
  code.
- **Cost:** all 14 servers change at once (behavior-preserving); their `test.js`
  runners and `test/servers/*.test.js` must stay green; `package.json` `files`
  and validators must track the new imports.
- **Risk:** a server that relied on some incidental boilerplate detail could
  regress. Mitigated by migrating the reference trio first with tests green
  before the bulk migration, and by keeping the factory's behavior byte-compatible
  with the current scaffold (same log prefixes, same main-guard, same response
  envelope).

## References

- `docs/architecture/mcp-servers.md` — how the servers work + the full variance table
- `docs/architecture/system-overview.md` — the MCP boundary
- `servers/lib/bedrock-client.js` — the shared Bedrock client the factory reuses
- ADR-002 — the consolidation program
