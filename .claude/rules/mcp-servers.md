---
paths:
  - "servers/**"
  - ".mcp.json"
---
# Bundled MCP servers

- Every server in `servers/<name>/` is self-contained: its own `package.json`, runnable
  standalone, and built on `createPickerServer` in `servers/lib/create-picker-server.js`
  (ADR-003). Don't hand-roll MCP scaffolding.
- Shared code (Bedrock client, catalog loader, dynamic resolvers, overrides) lives in
  `servers/lib/`. Catalogs live in `servers/lib/catalogs/` and are validated by
  `node scripts/validate-catalogs.js` (pre-commit runs it when catalogs are staged).
- **Publishing:** the npm package only ships what `package.json` `files` lists. When you add a
  server or a new file that a server imports, add it to `files`.
  `test/unit/npm-package-contents.test.js` checks that every runtime import of a shipped
  server is shipped.
- **Tests** use a custom `node:assert` harness, not mocha, and run only via
  `scripts/run-server-tests.js` (`npm run test:servers`). The runner discovers test files, so
  don't keep a list. `servers/server-tests-wired.test.js` fails if a test file isn't discovered.
  Tests that hit live HTTP or AWS go in the runner's `NETWORK_DEPENDENT` list and must have a
  deterministic offline path.
- **Catalog data:** never invent model or instance metadata (VRAM, versions, prices). Leave a
  documented gap and skip the test instead. Catalogs grow, so assert behaviour ("top
  recommendation has enough VRAM"), not specific SKUs or versions.
- Bedrock "smart mode" is opt-in (`BEDROCK_SMART=true`). Default behaviour must work offline.
