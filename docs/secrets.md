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

### Deploy-time (`do/deploy`): by reference only

SageMaker deploys (`realtime-inference`, `async-inference`, `batch-transform`) never put a secret value in the container `Environment`. SageMaker returns that map from `DescribeModel`, `DescribeInferenceComponent` and `DescribeEndpointConfig`, and CloudTrail records it as request parameters, so anyone with describe or CloudTrail read access could read a value placed there.

Instead, `do/deploy` passes the reference:

| Configured | Container `Environment` gets |
|---|---|
| `HF_TOKEN_ARN` (do/config, or the bootstrap profile secret `hfToken`) | `HF_TOKEN_ARN=<arn>` |
| `NGC_API_KEY_ARN` (do/config, or the profile secret `ngcApiKey`) | `NGC_API_KEY_ARN=<arn>` |
| `IC_ENV_HF_TOKEN_ARN` (realtime IC override) | `HF_TOKEN_ARN=<arn>` |

At startup the container entrypoint (`code/serve`, used by the vLLM, SGLang, TensorRT-LLM and diffusors images) resolves each `*_ARN` with the SageMaker execution role (`aws secretsmanager get-secret-value`, or `boto3` if the image has no AWS CLI) and exports `HF_TOKEN` / `NGC_API_KEY` for the model server. The value is never printed. If the lookup fails, the container exits with an error naming the variable and the missing permission. A value that is already set (for example from a Kubernetes `secretKeyRef`) is left alone.

`do/deploy` checks the secret with `DescribeSecret` (metadata only) and warns if it can't describe it, or if its name is outside the prefixes the bootstrap execution role can read (see below).

**Plaintext tokens are refused.** If only `HF_TOKEN` / `NGC_API_KEY` (or `IC_ENV_HF_TOKEN` / `IC_ENV_NGC_API_KEY`) is set, with no matching `*_ARN`, `do/deploy` exits with code 3 before creating anything:

```bash
# Store the token once, then deploy by reference
ml-container-creator secrets create --type hf-token --name production --secret-value hf_***
mcc bootstrap add-secret hfToken arn:aws:secretsmanager:<region>:<account>:secret:mlcc/hf-token/production-AbCdEf
./do/deploy
```

If the model doesn't need a token, run `unset HF_TOKEN`. To deploy the plaintext value anyway, pass `./do/deploy --allow-plaintext-secret`. It prints a warning that the value will be visible in SageMaker Describe APIs and CloudTrail.

!!! warning "Endpoints deployed before this change"
    Releases from v0.9.0 up to this fix resolved the ARN on your machine and wrote the **plaintext** token into the SageMaker container `Environment`. Those models and inference components keep the plaintext value until you redeploy them. Check with `aws sagemaker describe-inference-component --inference-component-name <ic> --query 'keys(Specification.Container.Environment)'` (or `describe-model ... --query 'keys(PrimaryContainer.Environment)'`). If `HF_TOKEN` or `NGC_API_KEY` is listed, **rotate the token** at Hugging Face / NGC, update the secret (`aws secretsmanager put-secret-value`), and redeploy (`./do/deploy --force` on realtime-inference). Then delete the superseded models and inference components, which still carry the old value.

**Images whose entrypoint MLCC doesn't own.** LMI/DJL, llama.cpp and Triton images start through the AWS DLC or Triton entrypoint, which doesn't resolve `*_ARN`. For gated models on those engines, stage the weights to S3 first (`./do/stage`), so the container needs no token. If you can't stage them, use `--allow-plaintext-secret` and accept the exposure.

**HyperPod EKS / EKS.** These targets resolve `HF_TOKEN_ARN` on your machine only to create the in-cluster Kubernetes Secret `hf-token-secret`. Pods read it through `secretKeyRef` / `tokenSecretRef`, never as a plain env value, and no SageMaker API payload carries it.

## IAM Permissions

The serving container resolves `*_ARN` **as the SageMaker execution role**, so that role (not just your CLI user) needs `secretsmanager:GetSecretValue` on the secret. The bootstrap `core` stack (`infra/bootstrap-modules/core/stack.ts`) grants it on the secret names MLCC creates:

```json
{
    "Sid": "SecretsManagerRead",
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    "Resource": [
        "arn:aws:secretsmanager:*:<account>:secret:mlcc/*",
        "arn:aws:secretsmanager:*:<account>:secret:ml-container-creator/*",
        "arn:aws:secretsmanager:*:<account>:secret:mlcc-hf-token-*"
    ]
},
{
    "Sid": "SecretsManagerKmsDecrypt",
    "Effect": "Allow",
    "Action": "kms:Decrypt",
    "Resource": "arn:aws:kms:*:<account>:key/*",
    "Condition": {
        "StringLike": {
            "kms:ViaService": "secretsmanager.*.amazonaws.com",
            "kms:EncryptionContext:SecretARN": ["<the three secret ARN patterns above>"]
        }
    }
}
```

`kms:Decrypt` only matters for secrets created with a customer-managed key (`secrets create --kms-key-id`). The default `aws/secretsmanager` key needs no grant. Run `mcc bootstrap` again to apply the `mlcc-hf-token-*` and KMS statements to an existing role.

If you registered a secret with another name (`mcc bootstrap add-secret hfToken <arn>` accepts any ARN), or you deploy with your own `ROLE_ARN`, grant that role `secretsmanager:GetSecretValue` on the secret yourself. Otherwise the container fails at startup.

No IAM changes are needed when adding new secret types, as long as the secret uses the `mlcc/` prefix.

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

Plaintext flags (`--hf-token`, `--ngc-token`) still generate a `do/config` that exports the plaintext value, and `do/build` / `do/run` use it locally. `do/deploy` to a SageMaker target now refuses it unless you pass `--allow-plaintext-secret` (see [Deploy-time](#deploy-time-dodeploy-by-reference-only)).

!!!tip
    Migrate existing projects to Secrets Manager by creating a secret with `secrets create`, then updating `do/config` to replace the plaintext export with the `_ARN` export.

## Supported Secret Types

| Type | Display Name | Stages | Purpose |
|------|-------------|--------|---------|
| `hf-token` | HuggingFace Token | build-time, runtime | Gated model download from HuggingFace Hub |
| `ngc-token` | NVIDIA NGC Token | build-time | Pulling base images from NVIDIA NGC registry |

## Adding New Secret Types

New secret types can be added by editing the secret classification registry. See [Adding Features — Secrets](ADDING_FEATURES.md) for the step-by-step guide. The system is designed so that a single registry entry automatically enables the CLI prompts, `secrets create` type selection, and do-script resolution logic.
