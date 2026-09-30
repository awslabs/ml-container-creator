<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-007: Enforce the `do/` Script Contract (Convention Made True)

## Status

Accepted — in progress (Wave 6)

## Context

Generated projects ship a `do/` directory of runtime scripts (`build`, `push`,
`deploy`, `benchmark`, `tune`, `clean`, …). A well-designed convention already
governs them, documented in [`docs/do-script-contract.md`](../do-script-contract.md):

- a standard header — shebang, copyright/SPDX, one-line description;
- an `@mlcc-script` block with four fields (`type`, `guard`, `lifecycle`,
  `targets`);
- `source lib/script-contract.sh` as the first source, which reads the
  `# guard:` annotation and **auto-enforces** it (exit code `3` on violation);
- `_require_guard` for inline flag escalation and `_guard_met` for non-enforcing
  queries.

The convention is sound. The problem Wave 6 addresses is that **reality has
drifted from it and nothing catches the drift**:

1. **Header regressions.** `do/deploy` and `do/clean` are missing the
   copyright/SPDX header. `do/benchmark` is worse: its `--flag=value`
   normalization loop sits *above* the header, so the file has **no shebang** and
   no copyright line — only a stray SPDX comment on line 13.
2. **Hand-rolled target guards with inconsistent exit codes.** `do/ci`,
   `do/add-ic`, `do/optimize`, and `do/benchmark` each open-code a
   "not supported on `<target>`" `if`/`case` block that exits `1`. The doc
   reserves exit `3` for contract/target violations (so CI and the advisory
   agent can distinguish "couldn't start" from "failed"). `do/status` uses a
   bespoke exit `4` for an AWS-credentials failure.
3. **Stale registry.** The doc's registry table lists 23 scripts; `do/draft`
   ships with a full contract block but is absent from the table, and the doc's
   `do/draft` *example* lists `targets: realtime-inference, hyperpod-eks` while
   the shipped file declares `targets: hyperpod-eks` only (realtime speculative
   decoding is handled via `do/optimize --apply`).
4. **No enforcement test.** `test/unit/do-script-contracts.test.js` exercises
   `script-contract.sh`'s guard *functions* thoroughly via synthetic scripts, but
   never iterates the real scripts to validate their headers — which is exactly
   why the deploy/clean/benchmark regressions went unnoticed.

Separately, the script *bodies* carry consolidatable duplication: an AWS
credential-preflight block (`aws sts get-caller-identity` → export
`AWS_ACCOUNT_ID`) is copy-pasted in ~10 places (push, submit, status, stage, and
every `deploy.d/*` / `clean.d/*` target script), and a JSON parse-back idiom
(`… | grep -E '^\{' | tail -1` piped into a `python3 -c json.load` one-liner) is
repeated across dozens of call sites in the large helper-driven scripts.

## Decision

Make the documented convention **true and enforced**, and pull the highest-value
duplication into `do/lib/`. Do not redesign the contract — it is good; close the
gap between it and the code.

### 1. A test that enforces the contract on every script

Add a conformance test that enumerates every contract-bearing top-level `do/`
script and asserts:

- a `#!/bin/bash` shebang on line 1, followed by the copyright + SPDX header;
- an `@mlcc-script` block with all four fields, each a valid enum value per the
  doc tables;
- `source .../lib/script-contract.sh` is present.

Two documented exceptions are encoded explicitly: `do/config` is a *sourced data
file* (carries the contract block for the agent, but is not an executable step,
so it does not source the enforcer), and `do/manifest` is a *thin Node shim*
(sources the enforcer but delegates to `lib/manifest-cli.js` rather than sourcing
`config`/`profile.sh`). The test fails against the pre-fix tree — proving it
catches the drift.

### 2. Restore the drifted headers

`do/deploy`, `do/clean`, `do/benchmark` get the standard shebang +
copyright/SPDX header. `do/benchmark`'s arg-normalization loop moves *below* the
header and `set -e/-u/-o pipefail` preamble. Behavior is unchanged.

### 3. A `_restrict_targets` helper — one target-guard, exit 3

