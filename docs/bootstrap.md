# Bootstrap

Bootstrap provisions shared AWS infrastructure that MCC projects depend on — an IAM execution role, an ECR repository, and optional S3 buckets. Run it once per region, and all MCC projects in that environment reuse the same resources. For multi-region deployments, run bootstrap once in each region — account-level singletons (IAM roles) are shared automatically.

```bash
ml-container-creator bootstrap
```

!!! tip "Run bootstrap before your first project"
    If you skip bootstrap, `do/deploy` and `do/push` still work — but you'll need to manually create an IAM role and ECR repository. Bootstrap automates this and gets the permissions right.

---

## Resource Classification

Bootstrap separates resources into three tiers:

```
┌─────────────────────────────────────────────────────────────────┐
│  ACCOUNT-LEVEL SINGLETONS (one per AWS account)                 │
│    • IAM Role: mlcc-sagemaker-execution-role                    │
│    • IAM Roles: mlcc-ci-scanner-role (CI only)                  │
│    • IAM Roles: mlcc-ci-orchestrator-role                       │
│    • IAM Roles: mlcc-ci-codebuild-role                          │
├─────────────────────────────────────────────────────────────────┤
│  REGION-SCOPED RESOURCES (one set per region)                   │
│    • ECR Repository: ml-container-creator                       │
│    • S3: mlcc-tune-{accountId}-{region}                         │
│    • S3: mlcc-adapters-{accountId}-{region}                     │
│    • S3: mlcc-async-{accountId}-{region}                        │
│    • S3: mlcc-batch-{accountId}-{region}                        │
│    • S3: mlcc-benchmark-{accountId}-{region}                    │
├─────────────────────────────────────────────────────────────────┤
│  CI RESOURCES (one set per account, fixed to one region)        │
│    • DynamoDB: mlcc-ci-table                                    │
│    • Lambda: mlcc-ci-scanner                                    │
│    • Step Functions: mlcc-ci-orchestrator                        │
│    • CodeBuild: mlcc-ci-executor                                │
│    • EventBridge Rule: mlcc-ci-scanner-schedule                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key implications:**

- Bootstrapping a second region **reuses** the existing IAM role (detected automatically) and creates new regional resources (ECR, S3)
- Each profile's `stackName` always follows the pattern `mlcc-bootstrap-{profileName}` — never borrowed from another profile
- If the IAM role already exists from a prior region's bootstrap, the CloudFormation stack skips creation and references it via the `UseExistingRoleArn` parameter

---

## What It Provisions

Bootstrap deploys a CloudFormation stack (`mlcc-bootstrap-<profile>`) with:

| Resource | Name | Purpose |
|---|---|---|
| **IAM Role** | `mlcc-sagemaker-execution-role` | SageMaker execution role with least-privilege permissions for endpoints, tuning, benchmarking, adapters, and secrets |
| **ECR Repository** | `ml-container-creator` | Shared container registry for all MCC project images (auto-expires untagged images after 30 days) |
| **S3 Bucket** (optional) | `mlcc-async-{account}-{region}` | Async inference output |
| **S3 Bucket** (optional) | `mlcc-batch-{account}-{region}` | Batch transform I/O |
| **S3 Bucket** (optional) | `mlcc-adapters-{account}-{region}` | LoRA adapter weight storage |
| **S3 Bucket** (optional) | `mlcc-benchmark-{account}-{region}` | Benchmark results |
| **S3 Bucket** (optional) | `mlcc-tune-{account}-{region}` | Tune datasets and output |
| **MLflow App** (optional) | Auto-detected | Experiment tracking for fine-tuning jobs |

S3 buckets are created when you answer "Yes" to *"Will you use async inference or batch transform?"* during interactive setup, or pass `--skip-s3` to skip them in non-interactive mode.

---

## Resource Lifecycle

Resources provisioned by bootstrap have different persistence behaviors:

| Resource | DeletionPolicy | Behavior on Stack Teardown |
|---|---|---|
| **IAM Role** | Default (Delete) | Deleted with the stack. Re-running bootstrap recreates it fresh. If the role already exists from another region, `UseExistingRoleArn` detection reuses it automatically. |
| **ECR Repository** | Default (Delete) | Deleted with the stack. If it already exists when bootstrap runs, creation is skipped (`SkipEcrCreation=true` is passed automatically). |
| **S3 Buckets** | **Retain** | Survive stack teardowns. If they already exist when bootstrap runs, creation is skipped and bucket names are injected from the deterministic naming pattern (`mlcc-{purpose}-{accountId}-{region}`). |

!!! info "S3 buckets are persistent"
    S3 buckets are the one resource that outlives the CloudFormation stack. This means your data (adapters, tune datasets, benchmark results) is never lost — even if you tear down and rebuild the bootstrap stack.

## Interactive Setup

```bash
ml-container-creator bootstrap
```

The interactive flow walks you through:

1. **Profile name** — a label for this environment (default: `default`)
2. **AWS profile selection** — picks from your `~/.aws/config` profiles
3. **Credential validation** — confirms access and discovers account ID + region
4. **S3 bucket decision** — whether to create buckets for async/batch/adapters/benchmarks
5. **CloudFormation deployment** — deploys the bootstrap stack
6. **MLflow App** — detects or creates an MLflow tracking server for tune experiments
7. **CI infrastructure** (optional) — deploys the CDK-based CI harness for automated E2E testing
    - With `--benchmark-infra`: also provisions Glue database (`mlcc_ci`), Athena table (`benchmark_results`), and S3 results bucket (`mlcc-benchmark-results-{accountId}-{region}`)
8. **Post-setup chain** — runs `mcp init` → `sync-architectures` → `sync-schemas`

The result is saved to `~/.ml-container-creator/config.json` and becomes your active profile.

---

## Non-Interactive Setup

For CI pipelines or scripted provisioning:

```bash
ml-container-creator bootstrap \
  --non-interactive \
  --profile my-aws-profile \
  --region us-west-2 \
  --name production \
  --skip-ci
