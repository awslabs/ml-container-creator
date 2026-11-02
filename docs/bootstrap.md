# Bootstrap

Bootstrap provisions the shared AWS infrastructure that MCC projects depend on. Infrastructure is decomposed into **independent, selectively-provisioned modules** — you choose which pieces you need, and each is deployed as its own CDK stack. Run it once per environment; all MCC projects using that profile reuse the same resources.

```bash
ml-container-creator bootstrap add <profile-name>
```

!!! tip "Run bootstrap before your first project"
    If you skip bootstrap, `do/deploy` and `do/push` still work — but you'll need to manually create an IAM role and ECR repository. Bootstrap automates this and gets the permissions right.

!!! info "Command structure"
    Bootstrap commands are symmetric on two axes: **profiles** (`add` / `remove` a `<profile>`) and **modules** (`add-module` / `remove-module` a `<module>`). Running bare `ml-container-creator bootstrap` with no subcommand shows getting-started guidance (if no profile exists) or your current status plus next steps (if one does) — it never provisions anything.

---

## Modules

Bootstrap infrastructure is organized into modules. Only `core` is required; everything else is opt-in.

| Module | Resources | Est. Cost | Required | Depends On |
|--------|-----------|:---------:|:--------:|------------|
| `core` | IAM execution role + ECR repository | ~$1/mo | **Yes** | — |
| `benchmark` | S3 bucket + Glue DB for benchmark results | ~$5/mo | No | core |
| `registry` | Model Package Group + AI Registry Hub | ~$0/mo | No | core |
| `training` | Artifacts bucket (tune/train/optimize output + MLflow store), legacy training/adapters buckets, reward-Lambda role, HyperPod training role (`mlcc-hp-train-role-<region>`), MLflow (best-effort) | ~$2/mo | No | core |
| `ci` | CodeBuild + DynamoDB + StepFunctions + EventBridge | ~$15/mo | No | core, benchmark, registry |
| `sagemaker-domain` | Studio domain + default user profile | ~$10/mo | No | core |
| `eks` | Standalone EKS cluster (VPC, control plane, OIDC, Fargate, CSI/metrics add-ons, inference IRSA role) | ~$73+/mo | No | core |
| `hyperpod` | ⚠️ **DEPRECATED** — HyperPod cluster + Inference Operator | ~$1,300/mo | No | eks |

Each module is a standalone CDK stack named `mlcc-<profile>-<module>` (e.g., `mlcc-default-core`). Modules expose their outputs as CloudFormation cross-stack exports (`mlcc-<profile>-<module>-<ExportName>`), which the next module imports as needed.

!!! danger "`hyperpod` module is DEPRECATED (v2.0.0)"
    HyperPod **cluster provisioning** via `bootstrap add-module hyperpod` is deprecated and
    refuses to run (hidden from the interactive picker). A live rehearsal established that
    MLCC's cluster-creation path does not enable inference at `CreateCluster` time, so the
    inference operator never creates a SageMaker endpoint. **Provision a HyperPod cluster via
    the AWS SageMaker console (Quick Install) or the published CloudFormation templates
    instead** — the `hyperpod-eks` deploy target then works normally against it. A dedicated
    spike (BL153) will decide the long-term HP-native provisioning path. See
    [HyperPod Bootstrap](hyperpod-bootstrap.md) and the
    [EKS/HyperPod migration findings](architecture/eks-hyperpod-migration.md).

!!! info "Module definitions live in the manifest"
    `infra/bootstrap-modules/module-manifest.json` is the single source of truth for module metadata (display name, cost, dependencies, exports). Adding a module is a matter of adding a manifest entry + a CDK stack.

---

## Interactive Setup

```bash
ml-container-creator bootstrap add <profile-name>
```

The flow:

