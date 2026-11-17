# EKS / HyperPod Migration & Live-Rehearsal Findings (BL143 / Wave 2)

This page is the findings-and-migration record for the Wave 2 EKS/HyperPod module
split (BL143). It satisfies the spec's "migration doc" requirement (Req 3.5 — IAM
teardown permissions) and additionally captures everything the **live sim-account
rehearsal** surfaced during bring-up, so the next operator (or a first-time user)
does not rediscover these the hard way.

For the per-role IAM reference and the CDK adopted-role limitation, see
[Bootstrap IAM Roles](../dev/bootstrap-iam-roles.md).

!!! danger "`hyperpod` module is DEPRECATED (v2.0.0) — historical record"
    HyperPod **cluster provisioning** via `bootstrap add-module hyperpod` is deprecated and
    refuses to run (hidden from the interactive picker). Provision a HyperPod cluster via the
    AWS SageMaker console (Quick Install) or the published CloudFormation templates instead;
    the `hyperpod-eks` deploy target works normally against it. The `hyperpod` provisioning
    steps on this page are a historical record and apply only to existing installs (or
    `--force`). See [Bootstrap](../bootstrap.md) and [HyperPod Bootstrap](../hyperpod-bootstrap.md).

---

## TL;DR for a first-time user

- `bootstrap add-module eks` stands up a vanilla EKS cluster you can deploy to with
  `./do/deploy --target eks`. **Vanilla-EKS users stop here.**
- *(Historical — deprecated, see the banner above.)* `bootstrap add-module hyperpod`
  layered the HyperPod cluster + Inference Operator on top. The operator's control plane runs on a **CPU** floor (2 × `ml.c5.4xlarge`) — it
  does **not** need a GPU. GPU compute for model serving is attached on demand as a
  separate instance group.
- A fresh bootstrap on current code includes all the IAM fixes below. The manual
  recovery steps are only for deployments provisioned **before** these fixes landed.

---

## IAM teardown permissions (Req 3.5)

The cutover teardown (`remove-module eks` / `remove-module hyperpod`, or a manual
stack destroy) exercises more IAM than provisioning. A first-time user's role that can
provision may still fail to tear down. The teardown path needs, at minimum:

| Service | Actions (teardown) | Why |
|---|---|---|
| CloudFormation | `cloudformation:DeleteStack`, `DescribeStack*`, `DeleteChangeSet` | Each module is a CFN stack |
| EKS | `eks:DeleteCluster`, `eks:DeleteNodegroup`, `eks:DeleteAddon`, `eks:DeleteFargateProfile`, `eks:Describe*`, `eks:List*` | Cluster + Fargate profile + add-ons |
| SageMaker | `sagemaker:DeleteCluster`, `sagemaker:DescribeCluster`, `sagemaker:UpdateCluster` | HyperPod cluster + instance groups |
| Lambda | `lambda:DeleteFunction`, `lambda:GetFunction`, `lambda:InvokeFunction` | CDK custom-resource providers (e.g. the EKS `KubectlProvider`/`ClusterResourceProvider` nested stacks) |
| IAM | `iam:DeleteRole`, `iam:DeleteRolePolicy`, `iam:DetachRolePolicy`, `iam:DeleteOpenIDConnectProvider` | Roles/OIDC the stacks created (except RETAIN'd service roles) |
| EC2 | `ec2:DeleteVpc`, `ec2:DeleteSubnet`, `ec2:DeleteSecurityGroup`, `ec2:DeleteNatGateway`, `ec2:ReleaseAddress`, ENI deletes | VPC + networking |
| S3 | `s3:DeleteBucket`, `s3:DeleteObject` | Non-RETAIN'd buckets (the TLS bucket is RETAIN'd and is NOT deleted automatically — see Orphan cleanup) |

!!! warning "Cross-account AssumeRole caveat (sim-account finding)"
    In the sim-account run, teardown failed with `AssumeRoleFailed` because the caller
    role in one account could not assume the CDK deploy role
    (`cdk-hnb659fds-deploy-role-...`) in a different account. If you provision and tear
    down across accounts, the caller must be allowed to assume the CDK execution role in
    the target account. This is an environment/trust configuration issue, not a code
    bug — but it blocks teardown silently if missing.

### Orphan cleanup after teardown

`remove-module` always purges the module from the bootstrap profile — even if the CDK
teardown fails — so the profile never carries stale `_PROFILE_*` keys pointing at
destroyed resources. But some resources are intentionally **RETAIN**'d and survive
teardown; clean them up manually if you want a truly empty account:

- RETAIN'd service IAM roles (`eks-cluster-role`, `eks-node-role`,
  `hyperpod-instance-role`, `fargate-pod-exec-role`) — use `remove-module eks
  --force-delete` to also destroy them.
- RETAIN'd buckets: the HyperPod TLS bucket (`mlcc-hyperpod-tls-<profile>`) and the
  core models bucket (`mlcc-core-<account>-<region>`).

---

## Bring-up findings (from the live rehearsal)

These are the issues the live run surfaced and the fixes that shipped. Each is already
in the net-new provision path; the manual steps are recovery for pre-fix deployments.

### 1. Adopted service roles silently drift (the big one)

RETAIN'd service roles are adopted (imported) on re-provision. CDK **cannot** set the
trust policy of an imported role and **cannot** attach a managed policy to one. So an
adopted role froze at whatever it had when first created and drifted out of spec as the
stack evolved. HyperPod then rejected the instance role with **"execution role
permissions are invalid"** — and, confusingly, reported the downstream lifecycle-script
read failure as **"S3 bucket is not owned by your account. Cross-account S3 buckets are
not allowed"** (a same-account bucket). That misleading error cost real debugging time.

**Fix:** the adopt path imports mutably and re-asserts inline policies; the module
runner reconciles the trust policy (`sagemaker` + `ec2` principals) and the managed
policies at provision time (CDK can't). See
[Bootstrap IAM Roles](../dev/bootstrap-iam-roles.md) for the full mechanism and the
manual recovery commands.

!!! tip "Debugging rule"
    If HyperPod reports an invalid execution role OR an S3 "not owned by your account"
    error, check the role's **trust policy and attached policies first** — both symptoms
    trace to the same under-scoped role.

### 2. Inference Operator needs CPU, not GPU

The HyperPod Inference Operator's control plane (gateway controller, controller-manager,
ALB, KEDA — ~13 pods per the AWS operator-install minimum) is CPU/orchestration work.
AWS's documented minimum is `ml.c5.4xlarge`. MLCC's `default-worker` floor is therefore
**2 × `ml.c5.4xlarge` (CPU)**, not GPU. GPU nodes are attached on demand only for
model-serving pods. This decouples "operator healthy" from "GPU capacity available" —
important because GPU capacity is frequently constrained (see finding 5).

### 3. Inference Operator v3.0 S3/ACM tagging permissions

The operator (v3.0+) tags the ALB, S3, and ACM resources it creates, and its startup
validation writes a **tagged** object to its TLS bucket. The custom
`hyperpod-inference-role` therefore needs, beyond `AmazonSageMakerHyperPodInferenceAccess`:

- `s3:PutObject` **and** `s3:PutObjectTagging` on `mlcc-hyperpod-tls-<profile>` (a tagged
  PutObject without the tagging action fails `AccessDenied` on `s3:PutObjectTagging`),
  plus `s3:GetObject` / `s3:ListBucket`.
- `acm:AddTagsToCertificate` on `arn:aws:acm:*:*:certificate/*`.

These are now attached unconditionally (the inference role is an IRSA role, always
freshly created, never adopted — so no reconciler is needed). Pre-fix deployments
self-heal on the next `add-module hyperpod`, or attach the two inline policies manually.

### 4. HyperPod lifecycle script must exist in S3

Every EKS-orchestrated instance group requires a `LifeCycleConfig`. The module uploads a
no-op `on_create.sh` to `s3://mlcc-core-<account>-<region>/hyperpod-lifecycle/` before
cluster create. A manual `update-cluster` that adds an instance group must point
`SourceS3Uri` at that prefix (the directory) with `OnCreate: on_create.sh` (the
filename) — splitting the full object path into the wrong fields fails validation.

### 5. GPU capacity is the gating constraint

GPU instance groups retry until capacity is available in the region; during the
rehearsal, `ml.g5.8xlarge` / `ml.g6.2xlarge` capacity came and went. The CPU operator
floor comes up reliably regardless, so the cluster + operator stay healthy while a GPU
group waits. For model serving, be prepared to wait for capacity or try an alternate GPU
family. This is an AWS capacity reality, not a code limitation.

### 6. The ALB controller runs in the operator's namespace — IRSA trust must allow it

The sharpest find of the rehearsal. The eks module installs the AWS Load Balancer
Controller in `kube-system` (its Helm chart) and binds `alb-controller-role`'s IRSA
trust to `system:serviceaccount:kube-system:aws-load-balancer-controller`. But the
**HyperPod Inference Operator add-on installs its OWN ALB controller** in
`hyperpod-inference-system` (deployment `hyperpod-inference-alb`), under the same SA
name, annotated with that same `alb-controller-role` — and ITS webhook
(`vtargetgroupbinding.elbv2.k8s.aws`, registered as `alb-webhook`) is the one that gates
ingress reconciliation.

That operator-namespace controller presents a token with
`sub = system:serviceaccount:hyperpod-inference-system:aws-load-balancer-controller`,
which a `kube-system`-pinned `StringEquals` trust **rejects**:

```
STS AssumeRoleWithWebIdentity 403 AccessDenied: Not authorized to perform
sts:AssumeRoleWithWebIdentity
```

Result: the ALB never provisions → the ingress (`alb-<endpoint>`) never gets an
`ADDRESS` → the operator's TLS/cert step blocks on "no ingress found in loadbalancer
status" → the `InferenceEndpointConfig` hangs at `DeploymentInProgress` **even though the
model pod is `3/3 Running` and serving 200s on `/ping`**.

!!! warning "Debugging note — this one is deceptive"
    Every individual component verifies correct: OIDC provider registered, role trust
    well-formed, SA annotated, pod IRSA env + token audience (`sts.amazonaws.com`) all
    right. A `kube-system` token even assumes the role fine via the CLI. The ONLY tell is
    that the failing webhook's `clientConfig.service` points at `hyperpod-inference-system`,
    not `kube-system` — i.e. a **second** ALB controller in the operator's namespace. If
    an endpoint hangs at `DeploymentInProgress` with the model pod healthy, check
    `kubectl get validatingwebhookconfiguration alb-webhook -o json` for which namespace
    serves the `elbv2` webhooks.

**Fix:** `alb-controller-role` now trusts the SA **name in any namespace** (a `StringLike`
`system:serviceaccount:*:aws-load-balancer-controller`, via `_createIrsaRole`'s
`saNameAnyNamespace=true`) rather than pinning `kube-system`. This covers whichever
controller — the eks stack's or the operator's — actually serves the ingress. The other
IRSA roles stay exact-namespace-pinned (their namespaces are stack-controlled). Pre-fix
clusters: update the live role's trust to the wildcard sub, then restart the operator's
`hyperpod-inference-alb` deployment so it re-exchanges its token.

