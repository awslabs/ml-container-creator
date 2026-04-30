# Testing

## Running Tests

```bash
npm test                    # Unit + integration tests
npm run test:property       # Property-based tests (fast-check)
npm run test:all            # All tests without security audit
npm run validate            # All tests + ESLint + npm audit
npm run test:servers        # MCP server standalone tests
```

## Targeted Testing

```bash
npm test -- --grep "CLI Options"
npm test -- --grep "sklearn"
npm run test:property -- --grep "catalog-schema"
npx mocha test/unit/config-manager-unit.test.js
```

## Test Structure

| Directory | What It Tests |
|-----------|---------------|
| `test/unit/` | Individual modules (config-manager, deployment-config-resolver, prompt-runner, template-manager) |
| `test/property/` | Universal correctness properties across parameter combinations using fast-check |
| `test/input-parsing-and-generation/` | End-to-end generation: CLI options, env vars, config files, file generation, error handling |
| `test/integration/` | MCP client-server integration |
| `test/servers/` | MCP server-specific tests |
| `test/*.test.js` | Top-level integration tests (generator.test.js, template-manager.test.js) |

## What to Test When Adding Features

**New deployment config.** Add a generation test in `test/generator.test.js` asserting expected files. Add a `template-manager` test for validation rules.

**New catalog entry.** The `catalog-schema-validation` property test validates all catalog entries against their schemas automatically. No new test needed unless the entry introduces new validation logic.

**New MCP server.** Add a `test.js` in the server directory. Add an integration test in `test/integration/` if the server interacts with the generator.

**New prompt.** Add a property test in `test/property/` or `test/input-parsing-and-generation/` verifying the prompt's effect on generated output.

## Property-Based Tests

Property tests use [fast-check](https://github.com/dubzzz/fast-check) to validate universal correctness properties across thousands of parameter combinations. They live in `test/property/` and cover areas like:

- Catalog schema validation against JSON schemas
- Deployment config resolver decomposition and round-tripping
- Environment variable merge precedence
- Registry loader transformations
- Template manager validation rules (GPU requirements, HyperPod config, async/batch config)
- Namespace validation (RFC 1123 DNS labels)

Run them with `npm run test:property`. Each test file targets a specific property and runs 20--100 iterations depending on complexity.
