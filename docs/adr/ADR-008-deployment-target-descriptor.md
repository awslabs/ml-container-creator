<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-008: Deployment-Target Descriptor (single source of truth)

## Status

Accepted — implemented (Wave 8). Approved approach: **phased B** — land the
descriptors + conformance test first (the C safety net), then convert each
scattered authority to generation-time derivation one at a time, each proven
byte-for-byte, keeping the shell hot-path `case` blocks as *generated* static
code (never live runtime JSON reads). Full-A runtime reads on the shell hot path
are rejected (per-call `python3` on the guard path + a new Python dependency for
a pure-bash check + harder-to-prove behavior + new teardown failure modes).

**Implementation summary (what shipped).** One descriptor per target at
`templates/do/targets.d/<target>/manifest.json` (schema:
`manifest.schema.json`), read by `src/lib/target-manifest-reader.js` (Node,
gen-time) and `templates/do/lib/python/target_manifest.py` (Python, runtime +
one-shot CLI). The scattered authorities now derive from it:

- **Generated (build-time, static output):** `_guard_deployment_active` in
  `script-contract.sh`, and the reconfigure + switch-or-deploy status-var maps in
  `templates/do/deploy` — all produced by `scripts/codegen-target-guard.js` (wired
  into `npm run codegen`) between `# >>> GENERATED` markers. The shell hot path
  reads no JSON at runtime.
- **Derived (load-time):** `SHELL_VAR_TO_ANSWER` in `do-config.js`
  (`statusVarToAnswerKey()`), `RUNTIME_OWNED_VARS` in the regenerate handler
  (`runtimeOwnedVarsUnion()`), and `SCHEMAS` / `STATUS_VARS` / `TARGET_ALIASES` in
  `deploy_schema.py` (in-process import of `target_manifest`, with a baked-in
  fallback so the deploy helper never breaks).
- **Enforced:** `test/unit/target-descriptor-conformance.test.js` fails if any
  authority (or a generated block) drifts from the descriptor.

Two latent `eks` gaps were closed on the way: the `resolve-serving-config.sh` and
`do/logs` kubernetes arms now cover `hyperpod-eks|eks`. Target-alias handling was
unified across the shell maps and `deploy_schema.py` (all resolve the descriptor's
full alias set, including `managed-inference`). Behavior for the five existing
targets is byte-for-byte unchanged apart from these two intentional `eks` fixes and
the additive alias arms.

Left deliberately hand-authored (not a contract duplication, so not derived): the
`deploy.d/<target>` / `clean.d/<target>` scripts (the actual work), the 1:1
dispatcher `source` arms (conformance-checked), the `do/config` status `export`
block (template-owned EJS, conformance-checked), and the `app.js` eks-manifest copy
(genuinely eks-specific). `SHARED_RUNTIME_VARS` (cross-cutting benchmark/optimize/
draft vars) stays hand-listed. The `TODO BL105` is now fully resolved: the
serve-engine slice of `RUNTIME_OWNED_VARS` derives from each serve.d manifest's
`env_var_prefix + dimension_map` via `serveEngineRuntimeVarsUnion()`, so `regenerate`
preserves the benchmark-tunable engine vars for every engine (not just vLLM).

## Context

A `DEPLOYMENT_TARGET` selects where a generated project deploys
(`realtime-inference`, `async-inference`, `batch-transform`, `hyperpod-eks`,
`eks`). The design deliberately tracks each target's state independently — a
per-target `DEPLOYMENT_TARGET_<T>_STATUS` variable in `do/config` — which is what
lets multiple deployments coexist. That capability is worth keeping.

The problem is that the *contract* for a target is **scattered across at least
six authorities that must be hand-edited in lockstep**, with no enforcement that
they agree. The Wave 6 `eks` audit proved the cost: `eks` was writing a status
var that the guard didn't read, the config template didn't declare, `do-config.js`
didn't map, and `regenerate` didn't preserve — four of six touchpoints silently
disagreed for some time.

