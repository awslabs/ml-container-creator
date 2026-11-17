# Bucket consolidation — Phase 1 report (branch `w6-buckets`, uncommitted)

Spec: `.kiro/specs/v2-w6-03-bucket-consolidation/requirements.md` (R1, R2, R4, plus the R5 docs/tests for those parts).

No AWS changes were made. AWS calls were read-only: `get-template`, `describe-stacks`, `describe-stack-resources`, `list-imports`, `list-change-sets`, `head-bucket`, `describe-mlflow-app`, `sts get-caller-identity`, and `bootstrap import-buckets --dry-run` (which creates no change set). Nothing is committed.

Owner decisions applied after review:
- D4 confirmed: delete `mlcc-training-role`.
- Fix and re-pin the `.benchmark_writer.py` placeholder.
- Accept fail-fast on a missing `artifactsS3Bucket` until the profile is migrated.

## Changes per requirement

### R1 — every MLCC bucket owned by CloudFormation

**R1.2 — one declared source per stack**
- Each owning stack declares its buckets once, in a `buckets.json` next to the stack. Locations: `core/`, `training/`, `benchmark/`, `ci/`, `hyperpod/stacks/` (TLS).
- Each entry holds: name template, adopt context key, CFN output, profile key, env var, import order.
- Two readers:
  - `infra/bootstrap-modules/bucket-declarations.ts` for the stacks (`renderBucketName`, plus `declaredBucket` with RETAIN always).
  - `bucket-declarations.cjs` for the runner, handler and tests. It discovers the files by walking the tree.
- Each stack re-exports its declaration as `BUCKETS`.
- Removed the hand-kept copies of bucket names:
  - `retainedBucketFor` and `retainedAdaptersBucketFor`
  - `_detectRetainedTlsBucket`
  - the `_warnPersistentBuckets` map
  - the core/TLS names rebuilt in the EKS IRSA, HyperPod lifecycle and `module-runner` lifecycle code

**R1.1 — adopt fix**
- `_computeAdoptFlags` now checks stack ownership with `describe-stack-resources` (`_stackOwnedBucketNames`), then decides per bucket with `planBucketAdoption`:

  | Bucket state | Decision |
  |---|---|
  | Owned by this stack | Stays a stack resource |
  | Exists but not in this stack | Adopted by reference |
  | Does not exist | Created |

- If the ownership lookup fails, it throws instead of guessing.
- The TLS bucket goes through the same path.

**R1.3 — training stack**
- `training/stack.ts` gains `ArtifactsBucket`, using the existing physical name `mlcc-tune-<acct>-<region>`.
- Settings: RETAIN, versioning off, SSE-S3, block all public access, and a single lifecycle rule (abort incomplete multipart uploads after 7 days).
- New output `ArtifactsBucketOutput`, exported as `mlcc-<p>-training-ArtifactsBucket`. New adopt context `adoptExistingArtifactsBucket`.

**R1.4 — core stack**
- The models bucket gets two lifecycle rules: `NoncurrentVersionExpiration` 30 days and `AbortIncompleteMultipartUpload` 7 days.

**R1.5 — `bootstrap import-buckets [--dry-run]`**
- Handler `_handleImportBuckets` calls `CdkModuleRunner.importBuckets`. Order comes from the declarations: training → core → benchmark → ci, provisioned modules only.
- For each stack it:
  1. Builds the IMPORT template: the deployed template plus one minimal Retain `AWS::S3::Bucket` per bucket to import.
  2. Creates the change set. Logical IDs come from an offline synth.
  3. Checks it with `assertImportOnlyChangeSet`. If the change set contains anything else, it deletes the change set and aborts.
  4. Executes it and waits for `stack-import-complete`.
  5. Runs the normal deploy (`forceDeploy`).
  6. Saves the profile.
- Idempotent: buckets the stack already owns are skipped.
- Uses argv-form `execFileSync` and cleans up its temp files.

**R1.6 — deletions**
- `TrainingRole`, its policy and `TrainingRoleArnOutput` are deleted. No stack imports that export (checked live).
- Deleted `config/bootstrap-stack.json` (and its `package.json` `files` entry), `_setupS3Buckets`, `_createS3Bucket`, and the delegations to them.
- Deleted the tests that pinned these: `bootstrap-s3`, `bootstrap-tune-resources`, `bootstrap-secrets-iam`, and the S3 property in `bootstrap-idempotency`.
- The SecretsManagerRead scope check moved into the CDK assertion test, against `core/stack.ts`.
- The BL123 launch-gate test now asserts the core execution role.

**R1.7 — MLflow**
- `provision-mlflow.cjs` takes `artifactsBucket` from `moduleOutputs.training.ArtifactsBucket`. It never creates a bucket or builds a bucket name. With no bucket, it returns null.
- `artifactsBucketFromMlflowApp` reads `describe-mlflow-app ArtifactStoreUri`. `bootstrap migrate` uses it to seed `moduleOutputs.training.ArtifactsBucket` and the `artifactsS3Bucket` profile key.

