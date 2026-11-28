# Contributing

This guide is for developers who want to extend ML Container Creator -- adding deployment configurations, MCP servers, catalog entries, or registry data. For user-facing documentation on configuration, deployment, and MCP usage, see the [User Guide](how-it-works.md).

## Quick Setup

```bash
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator
npm install
npm link
npm test
ml-container-creator
```

Or run without installing globally:

```bash
npx @aws/ml-container-creator
```

Requires Node.js 24.11.1+ and npm 11.6.2+.

## Project Structure

```
ml-container-creator/
├── bin/cli.js                      # CLI entry point (Commander.js)
├── src/
│   ├── app.js                      # Main orchestrator (phased lifecycle)
│   ├── lib/                        # Core modules (config, prompts, validators, handlers)
│   │   ├── generated/              # Code-gen'd from config/parameter-schema-v2.json (do not edit)
│   │   ├── prompts/                # Interactive wizard prompt modules
│   │   └── validators/             # Parameter/catalog validators
│   └── agent/                      # Python advisory agent
├── templates/                      # EJS templates for generated projects (Dockerfile, do/, code/, ...)
├── servers/                        # Bundled MCP servers (each self-contained) + servers/lib/
├── infra/                          # CDK stacks (bootstrap-modules/, ci-harness/)
├── config/                         # parameter-schema-v2.json, mcp.json, presets
├── scripts/                        # Codegen, validation, E2E and utility scripts
├── test/                           # Mocha suites: unit/, property/, integration/, input-parsing-and-generation/, servers/
├── tests/                          # Python (pytest) tests
└── docs/                           # MkDocs site source
```

## Developer Guide Pages

| Page | When to Read |
|------|-------------|
| [Schema-Driven Architecture](dev/schema-driven-architecture.md) | Understanding the lifecycle phases, how the schema drives codegen, and how configuration flows through the system |
| [Template System](dev/template-system.md) | Working with EJS templates, do/ script branching, Dockerfile conditionals, or adding a new deployment configuration |
| [MCP Server Development](dev/mcp-server-development.md) | Adding catalog entries (instance types, base images), creating new bundled MCP servers, or working with JSON schemas |
| [Registries and Catalogs](dev/registries-and-catalogs.md) | Contributing framework configs, model entries, or instance type data to the registry system |
| [Testing](dev/testing.md) | Running the test suite, understanding test structure, or writing tests for new features |

## PR Workflow

1. Create a feature branch from `main`.
2. Make changes. Follow existing code style (ES modules, `const` by default, single quotes, no semicolons in `lib/` modules).
3. Run `npm run test:ci` -- this runs ESLint, then `test:all` (mocha tests, node:test suites, and property tests).
4. Verify generated projects build: `ml-container-creator --skip-prompts --deployment-config=<your-config> ...` then `./do/build`.
5. If you edited catalogs, run `node scripts/validate-catalogs.js`.
6. If you edited docs, run `mkdocs build --strict`.
7. Commit with a conventional commit message: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.
8. Push and open a PR. CI runs tests on Node.js 24.x and 22.x.
