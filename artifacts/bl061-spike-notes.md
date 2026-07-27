# BL061 Spike Notes — Reasoning MCP Server

## Date: 2026-07-27

---

## Task 0.1: MCP Developer Guide (`docs/dev/mcp-server-development.md`)

### Key Conventions

1. **Directory layout**: `servers/<name>/` with `index.js`, `test.js`, `package.json`, `manifest.json`
2. **Dependencies**: Only `@modelcontextprotocol/sdk` and `zod` guaranteed. AWS SDK lives in `servers/lib/package.json` and is imported from `'../lib/...'`
3. **Manifest schema**: Must declare all six fields: `name`, `version`, `description`, `modes`, `catalogs`, `tool`. All three modes must be booleans (even if unused → set to false). No additional properties.
4. **Identity consistency**: `name` and `version` in `manifest.json` must match `package.json`
5. **Logging**: Always to `stderr` (stdout = MCP JSON-RPC channel)
6. **isMain guard**: Wrap transport connection in `process.argv[1]` check so file can be imported for testing
7. **Response format**: `{ content: [{ type: 'text', text: JSON.stringify({...}) }] }`
8. **Test convention**: `node:assert` only, no framework. Export core logic for direct testing.
9. **Catalog requirement**: If `modes.static: true`, at least one catalog must be declared. Since reasoning server is `static: false, smart: true`, catalogs can be `{}`

### What the reasoning server needs differently

- The shared `bedrock-client.js` (`queryBedrock()`) uses the "server CONFIG + parameters/limit/context" pattern designed for parameter-selection servers. For the reasoning server, we need direct Bedrock invocation because:
  - We don't fit the `{values, choices}` pattern
  - Our tool returns `{interpretation, confidence?, suggestions?}`
  - We construct our own prompt from context+data+objective
- We'll use `@aws-sdk/client-bedrock-runtime` directly (already available in `servers/lib/package.json`)

---

## Task 0.2: Audit of Existing Servers

### `servers/instance-sizer/index.js`

- **Initialization**: Direct `new McpServer({name, version})` + `StdioServerTransport`
- **Tool registration**: `server.tool(name, description, zodSchema, async handler)`
- **Error handling**: Returns structured error in content (never throws/crashes)
- **Config loading**: Reads from file at startup, env vars for mode selection
- **Export pattern**: Exports handler function + constants + server object
- **Test pattern**: `test.js` imports handler directly, calls it, parses `result.content[0].text`

### `servers/agent-knowledge/index.js`

- **Simpler server**: No AWS calls, pure data parsing
- **Multiple tools**: Registers two tools (`query_knowledge`, `write_local_capability`)
- **Config loading**: Reads `config/agent.json` via path resolution from `PACKAGE_ROOT`
- **Cache pattern**: In-memory `Map` cache with `getCached(key, loader)` 
- **Path setup**: `fileURLToPath(import.meta.url)` → `__dirname` → `PACKAGE_ROOT = resolve(__dirname, '../../')`

### `servers/agent-knowledge/test.js`

- Sync test runner: `function test(name, fn) { try { fn(); ... } catch { ... } }`
- Some tests use `async` (await handleQueryKnowledge) but the runner is sync
- Imports exported functions directly from `./index.js`
- Uses `node:assert` with `.ok`, `.strictEqual`, assertions in try/catch

---

## Task 0.3: Direct Bedrock Calls in hey/GoalPlanner

### `src/agent/goal_planner.py`

- **NOT a direct Bedrock call** — uses the Strands Agent instance: `self._agent(prompt)`
- The Agent wraps Bedrock, but GoalPlanner doesn't call Bedrock directly
- Prompt construction: Template with `{permitted_scripts}`, `{context_json}`, `{objective}`
- Response parsing: Extracts JSON array from LLM output
- This is a good candidate for `interpret` integration — the planning call is stateless single-shot

### Integration approach for Phase 5

- GoalPlanner currently takes a Strands agent and calls it like a function
- To route through `interpret`, the Python agent would need to call the MCP reasoning server
- The `mcp_client.py` pattern (if it exists) or a subprocess call to the MCP server would be needed
- **For this ticket**: Focus on building the server itself (Phases 1-3, 6). Integration (Phases 4-5) is explicitly wired to existing callers and may be deferred per the task structure.

---

## Patterns to Follow

1. ESM module with `"type": "module"` in package.json
2. `@modelcontextprotocol/sdk` ^1.0.0, `zod` via SDK peer dep
3. `McpServer` + `StdioServerTransport` from SDK subpaths
4. Export handler + server for testing
5. `isMain` guard for transport startup
6. Return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` from tool handlers
7. Log to stderr with `[server-name]` prefix
8. Test with `node:assert`, no external framework
9. Load config with path relative to `PACKAGE_ROOT` (= `../../` from server dir)

## Patterns to Avoid

1. Don't throw from tool handlers — return structured error
2. Don't use the shared `queryBedrock()` helper — it's designed for the values/choices pattern
3. Don't add catalogs to manifest when `modes.static: false`
4. Don't use external test frameworks (jest, mocha, etc.)
5. Don't log to stdout (breaks MCP protocol)