### 7. The SageMaker endpoint never gets created unless the cluster is inference-enabled

The final stage of a HyperPod model deploy — creating the managed **SageMaker AI endpoint**
(`CreateModel` → `CreateEndpointConfig` → `CreateEndpoint`) — is gated on the HyperPod
cluster being **inference-enabled** (`describe-cluster` → `InferenceConfig != null`). That
enablement (`EnableClusterInference`) is performed asynchronously by the inference add-on's
controller and takes a **documented 5-15+ minutes**.

MLCC previously (a) delegated enablement entirely to the add-on install and **never verified
it**, and (b) polled the add-on for only **10 minutes** — shorter than the operation it was
waiting on. So the install could return "success" while `EnableClusterInference` was still
running (or had silently not taken), leaving the cluster at `InferenceConfig: null`. The
symptom is maximally confusing: a model deploy's **pods come up `3/3 Running` and serve
200s, the ALB provisions, the cert issues — but no SageMaker endpoint is ever created.** The
operator's `SageMakerEndpointRegistration` controller polls `DescribeEndpoint` forever
(`Could not find endpoint`), the `InferenceEndpointConfig` hangs at `DeploymentInProgress`,
and the deploy driver eventually writes a generic `Failed` after a 15-min timeout with no
hint at the real cause.

!!! warning "The `InferenceConfig: null` signature"
    If a HyperPod model deploy hangs with the model pod healthy and serving but the
    SageMaker endpoint absent (`aws sagemaker list-endpoints` empty, operator only ever
    calling `DescribeEndpoint`), check `aws sagemaker describe-cluster --cluster-name
    mlcc-<profile>-hyperpod --query InferenceConfig`. `null` means cluster inference never
    enabled — the endpoint create is gated on it and will never fire.

**Fix (two layers):**

- **Bootstrap** (`_installInferenceAddon`): the addon poll window is extended to 20 min, and
  after the addon is `ACTIVE` the runner **verifies** cluster inference enablement by polling
  `describe-cluster … InferenceConfig` until non-null (`_ensureHyperPodClusterInferenceEnabled`,
  up to 15 min), surfacing a clear actionable warning instead of a silent "non-blocking"
  success. This also runs on the already-ACTIVE re-run path (addon ACTIVE ≠ cluster enabled).
- **Deploy driver** (`do/deploy.d/hyperpod-eks`): a **fail-fast precondition** probes
  `InferenceConfig` before the reconcile wait and exits immediately with the real cause and
  the "re-run bootstrap" remediation, instead of a 15-min generic timeout.

Pre-fix clusters stuck here: confirm with `describe-cluster … InferenceConfig`; if null,
re-run `bootstrap add-module hyperpod` and let the enablement complete (give it 15+ min),
then redeploy.

### 8. Teardown leaves the inference add-on behind → wedges a recreate

`remove-module hyperpod` runs `cdk destroy` on the module's CDK stacks
(`hyperpod-cluster`, `inference-operator`) and deletes the HyperPod cluster. But the
**inference EKS add-on** is installed OUT-OF-BAND (`aws eks create-addon` in
`_installInferenceAddon`), so it lives in no CDK stack and `cdk destroy` never removes it.
After teardown the add-on remains `ACTIVE` on the eks cluster, carrying a **stale
`hyperpodClusterArn`** pointing at the now-deleted cluster.

That wedges a recreate: a subsequent `add-module hyperpod` creates a NEW HyperPod cluster
with a new ARN, but `_installInferenceAddon` early-returns when it sees the add-on already
`ACTIVE` — so the add-on keeps its stale ARN and the operator tries to enable inference on
the deleted cluster. (Compounds with the "watcher being deleted" transient — see below.)

**Fix (BL143, superseded by BL161):** `teardown` deleted the inference add-on out-of-band,
symmetric with its out-of-band creation. This was an imperative delete papering over an
imperative create.

**Resolution (BL161 — the add-on is now CDK-owned):** the inference add-on is a CDK
resource — `new eks.CfnAddon(this, 'HyperPodInferenceAddon', …)` in
`inference-operator-stack.ts`, mirroring the four sibling `eks.CfnAddon`s in
`eks-cluster-stack.ts`. The normal stack loop materializes it on deploy, and the normal
reverse `cdk destroy` removes it with its stack on teardown — create and destroy are now
**symmetric**. The out-of-band `aws eks create-addon`/`delete-addon` hooks
(`_installInferenceAddon` / `_deleteInferenceAddon`) and the stale-ACTIVE early-return that
wedged a recreate are **gone**: a changed `hyperpodClusterArn` is now a normal stack update,
not a wedge. The add-on `configurationValues` are assembled in the stack from props/context
(no runtime SSM read), preserving the conditional `jumpstartGatedModelDownloadRoleArn`
(included only when present). Two concerns stay as post-deploy module-runner steps because
they are NOT CloudFormation resources: the read-only, warn-not-block cluster-inference
watcher verification (`_ensureHyperPodClusterInferenceEnabled`) and the kubectl post-install
patches (`_postInstallInferenceOperator`). This relies on the BL143 decoupling (below): the
`AWS::EKS::Addon` completes at ACTIVE, independent of the slow async
`EnableClusterInference` — a live `add-module hyperpod` confirm is owed before shipping, and
the `addonVersion` should be pinned once confirmed against a live account.

Pre-BL161 clusters with a dangling out-of-band add-on: delete it manually before re-adding:
```
aws eks delete-addon --cluster-name mlcc-<profile>-eks \
  --addon-name amazon-sagemaker-hyperpod-inference --region <region>
```

### Naming audit (BL161 R4 — ADR-012 Q3 corollary: no rename)

ADR-012's Q3 corollary requires MLCC to conform to the AWS service's naming convention
wherever the control plane resolves a resource by name/prefix, and to impose `mlcc-` naming
only where MLCC **fully owns** the resource. The backlog flagged the TLS bucket as a
suspect; the audit CONFIRMS it (and every other `mlcc-` name) is MLCC-owned — **no rename
needed**:

- The TLS bucket `mlcc-hyperpod-tls-<profile>` is passed EXPLICITLY as the add-on's
  `tlsCertificateS3Bucket` configurationValue, granted IAM by EXACT ARN
  (`HyperPodInferenceTlsBucketAccess` in `eks-cluster-stack.ts`), and the add-on's
  `configurationSchema` for that field requires only the substring `tls` — so the `mlcc-`
  prefix is schema-valid and NOT resolved by a `sagemaker-`/`hyperpod-` prefix convention.
- Census conclusion: every MLCC-chosen name in the eks + hyperpod bootstrap modules is
  either MLCC-fully-owned (passed explicitly / exact-ARN / live handle) or an AWS-canonical
  name (add-on names like `amazon-sagemaker-hyperpod-inference`; chart namespaces/SAs like
  `hyperpod-inference-system` / `aws-load-balancer-controller`) that already conforms. NO
  name is resolved by a `mlcc-` prefix convention.
- Guard: a source-analysis assertion in `test/unit/hyperpod-cdk-stacks.test.js` pins that
  the add-on config references the TLS bucket name explicitly (not by prefix), so a future
  switch to convention-based resolution fails loudly.

!!! warning "Stuck inference watcher after repeated enable/disable"
    Cycling enable/disable/reinstall on one cluster (as happens during debugging) can leave
    the SageMaker-side inference **watcher service** stuck mid-delete:
    `UpdateClusterInference 400 ValidationException: Underlying watcher service is being
    deleted`. This is internal managed state with no public reset. On a sandbox cluster the
    reliable recovery is a **clean recreate** (`remove-module hyperpod` → delete the
    dangling add-on → `add-module hyperpod`), which starts with a fresh cluster and no
    watcher conflict. A first-time deploy on a clean cluster does not hit this.

### Recreate playbook (preserving out-of-band GPU instance groups)

A manually-added GPU instance group (via `aws sagemaker update-cluster`) is NOT in the CDK
stack, so a recreate drops it — re-attach it after. Sequence:

1. `ml-container-creator bootstrap remove-module hyperpod` (destroys the HyperPod cluster +
   clears the stuck watcher; leaves `eks` intact).
2. Confirm the add-on is gone (the teardown fix does this; else delete it manually, above)
   and the cluster is gone (`describe-cluster` → does-not-exist).
3. `ml-container-creator bootstrap add-module hyperpod` *(historical; deprecated, refused without `--force`)* — fresh cluster; wait for
   "✅ Cluster inference capability is enabled" and `describe-cluster … InferenceConfig`
   non-null.
4. Re-attach the GPU group with `update-cluster` (full instance-group set: the CPU
   `default-worker` floor **plus** your GPU group).
5. `./do/submit && ./do/deploy --target hyperpod-eks` — the deploy driver's precondition
   probe confirms inference is enabled, then the SageMaker endpoint is created.

---

## Adopted-role reconciliation covers all four service roles

The provision-time reconciler (`_ensureAdoptedServiceRoles` in `module-runner.cjs`)
re-asserts the trust policy **and** managed policies for **every** RETAIN'd service role
(`eks-cluster-role`, `eks-node-role`, `hyperpod-instance-role`, `fargate-pod-exec-role`)
after the eks-cluster stack deploys — not just the HyperPod instance role. The desired
trust principals + managed policies live in one `ADOPTED_SERVICE_ROLES` table, and a
drift test (`hyperpod-cdk-stacks.test.js`) asserts each entry mirrors the stack's
`_createOrAdoptRole(...)` call, so a stack change that isn't reflected in the runner
fails loudly. See [Bootstrap IAM Roles](../dev/bootstrap-iam-roles.md).
---
## 📌 RESUME PIN — BL143 Wave 2 rehearsal (paused on GPU capacity)

> Parked mid-rehearsal while chasing GPU capacity (and possibly Wave 3 in the meantime).
> The live cluster is on a **hand-patched hotfix**, not a durable state. Pick up here.

### ✅ Q1 RESOLVED (2026-10-15, GPU model deploy observed) — `InferenceConfig` IS the real signal

The parked GPU deploy ran. Decisive result (ground truth from the live cluster):
- The pod deployed, served, and passed inference tests over the ALB — BUT `do/deploy`
  errored at 15 min, and **`aws sagemaker list-endpoints` returns `[]`: NO SageMaker
  endpoint was ever created.**
- Cluster `InferenceConfig` = **`null`**. The `SageMakerEndpointRegistration` CR is stuck
  `state: CreationInProgress` with `DescribeEndpoint ... ValidationException: Could not
  find endpoint "qwen3-4b-test"` and empty endpoint/config/model ARNs. The operator polls
  `DescribeEndpoint` forever for an endpoint it never created — because it only issues
  `CreateEndpoint` once the CLUSTER is inference-enabled, and it isn't.
- The `CertificateProcessingFailed: no ingress found` events were TRANSIENT (x11 during
  ALB provisioning); TLS/cert/ALB all resolved on their own. Not the blocker.
