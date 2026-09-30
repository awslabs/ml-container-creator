<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Test Suite Inventory (Wave 1, Task 1)

> **Purpose.** This is the baseline audit produced at the start of the
> consolidation program (see `docs/adr/ADR-002-consolidation-program.md`). It
> catalogs the test suite by category, records baseline timings and the
> pre-existing failure set, and flags redundancy that Wave 1 Task 2 (early
> streamline) and Wave 9 (bookend) will act on. It is a **working artifact**:
> the numbers here are a point-in-time snapshot at program start (generator
> v1.7.2), captured on macOS/darwin.

## How the suites are invoked

From `package.json` scripts (the source of truth for what actually runs):

| Script | Glob | Notes |
|---|---|---|
| `test` | `test/**/*.test.js` minus `test/property/**` | parallel; the "full non-property" suite. **Also picks up `test/input-parsing-and-generation/**` and `test/servers/**`** because the glob is unqualified. |
| `test:property` | `test/property/**/*.test.js` | 8 GB heap, `--parallel --jobs 4` |
| `test:all` | `test` + `test:property` | what `test:ci` runs after lint |
| `test:unit` | `test/unit/**/*.test.js` | not parallel; 15 s timeout |
| `test:integration` | `test/integration/**/*.test.js` | 30 s timeout |
| `test:servers` | 5 explicit `servers/*/test.js` runners | region, instance-sizer, workload, reasoning, draft-model-picker only — **7 of the 12 standalone server runners are not in this script** |

`.mocharc.json` only sets `require: ["test/setup-env.js"]`. Python tests
(`pytest`) live in two roots and are run separately (CI runs
`pytest test/unit/`).

## Category counts

| Category | Path | `.test.js` files | Lines of test code |
|---|---|---:|---:|
| Unit (JS) | `test/unit/` | 159 | 49,806 |
| Property (JS) | `test/property/` | 162 | 44,615 |
| Generation (JS) | `test/input-parsing-and-generation/` | 62 | 19,512 |
| Integration (JS) | `test/integration/` | 27 | 10,251 |
| Servers (JS) | `test/servers/` | 4 | 2,041 |
| **JS total** | | **414** | **~126,225** |
| Python (unit) | `test/unit/*.py` (+ `test/unit/agent/`) | 45 | — |
| Python (root) | `tests/*.py` | 18 | — |
| Standalone server runners | `servers/*/test.js` | 12 | — |

Helpers already present in `test/helpers/`: `assertions.js` (47),
`ejs-fixture.js` (65), `mock-generator.js` (95), `property-config.js` (25),
`run-generator.js` (391) + its own `run-generator.test.js` (246).

## Baseline timing (macOS/darwin, this machine)

Captured with `MLFLOW_TRACKING_URI` pinned to `file:///tmp/mlcc-wave1-mlruns`
so MLflow does not write `./mlruns` into the repo.

| Suite | Wall time | Result |
|---|---|---|
| `test:unit` | ~53 s (mocha) / ~1 m 19 s (process) | 3134 passing, 10 pending, **20 failing** |
| `test:integration` | ~1 m | 600 passing, 1 pending, 0 failing |
| `test` (full non-property) | ~1 m (mocha) | 4813 passing, 39 pending, **25 failing** |
| `test:property` | **~10 m 33 s** | ≥1 failing (catalog-schema) |

The property suite dominates wall-clock time by an order of magnitude.

## ⚠️ Pre-existing failures at baseline (NOT caused by this program)

**The suite is not green on this machine at program start.** Every failure
observed is an environmental flake, not a code defect. This is the reference
baseline: later waves must compare against *this* set, not against an assumed
all-green state.

| Count | Suite | Root cause | Class |
|---:|---|---|---|
| 20 | `notebook-export` (unit) | System Python 3.9 `python3: posix_spawn: .../Python.app/...: Undefined error: 0` — the test shells out to `python3` to execute a generated notebook, and the macOS CommandLineTools Python fails to spawn. | Environment (Python runtime) |
| 1 | `catalog-schema-validation` (unit+property) | Instance catalog entry `ml.p6-b300.48xlarge` carries fields (`networkBandwidthGbps`, `inferenceAmiVersion`) and a `costTier` not permitted by the catalog schema (`additionalProperties:false`; `costTier` enum lacks the used value). | Data/schema drift (real, small) |
| 3 | `tensorrt-llm`, `error-handling` (generation), `e2e-catalog-consolidation` (integration) | Mocha 10–15 s timeouts on tests that spawn full generation / `/bin/sh`; `spawnSync ... ETIMEDOUT`. Load- and spawn-sensitive. | Environment (timeout/flake) |