Add `_restrict_targets <comma,list>` to `script-contract.sh`. It compares the
current `DEPLOYMENT_TARGET` against the allowed list and, on mismatch, emits the
standard contract-violation format and exits `3`. The hand-rolled blocks in
`ci`, `add-ic`, `optimize`, and `benchmark` migrate onto it, preserving their
specific guidance text via the helper's remedy argument. This unifies the exit
code (3) and format while keeping the user-facing message intent.

`do/status`'s AWS-credentials check is **not** a contract violation — it is a
general runtime error — so it standardizes to exit `1` (the documented
"general error"), not `3`. Exit `4` is retired.

### 4. Extract `do/lib/aws-preflight.sh`

Move the repeated credential-preflight block into `do/lib/aws-preflight.sh`,
exposing a helper that validates credentials (with the standard message) and
exports `AWS_ACCOUNT_ID`. The ~10 copies source it instead. The new lib file
carries a module-header docblock naming its role.

### 5. Refresh the docs to match reality

Update `docs/do-script-contract.md`: add `do/draft` to the registry, reconcile
its `targets` with the shipped file, standardize the header example on
`#!/bin/bash` (matching every shipped script), document the `config` /
`manifest` exceptions, document `_restrict_targets` and `aws-preflight.sh`, and
cross-reference the shell↔JS contract enforced by `src/lib/do-config.js`
(config lines must be single-line `export UPPER_SNAKE=…`; only the
`SHELL_VAR_TO_ANSWER` keys round-trip to generator answers). Add
`docs/architecture/do-scripts.md` as the Wave 6 corpus explainer.

### Out of scope (filed as backlog)

The **JSON parse-back idiom** consolidation is deferred. It spans dozens of call
sites inside the large helper-driven scripts (`register`, `train`, `tune`,
`adapter`, …), is orthogonal to the *contract-convention* theme of this wave, and
carries real behavioral risk (each site parses different fields with subtly
different error handling). Filed as a backlog item to be tackled as its own
focused pass, with the `aws-preflight.sh` extraction as the proven template.

## Consequences

- **Positive:** the contract is enforced by a test, so header/exit-code drift
  cannot silently return. Target restrictions speak one exit code (3) and one
  format. The AWS-preflight duplication collapses to one lib file. The registry
  and doc match the shipped scripts. An AI maintainer reading one `do/` script
  sees the same shape every time and can trust the doc.
- **Cost:** header edits to three scripts; a new lib file + ~10 call-site
  migrations; four target-guard migrations; doc refresh. All behavior-preserving.
- **Risk:** low–medium. The `deploy.d/*` / `clean.d/*` migrations touch the
  deploy/teardown path; mitigated by keeping each script's behavior identical and
  verifying against the existing do-script / do-config suites plus a generation
  smoke test. The JSON-idiom deferral keeps the high-risk change out of this wave.

## Follow-up (post-wave re-audit)

A per-script re-audit after the wave produced
[`do-scripts-wave6-changelog.md`](../architecture/do-scripts-wave6-changelog.md)
(a reviewable before/after record) and caught one behavior change that had been
made implicitly: `do/adapter` had started *rejecting* the `eks` target. `eks`
(EKS without the HyperPod Inference Operator) is a first-class — if currently
untested — target, so this was corrected to *allow* LoRA on `eks` (routed through
the same vLLM hot-load path as `hyperpod-eks`). The audit also found `eks` was
missing from `_guard_deployment_active`, the `config` status vars, `do-config.js`,
the `regenerate` preservation list, and the conformance target enum; all were
wired so `eks` is first-class at the guard/status layer. Adding a new target is
now documented in
[`deployment-target-authoring.md`](../architecture/deployment-target-authoring.md).

## References

- `docs/do-script-contract.md` — the contract convention + script registry
- `docs/architecture/do-scripts.md` — how the `do/` subsystem works today (Wave 6)
- `docs/architecture/deployment-target-authoring.md` — how to add a deployment target
- `docs/architecture/do-scripts-wave6-changelog.md` — per-script before/after record
- `templates/do/lib/script-contract.sh` — the guard enforcer (+ `_restrict_targets`)
- `templates/do/lib/aws-preflight.sh` — the shared credential preflight
- `src/lib/do-config.js` — the shell↔JS config contract (ADR-005, Wave 4)
- ADR-002 — the consolidation program