### The duplication, concretely

The per-target **status variable** (`DEPLOYMENT_TARGET_<T>_STATUS`) is repeated in:

1. `templates/do/config` — the template-owned `export` block (+ its camelCase EJS key).
2. `templates/do/deploy` — **four** separate `case "$DEPLOYMENT_TARGET"` blocks
   (v1.4 back-fill, `--reconfigure` clears, switch-or-deploy, plus the deploy.d writes).
3. `templates/do/lib/script-contract.sh` — `_guard_deployment_active` target→status_var
   `case`, plus the accepted success set `InService|Running|Completed`.
4. `templates/do/lib/python/deploy_schema.py` — `STATUS_VARS` (and `SCHEMAS`, `TARGET_ALIASES`).
5. `src/lib/do-config.js` — `SHELL_VAR_TO_ANSWER`.
6. `src/lib/regenerate-command-handler.js` — `RUNTIME_OWNED_VARS`
   (whose comment already says: *"TODO BL105: derive this list from the manifests"*).

Plus tests (`do-contract-conformance` `VALID_TARGETS`, `do-script-contracts`
status matrix, `do-config`, Python switch tests).

The **target enum + aliases** are separately duplicated across
`parameter-schema-v2.json`, `deploy_schema.py` `TARGET_ALIASES`, the `deploy`
alias `case`, the `do/test` alias `case`, `deploy_prompts.py` `TARGETS`, the
`clean` interactive menu, and `VALID_TARGETS`.

The **success status** per target is duplicated between each `deploy.d/*` write
and the accepted-status set in `script-contract.sh`.

### Two concrete gaps this scatter is currently hiding

- `templates/do/lib/resolve-serving-config.sh` has a `hyperpod-eks` arm and a
  catch-all — **no `eks` arm** — so benchmark analytics on `eks` resolve the wrong
  instance/TP.
- `templates/do/logs` dispatch has four arms — **no `eks` arm**.

### The precedent to mirror

The **serve-engine manifest system** (ADR-004) already solves the exact same
shape for serving engines: one `serve.d/<engine>/manifest.json` per engine, a
runtime reader `templates/do/lib/python/serve_manifest.py` (with a `_cli(argv)`
shim so bash can shell out: `python serve_manifest.py <field> <engine>`), and a
generation-time Node reader `src/lib/serve-manifest-reader.js` — explicitly "both
read the same manifest." `deploy_schema.py` is already ~80% a target descriptor
(`SCHEMAS` + `STATUS_VARS` + `TARGET_ALIASES` + `validate_config`); it just isn't
the source everything else derives from.

## Decision (proposed)

Make **one descriptor per deployment target the single source of truth** for the
per-target contract, and have every scattered authority **derive from or be
checked against it** — the same pattern ADR-004 established for serve engines.

### The descriptor

One JSON descriptor per target (proposed location `templates/do/targets.d/<target>/manifest.json`,
mirroring `serve.d/<engine>/`), carrying the canonical tuple:

```jsonc
{
  "target": "eks",
  "aliases": [],
  "status_var": "DEPLOYMENT_TARGET_EKS_STATUS",
  "answer_key": "deploymentTargetEksStatus",   // camelCase for SHELL_VAR_TO_ANSWER
  "success_status": "Running",                  // one of InService|Running|Completed
  "family": "kubernetes",                        // kubernetes | sagemaker-endpoint | sagemaker-job
  "deploy_script": "deploy.d/eks",
  "clean_script": "clean.d/eks",
  "required_vars": [],                           // deploy_schema SCHEMAS.required
  "optional_vars": { "HP_CLUSTER_NAME": "", "HP_GPU_COUNT": "auto", "HP_NAMESPACE": "default" },
  "runtime_owned_vars": ["DEPLOYMENT_TARGET_EKS_STATUS"], // → regenerate RUNTIME_OWNED_VARS
  "serving_config_source": "kubernetes",         // which resolve-serving-config arm
  "verbs": { "optimize": false, "add-ic": false, "ci": false, "adapter": true }  // applicability
}
```

