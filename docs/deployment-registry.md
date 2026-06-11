# Deployment Registry

The deployment registry tracks every configuration you deploy — model, instance, region, parameters, and status. Use it to audit what's running, compare configurations across environments, and feed the CI system with testable configurations.

---

## Quick Start

```bash
# Register a successful deployment
./do/register

# Register with notes
./do/register --notes "Upgraded to vLLM 0.8.5, 20% latency improvement"

# Register a partial success (e.g., deploy worked but tune failed)
./do/register --status partial --notes "Tune OOM on 32B model"

# Output as JSON (for scripting)
./do/register --json

# Register to CI table (DynamoDB)
./do/register --ci
```

---

## What Gets Captured

Every registration records:

| Field | Source | Example |
|---|---|---|
| **Project name** | `do/config` | `qwen3-4b-vllm` |
| **Deployment config** | `do/config` | `transformers-vllm` |
| **Architecture** | Derived from config | `transformers` |
| **Backend** | Derived from config | `vllm` |
| **Model name** | `do/config` | `Qwen/Qwen3-4B` |
| **Instance type** | `do/config` | `ml.g5.xlarge` |
| **Region** | `do/config` | `us-east-1` |
| **Deployment target** | `do/config` | `realtime-inference` |
| **Base image** | `do/config` | `vllm/vllm-openai:v0.8.5` |
| **IC list** | `do/ic/*.conf` | All inference components + adapters |
| **Parameters** | Environment variables | Engine-specific env vars (secrets redacted) |
| **Status** | `--status` flag | `success`, `partial`, `failed` |
| **Notes** | `--notes` flag | Free-text |
| **Generator version** | npm global install | `0.10.1` |

---

## Flags

| Flag | Description |
|---|---|
| `--status <value>` | One of: `success`, `partial`, `failed` (default: `success`) |
| `--notes "text"` | Free-text annotation |
| `--json` | Output deployment record as JSON to stdout |
| `--ci` | Write to CI DynamoDB table (implies `--json`) |
| `--ci-table <name>` | Override CI table name (default: `mlcc-ci-table`) |
| `--build-strategy <value>` | Record how the image was built (default: `codebuild-submit`) |
| `--project` | Include project-level metadata |

---

## Storage Modes

### Local Registry (Default)

Without `--ci`, `do/register` calls `ml-container-creator registry log` which appends to the local registry. Use `ml-container-creator registry` subcommands to query it:

```bash
# List all registered deployments
ml-container-creator registry list

# Filter by deployment config
ml-container-creator registry list --deployment-config=transformers-vllm

# Show details for a specific entry
ml-container-creator registry show <id>
```

### CI Table (DynamoDB)

With `--ci`, the record is written to a DynamoDB table (provisioned by `ml-container-creator bootstrap --ci`). Each record gets a deterministic `configId` — a hash of `deploymentConfig:modelName:instanceType:region:deploymentTarget:icCount:adapterCount`.

If the configId already exists, the record is updated and `testStatus` is reset to `untested` — signaling the CI harness to re-validate.

```bash
# Register to CI table
./do/register --ci

# Use a custom table name
./do/register --ci --ci-table my-custom-table
```

!!! note "CI Infrastructure Required"
    The CI table must exist before `--ci` works. Run `ml-container-creator bootstrap` with CI enabled to provision it. See [Bootstrap](bootstrap.md) for details.

---

## Multi-IC and Adapter Tracking

For realtime-inference projects, the registry captures all inference components from `do/ic/*.conf` and all adapters from `do/adapters/*.conf`:

```json
{
  "icList": [
    {"name": "default", "image": "qwen3-4b-latest", "gpuCount": 1, "copyCount": 1},
    {"name": "tuned-sft", "isAdapter": true, "baseIcName": "default", "artifactUrl": "s3://..."}
  ]
}
```

In CI mode, only the first IC (alphabetically) is included to keep validation costs down.

---

## Parameter Capture

The registry captures environment variables relevant to each architecture:

- **Transformers/Diffusors** — Engine-prefixed vars (`VLLM_*`, `SGLANG_*`, etc.) + `HF_MODEL_ID`
- **HTTP** — All non-system env vars from `do/config`
- **Triton** — `config.pbtxt` content + `TRITON_MODEL_REPOSITORY`

Sensitive values (`HF_TOKEN`, `AWS_SECRET_ACCESS_KEY`, anything containing `SECRET` or `TOKEN`) are automatically redacted to `***REDACTED***`.

---

## Typical Workflow

```bash
# 1. Deploy
./do/build && ./do/push && ./do/deploy

# 2. Test
./do/test

# 3. Register (after confirming it works)
./do/register --notes "Initial deployment, inference validated"

# 4. Later: upgrade base image, re-deploy, re-register
./do/register --notes "vLLM 0.8.5 upgrade"
```

For CI pipelines, registration happens automatically as part of `do/ci`.