```

| Flag | Required | Description |
|---|---|---|
| `--non-interactive` | Yes | Skips all prompts |
| `--profile` | Yes | AWS CLI profile name |
| `--region` | Yes | AWS region |
| `--name` | No | Bootstrap profile name (default: `default`) |
| `--role-arn` | No | Use an existing IAM role instead of creating one |
| `--skip-s3` | No | Skip S3 bucket creation |
| `--skip-ci` | No | Skip CI infrastructure |
| `--ci` | No | Force CI infrastructure deployment |
| `--benchmark-infra` | No | Deploy Glue/Athena benchmark infrastructure (requires `--ci`) |

---

## Profiles

Bootstrap supports multiple named profiles for different AWS environments (e.g., dev vs. prod, or multi-region).

```bash
# List all profiles
ml-container-creator bootstrap list

# Switch active profile
ml-container-creator bootstrap use production

# Check active profile and resource state
ml-container-creator bootstrap status

# Remove a profile (config only — does not delete AWS resources)
ml-container-creator bootstrap remove staging --force
```

The active profile determines which IAM role, ECR repo, and S3 buckets are used by `do/` scripts in all MCC projects.

### Multi-Region Deployments

To deploy in multiple regions within the same account, create a profile per region:

```bash
# Bootstrap us-east-1
ml-container-creator bootstrap
# Profile name: mlcc-us-east-1, Region: us-east-1

# Bootstrap us-west-2
ml-container-creator bootstrap
# Profile name: mlcc-us-west-2, Region: us-west-2

