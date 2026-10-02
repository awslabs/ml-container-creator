<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Adding a Deployment Target

> **Audience.** Human or AI maintainers adding a new `DEPLOYMENT_TARGET` to MLCC
> — a new place a model can be deployed and operated. This is the deployment-side
> analogue of the [serve-engine plugin authoring guide](serve-engine-plugin-authoring.md):
> where that guide adds a *serving engine*, this one adds a *deployment target*.
>
> Read [do-scripts.md](do-scripts.md) first for the `do/` subsystem and the
> target model, and [do-script-contract.md](../do-script-contract.md) for the
> per-script contract. [ADR-007](../adr/ADR-007-do-script-contract-enforcement.md)
> records why the contract is enforced.

## What a deployment target is

A deployment target is a value of `DEPLOYMENT_TARGET` (set in `do/config`) that
selects **where and how** a model runs. `do/deploy` is a thin dispatcher: it
routes to `deploy.d/<target>` based on `DEPLOYMENT_TARGET`. The active target
also changes how the operate/teardown verbs (`do/test`, `do/logs`, `do/status`,
`do/clean`, `do/benchmark`, `do/adapter`) behave.

The existing targets are `realtime-inference`, `async-inference`,
`batch-transform`, `hyperpod-eks`, and `eks`. They fall into two families:

- **SageMaker-endpoint targets** (`realtime-inference`, `async-inference`,
  `batch-transform`, and `hyperpod-eks` — which registers a SageMaker endpoint
  via the operator). Verbs that need a SageMaker endpoint work.
- **Direct-Kubernetes targets** (`eks` — vLLM as plain k8s pods, no SageMaker
  endpoint). Serving-pod verbs reach the pod via `kubectl port-forward`; verbs
  that need a SageMaker endpoint do not apply.

Knowing which family your target belongs to tells you which verbs should accept
it and which should refuse it (via `_restrict_targets` / `_contract_violation`).

## Environment variables & naming conventions