Readers, mirroring the serve-manifest precedent:

- **Python runtime reader** `templates/do/lib/python/target_manifest.py` (with a
  bash `_cli` shim), so `script-contract.sh`, `deploy`, `resolve-serving-config.sh`,
  `deploy_schema.py`, `.deploy_helper.py` read the descriptor instead of hard-coded
  `case` blocks.
- **Node generation-time reader** `src/lib/target-manifest-reader.js`, so
  `do-config.js`, `regenerate-command-handler.js`, `app.js`, and the config
  template derive from the same descriptors.

## Options considered

The real decision is *how far* the derivation goes. Three options, increasing
determinism and increasing blast radius:

### Option A — Full runtime derivation

Every consumer reads the descriptor live (bash shells out to `target_manifest.py`;
JS imports the reader). No hard-coded target `case` blocks remain anywhere.

- **Pro:** maximal determinism; the descriptor is *the* behavior, not a checked copy.
- **Con:** largest change to the deploy/teardown path (highest blast radius);
  bash reading JSON on every guard check adds a `python3` call to hot paths
  (`_guard_deployment_active` runs on nearly every operate-verb); harder to keep
  byte-for-byte behavior; the config *template* still can't "read" a manifest at
  render time without the Node reader, so it's really A+B for the template layer.

### Option B — Descriptor as SoT + generation-time derivation (codegen)

The descriptors are the source of truth. A generation/build step derives the
scattered artifacts from them: the config template's status block, the
`SHELL_VAR_TO_ANSWER` entries, `RUNTIME_OWNED_VARS`, the `deploy`/`clean`
dispatcher `case` blocks, and `_guard_deployment_active`'s map — emitted into
`generated/` files (the repo already uses `src/lib/generated/*` for
parameter-matrix/validation-rules). Runtime scripts keep fast static `case`
blocks, but those blocks are **generated**, not hand-written.

- **Pro:** one place to edit; no runtime `python3` on hot paths; the generated
  artifacts are diffable so migration can be proven byte-for-byte; matches the
  existing `generated/` precedent.
- **Con:** adds a codegen step to the build (`sync-*` script) that must run when a
  descriptor changes; a generated file can drift if someone hand-edits it
  (mitigated by a "generated — do not edit" header + a CI check).

### Option C — Descriptor-validated scatter (enforcement only)

Keep the scattered authorities as-is, but add **one conformance test** that loads
the descriptors and asserts every authority agrees with them (status var present
in all six places, success status matches, dispatcher arm exists, deploy.d/clean.d
files exist, verb guards match `verbs`). This is the enforcement half of Option B
without the codegen.

- **Pro:** lowest risk; zero runtime change; would have caught the `eks` bug;
  small, fast to land.
- **Con:** doesn't reduce the work of adding a target (you still edit six places)
  — it only *checks* that you did. Not DRY; the scatter remains.

## Recommendation

**A phased B, starting with C** — i.e. land the descriptor + the conformance test
first (the C safety net), then convert authorities to generation-time derivation
one at a time (B), leaving the hot-path runtime `case` blocks as *generated*
static code rather than live JSON reads (avoiding A's per-call `python3` cost).

Rationale: C is immediately valuable and near-zero-risk (it's the "make the
convention enforced" move that Waves 6/7 used, and it closes the class of bug that
started this). B then removes the duplication for real, and doing it *after* C
means every derivation step is guarded by the conformance test — we can convert
one authority, run the test, and know the descriptor and the generated artifact
still agree. Full-A runtime reads are rejected for the guard hot path
specifically; if a future need arises (e.g. user-authored out-of-tree targets),
the reader already exists to support it.

## Migration (must preserve all 5 targets byte-for-byte)

1. Author the five descriptors to exactly match today's values (the canonical
   tuple is already mapped in `docs/architecture/deployment-target-authoring.md`).