- The InferenceEndpointConfig CR shows `DeploymentComplete` / `readyReplicas:1` on the k8s
  side but top-level `state: DeploymentInProgress` — because SageMaker registration never
  completed. **A serving pod + ALB is INDEPENDENT of SageMaker endpoint registration.**

**Conclusions (these settle the Q1 decision tree — "no endpoint → InferenceConfig real"):**
1. `InferenceConfig: null` is NOT a red herring — it is the genuine blocker. The earlier
   "watcher Enabled while field null" hypothesis is DISPROVEN. KEEP the signal; do NOT
   re-gate on watcher-status / SageMakerEndpointRegistration state.
2. KEEP the gate warn-not-block (it correctly let us observe ground truth instead of
   blocking blind, and a working-pod-without-endpoint is a legitimate partial state).
3. Root cause for THIS cluster: the hand-patched console operator (executionRole
   `SageMakerHyperPodInference-c8d2c2b0`, TLS bucket `hyperpod-tls-0e395cc8-...`) never ran
   `EnableClusterInference`. Patching `HYPERPOD_CLUSTER_ARN` got a working pod but did NOT
   enable cluster inference. The durable MLCC reinstall (step 2 below) runs enablement and
   populates `InferenceConfig`, after which registration completes and `do/deploy` reaches
   terminal success. ⇒ proceed to the clean MLCC reinstall.

### Where the live cluster is right now
- HyperPod cluster ARN: `arn:aws:sagemaker:us-west-2:258927109213:cluster/8ddoe8yjwb85`
  (cluster name `mlcc-mlcc-demo-us-west-2-hyperpod`), EKS `mlcc-mlcc-demo-us-west-2-eks`,
  account `258927109213`, region `us-west-2`.
- The inference operator was **manually installed from the HyperPod/SageMaker console**
  (NOT via MLCC). It came up broken: the console install left `HYPERPOD_CLUSTER_ARN`
  **empty**, the node-label fallback didn't resolve (`cluster name label not found`), and
  the `manager` container crash-looped (exit 1, ~110 restarts).
- **Hotfix applied** to get it healthy: `kubectl set env deployment/hyperpod-inference-controller-manager
  -n hyperpod-inference-system HYPERPOD_CLUSTER_ARN=<the 8ddoe8yjwb85 ARN>`, then scaled the
  old ReplicaSet (`5d4f648fbb`) to 0 so it stopped respawning crash pods. Operator pod is
  now green. **The console's EKS add-on record still shows `CREATE_FAILED`** — that is a
  latched provisioning-time verdict, not current pod health; it will NOT self-clear.
- ⚠️ This hotfix is NOT durable: if the console add-on reconciles / its Helm/CFN re-applies,
  `HYPERPOD_CLUSTER_ARN` reverts to empty and it crash-loops again.
- Console install details observed (random-named, i.e. control-plane-generated, NOT MLCC):
  role `SageMakerHyperPodInference-c8d2c2b0`, TLS bucket `hyperpod-tls-0e395cc8-ac7408e0`,
  gated-download role `inf-0e395cc8-gate-c8d2c2b0`, operator image `v3.7.0` / chart `3.2.0`,
  `describe-addon` showed `createdBy: null, role: null` (= Helm/CFN-style, not a managed add-on).
- kubectl access gotcha: this shell authenticates as `assumed-role/Admin/frgud-Isengard`,
  but the cluster access-entries list `role/mlcc-admin` and NOT `role/Admin`. Either add an
  access entry for `role/Admin` (+ `AmazonEKSClusterAdminPolicy`, scope=cluster) or switch
  the shell to the `mlcc-admin` profile before `update-kubeconfig`.

### 🔁 DECISION (2026-10-15): FULL both-layer teardown + recreate (not incremental, not HP-only)

After Q1 resolved (the hand-patched console operator never enabled cluster inference),
we chose a **full teardown of BOTH the hyperpod AND eks modules, then recreate both from
the fixed code** — rather than an add-on reinstall or an HP-only recreate. Rationale:
- A green result on the hand-healed cluster would be a STALE SUCCESS: it validates the
  artifact, not the generator. The north star is "MLCC bootstraps a cluster and a model
  deploys with NO manual intervention."
- **Decisive reason to also tear down eks (owner):** the eks↔hyperpod resource-sharing
  fixes (adopt-role reconciliation across all 4 service roles, ALB cross-namespace trust,
  EksInferenceRole/OIDC re-wiring) all landed AFTER the last EKS teardown. So the CURRENT
  eks cluster was never built by the corrected code. An HP-only recreate would test the
  operator against an old-style eks base and could mask or falsely trip the resource-sharing
  seam those fixes target. Only a both-layer recreate validates the seam.
- GPU: full teardown DROPS the out-of-band instance groups; re-attach after (command below).
  Owner reliably gets capacity on the current group set within ~1 hour.

**Verification discipline for this run (the REAL BL143 test):** do NOT hand-heal. If
something breaks, diagnose it as a generator bug, fix the code (working tree is live via
`npm link` → ts-node runs `.ts` source directly; `dist/` deleted), re-run. Watch the
`_ensureAdoptedServiceRoles` reconciler output on `add-module eks` — the RETAIN'd IAM roles
are re-ADOPTED (not recreated), which is exactly the adopt-drift seam under test. The OIDC
provider ARN is NEW after the eks recreate; `fromOpenIdConnectProviderArn` must resolve it.

### Teardown / recreate order
```
# Teardown — reverse dependency order (hyperpod depends on eks):
ml-container-creator bootstrap remove-module hyperpod   # HP cluster + operator add-on
ml-container-creator bootstrap remove-module eks        # EKS, OIDC, Fargate, adopted roles
# Confirm removed in BOTH console (describe-cluster → not found; CFN stacks DELETE_COMPLETE;
#   eks list-addons empty) AND profile (module outputs / SSM cleared).
# Recreate — forward dependency order (eks is the base):
ml-container-creator bootstrap add-module eks           # fresh EKS + OIDC + re-adopted roles
ml-container-creator bootstrap add-module hyperpod      # fresh HP + operator on fresh eks
#   watch "✅ Cluster inference capability is enabled" + describe-cluster InferenceConfig non-null
```

### GPU re-attach command (step after `add-module hyperpod`, before deploy)
UPDATED 2026-10-15 for the FRESH cluster (`6xrngxpk4sie`): it starts with ONE group
`default-worker` 2×ml.c5.4xlarge. `update-cluster` is a DECLARATIVE REPLACE — pass the
FULL desired set or you drop default-worker. Below = default-worker (count 2, matching the
fresh cluster) + all 5 GPU variants at target 1 (first-come-first-served capacity). All use
ExecutionRole `mlcc-mlcc-demo-us-west-2-hyperpod-instance-role` and the SAME lifecycle path
(the old `g6-12x` missing-`/hyperpod-lifecycle/`-suffix typo is normalized out here).
Profile is `frgud+mcc-demo-mlcc-admin` (the MLCC profile's awsProfile — NOT the shell's
`...-Admin`; see finding #10). Deploy with `--instance-type <the variant that actually
filled>`, not necessarily g5.16x.
```
aws sagemaker update-cluster \
  --cluster-name mlcc-hyperpod-cluster --region us-west-2 \
  --profile "frgud+mcc-demo-mlcc-admin" \
  --instance-groups '[
    {"InstanceGroupName":"default-worker","InstanceType":"ml.c5.4xlarge","InstanceCount":2,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}},
    {"InstanceGroupName":"g5-16x-worker","InstanceType":"ml.g5.16xlarge","InstanceCount":1,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}},
    {"InstanceGroupName":"g5-12x-worker","InstanceType":"ml.g5.12xlarge","InstanceCount":1,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}},
    {"InstanceGroupName":"g5-8x-worker","InstanceType":"ml.g5.8xlarge","InstanceCount":1,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}},
    {"InstanceGroupName":"g6-12x-worker","InstanceType":"ml.g6.12xlarge","InstanceCount":1,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}},
    {"InstanceGroupName":"g6e-12x-worker","InstanceType":"ml.g6e.12xlarge","InstanceCount":1,"ExecutionRole":"arn:aws:iam::258927109213:role/mlcc-mlcc-demo-us-west-2-hyperpod-instance-role","LifeCycleConfig":{"SourceS3Uri":"s3://mlcc-core-258927109213-us-west-2/hyperpod-lifecycle/","OnCreate":"on_create.sh"}}
  ]'
