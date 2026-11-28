---
paths:
  - "infra/**"
  - "src/lib/bootstrap-*.js"
  - "src/lib/e2e-*.js"
---
# Bootstrap and CI infrastructure (CDK)

- **Modules** are defined in `infra/bootstrap-modules/module-manifest.json`. The Node side,
  `src/lib/bootstrap-module-selector.js`, validates dependencies and sorts modules
  topologically. Never auto-add a missing dependency; error instead and name it.
  `infra/bootstrap-modules/module-runner.cjs` runs `cdk deploy` / `destroy` per module. Stacks
  are TypeScript, compiled by the `cdk` CLI (ts-node). Node never imports them. Run
  `npm install` and `npm run build` in `infra/bootstrap-modules/` when you change `.ts`; the
  pre-commit hook builds it.
- **Bucket names** are spelled once, in each stack's `buckets.json`, and rendered by
  `bucket-declarations.ts` (CDK) and `bucket-declarations.cjs` (runtime). If you change one
  renderer, change both. `test/unit/no-literal-bucket-names.test.js` must stay green.
- **RETAIN by default** for anything holding user data or identity: buckets, IAM roles, ECR,
  clusters. Removing these is a separate `--force-delete` path. Adopt-existing is driven by
  SSM params from a prior deploy plus `adopt*` context flags. Keep it idempotent.
- **SSM parameters** are the contract between stacks and the runner. Keep key names in one
  place, and the value of a param must be deterministic (no timestamps) or every deploy diffs.
- **IAM is least privilege.** No `Action: "*"` or `service:*` on `Resource: "*"`. Scope
  resources to `mlcc-*` names, the account and the region. `iam:PassRole` is always scoped to
  specific roles and conditioned on `iam:PassedToService`. No managed `*FullAccess` policies on
  new roles. Don't change IAM outside CloudFormation (`aws iam put-role-policy` from the runner).
  Known violations (the ci-harness CodeBuild role, `sagemaker-domain` managed policies, and
  `_ensureCdkExecRolePassRole`) are tracked in `docs/dev/improvement-plan.md`. Don't copy them.
- **Clusters:** consume, don't provision (ADR-012). The `hyperpod` module is deprecated.
- **CI:** `infra/ci-harness/` is the live CI orchestrator (Step Functions, CodeBuild, scanners)
  and is published in the package. The bootstrap `ci` module is the per-account CodeBuild
  plus results table. Don't add a third CI mechanism.
- Never run `npx cdk`, `cdk deploy` or `aws` without asking. Tests must mock
  `handler._provisionModules`, `_execAws` and `_resourceExists`; otherwise they shell out
  to real CDK.
- Shell commands built from user input (profile names, regions) must use `execFileSync` with
  an argument array, or validate the input first.
