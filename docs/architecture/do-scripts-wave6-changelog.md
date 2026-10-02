<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Wave 6 — Per-Script `do/` Changelog

This is the reviewable, per-script record of every change Wave 6
([ADR-007](../adr/ADR-007-do-script-contract-enforcement.md)) made to the `do/`
runtime scripts. It exists because behavior-touching edits to shipped scripts
deserve a per-file before/after record, not just a wave-level summary.

Every change here is **behavior-preserving except where explicitly flagged**. One
genuine behavior change was found during the post-wave re-audit and corrected —
see [do/adapter](#doadapter) and the `eks` note below.

## A note on the `eks` target

`eks` is a **first-class deployment target**: a model served as standard
Kubernetes objects on an EKS cluster **without** the HyperPod Inference Operator
(contrast `hyperpod-eks`, which uses the operator and its `InferenceEndpointConfig`
CRD). It is currently **untested / unvalidated** end-to-end, but it is *supported*,
not deprecated. Earlier Wave 6 notes described it dismissively as "legacy /
plain-k8s"; that framing was wrong and has been corrected across the docs.

## Legend

- **Header** — added the standard shebang + copyright/SPDX header.
- **Exit code** — a target/guard rejection's exit code (contract violations are `3`).
- **Target guard** — a `DEPLOYMENT_TARGET` restriction.
- **Preflight** — the AWS-credential check, now `lib/aws-preflight.sh`.
- ⚠️ marks a real behavior change (not pure consolidation).

---

## Top-level scripts

### do/deploy
- **Header:** added the missing copyright/SPDX lines after the shebang.
- Nothing else. Dispatcher logic untouched.

### do/clean
- **Header:** added the missing copyright/SPDX lines.
- Nothing else.

### do/config
- **Header:** added copyright/SPDX after the shebang (before `# do-framework
  configuration`). `config` is a sourced *data file* — it keeps its `@mlcc-script`
  block but does not source the enforcer.

### do/benchmark
- **Header:** restored. The file had lost its shebang/copyright — the
  `--flag=value` normalization loop had migrated *above* the header. Reordered to:
  shebang → copyright/SPDX → description → `@mlcc-script` → `set -e/-u/-o pipefail`
  → normalization loop (still before the JSON-mode detection loop, preserving
  `--json=x` handling) → sources.
- **Target guard / exit code:** `async-inference` and `batch-transform` rejections
  moved from hand-rolled `echo…; exit 1` to `_contract_violation "target" …`
  (exit `3`), each keeping its distinct message. These stay explicit branches
  (not `_restrict_targets`) because the **`eks` plain-EKS benchmark path sits
  below them** and must be reachable — `eks` benchmarking via pod port-forward is
  preserved.
- *Not Wave 6 (pre-existing working-tree changes, left untouched):* the `--dataset`
  BYOD flag, `ARG_DATASET`, the dataset help text, and the "require `--workload`
  or `--dataset`" logic are separate in-flight work.

### do/status
- **Preflight:** validate-only block → `_aws_preflight` (silent). **Exit code:**
  `4` → `1` (AWS-creds failure is a general runtime error, not a contract
  violation). Minor: the helper also exports `AWS_ACCOUNT_ID` (previously not set
  here) — harmless.

### do/push
- **Preflight:** verbose block → `_aws_preflight --verbose`. Preserves the
  `🔍/✅` lines and `AWS_ACCOUNT_ID` capture. **Exit code:** `4` → `1`. The
  richer "IAM role recommended" guidance is now part of the shared helper message.

### do/submit
- **Preflight:** verbose block (+ its `-z AWS_ACCOUNT_ID` empty-check) →
  `_aws_preflight --verbose`. The empty-account-id check now lives in the helper.
  **Exit code:** `4` → `1`.

### do/stage
- **Preflight:** silent block → `_aws_preflight`. Its separate `command -v aws`
  check is kept. **Exit code:** `4` → `1`. Message changed from "not configured
  or expired" to the shared helper message.

### do/ci
- **Target guard / exit code:** hand-rolled `hyperpod-eks` rejection (`exit 1`) →
  `_restrict_targets "realtime-inference"` (exit `3`), guidance preserved. The CI
  harness is SageMaker-managed-inference only (Lambda/Step Functions/CodeBuild);
  every non-`realtime-inference` target — including `eks` and `hyperpod-eks` — is
  correctly refused. (`eks` was never supported here; no behavior change for it.)

### do/add-ic
- **Target guard / exit code:**
  - `hyperpod-eks` branch → `_contract_violation "target" …` (exit `3`), keeps its
    distinct "use `do/adapter --load-lora`" guidance.
  - `async-inference`/`batch-transform` block → `_restrict_targets
    "realtime-inference"` (exit `3`). Inference Components are real-time-only, so
    `eks`/`hyperpod-eks` are also (correctly) refused here.

### do/adapter ⚠️
- **Target guard / exit code:** this is the one place the initial Wave 6 edit
  introduced a real behavior change, now **corrected**.
  - **Original:** rejected only `async-inference`/`batch-transform`; every other
    target fell through. `hyperpod-eks` → vLLM hot-load path; `realtime-inference`
    → SMAI IC path; **`eks` fell through unhandled** (no `eks` branch → landed in
    SMAI code that can't work without an endpoint).
  - **First Wave 6 edit (wrong):** `_restrict_targets
    "realtime-inference,hyperpod-eks"` — this *rejected* `eks`, silently deciding
    a product question.
  - **Corrected:** `eks` is allowed and routed to the same vLLM LoRA hot-load path
    as `hyperpod-eks` (plain EKS runs vLLM without the operator, so hot-load
    applies identically). The top guard is now
    `_restrict_targets "realtime-inference,hyperpod-eks,eks"`; the vLLM path fires
    for `hyperpod-eks` **or** `eks`; the `HP_LORA_ENABLED` and sourcing-verb
    messages are now target-aware. `async`/`batch` stay rejected. Covered by a new
    test in `bl112-adapter-hyperpod-unified.test.js`.
  - **Companion fix (eks made first-class at the guard + status layer):** the
    `deployment-active` guard had **no `eks` case** — it fell to the default and
    always failed, so *any* `guard: deployment-active` script (adapter, test,
    logs, status, clean) was silently unrunnable on `eks`. Added
    `eks → DEPLOYMENT_TARGET_EKS_STATUS` to `_guard_deployment_active` (accepts
    `Running`, which `deploy.d/eks` writes), and wired `DEPLOYMENT_TARGET_EKS_STATUS`
    into the `config` template, `do-config.js` `SHELL_VAR_TO_ANSWER`
    (`deploymentTargetEksStatus`), and the `regenerate` STATUS_VARS preservation
    list. The conformance test's target enum now includes `eks`.
- **Nested per-verb guard:** the `from-hub|from-tune|from-train|from-registry`
  sub-command rejection inside the vLLM path (SMAI-only sourcing verbs) moved from
  `echo…; exit 1` to `_contract_violation "target" …` (exit `3`), message
  preserved.

### do/optimize
- **Target guard / exit code:**
  - `eks` branch → `_contract_violation "target" …` (exit `3`), keeps its exact
    "N/A for eks target — no SageMaker endpoint" message. `eks` handling
    **unchanged** (still refused, correctly — AI Recommendations needs a SageMaker
    endpoint, which plain EKS does not have).
  - `async-inference`/`batch-transform` → `_restrict_targets
    "realtime-inference,hyperpod-eks"` (exit `3`), keeps the "use `do/benchmark
    --recommend`" tail.

---

## Deploy dispatchers (`deploy.d/*`)

All five migrated the identical verbose AWS-preflight block to
`_aws_preflight --verbose` (sourced after `lib/profile.sh`). Behavior preserved
(`🔍/✅` lines + `AWS_ACCOUNT_ID`), **exit code `4` → `1`**. No target logic
changed.

- **deploy.d/eks** — plain EKS target preserved as-is (only preflight migrated).
- **deploy.d/hyperpod-eks** — preflight migrated. *Not Wave 6:* the
  `VLLM_ENABLE_LORA="false"` literal (BL127) is a pre-existing working-tree change.
- **deploy.d/realtime-inference**, **deploy.d/async-inference**,
  **deploy.d/batch-transform** — preflight migrated only.

## Clean dispatchers (`clean.d/*`)

- **clean.d/eks** — two in-function validate-only preflight blocks →
  `_aws_preflight` (exit `4` → `1`). Reference migration for the deferred rest.
- **clean.d/{async-inference,batch-transform,hyperpod-eks,realtime-inference}** —
  **not yet migrated** (deferred to BL132): many in-function copies on the
  destructive teardown path; migrated one file at a time with tests.

---

## Shared library (`lib/`)

### lib/script-contract.sh
- Added **`_restrict_targets "<csv-allow-list>" ["guidance"]`** — enforces a
  target allow-list, emitting the standard `_contract_violation` format and exit
  `3` on mismatch. Replaces hand-rolled `case … exit 1` blocks. Added to the
  `Provides:` doc comment.

### lib/aws-preflight.sh (new)
- **`_aws_preflight [--verbose]`** — the single AWS-credential preflight: validates
  credentials, exports `AWS_ACCOUNT_ID`, fails with exit `1` (general error).
  `--verbose` prints the `🔍/✅` lines; default silent. Replaces ~10 copies.

---

## Exit-code standardization summary

| Situation | Before (varied) | After |
|---|---|---|
| Target not supported | `exit 1` (hand-rolled) | `exit 3` (`_restrict_targets` / `_contract_violation`) |
| AWS credentials missing | `exit 4` (undocumented) | `exit 1` (general runtime error) |

## Tests

- `test/unit/do-contract-conformance.test.js` — iterates every script; enforces
  header + `@mlcc-script` fields + enforcer source + exit-`3` target restrictions.
- `test/unit/do-aws-preflight-generation.test.js` — the helper ships and every
  caller sources it; no migrated script open-codes the preflight block.
- Updated to the new contract: `hyperpod-ops-surface-guards.test.js`,
  `bl112-adapter-hyperpod-unified.test.js`, `bl103-eks-target.property.test.js`.
