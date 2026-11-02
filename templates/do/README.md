<%
const _lora = typeof enableLora !== 'undefined' && enableLora;
const _bench = typeof includeBenchmark !== 'undefined' && includeBenchmark;
const _batchGen = typeof deploymentTarget !== 'undefined' && deploymentTarget === 'batch-transform';
const _tune = framework === 'transformers' && !_batchGen;
const _noBuild = typeof no_build !== 'undefined' && no_build;
-%>
# do/ Scripts

Standardized lifecycle scripts for your ML deployment project, following [do-framework](https://github.com/iankoulski/do-framework) conventions.

> Full documentation: [awslabs.github.io/ml-container-creator](https://awslabs.github.io/ml-container-creator/)

## Configuration

- **Deployment config**: `<%= deploymentConfig %>` (<%= framework %> / <%= modelServer %>)
- **Region**: `<%= awsRegion %>`
- **Instance**: `<%= instanceType %>`
- **Build Target**: `<%= buildTarget %>`

All settings are centralized in `do/config`. Override via environment variables.

## Available Scripts

Most scripts accept `--help`. Deployment-centric scripts act on the active target (`DEPLOYMENT_TARGET` in `do/config`); pass `--target <t>` to pick another.

| Script | Description |
|--------|-------------|
<% if (!_noBuild) { %>| `./do/build` | Build Docker image locally |
| `./do/push` | Push image to Amazon ECR |
<% } %>| `./do/submit` | Submit remote build to CodeBuild |
| `./do/stage` | Pre-stage model weights from Hugging Face to S3 (SageMaker Processing Job) |
| `./do/run` | Run container locally (docker run) |
| `./do/validate` | Target-aware pre-deploy checks (right-sizing, config, cluster contract, SageMaker payloads); `--format json` for CI |
| `./do/deploy` | Deploy to the active target (`--target <t>` to choose; `--help` lists targets and flags) |
| `./do/add-ic` | realtime-inference: add an inference component (for example a full fine-tuned model) to the endpoint |
| `./do/add-pod` | hyperpod-eks: serve a full fine-tuned model as its own InferenceEndpointConfig |
<% if (_lora) { %>| `./do/adapter` | Manage LoRA adapters on the deployment (`add`, `list`, `remove`, `update`, `search`, `promote`) |
<% } %>| `./do/draft` | hyperpod-eks: configure a speculative-decoding draft model (`set`, `remove`, `status`) |
| `./do/test` | Test the local container or the active deployment (`--adapter <name>` for an adapter) |
| `./do/status` | Show deployment health and status (IC copies as current/desired) |
| `./do/logs` | Tail logs: CloudWatch (SageMaker targets) or kubectl (hyperpod-eks / eks) |
| `./do/metrics` | Serving-metrics readout for the deployed endpoint (`--window <minutes>`, `--target`, `--json`) |
<% if (_bench) { %>| `./do/benchmark` | Run a SageMaker AI Benchmarking job (`--workload <name>` or `--dataset <name>`) |
| `./do/optimize` | Run SageMaker AI Inference Recommendations and apply a result (`--apply`) |
<% } %><% if (_tune) { %>| `./do/tune` | Fine-tune a supported model (SFT, DPO, RLVR, RLAIF) with SageMaker AI Managed Model Customization; `--backend hp-eks` runs on a HyperPod EKS cluster |
<% } %><% if (!_batchGen) { %>| `./do/train` | Custom training with your own code (`do/training/<technique>/`) on SageMaker Training (`--backend smtj`, default) or HyperPod EKS (`--backend hp-eks`) |
| `./do/evaluate` | Evaluate a deployed model or adapter with inference requests (technique-specific quality metrics) |
<% } %>| `./do/register` | Register the deployed model (SageMaker Model Registry); `dataset`, `evaluator` and `prompt` subcommands register assets to the AI Registry |
| `./do/manifest` | Asset manifest helper for deployed resources (`add`, `delete`, `list`) |
| `./do/export` | Export the current do/config as a reproduce-it CLI command, a generator `--config` JSON (`--json`), or a notebook (`--notebook`) |
| `./do/clean` | Clean up resources for the active target (`./do/clean --help` lists scopes); `./do/clean adapters` deletes this project's canonical adapters from S3 |
| `./do/ci` | CI harness (realtime-inference): `report`, `status`, `trigger`, `dashboard` |
| `./do/config` | Project configuration, sourced by every script (not run directly) |

## Quick Start

```bash
<% if (_noBuild) { %>./do/stage              # Stage model weights to S3
<% } else { %>./do/submit             # Build and push with CodeBuild (or: ./do/build && ./do/push)
<% } %>./do/deploy             # Deploy to the active target (or: ./do/deploy --target <t>)
./do/test               # Test inference
./do/clean all          # Tear down
```

## See Also

- [`IAM_PERMISSIONS.md`](../IAM_PERMISSIONS.md) — Required IAM permissions per script
- [Full docs](https://awslabs.github.io/ml-container-creator/) — Architecture, tutorials, API reference