```

### ✅ EKS layer recreate VALIDATED (2026-10-15, clean from-scratch `add-module eks`)

The full-teardown rationale (resource-sharing seam never built by the fixed code) is now
CONFIRMED GOOD on a clean install. Verified from ground truth (not the CLI ✅):
- Cluster `ACTIVE`; new OIDC provider `...id/6AE3104F3E4DBE9BDCC71501DD5CA71C`.
- SSM repopulated with the NEW OIDC ARN + all 5 role ARNs.
- **IRSA trust re-wiring (the v1.9 create-vs-adopt trap) HELD:** all four IRSA roles
  (eks-inference, alb-controller, hyperpod-inference, keda-operator) trust the NEW OIDC —
  `fromOpenIdConnectProviderArn` resolved the fresh provider correctly from scratch.
- **Adopt-drift fix HELD:** all four adopted roles came up with their FULL managed-policy
  set via `_ensureAdoptedServiceRoles` — including `hyperpod-instance-role` getting
  CNI+ECR+WorkerNode+`AmazonSageMakerClusterInstanceRolePolicy` automatically (the exact
  policies that had to be HAND-attached earlier this session). No manual patch needed.
This is the clean result that lets the nine BL143 fixes be committed with confidence
(pending the hyperpod layer + model deploy below).

### � Q1 RE-RESOLVED (2026-10-15, clean MLCC install, FULL operator logs) — `InferenceConfig` IS the WRONG signal after all

Reproduced on a CLEAN MLCC install (new cluster `6xrngxpk4sie`, correct role/bucket/ARN,
addon ACTIVE, all 7 operator pods 1/1 Running). The deploy's verifier WARNED
"InferenceConfig did NOT enable within 15 min (null)". But the controller-manager logs
show cluster inference **DID enable**:
- 17:44–17:46 retries 1–4 of `EnableClusterInference` fail: `ValidationException:
  Underlying watcher service is being deleted` (old-cluster teardown drain — transient).
- 17:47:03 retry 5: `EnableClusterInference invoked successfully`.
- 17:47→17:50:47 watcher `Enabling`→`Enabled`: *"Desired watcher status reached. Cluster
  inference watcher enabled successfully."* (Also logged "Service side watcher is already
  enabled" at 17:40.)
- YET `describe-cluster InferenceConfig` = **still null** (cluster status InService, addon
  ACTIVE, health issues []).

**VERDICT (flips the earlier hand-patched-cluster conclusion): `InferenceConfig` is NOT the
enablement signal.** The operator tracks enablement via its OWN watcher-status API
(`GetInferenceWatcherStatus` → Enabling/Enabled), and that reached `Enabled` while
`InferenceConfig` stayed null. So the field and the capability are DECOUPLED;
`InferenceConfig: null` is a RED HERRING. The earlier "it's the real blocker" reading came
from the hand-patched console operator that genuinely never enabled — a different failure.

**Two consequences:**
1. MLCC's verifier (`_ensureHyperPodClusterInferenceEnabled`) gates on the WRONG field →
   false-negative 15-min warning on a cluster that IS enabled. FIX: gate on the operator's
   watcher status (Enabled) or the `SageMakerEndpointRegistration` CR state, NOT
   `describe-cluster InferenceConfig`. Also bump the timeout — a recreate-after-teardown
   watcher drain pushes first success past 15 min (here: enabled at ~17:50).
2. The warn-not-block posture (already shipped) was CORRECT — the deploy proceeds past the
   false warning, which is exactly why we could observe this.

**Still to confirm (the irreplaceable ground truth):** does a model deploy actually create a
SageMaker endpoint on THIS cluster while InferenceConfig stays null? If yes → the signal fix
above is confirmed necessary. (Operator says Enabled, so expectation is YES.) GPU re-attach
uses the cluster NAME (unchanged: `mlcc-mlcc-demo-us-west-2-hyperpod`) so the RESUME PIN
command is still valid; the new cluster ARN is `6xrngxpk4sie`.

### � BL143 FINDING #11 (predicted 2026-10-15) — `deploy.d/hyperpod-eks` gates `Running` on the SageMaker endpoint, not the serving pod

EKS ADD-ON vs HELM-CHART INSTALL — NOT a discrepancy (checked 2026-10-15). Investigated
whether operator-not-green is a difference between the EKS add-on (MLCC) and the SageMaker
Helm-chart (console) install, prompted by the recollection that hand-setting
`HYPERPOD_CLUSTER_ARN` on the Helm pod last session flipped it green. Result: NO discrepancy
found. (a) Same operator image/version: the add-on (`v2.1.0-eksbuild.1`) runs
`hyperpod-inference-operator:v3.7.0`, chart 3.2.0, app 3.7 — identical to the Helm install;
the add-on is a packaging wrapper around the same chart+binary. (b) Cluster ARN wired
correctly: controller-manager `HYPERPOD_CLUSTER_ARN` = `...6xrngxpk4sie` = actual cluster ARN
= add-on `configurationValues.hyperpodClusterArn`. The field that was EMPTY on the Helm
install (whose hand-fix flipped it green) is ALREADY SET on the add-on install. (c) Red
herring, do NOT re-chase: `inference-gateway-controller` has no `HYPERPOD_CLUSTER_ARN` — it
is the Envoy Gateway (routing) controller that does not use the ARN by design; healthy 1/1.
Conclusion: last session's "ARN fix → green" worked because the Helm operator's ARN was
genuinely empty; the add-on's is not. If the console is still not-green here it is for a
DIFFERENT, internal-API reason we cannot query. Leading hypothesis (testable on deploy): the
console populates operator-green + Models only once a model CR (workload) exists — "a
workload made it green" last time, with the ARN fix coinciding.

---

### 🧪 Quick Install (console Helm route) structural diff — in progress (2026-10-15)

Running the SageMaker HyperPod console "Quick Install" ALONGSIDE the MLCC add-on (owner
chose to keep both, trust control plane). Its CFN stack
(`infop-us-west-2-mlcc-mlcc-demo-us-west-2-hyperpod`) is a NESTED-STACK orchestration that
provisions a PREREQUISITE SET the MLCC add-on path does not create as part of its install:
`CertManagerStack`, `MetricsServerStack`, `EksOidcProviderStack`,
`InferenceAddonIamRolesStack`, `TLSCertificatesS3BucketStack`, a
`TieredCacheConfigWaitCondition`, AND — notably — a **SageMaker Studio DOMAIN**
(params `DomainName=...-hyperpod-1792090214344`, `UserProfileName=default-user`,
`DomainUserProfileRoleArn`, `DataScientistRole*Namespaces`). This matches the AWS docs read
earlier: Quick Install "creates a new Studio domain with permissions to deploy a JumpStart
model to the cluster." MLCC's path creates NO Studio domain for inference.
**Leading hypothesis for the missing CreateEndpoint:** the Studio-domain / domain-user-role
setup (or the tiered-cache config) may be what the operator needs to actually ISSUE
CreateEndpoint, not just poll. UNCONFIRMED — stack still CREATE_IN_PROGRESS, no endpoint yet,
registration CR still CreationInProgress. (NB: the `mlcc-studio-...` domain currently in
list-domains is MLCC's OWN sagemaker-domain module, NOT the Quick Install one.)
DECISIVE TEST RESULT (CREATE_COMPLETE): **still NO endpoint.** list-endpoints `[]`,
registration CR `CreationInProgress` empty ARN, InferenceEndpointConfig `DeploymentInProgress`.
Quick Install did NOT install a second operator (reused MLCC's add-on operator, controller
age unchanged); it added a Studio domain (`...-hyperpod-1792090214344`), observability stack
(several CrashLoopBackOff — unrelated), and prereqs — and the endpoint STILL was not created.
⇒ it is NOT the install path and NOT the Studio-domain/prereq set. Both hypotheses REJECTED.

### � CORRECTION (2026-10-15) — "Quick Install vs EKS add-on" was a FALSE dichotomy

KEY DISTINCTION (2026-10-15) — TWO different failures both ending in "no endpoint". After the
add-on delete + Quick Install recreate, the controller-manager CrashLoopBackOff'd with the
EXACT session-start error: `HYPERPOD_CLUSTER_ARN environment variable not set ... cluster name
label not found` → exit 1. So there are TWO DISTINCT root causes presenting the same symptom:
(1) CONSOLE/Quick Install path — the add-on it provisions comes up with an EMPTY
`HYPERPOD_CLUSTER_ARN`, node-label fallback fails, operator crash-loops, nothing reconciles;
recovery = `kubectl set env ... HYPERPOD_CLUSTER_ARN=<arn>`. THIS is why MLCC's path works
where the console's doesn't — MLCC `_installInferenceAddon` passes `hyperpodClusterArn` in the
config blob AND `_postInstallInferenceOperator` sets the env var as a post-install patch, so
MLCC already solves failure #1. (2) MLCC path — operator HEALTHY (1/1, ARN set, watcher
"Enabled") yet STILL does not issue CreateEndpoint (polls DescribeEndpoint forever). The
dramatic console crash does NOT overwrite finding #2: a correctly-wired, enabled operator
still didn't create the endpoint. Pending test: ARN-fix the crash-looping console operator;
once healthy, does it create the endpoint? Same-as-MLCC (healthy, no endpoint) → #2 confirmed
independent (AWS item); endpoint appears → new/important.

---

After deleting the EKS add-on and re-running the console Quick Install, its CFN stack shows a
nested `HyperPodInferenceAddonStack` (CREATE_IN_PROGRESS) and `list-addons` STILL contains
`amazon-sagemaker-hyperpod-inference`. ⇒ **Quick Install INSTALLS the EKS add-on itself** (as
one nested stack among its prereq stacks); it is not a separate "Helm operator." This
retroactively explains why the operator image was byte-identical across both paths — THERE IS
ONLY ONE operator (the add-on), and both install routes converge on it. The only real
difference is the SURROUNDING prereq stacks Quick Install adds (Studio domain, cert-manager,
metrics, observability, tiered-cache, IAM). So "add-on vs Helm discrepancy" is permanently
rejected — same operator either way. (Transient during this recreate: deleting the add-on
left the controller-manager CrashLoopBackOff and removed the SageMakerEndpointRegistration CR
— expected mid-recreate, not a new bug. Re-check once HyperPodInferenceAddonStack completes.)

### 🔚 CONCLUSION — not an MLCC bug; operator does not issue CreateEndpoint (needs AWS/operator-level support)

> **UPDATE (2026-09-29): RESOLVED, not a dead-end.** This "needs AWS support" conclusion was
> about MLCC's EKS-FIRST provisioned cluster, where the operator never issued CreateEndpoint.
> It is now SUPERSEDED by the later entries: on a properly HP-NATIVE-provisioned cluster the
> operator issues CreateEndpoint and a real SageMaker endpoint reaches `InService` end-to-end
> (see "✅ DEPLOY-PATH CONFIRMATION (2026-09-29)" below). The fix was never a deploy-time patch
> or an AWS support ticket — it was HP-native PROVISIONING (→ BL153). The reasoning below is
> retained as the historical trail that led there.

### ✅ ENDPOINT ROOT CAUSE CONFIRMED (2026-10-15, healthy-operator deploy + full controller logs)

The stopgap (`inferenceGateway:{enabled:false}` + full HP-shape config) produced the FIRST
clean MLCC operator of the session: controller-manager 1/1 Running, no gateway controller,
watcher "Enabled". Deployed the model anyway. Result: endpoint STILL not created
(registration CR `CreationInProgress`, empty ARN, forever; `do/deploy` errored ~17 min).

**Controller-manager logs are unambiguous:** the ONLY endpoint-related activity is the
`SageMakerEndpointRegistrationReconciler` repeatedly calling `DescribeEndpoint` →
`ValidationException: Could not find endpoint "qwen3-4b-test"`. There is NO
`CreateModel`/`CreateEndpointConfig`/`CreateEndpoint` call, and NO permission/validation
error. ⇒ the operator is NOT trying-and-failing to create the endpoint; it is NOT TRYING at
all. `SageMakerEndpointRegistration` is a *registration/status* controller — it tracks an
endpoint that SOME OTHER component is expected to CREATE. On MLCC's cluster that creator
never runs.

**This definitively eliminates all MLCC add-on CONFIG as the cause** (config now matches the
working HP shape, operator byte-identical + healthy, endpoint still not created). The missing
piece is the CREATOR of the endpoint, upstream of the registration controller.

**Leading hypothesis for the missing creator (strong, MLCC-fixable): the inference-WIRED
domain + data-scientist role/NAMESPACE bindings the HP Quick Install provisions, which MLCC's
domain does NOT provide.** CORRECTION: MLCC DOES have a `sagemaker-domain` module (domain
`mlcc-studio-<profile>`) — but it is a general STUDIO NOTEBOOK domain (read
`sagemaker-domain/stack.ts`): a Studio execution role (Spaces/JupyterServer/S3), a default
user profile, ml.t3.medium JupyterLab. It has NO linkage to the HyperPod cluster, NO
`DomainUserProfileRoleArn` scoped to deploy-to-cluster, and crucially NO
`DataScientistRole*` + `DataScientistRole*Namespaces` (the k8s-NAMESPACE RBAC bindings). The
HP path's `main-stack-inference-operator-addon-template.yaml` creates a domain + those
data-scientist role/namespace bindings specifically "with permissions to deploy a model to
the cluster." So MLCC has A domain but not the INFERENCE-WIRED one. The strongest specific
candidate for the missing CreateEndpoint authorization is the `DataScientistRole<N>Namespaces`
k8s RBAC binding — it may be what authorizes the operator to create an endpoint for a model CR
in that namespace. UNPROVEN from the CLI (the trigger is control-plane-internal); still the
only structural difference consistent with every observation. Ties to the template-adoption
finding below: the published template provisions this wiring; MLCC's hand-rolled path (and its
notebook-oriented sagemaker-domain module) does not.

**NAMESPACE-RBAC HYPOTHESIS TESTED → WEAKENED (2026-10-15).** Checked for the HP
data-scientist RBAC bindings; they ARE present on the cluster (from the earlier Quick Install,
3h+ old): `rolebinding/hyperpod-data-scientist-namespace-role-binding-1` IN THE `default`
NAMESPACE, `clusterrolebinding/hyperpod-data-scientist-cluster-role-binding-1`, and
`clusterrolebinding/hyperpod-inference-manager-rolebinding`. So the cluster now has BOTH
MLCC's add-on config AND the HP Quick Install's full prerequisite wiring (domain + data-
scientist role/namespace bindings + inference-manager CRB) — and the operator STILL only polls
DescribeEndpoint, never issues CreateEndpoint. ⇒ the missing trigger is NOT any
structural prerequisite we can identify/test from the CLI (domain, RBAC, roles all present).

**CORRECTED VERDICT:** we have ELIMINATED, by evidence, every CLI-observable cause — add-on
config (matched HP), operator version (identical), operator health (1/1), cluster ARN, roles,
watcher (Enabled), Studio domain (present), data-scientist namespace RBAC (present). The
`CreateEndpoint` trigger is control-plane-internal and not diagnosable from here. This is now
a legitimate **AWS SUPPORT** case: "HyperPod inference operator v3.7.0 — SageMakerEndpoint
RegistrationReconciler only polls DescribeEndpoint ('Could not find endpoint'), never issues
CreateModel/CreateEndpointConfig/CreateEndpoint, on a cluster with the add-on ACTIVE, watcher
Enabled, operator healthy, and the Quick-Install domain + data-scientist RBAC present."

**EKS-FIRST vs HP-NATIVE provisioning (2026-10-15, owner hypothesis — strongest remaining
lead).** `describe-cluster` on MLCC's HyperPod cluster shows `InferenceConfig` is ABSENT
entirely (not null — not a field on the object at all); top-level keys are
ClusterArn/ClusterName/ClusterStatus/CreationTime/FailureMessage/InstanceGroups/
NodeProvisioningMode/NodeRecovery/Orchestrator/RestrictedInstanceGroups/VpcConfig, and
`Orchestrator: {Eks: {ClusterArn: <the separately-created MLCC eks cluster>}}`. So this HP
cluster carries NO cluster-level inference capability. MLCC provisions EKS-FIRST (create the
`eks` module's cluster → create the HyperPod cluster referencing it); the console Quick Install
is HP-NATIVE (HyperPod cluster is primary, EKS is its orchestrator, in one AWS-orchestrated
flow). HYPOTHESIS: the operator's CreateEndpoint path may require a cluster-level inference
capability that only the HP-native provisioning flow attaches — so EKS-first → no inference
field → operator polls DescribeEndpoint forever. CANNOT PROVE from the CLI (would need to
compare against an HP-natively-created cluster; this is the only HP cluster and Quick Install
reused it). But it is CONSISTENT with every observation and ties the "InferenceConfig red
herring" back in: the field may be exactly the "cluster owns inference" marker, absent because
of EKS-first.

**✅ VERIFIED: AWS's HP-native template IS publicly deployable (2026-10-15).** The published
main-stack resolves (HTTP 200, us-west-2) at:
`https://aws-sagemaker-hyperpod-cluster-setup-us-west-2-prod.s3.us-west-2.amazonaws.com/1/templates/main-stack-inference-operator-addon-template.yaml`
(bucket flattens the GitHub `eks/cloudformation/*` under `1/templates/`; sibling keys:
`inference-operator-main-stack-template.yaml`, `inference-operator-addon-template.yaml`,
`inference-addon-iam-roles-template.yaml`, `main-stack-eks-based-template.yaml`). EVERY
parameter has a default (REQUIRED set is empty) → with defaults it self-provisions the FULL
HP-native stack: own VPC + EKS (`EKSClusterName` default `eks`) + OIDC + cert-manager/FSx/S3-CSI
/metrics add-ons + Studio domain (`CreateDomain:true`) + inference operator + HyperPod cluster.
This de-risks the core BL152 assumption (template is cross-account deployable).

