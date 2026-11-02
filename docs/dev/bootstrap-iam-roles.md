# Bootstrap IAM Roles — the adopted-role (CDK import) limitation

!!! note "Scope: the `eks` module (the `hyperpod` module is deprecated)"
    This page is about the `eks` module's adopted roles, which remain fully supported. The
    `hyperpod` bootstrap module (HyperPod cluster provisioning) is **deprecated** as of v2.0.0
    (see [HyperPod Bootstrap](../hyperpod-bootstrap.md)); where this page mentions self-heal
    during `add-module hyperpod`, that applies to existing/`--force` provisioning only. The
    adopt-drift mechanics below are unchanged and still apply to the `eks` module and to a
    `bootstrap update`.

This page documents a CDK limitation that affects the **RETAIN'd (adopted) IAM
roles** the `eks` bootstrap module provisions, how to recognize it, and the fix
workflow (reconcile the live role, then land the change in the stack via a PR). It
also includes a full inventory of **every bootstrap IAM role, by module** (see
[All bootstrap IAM roles by module](#all-bootstrap-iam-roles-by-module)), noting
which are adopt-drift-prone and which are fully CloudFormation-managed.

## Why some roles are "adopted" instead of created

A few IAM roles are created with `RemovalPolicy.RETAIN` so they survive a
`cdk destroy` / `bootstrap remove-module` — their ARNs stay stable across cluster
rebuilds, and recreating them would collide on the existing name. On a
re-provision, the stack detects the surviving roles and **adopts** them (imports
by name) rather than recreating them. The module runner signals this by injecting
`--context adoptRoles=true` when it finds the roles already exist.

Adoption is the right call for resilience, but CDK imposes a hard limit on what
you can do to an **imported** role.

## The limitation

When a role is adopted (imported via `iam.Role.fromRoleArn(..., { mutable: true })`),
CDK can only partially manage it:

| Role aspect | On CREATE (fresh role) | On ADOPT (imported role) |
|---|---|---|
| Trust / assume-role policy | ✅ set via `assumedBy` | ❌ **CDK cannot modify an imported role's trust** |
| AWS-managed policies | ✅ attached via `managedPolicies` | ❌ **refused** — `addManagedPolicy()` on an imported role no-ops with *"Can't combine imported IManagedPolicy … Use ManagedPolicy directly"* |
| Inline policies | ✅ via `addToPrincipalPolicy` | ✅ works (mutable import emits a standalone `Policy`) |

So an adopted role keeps whatever **trust** and **managed policies** it had when it
was first created. If the stack later adds a new managed policy or a new trust
principal, a **freshly-created** role gets it, but an **adopted** role silently
does **not** — it drifts out of spec.

!!! warning "The symptom is misleading"
    An under-scoped HyperPod instance role surfaces at `CreateCluster`/`UpdateCluster`
    as `Execution role permissions are invalid`, and — confusingly — a *downstream*
    lifecycle-script read failure is reported as `The S3 bucket … is not owned by
    your account. Cross-account S3 buckets are not allowed`. Neither message points
    at the real cause (the role is missing a managed policy or the `ec2` trust
    principal). Check the role's attached policies and trust first.

## How MLCC compensates

- **Inline policies** (ENI permissions, lifecycle S3 read) are re-asserted on both
  paths in `eks/stacks/eks-cluster-stack.ts` — the mutable import makes this work.
- **Trust** and **managed policies** are reconciled at provision time by the module
  runner for **ALL** adopted service roles (which CDK cannot do for an imported role):
    - `_ensureAdoptedServiceRoles(profile)` in
      `infra/bootstrap-modules/module-runner.cjs` iterates the `ADOPTED_SERVICE_ROLES`
      table and, for each of the four roles, re-asserts the full trust principal set
      (`update-assume-role-policy`) and re-attaches the full managed-policy set
      (`attach-role-policy`, idempotent). It runs after the eks-cluster stack deploys,
      so it is in place before HyperPod's `CreateCluster` validation.
    - `ADOPTED_SERVICE_ROLES` is the single source for the desired trust + managed
      policies; a drift test (`hyperpod-cdk-stacks.test.js`) asserts each entry mirrors
      the stack's `_createOrAdoptRole(...)` call, so the two cannot silently diverge.

So no adopted service role is left to manual drift-repair: a `bootstrap update` (or the
dependency re-provision during `add-module hyperpod`) self-heals trust + managed policies
for all four. The manual fix workflow below is only for an immediate out-of-band repair
before you can re-run bootstrap.

## Fix workflow

When an adopted role is under-scoped (a `bootstrap update` left it missing a
managed policy or trust principal because CDK could not touch the imported role):

### 1. Reconcile the live role manually

Attach any missing AWS-managed policies (idempotent — re-attaching is a no-op):

```bash
aws iam attach-role-policy \
  --role-name mlcc-<profile>-<role> \
  --policy-arn arn:aws:iam::aws:policy/<PolicyName> \
  --profile "$AWS_PROFILE"
```

Fix the trust policy if a principal is missing (sets the FULL desired trust doc):

```bash
aws iam update-assume-role-policy \
  --role-name mlcc-<profile>-<role> \
  --policy-document file://trust.json \
  --profile "$AWS_PROFILE"
```

Use the "Impacted roles by stack" table above as the source of truth for what each
role must have.

### 2. Land the change in the stack (PR)

Update `infra/bootstrap-modules/eks/stacks/eks-cluster-stack.ts` so a **fresh**
deploy creates the role correctly, and — if the role should self-heal on
`bootstrap update` — add/extend a provision-time reconciler in
`infra/bootstrap-modules/module-runner.cjs` (follow the
`_ensureHyperPodInstanceRole*` pattern). Then open a PR.

!!! tip "derive-dont-hardcode"
    If you add a provision-time managed-policy reconciler, define the policy list in
    ONE place and add a drift test asserting it mirrors the stack's managed-policy
    array (see `HYPERPOD_INSTANCE_ROLE_MANAGED_POLICIES` and its guard in
    `test/unit/hyperpod-cdk-stacks.test.js`). A silently-diverging second copy is the
    exact class of bug this page exists to prevent.

---

## All bootstrap IAM roles by module

For completeness, here is every IAM role the bootstrap stacks create, by module.
**Only the `eks` module's RETAIN'd service roles are *adopted*** (and therefore
subject to the CDK import limitation above). Every other module role is a plain
`new iam.Role` with **no `RemovalPolicy.RETAIN`**, so CloudFormation fully owns it
and reconciles its trust and policies on every `bootstrap update` — those roles do
**not** suffer adopt-drift and need no manual intervention.

!!! info "How to read the 'Adopt-drift risk' column"
    **Yes** = the role is RETAIN'd + adopted on re-provision, so CDK cannot manage its
    trust/managed policies directly — but the module runner's `_ensureAdoptedServiceRoles`
    reconciles it at provision time, so it still self-heals on `bootstrap update`.
    **No** = CloudFormation-managed every deploy; a stack change applies automatically.

### `core` module (`core/stack.ts`)

| Role (`mlcc-…`) | Trust principal | Policies | RETAIN'd / adopted | Adopt-drift risk |
|---|---|---|:--:|:--:|
| `mlcc-sagemaker-execution-role` | `sagemaker.amazonaws.com` | Large **inline** set (SageMaker endpoints, benchmarking, S3, ECR, logs, PassRole) | No | **No** |

### `training` module (`training/stack.ts`)

| Role (`mlcc-…`) | Trust principal | Policies | RETAIN'd / adopted | Adopt-drift risk |
|---|---|---|:--:|:--:|
| `mlcc-reward-lambda-role-<region>` | `lambda.amazonaws.com` + `sagemaker.amazonaws.com` | AWSLambdaBasicExecutionRole + **inline** read on the training bucket | No | **No** |

(The former `mlcc-training-role-<region>` was deleted — no runtime path assumed it; every job runs as `mlcc-sagemaker-execution-role`, which carries the launch-gate permissions.)

### `ci` module (`ci/stack.ts`)

| Role (`mlcc-…`) | Trust principal | Policies | RETAIN'd / adopted | Adopt-drift risk |
|---|---|---|:--:|:--:|
| `mlcc-ci-codebuild-<profile>-<region>` | `codebuild.amazonaws.com` | **Inline**: DynamoDB (CI table), S3 (benchmark + source buckets), CloudWatch Logs | No | **No** |

### `sagemaker-domain` module (`sagemaker-domain/stack.ts`)

| Role (`mlcc-…`) | Trust principal | Policies | RETAIN'd / adopted | Adopt-drift risk |
|---|---|---|:--:|:--:|
| `mlcc-studio-execution-role-<profile>` | `sagemaker.amazonaws.com` | **Managed**: `AmazonSageMakerFullAccess`, `AmazonS3FullAccess` + **inline** Studio Spaces/Apps | No | **No** |

### `eks` module — adopted service roles (`eks/stacks/eks-cluster-stack.ts`)

These are the **only** adopt-drift-prone roles. See the "Impacted roles by stack"
table earlier on this page for their full policy/trust requirements.

All four are RETAIN'd + adopted, so CDK cannot manage their trust/managed policies on
re-provision — but the module runner's `_ensureAdoptedServiceRoles` reconciles all of
them at provision time, so they self-heal on `bootstrap update` / `add-module`.

| Role (`mlcc-<profile>-…`) | RETAIN'd / adopted | Trust + managed self-healed by runner |
|---|:--:|:--:|
| `eks-cluster-role` | Yes | ✅ |
| `eks-node-role` | Yes | ✅ |
| `hyperpod-instance-role` | Yes | ✅ |
| `fargate-pod-exec-role` | Yes | ✅ |

### `eks` module — IRSA roles (`eks/stacks/eks-cluster-stack.ts`)

Created with `RemovalPolicy.DESTROY` and **always recreated** (OIDC-bound trust must
point at the current cluster's provider), so CDK manages them fully every deploy.

| Role (`mlcc-<profile>-…`) | Trust (OIDC `:sub` service account) | Managed policy | Adopt-drift risk |
|---|---|---|:--:|
| `eks-inference-role` | `default:mlcc-eks-inference-sa` | inline S3 read (core bucket) | **No** |
| `hyperpod-inference-role` | `hyperpod-inference-system:hyperpod-inference-controller-manager` | `AmazonSageMakerHyperPodInferenceAccess` | **No** |
| `alb-controller-role` | `kube-system:aws-load-balancer-controller` | inline ELB/EC2 | **No** |
| `keda-operator-role` | `keda:keda-operator` | inline | **No** |
| `s3-csi-role` | `kube-system:s3-csi-*` | inline S3 | **No** |
| `fsx-csi-role` | `kube-system:fsx-csi-controller-sa` | `AmazonFSxFullAccess` | **No** |

!!! note "Non-role resources are also CloudFormation-managed"
    Other bootstrap modules create non-role IAM-adjacent resources (e.g. the CI
    StepFunctions/EventBridge roles are created inline by their L2 constructs). Those
    follow the same rule: not RETAIN'd → fully CloudFormation-managed → no adopt-drift.