### R2 — zero hard-coding

**R2.1 — names come only from profile keys**
- `_denormalizeModuleOutputs` writes `artifactsS3Bucket`. The key is also added to `DENORMALIZED_FLAT_KEYS`.
- `profile.sh` exports `CORE_S3_BUCKET`, `ARTIFACTS_S3_BUCKET`, `BENCHMARK_S3_BUCKET` and `CODEBUILD_SOURCE_S3_BUCKET`. `MODELS_S3_BUCKET` and `TUNE_S3_BUCKET` remain only as override aliases.
- New `_require_bucket <VAR>`: fails fast, naming both the missing key and the `bootstrap add-module <m>` command that adds it.
- `_resolve_bucket` is removed.

**R2.2 — convention-built names removed (report Q3 list)**
- `do/tune:28` and `:1224-1228`
- `do/optimize:688`
- `provision-mlflow:47`
- `register_evaluator.py:75`: now returns None and the backup is skipped
- `deploy.d/{async-inference,batch-transform}:58`
- `profile.sh` `_resolve_bucket`
- the eks / hyperpod / module-runner core names (now derived from the declarations)
- the `_warnPersistentBuckets` map
- the `do/config:348` comment
- `.benchmark_writer.py` dry-run placeholder: now names the profile key, and the BL082/BL108 hash pin is re-pinned with a note
- `bootstrap-provisioners` dead code
- the prompt text in `infrastructure-prompts`
- `docs/fine-tuning.md` examples
- `IAM_PERMISSIONS.md`
- The notebook generator now reads `artifactsS3Bucket` when the notebook runs, not when it is generated. Its output path is `<project>/tune/<technique>/`.

**R2.3 — bug fixes**
- `do/train`, `do/optimize`, `do/benchmark` and `do/register` take `CORE_BUCKET` from `CORE_S3_BUCKET` / `coreS3Bucket`.
- `do/clean.d/*` (4 files) use `CODEBUILD_SOURCE_S3_BUCKET`, guarded for an empty value.
- The `do/train` default output (and `train-config-builder.js`) is now `s3://<artifacts>/<project>/train/`.

**R2.4 — `test/unit/no-literal-bucket-names.test.js`**
- **Static scan**, comments included. The allowlist is exactly the 7 declaration `"name"` lines; each must exist exactly once and match what is on disk.
- **Behavioral test** with fake bucket names `zz-core-x`, `zz-art-y`, `zz-bench-z` and `zz-src-w`. Covered: `profile.sh`, `do/tune` `_resolve_output_bucket`, the executed notebook cell, `ensureMlflowApp`, and migrate seeding. Each key is also dropped in turn to prove the fail-fast message.
- **Conformance test:** stack source ↔ declaration ↔ CFN output ↔ `_denormalizeModuleOutputs` ↔ `profile.sh` ↔ `_require_bucket` table ↔ `bin/app.ts` adopt contexts ↔ runner flags ↔ manifest exports.
  - The manifest now exports `ModelsBucket`, `SourceBucket`, `ArtifactsBucket` and `RewardLambdaRoleArn`. `TrainingRoleArn` is removed.

### R4 — existing projects keep working

Nothing is moved or deleted. Import only adds the existing buckets to their stacks, and the physical names don't change. Recorded `TUNE_*` paths, model packages and MLflow URIs stay valid. The legacy training and adapters buckets are kept, imported with Retain.

### R5 — docs and tests

- New `docs/architecture/s3-layout.md`: buckets, owners, keys, settings, the declared source, ownership rules, and the import runbook. The Phase 2 layout is a short "coming in Wave 6.1" note.
- Added to `mkdocs.yml`. Updated `bootstrap-iam-roles.md`, `ADDING_FEATURES.md` and `local-development.md`.
- New tests:
  - `test/unit/bucket-adopt-ownership.test.js` (27 tests)
  - `test/unit/bootstrap-bucket-stacks-cdk.test.js`, which drives `infra/bootstrap-modules/test/bucket-stacks.assertions.ts` (aws-cdk-lib/assertions)

## Test results (from the worktree root, after the review fixes)

