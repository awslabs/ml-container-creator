<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# The `do/` Script Subsystem

Every generated project ships a `do/` directory of runtime scripts — the verbs a
developer (or the advisory agent) runs against the project: `do/build`,
`do/push`, `do/deploy`, `do/benchmark`, `do/tune`, `do/clean`, and more. This
explainer is the maintainer's structural map of that subsystem: the contract that
governs every script, the shared library it leans on, and the shell↔JS seam.
See [system-overview.md](system-overview.md) for where `do/` sits, the
task-oriented [`do-script-contract.md`](../do-script-contract.md) for the authoring
guide, and [ADR-007](../adr/ADR-007-do-script-contract-enforcement.md) for the
enforcement decision.

## One contract per script

Every contract-bearing script begins with the same shape:

```bash
#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# do/NAME — one-line description.
#
# @mlcc-script
# type: model-centric | deployment-centric | hybrid
# guard: none | artifact-ready | model-staged | deployment-active | training-infra
# lifecycle: configuration | build | … | teardown | training | ci | metadata
# targets: all | <comma list of realtime-inference,async-inference,batch-transform,hyperpod-eks,eks>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/script-contract.sh"   # reads @mlcc-script, auto-enforces guard
source "${SCRIPT_DIR}/config"
source "${SCRIPT_DIR}/lib/profile.sh"
```

The `@mlcc-script` block is machine-readable metadata: the advisory agent reads
it to sequence goals without parsing the whole script, and the runtime enforcer
reads the `guard` field to gate execution. The four fields and their allowed
values are defined in [`do-script-contract.md`](../do-script-contract.md).

This shape is **enforced by a test** (`test/unit/do-script-contracts.test.js`):
it iterates every contract-bearing script and validates the header, the four
fields (against their enums), and the `script-contract.sh` source line. Header or
exit-code drift fails the suite rather than shipping silently — the gap that
Wave 6 closed (ADR-007).

### Two documented exceptions

- **`do/config`** carries an `@mlcc-script` block (so the agent can classify it)
  but is a *sourced data file*, not an executable step — it does not source the
  enforcer.
- **`do/manifest`** is a *thin Node shim*: it sources the enforcer but delegates
  to `lib/manifest-cli.js` instead of sourcing `config` / `profile.sh`.

## Deployment targets

`DEPLOYMENT_TARGET` (set in `do/config`) selects where a model runs. Every target
is first-class; each writes its own `DEPLOYMENT_TARGET_<T>_STATUS` variable that
`_guard_deployment_active` reads.

| Target | What it is | Status var | Success status |
|---|---|---|---|
| `realtime-inference` | SageMaker real-time endpoint (Inference Components) | `DEPLOYMENT_TARGET_SMAI_STATUS` | `InService` |
| `async-inference` | SageMaker asynchronous endpoint | `DEPLOYMENT_TARGET_ASYNC_STATUS` | `InService` |
| `batch-transform` | SageMaker batch transform job | `DEPLOYMENT_TARGET_BATCH_STATUS` | `Completed` |
| `hyperpod-eks` | EKS via the HyperPod Inference Operator (`InferenceEndpointConfig` CRD) | `DEPLOYMENT_TARGET_HP_STATUS` | `Running` |
| `eks` | EKS **without** the HyperPod Inference Operator — standard Deployment + Service + ConfigMap | `DEPLOYMENT_TARGET_EKS_STATUS` | `Running` |

> **`eks` status:** `eks` is a first-class, supported target — *not* legacy. It is
> currently **untested / unvalidated** end-to-end (BL103). Because it serves vLLM
> as plain Kubernetes pods without the operator, verbs that operate on the serving
> pod directly (`do/adapter`, `do/test`, `do/benchmark`) treat it like
> `hyperpod-eks` via a direct-pod `kubectl port-forward`; verbs that require a
> SageMaker endpoint (`do/optimize`, `do/add-ic`, `do/ci`) do not apply to it.

To add your own target, see
[Adding a Deployment Target](deployment-target-authoring.md) — the full
touchpoint checklist (deploy/clean scripts, status var, guard case, JS
round-trip, dispatcher, per-verb support).