**⭐ TEMPLATE-SOURCE FINDING (2026-10-15) — the HP cluster must be CREATED with inference
enabled; MLCC's creation path doesn't request it.** Reading AWS's published templates (free,
no live cluster needed):
- `main-stack-eks-based-template.yaml` has an explicit **`EnableHPInferenceFeature`** flag
  (+ `EnableHPInferenceAddonFeature`) gating the cluster-creation path via
  `EnableHPInferenceFeatureCondition`. I.e. inference is a CREATION-TIME cluster capability
  you opt into, not something bolted on afterward.
- The HyperPod cluster is NOT created via a declarative `AWS::SageMaker::Cluster` resource —
  it's a **Lambda custom resource** (`hp-lambda-function.zip`) that calls the SageMaker API
  with env vars incl. the inference feature flag + `RESTRICTED_INSTANCE_GROUPS_CONFIG`. The
  actual CreateCluster call + its inference-enable logic is COMPILED in the Lambda (not
  diffable from YAML).
- MLCC side: `hyperpod-cluster/stack.ts` docstring says it "does NOT create a real cluster —
  records configuration intent only"; and grep finds NO `CreateCluster`/`create-cluster` API
  call anywhere in MLCC's infra code (only comments ABOUT CreateCluster preconditions). So I
  could NOT locate where MLCC actually creates the cluster (compiled artifact, missed path,
  or created manually/console earlier). HONEST GAP: unproven WHERE MLCC's CreateCluster is.
- BUT the live evidence is decisive regardless of where it lives: MLCC's resulting cluster
  had NO inference field at all (`describe-cluster` InferenceConfig ABSENT). So MLCC's
  creation path — wherever it is — does NOT pass the `EnableHPInferenceFeature`-equivalent.
  The operator can enable a watcher but cannot retroactively attach cluster-level inference
  never requested at CreateCluster time ⇒ endpoints never created. This is the mechanism,
  now backed by BOTH the describe-cluster evidence AND the template's explicit enable flag.

**This SHARPENS BL152:** the fix is not just "adopt the add-on config template" — it is "the
HyperPod cluster must be CREATED with inference enabled (`EnableHPInferenceFeature=true` /
whatever the CreateCluster API's inference param is)." The cleanest way is to adopt AWS's
cluster-creation path (the Lambda/template that sets this), which is exactly the HP-native
module the owner wants. First confirmation step for the new module: ensure MLCC's CreateCluster
passes the inference-enable flag, then verify `describe-cluster` carries an inference field.

**OPTION A — decisive HP-native test (run before the module rework):**
`aws cloudformation create-stack --stack-name hp-native-test --region us-west-2 --profile
frgud+mcc-demo-mlcc-admin --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
--template-url <the URL above>`. Creates a BRAND-NEW EKS+HyperPod (does NOT touch MLCC's
stacks; tear down after; 2 EKS clusters billing meanwhile). Decisive reads: (1) does
`describe-cluster` on the resulting HP cluster carry an INFERENCE FIELD (the thing MLCC's
EKS-first cluster LACKED)? (2) deploy a model via MLCC's cluster-picker against it → does a
real SageMaker endpoint get created? Endpoint created → EKS-first hypothesis CONFIRMED, and
this template is the blueprint for the new self-provisioning HyperPod module. No endpoint →
EKS-first was not the cause; skip the module rework.

**This REFRAMES BL152:** the fix is not merely "use AWS's template for the add-on config" — it
is "stop forcing HyperPod inference through MLCC's EKS-FIRST module split; adopt the HP-NATIVE
provisioning the published template performs." This does NOT undo the Wave-2 eks/hyperpod split
(vanilla-EKS still reuses the shared eks module) — it means HyperPod-EKS and vanilla-EKS become
TWO SEPARATE TARGET PATHS that happen to both use EKS underneath: vanilla-EKS = plain
Deployment on a shared/BYO eks cluster; HyperPod-EKS = AWS's HP-native inference-operator
template owning its own EKS+HyperPod+domain+inference setup. The template adoption and the
"separate paths" idea are the SAME fix from two angles. Decisive confirmation test (future):
provision a cluster the HP-native way (or via the published main-stack template) and check
whether `describe-cluster` then carries an inference field + the operator issues CreateEndpoint.

**Why ADOPT-THE-TEMPLATE is still the right fix (reasoning SHIFTED):** not "it provisions a
missing prereq" (prereqs are present and it still fails) — but "MLCC should not hand-reconstruct
an install whose endpoint-creation trigger is UNDOCUMENTED and UN-DEBUGGABLE from outside.
AWS's published template is the TESTED path that demonstrably works (Quick Install creates
endpoints). Adopting it means MLCC inherits whatever the invisible trigger is instead of
chasing it blind forever." The fact that loading the cluster with every identifiable HP prereq
STILL didn't make MLCC's hand-rolled path work is the strongest possible argument for not
hand-rolling it. (The four MLCC fixes shipped this session — identity, Running-decouple,
watcher-signal, gateway-patch-skip — all stand regardless.)

### ✅ CONFIRMATION + CORRECTION (2026-10-15) — HP-native cluster works; `InferenceConfig` theory was WRONG

A HyperPod cluster provisioned the HP-NATIVE way (console/CFT: `mlcc-hyperpod-cluster` /
`cluster/61l69r1yp5ru`, orchestrator `sagemaker-mlcc-hyperpod-cluster-...-eks` — it created
its OWN EKS) works with ZERO UI weirdness: operator green, endpoints create, Models tab
populates. This CONFIRMS the deprecation + BL153 direction: AWS's HP-native provisioning works
where MLCC's EKS-first hand-rolled path did not.

**BUT it CORRECTS the earlier mechanism theory (which was WRONG):** `describe-cluster` on this
WORKING cluster also has `InferenceConfig` **ABSENT** — identical to MLCC's broken cluster. So
`InferenceConfig` present/absent tells you NOTHING about whether inference works; it is a
confirmed RED HERRING, and the earlier "EKS-first → no InferenceConfig field → no endpoint"
hypothesis is DISPROVEN. (The working cluster actually has MORE fields — `AutoScaling`,
`ClusterRole`, `RestrictedInstanceGroups` — than MLCC's, but the inference capability is NOT a
visible cluster-object field in either.) This retroactively vindicates one fix we shipped:
re-gating the inference verifier off `InferenceConfig` onto the operator WATCHER STATUS.