All target state and config lives in `do/config` as `export UPPER_SNAKE=value`
lines (the only shape the JS parser reads — see
[do-scripts.md](do-scripts.md#the-shelljs-config-seam)). The variable *name*
encodes both its **namespace** (which subsystem owns it) and its **lifecycle**
(who writes it and whether `regenerate` preserves it). Get these two right and a
new target behaves; get them wrong and you either clobber live deployment state
or leak config across targets.

### Naming namespaces (prefixes)

| Prefix | Owns | Examples |
|---|---|---|
| `DEPLOYMENT_TARGET` | the active target + its per-target **state** | `DEPLOYMENT_TARGET`, `DEPLOYMENT_TARGET_<T>_STATUS` |
| `HP_*` | Kubernetes-target config (HyperPod EKS **and** plain `eks`) | `HP_CLUSTER_NAME`, `HP_NAMESPACE`, `HP_GPU_COUNT`, `HP_LORA_ENABLED`, `HP_SPECULATIVE_*` |
| `SMAI_*` | SageMaker managed-inference specifics | `SMAI_ENDPOINT_NAME` |
| `ASYNC_*` / `BATCH_*` | async / batch-transform target config | `ASYNC_MAX_CONCURRENT_INVOCATIONS`, `BATCH_SPLIT_TYPE` |
| `IC_ENV_*` | env vars **passed through** to the serving container / Inference Component | `IC_ENV_VLLM_MAX_MODEL_LEN`, `IC_ENV_HF_TOKEN_ARN` |
| `SERVING_*` | the target-agnostic serving-config abstraction (BL101) that `deploy.d/*` writes and `do/benchmark` reads | `SERVING_INSTANCE_TYPE`, `SERVING_TENSOR_PARALLEL` |
| `VLLM_*` / `SGLANG_*` / `TGI_*` | engine runtime knobs | `VLLM_TENSOR_PARALLEL_SIZE`, `VLLM_MAX_MODEL_LEN` |
| `_PROFILE_*` | profile-resolved values emitted by `profile.sh` (read-only in scripts) | `_PROFILE_ecrRepositoryName` |

**Choosing a namespace for a new target.** If your target is Kubernetes-based,
reuse `HP_*` (as `eks` does — it reads `HP_NAMESPACE`, `HP_GPU_COUNT`,
`HP_LORA_ENABLED`) rather than inventing a parallel set. Only introduce a new
prefix when the target is a genuinely new family with config that doesn't map
onto an existing one; if you do, keep it a single consistent prefix.

### The two lifecycles — this is the state-management rule

Every var in `do/config` is exactly one of:

- **Template-owned (config).** Rendered from generator answers by the `do/config`
  EJS template. `regenerate` **overwrites** these from the fresh render. This is
  most `HP_*` / `ASYNC_*` / `BATCH_*` / `IC_ENV_*` config.
- **Runtime-owned (state).** Written by a `do/` script at runtime (not known at
  generation time) — deployment status, benchmark-proven serving config,
  speculative-decoding settings, `KUBECONFIG`. These are listed in
  `RUNTIME_OWNED_VARS` in `src/lib/regenerate-command-handler.js` so `regenerate`
  **preserves** them instead of wiping live state.

> **The rule for a new target:** every variable your scripts **write at runtime**
> (anything not derivable from generator answers) MUST be preserved by `regenerate`.
> Since ADR-008 the per-target slice is **derived**: list those vars in your
> descriptor's `runtime_owned_vars` and `regenerate`'s `RUNTIME_OWNED_VARS` picks
> them up via `runtimeOwnedVarsUnion()`. The serve-engine benchmark-tunable slice
> (e.g. `VLLM_TENSOR_PARALLEL_SIZE`) is likewise derived, from each serve.d
> manifest's `env_var_prefix + dimension_map` via `serveEngineRuntimeVarsUnion()`.
> Only genuinely cross-cutting vars — written by verb scripts like
> benchmark/optimize/draft and not tied to one target or engine — stay in the
> hand-listed `SHARED_RUNTIME_VARS`. Miss this and `regenerate` silently erases
> your target's live state.

### Required state variable: `DEPLOYMENT_TARGET_<T>_STATUS`

The one variable **every** target must define is its status var (detailed as
touchpoint #3 below):

- **Name:** `DEPLOYMENT_TARGET_<T>_STATUS`, where `<T>` is a short uppercase tag
  (`SMAI`, `HP`, `EKS`, `ASYNC`, `BATCH`). It is **not** the literal target name.
- **Written by** `deploy.d/<target>` at runtime → so it is **runtime-owned**
  (must be in `RUNTIME_OWNED_VARS`).
- **Success value** must be one the guard accepts: `InService`, `Running`, or
  `Completed`.
- **Round-trips** to the answers object as `deploymentTarget<T>Status` via
  `SHELL_VAR_TO_ANSWER` in `do-config.js`.

### `IC_ENV_*` and the secret rule

Env vars destined for the serving container use the `IC_ENV_` prefix (the suffix
is the real container var, e.g. `IC_ENV_VLLM_MAX_MODEL_LEN` →
`VLLM_MAX_MODEL_LEN` in the container). **Never** store a raw secret in
`do/config`; use the Secrets Manager ARN pattern (`IC_ENV_HF_TOKEN_ARN=arn:...`)
and resolve it at runtime, exactly as `HF_TOKEN_ARN` does in `do/build`.

## State-variable map — the five targets today

`do/config` tracks **each target's state independently**, which is what lets
multiple deployments coexist (a real-time endpoint *and* a HyperPod cluster *and*
an `eks` Deployment can all be live at once, each with its own status).

Historically a target's contract was spread across ~7 hand-wired touchpoints that
had to be kept in agreement by hand. As of [ADR-008](../adr/ADR-008-deployment-target-descriptor.md)
(Wave 8) there is now a **single source of truth**: one descriptor per target at
`templates/do/targets.d/<target>/manifest.json`. The mechanical touchpoints below
are **derived** from that descriptor — either at build time (the shell status-var
maps are code-generated by `scripts/codegen-target-guard.js`) or at load time (the
JS and Python authorities import the descriptor). The table stays useful as the map
of *where* each target is threaded, but the ✓ columns are now derived, not
independently maintained.

| Target | Status var | Success | config decl | guard case | `SHELL_VAR_TO_ANSWER` | `RUNTIME_OWNED_VARS` | `deploy.d/` | `clean.d/` | dispatcher arm |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `realtime-inference` | `DEPLOYMENT_TARGET_SMAI_STATUS` | `InService` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`realtime-inference`) | ✓ |
| `async-inference` | `DEPLOYMENT_TARGET_ASYNC_STATUS` | `InService` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `batch-transform` | `DEPLOYMENT_TARGET_BATCH_STATUS` | `Completed` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hyperpod-eks` | `DEPLOYMENT_TARGET_HP_STATUS` | `Running` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `eks` | `DEPLOYMENT_TARGET_EKS_STATUS` | `Running` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The touchpoint files, and how each relates to the descriptor:

- **descriptor (source of truth)** — `templates/do/targets.d/<target>/manifest.json`
- **config decl** — `templates/do/config` (the `DEPLOYMENT_TARGET_*_STATUS` block);
  template-owned, conformance-checked against the descriptor
- **guard case** — `_guard_deployment_active` in `templates/do/lib/script-contract.sh`;
  **generated** from the descriptor between `# >>> GENERATED` markers
- **`SHELL_VAR_TO_ANSWER`** — `src/lib/do-config.js`; **derived** at load via
  `statusVarToAnswerKey()` (`target-manifest-reader.js`)
- **`RUNTIME_OWNED_VARS`** — `src/lib/regenerate-command-handler.js`; the per-target
  slice is **derived** via `runtimeOwnedVarsUnion()`
- **`deploy` status-var maps** — the reconfigure + switch-or-deploy `case` blocks in
  `templates/do/deploy`; **generated** from the descriptor between markers
- **`deploy_schema.py`** — `templates/do/lib/python/deploy_schema.py`; `SCHEMAS`,
  `STATUS_VARS`, `TARGET_ALIASES` all **derived** at import from the descriptor
- **`SERVING_*` resolver** — `templates/do/lib/resolve-serving-config.sh`; the
  kubernetes-family arm now covers `hyperpod-eks|eks` (see below)
- **`deploy.d/` / `clean.d/`** — `templates/do/deploy.d/<target>` / `clean.d/<target>`;
  hand-authored per target (the actual work — not derivable)
- **dispatcher arm** — the `case "$DEPLOYMENT_TARGET"` in `templates/do/deploy` /
  `templates/do/clean`; hand-authored (1:1 `source deploy.d/<target>`), conformance-checked
- (plus **`VALID_TARGETS`** in `test/unit/do-contract-conformance.test.js` and the
  `--target` / clean menus)

Every derivation is guarded by `test/unit/target-descriptor-conformance.test.js`,
which fails if any authority drifts from the descriptor.

> **`eks` serving-config gap — fixed in Wave 8.** `resolve-serving-config.sh` (the
> `SERVING_*` abstraction `do/benchmark` reads) previously had a `hyperpod-eks)` arm
> and a default arm but **no `eks` arm**, so `eks` fell to the SageMaker default and
> recorded the wrong instance/TP for benchmark analytics. It now resolves via a
> shared `hyperpod-eks|eks)` kubernetes arm (both are `serving_config_source:
> kubernetes` in their descriptors). `do/logs` gained the same `hyperpod-eks|eks)`
> fold. These were the two latent `eks` gaps ADR-008 closed.

## The contract a target must satisfy

Since [ADR-008](../adr/ADR-008-deployment-target-descriptor.md) (Wave 8), adding a
target is mostly **writing one descriptor plus the two scripts that do the actual
work**. The mechanical touchpoints that used to be hand-wired in ~7 places are now
derived from the descriptor.

### The short version (what you actually edit)

1. **Write the descriptor** — `templates/do/targets.d/<target>/manifest.json`. This
   is the single source of truth: status var, success status, aliases, answer key,
   family, required/optional vars, runtime-owned vars, serving-config source, and
   verb applicability all live here. Validate it against
   `templates/do/targets.d/manifest.schema.json`.
2. **Write the deploy script** — `templates/do/deploy.d/<target>` (does the work,
   writes the status var).
3. **Write the teardown script** — `templates/do/clean.d/<target>`.
4. **Add the dispatcher + menu arms** — a `source deploy.d/<target>` / `source
   clean.d/<target>` arm in `templates/do/deploy` and `templates/do/clean`, plus the
   `--help` / interactive-menu entries. (These stay hand-authored because each arm is
   a 1:1 wiring to the script; they are conformance-checked, not generated.)
5. **Run `npm run codegen`** — regenerates the shell status-var maps (guard +
   `deploy` reconfigure + switch-or-deploy) from your descriptor.
6. **Add to `VALID_TARGETS`** — `test/unit/do-contract-conformance.test.js` (the
   `@mlcc-script` enum), and add the target to the `_guard_deployment_active` matrix
   in `test/unit/do-script-contracts.test.js`.
7. **Declare verb support** — for each `do/` verb, set its `@mlcc-script` `targets:`
   or add a `_restrict_targets` / `_contract_violation` guard (exit 3). Keep the
   verb's descriptor `verbs` map in step 1 in agreement.

Everything else — the guard's status-var case, `do-config.js` `SHELL_VAR_TO_ANSWER`,
`regenerate`'s `RUNTIME_OWNED_VARS`, `deploy_schema.py`'s `SCHEMAS` / `STATUS_VARS`
/ `TARGET_ALIASES`, and the `deploy` status-var maps — is derived from the descriptor
and needs no edit. `target-descriptor-conformance.test.js` fails if any of them drift.

### The long version (every touchpoint, and where it now comes from)

The subsections below describe each touchpoint in wiring order, using `eks` as the
worked reference. Read them to understand *what* each derivation produces; you rarely
edit these files directly anymore.

### 1. The deploy script — `templates/do/deploy.d/<target>`

The unit of work. It receives the deploy args, provisions the target, and on
success/failure **writes its status variable** (see #3). It resolves
`SCRIPT_DIR` to the `do/` parent (`.../.. `) for `lib/` access and follows the
standard header/preamble. Reference: `templates/do/deploy.d/eks`.

### 2. The teardown script — `templates/do/clean.d/<target>`

Deletes only what the deploy script created. Reference:
`templates/do/clean.d/eks`.

### 3. A status variable — `DEPLOYMENT_TARGET_<T>_STATUS`

This is the linchpin that makes the target first-class. The
`deployment-active` guard reads it to decide whether operate-verbs may run.

- **Declare it** in the `do/config` template
  (`templates/do/config`), next to the other `DEPLOYMENT_TARGET_*_STATUS`
  exports, so it is defined on first source.
- **Write it** from `deploy.d/<target>` via `_update_config
  "DEPLOYMENT_TARGET_<T>_STATUS" "<value>"` on success and failure. The success
  value **must** be one of the states the guard accepts: `InService`, `Running`,
  or `Completed` (see `_guard_deployment_active`). `eks` writes `Running`.

### 4. Teach the guard — GENERATED from the descriptor

`_guard_deployment_active` in `templates/do/lib/script-contract.sh` maps each target
to its status var. **You no longer hand-edit this** — the `case` block lives between
`# >>> GENERATED … # <<< END GENERATED` markers and is produced from your descriptor's
`status_var` (and `aliases`) by `scripts/codegen-target-guard.js`. Run `npm run
codegen` after adding the descriptor and the arm appears:

```bash
eks) status_var="DEPLOYMENT_TARGET_EKS_STATUS" ;;
```

The same codegen also regenerates the two status-var maps in `templates/do/deploy`
(reconfigure active-check + switch-or-deploy). Before ADR-008 a missing hand-written
arm meant **every `guard: deployment-active` script failed on the target** — the bug
`eks` originally had; deriving the arm removes that failure mode.

### 5. Register the status var with the JS side — DERIVED from the descriptor

The `do/config` ↔ generator seam (see [do-scripts.md](do-scripts.md#the-shelljs-config-seam))
round-trips the status var, and `regenerate` must preserve it. Both are now **derived**
from your descriptor — no edit needed:

- `src/lib/do-config.js` → `SHELL_VAR_TO_ANSWER` spreads `...statusVarToAnswerKey()`,
  which maps each descriptor's `status_var` → `answer_key`. Set those two fields in
  the descriptor and the `DEPLOYMENT_TARGET_<T>_STATUS → deploymentTarget<T>Status`
  round-trip works for `import` / `update` / `validate`.
- `src/lib/regenerate-command-handler.js` → `RUNTIME_OWNED_VARS` spreads
  `...runtimeOwnedVarsUnion()`, which unions each descriptor's `runtime_owned_vars`
  (its status var + any target-family runtime vars). List those in the descriptor and
  `regenerate` preserves them.
- `templates/do/lib/python/deploy_schema.py` → `STATUS_VARS` / `SCHEMAS` /
  `TARGET_ALIASES` are all derived at import from the descriptor's `status_var`,
  `required_vars` / `optional_vars`, and `aliases`.

### 6. Add to the contract enum

`test/unit/do-contract-conformance.test.js` → `VALID_TARGETS`. The conformance
test rejects any `@mlcc-script` `targets:` value not in this enum, so a new
target must be added here or every script that lists it fails the suite.

### 7. Wire the dispatcher and menus — `templates/do/deploy`, `templates/do/clean`

- Add a `case` arm in `do/deploy` that `source`s `deploy.d/<target>`.
- Add the target to the `do/deploy --help` target list and the interactive
  target menu in `do/clean`.

### 8. Ship the deploy/clean scripts into generated projects

The whole `templates/do/` tree is copied at generation time, so a new
`deploy.d/<target>` / `clean.d/<target>` ships automatically. If your target
needs extra assets (as `eks` does with its rendered manifests), add the copy in
`src/app.js` alongside the existing target-specific handling.

### 9. Declare target support on each verb

For every `do/` verb, decide whether it applies to your target:

- If it applies, list your target in the verb's `@mlcc-script` `targets:` field
  (or leave `targets: all`).
- If it does **not** apply, add a guard using the shared primitives — never a
  hand-rolled `exit 1`:
  - `_restrict_targets "<allow-list>" "guidance"` for a simple allow-list, or
  - `_contract_violation "target" "<reason>" "<remedy>"` for a target that needs
    its own distinct message.

  Both exit `3` (the reserved contract-violation code). Example: `do/optimize`
  refuses `eks` because AI Recommendations need a SageMaker endpoint; `do/adapter`
  *accepts* `eks` because vLLM LoRA hot-load works over a pod port-forward.

## Worked example — how `eks` was wired

`eks` (EKS without the HyperPod Inference Operator) is the reference. Its full
touchpoint set:

| # | Touchpoint | File | What it got |
|---|---|---|---|
| 1 | deploy script | `templates/do/deploy.d/eks` | renders + applies Deployment/Service/ConfigMap |
| 2 | teardown | `templates/do/clean.d/eks` | deletes those k8s objects |
| 3 | status var (declare) | `templates/do/config` | `export DEPLOYMENT_TARGET_EKS_STATUS=…` |
| 3 | status var (write) | `templates/do/deploy.d/eks` | `_update_config DEPLOYMENT_TARGET_EKS_STATUS Running/Failed` |
| 4 | guard | `templates/do/lib/script-contract.sh` | `eks) status_var="DEPLOYMENT_TARGET_EKS_STATUS"` |
| 5 | JS round-trip | `src/lib/do-config.js` | `DEPLOYMENT_TARGET_EKS_STATUS → deploymentTargetEksStatus` |
| 5 | regenerate | `src/lib/regenerate-command-handler.js` | STATUS_VARS += `DEPLOYMENT_TARGET_EKS_STATUS` |
| 6 | contract enum | `test/unit/do-contract-conformance.test.js` | `VALID_TARGETS += 'eks'` |
| 7 | dispatcher + menus | `templates/do/deploy`, `templates/do/clean` | `eks)` case + menu entries |
| 9 | verb support | `do/adapter`, `do/benchmark`, `do/test` (accept) / `do/optimize`, `do/add-ic`, `do/ci` (refuse via exit 3) | per-verb target guards |

If any one of these is missing, the target half-works. The bug that motivated
this guide: `eks` had #1, #2, #3-write, #7 (deploy), and #9-accept-for-benchmark,
but was **missing #4** (guard case) — so `do/adapter`/`do/test`/`do/status` on
`eks` failed the `deployment-active` guard before doing anything.

## Verifying a new target

1. `npm run codegen` then `git diff` — confirms the shell status-var maps
   regenerated from your descriptor and that a re-run is a no-op (idempotent).
2. `npm test -- test/unit/target-descriptor-conformance.test.js` — the descriptor
   agrees with every derived authority (config decl, guard, `SHELL_VAR_TO_ANSWER`,
   `RUNTIME_OWNED_VARS`, `deploy_schema.py`, dispatcher, aliases, verbs) and the
   generated blocks have not drifted.
3. `npm test -- test/unit/do-contract-conformance.test.js` — the new target's
   verbs pass the contract (valid enum, headers, exit-3 guards).
4. `npm test -- test/unit/do-script-contracts.test.js` — add your target to the
   `_guard_deployment_active` matrix and assert it passes with its success status.
5. `mkdocs build --strict` after documenting the target in
   [deployments.md](../deployments.md) (user-facing) and the targets table in
   [do-scripts.md](do-scripts.md).

## Anti-patterns

- **A `deploy.d/<target>` with no status var + guard case.** The target deploys
  but no operate-verb can run on it. Wire #3 and #4 together.
- **Hand-rolled `if target != … ; exit 1` target guards.** Use `_restrict_targets`
  / `_contract_violation` so the exit code (3) and message format stay uniform.
- **Adding the target to `VALID_TARGETS` but not the guard/status wiring.** The
  conformance test goes green while the target is still second-class at runtime.
