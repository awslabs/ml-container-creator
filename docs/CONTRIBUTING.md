# Contributing

This guide is for developers who want to extend ML Container Creator -- adding deployment configurations, MCP servers, catalog entries, or registry data. For user-facing documentation on configuration, deployment, and MCP usage, see the [User Guide](how-it-works.md).

## Quick Setup

```bash
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator
npm install
npm link
npm test
yo @aws/ml-container-creator
```

Requires Node.js 24.11.1+ and npm 11.6.2+.

## Project Structure

```
ml-container-creator/
├── generators/app/
│   ├── index.js                    # Yeoman generator entry point
│   ├── lib/                        # 28 modules (see Generator Architecture)
│   │   ├── config-manager.js       # 8-level configuration precedence
│   │   ├── prompt-runner.js        # Phased prompt orchestration
│   │   ├── prompts.js              # Prompt definitions and choices
│   │   ├── template-manager.js     # Configuration validation
│   │   ├── configuration-manager.js # Registry-based config matching
│   │   ├── registry-loader.js      # Catalog JSON to internal data shapes
│   │   ├── mcp-client.js           # MCP server communication
│   │   ├── deployment-registry.js  # Capture/replay deployments
│   │   ├── deployment-config-resolver.js # Decompose deployment-config strings
│   │   ├── validation-engine.js    # Accelerator compatibility checks
│   │   ├── comment-generator.js    # Dockerfile comment generation
│   │   ├── cli-handler.js          # Subcommand routing (mcp, registry, help)
│   │   ├── mcp-command-handler.js  # mcp add/remove/list subcommands
│   │   ├── registry-command-handler.js # registry list/replay/export subcommands
│   │   ├── huggingface-client.js   # HuggingFace API lookups
│   │   ├── configuration-matcher.js # Framework/model config matching
│   │   ├── configuration-exporter.js # Export config as CLI command
│   │   ├── template-engine.js      # EJS rendering helpers
│   │   ├── schema-validator.js     # JSON schema validation
│   │   ├── known-flags-validator.js # Env var flag validation
│   │   ├── accelerator-validator.js # Base class for accelerator validators
│   │   ├── cuda-validator.js       # CUDA version compatibility
│   │   ├── neuron-validator.js     # AWS Neuron compatibility
│   │   ├── rocm-validator.js       # AMD ROCm compatibility
│   │   ├── cpu-validator.js        # CPU (no-op) validator
│   │   ├── docker-introspection-validator.js # Docker-based validation
│   │   ├── community-reports-validator.js    # Community validation data
│   │   └── deployment-entry-schema.js        # Deployment registry schema
│   ├── config/
│   │   ├── registries/             # Legacy (empty, replaced by catalogs)
│   │   └── schemas/                # Legacy (empty, replaced by catalogs)
│   └── templates/                  # EJS templates for generated projects
│       ├── Dockerfile              # Main Dockerfile (http + transformers)
│       ├── do/                     # do-framework lifecycle scripts
│       ├── code/                   # Model serving code
│       ├── deploy/                 # Legacy wrapper scripts
│       ├── triton/                 # Triton-specific Dockerfile + model repo
│       ├── diffusors/              # Diffusors-specific Dockerfile + serve
│       ├── hyperpod/               # K8s manifests for HyperPod EKS
│       ├── sample_model/           # Abalone sample model training
│       └── test/                   # Test script templates
├── servers/                        # Bundled MCP servers
│   ├── instance-recommender/       # Instance type recommendations
│   ├── region-picker/              # AWS region suggestions
│   ├── base-image-picker/          # Base image catalog + selection
│   │   └── catalogs/               # model-servers.json, triton-backends.json, ...
│   ├── model-picker/               # HuggingFace model metadata
│   │   └── catalogs/               # popular-transformers.json, popular-diffusors.json
│   ├── hyperpod-cluster-picker/    # HyperPod cluster discovery
│   └── lib/                        # Shared Bedrock client + JSON schemas
├── test/                           # Test suite
│   ├── unit/                       # Unit tests
│   ├── property/                   # Property-based tests (fast-check)
│   ├── input-parsing-and-generation/ # Integration tests
│   ├── integration/                # MCP integration tests
│   └── servers/                    # MCP server tests
├── config/                         # mcp.json, defaults.json, presets/
└── scripts/                        # Build, validation, and utility scripts
```

## Developer Guide Pages

| Page | When to Read |
|------|-------------|
| [Generator Architecture](dev/generator-architecture.md) | Understanding the lifecycle phases, key modules, and how configuration flows through the system |
| [Template System](dev/template-system.md) | Working with EJS templates, do/ script branching, Dockerfile conditionals, or adding a new deployment configuration |
| [MCP Server Development](dev/mcp-server-development.md) | Adding catalog entries (instance types, base images), creating new bundled MCP servers, or working with JSON schemas |
| [Registries and Catalogs](dev/registries-and-catalogs.md) | Contributing framework configs, model entries, or instance type data to the registry system |
| [Testing](dev/testing.md) | Running the test suite, understanding test structure, or writing tests for new features |

## PR Workflow

1. Create a feature branch from `main`.
2. Make changes. Follow existing code style (ES modules, `const` by default, single quotes, no semicolons in `lib/` modules).
3. Run `npm run validate` -- this runs ESLint, npm audit, unit tests, and property tests.
4. Verify generated projects build: `yo @aws/ml-container-creator --skip-prompts --deployment-config=<your-config> ...` then `./do/build`.
5. If you edited catalogs, run `node scripts/validate-catalogs.js`.
6. If you edited docs, run `mkdocs build --strict`.
7. Commit with a conventional commit message: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`.
8. Push and open a PR. CI runs tests on Node.js 24.x and 22.x.