1. **Profile name** — taken from the `add <profile-name>` argument (prompted if omitted)
2. **AWS profile selection** — picks from your `~/.aws/config` profiles
3. **Credential validation** — confirms access and discovers account ID + region
4. **CDK dependency install** — on first run, dependencies for the module stacks are installed automatically into `infra/bootstrap-modules/` (you'll see "📦 Installing bootstrap-modules CDK dependencies")
5. **CDK bootstrap check** — if the account/region isn't CDK-bootstrapped, `npx cdk bootstrap` runs automatically
6. **Module selection** — a spacebar multi-select:
   ```
   Select infrastructure modules to provision:   (descriptions abbreviated)
     ◉ Core Infrastructure — IAM role + ECR repository … (~$1/mo)     (required)
     ◻ Benchmark Infrastructure — S3 bucket + Glue DB … (~$5/mo)
     ◻ Model Registry — Model Package Group + AI Registry Hub … (~$0/mo)
     ◻ Training Infrastructure — Artifacts bucket … + MLflow … (~$2/mo)
     ◻ CI/CD Pipeline — CodeBuild + DynamoDB + StepFunctions … (~$15/mo)
     ◻ SageMaker Studio Domain — Studio domain + default user profile (~$10/mo)
     ◻ EKS Cluster — standalone EKS environment … (~$73+/mo …)
   ```

   The list comes from `infra/bootstrap-modules/module-manifest.json`. The deprecated `hyperpod` module is hidden from new selection (it only appears, marked deprecated, on a profile that already has it).
7. **Dependency validation** — dependencies are **not** auto-added. If you select `ci` without `benchmark` and `registry`, bootstrap stops before provisioning anything and tells you which modules to select as well, so you see every module and its cost.
8. **Provisioning** — selected modules deploy in topological order (dependencies first). Each becomes a `mlcc-<profile>-<module>` CDK stack.
9. **Post-setup chain** — runs `mcp init` → `sync-architectures` → `sync-schemas`

The result is saved to `~/.ml-container-creator/config.json` and becomes your active profile.

!!! tip "Preview first with --dry-run"
    Add `--dry-run` to any provisioning command to see exactly what would happen — the CDK stacks, resources, provisioning order, and profile changes — **without creating anything**.

---

## Non-Interactive Setup

For CI pipelines or scripted provisioning:

```bash
ml-container-creator bootstrap \
  --non-interactive \
  --profile my-aws-profile \
  --region us-west-2 \
  --name production \
  --with benchmark,training
```

The default module set for non-interactive mode is **`core` + `registry`**. Use `--with` to add more (comma-separated). Dependencies are validated, not auto-added: list every module you need.

| Flag | Required | Description |
|---|---|---|
| `--non-interactive` | Yes | Skips all prompts |
| `--profile` | Yes | AWS CLI profile name |
| `--region` | Yes | AWS region |
| `--name` | No | Bootstrap profile name (default: `default`) |
| `--with <modules>` | No | Comma-separated extra modules to provision beyond the `core + registry` baseline |
| `--dry-run` | No | Preview the provisioning plan without creating resources |

!!! note "Legacy flags"
    The pre-v1.2 flags `--ci`, `--benchmark-infra`, `--skip-ci`, `--skip-s3`, and `--role-arn` are retained for backward compatibility but are **no-ops** in the modular flow. Use `--with <modules>` instead (e.g., `--with ci` in place of `--ci`).

---

## Adding and Removing Modules

The primary workflow for incrementally growing your infrastructure:

```bash
# Preview adding a module (no resources created)
ml-container-creator bootstrap add-module training --dry-run

# Add a single module
ml-container-creator bootstrap add-module training

# Preview a removal (shows any dependent-module cascade)
ml-container-creator bootstrap remove-module benchmark --dry-run

# Remove a module (with confirmation)
ml-container-creator bootstrap remove-module benchmark

# Per-module status table
ml-container-creator bootstrap status
```

- **`add`** validates dependencies before provisioning. Adding a module whose dependencies aren't provisioned prompts you to add them first. `add core` is a no-op (core is always present).
- **`remove-module`** checks for dependents first — if another provisioned module depends on the one you're removing, you're warned and offered a cascade. `remove-module core` is rejected (core is required by everything).
- Adding a module never re-provisions existing ones.

!!! warning "S3 buckets persist after teardown (and become unmanaged)"
    The `benchmark` and `training` modules own S3 buckets created with
    `RemovalPolicy: RETAIN`. When you `remove-module` one of these (or tear down
    its stack), **the bucket is NOT deleted** — your data (benchmark results,
    training datasets) is preserved.

    The trade-off: once the stack is gone, the bucket is **unmanaged** — no CDK
    stack owns it. When you re-add the module, MCC detects the existing bucket
    (via `head-bucket`) and **adopts it automatically** rather than failing on a
    name collision. You'll see `♻️  Existing bucket detected — adopting instead
    of recreating` during the re-provision.

    To fully reclaim a bucket's storage and name (e.g., start clean in a region),
    delete it manually before re-adding: `aws s3 rb s3://<bucket> --force`.

    The same RETAIN-and-adopt behavior applies to the `core` module's ECR
    repository (`ml-container-creator`): it survives teardown and is adopted
    automatically on re-provision. To fully reclaim it, delete it first:
    `aws ecr delete-repository --repository-name ml-container-creator --force`.

---

## Profiles

Bootstrap supports multiple named profiles for different AWS environments (e.g., dev vs. prod, or multi-region).

```bash
# List all profiles
ml-container-creator bootstrap list

# Switch active profile
ml-container-creator bootstrap use production

# Check active profile + per-module status
ml-container-creator bootstrap status

# Remove a profile (config only — does not delete AWS resources)
ml-container-creator bootstrap remove staging --force
```

The active profile determines which modules' resources are used by `do/` scripts in all MCC projects.

### Multi-Region Deployments

To deploy in multiple regions within the same account, create a profile per region:

```bash
ml-container-creator bootstrap add mlcc-us-east-1   # Region: us-east-1
ml-container-creator bootstrap add mlcc-us-west-2   # Region: us-west-2
ml-container-creator bootstrap use mlcc-us-west-2
```

Each region gets its own module stacks. The `core` IAM role is an account-level singleton — if it already exists from another region's bootstrap, it's detected and reused rather than recreated.

!!! info "Profile naming convention"
    For multi-region setups, name profiles after their region (e.g., `mlcc-us-east-1`). Module stack names are always `mlcc-<profile>-<module>`.

### Profile Removal

```bash
ml-container-creator bootstrap remove staging --force
```

!!! warning "Metadata-only removal"
    `bootstrap remove <profile>` only deletes the entry from `~/.ml-container-creator/config.json`. It does NOT delete AWS resources. To tear down actual infrastructure, use `bootstrap remove-module <module>` for each module (which runs `cdk destroy`), or delete the stacks via the AWS Console.

### Config File

Profiles are stored at `~/.ml-container-creator/config.json`. A modular profile records the provisioned modules and their outputs, plus **denormalized flat keys** that the `do/` scripts read via `profile.sh`:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": {
      "awsProfile": "my-aws-profile",
      "awsRegion": "us-west-2",
      "accountId": "111111111111",
      "coreS3Bucket": "<core bucket from the core stack outputs>",
      "artifactsS3Bucket": "<artifacts bucket from the training stack outputs>",
      "provisionedModules": ["core", "benchmark", "registry"],
      "moduleOutputs": {
        "core": {
          "RoleArn": "arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role",
          "EcrRepositoryName": "ml-container-creator"
        },
        "benchmark": {
          "BenchmarkBucket": "mlcc-benchmark-111111111111-us-west-2",
          "GlueDatabase": "mlcc_ci"
        },
        "registry": {
          "AiRegistryHubName": "mlcc-registry-111111111111"
        }
      },
      "roleArn": "arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role",
      "ecrRepositoryName": "ml-container-creator",
      "ciBenchmarkResultsBucket": "mlcc-benchmark-111111111111-us-west-2",
      "ciGlueDatabase": "mlcc_ci",
      "aiRegistryHubName": "mlcc-registry-111111111111"
    }
  }
}
```

!!! info "Why both moduleOutputs and flat keys?"
    `moduleOutputs` is the structured source of truth. The flat keys (`roleArn`, `ciBenchmarkResultsBucket`, etc.) are **denormalized** from it on every profile save so that generated `do/` scripts — which read flat keys via `profile.sh` — keep working unchanged. You never edit these by hand.

---

## Runtime Profile Loader

Generated projects include `do/lib/profile.sh` — a shared loader sourced by all `do/` scripts. It reads the active bootstrap profile into `_PROFILE_<key>` shell variables at runtime (for example `${_PROFILE_roleArn}`):

- **No regeneration needed** when switching profiles — run `mcc bootstrap use <profile>` then re-run any `do/` script
- **Precedence**: explicit env var > `_PROFILE_<key>` > default
- **Works on bash 3.2+** (the macOS default) — no associative arrays
- **Graceful degradation**: if `~/.ml-container-creator/config.json` doesn't exist, the `_PROFILE_<key>` variables stay empty and scripts fall back to env vars
- **Bucket names come only from the profile** (`coreS3Bucket`, `artifactsS3Bucket`, ...); a script that needs a bucket stops with an error when its key is missing

This enables workflows where you switch profiles and immediately run `do/deploy` against the new region/account without regenerating the project.

---

## Updating Bootstrap

When you upgrade MCC, module stacks may include new permissions or resources. Re-apply the currently-provisioned modules with:

```bash
ml-container-creator bootstrap update
```

This re-provisions every module in the active profile's `provisionedModules` (in topological order) without prompts, then re-runs the post-setup chain. Sanity checks before updating:

1. **Account match** — your current AWS caller identity must match the profile's `accountId`.
2. **Provisioned set** — only modules already in the profile are re-provisioned; use `bootstrap add-module` to introduce new ones.

```bash
# Preview what would change across all installed modules (cdk diff per module)
ml-container-creator bootstrap update --dry-run