**What this means:** the working-vs-broken difference is NOT a single cluster field MLCC could
add — it is the whole HP-NATIVE PROVISIONING ORCHESTRATION (cluster + EKS + operator + domain
created together by AWS's template/console flow). That makes the deprecation + "adopt the
HP-native path" (BL153) MORE clearly correct, not less: there was never a one-line config/field
fix; the hand-rolled EKS-first approach was structurally wrong. The working cluster is a clean,
healthy foundation to deploy against via `--target hyperpod-eks` and to study for the BL153
spike's module design.

### ✅ DEPLOY-PATH CONFIRMATION (2026-09-29) — `do/deploy --target hyperpod-eks` drives a SageMaker endpoint to `InService` on the HP-native cluster + the basic operator

Owner ran a full model deploy through MLCC's retained `hyperpod-eks` deploy target against the
HP-native cluster (EKS `sagemaker-mlcc-hyperpod-cluster-b9ce52cc-eks` / HyperPod
`cluster/61l69r1yp5ru`) with the **basic inference operator** (NOT MLCC's hand-assembled add-on
config). `do/deploy` signalled successful deployment once the `SageMakerEndpointRegistration`
resource was successfully created on the cluster — i.e. the operator reconciled the deploy on a
properly-provisioned cluster, which it never did on MLCC's EKS-first cluster.

**Why this does NOT reverse the deprecation (it REINFORCES the boundary we drew):** this is the
console/CFT-provisioned HP-native cluster — exactly the one the entry above already shows works.
It was NOT provisioned by MLCC's `hyperpod` bootstrap module (still correctly deprecated). The
new, stronger data point is that **MLCC's own `hyperpod-eks` DEPLOY target works end-to-end
against a correctly-provisioned cluster** — which is precisely the line the Wave-2 carve-out
drew: deprecate *provisioning* (the broken EKS-first hand-roll → BL153 spike), KEEP the deploy
target. "Nothing we could have done" (owner) on the provisioning side is the whole BL153 thesis:
the cluster must be CREATED HP-native with inference enabled; no MLCC deploy-time fix substitutes
for that. The four Wave-2 fixes (identity, Running-decouple, watcher-signal, gateway-patch-skip)
+ the `hyperpod-eks` target are all vindicated by this run.

**FULL END-TO-END `InService` CONFIRMED (2026-09-29, complete `do/deploy` log).** This run went
all the way — the SageMaker endpoint the operator NEVER created on MLCC's EKS-first cluster was
created and reached `InService` here:

```
✅ 15:34:53 InferenceEndpointConfig state: DeploymentComplete
⏳ Waiting for SageMaker endpoint 'qwen3-4b-test' to reach InService...
   ✅ 15:34:56 Endpoint status: InService
   Endpoint ARN: arn:aws:sagemaker:us-west-2:258927109213:endpoint/qwen3-4b-test
```

Run shape: `./do/deploy --target hyperpod --reconfigure`, cluster `mlcc-hyperpod-cluster`
(`cluster/61l69r1yp5ru`, EKS `sagemaker-mlcc-hyperpod-cluster-b9ce52cc-eks`), `ml.g5.16xlarge`
g5-16x-worker node, 1 replica, `default` namespace, image
`ml-container-creator:qwen3-4b-test-latest`. Pods went `Init → PodInitializing → 2/3 → 3/3
Running` over ~9 min, `InferenceEndpointConfig` reached `DeploymentComplete`, then the SageMaker
endpoint reached `InService` ~3s later. This is milestone (c) — the operator issued
`CreateModel`/`CreateEndpointConfig`/`CreateEndpoint` end-to-end, the step that polled forever
("Could not find endpoint") on MLCC's broken cluster.

**Two things this settles:**
1. **The `hyperpod-eks` deploy target is end-to-end CORRECT** against a properly HP-native-
   provisioned cluster — `CreateEndpoint` fires, a real endpoint ARN is produced, `do/test`/
   `do/benchmark`/`do/register` are reachable. The Wave-2 decision to KEEP the deploy target
   (deprecate only provisioning) is fully vindicated.
2. **The Wave-2 `Running`-decouple is behaving correctly, not masking.** The advisory endpoint
   poll still actively WAITED for and REPORTED `InService` ("Waiting for SageMaker endpoint ...
   to reach InService" → "✅ Endpoint status: InService") rather than exiting blind — so the
   non-fatal poll surfaces the real terminal state when it genuinely happens.

Net: the deprecation boundary is exactly right. Provisioning (EKS-first hand-roll) is the only
broken part → BL153 spike; the deploy target + the four Wave-2 fixes are proven by a live
`InService` endpoint. "Nothing we could have done" on provisioning holds — but once the cluster
is provisioned HP-native, MLCC's deploy path works start to finish.

### 🏛️ ROOT ARCHITECTURAL FINDING (2026-10-15) — MLCC hand-reimplements an AWS-PUBLISHED CloudFormation template

The decisive discovery behind this ENTIRE session's operator pain. AWS publishes the complete
HyperPod inference-operator install as CloudFormation templates in the PUBLIC repo
`aws/sagemaker-hyperpod-cluster-setup` (`eks/cloudformation/`), hosted at a referenceable S3
URL (`aws-sagemaker-hyperpod-cluster-setup-<region>-prod`; docs show the sibling
`https://aws-sagemaker-hyperpod-cluster-setup.amazonaws.com/templates-*` pattern). The exact
templates MLCC hand-reimplements:
- `main-stack-inference-operator-addon-template.yaml` — the Quick Install orchestrator (the
  `infop-...` stack): Studio domain, OIDC assoc, cert-manager/FSx/S3-CSI/metrics-server
  dependency add-ons, data-scientist roles, retention policies, and the inference add-on, all
  as parameterized nested stacks.
- `inference-operator-addon-template.yaml` — the add-on config CONTRACT as explicit
  parameters: ExecutionRoleArn, TlsCertificateS3Bucket, KedaRoleArn, AlbControllerRoleArn,
  **JumpstartGatedModelRoleArn**, **InferenceGatewayControllerRoleArn**, **EnableInferenceGateway
  (default 'false')**. Installs via a Lambda-backed CUSTOM RESOURCE (not a bare create-addon).
- `inference-addon-iam-roles-template.yaml`, `cert-manager-template.yaml`,
  `metrics-server-addon-template.yaml`, `eks-oidc-provider-template.yaml`,
  `data-scientist-setup-template.yaml`, `inf-sa-creation-template.yaml`, etc.

**MLCC instead:** hand-assembles the `create-addon --configuration-values` JSON in
`module-runner.cjs` + provisions the prereqs via its own CDK. EVERY operator bug this session
(empty HYPERPOD_CLUSTER_ARN, missing/mis-defaulted `inferenceGateway.enabled`, missing
gated-download + gateway-controller roles, IAM/OIDC wiring, "operator pending", the
never-issued CreateEndpoint) is DRIFT between MLCC's hand-rolled version and this published,
AWS-maintained template. The `EnableInferenceGateway` default and the two extra role params
are literally in the published template — we rediscovered them by 30-min live recreates.

**ARCHITECTURAL RECOMMENDATION (reshapes Wave 4 — likely the single highest-leverage change):**
stop hand-reimplementing. MLCC should DEPLOY AWS's published inference-operator template
(nested stack / `create-stack --template-url`) and pass PARAMETERS (cluster ARN, role ARNs,
bucket, enable-gateway, create-domain), letting AWS's tested orchestration own the install —
the ADR-008 "derive from the authoritative source, don't reconstruct" principle applied to
the operator. This deletes the entire drift bug-class. Open design points: pin a template
version/URL (reproducibility); decide create-vs-reuse for the Studio domain + roles MLCC
already provisions (avoid double-provisioning); confirm the template is deployable
cross-account from the prod S3 bucket. Supersedes the earlier "AWS-support" framing — the fix
is MLCC-side after all, but it is ADOPT-THE-TEMPLATE, not patch-the-hand-rolled-blob.
This also makes the interim config-shape fix (inferenceGateway:false etc., just shipped) a
STOPGAP until the template-adoption lands.

---

LEADING HYPOTHESIS (2026-10-15, SUPERSEDES the "AWS-support / not-MLCC" conclusion in this
section) — MLCC's custom add-on params trip a hidden control-plane validation. CORRECTION:
MLCC's operator pod was PENDING / never fully deployed (NOT crash-looping like the console
path's empty-ARN crash). Comparing the two add-on config blobs (both land on the EKS add-on;
the difference is how each PATH builds the config): MLCC (EKS→HP, custom) is MISSING fields
the HP Quick Install (HP→EKS, service-generated) always sets —
`jumpstartGatedModelDownloadRoleArn` (ABSENT in MLCC) and `inferenceGateway: {enabled:false}`
(ABSENT in MLCC) — AND uses custom `mlcc-`-prefixed resource names (TLS bucket
`mlcc-hyperpod-tls-...`, role `mlcc-...-hyperpod-inference-role`) where the service generates
convention names (`hyperpod-tls-0e395cc8-...`, `SageMakerHyperPodInference-6446a130`,
`inf-0e395cc8-*`). HYPOTHESIS (strong, UNPROVEN): missing fields and/or non-convention names
trip a control-plane/operator validation not surfaced as an error → "pod pending, endpoint
never created". HP→EKS works because SageMaker generates a complete, convention-named param
set by construction. (Could NOT fetch the add-on configurationSchema to prove which fields
are required — mlcc-admin lacks eks:DescribeAddonConfiguration.) This reframes the superseded
conclusion below as MLCC-FIXABLE. Experiments (MLCC-side, cheap): (1) add the missing fields
to `_installInferenceAddon`'s blob — `jumpstartGatedModelDownloadRoleArn` (needs a gated-
download role MLCC may have to provision), `inferenceGateway:{enabled:false}`, explicit
`keda.enabled`/`alb.enabled:true` — matching the HP blob SHAPE, keeping MLCC role ARNs; (2)
test naming by using the service-prefix TLS bucket/role names. Run #1 first. If either makes
the endpoint appear → MLCC-fixable root cause. If neither → the superseded AWS-support framing
stands.

SCHEMA CHECK (2026-10-15, fetched describe-addon-configuration for v2.1.0-eksbuild.1 after
granting mlcc-admin eks:DescribeAddonConfiguration). Partially DISPROVES the hypothesis,
surfaces ONE real lead:
- `required: ["executionRoleArn","tlsCertificateS3Bucket"]` — ONLY those two; MLCC sets both.
  `jumpstartGatedModelDownloadRoleArn` and `inferenceGateway` are NOT required → their absence
  is schema-valid. ❌ "missing required fields" DISPROVEN.
- tlsCertificateS3Bucket pattern `^[a-z0-9][a-z0-9.-]*tls[a-z0-9.-]*[a-z0-9]$` requires only
  the substring `tls`. MLCC's `mlcc-hyperpod-tls-mlcc-demo-us-west-2` contains `tls` → MATCHES.
  Role-ARN patterns also match MLCC's `mlcc-`-named ARNs. ❌ "non-convention name rejected"
  DISPROVEN. MLCC's config is SCHEMA-VALID.
- `additionalProperties:false` top-level — but MLCC sends a SUBSET, not extra keys, so fine.
- ⭐ ONE real divergence: `inferenceGateway.enabled` DEFAULTS TO true. MLCC OMITS the block →
  gateway defaults ENABLED. HP Quick Install explicitly sets `inferenceGateway:{enabled:false}`.
  An enabled-but-unconfigured Inference Gateway is a plausible cause of "operator pending /
  not fully deployed" (the gateway controller `inference-gateway-controller` has unmet needs).
  This is the STRONGEST remaining lead — a behavioral config difference, not a validation error.