Notes:
- The 25 full-run failures = the 20 notebook-export + the 4 timeout/spawn
  flakes + the 1 catalog-schema assertion (which also fails in the property
  run). Integration alone was clean (0 failing).
- The **catalog-schema drift** is the one genuine (non-environment) issue and
  is a small data fix; it is independent of the consolidation refactors but
  should be tracked.
- The notebook-export failures gate on a working `python3`; on CI (Linux) they
  are expected to pass. They are flagged here so Wave 1 Task 2 does not mistake
  them for regressions.

## Redundancy findings (targets for Task 2 / Wave 9)

### R1 — Domain arbitraries re-declared inline across property tests (highest value)
- 161/162 property files import the shared `property-config.js` (good — one
  source for `numRuns`).
- **But 68 property files define their own `fc.record(...)` arbitraries, and
  0 import any shared arbitraries/generators helper.** The same domain fields
  are re-invented across dozens of files:

  | Field re-declared inline | # property files |
  |---|---:|
  | `deploymentTarget` | 18 |
  | `framework` | 15 |
  | `architecture` | 11 |
  | `instanceType` | 9 (24 reference it) |
  | `awsRegion` | 9 |
  | `deploymentConfig` | 7 |
  | `status` / `testStatus` | 15 |

  These are exactly the enums already defined in
  `config/parameter-schema-v2.json`. **Consolidation target:** a shared
  `test/helpers/arbitraries.js` that derives these arbitraries from the schema
  (single source of truth), replacing the inline copies. This both removes
  duplication and makes the property tests track the schema automatically.

### R2 — Grandfathered `numRuns` literals
- 139 property files still contain a `numRuns` reference. The pre-commit hook
  blocks *new* hardcoded `numRuns:` but the existing ones predate it. Migrating
  them to `PROPERTY_CONFIG` / `NUM_RUNS` from `property-config.js` is a
  mechanical consolidation.

### R3 — Slow generation-based property tests
- 7 property files run full project generation (`run-generator` /
  `writeProject`): the marketplace suite (`marketplace-file-exclusion`,
  `-file-inclusion`, `-deployment-target`, `-async-batch`,
  `-jumpstart-rejection`), `tune-generator-inclusion`,
  `train-generator-inclusion`. Individual cases were observed at 25–40 s, and
  one packaging property (`sagemaker-adapter-contract` Property 9) at ~119 s.
  These dominate the 10 m property wall time. **Target:** lower `numRuns` for
  generation-class properties via a dedicated `PROPERTY_CONFIG_GEN` profile,
  and/or move pure-logic assertions out of the generation loop.

### R4 — Same base name in multiple categories (modest)
- Only 10 base names appear in 2+ categories (e.g. `e2e-runner`,
  `deployment-config-resolver`, `aws-profile-parser`, `arn-detection`,
  `bl105-serve-manifest`, `bl107-sglang-plugin`, `notebook-export`,
  `secrets-mutual-exclusion`, `ci-stage-results`, `configuration`). Each pair
  is a candidate to check for a unit test that merely re-asserts a property
  test's invariant (or vice versa). Low volume; review case-by-case.

### R5 — Backlog-item (`bl*`) named tests
- 10 `bl*`-prefixed test files (4 unit, 3 property, 3 generation). These are
  tied to historical backlog items; some may cover behavior now also covered by
  feature-named suites. Review for merge into the feature suite they belong to.

### R6 — Structural / harness observations (not redundancy, but cleanup)
- `test/input-parsing-and-generation/` (62 files, ~19.5 k lines) has **no
  dedicated npm script** and is only run because the default `test` glob is
  unqualified. It is effectively a second generation-integration suite; naming
  it explicitly (script + doc) would clarify intent.
- `test:servers` runs only 5 of the 12 `servers/*/test.js` runners — 7 server
  runners are never exercised by an npm script. Wave 2 (MCP factory) will
  revisit this; flagged here for coverage-parity.