# Switch between regions
ml-container-creator bootstrap use mlcc-us-west-2
```

Each region gets its own CloudFormation stack, ECR repository, and S3 buckets. The IAM execution role is shared across regions (it's an account-level singleton).

!!! info "Profile naming convention"
    For multi-region setups, name profiles after their region (e.g., `mlcc-us-east-1`, `mlcc-eu-west-1`). The `stackName` is always derived as `mlcc-bootstrap-{profileName}`.

### Profile Removal

```bash
ml-container-creator bootstrap remove staging --force
```

!!! warning "Metadata-only removal"
    Profile removal **only** deletes the entry from `~/.ml-container-creator/config.json`. It does NOT delete AWS resources (IAM roles, S3 buckets, ECR repositories, CloudFormation stacks). Resources are retained for safety — delete them manually via the AWS Console or CLI if needed.

### Config File

Profiles are stored at `~/.ml-container-creator/config.json`. Multi-region example:

```json
{
  "activeProfile": "mlcc-us-east-1",
  "profiles": {
    "mlcc-us-east-1": {
      "awsProfile": "my-aws-profile",
      "awsRegion": "us-east-1",
      "accountId": "111111111111",
      "roleArn": "arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role",
      "ecrRepositoryName": "ml-container-creator",
      "asyncS3Bucket": "mlcc-async-111111111111-us-east-1",
      "batchS3Bucket": "mlcc-batch-111111111111-us-east-1",
      "stackName": "mlcc-bootstrap-mlcc-us-east-1",
      "sharedInfraFrom": null,
      "ciInfraProvisioned": true,
      "ciTableName": "mlcc-ci-table",
      "mlflowAppArn": "arn:aws:sagemaker:us-east-1:111111111111:mlflow-app/mlcc"
    },
    "mlcc-us-west-2": {
      "awsProfile": "my-aws-profile",
      "awsRegion": "us-west-2",
      "accountId": "111111111111",
      "roleArn": "arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role",
      "ecrRepositoryName": "ml-container-creator",
      "stackName": "mlcc-bootstrap-mlcc-us-west-2",
      "sharedInfraFrom": null,
      "ciInfraProvisioned": false
    }
  }
}
```

Key fields:

- `stackName` — always `mlcc-bootstrap-{profileName}` (never another profile's stack name)
- `sharedInfraFrom` — tracks which stack the IAM role was originally created by (for traceability when reusing across regions)
- `ciInfraProvisioned` — `true` on exactly ONE profile per account (CI is single-region)

---

## Updating Bootstrap

When you upgrade MCC, the bootstrap stack template may include new permissions or resources. Re-apply it with:

```bash
ml-container-creator bootstrap update
```

This re-deploys the CloudFormation stack for your active profile without prompts.

### Sanity Checks

Before deploying, `bootstrap update` validates:

1. **Account match** — your current AWS caller identity must match the profile's `accountId`. If you're logged into a different account, the update halts with an error.
2. **Stack exists** — the target CloudFormation stack must exist in the profile's region. If not found, you'll be prompted to run `bootstrap` (create) instead.
3. **Name consistency** — if the profile's `stackName` doesn't match the expected `mlcc-bootstrap-{profileName}` pattern, a warning is shown suggesting `bootstrap migrate`.
4. **CI region enforcement** — if `--ci` is passed and CI infrastructure already exists in another region/profile, the request is rejected.

If CI infrastructure was previously provisioned, it's updated along with the bootstrap stack.

---

## Migrating Legacy Profiles

If you created bootstrap profiles before multi-region support was added, the `migrate` subcommand upgrades them to current naming conventions:

```bash
ml-container-creator bootstrap migrate
```

### What It Does

- Corrects `stackName` to `mlcc-bootstrap-{profileName}` (the current naming pattern)
- Renames legacy `sharedStackFrom` field to `sharedInfraFrom`
- Validates profile-to-region consistency

### How It Works

1. Scans all profiles for naming inconsistencies
2. Displays a preview of proposed changes
3. Requires confirmation before writing

If no changes are needed, it prints a success message and exits.

### Safety

- **Non-destructive** — only modifies `~/.ml-container-creator/config.json` metadata
- **Idempotent** — safe to run multiple times (subsequent runs detect no changes)
- **Optional** — existing profiles continue to work without migration (you'll see a one-time advisory on `bootstrap update`)

### Example Output

```
📋 Migration Preview:

  Profile "my-profile":
    stackName: "mlcc-bootstrap-default" → "mlcc-bootstrap-my-profile"
  Profile "staging":
    sharedStackFrom → sharedInfraFrom: "mlcc-bootstrap-default" → "mlcc-bootstrap-default"