Caveat: the schema validates SHAPE, not SEMANTIC validity — a schema-valid config can still be
runtime-rejected (e.g. a role lacking a needed trust). "Schema-valid" rules out THIS class only.

REVISED experiment order (most-likely first): (1) set `inferenceGateway:{enabled:false}` in
`_installInferenceAddon`'s blob to MATCH the working HP path (MLCC does not configure a gateway,
so defaulting it ON is wrong); redeploy add-on → does the operator deploy fully + endpoint
appear? (2) If not, add the other HP-blob fields (gated-download role, explicit keda/alb). (3)
If still not → semantic/runtime issue beyond config shape → AWS support with this evidence.

--- (below: earlier conclusion, now SUPERSEDED by the hypothesis above) ---

Every MLCC-controllable variable has been checked and ELIMINATED:
- CR spec COMPLETE + valid: `endpointName`, `instanceType=ml.g5.8xlarge`, `modelName`,
  `modelSourceConfig` (valid S3), `invocationEndpoint`, autoscaling, TLS — all populated.
  No missing endpoint-creation field.
- Operator image identical across install methods (v3.7.0/chart 3.2.0).
- Cluster ARN, IAM role + `AmazonSageMakerHyperPodInferenceAccess`, add-on config — correct.
- Cluster-inference watcher reached `Enabled`.
- All prereqs present (Studio domain, cert-manager, metrics-server, OIDC, TLS) — Quick
  Install added the missing ones, endpoint STILL not created.
- k8s side genuinely complete: `deploymentObjectOverallState: DeploymentComplete`,
  readyReplicas 1, pod serving /ping 200s, TLS cert issued.

The HyperPod inference operator (v3.7.0), given a complete InferenceEndpointConfig on a
fully-provisioned cluster, does NOT issue CreateModel/CreateEndpointConfig/CreateEndpoint —
its SageMakerEndpointRegistration reconciler only POLLS DescribeEndpoint for an endpoint
nothing creates, looping forever on "Could not find endpoint". This is an OPERATOR /
control-plane behavior OUTSIDE MLCC's control and the public API surface. **Action: open AWS
support / operator-level debugging.** Not a generator bug — do NOT keep hunting MLCC config.

Two things that REMAIN MLCC-actionable regardless:
1. **Finding #11 fix (now necessary):** decouple `do/deploy` `Running` from the
   never-created SageMaker endpoint — gate on CRD DeploymentComplete + pod health, treat the
   endpoint as a non-fatal "pending" sub-status. Otherwise MLCC reports Failed for a serving
   deployment.
2. **The InferenceConfig verifier signal fix** (gate on watcher status, not
   `describe-cluster InferenceConfig`) + timeout bump.

### 🔴 ROOT CAUSE (2026-10-15, clean install + model deployed) — operator never ISSUES CreateEndpoint; it only POLLS for one

Decisive live data with a model deployed (pod 3/3 serving, /ping 200s):
- `InferenceEndpointConfig qwen3-4b-test` → `DeploymentInProgress` (k8s side complete, but
  overall never flips).
- `SageMakerEndpointRegistration qwen3-4b-test` → `state: CreationInProgress`, endpoint/
  config/model ARNs all EMPTY. Condition message, looping every few seconds:
  `DescribeEndpoint ... ValidationException: Could not find endpoint "qwen3-4b-test"`.
- `aws sagemaker list-endpoints` → `[]` (no endpoint exists).
- Controller log: `SageMakerEndpointRegistrationReconciler Checking endpoint creation status
  {endpointArn: ""}` → `IsEndpointDeployed` → DescribeEndpoint fails "Could not find
  endpoint" → stays CreationInProgress.

**The registration reconciler is a STATUS-WATCHER, not the creator.** It polls
`DescribeEndpoint` waiting for an endpoint `qwen3-4b-test` to appear, but NOTHING ever issues
`CreateModel`/`CreateEndpointConfig`/`CreateEndpoint`. So it polls forever. This is the gate
behind ALL the symptoms: no endpoint → operator never goes green → console Models tab empty →
`do/deploy` gate 2 (describe-endpoint InService) times out → writes `Failed` (finding #11
confirmed live). The pod serving over the ALB is independent of this.

**This is NOT an MLCC wiring bug.** On this CLEAN install everything MLCC controls is
correct: controller `HYPERPOD_CLUSTER_ARN` = cluster ARN, inference role + managed policy
correct, add-on config correct, cluster-inference watcher reached `Enabled`. Yet the
operator's endpoint-CREATION step (separate from the watcher-enablement step) does not fire.
That logic lives in the operator's internal cluster-inference integration (internal SageMaker
API, not queryable by us). Candidates to investigate OUTSIDE MLCC: operator v3.7.0 /
chart 3.2.0 behavior, whether the InferenceEndpointConfig CRD needs a field MLCC isn't
setting that triggers CreateEndpoint, or an operator/service bug. NEEDS: operator-side
investigation / AWS support — exceeds the public API surface and MLCC's control.