2. Land the readers + the conformance test (C). Prove all six authorities already
   agree with the descriptors (they do, post-Wave-6).
3. Convert authorities to derive from descriptors one at a time (B), each proven
   by re-rendering a project and diffing `do/config`, the dispatcher, and the
   guard against a pre-change baseline — **byte-for-byte identical** for the 5
   shipped targets.
4. Fix the two latent gaps *through the descriptor* (add `eks` to
   `serving_config_source` and the `logs` dispatch) so the fix and the convention
   land together.

## Consequences

- **Positive:** adding or changing a target becomes "edit one descriptor (+ write
  the deploy.d/clean.d scripts)"; the six authorities can no longer silently
  disagree; the `eks`-class bug is structurally prevented; `deploy_schema.py`'s
  role becomes "reads the descriptor". The `RUNTIME_OWNED_VARS` BL105 TODO is
  fully resolved: the per-target slice derives via `runtimeOwnedVarsUnion()` and
  the serve-engine slice via `serveEngineRuntimeVarsUnion()` (each serve.d
  manifest's `env_var_prefix + dimension_map`), so both are descriptor/manifest-driven.
- **Cost:** a new descriptor format + two readers + a codegen step + migrating
  ~6 authorities; touches the deploy/teardown path (the reason for the phased,
  test-guarded migration).
- **Risk:** medium-high (deploy/teardown blast radius) — bounded by landing C
  first and proving each B step byte-for-byte.

## Wave 8 task breakdown (as built)

1. ✅ **T1 — Descriptor schema + the 5 descriptors + JSON schema.**
   `targets.d/<target>/manifest.json` for all five, byte-matching today, plus
   `manifest.schema.json`. No consumer changes.
2. ✅ **T2 — Readers.** `target_manifest.py` (+ bash `_cli` shim) and
   `target-manifest-reader.js`, mirroring the serve-manifest readers. Unit tests
   (16 py + 10 node).
3. ✅ **T3 — Conformance test (the C safety net).** Asserts every authority
   (config template, guard, `SHELL_VAR_TO_ANSWER`, `RUNTIME_OWNED_VARS`,
   dispatcher, deploy.d/clean.d, `VALID_TARGETS`, verb guards, `deploy_schema.py`)
   agrees with the descriptors; passed on the pre-derivation tree.
4. ✅ **T4 — Derive the JS authorities.** `do-config.js` `SHELL_VAR_TO_ANSWER`
   and `regenerate` `RUNTIME_OWNED_VARS` derive from the descriptors; proven
   byte-for-byte (27-key map, 37-member set). `app.js` per-target handling and the
   `config` status block left template-owned + conformance-checked.
5. ✅ **T5 — Derive the shell authorities.** `_guard_deployment_active` and the
   two `deploy` status-var `case`s are generated static blocks
   (`scripts/codegen-target-guard.js`); `resolve-serving-config.sh` and `do/logs`
   gained the `hyperpod-eks|eks` arm; aliases unified. Byte-for-byte + full suite
   at baseline. (The dispatcher `source` arms were left hand-authored +
   conformance-checked — they are 1:1 wiring, not a contract map.)
6. ✅ **T6 — Retire the duplication + docs.** `deploy_schema.py` derives
   `SCHEMAS` / `STATUS_VARS` / `TARGET_ALIASES` from the descriptor; this guide's
   add-a-target checklist became "edit one descriptor + write deploy.d/clean.d";
   this ADR wired into nav; verified vs the 20-flake baseline.

## References

- ADR-004 — serve-engine plugin parity (the manifest precedent this mirrors)
- ADR-007 — do/ script contract enforcement (the conformance-test precedent)
- `docs/architecture/deployment-target-authoring.md` — the per-target tuple + touchpoint map
- `templates/do/lib/python/serve_manifest.py` / `src/lib/serve-manifest-reader.js` — reader pattern
- `templates/do/lib/python/deploy_schema.py` — the existing ~80% descriptor