? Apply these changes? (Y/n)
✅ Migration complete.
```

---

## Scanning and Pruning

```bash
# Discover existing MCC bootstrap stacks in the active account/region
ml-container-creator bootstrap scan

# Remove stale profiles whose stacks no longer exist
ml-container-creator bootstrap prune
```

---

## Schema Sync

Bootstrap can refresh local parameter schemas and model family definitions from the source catalogs:

```bash
ml-container-creator bootstrap sync-schemas
ml-container-creator bootstrap sync-model-families
```

These are also run automatically as part of the post-setup chain during initial bootstrap.

---

## IAM Permissions

The bootstrap-created role includes permissions for:

- **Endpoints** — Create, update, delete, describe, invoke (including async)
- **Benchmarking** — AI Benchmark Jobs, Workload Configs, Recommendation Jobs
- **Fine-tuning** — Training Jobs, Model Packages, Hub Contents, MLflow
- **ECR** — Pull images from the `ml-container-creator` repository
- **S3** — Read/write to `mlcc-*` and `ml-container-creator-*` prefixed buckets
- **Secrets Manager** — Read/write secrets with `mlcc/` or `ml-container-creator/` prefix
- **CloudWatch Logs** — Create log groups/streams for endpoint logging
- **SNS** — Publish notifications for async inference completion
- **Lambda** — Invoke reward functions for RLVR/RLAIF tuning
- **Service Quotas** — Check instance availability

If you need to use an existing role instead, pass `--role-arn` during bootstrap.

!!! warning "IAM role is not retained on stack deletion"
    Unlike S3 buckets, the IAM execution role is deleted when the bootstrap stack is torn down. Re-running `ml-container-creator bootstrap` recreates it fresh. If the role already exists in the account (e.g., from another region's bootstrap), it is detected and reused via `UseExistingRoleArn` — a new one is not created.

---

## CI Infrastructure (Optional)

Passing `--ci` during bootstrap (or answering "Yes" to the CI prompt) deploys a CDK stack (`MlccCiHarnessStack`) that provides:

- **DynamoDB table** (`mlcc-ci-table`) for E2E test result tracking
- **Lambda** (`mlcc-ci-scanner`) for scanning untested configurations
- **Step Functions** (`mlcc-ci-orchestrator`) for test execution workflow
- **CodeBuild** (`mlcc-ci-executor`) for running build/deploy/test in isolation
- **EventBridge** schedule for periodic scanning
- Automated CDK bootstrap in the target account/region (if not already done)

### Athena/Glue Benchmark Infrastructure

When benchmark infrastructure is enabled (opt-in via the `CreateBenchmarkInfra` CDK parameter), the CI stack also provisions:

| Resource | Name | Purpose |
|---|---|---|
| **Glue Database** | `mlcc_ci` | Data catalog for benchmark results |
| **Glue Table** | `benchmark_results` | Schema definition for Parquet-based benchmark data |
| **S3 Bucket** | `mlcc-benchmark-results-{accountId}-{region}` | Partitioned Parquet storage for benchmark metrics |

These resources support the two-stage pipeline's Stage 2 (benchmark → write → query).

To provision benchmark infrastructure:

```bash
ml-container-creator bootstrap --ci --benchmark-infra
ml-container-creator bootstrap update --ci --benchmark-infra
```

Without `--benchmark-infra`, CI deploys only the DynamoDB table, Lambda, Step Functions, and CodeBuild. Athena/Glue are opt-in.

**Bootstrap config fields** stored after provisioning:

| Field | Description |
|---|---|
| `ciGlueDatabase` | Name of the Glue database (default: `mlcc_ci`) |
| `benchmarkS3Bucket` | S3 bucket for raw benchmark outputs (from CloudFormation stack output `BenchmarkS3BucketName`) |
| `ciBenchmarkResultsBucket` | S3 bucket for Athena-queryable Parquet benchmark results |

Example config after provisioning:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "ciInfraProvisioned": true,
      "ciTableName": "mlcc-ci-table",
      "ciGlueDatabase": "mlcc_ci",
      "benchmarkS3Bucket": "mlcc-benchmark-111111111111-us-east-1",
      "ciBenchmarkResultsBucket": "mlcc-benchmark-results-111111111111-us-east-1"
    }
  }
}
```

