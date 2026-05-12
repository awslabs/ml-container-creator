# Secrets Management

ML Container Creator integrates with AWS Secrets Manager to securely store and resolve authentication tokens at build-time and runtime. This eliminates plaintext secrets from your Docker images and enables rotation without regenerating projects.

## Why Secrets Manager?

Plaintext tokens (via `--hf-token` or `--ngc-token`) are baked into the Docker image. Anyone with `docker inspect` access can extract them. Secrets Manager solves this:

- **Zero-knowledge images** — containers never contain the secret value; they resolve it at build-time or runtime via the ARN
- **Rotation** — rotate tokens in Secrets Manager without rebuilding containers
- **Audit trail** — CloudTrail logs every secret access
- **Least-privilege** — IAM policies scope access to the `mlcc/*` prefix

## The `secrets` Subcommand

The `secrets` subcommand manages secrets in AWS Secrets Manager. All secrets follow the naming convention `mlcc/<type>/<label>`.

### `secrets create`

Create a new managed secret:

```bash
# Flag mode
ml-container-creator secrets create \
  --type hf-token \
  --name production \
  --secret-value hf_abc123xyz

# JSON mode (inline)
ml-container-creator secrets create \
  --json '{"type":"ngc-token","name":"ci-pipeline","secretValue":"nvapi-xxx"}'

# JSON mode (file)
ml-container-creator secrets create --json file://secret.json

# Interactive mode (no flags — prompts for type, name, and value)
ml-container-creator secrets create
```

The interactive mode masks the secret value input and presents a list of available secret types.

### `secrets list`

List all mlcc-managed secrets (never displays secret values):

```bash
ml-container-creator secrets list
```

Output:

```
🔐 Managed Secrets (2)

────────────────────────────────────────────────────────────────────────────────
  Name:          mlcc/hf-token/production
  ARN:           arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf
  Type:          hf-token
  Created:       1/15/2024
  Last Accessed: 6/1/2024
────────────────────────────────────────────────────────────────────────────────
  Name:          mlcc/ngc-token/ci-pipeline
  ARN:           arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-pipeline-XyZaBC
  Type:          ngc-token
  Created:       3/20/2024
  Last Accessed: Never
────────────────────────────────────────────────────────────────────────────────
```

### `secrets describe`

Show metadata for a specific secret (never reveals the value):

```bash
ml-container-creator secrets describe mlcc/hf-token/production
```

Displays name, ARN, type, description, creation date, last changed/accessed dates, rotation configuration, and tags.

## ARN-Based Workflow

Instead of passing plaintext tokens, pass the secret's ARN to the generator:

```bash
ml-container-creator my-project \
  --deployment-config=transformers-vllm \
  --model-name=meta-llama/Llama-3-8B \
  --hf-token-arn=arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf \
  --skip-prompts
```

Available ARN flags:

| Flag | Secret Type | Used At |
|------|-------------|---------|
| `--hf-token-arn` | HuggingFace Token | Build-time and runtime |
| `--ngc-token-arn` | NVIDIA NGC Token | Build-time only |

### Interactive Prompt Flow

During interactive project generation, if you need a gated model token, the CLI:

1. Queries Secrets Manager for existing `mlcc/hf-token/*` secrets
2. Presents a selection list of managed secrets
3. Stores the selected ARN in `do/config`

This means you never need to type or paste a token during generation.

## How Secrets Are Resolved

### Build-time (`do/build`)

When `do/config` exports an `_ARN` variable (e.g., `HF_TOKEN_ARN`), the `do/build` script resolves it before running `docker build`:

```bash
if [ -n "${HF_TOKEN_ARN:-}" ]; then
    echo "🔐 Resolving HuggingFace token from Secrets Manager..."
    HF_TOKEN=$(aws secretsmanager get-secret-value \
        --secret-id "${HF_TOKEN_ARN}" \
        --query SecretString --output text) || {
        echo "❌ Failed to resolve HuggingFace token from Secrets Manager"
        exit 3
    }
    export HF_TOKEN
fi
```

The resolved value is passed to Docker as a build argument and is not persisted in the image layers.

### Runtime (`do/run`)

For secrets needed at runtime (like `hf-token` which is used for both build-time model download and runtime model loading), `do/run` performs the same resolution before starting the container:

```bash
if [ -n "${HF_TOKEN_ARN:-}" ]; then
    HF_TOKEN=$(aws secretsmanager get-secret-value \
        --secret-id "${HF_TOKEN_ARN}" \
        --query SecretString --output text)
    export HF_TOKEN
fi
```

## IAM Permissions

The bootstrap stack provisions an IAM policy that grants `secretsmanager:GetSecretValue` scoped to the `mlcc/*` prefix:

```json
{
    "Sid": "SecretsManagerRead",
    "Effect": "Allow",
    "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
    ],
    "Resource": "arn:aws:secretsmanager:*:*:secret:mlcc/*",
    "Condition": {
        "StringEquals": {
            "aws:ResourceTag/mlcc:managed-by": "ml-container-creator"
        }
    }
}
```

No IAM changes are needed when adding new secret types — the policy covers any secret under the `mlcc/` prefix that carries the `mlcc:managed-by` tag.

## Naming Convention

All managed secrets follow the pattern:

```
mlcc/<secret-type>/<user-provided-label>
```

Examples:

- `mlcc/hf-token/production`
- `mlcc/ngc-token/team-shared`
- `mlcc/hf-token/ci-pipeline`

This maps directly to the IAM policy resource pattern `arn:aws:secretsmanager:*:*:secret:mlcc/*`.

## Mutual Exclusion

You cannot specify both a plaintext token and an ARN for the same secret type:

```bash
# ❌ This will fail
ml-container-creator my-project \
  --hf-token=hf_abc123 \
  --hf-token-arn=arn:aws:secretsmanager:...

# Error: Cannot specify both --hf-token and --hf-token-arn
```

Use one or the other. The ARN-based approach is recommended for all environments.

## Backward Compatibility

Plaintext flags (`--hf-token`, `--ngc-token`) continue to work exactly as before. If you don't use `--*-arn` flags, the generated `do/config` exports the plaintext value directly and no Secrets Manager resolution occurs.

!!!tip
    Migrate existing projects to Secrets Manager by creating a secret with `secrets create`, then updating `do/config` to replace the plaintext export with the `_ARN` export.

## Supported Secret Types

| Type | Display Name | Stages | Purpose |
|------|-------------|--------|---------|
| `hf-token` | HuggingFace Token | build-time, runtime | Gated model download from HuggingFace Hub |
| `ngc-token` | NVIDIA NGC Token | build-time | Pulling base images from NVIDIA NGC registry |

## Adding New Secret Types

New secret types can be added by editing the secret classification registry. See [Adding Features — Secrets](ADDING_FEATURES.md) for the step-by-step guide. The system is designed so that a single registry entry automatically enables the CLI prompts, `secrets create` type selection, and do-script resolution logic.