| Gate | Result |
|---|---|
| `npm test` | exit 0 — 5719 passing, 44 pending (baseline 5687/44) |
| `npm run lint` (also with `--max-warnings 0`) | exit 0. The new test and `.cjs` files also lint clean. |
| `.venv/bin/python -m pytest test/unit` | 1439 passed, 3 skipped (baseline 1438/3). The re-pinned writer-hash test passes. |
| `pytest tests/` (not a required gate) | 13 failures, the same set before and after this change (pre-existing) |
| `cd infra/bootstrap-modules && npx tsc --noEmit -p .` | exit 0 |
| CDK assertion tests | 2 passing: Retain/Retain on all buckets, artifacts unversioned with one abort rule, core lifecycle rules, adopt mode with 0 buckets but outputs kept, training role gone, SecretsManagerRead scope, TS/CJS names agree, logical IDs stable |
| `npm run test:servers:unit`, `validate:doc-commands` | pass; 0 doc errors |
| Property tests `bootstrap-*` + `notebook-export` | 40 passing, 1 pending. A full `test:property` run was interrupted (exit 143) and not repeated. |
| Offline `cdk synth` | training: `ArtifactsBucket2AAC5544` (mlcc-tune, Retain, no versioning, abort after 7 days), `TrainingBucketEB7BB5C9`, `AdaptersBucket91CC3455`; only the reward-lambda role remains. core: `ModelsBucketResource2D4F0B9A`, Retain, both lifecycle rules. |
| Synth vs `main` | eks-cluster (93 resources), hyperpod-cluster, inference-operator, benchmark and ci are all **identical**. The only differences are the intended core lifecycle and training changes. |
| Drift test proven | Adding an sts-built `mlcc-tune` name to `do/optimize` → 1 failure naming `templates/do/optimize:1004`. Reverted → passes. |
| `/bin/bash -n` (bash 3.2.57) | `tune`, `optimize`, `benchmark` and `lib/profile.sh` pass. EJS scripts rendered for realtime / async / batch / hyperpod-eks all pass. No bash-4 constructs added. |
| Live `import-buckets --dry-run` | The plan matches the table below. Every import template equals the deployed template plus only the bucket resources. 0 change sets on any stack before and after. The local config was unchanged. |

## Owner-run sequence (per account + region; repeat for 589351927610)

```bash
ml-container-creator bootstrap migrate                    # seeds artifactsS3Bucket from the MLflow App ArtifactStoreUri
ml-container-creator bootstrap import-buckets --dry-run   # read-only plan
ml-container-creator bootstrap import-buckets             # IMPORT change set → verify → execute → normal deploy, per stack
ml-container-creator bootstrap update                     # second run: no adopt notice, no DELETE_SKIPPED
aws cloudformation describe-stack-resources --stack-name mlcc-<p>-training --query "StackResources[?ResourceType=='AWS::S3::Bucket']"
```

Expected IMPORT change sets (from the live dry run, 258927109213 / us-west-2). Each contains `Import` actions only:

| Stack | Imports | What the follow-up deploy applies |
|---|---|---|
| `mlcc-mlcc-demo-us-west-2-training` | `ArtifactsBucket2AAC5544`, `TrainingBucketEB7BB5C9`, `AdaptersBucket91CC3455` | Bucket properties and tags; artifacts bucket abort-after-7-days rule (versioning stays off); **deletes `mlcc-training-role-us-west-2`**; adds the `ArtifactsBucket` output and removes `TrainingRoleArn` |
| `mlcc-mlcc-demo-us-west-2-core` | `ModelsBucketResource2D4F0B9A` | Noncurrent-version expiry after 30 days, abort after 7 days, tags |
| `mlcc-mlcc-demo-us-west-2-benchmark` | `BenchmarkBucketDD7D1D2F` | Tags and properties (already match live) |
| `mlcc-mlcc-demo-us-west-2-ci` | `SourceBucketResourceB217D9BF` | Tags and properties (already match live) |

The cluster stacks are never touched.

## Could not verify offline

- **Real IMPORT run.** No IMPORT change set was created or executed. Still unconfirmed:
  - that CloudFormation accepts the minimal-property import templates
  - the real `describe-change-set` shape (`Changes[].ResourceChange.Action == 'Import'` is assumed)
  - the follow-up deploy's actual diff and the IAM role removal
- **Migrate seeding.** Exercised only with stubs. The live MLflow App store reads `s3://mlcc-tune-258927109213-us-west-2`, which is the expected seed value.
- **End-to-end `do/` runs.** `do/tune`, `do/optimize` and `do/train` were not run against AWS. Their bucket resolution was tested through extracted functions and `profile.sh`.

## Deviations and notes

1. **Declarations format.** Declarations are per-stack `buckets.json` files, re-exported as `BUCKETS`, so the `.cjs` runner reads the same source without a build. A test checks that the TS and CJS renderers agree.
2. **Narrower drift-test patterns.** The scan flags only code that builds a bucket name. Report examples are still caught. Non-bucket names such as `mlcc-tune-tracking` and the `/tmp/.mlcc-benchmark-latest-*` paths are not flagged.
3. **`.benchmark_writer.py` (owner-approved).** The placeholder is fixed and the BL082/BL108 hash pin is re-pinned with a note. The allowlist is only the 7 declaration lines.
4. **D4.** Owner confirmed deleting the role. The role's `MlccPassRewardLambdaRole` statement was ineffective because nothing assumed the role.
5. **Fail-fast (owner-approved).** `do/tune`, `do/optimize` and the `do/train` default output require `artifactsS3Bucket`. The live profile doesn't have it yet; running `bootstrap migrate` adds it.
6. **Async/batch defaults.** Dropped the dead `asyncS3Bucket`/`batchS3Bucket` keys. Async and batch defaults now come only from the core bucket. `--skip-s3` is still accepted but no longer does anything.