## The enforcer: `do/lib/script-contract.sh`

Sourcing `script-contract.sh` does three things:

1. Reads the caller's `# guard:` / `# type:` annotations from its header.
2. Re-sources `config` and `profile.sh` (with `set +u`) so guard-relevant
   variables — `DEPLOYMENT_TARGET`, the `DEPLOYMENT_TARGET_*_STATUS` vars,
   `_PROFILE_provisionedModules` — are loaded before enforcement.
3. Auto-calls the declared guard; a violation prints the standard message and
   exits `3`.

Guard predicates and public API:

| Function | Role |
|---|---|
| `_guard_none` | always passes |
| `_guard_artifact_ready` | `ECR_IMAGE_URI` is set |
| `_guard_model_staged` | `STAGED_MODEL_PATH` is set |
| `_guard_deployment_active` | the target's `DEPLOYMENT_TARGET_*_STATUS` is `InService` / `Running` / `Completed` |
| `_guard_training_infra` | `training` is in `_PROFILE_provisionedModules` |
| `_require_guard <name>` | enforce a guard inline (flag escalation) |
| `_guard_met <name>` | non-enforcing predicate (conditional logic) |
| `_restrict_targets <list>` | enforce a target allow-list; exit 3 on mismatch |
| `_contract_violation guard reason remedy` | the standard `❌` message + exit 3 |
| `_require_python_env` | ensure a Python venv (in-venv → `.mlcc/hey-venv` → exit 1) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | general error (including AWS-credential failures) |
| `2` | usage / argument error |
| `3` | **contract violation** — guard not met or target not allowed |

Exit `3` is reserved so CI and the advisory agent can distinguish "couldn't
start (preconditions unmet)" from "ran and failed." Target restrictions go
through `_restrict_targets`, so they all speak this one code and format —
replacing the hand-rolled `exit 1` blocks that used to drift per script.

## Shared library

`do/lib/` holds the shared shell and Node helpers every script leans on:

| File | Role |
|---|---|
| `script-contract.sh` | the guard enforcer + public guard API (above) |
| `profile.sh` | loads `~/.ml-container-creator/config.json`, emits `_PROFILE_*`, resolves buckets, discovers secrets |
| `aws-preflight.sh` | validates AWS credentials and exports `AWS_ACCOUNT_ID` — the one copy of a block previously duplicated across ~10 scripts |
| `resolve-instance.sh`, `resolve-serving-config.sh`, `endpoint-config.sh`, `inference-component.sh`, `deployment-state.sh`, `staged-assets.sh`, `secrets.sh`, `wait.sh`, `feedback.sh` | domain helpers sourced as needed |
| `manifest-cli.js`, `render-eks-manifests.cjs` | Node helpers invoked by scripts |
| `python/` | shared Python modules (`common.py`, `register_*.py`, `deploy_*.py`, `tune_*.py`, …) imported by the hidden `.*.py` helpers |

The hidden `.*.py` helpers (`.deploy_helper.py`, `.register_helper.py`, …) are
invoked as `python3 "${SCRIPT_DIR}/.HELPER.py" <subcommand> …` and self-bootstrap
their import path to `lib/python/`. `_require_python_env` is the shared venv gate
they all rely on.

## The shell↔JS config seam

`do/config` is generated from an EJS template and sourced by every script. It is
also read back on the Node side by `src/lib/do-config.js` (extracted in Wave 4,
ADR-005) for the `import` / `update` / `regenerate` / `validate` command paths.
That crossing is a contract:

- config lines the JS parser sees must be single-line `export UPPER_SNAKE=value`
  (multi-line or computed exports are invisible to `parseDoConfig`);
- only the keys in `SHELL_VAR_TO_ANSWER` round-trip back into generator answers
  (`shellVarsToAnswers`); everything else is intentionally dropped.

So a new `export FOO=…` in `config` is inert on the JS side until it is added to
that map — a deliberate allow-list, not an oversight.

## Script registry

The authoritative per-script classification (type / guard / lifecycle / targets)
lives in [`do-script-contract.md`](../do-script-contract.md#current-script-registry).
It is kept in sync with the shipped scripts by the conformance test.