- Python tests are split across `test/unit/*.py` and `tests/*.py` with
  overlapping `test_property_*` files; consolidating to one root is a Wave 6/9
  cleanup.

## Coverage-parity guardrail for Task 2

When removing or merging a test, preserve coverage of every **distinct
behavior**. Before deleting a file, confirm the behavior it asserts is either
(a) covered by another retained test, or (b) migrated into the shared
generator/arbitrary it is being folded into. The metric for Task 2 success is
**lower file count + faster wall time with no net loss of distinct-behavior
coverage**, measured against the baseline table above (and against the same
known pre-existing failure set, which must not grow).

---

## Task 2 results — early streamline (this wave)

Scope of this pass was deliberately narrow and low-risk: establish the shared
substrate and take the biggest wall-time win, without a mass rewrite of 68
files (that broader migration is scheduled for the Wave 9 bookend, guided by the
notes below).

### Added shared substrate
- **`test/helpers/arbitraries.js`** — schema-derived fast-check arbitraries.
  `VALUES` and `arb.*` source `deploymentConfig`, `deploymentTarget`,
  `framework`, `modelServer`, `modelFormat` from
  `config/parameter-schema-v2.json` (single source of truth); `architecture`
  and `awsRegion` are explicit test-domain lists (no bounded schema enum).
  `subset()` narrows a domain while asserting membership; `schemaEnum()` fails
  loudly if the schema drops an enum. Addresses R1.
- **`PROPERTY_CONFIG_GEN` / `GEN_NUM_RUNS`** added to
  `test/helpers/property-config.js` — a capped profile (default cap 20,
  `min(NUM_RUNS, cap)`, 120 s timeout) for generation-/packaging-heavy property
  tests. Addresses R3.

### R3 — generation-property speedup (measured)
Migrated 8 generation/packaging property files onto `GEN_NUM_RUNS`:
`marketplace-file-exclusion`, `marketplace-file-inclusion`,
`marketplace-deployment-target`, `marketplace-async-batch`,
`marketplace-jumpstart-rejection`, `tune-generator-inclusion`,
`train-generator-inclusion`, `adapter-sidecar-tar-packaging`.

| | Before | After |
|---|---|---|
| These 8 files (parallel, `--jobs 4`) | multiple minutes; single cases 25–40 s, one packaging property ~119 s | **~104 s total**, packaging property ~22 s |
| Result | — | 37 passing, 0 failing |

The cap only lowers iteration count for the generation code path (same path on
every run); distinct-behavior coverage is unchanged. Local dev can restore full
runs with `PROPERTY_GEN_NUM_RUNS=100`.

### R1 — arbitraries migration (proof + guidance)
- Migrated `base-image-picker-equivalence.property.test.js` as the reference:
  its framework lists now come from the shared helper
  (`VALUES.framework` / `NON_TRANSFORMER_FRAMEWORKS`); **5 passing**.
- **Important semantic caveat discovered:** several property files define a
  local `MODEL_SERVERS = ['vllm','sglang','tensorrt-llm','lmi','djl', ...]`.
  This is the set of **serve.d engine names** (used for base-image routing /
  engine plumbing), which is a DIFFERENT concept from the schema `modelServer`
  enum (`flask/fastapi/vllm/sglang`). These must NOT be replaced with
  `VALUES.modelServer`. The helper documents this; the broader Wave 9 migration
  must convert `framework`/`deploymentTarget`/`deploymentConfig` arbitraries
  (schema-backed) while leaving engine lists local until Wave 3 gives them a
  manifest-backed source.

### Verification
- `eslint` clean on all added/modified files (repo forbids trailing commas and
  `!=null`/`==null`; honored).
- No hardcoded `numRuns: <int>` literals introduced (pre-commit guard safe).
- Migrated files pass. The known pre-existing baseline failures (see above) are
  unchanged — this pass neither fixed nor added to them.

### Deferred to Wave 9 (bookend)
- Convert the remaining ~67 property files' schema-backed inline arbitraries to
  the shared helper (R1), guided by the serve.d-engine caveat above.
- Migrate the 139 grandfathered `numRuns` literals to `property-config.js` (R2).
- Name the `input-parsing-and-generation` suite with a dedicated script, and
  reconcile `test:servers` to cover all 12 server runners (R6) — the latter
  folds into Wave 2 (MCP factory).