**Immediate MLCC-side consequence (finding #11 fix becomes necessary, not optional):** since
a correctly-deployed, serving model does NOT produce a SageMaker endpoint via this operator,
`deploy.d/hyperpod-eks` gating `Running` on `describe-endpoint InService` is wrong for the
real-world behavior — it reports `Failed` for a working deployment. Decouple `Running` from
the endpoint gate (finding #11 option a/b).

**✅ BOTH MLCC-SIDE FIXES SHIPPED (2026-10-15, uncommitted; tests green 80/80):**
1. `deploy.d/hyperpod-eks` — the SageMaker-endpoint poll is now ADVISORY: short window
   (`HP_ENDPOINT_POLL_WINDOW`, default 120s), never exits, never writes `Failed`; records
   `HP_SAGEMAKER_ENDPOINT_STATUS` as a separate sub-status. `DEPLOYMENT_TARGET_HP_STATUS=
   Running` is written once gate 1 (CRD `DeploymentComplete`, a hard requirement) passes +
   pod healthy — independent of the endpoint. (option b)
2. `module-runner.cjs` `_ensureHyperPodClusterInferenceEnabled` — now gates on the OPERATOR
   WATCHER STATUS (greps the controller-manager log for "watcher enabled successfully" /
   "already enabled" / "Desired watcher status reached") instead of the decoupled
   `describe-cluster InferenceConfig`; timeout bumped 15→25 min for teardown-drain overrun;
   uses `_subprocessEnv` (finding #10); warning text corrected (InferenceConfig is NOT a
   reliable signal). Still non-fatal.
Tests updated in `test/unit/hyperpod-cdk-stacks.test.js` (watcher-status verifier +
endpoint-decoupling, 2 new). NOT fixed by these: the operator not issuing CreateEndpoint
(outside MLCC — AWS support).

---

Owner prediction: "the model will deploy and be usable, but the deploy script won't catch
success and write `DEPLOYMENT_TARGET_HP_STATUS=Running`." Confirmed by reading the driver:
completion has TWO sequential gates:
1. **Gate 1 (CRD state):** poll `kubectl get inferenceendpointconfig <proj> -o
   jsonpath='{.status.state}'` until `DeploymentComplete`. This passes on a healthy deploy
   (we observed DeploymentComplete + readyReplicas:1 earlier).
2. **Gate 2 (SageMaker endpoint):** poll `aws sagemaker describe-endpoint --endpoint-name
   <proj>` until `InService`. On timeout → `_update_config DEPLOYMENT_TARGET_HP_STATUS
   Failed; exit 1`.

`Running` is written ONLY after BOTH gates pass (line ~1007). So the status is gated on a
SageMaker ENDPOINT existing + reaching InService — the exact thing that never materialized
on the hand-patched run (SageMakerEndpointRegistration stuck CreationInProgress,
DescribeEndpoint "Could not find endpoint"). If the operator-managed endpoint is not created
(or describe-endpoint can't find it), a pod that is serving traffic fine still yields a
`Failed` status write + exit 1.

**Interpreting the live deploy:** a `Failed` write means GATE 2 failed (no InService
endpoint), NOT that the k8s deployment failed. Correlate with: CRD reached DeploymentComplete
(gate 1 ok) + pod serving + `list-endpoints` empty ⇒ gate-2-only failure.

**The fix is a DESIGN decision (do after the live result):** should hyperpod-eks `Running`
mean "pod serving" (gate 1 + pod health) or "SageMaker endpoint InService" (gate 2)? If the
operator's SageMaker-endpoint registration is flaky/slow/opaque (as seen all session),
gating `Running` on gate 2 reports Failed for deploys that actually serve. Options: (a) write
`Running` after gate 1 + a direct pod-health/readiness check, treat the SageMaker endpoint as
a SEPARATE optional status; (b) keep gate 2 but make it non-fatal (warn + write Running with
an "endpoint pending" sub-status) — mirrors the warn-not-block posture already taken on the
InferenceConfig precondition; (c) keep as-is if the endpoint IS reliably created on a clean
install. Decide from the live outcome.

### �🔎 Operator-registration investigation (2026-10-15, option 2) — no kubectl-visible gate; console internal API is the only authoritative source

Prompted by: console shows operator pending/not-green (and the "Models" tab only appears
when green), contradicting `kubectl` showing pods healthy. Investigated whether a
control-plane self-registration gate is unsatisfied. Findings (all read-only):
- Controller-manager Deployment: `Available=True`, `Progressing=True
  (NewReplicaSetAvailable)` — no degraded condition.
- Controller fully initialized: validating + conversion webhooks registered, the
  `SageMakerEndpointRegistration` controller logged "Starting workers" (17:44), watcher
  "already enabled" (17:40). A fully-started operator, not one stuck registering.
- All inference CRDs installed; ZERO CRs of any kind (expected — no model deployed yet;
  this is also why the console "Models" tab is empty).
- **No public API exposes the operator's control-plane registration state.** boto3
  SageMaker surface has only classic inference ops (InferenceComponent / InferenceExperiment
  / InferenceRecommendations) + DescribeCluster. The operator's `EnableClusterInference` /
  `UpdateClusterInference` / watcher-status calls hit an INTERNAL/undocumented API; the
  console reads that same internal API. `describe-cluster` has NO `InferenceConfig` field at
  all on this cluster object (querying it returns null because it is absent).

Additional checks (2026-10-15, after the investigation above):
- EKS Add-on page "Additional Information" (= add-on `configurationValues`) shows MLCC's
  CORRECT config: `hyperpod-inference-role` (not console's c8d2c2b0), MLCC TLS bucket, new
  cluster ARN `6xrngxpk4sie`, MLCC alb/keda roles. Add-on install confirmed correct.
- `hyperpod-inference-role` trust = IRSA scoped to the NEW OIDC (`6AE3104F...`), SA
  `hyperpod-inference-system:hyperpod-inference-controller-manager`, aud sts — correct.
  Managed policy `AmazonSageMakerHyperPodInferenceAccess` attached. The operator's
  successful `EnableClusterInference` call corroborates the role works (would AccessDeny if
  not). Role is NOT the gate.
- Observed asymmetry: the HP (SageMaker) console Inference view shows MISSING role data /
  operator not-green, while the EKS add-on page is fully populated. First concrete split
  between the two consoles — but unexplainable from any queryable surface (internal API).

**Conclusion:** by EVERY signal reachable from kubectl/CLI/IAM, the operator is healthy,
correctly wired, and registered — NO visible broken gate. The console's green/pending state and the "Models"
list are driven by an internal SageMaker API we cannot query, so the console is MORE
authoritative here but not reproducible on our side. Two live possibilities, distinguishable
only by the deploy: (1) the console "pending" was STALE (operator finished starting
controllers ~17:44, enablement ~17:50 — if viewed now it may be green; empty Models tab just
means no model yet), or (2) a genuine internal registration gate the CLI can't see. The
model deploy + the console Models tab is the decisive test. (Prior over-correction retracted:
"pods Running + watcher Enabled" is matched by Available=True + started reconcilers; no
hidden kubectl gate found.)

### �🐞 BL143 FINDING #10 (2026-10-15, clean-recreate `add-module hyperpod`) — identity split between AWS-CLI calls and helm/kubectl

**Symptom:** `add-module hyperpod` printed `✅ EKS cluster-admin access granted to
...role/mlcc-admin` then immediately failed the Helm install with
`kubernetes cluster unreachable: the server has asked for the client to provide credentials`.

**Root cause (confirmed):** the bootstrap grants the EKS access entry using the MLCC
PROFILE's identity (`aws ... --profile ${profile.awsProfile}`, here
`frgud+mcc-demo-mlcc-admin` → `role/mlcc-admin`), but the `helm`/`kubectl` subprocess it
spawns has NO `--profile` flag (helm doesn't take one) and so inherits the OPERATOR'S
SHELL identity via the ambient `AWS_PROFILE` env var (here `frgud+mcc-demo-Admin` →
`role/Admin`). The two subprocesses resolve DIFFERENT IAM roles. The access entry is
created for `mlcc-admin`; the helm token is minted for `Admin`, which has no entry → auth
rejected. `aws eks update-kubeconfig` also writes an exec block with no profile, so the
kubeconfig token follows ambient env too.

**Confirmed by:** `config.json` activeProfile `mlcc-demo-us-west-2` has
`awsProfile: frgud+mcc-demo-mlcc-admin` (assumes `mlcc-admin`); the operator's shell had
`AWS_PROFILE=frgud+mcc-demo-Admin` (assumes `Admin`). `list-access-entries` showed
`mlcc-admin` but NOT `Admin`.

**Unblock used (NOT the fix — an env correction):** operator set shell to the mlcc-admin
profile so helm inherits the same identity the access entry was granted to; the run then
proceeded. This confirms the diagnosis but does NOT fix the generator.

**DURABLE FIX (code, still TODO — BL143):** make the helm/kubectl subprocesses use the
SAME identity as the bootstrap's AWS-CLI calls, independent of ambient shell env. Options:
(a) export `AWS_PROFILE=${profile.awsProfile}` (+ `AWS_REGION`) into the execSync env for
every helm/kubectl call in `module-runner.cjs` (authoritative — MLCC profile wins), and/or
(b) `aws eks update-kubeconfig ... --profile ${profile.awsProfile}` so the kubeconfig exec
block bakes the profile in. Prefer (a)+(b): the MLCC profile is the source of truth for the
deploy; ambient `AWS_PROFILE` must not be able to diverge from the identity the access
entry was granted to. Add a regression note; this fails for ANY operator whose shell
`AWS_PROFILE` ≠ the profile's `awsProfile`.

### Next steps, in strict order (do NOT reorder — step 1 is irreplaceable)
> ⚠️ The step 1/2 below are DONE / SUPERSEDED by the live rehearsal (2026-10-15). The signal
> observation was captured, the endpoint root cause was localized, and 4 MLCC fixes shipped.
> See the "ENDPOINT ROOT CAUSE CONFIRMED" + "CORRECTED VERDICT" sections above for the live
> result. The CURRENT next steps are in "Next steps after the rehearsal" below.

1. ~~GPU → deploy → capture the signal.~~ DONE. Signal captured: the deploy proceeds past a
   null `InferenceConfig` (warn-not-block, shipped), the operator comes up healthy with the
   config fix, but NO SageMaker endpoint is created — the operator only polls DescribeEndpoint,
   never issues CreateEndpoint, even with every identifiable prereq present. `InferenceConfig`
   confirmed a red herring; verifier re-gated on watcher status (shipped).
2. ~~Contention test / restore durable state.~~ Overtaken by events — the cluster went through
   multiple full recreates; the endpoint root cause is now the open item, not contention.

### Next steps after the rehearsal (current)

1. **AWS support case (parallel, external).** File: "HyperPod inference operator v3.7.0 —
   SageMakerEndpointRegistrationReconciler only polls DescribeEndpoint ('Could not find
   endpoint'), never issues CreateModel/CreateEndpointConfig/CreateEndpoint, on a cluster with
   the add-on ACTIVE, watcher Enabled, operator 1/1, and the Quick-Install Studio domain +
   data-scientist RBAC bindings present. Console Quick Install creates endpoints on the same
   cluster; MLCC's add-on install does not. What triggers CreateEndpoint?" Attach the
   controller-manager logs.
2. **BL152 — adopt AWS's published inference-operator CFT** (tracker; the real MLCC-side fix).
   Stop hand-reconstructing the install; deploy AWS's template + pass parameters. Reasoning:
   even with every identifiable prereq loaded onto the cluster the hand-rolled path still
   couldn't create an endpoint, so the trigger is un-debuggable from outside — adopt the
   tested template that demonstrably works. First spike step: verify the template is deployable
   cross-account from `aws-sagemaker-hyperpod-cluster-setup-<region>-prod`, read its full
   parameter + Create*/Retain* surface, and design create-vs-reuse reconciliation against
   MLCC's existing `eks` + `sagemaker-domain` modules.
3. **Commit the session's 4 shipped MLCC fixes** (identity split / `_subprocessEnv`,
   Running-decouple from endpoint, watcher-status verifier signal, gateway-patch-skip) + the
   config stopgap (`inferenceGateway:{enabled:false}` + full HP-shape blob) + the test updates.
   These are independent of the endpoint root cause and all stand. Also fold the access-entry
   friction into finding #10 (a fresh MLCC cluster needs the admin principal's access entry +
   policy association to actually authorize kubectl; the bootstrap should grant to a
   configurable admin list and wait-verify it is live).

### Decisions locked this session (so we don't relitigate)
- **Keep operator install automated in MLCC — do NOT offload to the console.** Proven: the
  console path shipped a crash-looping operator (empty ARN) out of the box. MLCC's
  `_installInferenceAddon` avoids it by passing `hyperpodClusterArn` (from SSM) in the config.
- **EKS Add-on over Helm.** AWS positions the add-on as the forward path (Operator 3.0+
  "simplified lifecycle management"; Helm installs are expected to migrate to it). MLCC
  already uses the add-on path — stay there.

### Wave 4 backlog (structural, future — informed by steps 1–2 above)
> **✅ UPDATE (2026-10-19, BL161 implemented — spec `v2-w4-05-bl161`).** The first two bullets
> below are DONE; the third is deferred to BL162. Key caveats recorded for BL162:
>
> - **(a) DONE — add-on is a CDK-owned `eks.CfnAddon`.** The inference add-on is now
>   `new eks.CfnAddon('HyperPodInferenceAddon', addonName: 'amazon-sagemaker-hyperpod-inference',
>   resolveConflicts: OVERWRITE)` in `inference-operator-stack.ts` (config built from stack
>   props, not an SSM read). The imperative `_installInferenceAddon`/`_deleteInferenceAddon`
>   functions + their deploy/teardown hooks + the stale-`ACTIVE` early-return wedge are REMOVED;
>   create/destroy are now symmetric through CloudFormation. The kubectl post-install patches +
>   the read-only watcher verification (`_ensureHyperPodClusterInferenceEnabled`) remain as a
>   post-deploy module-runner step (`_postDeployInferenceOperator`). `tsc` + lint + full test
>   gate green. OWED a live `add-module hyperpod` confirm of two things: OQ-1 — that
>   `AWS::EKS::Addon` ACTIVE is DECOUPLED from the slow async `EnableClusterInference` (so the CFN
>   create does not time out); OQ-2 — pin `addonVersion` (currently OMITTED = resolves default,
>   identical to the old imperative path) via `aws eks describe-addon-versions`.
> - **(b) DONE — naming audit = confirm/document/guard, NO rename.** The TLS bucket
>   `mlcc-hyperpod-tls-<profile>` is VERIFIED MLCC-owned: passed explicitly as the add-on's
>   `tlsCertificateS3Bucket`, granted by exact ARN, and the add-on schema needs only the
>   substring `tls` — nothing resolves it by a `sagemaker-`/`hyperpod-` PREFIX. The full census
>   found ZERO convention-resolved `mlcc-` names. Documented in-code + guarded by a drift test.
> - **(c) DEFERRED to BL162 — IRSA relocation + operator-recreate spike.**
> - **⚠️ REACHABILITY CAVEAT (for BL162).** The hardened CfnAddon install lives in the
>   `inference-operator` stack, which is welded to the DEPRECATED `hyperpod-cluster` provisioning
>   stack inside the single `hyperpod` module (`stacks: [hyperpod-cluster, inference-operator]`).
>   So it is only reachable via `add-module hyperpod --force` (plain `add-module hyperpod` refuses
>   on `deprecated:true`); there is NO independent `add-module inference-operator`-only path. On
>   the SUPPORTED route (console/CFT-provisioned cluster → `do/deploy --target hyperpod-eks`) the
>   operator add-on is installed by AWS's provisioning, NOT by MLCC. BL162 must decide whether
>   AWS's HP-native CFT installs the add-on itself (making MLCC's CfnAddon a bridge to retire) or
>   whether to split `inference-operator` into its own non-deprecated module so the CfnAddon is
>   reachable against a BYO cluster.

- Move the inference add-on into **CDK ownership (`CfnAddon`)** so teardown/recreate stop
  needing the imperative `_deleteInferenceAddon` hack and the stale-ARN recreate wedge.
- **Naming-convention alignment (Q3).** The operator derives the cluster ARN from the
  cluster *name* and may resolve other resources by convention. MLCC's deterministic
  `mlcc-`-prefixed names (e.g. TLS bucket `mlcc-hyperpod-tls-${profileName}` at
  module-runner.cjs ~L950) may diverge from what the operator/SageMaker expect (prefixes
  like `sagemaker-` / `hyperpod-`). TODO: verify whether a hard bucket-prefix check exists;
  prefer letting the control-plane name resources it resolves by convention, imposing MLCC
  names only where we fully own the resource and nothing downstream resolves it by name —
  in so far as CDK allows.
- Fold in the operator-IRSA relocation spike + the "recreate operator from SageMaker
  HyperPod rather than the EKS add-on" question here.