The S3 bucket includes lifecycle rules:
- **Transition to Infrequent Access** after 90 days
- **Expire** after 365 days (configurable)

IAM permissions added to the CI CodeBuild role:
- `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on the results bucket
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions`, `glue:BatchCreatePartition`, `glue:CreatePartition`
- `athena:StartQueryExecution`, `athena:GetQueryResults` (for partition repair)

These fields are absent (and the system gracefully degrades) if benchmark infrastructure is not provisioned — backward compatible with existing bootstrap profiles.


### Runtime Profile Loader

Generated projects include `do/lib/profile.sh` — a shared loader sourced by all `do/` scripts. It reads the active bootstrap profile into a bash associative array (`_PROFILE[]`) at runtime:

- **No regeneration needed** when switching profiles — run `mcc bootstrap use <profile>` then re-run any `do/` script
- **Precedence**: explicit env var > `_PROFILE[key]` > hardcoded default
- **Bash 4+ required** (Linux default; macOS users need Homebrew bash)
- **Graceful degradation**: if `~/.ml-container-creator/config.json` doesn't exist, `_PROFILE` stays empty and scripts fall back to env vars

This enables workflows where you switch profiles and immediately run `do/deploy` against the new region/account without regenerating the project.


### Single-Region Enforcement

CI infrastructure deploys **exactly once per AWS account**, in a single region. Attempting to deploy CI in a second region is rejected:

```
❌ CI infrastructure already exists in us-east-1 (profile: mlcc-us-east-1).
   Only one CI deployment per account is supported.
   To move CI to this region, first remove it from the existing profile:
   ml-container-creator bootstrap remove mlcc-us-east-1 --ci-only
```

This prevents conflicting IAM role names, DynamoDB table names, and ensures a single source of truth for test results.

### Limitations

The CI harness source is only available from a git clone — `npm install` does not include the `infra/` directory.
IAM roles created by the CI stack use `RemovalPolicy.RETAIN` — they persist even if the stack is deleted, preventing permission errors on re-deployment.

See [CI Integration](ci-integration.md) for details on running automated E2E validation.

---

## Troubleshooting

**"No active bootstrap profile found"**
: Run `ml-container-creator bootstrap` to create one, or `bootstrap list` to see existing profiles.

**Stack deployment failed**
: Check CloudFormation console: `https://console.aws.amazon.com/cloudformation/home?region=<region>#/stacks`

**Resources already exist in another profile**
: Bootstrap detects existing `mlcc-bootstrap-*` stacks and reuses them. Only one bootstrap stack per account/region is needed.

**CDK bootstrap required for CI**
: If CDK hasn't been bootstrapped in the target account/region, MCC does it automatically. If it fails, run manually: `npx cdk bootstrap aws://<account>/<region> --profile <profile>`

**"Account ID mismatch" on `bootstrap update`**
: Your current AWS credentials point to a different account than the profile's `accountId`. Switch AWS profiles: `export AWS_PROFILE=<correct-profile>` or re-run bootstrap to create a profile for this account.

**"CI infrastructure already exists in another region"**
: CI is single-region per account. To move it, remove CI from the existing region first (delete the `MlccCiHarnessStack` CloudFormation stack manually, then set `ciInfraProvisioned: false` in the old profile), then re-run `bootstrap --ci` in the new region.

**"ResourceExistenceCheck error for S3 buckets" during `bootstrap update`**
: This is non-blocking. The buckets already exist (they have `DeletionPolicy: Retain`) and are reused by the `do/` scripts via their deterministic names. The CloudFormation error is cosmetic — the stack deploys without managing the buckets, which persist independently. No action needed.
