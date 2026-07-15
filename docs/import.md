# Import, Update & Regenerate

Three project lifecycle commands that let you work with existing endpoints, incrementally update configuration, and upgrade generator versions without starting from scratch.

## Overview

| Command | Use case |
|---------|----------|
| `mcc import` | Generate a project from a colleague's running endpoint |
| `mcc update` | Change one or two fields without regenerating everything |
| `mcc regenerate` | Upgrade to a new generator version with saved parameters |

---

## `mcc import`

Generate an operational project from a running SageMaker endpoint — even one you didn't create.

### When to use

- A colleague deployed an endpoint and you need to run `do/test`, `do/benchmark`, or `do/adapter`
- You're diagnosing a production issue and need the operational tooling
- You want to extend an existing endpoint with benchmarking or monitoring

### Usage

```bash
mcc import <endpoint-arn> [--output-dir <path>] [--region <region>] [--dry-run]
```

### Flags

| Flag | Description |
|------|-------------|
| `--output-dir <path>` | Output directory (default: `./<endpoint-name>`) |
| `--region <region>` | AWS region override (default: extracted from ARN) |
| `--dry-run` | Print reconstructed config without writing files |

### What gets generated

**Included:** `do/config`, `do/test`, `do/benchmark`, `do/deploy`, `do/clean`, `do/logs`, `do/status`, `do/register`, `do/optimize`, `do/run`, `do/ic/<name>.conf`

**Not included:** `Dockerfile`, `do/build`, `do/push`, `do/submit`, `buildspec.yml`, `code/` directory

The generated project is a "no-build" project — the container already exists in ECR.

### Endpoint status

Import works on **any** endpoint status: InService, Updating, OutOfService, or Failed. The `DescribeEndpointConfig` and `DescribeInferenceComponent` APIs are always accessible regardless of endpoint health.

### Example

```bash
# Import from a running endpoint
mcc import arn:aws:sagemaker:us-east-1:123456789012:endpoint/llama3-prod

# Preview what would be generated
mcc import arn:aws:sagemaker:us-east-1:123456789012:endpoint/llama3-prod --dry-run

# Import to a specific directory
mcc import arn:aws:sagemaker:us-east-1:123456789012:endpoint/llama3-prod --output-dir ./my-project
```

After import:

```bash
cd llama3-prod
./do/test          # Test the endpoint
./do/benchmark     # Run performance benchmarks
./do/status        # Check endpoint health
./do/logs          # View CloudWatch logs
```

---

## `mcc update`

Change specific configuration fields and regenerate only the affected files. Customizations to unrelated files are preserved.

### When to use

- Changing instance type (e.g., scaling up from ml.g5.xlarge to ml.g5.2xlarge)
- Updating environment variables
- Toggling LoRA support
- Any single-field change that doesn't require full regeneration

### Usage

```bash
mcc update [--field <key=value>...] [--dry-run] [--no-register]
```

### Flags

| Flag | Description |
|------|-------------|
| `--field <key=value>` | Set a field non-interactively (repeatable) |
| `--dry-run` | Show affected files without writing |
| `--no-register` | Skip `do/register` after update |

### Interactive vs non-interactive

**Without `--field`:** Interactive spacebar multi-select of fields, then prompted for new values.

**With `--field`:** Direct key=value assignment — no prompts.

```bash
# Non-interactive: change instance type
mcc update --field instanceType=ml.g5.4xlarge

# Multiple fields at once
mcc update --field instanceType=ml.g5.4xlarge --field icGpuCount=4

# Preview what would change
mcc update --field instanceType=ml.g5.4xlarge --dry-run
```

### Affected files

The update command uses a dependency map to determine which template files are affected by each parameter change:

| Parameter | Affected files |
|-----------|---------------|
| `instanceType` | `do/config`, `do/ic/default.conf` |
| `deploymentConfig` | `do/config`, `do/ic/default.conf`, `Dockerfile`, `do/build` |
| `baseImage` | `Dockerfile`, `do/build` |
| `region` | `do/config` |
| `icGpuCount` | `do/ic/default.conf` |
| `enableLora` | `do/ic/default.conf`, `Dockerfile` |

Only these files are rewritten. All other files remain untouched.

### Update log

Every update appends an entry to `do/update.log` with timestamp, changed fields, and affected files — useful for auditing configuration drift.

---

## `mcc regenerate`

Re-run project generation from saved parameters using the current generator version. Use this after upgrading MCC to get the latest template improvements.

### When to use

- After `npm update @aws/ml-container-creator` — get latest template fixes
- After a generator release with new `do/` script features
- To reset generated files to a clean state (with `--force`)

### Usage

```bash
mcc regenerate [--force] [--dry-run] [--no-register]
```

### Flags

| Flag | Description |
|------|-------------|
| `--force` | Regenerate even if version already matches |
| `--dry-run` | Show what would change without writing |
| `--no-register` | Skip `do/register` after regeneration |

### How it works

1. Reads `.mlcc-generation-params.json` (written at generation time)
2. Merges with live overrides from `do/config` (your manual edits win)
3. Merges IC sizing from `do/ic/default.conf`
4. Backs up current generated files to `.mlcc-backup/<timestamp>/`
5. Runs full `writeProject()` with current templates
6. Updates `.mlcc-version`

### Guard on imported projects

If a project was created via `mcc import` (has `.mlcc-import-source` but no `.mlcc-generation-params.json`), regeneration is blocked:

```
❌ This is an imported project — regeneration requires original generation parameters.
   Use 'mcc update' to change specific fields instead.
```

Use `mcc update` for field-level changes on imported projects.

### Example

```bash
# Check if regeneration is needed (version comparison)
mcc regenerate --dry-run

# Force regeneration regardless of version
mcc regenerate --force

# Regenerate without auto-registering
mcc regenerate --force --no-register
```

---

## `.mlcc-generation-params.json`

Written automatically by `writeProject()` after every successful generation. Contains:

- `generatorVersion` — version of MCC that created the project
- `generatedAt` — ISO timestamp
- `answers` — full configuration (secrets redacted)
- `bootstrapProfile` — which bootstrap profile was active
- `catalogVersions` — framework and model registry versions used

**Not committed to git** — listed in `.gitignore` by default. This is local project state.

Sensitive values (`hfToken`, `ngcToken`) are replaced with `[REDACTED]`. ARN references (`hfTokenArn`, `ngcTokenArn`) are preserved since they're not secret.