# Apply the updates
ml-container-creator bootstrap update
```

!!! tip "Preview updates with --dry-run"
    `bootstrap update --dry-run` runs `cdk diff` per module and shows exactly what would change — applying nothing. Use it after pulling new template code to see the blast radius before committing.

### Redeploy a single module

To shorten the iteration loop when only one module changed, scope the update to a single module with `--module <name>`:

```bash
ml-container-creator bootstrap update --module registry
```

This deploys only the named module's CDK stack and leaves all other modules untouched. The module must already be in the active profile's `provisionedModules`; if it is not, the command exits with an error listing the available provisioned modules. Running `bootstrap update` without `--module` still redeploys every provisioned module.

---

## MLflow (Training Module)

The `training` module provisions an MLflow tracking app on a **best-effort** basis after the training bucket + role are created. If MLflow isn't available in your region (or the CLI version doesn't support it), provisioning logs a warning and continues — the training module still succeeds.

When present, the MLflow app ARN is surfaced as `MLFLOW_APP_ARN` in generated projects, and `do/tune` prints the tracking URL. Each project logs to its own MLflow experiment, named after the project; whichever of `do/register`, `do/tune`, `do/train` or `do/deploy` runs first creates it, and `do/tune` and `do/train` both log there (see [Custom Training](custom-training.md)). When absent, `do/tune` runs normally without a tracking URL — **it is never a hard dependency**.

---

## IAM Permissions

The `core` module's execution role includes permissions for:

- **Endpoints** — Create, update, delete, describe, invoke (including async)
- **Benchmarking** — AI Benchmark Jobs, Workload Configs, Recommendation Jobs
- **Fine-tuning** — Training Jobs, Model Packages, Hub Contents, MLflow
- **ECR** — Pull images from the `ml-container-creator` repository
- **S3** — Read/write to `mlcc-*` and `ml-container-creator-*` prefixed buckets
- **Secrets Manager** — Read/write secrets with `mlcc/` or `ml-container-creator/` prefix, read `mlcc-hf-token-*`, and `kms:Decrypt` through Secrets Manager for those secrets (see [Secrets](secrets.md#iam-permissions))
- **CloudWatch Logs** — Create log groups/streams for endpoint logging
- **SNS** — Publish notifications for async inference completion
- **Lambda** — Invoke reward functions for RLVR/RLAIF tuning
- **Service Quotas** — Check instance availability

The `training` module adds a separate HyperPod training role, `mlcc-hp-train-role-<region>`, assumed by `do/train` / `do/tune --backend hp-eks` pods through EKS Pod Identity. The generated project's `IAM_PERMISSIONS.md` lists its permissions.

---

## Migrating Legacy (Monolithic) Profiles

If you bootstrapped before v1.2 with the monolithic CloudFormation stack, the interactive flow detects the legacy profile and offers to migrate:

```
Existing bootstrap infrastructure detected. Migrate to modular stacks? [Y/n]
```

Migration is **non-destructive** — it maps your existing profile values (`roleArn`, benchmark bucket, AI Registry hub, CI flags) into `provisionedModules` + `moduleOutputs` without tearing down any resources. Modular CDK stacks are created lazily the next time you run `bootstrap add` or a full interactive setup.

!!! note "Legacy CI harness"
    The pre-v1.2 `infra/ci-harness/` monolithic CI stack is superseded by the `ci` module. It is not removed automatically — remove it manually once you've verified the `ci` module has parity for your workflow.

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

These also run automatically as part of the post-setup chain during initial bootstrap.

---

## All Actions and Flags

`ml-container-creator bootstrap --help` is the authoritative list.

| Action | What it does |
|---|---|
| *(none)* | Status + next steps if a profile exists, else getting-started guidance (never provisions) |
| `add <profile>` / `remove <profile>` | Create a profile (interactive setup + module selection) / remove it (config only) |
| `add-module <module>` / `remove-module <module>` | Add one module to the active profile / tear one down (`cdk destroy`) |
| `add-secret <type> <arn>` | Record a Secrets Manager ARN on the profile (`hfToken` or `ngcApiKey`); see [Secrets](secrets.md) |
| `status [--verify]` | Active profile, per-module state and resources |
| `use <profile>` / `list` | Switch the active profile / list profiles |
| `update [--module <names>]` | Re-provision the profile's modules (or only the named ones) |
| `scan` / `prune` | Discover MCC stacks in the account/region / remove stale profiles |
| `migrate` | Fix legacy profile naming (previews the changes and asks before writing) |
| `sync-schemas` / `sync-model-families` | Refresh local schemas / model family definitions |

| Flag | Use |
|---|---|
| `--dry-run` | Preview provisioning, removal or update without changing anything |
| `--with <modules>` | Non-interactive module list (default `core,registry`) |
| `--module <names>` | `update` only these modules |
| `--force` | Remove without confirmation |
| `--force-delete` | On `remove-module eks` / `hyperpod`, also destroy retained roles and buckets |
| `--skip-teardown` | Forget a module from the profile without a `cdk destroy` (stacks already deleted out-of-band) |
| `--skip-post-setup` | Skip the post-setup chain (mcp init, sync-architectures, sync-schemas) |

---

## Troubleshooting

**"No active bootstrap profile found"**
: Run `ml-container-creator bootstrap` to create one, or `bootstrap list` to see existing profiles.

**"Installing bootstrap-modules CDK dependencies" then a failure**
: The module stacks need `aws-cdk-lib` installed in `infra/bootstrap-modules/`. MCC installs this automatically on first provision. If auto-install fails, run manually: `cd infra/bootstrap-modules && npm install`.

**Module provisioning failed partway through**
: Provisioning aborts on the first module failure — partial progress is not saved to the profile. Fix the underlying error (check the CloudFormation console) and re-run; already-deployed module stacks are idempotent and will be detected as provisioned.

**CDK bootstrap required**
: If CDK hasn't been bootstrapped in the target account/region, MCC does it automatically. If it fails, run manually: `npx cdk bootstrap aws://<account>/<region> --profile <profile>`

**"Account ID mismatch" on `bootstrap update`**
: Your current AWS credentials point to a different account than the profile's `accountId`. Switch AWS profiles (`export AWS_PROFILE=<correct-profile>`) or re-run bootstrap for this account.

**A generated `do/` script reports an empty `ROLE_ARN` / bucket**
: The flat profile keys are denormalized from `moduleOutputs` on save. If a key is empty, the corresponding module may not be provisioned — check `bootstrap status` and `bootstrap add-module <module>` as needed.

**MLflow setup skipped during `training` provisioning**
: This is expected and non-fatal in regions where the MLflow app API isn't available. Tune jobs still run; you just won't get an MLflow tracking URL.

See [CI Integration](ci-integration.md) for details on running automated E2E validation with the `ci` module.
